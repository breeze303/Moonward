import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { DEFAULT_MODEL_LIMITS } from '../shared/contract.ts'
import type { AdminAccountsView, AdminUser, Chat, ChatEvent, GatewaySettings, Model, ModelCatalog, ModelSelection, RunReceipt, User } from '../shared/contract.ts'
import { appSchemaVersion, migrateApp, openDb } from '../server/db.ts'
import { gatewayBaseUrl, gatewayLookup } from '../server/gatewayNetwork.ts'
import { readServerSentEvents } from '../src/services/api/sse.ts'
import { ChatStore } from '../server/store.ts'
import { startWorker } from '../server/worker.ts'
import { BrowserlessClient, minimumPassword, mockKey, password, startMock, startSite } from './support.ts'

const txt = { name: 'demo.txt', mime: 'text/plain', data: Buffer.from('SAMPLE-TEXT').toString('base64') }
const png = { name: 'image.png', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==' }
const pdf = { name: 'paper.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4\n%%EOF').toString('base64') }

async function events(res: Response) {
  assert.equal(res.status, 200, await (res.ok ? Promise.resolve('') : res.text()))
  const list: ChatEvent[] = []
  for await (const item of readServerSentEvents(res.body!)) list.push(JSON.parse(item.data) as ChatEvent)
  return list
}

function result(list: ChatEvent[]) {
  const end = list.at(-1)
  assert.ok(end?.type === 'done')
  return end
}

async function started(res: Response) {
  assert.equal(res.status, 200)
  const reader = readServerSentEvents(res.body!)[Symbol.asyncIterator]()
  const event = JSON.parse((await reader.next()).value!.data) as ChatEvent
  assert.ok(event.type === 'start')
  return { chat: event.chat, reader }
}

async function error(res: Response, status: number, code: string) {
  assert.equal(res.status, status)
  assert.equal((await res.json()).code, code)
}

async function create(client: BrowserlessClient) {
  const res = await client.api('/chats', 'POST', {})
  assert.equal(res.status, 201)
  return res.json() as Promise<Chat>
}

const stream = (client: BrowserlessClient, id: string, signal?: AbortSignal) => client.api(`/runs/${id}/events`, 'GET', undefined, signal)

async function postAndSubscribe(client: BrowserlessClient, turn: object, signal?: AbortSignal) {
  const submitted = await client.api('/runs', 'POST', turn, signal)
  if (!submitted.ok) return submitted
  assert.equal(submitted.status, 202)
  const receipt = await submitted.json() as RunReceipt
  assert.equal(receipt.chat.activeRunId, receipt.runId)
  return stream(client, receipt.runId, signal)
}

function send(client: BrowserlessClient, chat: Chat, text: string, extra = {}, signal?: AbortSignal) {
  return postAndSubscribe(client, { action: 'send', chatId: chat.id, version: chat.version, model: 'gpt-6.2-sol', text, ...extra }, signal)
}

async function invitation(admin: BrowserlessClient, email: string) {
  const res = await admin.api('/admin/invitations', 'POST', { email })
  assert.equal(res.status, 201)
  return new URLSearchParams(new URL((await res.json()).url).hash.slice(1)).get('invite')!
}

async function register(admin: BrowserlessClient, email: string) {
  const token = await invitation(admin, email)
  const client = new BrowserlessClient(admin.origin)
  assert.equal((await client.api('/invite/redeem', 'POST', { token, name: email.split('@')[0], password })).status, 201)
  return client.login(email)
}

test('an empty site can initialize one administrator in the browser', async (t) => {
  const site = await startSite(null, { seed: false })
  t.after(() => site.shutdown())
  const guest = new BrowserlessClient(site.origin)
  await error(await guest.api('/me'), 401, 'setup_required')
  const body = { email: 'first@example.test', name: 'First admin', password: minimumPassword }
  await error(await guest.api('/setup', 'POST', { ...body, password: minimumPassword.slice(1) }), 400, 'invalid_input')
  const emails = [body.email, 'other@example.test']
  const results = await Promise.all(emails.map((email) => guest.api('/setup', 'POST', { ...body, email })))
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409])
  await Promise.all(results.map((result) => result.json()))
  await error(await guest.api('/me'), 401, 'unauthenticated')
  await error(await guest.api('/setup', 'POST', body), 409, 'admin_exists')
  const admin = await guest.login(emails[results.findIndex((result) => result.status === 201)], minimumPassword)
  const users = (await (await admin.api('/admin')).json() as AdminAccountsView).users
  assert.equal(users.length, 1)
  assert.equal(users[0].role, 'admin')
})

