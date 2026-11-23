import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { effortLevels, type Effort, type Model } from '../shared/contract.ts'
import { adminEmail, minimumPassword, mockKey, password, startMock, startSite } from './support.ts'

const modelButton = (page: Page) => page.getByRole('button', { name: /^模型：/ })
const modelListButton = (page: Page) => page.getByRole('button', { name: /^推理深度：.+，选择模型$/ })

async function login(page: Page, email = adminEmail, secret = password) {
  await page.goto('/')
  await expect(page).toHaveTitle('Moonward')
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(secret)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '今天有什么可以帮到你？' })).toBeVisible()
}

test('a fresh deployment creates its administrator and names a new chat from the web', async ({ browser, page }) => {
  const title = Promise.withResolvers<string>()
  const mock = await startMock(0, { title: () => title.promise })
  const site = await startSite(mock.url, { staticFiles: true, seed: false })
  try {
    await page.setViewportSize({ width: 390, height: 820 })
    await page.goto(site.origin)
    await expect(page.getByRole('heading', { name: '等待站点初始化' })).toBeVisible()
    await expect(page.getByRole('button', { name: '创建管理员' })).toHaveCount(0)
    await page.goto(`${site.origin}/setup`)
    await expect(page.getByRole('heading', { name: '设置管理员账户' })).toBeVisible()
    await expect(page).toHaveURL(`${site.origin}/setup`)
    await page.screenshot({ path: 'test-results/moonward-first-setup.png', fullPage: true })
    await expect(page.getByLabel('一次性设置口令')).toHaveCount(0)
    await page.getByLabel('显示名称', { exact: true }).fill('首位管理员')
    await page.getByLabel('邮箱', { exact: true }).fill('first-admin@example.test')
    await page.getByLabel('密码', { exact: true }).fill(minimumPassword)
    await page.getByRole('button', { name: '创建管理员' }).click()
    await expect(page.getByRole('heading', { name: '今天有什么可以帮到你？' })).toBeVisible()
    await expect(page).toHaveURL(`${site.origin}/`)

    await page.getByRole('textbox', { name: '消息' }).fill('周六想去看展，再找一家餐厅')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByRole('article', { name: '模型回复' })).toContainText('周六想去看展')
    const header = page.locator('.workspace-main header')
    await expect(header).toContainText('周六想去看展')
    title.resolve('周六看展与晚餐')
    await expect(header).toContainText('周六看展与晚餐')
    await page.reload()
    await expect(header).toContainText('周六看展与晚餐')
    const visitor = await browser.newPage()
    try {
      await visitor.goto(`${site.origin}/setup`)
      await expect(visitor.getByRole('heading', { name: '登录 Moonward' })).toBeVisible()
      await expect(visitor).toHaveURL(`${site.origin}/`)
    } finally { await visitor.close() }
  } finally {
    title.resolve('')
    await site.shutdown()
    await mock.close()
  }
})

