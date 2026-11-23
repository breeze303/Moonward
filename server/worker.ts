import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { loadConfig } from './config.ts'
import type { Config } from './config.ts'
import { appSchemaVersion, openDb } from './db.ts'
import { HttpError } from './errors.ts'
import { GatewayStore } from './gateway.ts'
import type { Destination } from './gateway.ts'
import { CatalogStore } from './models.ts'
import { ChatStore, maxActiveSite } from './store.ts'
import type { GenerationJob, RunInput, TitleJob } from './store.ts'
import { chatTitleInstructions, createUpstream, ResponseAccumulator } from './upstream.ts'
import type { ReplyStatus } from '../shared/contract.ts'

const generationTimeoutMs = 600_000
const leaseMs = 10_000

export function startWorker(config: Config, db: DatabaseSync, onTick?: () => void) {
  const store = new ChatStore(db)
  const gateway = new GatewayStore(db, config)
  const catalog = new CatalogStore(db)
  const upstream = createUpstream(() => gateway.connection(), config.allowLoopbackGateway)
  const worker = randomUUID()
  type Active = { job: GenerationJob; abort: AbortController; state: ResponseAccumulator; dirty: boolean; done: Promise<void> }
  const active = new Map<string, Active>()
  const titleJobs = new Set<Promise<void>>()
  const shutdownTitles = new AbortController()

  async function nameChat(titleJob: TitleJob, job: GenerationJob, destination: Destination) {
    let title: string | null = null
    try {
      if (!titleJob.text || shutdownTitles.signal.aborted || titleJobs.size >= maxActiveSite || gateway.connection().version !== destination.version) return
      const effort = catalog.read().models.find(({ id }) => id === job.model)?.efforts.find((value) => value === 'none' || value === 'minimal' || value === 'low')
      const outputTokens = Math.min(job.outputTokens, 512)
      const state = new ResponseAccumulator(outputTokens)
      const signal = AbortSignal.any([shutdownTitles.signal, AbortSignal.timeout(Math.max(1, titleJob.until - Date.now()))])
      const input: RunInput = [{ role: 'user', content: [{ type: 'input_text', text: titleJob.text }] }]
      for await (const event of upstream.stream(input, {
        model: job.model, effort, outputTokens, instructions: chatTitleInstructions,
      }, false, signal, destination)) {
        state.accept(event)
        if (state.terminal) break
      }
      if (state.terminal !== 'completed' || signal.aborted) return
      const line = state.snapshot().text.trim().split(/\r?\n/u, 1)[0].replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ')
        .replace(/^[\s#>*"'`]+|[\s*"'`]+$/gu, '')
      title = Array.from(line).slice(0, 45).join('').trim() || null
    } catch { /* Keep the provisional title if the gateway cannot name this chat. */ }
    finally { store.finishTitle(titleJob, title) }
  }

  async function run(job: GenerationJob, entry: Active) {
    const { abort, state } = entry
    const startedAt = Date.now()
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(generationTimeoutMs)])
    let status: Exclude<ReplyStatus, 'streaming'> = 'interrupted'
    let error: string | null = 'upstream_interrupted'
    let destination: Destination | undefined
    try {
      destination = gateway.connection()
      const input = store.input(job)
      for await (const event of upstream.stream(input, { model: job.model, effort: job.effort ?? undefined, web: !!job.web, outputTokens: job.outputTokens }, !!job.summary, signal, destination)) {
        if (signal.aborted) break
        const thinking = state.thinking
        const delta = state.accept(event)
        if (delta || thinking !== state.thinking) entry.dirty = true
        if (state.terminal) break
      }
      if (state.terminal) { status = state.terminal; error = state.error }
    } catch (failure) {
      if (!signal.aborted) {
        error = failure instanceof HttpError ? failure.code : 'upstream_failed'
        status = error === 'upstream_interrupted' ? 'interrupted' : 'failed'
      }
    } finally {
      if (signal.aborted && !state.terminal) {
        status = abort.signal.reason === 'stopped' ? 'stopped' : 'interrupted'
        error = status === 'stopped' ? null : abort.signal.reason === 'disabled' ? 'disabled'
          : abort.signal.aborted ? 'interrupted' : 'upstream_timeout'
      }
      state.finishThinking()
      const snapshot = state.snapshot()
      const settled = store.finish(job, worker, Date.now(), { ...snapshot, status, error, inputTokens: state.inputTokens, outputTokens: state.outputTokens })
      if (settled && error) {
        console.info('[responses] finished', { run: job.id, model: job.model, status, error, elapsedMs: Date.now() - startedAt, chars: snapshot.text.length })
      }
      if (settled?.title && destination) {
        const task = nameChat(settled.title, job, destination).catch(() => console.error('[worker] could not save chat title', { chat: job.chatId }))
          .finally(() => titleJobs.delete(task))
        titleJobs.add(task)
      }
    }
  }

  const tick = () => {
    try {
      const now = Date.now()
      store.recoverExpired(now)
      for (const [id, entry] of active) {
        const lease = store.lease(id, worker, now, leaseMs)
        if (!lease || lease.stop_reason) entry.abort.abort(lease?.stop_reason ?? 'lease_lost')
        else if (entry.dirty) {
          store.checkpoint(entry.job, worker, now, entry.state.snapshot())
          entry.dirty = false
        }
      }
      while (active.size < maxActiveSite) {
        const job = store.claim(worker, Date.now(), leaseMs)
        if (!job) break
        const lease = store.lease(job.id, worker, Date.now(), leaseMs)
        if (!lease) continue
        const abort = new AbortController()
        if (lease.stop_reason) abort.abort(lease.stop_reason)
        const entry: Active = { job, abort, state: new ResponseAccumulator(job.outputTokens), dirty: false, done: Promise.resolve() }
        active.set(job.id, entry)
        entry.done = run(job, entry).catch(() => console.error('[worker] could not save generation', { run: job.id }))
          .finally(() => { active.delete(job.id) })
      }
      onTick?.()
    } catch { console.error('[worker] queue poll failed') }
  }
  const timer = setInterval(tick, 60)
  tick()
  return { async close() {
    clearInterval(timer)
    shutdownTitles.abort()
    const pending = [...active.values()]
    for (const entry of pending) entry.abort.abort('shutdown')
    await Promise.all(pending.map(({ done }) => done))
    await Promise.all(titleJobs)
    await upstream.close()
  } }
}

if (import.meta.main) {
  process.umask(0o077)
  const config = loadConfig()
  if (config.dbPath === ':memory:') throw new Error('The generation worker requires a shared database file')
  const db = openDb(config.dbPath)
  if (db.prepare('PRAGMA user_version').get()?.user_version !== appSchemaVersion) {
    db.close()
    throw new Error('Start the API to migrate the database before starting the worker')
  }
  let heartbeat = 0
  const worker = startWorker(config, db, () => {
    if (Date.now() - heartbeat >= 1_000) {
      writeFileSync('/tmp/wenji-worker-ready', '')
      heartbeat = Date.now()
    }
  })
  console.log('Generation worker started')
  const shutdown = () => {
    void worker.close().then(() => { db.close(); process.exit(0) }, () => process.exit(1))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