test('chat titles finish in the background and do not replace manual titles', async (t) => {
  const releaseTitle = Promise.withResolvers<string>()
  const releaseLate = Promise.withResolvers<string>()
  const mock = await startMock(0, { title: (text) => text.startsWith('TITLE-A') ? releaseTitle.promise : text.startsWith('TITLE-B') ? releaseLate.promise : null })
  const site = await startSite(mock.url)
  t.after(async () => { releaseTitle.resolve(''); releaseLate.resolve(''); await site.shutdown(); await mock.close() })
  const admin = await new BrowserlessClient(site.origin).login()
  const first = result(await events(await send(admin, await create(admin), 'TITLE-A ' + 'x'.repeat(800), { files: [txt], web: true }))).chat
  assert.equal(first.activeRunId, null)
  assert.equal(first.messages.at(-1)?.status, 'completed')
  assert.equal(first.titlePending, true)
  assert.match(first.title, /^TITLE-A/)
  releaseTitle.resolve('**旅行路线规划**\nExtra line')
  const readChat = async (id: string) => (await (await admin.api(`/chats/${id}`)).json() as Chat)
  let renamed = await readChat(first.id)
  for (let i = 0; renamed.titlePending && i < 50; i++) { await sleep(40); renamed = await readChat(first.id) }
  assert.equal(renamed.title, '旅行路线规划')
  assert.equal(renamed.version, first.version)
  assert.equal(mock.titleBodies.length, 1)
  const request = mock.titleBodies[0]
  assert.equal(request.store, false)
  assert.equal(request.tools, undefined)
  assert.equal(request.max_output_tokens, 512)
  assert.deepEqual(request.input, [{ role: 'user', content: [{ type: 'input_text', text: ('TITLE-A ' + 'x'.repeat(800)).slice(0, 512) }] }])
  await events(await send(admin, renamed, 'Follow up'))
  assert.equal(mock.titleBodies.length, 1)

  const second = result(await events(await send(admin, await create(admin), 'TITLE-B manual wins'))).chat
  assert.equal(second.titlePending, true)
  const until = site.db.prepare('SELECT title_job_until AS until FROM chats WHERE id = ?').get(second.id)!.until as number
  const response = await admin.api(`/chats/${second.id}`, 'PATCH', { title: '保留手动标题', version: second.version })
  assert.equal(response.status, 200)
  await response.json()
  new ChatStore(site.db).finishTitle({ chatId: second.id, until, text: '' }, '过期的自动标题')
  releaseLate.resolve('另一条自动标题')
  assert.equal((await readChat(second.id)).title, '保留手动标题')
})

test('admins customize the model catalog and defaults without expanding ordinary user permissions', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'wenji-catalog-'))
  const dbPath = join(folder, 'catalog.sqlite')
  const mock = await startMock(), site = await startSite(mock.url, { dbPath })
  let running = site
  t.after(async () => { await running.shutdown(); await mock.close(); rmSync(folder, { recursive: true, force: true }) })
  const guest = new BrowserlessClient(site.origin)
  await error(await guest.api('/admin/models'), 401, 'unauthenticated')
  const admin = await new BrowserlessClient(site.origin).login()
  const user = await register(admin, 'catalog@example.test')
  const seed = await (await admin.api('/admin/models')).json() as ModelCatalog
  assert.equal(seed.version, 0)
  assert.equal(seed.defaultId, 'gpt-6.2-sol')
  const ids = await (await admin.api('/admin/models/available?refresh=1')).json()
  assert.deepEqual(ids, ['gpt-6.2-sol', 'gpt-test-text', 'not-allowed'])
  await error(await user.api('/admin/models'), 403, 'forbidden')
  await error(await user.api('/admin/models/available'), 403, 'forbidden')
  await error(await user.api('/admin/models', 'PUT', { version: 0, selection: null }), 403, 'forbidden')
  const selection: ModelSelection = {
    defaultId: 'not-allowed',
    models: [
      { ...seed.models[0], enabled: false },
      seed.models[1],
      { ...seed.models[1], id: 'not-allowed', label: '自定义模型', efforts: ['max', 'none', 'high'], defaultEffort: 'high', summary: true },
      seed.models[2],
    ],
  }
  const patch = (next: unknown) => admin.api('/admin/models', 'PUT', { version: 0, selection: next })
  await error(await patch({ ...selection, defaultId: seed.models[0].id }), 400, 'invalid_input')
  await error(await patch({ ...selection, models: [...selection.models, selection.models[0]] }), 400, 'invalid_input')
  await error(await patch({ ...selection, models: [{ ...selection.models[2], defaultEffort: 'low' }] }), 400, 'invalid_input')
  await error(await patch({ ...selection, models: [{ ...selection.models[2], efforts: ['high', 'high'] }] }), 400, 'invalid_input')
  const res = await patch(selection)
  assert.equal(res.status, 200)
  assert.equal((await res.json() as ModelCatalog).version, 1)
  await error(await patch(selection), 409, 'catalog_conflict')
  const list = await (await user.api('/models')).json() as Model[]
  assert.deepEqual(list.map((model) => model.id), ['not-allowed', 'gpt-test-text'])
  assert.deepEqual(list[0].efforts, ['none', 'high', 'max'])
  assert.ok(!Object.hasOwn(list[0], 'enabled') && !Object.hasOwn(list[0], 'summary'))
  const chat = await create(user)
  await error(await send(user, chat, 'disabled model'), 400, 'model_unavailable')
  await error(await send(user, chat, 'disallowed effort', { model: 'not-allowed', effort: 'medium' }), 400, 'model_feature')
  await error(await send(user, chat, 'missing model', { model: 'unavailable-model' }), 400, 'model_unavailable')
  assert.equal(mock.bodies.length, 0)
  const stream = await events(await send(user, chat, '默认推理', { model: 'not-allowed' }))
  assert.deepEqual(mock.bodies[0].reasoning, { effort: 'high', summary: 'auto' })
  assert.ok(stream.some((event) => event.type === 'thinking' && event.thinking.active))
  assert.ok(!JSON.stringify(stream).includes('must-not-be-exposed'))
  const reply = result(stream).chat.messages.at(-1)!
  assert.equal(reply.thinking?.active, false)
  assert.equal(reply.thinking?.summary, '核对输出格式。')
  assert.ok((reply.thinking?.elapsedMs ?? 0) > 0)
  const disabled = await events(await send(user, await create(user), '显式关闭推理', { model: 'not-allowed', effort: 'none' }))
  assert.deepEqual(mock.bodies[1].reasoning, { effort: 'none' })
  assert.equal(result(disabled).chat.messages.at(-1)?.thinking, null)
  assert.equal((await admin.api('/admin/models', 'PUT', { version: 1, selection: { ...selection, defaultId: 'unavailable-model' } })).status, 200)
  assert.equal((await (await user.api('/models')).json() as Model[])[0].id, 'gpt-test-text')

  await site.shutdown()
  running = await startSite(null, { dbPath, seed: false })
  const reopened = await new BrowserlessClient(running.origin).login()
  const restored = await (await reopened.api('/admin/models')).json() as ModelCatalog
  assert.equal(restored.version, 2)
  assert.equal(restored.defaultId, 'unavailable-model')
  const reopenedUser = await new BrowserlessClient(running.origin).login('catalog@example.test')
  const history = await (await reopenedUser.api(`/chats/${chat.id}`)).json() as Chat
  assert.deepEqual(history.messages.at(-1)?.thinking, reply.thinking)
  await error(await reopened.api('/admin/models', 'PUT', { version: 2, selection: null }), 400, 'invalid_input')
  const cleared = await (await reopened.api('/admin/models', 'PUT', { version: 2, selection: { models: [], defaultId: null } })).json()
  assert.deepEqual(cleared, { version: 3, models: [], defaultId: null })
  assert.deepEqual(await (await reopenedUser.api('/models')).json(), [])
})

