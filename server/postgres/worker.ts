import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import type { Pool } from 'pg'
import type { Config } from '../config.ts'
import { PgChats } from './chat.ts'
import { PgGateway } from './settings.ts'
import { append, claim, finish, recover, renew } from './queue.ts'
import { claimTitle, finishTitle } from './titles.ts'
import { recall } from './memory.ts'
import { extractOne } from './memoryWorker.ts'
import { createUpstream, ResponseAccumulator, chatTitleInstructions } from '../upstream.ts'
import { HttpError } from '../errors.ts'
import type { Thinking } from '../../shared/contract.ts'

type Job = NonNullable<Awaited<ReturnType<typeof claim>>>
export function pgWorker(db: Pool, config: Config, heartbeat = () => {}) {
  const worker = randomUUID(),
    chats = new PgChats(db),
    gateway = new PgGateway(db, config)
  const upstream = createUpstream(() => {
    throw new Error('Missing destination')
  }, config.allowLoopbackGateway)
  const active = new Map<string, AbortController>(),
    tasks = new Set<Promise<void>>(),
    shutdown = new AbortController()
  async function title(ticket: NonNullable<Awaited<ReturnType<typeof claimTitle>>>) {
    let name: string | null = null
    try {
      const destination = await gateway.connection()
      if (!ticket.text || destination.version !== ticket.gateway_version) return
      const state = new ResponseAccumulator(512),
        signal = AbortSignal.any([
          shutdown.signal,
          AbortSignal.timeout(Math.min(12000, Math.max(1, ticket.until - Date.now()))),
        ])
      for await (const event of upstream.stream(
        [{ role: 'user', content: [{ type: 'input_text', text: ticket.text }] }],
        { model: ticket.model, outputTokens: Math.min(ticket.output_tokens, 512), instructions: chatTitleInstructions },
        false,
        signal,
        destination,
      )) {
        state.accept(event)
        if (state.terminal) break
      }
      if (state.terminal === 'completed')
        name =
          Array.from(
            state
              .snapshot()
              .text.trim()
              .split('\n')[0]
              .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' '),
          )
            .slice(0, 45)
            .join('')
            .trim() || null
    } catch {
      /* The local title is retained when the optional upstream title request fails. */
    } finally {
      await finishTitle(db, ticket, name)
    }
  }
  async function run(job: Job, ctrl: AbortController) {
    const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(600000)]),
      state = new ResponseAccumulator(job.output_tokens)
    let seq = 0,
      delta = '',
      thinking: Thinking | null = null,
      flushing: Promise<void> | undefined,
      timer: NodeJS.Timeout | undefined
    const flush = () => {
      if (flushing) return flushing
      if (!delta && !thinking) return Promise.resolve()
      const text = delta,
        phase = thinking
      delta = ''
      thinking = null
      flushing = append(db, job.id, worker, ++seq, text, phase)
        .then((ok) => {
          if (!ok) ctrl.abort('lease_lost')
        })
        .catch(() => ctrl.abort('storage_error'))
        .finally(() => {
          flushing = undefined
          if ((delta || thinking) && !signal.aborted) schedule()
        })
      return flushing
    }
    const schedule = () => {
      timer ??= setTimeout(() => {
        timer = undefined
        void flush()
      }, 100)
    }
    let error: string | null = 'upstream_interrupted'
    try {
      const destination = await gateway.connection()
      const input = await chats.input(job)
      await recall(db,job,input).catch(()=>{})
      for await (const event of upstream.stream(
        input,
        { model: job.model, effort: job.effort ?? undefined, web: !!job.web, outputTokens: job.output_tokens },
        !!job.summary,
        signal,
        destination,
      )) {
        const old = state.thinking
        delta += state.accept(event)
        if (old !== state.thinking) thinking = state.thinking
        if (delta || thinking) {
          if (!seq) await flush()
          else schedule()
        }
        if (state.terminal || signal.aborted) break
      }
      if (state.terminal) error = state.error
    } catch (e) {
      error = e instanceof HttpError ? e.code : 'upstream_failed'
    } finally {
      clearTimeout(timer)
      await flushing
      clearTimeout(timer)
    }
    state.finishThinking()
    const snapshot = state.snapshot()
    const status = signal.aborted
      ? 'interrupted'
      : (state.terminal ?? (error === 'upstream_interrupted' ? 'interrupted' : 'failed'))
    await finish(db, job.id, worker, {
      status,
      error: signal.aborted ? (ctrl.signal.aborted ? 'interrupted' : 'upstream_timeout') : error,
      content: snapshot.text,
      thinking: snapshot.thinking,
      citations: snapshot.citations,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
    })
    active.delete(job.id)
  }
  const leases = (async () => {
    while (!shutdown.signal.aborted) {
      try {
        const ids = [...active.keys()]
        if (ids.length) {
          const kept = new Map((await renew(db, worker, ids)).map((r) => [r.id, r.stop_reason]))
          for (const id of ids) if (!kept.has(id) || kept.get(id)) active.get(id)?.abort(kept.get(id) ?? 'lease_lost')
        }
        await recover(db)
        heartbeat()
      } catch {
        for (const ctrl of active.values()) ctrl.abort('storage_error')
      }
      await wait(500)
    }
  })()
  let nextExtraction=0, extracting=false
  const dispatch = (async () => {
    while (!shutdown.signal.aborted) {
      try {
        const job = await claim(db, worker)
        if (job) {
          const ctrl = new AbortController()
          active.set(job.id, ctrl)
          if (shutdown.signal.aborted) ctrl.abort()
          const task = run(job, ctrl)
            .catch(() => console.error('[postgres] generation could not be saved'))
            .finally(() => {
              tasks.delete(task)
              active.delete(job.id)
            })
          tasks.add(task)
          continue
        }
        const ticket = await claimTitle(db)
        if (ticket) {
          const task = title(ticket)
            .catch(() => console.error('[postgres] title could not be saved'))
            .finally(() => tasks.delete(task))
          tasks.add(task)
          continue
        }
        if(!extracting && Date.now()>=nextExtraction){
          extracting=true;nextExtraction=Date.now()+2000
          const task=extractOne(db,gateway,upstream,shutdown.signal).catch(()=>{}).finally(()=>{extracting=false;tasks.delete(task)})
          tasks.add(task)
        }
      } catch {
        console.error('[postgres] dispatch unavailable')
      }
      await wait(100)
    }
  })()
  return {
    async close() {
      shutdown.abort()
      for (const ctrl of active.values()) ctrl.abort('shutdown')
      await Promise.all([dispatch, leases])
      await Promise.all(tasks)
      await upstream.close()
    },
  }
}
