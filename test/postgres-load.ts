// Isolated HTTP load probe. Never use the configured production gateway or a production account.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fork, type ChildProcess } from 'node:child_process'
import { freshSchema } from '../server/postgres/schema.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import express from 'express'
import { loadConfig } from '../server/config.ts'
import { pgAccounts } from '../server/postgres/accounts.ts'
import { PgGateway } from '../server/postgres/settings.ts'
import { DEFAULT_MODEL_LIMITS } from '../shared/contract.ts'
import { readServerSentEvents } from '../src/services/api/sse.ts'
import { BrowserlessClient, listen, closeServer, password, adminEmail, mockKey } from './support.ts'

const url = new URL(process.env.MOONWARD_TEST_DATABASE_URL!),
  schema = 'load_' + randomUUID().replaceAll('-', '')
const seconds = Number(process.env.SOAK_SECONDS ?? 30)
assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 7200)
const activeTarget = Number(process.env.MOONWARD_TEST_ACTIVE ?? 100)
assert.ok(Number.isInteger(activeTarget) && activeTarget >= 1 && activeTarget <= 100)
const burstSize = activeTarget * 2
const base = new pg.Pool({ connectionString: url.href })
url.searchParams.set('options', `-c search_path=${schema}`)
const db = new pg.Pool({ connectionString: url.href }),
  mock = express()
let live = 0,
  peak = 0,
  started = 0,
  ended = 0,
  terminate = false,
  issued = 0
const streams = new Map<string, string>(),
  submit: number[] = [],
  latency: number[] = [],
  samples: number[] = [],
  arrival: number[] = []
let processingP95: number | undefined, admissionP95: number | undefined
mock.use(express.json())
mock.get('/v1/models', (_req, res) => res.json({ data: [{ id: 'test' }] }))
mock.post('/v1/responses', (req, res) => {
  if (req.body.instructions) {
    res.status(503).end()
    return
  }
  const key = req.body.input.at(-1).content[0].text
  if (streams.has(key)) {
    res.sendStatus(409)
    return
  }
  live++
  started++
  peak = Math.max(peak, live)
  streams.set(key, '')
  res.set('Content-Type', 'text/event-stream').flushHeaders()
  const emit = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  const initial = Date.now(),
    duration = 180000 + (Number(key) % 100) * 1200
  const tick = () => {
    if (terminate || Date.now() - initial > duration) {
      emit({ type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } })
      res.end()
      return
    }
    const delta = `${Date.now()}\n`
    streams.set(key, streams.get(key) + delta)
    emit({ type: 'response.output_text.delta', delta })
  }
  const timer = setInterval(tick, 250)
  res.on('close', () => {
    clearInterval(timer)
    live--
    ended++
  })
  tick()
})
const upstream = createServer(mock),
  mockUrl = await listen(upstream)