test('admins configure a fresh site in the browser API without environment settings and switch a live worker safely', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'wenji-gateway-'))
  const dbPath = join(folder, 'gateway.sqlite')
  const key = 'replacement-test-only-key'
  const mock = await startMock(), other = await startMock(0, { key, models: ['gpt-new-web'] })
  let site = await startSite(null, { dbPath })
  t.after(async () => { await site.shutdown(); await mock.close(); await other.close(); rmSync(folder, { recursive: true, force: true }) })
  await error(await new BrowserlessClient(site.origin).api('/admin/gateway'), 401, 'unauthenticated')
  const admin = await new BrowserlessClient(site.origin).login()
  const user = await register(admin, 'gateway@example.test')
  const path = '/admin/gateway', baseUrl = `${mock.url}/v1`, replacement = `${other.url}/v1`
  const readGateway = async (client: BrowserlessClient) => (await client.api(path)).json() as Promise<GatewaySettings>
  const update = (version: number, url: string, apiKey?: string) => admin.api(path, 'PUT', { version, baseUrl: url, apiKey })
  assert.deepEqual(await readGateway(admin), { version: 0, baseUrl: 'https://api.openai.com/v1', hasKey: false })
  assert.deepEqual(await (await user.api('/models')).json(), [])
  assert.deepEqual(await (await admin.api('/admin/models')).json(), { version: 0, models: [], defaultId: null })
  await error(await user.api(path), 403, 'forbidden')
  await error(await user.api(path, 'PUT', { version: 0, baseUrl, apiKey: mockKey }), 403, 'forbidden')
  await error(await update(0, baseUrl), 400, 'gateway_key_required')
  await error(await update(0, baseUrl, 'wrong-test-key'), 502, 'gateway_auth')
  assert.equal((await readGateway(admin)).hasKey, false)
  assert.deepEqual(await (await update(0, `${baseUrl}/`, mockKey)).json(), { version: 1, baseUrl, hasKey: true })
  assert.equal((await update(1, baseUrl)).status, 200)
  const ciphertext = site.db.prepare('SELECT encrypted_key FROM gateway_settings').get()!.encrypted_key
  assert.equal(typeof ciphertext, 'string')
  assert.ok(!(ciphertext as string).includes(mockKey))
  const firstModel = { id: 'gpt-6.2-sol', label: 'First', enabled: true, vision: false, files: false, web: false, efforts: [], defaultEffort: null, summary: false, limits: DEFAULT_MODEL_LIMITS }
  const secondModel = { ...firstModel, id: 'gpt-new-web', label: 'Second' }
  const selection = { models: [firstModel, secondModel], defaultId: firstModel.id }
  assert.equal((await admin.api('/admin/models', 'PUT', { version: 0, selection })).status, 200)
  assert.deepEqual((await (await user.api('/models')).json() as Model[]).map(({ id }) => id), [firstModel.id])
  await error(await update(2, replacement), 400, 'gateway_key_required')
  const first = await send(user, await create(user), 'SWITCH queued gateway test')
  await error(await update(2, replacement, key), 409, 'gateway_busy')
  assert.equal(result(await events(first)).chat.messages.at(-1)?.status, 'completed')
  assert.equal(mock.bodies.length, 1)
  assert.equal(other.bodies.length, 0)
  assert.deepEqual(await (await update(2, replacement, key)).json(), { version: 3, baseUrl: replacement, hasKey: true })
  await error(await update(2, baseUrl, mockKey), 409, 'gateway_conflict')
  assert.deepEqual(await (await admin.api('/admin/models/available')).json(), [secondModel.id])
  assert.deepEqual((await (await user.api('/models')).json() as Model[]).map(({ id }) => id), [secondModel.id])
  assert.equal(result(await events(await send(user, await create(user), 'new provider', { model: secondModel.id }))).chat.messages.at(-1)?.status, 'completed')
  assert.equal(other.bodies[0].model, secondModel.id)
  await site.shutdown()
  site = await startSite(mock.url, { dbPath, seed: false })
  const reopened = await new BrowserlessClient(site.origin).login()
  assert.deepEqual(await readGateway(reopened), { version: 3, baseUrl: replacement, hasKey: true })
  assert.deepEqual(await (await reopened.api('/admin/models')).json(), { ...selection, version: 1 })
  assert.deepEqual(await (await reopened.api('/admin/models/available')).json(), [secondModel.id])
})

