import pg from 'pg'
import type { ChatEvent } from '../../shared/contract.ts'
import type { PgChats } from './chat.ts'
import { usagePG } from './chat.ts'
import { replay } from './queue.ts'

// One listener per API process, never one database connection per browser.
export class RunFeed {
  private listeners = new Map<string, Set<() => void>>()
  private client?: pg.Client
  private retry?: NodeJS.Timeout
  private stopped = false
  onRevoke?: (owner?: string) => void
  private url: string
  constructor(url: string) {
    this.url = url
  }
  async start() {
    const c = new pg.Client({ connectionString: this.url })
    this.client = c
    const lost = () => {
      if (this.client !== c || this.stopped) return
      this.client = undefined
      this.onRevoke?.()
      void c.end().catch(() => {})
      this.retry = setTimeout(() => void this.start().catch(() => {}), 1000)
    }
    c.on('error', lost)
    c.on('end', lost)
    c.on('notification', (n) => {
      if (n.channel === 'moonward_revoke') this.onRevoke?.(n.payload)
      else for (const wake of this.listeners.get(n.payload ?? '') ?? []) wake()
    })
    try {
      await c.connect()
      await c.query('LISTEN moonward_runs; LISTEN moonward_revoke')
      this.onRevoke?.()
      for (const list of this.listeners.values()) for (const wake of list) wake()
    } catch (e) {
      lost()
      throw e
    }
  }
  async close() {
    this.stopped = true
    clearTimeout(this.retry)
    await this.client?.end()
  }
  async follow(
    store: PgChats,
    id: string,
    owner: string,
    signal: AbortSignal,
    send: (e: ChatEvent) => Promise<void>,
    heartbeat: () => void,
  ) {
    let dirty = true,
      resume: (() => void) | undefined
    const wake = () => {
      dirty = true
      resume?.()
    }
    const listeners = this.listeners.get(id) ?? new Set()
    listeners.add(wake)
    this.listeners.set(id, listeners)
    signal.addEventListener('abort', wake)
    try {
      const state = await replay(store.db, owner, id, 0),
        chat = await store.read(owner, state.chat_id)
      await send({ type: 'start', chat })
      let seq = chat.activeRunId === id ? (chat.cursor ?? 0) : 0,
        running = chat.messages.at(-1)?.status === 'streaming'
      while (!signal.aborted) {
        if (!dirty) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              heartbeat()
              resolve()
            }, 12000)
            resume = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          resume = undefined
        }
        if (signal.aborted) break
        dirty = false
        const next = await replay(store.db, owner, id, seq)
        if (next.status !== 'queued' && next.status !== 'streaming') {
          if (next.error === 'disabled') await send({ type: 'error', code: 'disabled' })
          else
            await send({
              type: 'done',
              chat: await store.read(owner, state.chat_id),
              usage: await usagePG(store.db, owner),
            })
          break
        }
        if (next.status === 'streaming' && !running) {
          running = true
          await send({ type: 'running' })
        }
        for (const chunk of next.chunks) {
          if (chunk.thinking) await send({ type: 'thinking', thinking: JSON.parse(chunk.thinking) })
          if (chunk.delta) await send({ type: 'delta', content: chunk.delta })
          seq = chunk.seq
        }
        if (seq < next.cursor) dirty = true
      }
    } finally {
      listeners.delete(wake)
      if (!listeners.size) this.listeners.delete(id)
      signal.removeEventListener('abort', wake)
    }
  }
}
