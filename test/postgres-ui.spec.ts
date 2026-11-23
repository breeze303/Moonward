import { test, expect } from '@playwright/test'
import pg from 'pg'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { freshSchema } from '../server/postgres/schema.ts'
import { createServer } from 'node:http'
import { loadConfig } from '../server/config.ts'
import { createPgApplication } from '../server/app.ts'
import { PgGateway } from '../server/postgres/settings.ts'
import { pgWorker } from '../server/postgres/worker.ts'
import { DEFAULT_MODEL_LIMITS } from '../shared/contract.ts'
import { adminEmail, password, mockKey, startMock, listen, closeServer } from './support.ts'

test('PostgreSQL: web capacity settings, cancel before dispatch and refresh during generation', async ({ page }) => {
  test.setTimeout(60_000)
  test.skip(!process.env.MOONWARD_TEST_DATABASE_URL, 'Requires an isolated PostgreSQL database')
  const schema = 'ui_' + randomUUID().replaceAll('-', ''),
    url = new URL(process.env.MOONWARD_TEST_DATABASE_URL!)
  const base = new pg.Pool({ connectionString: url.href })
  url.searchParams.set('options', `-c search_path=${schema}`)
  const db = new pg.Pool({ connectionString: url.href }),
    mock = await startMock(),
    server = createServer(),
    origin = await listen(server)
  const cfg = loadConfig({ AUTH_SECRET: randomUUID(), APP_ORIGIN: origin })
  let app: Awaited<ReturnType<typeof createPgApplication>> | undefined, worker: ReturnType<typeof pgWorker> | undefined
  try {
    await base.query(`CREATE SCHEMA ${schema}`)
    await db.query(await freshSchema())
    await db.query(
      `INSERT INTO site_settings(id,daily_limit) VALUES(1,1000);INSERT INTO gateway_settings VALUES(1,0,'https://example.test',NULL)`,
    )
    await db.query('INSERT INTO model_catalog VALUES(1,1,$1)', [
      JSON.stringify({
        defaultId: 'gpt-test-text',
        models: [
          {
            id: 'gpt-test-text',
            label: 'Moonward 测试模型',
            enabled: true,
            web: true,
            vision: false,
            files: true,
            efforts: [],
            defaultEffort: null,
            summary: false,
            limits: DEFAULT_MODEL_LIMITS,
          },
        ],
      }),
    ])
    await new PgGateway(db, cfg).save({ baseUrl: mock.url + '/v1', apiKey: mockKey, version: 0 })
    app = await createPgApplication(cfg, url.href)
    await app.accounts.createAdmin(adminEmail, 'Admin', password)
    app.app.use(express.static('dist'))
    server.on('request', app.app)
    await page.goto(origin)
    await page.getByLabel('邮箱').fill(adminEmail)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    const memoryToggle = page.locator('.composer').getByRole('button', { name: '本对话不使用记忆' })
    await expect(memoryToggle).toHaveAttribute('aria-pressed', 'false')
    await memoryToggle.click()
    await expect(memoryToggle).toHaveAttribute('aria-pressed', 'true')
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await expect(memoryToggle).toBeVisible()
        const memoryBox = await memoryToggle.boundingBox()
        const searchBox = await page.getByRole('button', { name: '智能搜索', exact: true }).boundingBox()
        const modelBox = await page.locator('.composer-model').boundingBox()
        expect(memoryBox!.x).toBeGreaterThanOrEqual(searchBox!.x + searchBox!.width)
        expect(memoryBox!.x + memoryBox!.width).toBeLessThanOrEqual(modelBox!.x)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        await page.screenshot({path:`test-results/memory-composer-${width}-${colorScheme}.png`})
      }
    }
    await page.setViewportSize({width:1280,height:800})
    for (const name of ['设置', '记忆']) await page.getByRole('button', { name, exact: true }).click()
    const editor = page.getByRole('textbox', { name: '记忆内容', exact: true })
    const enabled = page.getByRole('switch', { name: '使用已保存的记忆' })
    const automatic = page.getByRole('switch', { name: '从聊天中自动记忆' })
    const clear = page.getByRole('button', { name: '清空全部记忆', exact: true })
    const height = () => editor.evaluate(el => el.clientHeight)
    const short = await height()
    const draft = '默认使用简体中文。\n先给结论，再解释原因。\n代码示例使用 TypeScript。'
    await editor.fill(draft)
    expect(await height()).toBeGreaterThan(short)
    await automatic.check()
    await expect(enabled).toBeEnabled()
    await enabled.focus()
    await enabled.press('Space')
    await expect(enabled).not.toBeChecked()
    await expect(automatic).toBeDisabled()
    await expect(automatic).not.toBeChecked()
    await expect(editor).toHaveValue(draft)
    await enabled.check()
    await expect(automatic).toBeChecked()
    await automatic.uncheck()
    await editor.fill('长期偏好'.repeat(120))
    expect(await height()).toBeGreaterThan(short)
    expect(await height()).toBeLessThanOrEqual(240)
    await page.setViewportSize({width:390,height:844})
    expect(await height()).toBeLessThanOrEqual(240)
    expect(await editor.evaluate(el => el.scrollHeight)).toBeGreaterThan(await height())
    await page.setViewportSize({width:1280,height:800})
    await editor.fill('使用简体中文')
    expect(await height()).toBe(short)
    await page.getByRole('button',{name:'添加记忆'}).click()
    await expect(page.locator('.memory-row')).toContainText('使用简体中文')
    await expect(editor).toHaveValue('')
    await editor.fill(draft)
    for (const [device, viewport] of [['desktop', {width:1280,height:800}], ['mobile', {width:390,height:844}]] as const) {
      await page.setViewportSize(viewport)
      const region = page.getByRole('region', { name: '记忆' })
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await expect.poll(() => page.locator('html').evaluate(el => getComputedStyle(el).colorScheme)).toBe(colorScheme)
        await region.evaluate(el => { el.scrollTop = 0 })
        await expect(enabled).toBeInViewport()
        expect(await region.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(await region.evaluate(el => el.clientWidth))
        await page.screenshot({path:`test-results/memory-${device}-${colorScheme}.png`})
        await clear.scrollIntoViewIfNeeded()
        const listBox = await page.locator('.memory-row').boundingBox(), clearBox = await clear.boundingBox()
        expect(clearBox!.x).toBeCloseTo(listBox!.x, 0)
        await expect(clear).toHaveCSS('border-top-style', 'solid')
        await page.screenshot({path:`test-results/memory-clear-${device}-${colorScheme}.png`})
      }
    }
    await editor.fill('')
    await page.setViewportSize({width:1280,height:800})
    await clear.click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('.memory-row')).toHaveCount(1)
    await clear.click()
    await page.getByRole('button',{name:'确认永久清空全部记忆'}).click()
    await expect(page.locator('.memory-row')).toHaveCount(0)
    for (const name of ['账号', '站点管理']) await page.getByRole('button', { name, exact: true }).click()
    const capacity = page.getByRole('spinbutton', { name: '同时生成上限' })
    await expect(capacity).toHaveValue('100')
    await capacity.fill('1')
    await page.getByRole('button', { name: '保存同时生成上限' }).click()
    await expect
      .poll(async () => (await db.query('SELECT running_limit FROM site_settings')).rows[0].running_limit)
      .toBe(1)
    await page.goto(origin)
    const input = page.getByRole('textbox', { name: '消息' }),
      send = page.getByRole('button', { name: '发送消息' }),
      reply = page.getByRole('article', { name: '模型回复' }).last()
    await memoryToggle.click()
    await input.fill('cancel before dispatch')
    await send.click()
    await expect(reply.getByText('排队中')).toBeVisible()
    await expect(memoryToggle).toHaveCount(0)
    expect((await db.query('SELECT memory_enabled FROM chats')).rows[0].memory_enabled).toBe(false)
    await page.getByRole('button', { name: '停止生成' }).click()
    await expect(reply).toContainText('已停止')
    expect(mock.bodies).toHaveLength(0)
    worker = pgWorker(db, cfg)
    await input.fill('SLOW browser reconnect')
    await send.click()
    await expect(reply.locator('.ds-markdown')).not.toBeEmpty()
    await page.reload()
    await expect(reply).toContainText('browser reconnect。', { timeout: 10000 })
    expect(mock.bodies).toHaveLength(1)
  } finally {
    await page.close()
    await app?.drain()
    await worker?.close()
    await closeServer(server)
    await app?.close()
    await mock.close()
    await db.end()
    await base.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await base.end()
  }
})