test('gateway destinations enforce public HTTPS and the connecting socket filters local DNS results', async () => {
  for (const address of ['https://localhost/v1', 'https://127.0.0.1/v1', 'https://10.0.0.1/v1', 'https://[::1]/v1', 'https://[::ffff:127.0.0.1]/v1',
    'http://example.com/v1', 'https://test:test@example.com/v1', 'https://example.com/v1?key=value', 'https://example.com/v1#']) {
    assert.throws(() => gatewayBaseUrl(address, false), { code: 'gateway_url' })
  }
  assert.equal(gatewayBaseUrl('https://example.com/v1//', false), 'https://example.com/v1')
  assert.equal(gatewayBaseUrl('http://127.0.0.1:9000/v1', true), 'http://127.0.0.1:9000/v1')
  await new Promise<void>((resolve, reject) => gatewayLookup(false)('localhost', { all: true }, (failure) => failure ? resolve() : reject(new Error('Local DNS result accepted'))))
})

test('per-model length settings validate context and preserve the queued request budget', async (t) => {
  const mock = await startMock(), site = await startSite(mock.url, { worker: false })
  let worker: ReturnType<typeof startWorker> | undefined
  t.after(async () => { await worker?.close(); await site.shutdown(); await mock.close() })
  const admin = await new BrowserlessClient(site.origin).login()
  const catalog = await (await admin.api('/admin/models')).json() as ModelCatalog
  const modelId = catalog.models[0].id
  const { models, defaultId } = catalog
  site.db.prepare('UPDATE model_catalog SET selection = ? WHERE id = 1').run(JSON.stringify({ defaultId,
    models: models.map(({ limits: _limits, ...oldModel }) => oldModel) }))
  const legacy = await (await admin.api('/admin/models')).json() as ModelCatalog
  assert.deepEqual(legacy.models[0].limits, DEFAULT_MODEL_LIMITS)
  const save = (version: number, contextChars: number, outputTokens: number) => admin.api('/admin/models', 'PUT', {
    version, selection: { defaultId, models: models.map((model) => model.id === modelId
      ? { ...model, limits: { contextChars, outputTokens } } : model) },
  })
  await error(await save(0, 0, 8192), 400, 'invalid_input')
  await error(await save(0, 100, 4), 400, 'invalid_input')
  assert.equal((await save(0, 100, 32_768)).status, 200)
  const chat = await create(admin)
  const running = await send(admin, chat, 'context longer than five')
  assert.equal(running.status, 200)
  assert.equal((await save(1, 5, 1024)).status, 200)
  worker = startWorker(site.config, site.db)
  const completed = result(await events(running)).chat
  assert.equal(completed.messages.at(-1)?.status, 'completed')
  assert.equal(mock.bodies[0].max_output_tokens, 32_768)
  await error(await send(admin, completed, 'x'), 413, 'context_too_large')
  const historical = await (await admin.api(`/chats/${chat.id}`)).json() as Chat
  assert.deepEqual(historical.messages, completed.messages)
  const newChat = await create(admin)
  await error(await send(admin, newChat, '123456'), 413, 'context_too_large')
  await events(await send(admin, newChat, '12345'))
  assert.equal(mock.bodies[1].max_output_tokens, 1024)
  const long = 'LONG_LENGTH ' + 'x'.repeat(25_000)
  const longReply = result(await events(await send(admin, await create(admin), long, { model: 'gpt-test-text' }))).chat.messages.at(-1)!
  assert.equal(longReply.status, 'completed')
  assert.equal(longReply.content.length, 100_000)
  assert.equal(mock.bodies[2].max_output_tokens, DEFAULT_MODEL_LIMITS.outputTokens)
  assert.deepEqual(mock.bodies[2].input[0].content, [{ type: 'input_text', text: long }])
})

test('schema 4 queued jobs acquire the old length defaults', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE generation_jobs (id TEXT PRIMARY KEY) STRICT; INSERT INTO generation_jobs VALUES ('pending');
      CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT); INSERT INTO chats VALUES ('old', '已有名称'); PRAGMA user_version = 4;`)
    migrateApp(db, 10)
    const job = db.prepare('SELECT id, output_tokens AS outputTokens, context_chars AS contextChars FROM generation_jobs').get()
    assert.deepEqual({ ...job }, { id: 'pending', ...DEFAULT_MODEL_LIMITS })
    assert.deepEqual({ ...db.prepare('SELECT title, title_job_until FROM chats').get() }, { title: '已有名称', title_job_until: 0 })
  } finally { db.close() }
})

test('schema 1 upgrades without changing existing messages', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, version INTEGER);
      CREATE TABLE attempts (id TEXT PRIMARY KEY, chat_id TEXT, status TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT, status TEXT, error TEXT);
      INSERT INTO messages VALUES ('original', 'retained', 'completed', NULL); PRAGMA user_version = 1;`)
    migrateApp(db, 10)
    migrateApp(db, 99)
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, appSchemaVersion)
    assert.deepEqual({ ...db.prepare('SELECT id, content, thinking FROM messages').get() }, { id: 'original', content: 'retained', thinking: null })
    assert.equal(db.prepare('SELECT selection FROM model_catalog WHERE id = 1').get()?.selection, null)
  } finally { db.close() }
})