test('Moonward shows white controls and its logo animation in both themes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page).toHaveTitle('Moonward')
  await expect(page.locator('.auth-top .brand')).toHaveText('Moonward')
  await expect(page.getByRole('heading', { name: '登录 Moonward' })).toBeVisible()
  const mark = page.locator('.auth-top .brand-mark')
  await expect.poll(() => mark.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect.poll(() => mark.evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe('moonward-mark-glint')
  await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await page.screenshot({ path: 'test-results/moonward-login.png' })

  await login(page)
  const sidebar = page.getByRole('complementary', { name: '对话侧栏' })
  await expect(sidebar.locator('.brand')).toHaveText('Moonward')
  const composer = page.locator('.composer')
  const message = page.getByRole('textbox', { name: '消息' })
  await message.fill('Moonward')
  const send = page.getByRole('button', { name: '发送消息' })
  await expect(send).toBeEnabled()
  await expect(send).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(send).toHaveCSS('color', 'rgb(32, 33, 36)')
  await expect(composer.locator('.composer-glow')).toBeHidden()
  await page.screenshot({ path: 'test-results/moonward-desktop.png' })

  await page.setViewportSize({ width: 320, height: 650 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect(page.locator('body')).toHaveAttribute('data-ds-dark-theme', '')
  await expect(page.locator('.workspace-main header .brand')).toHaveText('Moonward')
  await expect(send).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(composer.locator('.composer-glow')).toBeHidden()
  await expect.poll(() => page.locator('.workspace-main header .brand-mark').evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe('moonward-mark-glint')
  const box = (await composer.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(320)
  expect(box.y + box.height).toBeLessThanOrEqual(650)
  await page.screenshot({ path: 'test-results/moonward-mobile-dark.png' })
})

for (const colorScheme of ['dark', 'light'] as const) test(`composer edge breathes in sync in ${colorScheme} mode`, async ({ page }) => {
  await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  const composer = page.locator('.composer')
  const glow = composer.locator('.composer-glow')
  const message = page.getByRole('textbox', { name: '消息' })
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.route('**/api/runs', async (route) => {
    reached.resolve()
    await release.promise
    await route.continue()
  })
  await message.fill('SLOW 检查边缘呼吸')
  await expect(glow).toBeHidden()
  await page.getByRole('button', { name: '发送消息' }).click()
  await reached.promise
  try {
    await expect(message).toHaveAttribute('readonly', '')
    await expect(glow).toBeHidden()
  } finally { release.resolve() }

  await expect(glow).toHaveCSS('opacity', '1')
  await expect.poll(() => glow.evaluate((el) => getComputedStyle(el, '::after').animationPlayState)).toBe('running')
  const pulse = (progress: number) => glow.evaluate((layer, progress) => {
    const animation = layer.getAnimations({ subtree: true }).find((item) => item instanceof CSSAnimation && item.animationName === 'moonward-composer-breathe')!
    animation.pause()
    animation.currentTime = progress * Number(animation.effect!.getTiming().duration)
    return Number(getComputedStyle(layer, '::after').opacity)
  }, progress)
  const dimmest = await pulse(0)
  const rising = await pulse(.25)
  const brightest = await pulse(.5)
  expect(rising).toBeGreaterThan(dimmest)
  expect(brightest).toBeGreaterThan(rising)
  expect(await pulse(.75)).toBeCloseTo(rising)
  expect(await pulse(1)).toBeCloseTo(dimmest)

  const checkEdges = async (size: string) => {
    const prefix = `test-results/moonward-halo-${colorScheme}-${size}`
    const { x, y, width, height } = (await composer.boundingBox())!
    const margin = 12
    const left = Math.round(x), top = Math.round(y)
    const right = Math.round(x + width), bottom = Math.round(y + height)
    const clip = { x: left - margin, y: top - margin, width: right - left + 2 * margin, height: bottom - top + 2 * margin }
    const midX = Math.floor(clip.width / 2), midY = Math.floor(clip.height / 2)
    const bands = (offset: number, thickness: number) => [
      [midX, margin + offset, 1, thickness],
      [midX, clip.height - margin - offset - thickness, 1, thickness],
      [margin + offset, midY, thickness, 1],
      [clip.width - margin - offset - thickness, midY, thickness, 1],
    ]
    const points = [...bands(0, 4), ...bands(-4, 3), ...bands(-11, 3), [midX, midY, 1, 1]]
    await pulse(0)
    const dim = await page.screenshot({ clip, path: `${prefix}-dim.png` })
    await pulse(.5)
    const lit = await page.screenshot({ clip, path: `${prefix}-lit.png` })
    const [before, after] = await page.evaluate(async ({ frames, points }) => Promise.all(frames.map(async (png) => {
      const image = new Image()
      image.src = `data:image/png;base64,${png}`
      await image.decode()
      const { width, height } = image
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(image, 0, 0)
      return points.map(([x, y, w, h]) => {
        const pixels = ctx.getImageData(x, y, w, h).data
        return pixels.filter((_, i) => i % 4 < 3).reduce((sum, value) => sum + value, 0) / (w * h * 3)
      })
    })), { frames: [dim, lit].map((frame) => frame.toString('base64')), points })
    const deltas = after.map((value, i) => Math.abs(value - before[i]))
    const edges = deltas.slice(0, 4)
    expect(Math.min(...edges), `edge changes: ${edges}`).toBeGreaterThan(12)
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThan(8)
    const near = deltas.slice(4, 8), far = deltas.slice(8, 12)
    expect(Math.min(...near), `outer glow: ${near}`).toBeGreaterThan(5)
    for (const [side, value] of near.entries()) expect(far[side]).toBeLessThan(value / 2)
    expect(deltas[12]).toBeLessThan(2)
  }
  await checkEdges('desktop')
  await page.setViewportSize({ width: 320, height: 650 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()
  await expect(glow).toBeVisible()
  await checkEdges('mobile')
  await expect(page.getByRole('article', { name: '模型回复' })).toContainText('检查边缘呼吸。', { timeout: 10_000 })
  await expect(glow).toBeHidden()
})

test('waiting shows three dots and only reasoning animates the moon and thinking text', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  await page.getByRole('textbox', { name: '消息' }).fill('MOONWAIT 等待标志')
  await page.getByRole('button', { name: '发送消息' }).click()
  const reply = page.getByRole('article', { name: '模型回复' })
  const dots = reply.getByRole('status', { name: '正在等待回复' })
  const moon = reply.locator('.reply-moon')
  const shimmer = reply.locator('.thinking-shimmer')
  await expect(dots.locator('span')).toHaveCount(3)
  await expect(moon).toHaveCount(0)
  await expect(shimmer).toHaveCount(0)
  await expect(reply.getByText('思考中', { exact: true })).toBeVisible()
  await expect(dots).toHaveCount(0)
  await expect(moon).toBeVisible()
  await expect(moon.locator('rect, [stroke]')).toHaveCount(0)
  await expect(shimmer).toHaveCSS('animation-name', 'moonward-thinking-shimmer')
  await expect(shimmer).toHaveCSS('animation-iteration-count', 'infinite')
  await expect(shimmer).toHaveCSS('background-clip', 'text')
  const sweep = (progress: number) => shimmer.evaluate((el, progress) => {
    const animation = el.getAnimations().find((item) => item instanceof CSSAnimation && item.animationName === 'moonward-thinking-shimmer')!
    animation.pause()
    animation.currentTime = progress * Number(animation.effect!.getTiming().duration)
    return getComputedStyle(el).backgroundPosition
  }, progress)
  expect(await sweep(0)).toBe('100% 50%')
  const base = await shimmer.screenshot()
  expect(await sweep(.5)).toBe('50% 50%')
  const highlight = await shimmer.screenshot({ path: 'test-results/moonward-thinking-dark.png' })
  expect(highlight.equals(base)).toBe(false)
  await sweep(.999)
  expect((await shimmer.screenshot()).equals(base)).toBe(true)
  expect(await sweep(1)).toBe('100% 50%')
  const sample = (time: number) => moon.evaluate((el, time) => {
    for (const animation of el.getAnimations({ subtree: true })) {
      animation.pause()
      animation.currentTime = time
    }
    const shadow = getComputedStyle(el.querySelector('.reply-moon-shadow')!).transform
    const rotation = getComputedStyle(el.querySelector('.reply-moon-stars')!).transform
    return { offset: new DOMMatrixReadOnly(shadow).m41, rotation }
  }, time)
  const crescent = await sample(0)
  const narrow = await moon.screenshot({ path: 'test-results/moonward-reply-crescent.png' })
  const full = await sample(2300)
  const wide = await moon.screenshot({ path: 'test-results/moonward-reply-full.png' })
  expect(full.offset).toBeGreaterThan(crescent.offset + 12)
  expect(full.rotation).not.toEqual(crescent.rotation)
  const [crescentPixels, fullPixels] = await page.evaluate(async (frames) => Promise.all(frames.map(async (frame) => {
    const image = new Image()
    image.src = `data:image/png;base64,${frame}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(13, 13, 16, 16).data
    let bright = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 160) bright++
    return bright
  })), [narrow.toString('base64'), wide.toString('base64')])
  expect(fullPixels).toBeGreaterThan(crescentPixels * 1.6)

  await page.setViewportSize({ width: 320, height: 650 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await expect(moon).toBeVisible()
  await expect(moon).toHaveCSS('color', 'rgb(54, 57, 62)')
  await expect.poll(() => moon.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(0)
  await sweep(0)
  const lightBase = await shimmer.screenshot()
  await sweep(.5)
  const lightHighlight = await shimmer.screenshot({ path: 'test-results/moonward-thinking-light.png' })
  expect(lightHighlight.equals(lightBase)).toBe(false)
  await expect(reply).toContainText('等待标志。')
  await expect(moon).toHaveCount(0)
  await expect(shimmer).toHaveCount(0)
  await expect(reply.getByText(/^已思考/)).toBeVisible()
})

test('invites, live conversation, attachments and history across desktop and mobile', async ({ browser, page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  await expect(modelButton(page)).toHaveAccessibleName('模型：gpt-6.2-sol')
  await page.screenshot({ path: 'test-results/wenji-desktop.png' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号', exact: true }).click()
  await page.getByRole('button', { name: '站点管理' }).click()
  await expect(page.getByRole('columnheader', { name: '每日上限' })).toBeVisible()
  await page.screenshot({ path: 'test-results/wenji-admin.png' })
  await page.getByRole('button', { name: '邀请用户' }).click()
  await page.getByLabel('受邀邮箱').fill('invited@example.test')
  await page.getByRole('button', { name: '生成邀请' }).click()
  const inviteField = page.getByLabel('邀请链接（24 小时有效）')
  await expect(inviteField).toBeVisible()
  const invite = await inviteField.inputValue()

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' })
  const phone = await mobile.newPage()
  phone.on('pageerror', (e) => errors.push(e.message))
  await phone.goto(invite)
  await expect(phone.getByLabel('邮箱')).toHaveValue('invited@example.test')
  await phone.getByLabel('显示名称').fill('体验用户')
  const invitePassword = phone.getByLabel('密码', { exact: true })
  await expect(invitePassword).toHaveAttribute('minlength', '10')
  await invitePassword.fill(minimumPassword)
  await phone.getByRole('button', { name: '创建账号' }).click()
  await expect(modelButton(phone)).toHaveAccessibleName('模型：gpt-6.2-sol')
  await phone.screenshot({ path: 'test-results/wenji-mobile-welcome.png' })
  await phone.locator('input[type=file]').setInputFiles([
    { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('SAMPLE') },
    { name: 'test.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') },
    { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64') },
  ])
  await expect(phone.getByRole('button', { name: '移除 note.txt' })).toBeVisible()
  await expect.poll(() => phone.getByRole('img', { name: 'pixel.png' }).evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1)
  await phone.getByRole('button', { name: '智能搜索', exact: true }).click()
  await phone.getByRole('textbox', { name: '消息' }).fill('查看 Responses API 文档')
  await phone.getByRole('button', { name: '发送消息' }).click()
  await expect(phone.getByText('Responses API 支持流式输出。', { exact: true })).toBeVisible()
  await expect(phone.getByRole('link', { name: '来源 1：OpenAI 流式输出文档' })).toHaveAttribute('href', /developers\.openai\.com/)
  await expect(phone.getByRole('link', { name: 'test.pdf' })).toBeVisible()
  const preview = phone.locator('.message-attachment img')
  await expect.poll(() => preview.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1)
  const width = await phone.evaluate(() => ({ screen: window.innerWidth, page: document.documentElement.scrollWidth }))
  expect(width.page).toBeLessThanOrEqual(width.screen)
  const composer = await phone.locator('.composer').boundingBox()
  expect(composer!.y + composer!.height).toBeLessThan(844)
  await phone.screenshot({ path: 'test-results/wenji-mobile.png' })
  const sources = phone.getByRole('article', { name: '模型回复' }).getByRole('region', { name: '引用网页' })
  await expect(sources.getByRole('link', { name: /OpenAI 流式输出文档/ })).toHaveAttribute('href', /developers\.openai\.com/)
  await expect(sources.getByRole('link')).toHaveCount(1)
  await expect(phone.locator('.source-panel')).toHaveCount(0)
  await phone.getByRole('button', { name: '打开对话侧栏' }).click()
  await phone.screenshot({ path: 'test-results/wenji-mobile-sidebar.png' })
  await phone.getByRole('button', { name: '设置', exact: true }).click()
  await phone.getByRole('button', { name: '账号', exact: true }).click()
  await expect(phone.getByRole('button', { name: '站点管理' })).toHaveCount(0)
  await phone.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()

  const second = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  try {
    const laptop = await second.newPage()
    await login(laptop, 'invited@example.test', minimumPassword)
    await laptop.getByRole('navigation', { name: '对话历史' }).getByRole('button', { name: '查看 Responses API 文档', exact: true }).click()
    await expect(laptop.getByText('Responses API 支持流式输出。', { exact: true })).toBeVisible()
    await expect(laptop.getByRole('link', { name: 'note.txt' })).toBeVisible()
    await laptop.getByRole('button', { name: '编辑消息' }).click()
    await laptop.getByRole('textbox', { name: '编辑消息内容' }).fill('第二个分支')
    await laptop.getByRole('button', { name: '发送新分支' }).click()
    await expect(laptop.getByText('2 / 2', { exact: true })).toBeVisible()
    await laptop.getByRole('button', { name: '上一分支' }).click()
    await expect(laptop.getByText('Responses API 支持流式输出。', { exact: true })).toBeVisible()
    await laptop.reload()
    await expect(laptop.getByText('Responses API 支持流式输出。', { exact: true })).toBeVisible()
  } finally { await second.close(); await mobile.close() }
  expect(errors).toEqual([])
})

test('administrator manages user accounts from the dashboard', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await login(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号', exact: true }).click()
  await page.getByRole('button', { name: '站点管理' }).click()

  await page.getByRole('button', { name: '新增用户', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '新增用户' })
  await editor.getByLabel('邮箱').fill('managed-ui@example.test')
  await editor.getByLabel('显示名称').fill('界面用户')
  const initialPassword = editor.getByLabel('密码', { exact: true })
  await expect(initialPassword).toHaveAttribute('minlength', '10')
  await initialPassword.fill(minimumPassword)
  await editor.getByLabel('每日请求上限').fill('9')
  await page.mouse.click(4, 4)
  await page.keyboard.press('Escape')
  await expect(editor).toBeVisible()
  await expect(editor.getByLabel('显示名称')).toHaveValue('界面用户')
  await editor.getByRole('button', { name: '创建账号' }).click()
  await expect(page.getByText('界面用户', { exact: true })).toBeVisible()
  await expect(page.getByText('managed-ui@example.test', { exact: true })).toBeVisible()

  const search = page.getByLabel('搜索用户')
  const rows = page.locator('.users-table tbody tr')
  await search.fill('MANAGED-UI@example.test')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('managed-ui@example.test')
  await page.screenshot({ path: 'test-results/moonward-admin-users-desktop.png' })
  await page.getByRole('button', { name: '编辑 界面用户' }).click()
  const edit = page.getByRole('dialog', { name: '编辑用户' })
  await edit.getByLabel('显示名称').fill('已编辑用户')
  await edit.getByLabel('每日请求上限').fill('12')
  const newPassword = edit.getByLabel('新密码', { exact: true })
  await expect(newPassword).toHaveAttribute('minlength', '10')
  await newPassword.fill('Reset-123!')
  await edit.getByRole('button', { name: '保存修改' }).click()
  await expect(page.getByText('已编辑用户', { exact: true })).toBeVisible()
  await expect(page.getByText('界面用户', { exact: true })).toHaveCount(0)
  await search.fill('已编辑用户')
  await expect(rows).toHaveCount(1)
  await expect(rows.first().getByRole('spinbutton')).toHaveValue('12')

  await page.setViewportSize({ width: 320, height: 650 })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-ds-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-ds-dark-theme')
    await rows.first().scrollIntoViewIfNeeded()
    const view = page.locator('.admin-view')
    expect(await view.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const bounds = (await view.boundingBox())!
    for (const name of ['编辑 已编辑用户', '停用', '删除 已编辑用户']) {
      const action = rows.first().getByRole('button', { name, exact: true })
      await expect(action).toBeInViewport()
      const box = (await action.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(bounds.x)
      expect(box.x + box.width).toBeLessThanOrEqual(Math.min(320, bounds.x + bounds.width))
    }
    await page.screenshot({ path: `test-results/moonward-admin-users-mobile-${theme}.png` })
  }

  await rows.first().getByRole('button', { name: '停用', exact: true }).click()
  await page.getByRole('button', { name: '确认停用' }).click()
  await expect(rows.first()).toContainText('已停用')
  await rows.first().getByRole('button', { name: '启用', exact: true }).click()
  await page.getByRole('button', { name: '确认启用' }).click()
  await expect(rows.first()).toContainText('正常')

  await page.getByRole('button', { name: '删除 已编辑用户' }).click()
  const remove = page.getByRole('dialog', { name: '删除账号' })
  await expect(remove).toContainText('managed-ui@example.test')
  await remove.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('未找到用户', { exact: true })).toBeVisible()
  await expect(page.getByText('managed-ui@example.test', { exact: true })).toHaveCount(0)
})

test('composer toolbar distinguishes search states and fits both themes and screen sizes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  const search = page.getByRole('button', { name: '智能搜索', exact: true })
  const dial = page.getByRole('dialog', { name: '推理深度' })
  const slider = dial.getByRole('slider', { name: '推理深度' })
  const model = modelButton(page)
  const toolbar = page.locator('.composer-toolbar')
  await expect(search).toBeEnabled()
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-ds-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-ds-dark-theme')
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 650 : 900 })
      const boxes = await toolbar.evaluate((row) => {
        const rect = (selector: string) => row.querySelector(selector)!.getBoundingClientRect()
        const model = rect('.composer-model')
        const label = rect('.composer-model-label')
        const depth = rect('.composer-model-effort')
        const arrow = rect('.model-chevron')
        return { gaps: [depth.left - label.right, arrow.left - depth.right], label: label.width, searchBeforeModel: rect('.composer-search').right <= model.left,
          modelOnRight: row.querySelector('.composer-actions')!.contains(row.querySelector('.composer-model')),
          sendInsideRow: rect('[aria-label="发送消息"]').right <= row.getBoundingClientRect().right }
      })
      expect(boxes).toMatchObject({ gaps: [5, 5], searchBeforeModel: true, modelOnRight: true, sendInsideRow: true })
      expect(boxes.label).toBeGreaterThan(25)
      await expect(model).toHaveAccessibleName('模型：gpt-6.2-sol')
      const depth = model.locator('.composer-model-effort')
      await expect(depth).toHaveText('默认')
      await expect(search).toHaveAttribute('aria-pressed', 'false')
      await expect(search.locator('svg.lucide-earth')).toBeVisible()
      await expect(search).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await toolbar.screenshot({ path: `test-results/moonward-toolbar-${theme}-${width}-off.png` })
      await search.click()
      await expect(search).toHaveAttribute('aria-pressed', 'true')
      await expect(search).toHaveCSS('background-color', theme === 'light' ? 'rgb(229, 240, 255)' : 'rgb(31, 65, 104)')
      await expect(search.locator('svg.lucide-check')).toBeVisible()
      await toolbar.screenshot({ path: `test-results/moonward-toolbar-${theme}-${width}-on.png` })
      await model.click()
      await expect(slider).toBeFocused()
      await expect(dial.locator('.effort-moon')).toBeVisible()
      const popup = (await dial.boundingBox())!
      const trigger = (await model.boundingBox())!
      expect(popup.width).toBe(width === 320 ? 304 : 282)
      const center = popup.x + popup.width / 2
      expect(center).toBeCloseTo(width === 320 ? width / 2 : trigger.x + trigger.width / 2, 0)
      expect(popup.height).toBeLessThan(100)
      const scale = (await dial.locator('.effort-scale').boundingBox())!
      expect(scale.x - popup.x).toBe(7)
      expect(popup.x + popup.width - scale.x - scale.width).toBe(7)
      expect(popup.y + popup.height - scale.y - scale.height).toBe(5)
      expect(popup.x).toBeGreaterThanOrEqual(8)
      expect(popup.x + popup.width).toBeLessThanOrEqual(width - 8)
      const below = page.viewportSize()!.height - trigger.y - trigger.height - 16
      if (below >= popup.height) expect(popup.y).toBeGreaterThanOrEqual(trigger.y + trigger.height + 6)
      else expect(popup.y + popup.height).toBeLessThanOrEqual(trigger.y - 6)
      await slider.press('ArrowRight')
      await expect(slider).toHaveValue('1')
      await expect(depth).toHaveText('低')
      await page.screenshot({ path: `test-results/moonward-depth-${theme}-${width}.png` })
      await slider.press('End')
      await expect(depth).toHaveText('中')
      await page.screenshot({ path: `test-results/moonward-depth-${theme}-${width}-full.png` })
      await slider.press('Home')
      await search.click()
      await expect(dial).toHaveCount(0)
      await expect(search).toHaveAttribute('aria-pressed', 'false')
      await page.mouse.move(0, 0)
    }
  }
})

async function expectEffortFill(slider: Locator, step: number) {
  const geometry = await slider.evaluate((input: HTMLInputElement) => {
    const track = input.parentElement!.querySelector('.effort-track')!
    const fillElement = track.firstElementChild!
    const fill = fillElement.getBoundingClientRect()
    const rail = track.getBoundingClientRect()
    const moon = input.parentElement!.querySelector('.effort-moon')!
    const marker = moon.getBoundingClientRect()
    const unlit = moon.querySelector('.effort-moon-unlit')!
    const disc = unlit.getBoundingClientRect()
    const position = rail.width * input.valueAsNumber / Number(input.max)
    return { value: input.valueAsNumber, expectedFill: position, fillWidth: fill.width,
      shiftX: marker.x + marker.width / 2 - fill.right,
      shiftY: marker.y + marker.height / 2 - rail.y - rail.height / 2,
      coversRail: disc.top < rail.top && disc.bottom > rail.bottom,
      unlitColor: getComputedStyle(unlit).fill,
      railColor: getComputedStyle(track).backgroundColor,
      fillRadius: getComputedStyle(fillElement).borderTopRightRadius }
  })
  expect(geometry.value).toBe(step)
  expect(geometry.fillWidth).toBeCloseTo(geometry.expectedFill, 1)
  expect(geometry.shiftX).toBeCloseTo(0, 1)
  expect(geometry.shiftY).toBeCloseTo(0, 1)
  expect(geometry.coversRail).toBe(true)
  expect(geometry.unlitColor).toBe(geometry.railColor)
  expect(geometry.fillRadius).toBe('0px')
}

async function mockReasoningLevels(page: Page, efforts: readonly Effort[]) {
  await page.route('**/api/models', async (route) => {
    const response = await route.fetch()
    const models = await response.json() as Model[]
    await route.fulfill({ response, json: models.map((model) => model.id === 'gpt-6.2-sol'
      ? { ...model, efforts } : model) })
  })
}

test('each reasoning level joins the moon and track without gaps', async ({ page }) => {
  test.setTimeout(60_000)
  await mockReasoningLevels(page, effortLevels)
  await login(page)
  const model = modelButton(page)
  const dialog = page.getByRole('dialog', { name: '推理深度' })
  const slider = dialog.getByRole('slider')
  const steps = ['默认', '关闭', '极低', '低', '中', '高', '极高', '最大']
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 650 : 900 })
      await model.click()
      await slider.press('Home')
      for (const [step, label] of steps.entries()) {
        if (step) await slider.press('ArrowRight')
        await expectEffortFill(slider, step)
        await expect(model.locator('.composer-model-effort')).toHaveText(label)
        await dialog.locator('.effort-scale').evaluate(async (element) => {
          const animations = element.getAnimations({ subtree: true })
          for (const animation of animations) {
            if (animation instanceof CSSTransition) animation.finish()
            else { animation.pause(); animation.currentTime = 900 }
          }
          await Promise.all(animations.map((animation) => animation.ready))
        })
        const seam = await dialog.evaluate((panel) => {
          const frame = panel.getBoundingClientRect()
          const moon = panel.querySelector('.effort-moon')!.getBoundingClientRect()
          const track = panel.querySelector('.effort-track')!.getBoundingClientRect()
          return { x: moon.x + moon.width / 2 - Math.floor(frame.x),
            top: track.top - Math.floor(frame.y), bottom: track.bottom - Math.floor(frame.y) }
        })
        const image = await dialog.screenshot({ scale: 'css', path: `test-results/moonward-depth-levels/${colorScheme}-${width}-${step}.png` })
        const probe = await dialog.screenshot({ scale: 'css', style: '.model-popover[data-effort] { background-color: #ff00ff !important; }' })
        const gaps = await page.evaluate(async ({ images, seam, hasBlue, hasGray }) => {
          const top = Math.ceil(seam.top) + 1, bottom = Math.floor(seam.bottom) - 1
          const from = Math.ceil(seam.x) - (hasBlue ? 13 : 0)
          const to = Math.floor(seam.x) + (hasGray ? 13 : 0)
          const [normal, contrasting] = await Promise.all(images.map(async (png) => {
            const image = new Image()
            image.src = `data:image/png;base64,${png}`
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width; canvas.height = image.height
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(image, 0, 0)
            return ctx.getImageData(from, top, to - from + 1, bottom - top).data
          }))
          let gaps = 0
          for (let i = 0; i < normal.length; i++) if (Math.abs(normal[i] - contrasting[i]) > 3) gaps++
          return gaps
        }, { images: [image.toString('base64'), probe.toString('base64')], seam, hasBlue: step > 0, hasGray: step < steps.length - 1 })
        expect(gaps, `${colorScheme} ${width}px ${label}`).toBe(0)
      }
      await slider.press('Escape')
    }
  }
})

test('reasoning moon animates by depth while the fill follows the mouse', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
  await mockReasoningLevels(page, ['low', 'medium', 'high', 'xhigh', 'max'])
  await login(page)
  const model = modelButton(page)
  await model.click()
  const slider = page.getByRole('slider', { name: '推理深度' })
  const moon = page.locator('.effort-moon')
  const depth = model.locator('.composer-model-effort')
  const max = Number(await slider.getAttribute('max'))
  expect(max).toBe(5)
  const track = (await page.locator('.effort-track').boundingBox())!
  const y = track.y + track.height / 2
  await page.mouse.move(track.x, y)
  await page.mouse.down()
  for (const [step, name] of [[1, '低'], [4, '极高'], [max, '最大'], [3, '高'], [0, '默认']] as const) {
    await page.mouse.move(track.x + track.width * step / max, y)
    await expectEffortFill(slider, step)
    await expect(depth).toHaveText(name)
    if (step !== 4) continue
    const frames = await moon.evaluate((el) => {
      const shadow = el.querySelector('.effort-moon-shadow')!
      const stars = Array.from(el.querySelector('.effort-moon-stars')!.children)
      const motion = el.getAnimations({ subtree: true })
      return [0, 90, 240].map((time) => {
        for (const animation of motion) { animation.pause(); animation.currentTime = time }
        return { offset: new DOMMatrixReadOnly(getComputedStyle(shadow).transform).m41,
          stars: stars.map((star) => Number(getComputedStyle(star).opacity)) }
      })
    })
    const [crescent, changing, settled] = frames
    expect(crescent.stars).toEqual([0, 0, 0])
    expect(settled.stars[0]).toBe(1)
    expect(settled.stars[1]).toBeCloseTo(.7)
    expect(settled.stars[2]).toBeCloseTo(.25)
    expect(changing.stars[0]).toBeGreaterThan(0)
    expect(changing.stars[0]).toBeLessThan(1)
    expect(changing.offset).toBeGreaterThan(crescent.offset)
    expect(changing.offset).toBeLessThan(settled.offset)
    expect(settled.offset).toBeCloseTo(17.8)
  }
  await page.mouse.up()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await slider.press('End')
  await expect(depth).toHaveText('最大')
  await expect.poll(() => moon.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(0)
})

test('maximum reasoning loops the moon and sends stars toward it', async ({ page }) => {
  test.setTimeout(45_000)
  await mockReasoningLevels(page, effortLevels)
  await login(page)
  const model = modelButton(page)
  const dialog = page.getByRole('dialog', { name: '推理深度' })
  const slider = dialog.getByRole('slider')
  const fill = dialog.locator('.effort-track-fill')
  const sparks = fill.locator('.effort-track-spark')
  const sample = (phase: number, flight: number) => dialog.evaluate((el, { phase, flight }) => {
    const loops = el.getAnimations({ subtree: true }).filter((animation): animation is CSSAnimation =>
      animation instanceof CSSAnimation && animation.effect?.getTiming().iterations === Infinity)
    const firstFlight = loops.find((animation) => animation.animationName === 'moonward-rail-flight')
    for (const animation of loops) {
      const { delay, duration } = animation.effect!.getTiming()
      animation.pause()
      const flying = animation.animationName === 'moonward-rail-flight'
      const start = flying ? firstFlight?.effect?.getTiming().delay : delay
      animation.currentTime = Number(duration) * (1 + (flying ? flight : phase)) + (start ?? 0)
    }
    const shadow = getComputedStyle(el.querySelector('.effort-moon-shadow')!)
    const orbit = getComputedStyle(el.querySelector('.effort-moon-stars')!)
    const spark = getComputedStyle(el.querySelector('.effort-track-spark')!)
    return {
      loops: loops.map((animation) => animation.animationName),
      offset: new DOMMatrixReadOnly(shadow.transform).m41,
      orbit: orbit.transform,
      x: new DOMMatrixReadOnly(spark.transform).m41,
      opacity: Number(spark.opacity),
    }
  }, { phase, flight })

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 650 : 900 })
      await model.click()
      await slider.press('End')
      await expectEffortFill(slider, effortLevels.length)
      await expect(fill).toHaveCSS('background-image', /^linear-gradient\(90deg,/)
      await expect(sparks).toHaveCount(3)
      const crescent = await sample(0, .22)
      await dialog.screenshot({ path: `test-results/moonward-depth-max-${colorScheme}-${width}-crescent.png` })
      const full = await sample(.60, .82)
      await dialog.screenshot({ path: `test-results/moonward-depth-max-${colorScheme}-${width}-full.png` })
      const looped = await sample(1, 1)
      expect(crescent.loops).toEqual(expect.arrayContaining(['moonward-lunar-phase', 'moonward-star-orbit', 'moonward-rail-flight']))
      expect(full.offset).toBeGreaterThan(crescent.offset + 12)
      expect(looped.offset).toBeCloseTo(crescent.offset)
      expect(full.orbit).not.toEqual(crescent.orbit)
      expect(full.x - crescent.x).toBeGreaterThan(100)
      expect(crescent.opacity).toBeGreaterThan(.5)
      expect(looped.opacity).toBe(0)

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(sparks.first()).toBeVisible()
      await expect(fill).toHaveCSS('background-image', /^linear-gradient\(90deg,/)
      await expect.poll(() => dialog.locator('.effort-scale').evaluate((el) => el.getAnimations({ subtree: true }).length)).toBeGreaterThanOrEqual(5)
      await slider.press('ArrowLeft')
      await expect(fill).toHaveCSS('background-image', 'none')
      await expect(sparks).toHaveCount(0)
      await slider.press('Escape')
    }
  }
})

test('maximum reasoning motion stays on despite a legacy disabled preference', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.addInitScript(() => localStorage.setItem('wenji:effort-motion', 'disabled'))
  await mockReasoningLevels(page, ['low', 'medium', 'high', 'xhigh', 'max'])
  await login(page)
  const model = modelButton(page)
  const dialog = page.getByRole('dialog', { name: '推理深度' })
  const slider = dialog.getByRole('slider')
  const scale = dialog.locator('.effort-scale')
  const loops = () => scale.evaluate((el) => el.getAnimations({ subtree: true }).flatMap((a) =>
    a instanceof CSSAnimation && a.effect?.getTiming().iterations === Infinity ? [a.animationName] : []))
  const expected = expect.arrayContaining(['moonward-lunar-phase', 'moonward-star-orbit', 'moonward-rail-flight'])

  await model.click()
  await slider.press('End')
  await expect(slider).toHaveAttribute('aria-valuetext', '最大')
  await expect.poll(loops).toEqual(expected)
  await slider.press('Escape')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await expect(settings.getByText('推理滑块动画')).toHaveCount(0)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 320, height: 650 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.reload()
  await model.click()
  await expect(slider).toHaveAttribute('aria-valuetext', '最大')
  await expect.poll(loops).toEqual(expected)
})

test('mobile touch drag selects a discrete reasoning level from the model picker', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 650 }, isMobile: true, hasTouch: true })
  try {
    const phone = await context.newPage()
    await login(phone)
    await modelButton(phone).tap()
    const slider = phone.getByRole('slider', { name: '推理深度' })
    await expect(slider).toHaveValue('0')
    const max = Number(await slider.getAttribute('max'))
    const range = (await slider.boundingBox())!
    const y = Math.round(range.y + range.height / 2)
    const left = Math.round(range.x + 9)
    const right = Math.round(range.x + range.width - 9)
    const input = await context.newCDPSession(phone)
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: left, y }] })
    for (let step = 1; step <= 8; step++) {
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(left + (right - left) * step / 8), y }] })
      if (step === 4 || step === 8) await expectEffortFill(slider, Math.round(max * step / 8))
    }
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(slider).toHaveValue(String(max))
    await expect(modelListButton(phone)).not.toContainText('跟随默认')
  } finally { await context.close() }
})

test('chat-demo geometry, persistent theme and history actions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  const composer = page.locator('.composer')
  const sidebar = page.getByRole('complementary', { name: '对话侧栏' })
  const model = modelButton(page)
  await expect(model).toHaveAccessibleName('模型：gpt-6.2-sol')
  await expect(composer).toHaveCSS('border-radius', '24px')
  await expect(sidebar).toHaveCSS('width', '261px')
  await expect(composer).toHaveCSS('width', '776px')

  await page.getByRole('button', { name: '收起侧栏' }).click()
  await expect(sidebar).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: '打开对话侧栏' })).toBeVisible()
  await page.getByRole('button', { name: '打开对话侧栏' }).click()
  await sidebar.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByText('深色', { exact: true }).click()
  await expect(page.locator('body')).toHaveAttribute('data-ds-dark-theme', '')
  await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await expect(model).toHaveAccessibleName('模型：gpt-6.2-sol')
  await expect(composer).toHaveCSS('background-color', 'rgb(44, 44, 46)')
  await page.screenshot({ path: 'test-results/wenji-desktop-dark.png' })

  for (const width of [768, 767, 390, 320]) {
    await page.setViewportSize({ width, height: 650 })
    const tools = await composer.locator('.composer-toolbar').evaluate((row) => {
      const [left, right] = [...row.children].map((child) => child.getBoundingClientRect())
      const lastButton = row.querySelector('[aria-label="发送消息"]')!.getBoundingClientRect()
      const lastToggle = row.querySelector('[aria-label="智能搜索"]')!.getBoundingClientRect()
      return { overlap: lastToggle.right > right.left, overflow: lastButton.right > row.getBoundingClientRect().right,
        sideBySide: left.top < lastButton.bottom && right.bottom <= row.getBoundingClientRect().bottom }
    })
    expect(tools, `composer layout at ${width}px`).toEqual({ overlap: false, overflow: false, sideBySide: true })
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await model.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'gpt-6.2-sol', checked: true })).toBeFocused()
  await page.getByRole('menuitemradio', { name: 'gpt-6.2-sol' }).press('Escape')
  await expect(model).toBeFocused()
  await model.click()
  await modelListButton(page).click()
  await page.getByRole('menuitemradio', { name: 'gpt-test-text' }).click()
  await expect(page.getByRole('button', { name: '添加附件' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '智能搜索' })).toHaveCount(0)
  await page.getByRole('textbox', { name: '消息' }).fill('测试会话菜单')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.getByRole('article', { name: '模型回复' })).toContainText('测试会话菜单。')
  const history = page.getByRole('navigation', { name: '对话历史' })
  const menu = history.getByRole('button', { name: '测试会话菜单：更多' })
  await menu.click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  const rename = history.getByRole('textbox', { name: '对话名称' })
  await rename.fill('重命名成功')
  await rename.press('Enter')
  await expect(history.getByRole('button', { name: '重命名成功', exact: true })).toBeVisible()
  await history.getByRole('button', { name: '重命名成功：更多' }).click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  await page.getByRole('dialog', { name: '永久删除对话' }).getByRole('button', { name: '删除' }).click()
  await expect(history.getByRole('button', { name: '重命名成功', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '今天有什么可以帮到你？' })).toBeVisible()
})

test('history search and inline rename keep clear boundaries in both themes', async ({ page }) => {
  await login(page)
  const headers = { Origin: new URL(page.url()).origin }
  for (const title of ['其他对话', '周末行程', '周末安排']) {
    const created = await page.request.post('/api/chats', { headers, data: {} })
    expect(created.ok()).toBe(true)
    const { id, version } = await created.json()
    expect((await page.request.patch(`/api/chats/${id}`, { headers, data: { title, version } })).ok()).toBe(true)
  }
  await page.reload()
  const sidebar = page.getByRole('complementary', { name: '对话侧栏' })
  for (const [width, colorScheme] of [[1440, 'light'], [320, 'dark']] as const) {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width, height: 700 })
    if (width < 768) await page.getByRole('button', { name: '打开对话侧栏' }).click()
    await sidebar.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '搜索对话' }).click()
    const search = sidebar.getByRole('searchbox', { name: '搜索对话' })
    await expect(search).toBeFocused()
    await search.fill('周末')
    await expect(search).toHaveCSS('outline-style', 'none')
    await expect(sidebar.locator('.history-item')).toHaveCount(2)
    await sidebar.screenshot({ path: `test-results/moonward-history-search-${colorScheme}.png` })

    await sidebar.getByRole('button', { name: '周末行程：更多' }).click()
    await page.getByRole('menuitem', { name: '重命名' }).click()
    const editor = sidebar.getByRole('textbox', { name: '对话名称' })
    await editor.fill('不会因失焦而保存')
    await search.focus()
    await expect(editor).toHaveValue('不会因失焦而保存')
    const rows = await sidebar.locator('.history-item').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))
    expect(rows[1].top - rows[0].bottom).toBeGreaterThanOrEqual(5)
    const box = (await editor.boundingBox())!
    const parent = (await sidebar.locator('.history-item:has(input[name="title"])').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(parent.x)
    expect(box.x + box.width).toBeLessThan(parent.x + parent.width)
    await sidebar.screenshot({ path: `test-results/moonward-history-rename-${colorScheme}.png` })
    await sidebar.getByRole('button', { name: '取消重命名' }).click()
    await expect(sidebar.getByRole('button', { name: '周末行程', exact: true })).toBeVisible()
    await sidebar.getByRole('button', { name: '清空搜索' }).click()
    await expect(search).toHaveValue('')
    await expect(sidebar.getByRole('button', { name: '其他对话', exact: true })).toBeVisible()
    await sidebar.getByRole('button', { name: '关闭搜索' }).click()
  }
})

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`only new streamed text fades (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion })
    await page.setViewportSize({ width: reducedMotion === 'reduce' ? 320 : 1280, height: 780 })
    await login(page)
    await page.evaluate(() => {
      document.addEventListener('animationstart', (event) => {
        if (event.animationName !== 'ds-markdown-stream-reveal' || !(event.target instanceof HTMLElement)) return
        const target = event.target
        const samples = JSON.parse(document.body.dataset.streamFades || '[]')
        const previous = target.previousElementSibling
        samples.push({ text: target.textContent?.trim(), opacity: Number(getComputedStyle(target).opacity),
          previousOpacity: previous ? Number(getComputedStyle(previous).opacity) : null })
        document.body.dataset.streamFades = JSON.stringify(samples)
      })
    })
    await page.getByRole('textbox', { name: '消息' }).fill('STREAM_FADE')
    await page.getByRole('button', { name: '发送消息' }).click()
    const reply = page.getByRole('article', { name: '模型回复' })
    await expect(reply).toContainText('First words. More words.')
    await expect(reply.locator('strong')).toHaveText('Final words.')
    await expect(reply.locator('.ds-markdown-stream-chunk')).toHaveCount(0)

    const samples = await page.evaluate(() => JSON.parse(document.body.dataset.streamFades || '[]') as
      { text: string; opacity: number; previousOpacity: number | null }[])
    expect(samples.map(({ text }) => text)).toEqual(['First words.', 'More words.', 'Final words.'])
    expect(samples[1].previousOpacity).toBe(1)
    for (const { opacity } of samples) expect(opacity).toBeLessThan(1)
    await page.reload()
    await expect(reply.locator('strong')).toHaveText('Final words.')
    await expect(reply.locator('.ds-markdown-stream-chunk')).toHaveCount(0)
  })
}

test('switching during preparation or streaming keeps the original reply and the other draft separate', async ({ page }) => {
  await login(page)
  const input = page.getByRole('textbox', { name: '消息' })
  const send = page.getByRole('button', { name: '发送消息' })
  const reply = page.getByRole('article', { name: '模型回复' })
  const history = page.getByRole('navigation', { name: '对话历史' })
  await input.fill('历史对话')
  await send.click()
  await expect(reply).toContainText('历史对话。')
  const old = history.getByRole('button', { name: '历史对话', exact: true })
  await page.getByRole('button', { name: '开启新对话' }).click()

  const release = Promise.withResolvers<void>()
  const creating = Promise.withResolvers<void>()
  await page.route('**/api/chats', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    creating.resolve()
    await release.promise
    return route.continue()
  })
  await input.fill('SWITCH 跨会话继续')
  await send.click()
  await creating.promise
  try {
    await old.click()
    await expect(reply).toContainText('历史对话。')
    await input.fill('另一条对话的草稿')
    await expect(send).toBeEnabled()
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  } finally { release.resolve() }

  const live = history.getByRole('button', { name: 'SWITCH 跨会话继续', exact: true })
  await live.click()
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()
  await expect(reply.locator('.ds-markdown')).not.toBeEmpty()
  await old.click()
  await expect(input).toHaveValue('另一条对话的草稿')
  await expect(send).toBeEnabled()
  await expect(old).toHaveAttribute('aria-current', 'page')
  await expect(reply).toContainText('历史对话。')
  await live.click()
  await expect(reply).toContainText('跨会话继续。')
  await expect(reply).not.toContainText('连接已中断')
})

test('two new chats generate in the same tab and stopping one leaves the other running', async ({ page }) => {
  await login(page)
  const input = page.getByRole('textbox', { name: '消息' })
  const send = page.getByRole('button', { name: '发送消息' })
  const stop = page.getByRole('button', { name: '停止生成' })
  const newChat = page.getByRole('button', { name: '开启新对话' })
  const reply = page.getByRole('article', { name: '模型回复' })
  const history = page.getByRole('navigation', { name: '对话历史' })
  const glow = page.locator('.composer-glow')
  await input.fill('SLOW 第一条独立回复')
  await send.click()
  await expect(reply.locator('.ds-markdown')).not.toBeEmpty()
  const first = history.getByRole('button', { name: 'SLOW 第一条独立回复', exact: true })
  await expect(first).toBeVisible()
  await expect(glow).toBeVisible()

  await newChat.click()
  await expect(glow).toBeHidden()
  await input.fill('SLOW 第二条独立回复')
  await expect(send).toBeEnabled()
  await send.click()
  await expect(reply.locator('.ds-markdown')).not.toBeEmpty()
  const second = history.getByRole('button', { name: 'SLOW 第二条独立回复', exact: true })
  await expect(second).toHaveAttribute('aria-current', 'page')
  await stop.click()
  await expect(reply).toContainText('已停止')
  await expect(glow).toBeHidden()

  await first.click()
  await expect(stop).toBeVisible()
  await expect(glow).toBeVisible()
  await expect(reply).toContainText('第一条独立回复。', { timeout: 10_000 })
  await expect(reply).not.toContainText('已停止')
  await second.click()
  await expect(reply).toContainText('已停止')
  await expect(reply).not.toContainText('第一条独立回复')
})

test('a broken browser stream syncs the saved reply while another chat generates', async ({ page }) => {
  await login(page)
  let sends = 0
  page.on('request', (request) => { if (request.url().endsWith('/api/runs') && request.method() === 'POST') sends++ })
  await page.evaluate(() => {
    const fetchResponse = window.fetch.bind(window)
    window.fetch = async (path, init) => {
      const result = await fetchResponse(path, init)
      if (!/^\/api\/runs\/[^/]+\/events$/.test(String(path)) || !result.ok || !result.body) return result
      const reader = result.body.getReader()
      let disconnected = false
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          window.addEventListener('test-disconnect', () => {
            disconnected = true
            controller.error(new TypeError('Test: downstream connection lost'))
            void reader.cancel().catch(() => {})
          }, { once: true })
        },
        async pull(controller) {
          const chunk = await reader.read()
          if (disconnected) return
          if (chunk.done) controller.close()
          else controller.enqueue(chunk.value)
        },
      })
      return new Response(stream, { status: result.status, headers: result.headers })
    }
  })
  await page.getByRole('textbox', { name: '消息' }).fill('RECONNECT 取回完整回复')
  await page.getByRole('button', { name: '发送消息' }).click()
  const reply = page.getByRole('article', { name: '模型回复' })
  await expect(reply.locator('.ds-markdown')).not.toBeEmpty()
  const original = page.getByRole('navigation', { name: '对话历史' }).getByRole('button', { name: 'RECONNECT 取回完整回复', exact: true })
  await page.evaluate(() => window.dispatchEvent(new Event('test-disconnect')))
  await page.getByRole('button', { name: '开启新对话' }).click()
  await page.getByRole('textbox', { name: '消息' }).fill('恢复期间并发发送')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(reply).toContainText('恢复期间并发发送。')
  await original.click()
  await expect(reply).toContainText('取回完整回复。', { timeout: 9_000 })
  await expect(reply).not.toContainText('连接已中断')
  expect(sends).toBe(2)
})

test('refresh during a reply reconnects to the same run without submitting twice', async ({ page }) => {
  await login(page)
  let submissions = 0
  const streams: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path === '/api/runs' && request.method() === 'POST') submissions++
    if (/^\/api\/runs\/[^/]+\/events$/.test(path)) streams.push(path)
  })
  await page.getByRole('textbox', { name: '消息' }).fill('SLOW 刷新后仍是同一轮')
  await page.getByRole('button', { name: '发送消息' }).click()
  const reply = page.getByRole('article', { name: '模型回复' })
  await expect(reply.locator('.ds-markdown')).not.toBeEmpty()
  await page.reload()
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()
  await expect(reply).toContainText('刷新后仍是同一轮。', { timeout: 10_000 })
  expect(submissions).toBe(1)
  expect(streams.length).toBeGreaterThanOrEqual(2)
  expect(new Set(streams).size).toBe(1)
})

test('stopping an in-flight reply retains it and permits manual retry', async ({ page }) => {
  await login(page)
  await page.getByRole('textbox', { name: '消息' }).fill('SLOW 保留半截回复')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.getByRole('article', { name: '模型回复' }).locator('.ds-markdown')).not.toBeEmpty()
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByText('已停止')).toBeVisible()
  await page.reload()
  await expect(page.getByText('已停止')).toBeVisible()
  await page.getByRole('button', { name: '重新生成' }).click()
  await expect(page.getByRole('article', { name: '模型回复' })).toContainText('保留半截回复。', { timeout: 10_000 })
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible()
})

