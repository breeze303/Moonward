import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { PgChats } from '../server/postgres/chat.ts'
import { append, cancel, claim, finish, recover, replay } from '../server/postgres/queue.ts'
import { DEFAULT_MODEL_LIMITS } from '../shared/contract.ts'
import { createServer } from 'node:http'
import { setTimeout as wait } from 'node:timers/promises'
import { loadConfig } from '../server/config.ts'
import { createPgApplication } from '../server/app.ts'
import { pgWorker } from '../server/postgres/worker.ts'
import { PgGateway } from '../server/postgres/settings.ts'
import { claimTitle, finishTitle } from '../server/postgres/titles.ts'
import { BrowserlessClient, listen, closeServer, password, adminEmail, mockKey, startMock } from './support.ts'
import { readServerSentEvents } from '../src/services/api/sse.ts'

test(
  'PostgreSQL: concurrent admission, fair dispatch, replay, cancellation and lease fencing',
  { skip: !process.env.MOONWARD_TEST_DATABASE_URL },
  async () => {
    const schema = 'test_' + randomUUID().replaceAll('-', '')
    const base = new pg.Pool({ connectionString: process.env.MOONWARD_TEST_DATABASE_URL })
    const db = new pg.Pool({
      connectionString: process.env.MOONWARD_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    })
    try {
      await base.query(`CREATE SCHEMA ${schema}`)
      await db.query(await readFile(new URL('../server/postgres/schema.sql', import.meta.url), 'utf8'))
      await db.query(`INSERT INTO site_settings(id,daily_limit) VALUES(1,1000); INSERT INTO gateway_settings VALUES(1,0,'https://example.test',NULL);
      INSERT INTO "user"(id,name,email) VALUES('a','A','a@test'),('b','B','b@test'); INSERT INTO profiles(id,role,daily_limit) VALUES('a','user',1000),('b','user',1000)`)
      const store = new PgChats(db)
      const model = {
        id: 'mock',
        label: 'Mock',
        enabled: true,
        web: false,
        vision: false,
        files: false,
        efforts: [],
        defaultEffort: null,
        summary: false,
        limits: DEFAULT_MODEL_LIMITS,
      }
      const submit = async (owner: string) => {
        const chat = await store.create(owner)
        return store.reserve(
          owner,
          { chatId: chat.id, version: 0, action: 'send', model: 'mock', text: 'test' },
          model,
          [],
          0,
        )
      }
      await Promise.all(Array.from({ length: 200 }, () => submit('a')))
      const claimed = (await Promise.all(Array.from({ length: 120 }, (_, i) => claim(db, `worker${i % 2}`)))).filter(
        (x) => x !== null,
      )
      assert.equal(claimed.length, 100)
      assert.equal(new Set(claimed.map((x) => x.id)).size, 100)
      const run = await submit('b')
      const first = claimed[0]
      const worker = (await db.query('SELECT worker_id FROM generation_jobs WHERE id=$1', [first.id])).rows[0].worker_id
      assert.ok(await append(db, first.id, worker, 1, 'part1', null))
      assert.equal(await append(db, first.id, worker, 1, 'duplicate', null), false)
      assert.ok(await append(db, first.id, worker, 2, 'part2', null))
      assert.deepEqual(
        (await replay(db, 'a', first.id, 1)).chunks.map((x: { delta: string }) => x.delta),
        ['part2'],
      )
      await assert.rejects(replay(db, 'b', first.id, 0), { code: 'not_found' })
      await db.query("UPDATE generation_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [first.id])
      assert.equal(await recover(db), 1)
      assert.equal((await replay(db, 'a', first.id, 0)).final_content, 'part1part2')
      assert.equal(await append(db, first.id, worker, 3, 'stale', null), false)
      assert.equal((await claim(db, 'worker3'))?.id, run.runId)
      const queued = await submit('b')
      await cancel(db, 'b', queued.runId, 'stopped')
      assert.equal((await replay(db, 'b', queued.runId, 0)).status, 'stopped')
      assert.ok(
        await finish(db, run.runId, 'worker3', {
          status: 'completed',
          error: null,
          content: 'done',
          thinking: null,
          citations: [],
          inputTokens: 1,
          outputTokens: 1,
        }),
      )
      await db.query('UPDATE site_settings SET running_limit=1,waiting_limit=0')
      await assert.rejects(submit('b'), { code: 'queue_full' })
      assert.equal(await claimTitle(db), undefined, 'ordinary waiting jobs take priority over titles')
      for (const { id, owner_id } of (
        await db.query(`SELECT id,owner_id FROM attempts WHERE status IN ('streaming','queued')`)
      ).rows)
        await cancel(db, owner_id, id, 'stopped')
      await db.query("UPDATE generation_jobs SET lease_until=now()-interval '1 second' WHERE worker_id IS NOT NULL")
      await recover(db)
      const ticket = await claimTitle(db)
      assert.ok(ticket)
      assert.equal(ticket.chat, run.chat.id)
      const current = await store.read('b', run.chat.id)
      await store.rename('b', run.chat.id, current.version, 'Manual')
      await assert.rejects(submit('b'), { code: 'queue_full' }, 'renaming must not release a billable title slot')
      await finishTitle(db, ticket, 'Stale title')
      assert.equal((await store.read('b', run.chat.id)).title, 'Manual')
      assert.ok(await submit('b'))
      await db.query('UPDATE site_settings SET running_limit=100,waiting_limit=200')
      const [left, right, limited] = await Promise.all([store.create('a'), store.create('a'), store.create('b')])
      await db.query("UPDATE profiles SET daily_limit=0 WHERE id='b'")
      const send = (owner: string, chatId: string) =>
        store.reserve(owner, { chatId, version: 0, action: 'send', model: 'mock', text: 'batch' }, model, [], 0)
      const results = await Promise.allSettled([
        send('a', left.id),
        send('a', left.id),
        send('a', limited.id),
        send('b', limited.id),
        send('a', right.id),
      ])
      assert.deepEqual(
        results.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason.code)),
        ['ok', 'conflict', 'not_found', 'user_limit', 'ok'],
      )
      assert.deepEqual((await store.read('b', limited.id)).messages, [])
    } finally {
      await db.end()
      await base.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await base.end()
    }
  },
)