test('configured browser origins share accounts without accepting cross-origin writes', async (t) => {
  const mock = await startMock(), site = await startSite(mock.url, { loopbackAlias: true })
  t.after(async () => { await site.shutdown(); await mock.close() })
  const alternate = site.origin.replace('127.0.0.1', 'localhost')
  const admin = await new BrowserlessClient(alternate).login()
  const res = await admin.api('/admin/invitations', 'POST', { email: 'alias@example.test' })
  assert.equal(res.status, 201)
  const invite = new URL((await res.json()).url)
  assert.equal(invite.origin, alternate)
  const token = new URLSearchParams(invite.hash.slice(1)).get('invite')!
  const first = new BrowserlessClient(site.origin)
  assert.equal((await first.api('/invite/redeem', 'POST', { token, name: 'Alias', password })).status, 201)
  await first.login('alias@example.test')
  const chat = await create(first)
  const second = await new BrowserlessClient(alternate).login('alias@example.test')
  assert.equal((await (await second.api(`/chats/${chat.id}`)).json()).id, chat.id)
  await error(await fetch(`${site.origin}/api/chats`, {
    method: 'POST', headers: { Cookie: first.cookie, Origin: alternate, 'X-Forwarded-Host': invite.host },
  }), 403, 'invalid_origin')
  const unknownHost = await new Promise<number | undefined>((resolve, reject) => {
    request(`${site.origin}/api/chats`, { headers: { Cookie: first.cookie, Host: 'not-allowed.example' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    }).on('error', reject).end()
  })
  assert.equal(unknownHost, 403)
  assert.equal((await second.api('/auth/sign-out', 'POST')).status, 200)
  await error(await second.api('/me'), 401, 'unauthenticated')
  assert.equal((await first.api('/me')).status, 200)
})

test('invitation registration, origin enforcement and row ownership', async (t) => {
  const mock = await startMock(), site = await startSite(mock.url)
  t.after(async () => { await site.shutdown(); await mock.close() })
  const guest = new BrowserlessClient(site.origin)
  await error(await guest.api('/auth/sign-up/email', 'POST', { email: 'outside@example.test', name: 'Outside', password }), 404, 'not_found')
  await error(await guest.api('/chats'), 401, 'unauthenticated')
  await error(await fetch(`${site.origin}/api/chats`, { method: 'POST', headers: { Origin: 'https://different.example' } }), 403, 'invalid_origin')
  const admin = await new BrowserlessClient(site.origin).login()
  const auth = await guest.api('/auth/sign-in/email', 'POST', { email: 'admin@example.test', password })
  assert.deepEqual(await auth.json(), { ok: true })
  assert.ok(auth.headers.getSetCookie().some((cookie) => /;\s*httponly(?:;|$)/i.test(cookie)))
  guest.cookie = ''
  const old = await invitation(admin, 'one@example.test')
  const fresh = await invitation(admin, 'one@example.test')
  await error(await guest.api('/invite/inspect', 'POST', { token: old }), 404, 'invite_invalid')
  const expired = await invitation(admin, 'expired@example.test')
  site.db.prepare('UPDATE invitations SET expires_at = 0 WHERE email = ?').run('expired@example.test')
  await error(await guest.api('/invite/redeem', 'POST', { token: expired, name: 'Expired', password }), 404, 'invite_invalid')
  const redeem = { token: fresh, name: 'One', password: minimumPassword }
  await error(await guest.api('/invite/redeem', 'POST', { ...redeem, password: minimumPassword.slice(1) }), 400, 'invalid_input')
  const claims = await Promise.all([1, 2].map(() => guest.api('/invite/redeem', 'POST', redeem)))
  assert.deepEqual(claims.map((r) => r.status).sort(), [201, 404])
  await guest.login('one@example.test', minimumPassword)
  await error(await guest.api('/admin'), 403, 'forbidden')
  const first = await create(guest)
  const ended = result(await events(await send(guest, first, '资料', { files: [txt] })))
  const file = ended.chat.messages[0].files[0]
  assert.equal(await (await guest.api(`/files/${file.id}`)).text(), 'SAMPLE-TEXT')
  const other = await register(admin, 'two@example.test')
  assert.deepEqual(await (await other.api('/chats')).json(), [])
  await error(await other.api(`/chats/${first.id}`), 404, 'not_found')
  await error(await other.api(`/chats/${first.id}`, 'DELETE', { version: ended.chat.version }), 404, 'not_found')
  await error(await other.api(`/files/${file.id}`), 404, 'not_found')
  await error(await send(other, ended.chat, 'not my chat'), 404, 'not_found')
  assert.equal((await guest.api(`/chats/${first.id}`, 'DELETE', { version: ended.chat.version })).status, 204)
  await error(await guest.api(`/files/${file.id}`), 404, 'not_found')
  assert.equal((await (await guest.api('/me')).json() as User).usage.count, 1)
})

test('administrators can create, read, update, reset and delete user accounts', async (t) => {
  const mock = await startMock(), site = await startSite(mock.url)
  t.after(async () => { await site.shutdown(); await mock.close() })
  const guest = new BrowserlessClient(site.origin)
  const admin = await new BrowserlessClient(site.origin).login()
  const input = { email: 'managed@example.test', name: 'Managed User', password: minimumPassword, limit: 7 }
  await error(await guest.api('/admin/users', 'POST', input), 401, 'unauthenticated')
  await error(await admin.api('/admin/users', 'POST', { ...input, role: 'admin' }), 400, 'invalid_input')
  await error(await admin.api('/admin/users', 'POST', { ...input, password: minimumPassword.slice(1) }), 400, 'invalid_input')
  await error(await admin.api('/admin/users', 'POST', { ...input, password: 'x'.repeat(129) }), 400, 'invalid_input')
  const invite = await invitation(admin, input.email)
  const created = await admin.api('/admin/users', 'POST', input)
  assert.equal(created.status, 201)
  const managed = await created.json() as AdminUser
  assert.equal(managed.email, 'managed@example.test')
  assert.equal(managed.role, 'user')
  assert.equal(managed.usage.limit, 7)
  assert.equal(Object.hasOwn(managed, 'password'), false)
  const dashboard = await (await admin.api('/admin')).json() as AdminAccountsView
  assert.equal(dashboard.defaultUserLimit, site.config.userLimit)
  assert.deepEqual(dashboard.users.find((item) => item.id === managed.id), managed)
  await error(await admin.api('/admin/users', 'POST', input), 409, 'email_exists')
  await error(await guest.api('/invite/inspect', 'POST', { token: invite }), 404, 'invite_invalid')

  const user = await new BrowserlessClient(site.origin).login('managed@example.test', minimumPassword)
  assert.equal((await user.api('/me')).status, 200)
  await error(await user.api('/admin'), 403, 'forbidden')
  await error(await user.api('/admin/users', 'POST', input), 403, 'forbidden')
  await error(await user.api(`/admin/users/${managed.id}`, 'PATCH', { limit: 100 }), 403, 'forbidden')
  await error(await user.api(`/admin/users/${managed.id}`, 'DELETE'), 403, 'forbidden')
  const userPath = `/admin/users/${managed.id}`
  const resetPassword = 'Reset-123!'
  await error(await admin.api(userPath, 'PATCH', { password: resetPassword.slice(1) }), 400, 'invalid_input')
  const updated = await admin.api(userPath, 'PATCH', { email: 'renamed@example.test', name: 'Renamed User', password: resetPassword, limit: 11 })
  assert.equal(updated.status, 200)
  await error(await user.api('/me'), 401, 'unauthenticated')
  await error(await guest.api('/auth/sign-in/email', 'POST', { email: 'renamed@example.test', password: minimumPassword }), 401, 'invalid_credentials')
  const renamed = await new BrowserlessClient(site.origin).login('renamed@example.test', resetPassword)
  const me = await (await renamed.api('/me')).json() as User
  assert.equal(me.name, 'Renamed User')
  assert.equal(me.usage.limit, 11)

  await error(await admin.api(`/admin/users/${managed.id}`, 'PATCH', { email: 'admin@example.test' }), 409, 'email_exists')
  const adminMe = await (await admin.api('/me')).json() as User
  const adminRun = await started(await send(admin, await create(admin), 'SLOW keep administrator running'))
  const userRun = await started(await send(renamed, await create(renamed), 'SLOW delete this user', { files: [txt] }))
  const fileId = userRun.chat.messages[0].files[0].id
  if (!userRun.chat.messages.at(-1)?.content) assert.equal(JSON.parse((await userRun.reader.next()).value!.data).type, 'delta')

  await error(await admin.api(`/admin/users/${adminMe.id}`, 'DELETE'), 400, 'cannot_delete_admin')
  assert.equal((await admin.api(`/admin/users/${managed.id}`, 'DELETE')).status, 204)
  await error(await renamed.api('/me'), 401, 'unauthenticated')
  await error(await admin.api(`/admin/users/${managed.id}`, 'DELETE'), 404, 'not_found')
  assert.equal((await userRun.reader.next()).done, true)
  assert.equal(site.db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(fileId), undefined)
  assert.equal(site.db.prepare('SELECT 1 FROM generation_jobs WHERE id = ?').get(userRun.chat.activeRunId), undefined)
  assert.equal(site.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(userRun.chat.id), undefined)
  const remaining = await (await admin.api(`/chats/${adminRun.chat.id}`)).json() as Chat
  assert.equal(remaining.activeRunId, adminRun.chat.activeRunId)
  assert.equal(remaining.messages.at(-1)?.status, 'streaming')
  for (let i = 0; i < 40 && mock.aborted() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(mock.aborted(), 1)
  assert.equal((await admin.api(`/chats/${adminRun.chat.id}/stop`, 'POST', {})).status, 200)
  await adminRun.reader.return?.(undefined)
})

test('Responses wire format, citations, branch replay and optimistic conflicts', async (t) => {
  const mock = await startMock(), site = await startSite(mock.url)
  t.after(async () => { await site.shutdown(); await mock.close() })
  const client = await new BrowserlessClient(site.origin).login()
  const models = await (await client.api('/models')).json()
  assert.deepEqual(models.map((m: { id: string }) => m.id), ['gpt-6.2-sol', 'gpt-test-text'])
  const chat = await create(client)
  const data = await events(await send(client, chat, '记住 MAPLE-9781', { files: [png, pdf, txt], web: true, effort: 'low' }))
  const sent = mock.bodies[0]
  assert.deepEqual(sent.tools, [{ type: 'web_search' }])
  assert.equal(Object.hasOwn(sent, 'max_tool_calls'), false)
  assert.equal(data[0].type, 'start')
  assert.ok(data.some((e) => e.type === 'delta'))
  assert.ok(!JSON.stringify(data).includes(mockKey))
  const one = result(data)
  assert.deepEqual((sent.input[0].content as { type: string }[]).map((part) => part.type), ['input_text', 'input_image', 'input_file', 'input_file'])
  assert.equal(sent.store, false)
  assert.equal(one.chat.messages[1].status, 'completed')
  assert.equal(one.chat.messages[1].citations.length, 1)
  assert.equal(one.usage.inputTokens, 17)
  await error(await send(client, chat, 'stale'), 409, 'conflict')
  await error(await send(client, one.chat, 'unsupported', { model: 'gpt-test-text' }), 400, 'model_attachment')
  const recalled = result(await events(await send(client, one.chat, '回忆编号')))
  assert.equal(recalled.chat.messages.at(-1)?.content, 'MAPLE-9781')
  const post = (base: Chat, data: object) => postAndSubscribe(client, { chatId: base.id, version: base.version, model: 'gpt-6.2-sol', ...data })
  const edited = result(await events(await post(recalled.chat, { action: 'edit', target: one.chat.messages[0].id, text: '备选分支' })))
  assert.equal(edited.chat.messages.length, 2)
  assert.equal(edited.chat.messages[0].siblings.length, 2)
  assert.equal(edited.chat.messages[0].files.length, 3)
  const retried = result(await events(await post(edited.chat, { action: 'retry', target: edited.chat.messages[1].id })))
  assert.equal(retried.chat.messages[1].siblings.length, 2)
  const otherDevice = await new BrowserlessClient(site.origin).login()
  const switched = await otherDevice.api(`/chats/${chat.id}`, 'PATCH', { version: retried.chat.version, selected: one.chat.messages[0].id })
  assert.equal((await switched.json() as Chat).messages.at(-1)?.content, 'MAPLE-9781')
})

test('stop, browser disconnect, upstream failures and quotas preserve the correct result', async (t) => {
  const mock = await startMock(), site = await startSite(mock.url, { siteLimit: 5 })
  t.after(async () => { await site.shutdown(); await mock.close() })
  const admin = await new BrowserlessClient(site.origin).login()
  const user = await register(admin, 'slow@example.test')
  const chat = await create(user), extra = await create(user)
  const { chat: running, reader: iterator } = await started(await send(user, chat, 'SLOW 我们应当保留开头'))
  assert.equal(JSON.parse((await iterator.next()).value!.data).type, 'delta')
  await error(await send(user, running, 'parallel in the same chat'), 409, 'chat_busy')
  const stopped = await (await user.api(`/chats/${chat.id}/stop`, 'POST', {})).json()
  assert.equal(stopped.chat.messages.at(-1).status, 'stopped')
  assert.ok(stopped.chat.messages.at(-1).content)
  assert.equal(stopped.usage.count, 1)
  await iterator.return?.(undefined)
  for (const [prompt, status] of [['DROP 断开', 'interrupted'], ['INCOMPLETE 测试', 'incomplete'], ['FAIL 测试', 'failed']]) {
    const ended = result(await events(await send(user, await create(user), prompt)))
    assert.equal(ended.chat.messages.at(-1)?.status, status)
    assert.ok(ended.chat.messages.at(-1)?.content)
    if (prompt.startsWith('DROP')) assert.equal(ended.chat.messages.at(-1)?.error, 'upstream_interrupted')
    assert.ok(!JSON.stringify(ended).includes('credential-bearing'))
  }
  const lost = new AbortController()
  const disconnected = await send(user, extra, 'RECONNECT 客户连接断开', {}, lost.signal)
  const reader = readServerSentEvents(disconnected.body!)[Symbol.asyncIterator]()
  await reader.next(); await reader.next()
  const before = mock.aborted()
  lost.abort()
  await reader.return?.(undefined).catch(() => {})
  const stillRunning = await (await user.api(`/chats/${extra.id}`)).json() as Chat
  assert.equal(stillRunning.messages.at(-1)?.status, 'streaming')
  for (let i = 0; i < 50; i++) {
    const state = await (await user.api(`/chats/${extra.id}`)).json() as Chat
    const reply = state.messages.at(-1)
    if (reply?.status === 'completed') { assert.equal(reply.content, '**资料摘要**：客户连接断开。'); break }
    assert.equal(reply?.status, 'streaming')
    if (i === 49) assert.fail('Generation did not finish after the client disconnected')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const last = await create(user)
  await error(await send(user, last, 'site capped'), 429, 'site_limit')
  const me = await (await user.api('/me')).json() as User
  await admin.api('/admin/site', 'PATCH', { limit: 7 })
  await admin.api(`/admin/users/${me.id}`, 'PATCH', { limit: 5 })
  await error(await send(user, last, 'individual cap'), 429, 'user_limit')
  assert.ok(before >= 1)
  assert.equal(mock.aborted(), before)
})

test('different chats generate concurrently and stopping one frees only its slot', async (t) => {
  const mock = await startMock(), site = await startSite(mock.url, { siteLimit: 12 })
  t.after(async () => { await site.shutdown(); await mock.close() })
  const admin = await new BrowserlessClient(site.origin).login()
  const user = await register(admin, 'parallel@example.test')
  const outsider = await register(admin, 'waiting@example.test')
  const first = await create(user), second = await create(user), third = await create(user)
  const slots: [BrowserlessClient, Chat][] = [
    [user, first], [user, second], [admin, await create(admin)], [admin, await create(admin)],
  ]
  const jobs = await Promise.all(slots.map(async ([client, chat]) => started(await send(client, chat, 'SLOW parallel request'))))
  await error(await send(user, third, 'account cap'), 409, 'user_busy')
  await error(await send(outsider, await create(outsider), 'site cap'), 429, 'site_busy')

  const stopped = await (await user.api(`/chats/${first.id}/stop`, 'POST', {})).json()
  assert.equal(stopped.chat.messages.at(-1).status, 'stopped')
  const continuing = await (await user.api(`/chats/${second.id}`)).json() as Chat
  assert.equal(continuing.messages.at(-1)?.status, 'streaming')
  const replacement = result(await events(await send(user, third, 'newly available slot')))
  assert.equal(replacement.chat.messages.at(-1)?.status, 'completed')

  await Promise.all(jobs.map(async ({ chat, reader }, i) => {
    if (i > 0) assert.equal((await slots[i][0].api(`/chats/${chat.id}/stop`, 'POST', {})).status, 200)
    await reader.return?.(undefined)
  }))
})

test('the ten-minute generation deadline saves streamed text as an upstream timeout', { timeout: 5_000 }, async (t) => {
  const mock = await startMock(), site = await startSite(mock.url)
  t.after(async () => { await site.shutdown(); await mock.close() })
  const client = await new BrowserlessClient(site.origin).login()
  const chat = await create(client)
  const timeout = AbortSignal.timeout
  t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 600_000 ? 1_600 : ms))

  const stream = await events(await send(client, chat, 'SLOW keep the first chunk'))
  const partial = stream.flatMap((event) => event.type === 'delta' ? [event.content] : []).join('')
  assert.ok(partial)
  const reply = result(stream).chat.messages.at(-1)
  assert.equal(reply?.status, 'interrupted')
  assert.equal(reply?.error, 'upstream_timeout')
  assert.equal(reply?.content, partial)
  const saved = await (await client.api(`/chats/${chat.id}`)).json() as Chat
  assert.deepEqual(saved.messages.at(-1), reply)
})

test('disabling an account revokes browser sessions and stops its in-flight generation', async (t) => {
  const mock = await startMock(), site = await startSite(mock.url)
  t.after(async () => { await site.shutdown(); await mock.close() })
  const admin = await new BrowserlessClient(site.origin).login()
  const user = await register(admin, 'disabled@example.test')
  const me = await (await user.api('/me')).json() as User
  const chats = await Promise.all([create(user), create(user)])
  const running = await Promise.all(chats.map(async (chat) => started(await send(user, chat, 'SLOW 已停用'))))
  await Promise.all(running.map(({ reader }) => reader.next()))
  assert.equal((await admin.api(`/admin/users/${me.id}`, 'PATCH', { disabled: true })).status, 200)
  await Promise.all(running.map(async ({ reader }) => {
    assert.deepEqual(JSON.parse((await reader.next()).value!.data), { type: 'error', code: 'disabled' })
    await reader.return?.(undefined)
  }))
  await error(await user.api('/chats'), 401, 'unauthenticated')
  const signin = new BrowserlessClient(site.origin)
  await error(await signin.api('/auth/sign-in/email', 'POST', { email: me.email, password }), 403, 'disabled')
  assert.equal(signin.cookie, '')
})

test('SQLite backup can be reopened and recovers an interrupted reservation', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'wenji-backup-'))
  const mock = await startMock(), site = await startSite(mock.url, { dbPath: join(folder, 'source.sqlite'), worker: false })
  t.after(async () => { await site.shutdown(); await mock.close(); rmSync(folder, { recursive: true, force: true }) })
  const client = await new BrowserlessClient(site.origin).login()
  const user = await (await client.api('/me')).json() as User
  const chat = await create(client)
  const store = new ChatStore(site.db)
  const { models: [model] } = await (await client.api('/admin/models')).json() as ModelCatalog
  const run = store.reserve(user.id, { action: 'send', chatId: chat.id, version: chat.version, model: model.id, text: '备份探针' }, model, [], 0)
  const now = Date.now()
  const job = store.claim('original-worker', now, 10_000)!
  assert.equal(job.id, run.runId)
  store.checkpoint(job, 'original-worker', now, { text: '已保存的部分', citations: [], thinking: { active: true, elapsedMs: null, summary: '已收到的摘要' } })
  const destination = join(folder, 'copy.sqlite')
  await backup(site.db, destination)
  const copied = new DatabaseSync(destination)
  try {
    assert.equal(copied.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
    const recovered = new ChatStore(copied)
    recovered.recoverExpired(now + 10_001)
    assert.equal(recovered.claim('another-worker', now + 10_001, 10_000), undefined)
    const reply = recovered.read(user.id, chat.id).messages.at(-1)
    assert.equal(reply?.status, 'interrupted')
    assert.equal(reply?.content, '已保存的部分')
    assert.equal(reply?.thinking?.summary, '已收到的摘要')
    assert.equal(reply?.thinking?.active, false)
  } finally { copied.close() }
})