test('production Content Security Policy permits local Markdown, math and diagram rendering', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 360, height: 780 })
  await login(page)
  await page.getByRole('textbox', { name: '消息' }).fill('RICH_MARKDOWN')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.locator('.ds-markdown .katex')).toBeVisible()
  await expect(page.locator('.ds-markdown .token.keyword')).toContainText('const')
  await expect(page.locator('.md-mermaid-diagram svg')).toBeVisible({ timeout: 12_000 })
  expect(errors).toEqual([])
})

test('completed HTML renders only on demand in a scriptless, offline sandbox', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 })
  await login(page)
  const requests: string[] = []
  // Chromium also reports CSP-blocked loads to page.on('request'); those never reach routing.
  await page.route('**/preview-probe/**', (route) => { requests.push(route.request().url()); return route.abort() })
  await page.getByRole('textbox', { name: '消息' }).fill('HTML_PREVIEW')
  await page.getByRole('button', { name: '发送消息' }).click()
  const codeBlock = page.locator('.md-code-block')
  const source = codeBlock.locator('pre')
  const preview = codeBlock.getByRole('button', { name: '预览', exact: true })
  const iframe = codeBlock.locator('iframe')
  await expect(source).toContainText('预览测试页面')
  await expect(preview).toHaveCount(0)
  await expect(preview).toBeVisible()
  await expect(iframe).toHaveCount(0)
  await expect(codeBlock.getByRole('button', { name: '复制' })).toBeVisible()
  await preview.click()
  await expect(preview).toHaveAttribute('aria-pressed', 'true')
  await expect(source).toHaveCount(0)
  await expect(iframe).toHaveAttribute('sandbox', '')
  await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer')
  expect(await iframe.evaluate((node: HTMLIFrameElement) => node.contentDocument)).toBeNull()

  const rendered = codeBlock.frameLocator('iframe')
  const heading = rendered.getByRole('heading', { name: '预览测试页面' })
  await expect(heading).toHaveCSS('color', 'rgb(11, 99, 66)')
  await expect(rendered.locator('#still-static')).toHaveCSS('font-weight', '700')
  await expect(rendered.locator('#still-static')).toHaveText('本地样式')
  await expect.poll(() => rendered.getByRole('img', { name: 'embedded' }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
  await expect(rendered.locator('script, iframe, [http-equiv="refresh"]')).toHaveCount(0)
  await rendered.getByText('预览链接', { exact: true }).click()
  await rendered.getByRole('button', { name: '预览表单' }).click()
  await expect(heading).toBeVisible()
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible()
  expect(requests).toEqual([])
  await page.screenshot({ path: 'test-results/wenyu-html-preview-desktop.png' })

  await page.setViewportSize({ width: 320, height: 650 })
  await expect(heading).toBeVisible()
  const frameBounds = (await iframe.boundingBox())!
  expect(frameBounds.width).toBeGreaterThan(200)
  expect(frameBounds.x + frameBounds.width).toBeLessThanOrEqual(320)
  await page.screenshot({ path: 'test-results/wenyu-html-preview-mobile.png' })
  await codeBlock.getByRole('button', { name: '源码' }).click()
  await expect(source).toContainText('<script>')
  await expect(iframe).toHaveCount(0)
  await page.reload()
  await expect(preview).toBeVisible()
  await expect(iframe).toHaveCount(0)
})