const config = loadConfig({ AUTH_SECRET: randomUUID(), USER_DAILY_LIMIT: '10000' })
const children: ChildProcess[] = []
function startChild(role: string): Promise<string> {
  const child = fork(new URL('./pg-process.ts', import.meta.url), [role], {
    env: { PATH: process.env.PATH, MOONWARD_TEST_DATABASE_URL: url.href, AUTH_SECRET: config.secret,
      MOONWARD_TEST_BACKEND_PORT: process.env.MOONWARD_TEST_BACKEND_PORT, MOONWARD_TEST_PROXY_PORT: process.env.MOONWARD_TEST_PROXY_PORT },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  children.push(child)
  child.on('message', (m) => {
    if (m && typeof m === 'object' && 'processingP95' in m && 'admissionP95' in m) {
      processingP95 = Number(m.processingP95)
      admissionP95 = Number(m.admissionP95)
    }
  })
  return new Promise((resolve, reject) => {
    child.once('message', (m) => resolve(String(m)))
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Child exited')))
  })
}
const ctrl = new AbortController(),
  jobs = new Set<Promise<void>>()
let failure: unknown
const percentile = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)]
try {
  await base.query(`CREATE SCHEMA ${schema}`)
  await db.query(await freshSchema())
  await db.query(
    `INSERT INTO site_settings(id,daily_limit) VALUES(1,10000);INSERT INTO gateway_settings VALUES(1,0,'https://example.test',NULL)`,
  )
  await db.query('UPDATE site_settings SET running_limit=$1 WHERE id=1', [activeTarget])
  await db.query('INSERT INTO model_catalog VALUES(1,0,$1)', [
    JSON.stringify({
      defaultId: 'test',
      models: [
        {
          id: 'test',
          label: 'Mock',
          enabled: true,
          web: false,
          files: false,
          vision: false,
          defaultEffort: null,
          summary: false,
          efforts: [],
          limits: DEFAULT_MODEL_LIMITS,
        },
      ],
    }),
  ])
  await new PgGateway(db, config).save({ baseUrl: mockUrl + '/v1', apiKey: mockKey, version: 0 })
  await (await pgAccounts(config, db)).createAdmin(adminEmail, 'Tester', password)
  const [origin] = await Promise.all([startChild('api'), startChild('worker'), startChild('worker')])
  const client = new BrowserlessClient(origin)
  await client.login()
  const owner = (await (await client.api('/me')).json()).id
  // Reuse a completed conversation for subsequent rounds; each run uses a unique prompt.
  const ids = Array.from({ length: burstSize }, () => randomUUID())
  await db.query("INSERT INTO chats(id,owner_id,title,updated_at) SELECT unnest($1::text[]),$2,'load',0", [ids, owner])
  async function run(chatId: string, version: number) {
    const key = String(++issued),
      start = Date.now()
    const receipt = await client.api(
      '/runs',
      'POST',
      { chatId, version, action: 'send', text: key, model: 'test' },
      ctrl.signal,
    )
    assert.equal(receipt.status, 202)
    const run = await receipt.json()
    arrival.push(Number(receipt.headers.get('X-Probe-Received')) - start)
    submit.push(Date.now() - start)
    const sse = await client.api(`/runs/${run.runId}/events`, 'GET', undefined, ctrl.signal)
    assert.equal(sse.status, 200)
    for await (const f of readServerSentEvents(sse.body!, ctrl.signal)) {
      const e = JSON.parse(f.data)
      if (e.type === 'delta') {
        for (const stamp of e.content.trim().split('\n')) latency.push(Date.now() - Number(stamp))
      }
      if (e.type === 'done') {
        const m = e.chat.messages.at(-1)
        assert.equal(m.status, 'completed', `Unexpected terminal ${m.status}: ${m.error ?? 'no code'}`)
        assert.equal(m.content, streams.get(key))
        if (!terminate) launch(chatId, e.chat.version)
        return
      }
    }
    throw new Error('Missing terminal event')
  }
  function launch(id: string, version: number) {
    const t = run(id, version)
      .catch((e) => {
        failure = e
      })
      .finally(() => jobs.delete(t))
    jobs.add(t)
  }
  for (const id of ids) launch(id, 0)
  const deadline = Date.now() + 60000
  while (live < activeTarget && !failure && Date.now() < deadline) await sleep(50)
  if (failure) throw failure
  assert.equal(live, activeTarget)
  const until = Date.now() + seconds * 1000
  while (Date.now() < until && !failure) {
    await sleep(1000)
    samples.push(live)
    if (samples.length % 60 === 0)
      console.log(JSON.stringify({ elapsed: samples.length, active: live, completed: ended }))
  }
  terminate = true
  await Promise.all([...jobs])
  if (failure) throw failure
  const p95Submit = percentile(submit, 0.95),
    p95Delivery = percentile(latency, 0.95)
  const burstP95 = percentile(submit.slice(0, burstSize), 0.95)
  console.log(
    JSON.stringify({
      seconds,
      burstSize,
      peak,
      minSample: Math.min(...samples),
      meanActive: samples.reduce((a, b) => a + b) / samples.length,
      started,
      ended,
      samples: latency.length,
      burstP95,
      arrivalP95: percentile(arrival.slice(0, burstSize), 0.95),
      processingP95,
      admissionP95,
      p95Submit,
      p95Delivery,
    }),
  )
  assert.equal(peak, activeTarget)
  assert.equal(started, issued)
  assert.equal(ended, started)
  assert.ok(latency.length >= activeTarget)
  assert.ok(burstP95 < 500 && p95Submit < 500, 'Submission p95 exceeds 500ms')
  assert.ok(p95Delivery < 250, 'Delivery p95 exceeds 250ms')
} finally {
  terminate = true
  ctrl.abort()
  await Promise.allSettled([...jobs])
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode) return resolve()
          child.once('exit', () => resolve())
          if (child.connected) child.disconnect()
        }),
    ),
  )
  await closeServer(upstream)
  await db.end()
  await base.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await base.end()
}