test(
  'PostgreSQL authenticated HTTP: queue, stop, reconnect and stream to completion',
  { skip: !process.env.MOONWARD_TEST_DATABASE_URL, timeout: 30000 },
  async () => {
    const schema = 'test_' + randomUUID().replaceAll('-', ''),
      url = new URL(process.env.MOONWARD_TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    const base = new pg.Pool({ connectionString: process.env.MOONWARD_TEST_DATABASE_URL }),
      db = new pg.Pool({ connectionString: url.href })
    const mock = await startMock(),
      server = createServer(),
      origin = await listen(server)
    const config = loadConfig({ AUTH_SECRET: randomUUID(), APP_ORIGIN: origin, USER_DAILY_LIMIT: '1000' })
    let application: Awaited<ReturnType<typeof createPgApplication>> | undefined,
      worker: ReturnType<typeof pgWorker> | undefined
    try {
      await base.query(`CREATE SCHEMA ${schema}`)
      await db.query(await readFile(new URL('../server/postgres/schema.sql', import.meta.url), 'utf8'))
      await db.query(
        `INSERT INTO site_settings(id,daily_limit,running_limit) VALUES(1,1000,1);INSERT INTO gateway_settings VALUES(1,0,'https://example.test',NULL)`,
      )
      const models = config.legacyModels()
      models.push({
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
      })
      await db.query('INSERT INTO model_catalog VALUES(1,1,$1)', [
        JSON.stringify({ models, defaultId: 'gpt-test-text' }),
      ])
      await new PgGateway(db, config).save({ baseUrl: mock.url + '/v1', apiKey: mockKey, version: 0 })
      application = await createPgApplication(config, url.href)
      server.on('request', application.app)
      const client = new BrowserlessClient(origin)
      async function api(path: string, method = 'GET', body?: unknown) {
        const r = await client.api(path, method, body)
        assert.ok(r.ok, `${path}: ${r.status} ${r.ok ? '' : await r.text()}`)
        return r.json()
      }
      await api('/setup', 'POST', { name: 'Admin', email: adminEmail, password })
      await client.login()
      assert.equal((await api('/admin')).capacity.running, 1)
      const submit = async (text: string) => {
        const c = await api('/chats', 'POST')
        return api('/runs', 'POST', { chatId: c.id, version: 0, action: 'send', text, model: 'gpt-test-text' })
      }
      const slow = await submit('SLOW postgres'),
        queued = await submit('cancelled')
      await api('/admin/capacity', 'PATCH', { waiting: 1 })
      const extra = await api('/chats', 'POST'),
        rejected = await client.api('/runs', 'POST', {
          chatId: extra.id,
          version: 0,
          action: 'send',
          text: 'full',
          model: 'gpt-test-text',
        })
      assert.equal(rejected.status, 429)
      assert.equal(rejected.headers.get('Retry-After'), '5')
      assert.equal((await rejected.json()).code, 'queue_full')
      assert.deepEqual((await api(`/chats/${extra.id}`)).messages, [])
      assert.equal(queued.chat.messages.at(-1).status, 'queued')
      assert.equal((await api(`/chats/${queued.chat.id}/stop`, 'POST')).chat.messages.at(-1).status, 'stopped')
      worker = pgWorker(db, config)
      const ctrl = new AbortController(),
        first = await client.api(`/runs/${slow.runId}/events`, 'GET', undefined, ctrl.signal)
      for await (const frame of readServerSentEvents(first.body!, ctrl.signal)) {
        const e = JSON.parse(frame.data)
        if (e.type === 'delta' || (e.type === 'start' && e.chat.messages.at(-1).content)) {
          ctrl.abort()
          break
        }
      }
      const next = await client.api(`/runs/${slow.runId}/events`)
      let done = false
      for await (const frame of readServerSentEvents(next.body!)) {
        const e = JSON.parse(frame.data)
        if (e.type === 'done') {
          assert.match(e.chat.messages.at(-1).content, /postgres/)
          done = true
        }
      }
      assert.ok(done)
      assert.equal(mock.bodies.length, 1)
      await wait(50)
    } finally {
      await application?.drain()
      await worker?.close()
      await closeServer(server)
      await application?.close()
      await mock.close()
      await db.end()
      await base.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await base.end()
    }
  },
)