test('inline SVG graphics and CSS and SMIL animations render offline on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 })
  await login(page)
  const requests: string[] = []
  await page.route('**/preview-probe/**', (route) => { requests.push(route.request().url()); return route.abort() })
  await page.getByRole('textbox', { name: '消息' }).fill('SVG_PREVIEW')
  await page.getByRole('button', { name: '发送消息' }).click()
  const codeBlock = page.locator('.md-code-block')
  await codeBlock.getByRole('button', { name: '预览', exact: true }).click()
  const iframe = codeBlock.locator('iframe')
  const frame = codeBlock.frameLocator('iframe')
  const svg = frame.locator('#pelican-drive')
  const wheel = frame.locator('.wheel').first()
  await expect(svg).toBeVisible()
  await expect(iframe).toHaveAttribute('sandbox', '')
  await expect(frame.locator('#pelican')).toHaveCSS('fill', 'rgb(254, 250, 240)')
  expect(await wheel.evaluate((node: SVGUseElement) => node.getBBox().width)).toBeGreaterThan(30)
  await expect(svg).not.toHaveAttribute('onload')
  await expect(frame.locator('foreignObject, image, set')).toHaveCount(0)
  await expect(frame.locator('#remote-use')).not.toHaveAttribute('href')
  await expect(wheel).toHaveCSS('animation-name', 'spin')
  const firstTransform = await wheel.evaluate((node) => getComputedStyle(node).transform)
  await expect.poll(() => wheel.evaluate((node) => getComputedStyle(node).transform)).not.toBe(firstTransform)
  await expect.poll(() => svg.evaluate((node: SVGSVGElement) => node.getCurrentTime())).toBeGreaterThan(0)
  const motion = await svg.evaluate((node: SVGSVGElement) => {
    const car = node.querySelector<SVGGElement>('#car')!
    const cloud = node.querySelector<SVGGElement>('#cloud')!
    const lamp = node.querySelector<SVGCircleElement>('#lamp')!
    const sample = () => ({ car: car.getCTM()!.e, cloud: cloud.getCTM()!.e, lamp: lamp.r.animVal.value })
    node.pauseAnimations()
    node.setCurrentTime(0)
    const start = sample()
    node.setCurrentTime(1)
    const later = sample()
    node.unpauseAnimations()
    return { start, later }
  })
  expect(motion.later.car - motion.start.car).toBeGreaterThan(20)
  expect(motion.later.cloud - motion.start.cloud).toBeGreaterThan(10)
  expect(motion.later.lamp).toBeGreaterThan(motion.start.lamp)
  await page.screenshot({ path: 'test-results/wenyu-svg-preview-desktop.png' })

  await page.setViewportSize({ width: 320, height: 650 })
  await expect(svg).toBeVisible()
  const bounds = (await svg.boundingBox())!
  expect(bounds.width).toBeGreaterThan(200)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
  expect(requests).toEqual([])
  await page.screenshot({ path: 'test-results/wenyu-svg-preview-mobile.png' })
})