test('a durable job survives API restart and a new subscriber gets its original output', { timeout: 15_000 }, async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'wenji-worker-'))
  const dbPath = join(folder, 'shared.sqlite')
  const mock = await startMock()
  let site = await startSite(mock.url, { dbPath, worker: false })
  const port = Number(new URL(site.origin).port)
  let worker: ReturnType<typeof startWorker> | undefined, workerDb: DatabaseSync | undefined
  let serving = true
  t.after(async () => {
    if (serving) await site.shutdown()
    await worker?.close(); workerDb?.close(); await mock.close(); rmSync(folder, { recursive: true, force: true })
  })
  const client = await new BrowserlessClient(site.origin).login()
  const chat = await create(client)
  const turn = { action: 'send', chatId: chat.id, version: chat.version, model: 'gpt-6.2-sol', text: 'RECONNECT durable run' }
  const submitted = await client.api('/runs', 'POST', turn)
  assert.equal(submitted.status, 202)
  const { runId } = await submitted.json() as RunReceipt
  assert.equal(mock.bodies.length, 0)
  await error(await client.api('/runs', 'POST', turn), 409, 'conflict')
  await site.shutdown(); serving = false
  site = await startSite(mock.url, { dbPath, worker: false, seed: false, port }); serving = true
  const outsider = await register(client, 'no-access@example.test')
  await error(await stream(outsider, runId), 404, 'not_found')
  workerDb = openDb(dbPath)
  worker = startWorker(site.config, workerDb)
  const subscription = await started(await stream(client, runId))
  const partial = JSON.parse((await subscription.reader.next()).value!.data) as ChatEvent
  assert.equal(partial.type, 'delta')
  await site.shutdown(); serving = false
  assert.equal((await subscription.reader.next()).done, true)
  site = await startSite(mock.url, { dbPath, worker: false, seed: false, port }); serving = true
  const saved = await (await client.api(`/chats/${chat.id}`)).json() as Chat
  assert.equal(saved.activeRunId, runId)
  const replay = await events(await stream(client, runId))
  assert.ok(replay[0].type === 'start' && replay[0].chat.messages.at(-1)?.content)
  const done = result(replay)
  assert.equal(done.chat.messages.at(-1)?.content, '**资料摘要**：durable run。')
  assert.equal(done.chat.activeRunId, null)
  assert.equal(mock.bodies.length, 1)
  assert.equal(mock.aborted(), 0)
})
