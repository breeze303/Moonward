import { test, expect } from '@playwright/test'
import pg from 'pg'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { loadConfig } from '../server/config.ts'
import { createPgApplication } from '../server/app.ts'
import { PgGateway } from '../server/postgres/settings.ts'
import { pgWorker } from '../server/postgres/worker.ts'
import { DEFAULT_MODEL_LIMITS } from '../shared/contract.ts'
import { adminEmail, password, mockKey, startMock, listen, closeServer } from './support.ts'

test('PostgreSQL: web capacity settings, cancel before dispatch and refresh during generation', async ({ page }) => {
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
    await db.query(await readFile(new URL('../server/postgres/schema.sql', import.meta.url), 'utf8'))
    await db.query(
      `INSERT INTO site_settings(id,daily_limit) VALUES(1,1000);INSERT INTO gateway_settings VALUES(1,0,'https://example.test',NULL)`,
    )
    await db.query('INSERT INTO model_catalog VALUES(1,1,$1)', [
      JSON.stringify({
        defaultId: 'gpt-test-text',
        models: [
          {
            id: 'gpt-test-text',
            label: 'Mock',
            enabled: true,
            web: false,
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
    for (const name of ['设置', '账号', '站点管理']) await page.getByRole('button', { name, exact: true }).click()
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
    await input.fill('cancel before dispatch')
    await send.click()
    await expect(reply.getByText('排队中')).toBeVisible()
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