test('model administration, per-model depth and expandable thinking on desktop and small screens', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  const { models, defaultId } = await (await page.request.get('/api/admin/models')).json()
  await expect(page.getByRole('complementary', { name: '对话侧栏' }).getByText('Moonward', { exact: true })).toBeVisible()
  const openAdmin = async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '账号', exact: true }).click()
    await page.getByRole('button', { name: '站点管理' }).click()
  }
  try {
    await openAdmin()
    await page.getByRole('button', { name: 'API 配置', exact: true }).click()
    const baseUrl = page.getByLabel('API 基础地址')
    const key = page.getByLabel('API Key')
    await expect(baseUrl).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    await expect(key).toHaveValue('')
    await key.fill('wrong-test-key')
    const saveGateway = page.getByRole('button', { name: '验证并保存' })
    await saveGateway.click()
    await expect(page.getByText(/网关拒绝了 API Key/)).toBeVisible()
    await key.fill(mockKey)
    await saveGateway.click()
    await expect(page.getByRole('status').filter({ hasText: 'API 配置已保存' })).toBeVisible()
    await expect(key).toHaveValue('')
    await page.setViewportSize({ width: 320, height: 630 })
    const inputBox = (await baseUrl.boundingBox())!
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(320)
    await page.screenshot({ path: 'test-results/wenyu-gateway-mobile.png' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: 'test-results/wenyu-gateway-desktop.png' })
    await page.getByRole('button', { name: '模型管理' }).click()
    await page.getByRole('button', { name: '添加模型' }).click()
    const dialog = page.getByRole('dialog', { name: '添加模型' })
    await dialog.getByLabel('网关模型').selectOption('not-allowed')
    await dialog.getByLabel('模型显示名称').fill('深度推理测试模型')
    await dialog.getByRole('checkbox', { name: '中', exact: true }).check()
    await dialog.getByRole('checkbox', { name: '高', exact: true }).check()
    await dialog.getByRole('checkbox', { name: '请求公开思考摘要' }).check()
    await dialog.getByLabel('默认推理深度').selectOption('medium')
    await expect(dialog.getByLabel('上下文上限（字符）')).toHaveValue('120000')
    await expect(dialog.getByLabel('最大输出（token）')).toHaveValue('8192')
    await dialog.getByLabel('上下文上限（字符）').fill('250000')
    await dialog.getByLabel('最大输出（token）').fill('16384')
    await dialog.getByRole('button', { name: '保存模型' }).click()
    const row = page.getByRole('listitem').filter({ hasText: '深度推理测试模型' })
    await expect(row.getByText('网关可用')).toBeVisible()
    await row.getByRole('button', { name: '将 深度推理测试模型 设为默认' }).click()
    await expect(row.getByText('默认', { exact: true })).toBeVisible()
    await row.getByRole('button', { name: '编辑 深度推理测试模型' }).click()
    const editDialog = page.getByRole('dialog', { name: '编辑模型' })
    await expect(editDialog.getByLabel('模型显示名称')).toHaveValue('深度推理测试模型')
    await expect(editDialog.getByLabel('上下文上限（字符）')).toHaveValue('250000')
    await expect(editDialog.getByLabel('最大输出（token）')).toHaveValue('16384')
    await page.setViewportSize({ width: 320, height: 630 })
    const fields = editDialog.getByRole('group', { name: '长度限制' })
    await fields.scrollIntoViewIfNeeded()
    const limitsBox = (await fields.boundingBox())!
    expect(limitsBox.x + limitsBox.width).toBeLessThanOrEqual(320)
    await page.screenshot({ path: 'test-results/wenyu-model-limits-mobile.png' })
    await editDialog.getByRole('button', { name: '取消' }).click()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: 'test-results/wenyu-model-admin.png' })
    await page.getByRole('button', { name: '返回对话' }).click()

    await expect(modelButton(page)).toHaveAccessibleName('模型：深度推理测试模型')
    await modelButton(page).click()
    const slider = page.getByRole('slider', { name: '推理深度' })
    await expect(slider).toHaveAttribute('aria-valuetext', '跟随默认（中）')
    await expect(modelListButton(page)).toHaveText('跟随默认（中）')
    const range = (await slider.boundingBox())!
    await page.mouse.move(range.x + 8, range.y + range.height / 2)
    await page.mouse.down()
    await page.mouse.move(range.x + range.width - 8, range.y + range.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(slider).toHaveValue('2')
    await expect(slider).toHaveAttribute('aria-valuetext', '高')
    await slider.press('ArrowLeft')
    await expect(slider).toHaveAttribute('aria-valuetext', '中')
    await slider.press('Home')
    await expect(slider).toHaveAttribute('aria-valuetext', '跟随默认（中）')
    await slider.press('End')
    await expect(slider).toHaveAttribute('aria-valuetext', '高')
    await page.screenshot({ path: 'test-results/wenyu-depth-desktop.png' })
    await slider.press('Escape')
    await expect(slider).toHaveCount(0)
    await expect(modelButton(page)).toBeFocused()
    await modelButton(page).click()
    await modelListButton(page).click()
    await page.getByRole('button', { name: '返回推理深度' }).click()
    await expect(slider).toHaveAttribute('aria-valuetext', '高')
    await modelListButton(page).click()
    await page.getByRole('menuitemradio', { name: 'gpt-test-text', exact: true }).click()
    await modelButton(page).click()
    await expect(page.getByRole('menu', { name: '选择模型' })).toBeVisible()
    await expect(slider).toHaveCount(0)
    const renamedModel = page.getByRole('menuitemradio', { name: '深度推理测试模型', exact: true })
    await expect(renamedModel).toHaveText('深度推理测试模型')
    await renamedModel.click()
    await page.reload()
    await modelButton(page).click()
    await expect(slider).toHaveAttribute('aria-valuetext', '高')
    await slider.press('Escape')
    await page.getByRole('textbox', { name: '消息' }).fill('检查思考摘要')
    const run = page.waitForRequest((request) => request.url().endsWith('/api/runs') && request.method() === 'POST')
    await page.getByRole('button', { name: '发送消息' }).click()
    expect((await run).postDataJSON()).toMatchObject({ model: 'not-allowed', effort: 'high' })
    await expect(page.getByText('思考中', { exact: true })).toBeVisible()
    const reply = page.getByRole('article', { name: '模型回复' })
    const thinkingToggle = reply.locator('summary')
    const thinking = reply.locator('.thinking-summary')
    await thinkingToggle.click()
    await expect(thinking.getByRole('heading', { name: '思考步骤' })).toBeVisible()
    await expect(thinking.locator('strong')).toHaveText('我正筛选古诗词命名及出处。')
    await expect(thinking.locator('.ds-markdown-paragraph').first()).toHaveText('我正筛选古诗词命名及出处。我整理诗句出处候选')
    await expect(thinking.getByRole('listitem')).toHaveCount(2)
    await expect(thinkingToggle).toContainText('思考中')
    await expect(reply).toContainText('检查思考摘要。')
    await expect(thinking.locator('pre')).toContainText('<h1>仅作为源码</h1>')
    await expect(thinking.getByRole('button', { name: '预览', exact: true })).toHaveCount(0)
    await expect(thinking.locator('iframe')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/wenyu-thinking-desktop.png' })
    await page.reload()
    await expect(thinkingToggle).toContainText('已思考')
    await expect(thinking).toBeHidden()

    await page.setViewportSize({ width: 320, height: 630 })
    await thinkingToggle.click()
    await expect(thinking.locator('strong')).toHaveText('我正筛选古诗词命名及出处。')
    await expect(thinking.locator('li code')).toHaveText('输入')
    const thinkingBox = (await thinking.boundingBox())!
    expect(thinkingBox.x + thinkingBox.width).toBeLessThanOrEqual(320)
    await page.screenshot({ path: 'test-results/wenyu-thinking-mobile.png' })
    await modelButton(page).click()
    await modelListButton(page).click()
    const menu = page.getByRole('menu', { name: '选择模型' })
    const box = await menu.boundingBox()
    const trigger = await modelButton(page).boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(630 - 8)
    expect(box!.y >= trigger!.y + trigger!.height || box!.y + box!.height <= trigger!.y).toBe(true)
    await page.screenshot({ path: 'test-results/wenyu-model-mobile.png' })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    const res = await page.request.get('/api/admin/models')
    if (res.ok()) {
      const catalog = await res.json()
      await page.request.put('/api/admin/models', { data: { version: catalog.version, selection: { models, defaultId } }, headers: { Origin: new URL(page.url()).origin } })
    }
  }
})
