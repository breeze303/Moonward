import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { all, get, today, tx, usage } from './db.ts'
import { HttpError } from './errors.ts'
import { MAX_TURN_BYTES, MiB } from '../shared/contract.ts'
import type { Chat, ChatSummary, Citation, Effort, FileView, ModelConfig, ReplyStatus, RunReceipt, Thinking, Turn } from '../shared/contract.ts'
import type { Upload } from './validation.ts'

type ChatRow = ChatSummary & { leafId: string | null; titleUntil: number }
type Node = { id: string; parentId: string | null; role: 'user' | 'assistant' }
type MessageRow = Node & { content: string; status: ReplyStatus; error: string | null; model: string | null; citations: string; thinking: string | null }
type FileRow = FileView & { bytes: Uint8Array }
type Part = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'low' } |
  { type: 'input_file'; filename: string; file_data: string }
type Input = { role: 'user'; content: Part[] } | { role: 'assistant'; content: string }
export type RunInput = Input[]
type StopReason = 'stopped' | 'disabled'
type JobRef = { id: string; chatId: string; assistantId: string }
export type GenerationJob = JobRef & { model: string; effort: Effort | null; web: number; summary: number; outputTokens: number; contextChars: number }
export type TitleJob = { chatId: string; until: number; text: string }

const maxChats = 300
const maxMessages = 400
const maxAccountFiles = 128 * MiB
const maxActivePerAccount = 2
export const maxActiveSite = 4
const titleTimeoutMs = 12_000

type ReplySnapshot = { text: string; citations: Citation[]; thinking: Thinking | null }
type RunResult = ReplySnapshot & { status: Exclude<ReplyStatus, 'streaming'>; error: string | null; inputTokens: number | null; outputTokens: number | null }
const summary = ({ titleUntil, ...chat }: Omit<ChatRow, 'leafId'>): ChatSummary =>
  titleUntil > Date.now() ? { ...chat, titlePending: true } : chat

export class ChatStore {
  db: DatabaseSync

  constructor(db: DatabaseSync) { this.db = db }

  private chatRow(owner: string, id: string) {
    const row = get<ChatRow>(this.db, `
      SELECT id, title, version, leaf_id AS leafId, updated_at AS updatedAt, title_job_until AS titleUntil
      FROM chats WHERE owner_id = ? AND id = ?
    `, owner, id)
    if (!row) throw new HttpError(404, 'not_found')
    return row
  }

  private nodes(id: string) {
    return all<Node>(this.db, 'SELECT id, parent_id AS parentId, role FROM messages WHERE chat_id = ? ORDER BY rowid', id)
  }

  private path(id: string, leaf: string | null) {
    if (!leaf) return []
    return all<MessageRow>(this.db, `
      WITH RECURSIVE path(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM messages WHERE chat_id = ? AND id = ?
        UNION ALL
        SELECT m.id, m.parent_id, p.depth + 1 FROM messages AS m JOIN path AS p ON m.id = p.parent_id
        WHERE p.depth < ${maxMessages} AND m.chat_id = ?
      )
      SELECT m.id, m.parent_id AS parentId, m.role, m.content, m.status, m.error, m.model, m.citations, m.thinking
      FROM path JOIN messages AS m USING (id) ORDER BY path.depth DESC
    `, id, leaf, id)
  }

  private messageFiles<T extends FileView>(id: string, includeBytes = false) {
    return all<T>(this.db, `
      SELECT a.id, a.name, a.mime, a.size ${includeBytes ? ', a.bytes' : ''}
      FROM message_attachments AS ma JOIN attachments AS a ON a.id = ma.attachment_id
      WHERE ma.message_id = ? ORDER BY ma.position
    `, id)
  }

  list(owner: string) {
    return all<Omit<ChatRow, 'leafId'>>(this.db, `
      SELECT id, title, version, updated_at AS updatedAt, title_job_until AS titleUntil
      FROM chats WHERE owner_id = ? ORDER BY updated_at DESC, id
    `, owner).map(summary)
  }

  read(owner: string, id: string): Chat {
    const { leafId, ...chat } = this.chatRow(owner, id)
    const nodes = this.nodes(id)
    const siblings = new Map<string | null, string[]>()
    for (const node of nodes) {
      const group = siblings.get(node.parentId) || []
      group.push(node.id)
      siblings.set(node.parentId, group)
    }
    return { ...summary(chat), activeRunId: this.activeRun(id) ?? null, messages: this.path(id, leafId).map(({ parentId, thinking, ...row }) => {
      const phase = thinking ? JSON.parse(thinking) as Thinking : null
      return {
        ...row,
        citations: JSON.parse(row.citations) as Citation[],
        thinking: phase && { ...phase, active: row.status === 'streaming' && phase.active },
        files: this.messageFiles(row.id),
        siblings: siblings.get(parentId) || [row.id],
      }
    }) }
  }

  private activeRun(chatId: string) {
    return get<{ id: string }>(this.db, "SELECT id FROM attempts WHERE chat_id = ? AND status = 'streaming'", chatId)?.id
  }

  create(owner: string) {
    const id = randomUUID()
    tx(this.db, () => {
      if (get<{ count: number }>(this.db, 'SELECT COUNT(*) AS count FROM chats WHERE owner_id = ?', owner)!.count >= maxChats) {
        throw new HttpError(409, 'chat_limit')
      }
      this.db.prepare('INSERT INTO chats (id, owner_id, title, updated_at, title_job_until) VALUES (?, ?, ?, ?, -1)').run(id, owner, '', Date.now())
    })
    return this.read(owner, id)
  }

  private assertMutable(chat: ChatRow, version: number) {
    if (chat.version !== version) throw new HttpError(409, 'conflict')
    if (this.activeRun(chat.id)) {
      throw new HttpError(409, 'chat_busy')
    }
  }

  rename(owner: string, id: string, version: number, title: string) {
    tx(this.db, () => {
      this.assertMutable(this.chatRow(owner, id), version)
      this.db.prepare('UPDATE chats SET title = ?, title_job_until = 0, version = version + 1 WHERE id = ?').run(title, id)
    })
    return this.read(owner, id)
  }

  remove(owner: string, id: string, version: number) {
    tx(this.db, () => {
      this.assertMutable(this.chatRow(owner, id), version)
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(id)
    })
  }

  select(owner: string, id: string, version: number, selected: string) {
    tx(this.db, () => {
      this.assertMutable(this.chatRow(owner, id), version)
      const nodes = this.nodes(id)
      if (!nodes.some((node) => node.id === selected)) throw new HttpError(404, 'not_found')
      const lastChild = new Map(nodes.map((node) => [node.parentId, node.id]))
      let leaf = selected
      for (let child = lastChild.get(leaf); child; child = lastChild.get(leaf)) leaf = child
      this.db.prepare('UPDATE chats SET leaf_id = ?, version = version + 1 WHERE id = ?').run(leaf, id)
    })
    return this.read(owner, id)
  }

  getFile(owner: string, id: string) {
    const row = get<FileRow>(this.db, `
      SELECT a.id, a.name, a.mime, a.size, a.bytes FROM attachments AS a JOIN chats AS c ON c.id = a.chat_id
      WHERE c.owner_id = ? AND a.id = ?
    `, owner, id)
    if (!row) throw new HttpError(404, 'not_found')
    return row
  }

  private addMessage(chat: string, parent: string | null, role: Node['role'], content: string, status: ReplyStatus, model: string | null) {
    const id = randomUUID()
    this.db.prepare('INSERT INTO messages (id, chat_id, parent_id, role, content, status, model) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, chat, parent, role, content, status, model)
    return id
  }

  private attach(message: string, chat: string, files: Upload[]) {
    const add = this.db.prepare('INSERT INTO attachments (id, chat_id, name, mime, size, bytes) VALUES (?, ?, ?, ?, ?, ?)')
    const link = this.db.prepare('INSERT INTO message_attachments VALUES (?, ?, ?)')
    files.forEach(({ name, mime, bytes }, position) => {
      const id = randomUUID()
      add.run(id, chat, name, mime, bytes.length, bytes)
      link.run(message, id, position)
    })
  }

  private context(chatId: string, leaf: string, maxContextChars: number, validation?: ModelConfig): Input[] {
    let textSize = 0, attachmentSize = 0
    const input: Input[] = []
    for (const message of this.path(chatId, leaf)) {
      textSize += message.content.length
      if (textSize > maxContextChars) throw new HttpError(413, 'context_too_large')
      if (message.role === 'assistant') {
        if (message.content) input.push({ role: 'assistant', content: message.content })
        continue
      }
      const content: Part[] = message.content ? [{ type: 'input_text', text: message.content }] : []
      const files = this.messageFiles(message.id)
      for (const file of files) {
        attachmentSize += file.size
        const image = file.mime.startsWith('image/')
        if (validation && !(image ? validation.vision : validation.files)) throw new HttpError(400, 'model_attachment')
      }
      if (attachmentSize > MAX_TURN_BYTES) throw new HttpError(413, 'context_too_large')
      if (validation) continue
      if (files.length) {
        for (const file of this.messageFiles<FileRow>(message.id, true)) {
          const data = `data:${file.mime};base64,${Buffer.from(file.bytes).toString('base64')}`
          content.push(file.mime.startsWith('image/')
            ? { type: 'input_image', image_url: data, detail: 'low' }
            : { type: 'input_file', filename: file.name, file_data: data })
        }
      }
      input.push({ role: 'user', content })
    }
    return input
  }

  reserve(owner: string, turn: Turn, model: ModelConfig, uploads: Upload[], gatewayVersion: number): RunReceipt {
    const { chatId, version, action } = turn
    return tx(this.db, () => {
      if (!get(this.db, 'SELECT 1 FROM gateway_settings WHERE id = 1 AND version = ?', gatewayVersion)) {
        throw new HttpError(409, 'gateway_conflict')
      }
      const profile = get<{ disabled: number }>(this.db, 'SELECT disabled FROM profiles WHERE id = ?', owner)
      if (!profile || profile.disabled) throw new HttpError(403, 'disabled')
      const chat = this.chatRow(owner, chatId)
      this.assertMutable(chat, version)
      if (get<{ count: number }>(this.db, "SELECT COUNT(*) AS count FROM attempts WHERE owner_id = ? AND status = 'streaming'", owner)!.count >= maxActivePerAccount) {
        throw new HttpError(409, 'user_busy')
      }
      if (get<{ count: number }>(this.db, "SELECT COUNT(*) AS count FROM attempts WHERE status = 'streaming'")!.count >= maxActiveSite) {
        throw new HttpError(429, 'site_busy')
      }
      const day = today()
      const userUsage = usage(this.db, owner, day), siteUsage = usage(this.db, null, day)
      if (userUsage.count >= userUsage.limit) throw new HttpError(429, 'user_limit')
      if (siteUsage.count >= siteUsage.limit) throw new HttpError(429, 'site_limit')
      if (this.nodes(chatId).length + (action === 'retry' ? 1 : 2) > maxMessages) throw new HttpError(409, 'message_limit')
      if (uploads.length) {
        const current = get<{ size: number }>(this.db, `
          SELECT COALESCE(SUM(a.size), 0) AS size FROM attachments AS a JOIN chats AS c ON c.id = a.chat_id WHERE c.owner_id = ?
        `, owner)!.size
        if (current + uploads.reduce((n, f) => n + f.bytes.length, 0) > maxAccountFiles) throw new HttpError(413, 'file_quota')
      }

      const path = this.path(chatId, chat.leafId)
      const target = path.find((node) => node.id === turn.target)
      let userId: string
      if (action === 'retry') {
        if (target?.role !== 'assistant' || !target.parentId) throw new HttpError(400, 'invalid_branch')
        userId = target.parentId
      } else {
        if (action === 'edit' && target?.role !== 'user') throw new HttpError(400, 'invalid_branch')
        if (action === 'send' && path.at(-1)?.role === 'user') throw new HttpError(400, 'invalid_branch')
        userId = this.addMessage(chatId, action === 'edit' ? target!.parentId : chat.leafId, 'user', turn.text || '', 'completed', null)
        if (action === 'edit') {
          this.db.prepare('INSERT INTO message_attachments SELECT ?, attachment_id, position FROM message_attachments WHERE message_id = ?')
            .run(userId, target!.id)
        } else this.attach(userId, chatId, uploads)
      }

      // Validate the complete replay before charging a request or publishing the new branch.
      this.context(chatId, userId, model.limits.contextChars, model)
      const assistantId = this.addMessage(chatId, userId, 'assistant', '', 'streaming', model.id)
      const id = randomUUID()
      this.db.prepare('INSERT INTO attempts (id, owner_id, chat_id, assistant_id, day, status, model) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, owner, chatId, assistantId, day, 'streaming', model.id)
      this.db.prepare('INSERT INTO generation_jobs (id, effort, web, summary, output_tokens, context_chars) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, turn.effort ?? null, Number(turn.web ?? false), Number(model.summary), model.limits.outputTokens, model.limits.contextChars)
      const title = chat.title || Array.from((turn.text || uploads[0]?.name || '').replace(/\s+/gu, ' ')).slice(0, 45).join('')
      this.db.prepare('UPDATE chats SET title = ?, leaf_id = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(title, assistantId, Date.now(), chatId)
      return { runId: id, chat: this.read(owner, chatId) }
    })
  }

  progress(id: string, owner: string) {
    return get<{ chatId: string; assistantId: string; content: string; thinking: string | null; status: ReplyStatus; error: string | null }>(this.db, `
      SELECT a.chat_id AS chatId, a.assistant_id AS assistantId, m.content, m.thinking, a.status, m.error
      FROM attempts a JOIN messages m ON m.id = a.assistant_id WHERE a.id = ? AND a.owner_id = ?
    `, id, owner)
  }

  claim(worker: string, now: number, leaseMs: number): GenerationJob | undefined {
    const job = get<GenerationJob>(this.db, `
      SELECT j.id, a.chat_id AS chatId, a.assistant_id AS assistantId, a.model, j.effort, j.web, j.summary,
        j.output_tokens AS outputTokens, j.context_chars AS contextChars
      FROM attempts a JOIN generation_jobs j ON j.id = a.id
      WHERE a.status = 'streaming' AND j.worker_id IS NULL ORDER BY a.rowid LIMIT 1
    `)
    if (!job) return
    const result = this.db.prepare('UPDATE generation_jobs SET worker_id = ?, lease_until = ? WHERE id = ? AND worker_id IS NULL')
      .run(worker, now + leaseMs, job.id)
    if (result.changes) return job
  }

  input(job: GenerationJob) {
    const parent = get<{ parent_id: string }>(this.db, 'SELECT parent_id FROM messages WHERE id = ?', job.assistantId)
    if (!parent?.parent_id) throw new Error('Missing generation input')
    return this.context(job.chatId, parent.parent_id, job.contextChars)
  }

  lease(id: string, worker: string, now: number, leaseMs: number): { stop_reason: StopReason | null } | undefined {
    const lease = get<{ stop_reason: StopReason | null; lease_until: number }>(this.db,
      'SELECT stop_reason, lease_until FROM generation_jobs WHERE id = ? AND worker_id = ? AND lease_until > ?', id, worker, now)
    if (lease && lease.lease_until <= now + leaseMs / 2) {
      this.db.prepare('UPDATE generation_jobs SET lease_until = ? WHERE id = ? AND worker_id = ? AND lease_until > ?')
        .run(now + leaseMs, id, worker, now)
    }
    return lease
  }

  checkpoint(job: JobRef, worker: string, now: number, { text, citations, thinking }: ReplySnapshot) {
    this.db.prepare(`
      UPDATE messages SET content = ?, citations = ?, thinking = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM generation_jobs WHERE id = ? AND worker_id = ? AND lease_until > ?)
    `).run(text, JSON.stringify(citations), thinking && JSON.stringify(thinking), job.assistantId, job.id, worker, now)
  }

  private settle(job: JobRef, status: Exclude<ReplyStatus, 'streaming'>, error: string | null, result?: RunResult) {
    if (result) {
      this.db.prepare('UPDATE messages SET content = ?, citations = ?, thinking = ? WHERE id = ?')
        .run(result.text, JSON.stringify(result.citations), result.thinking && JSON.stringify(result.thinking), job.assistantId)
    }
    this.db.prepare('UPDATE messages SET status = ?, error = ? WHERE id = ?').run(status, error, job.assistantId)
    this.db.prepare('UPDATE attempts SET status = ?, input_tokens = ?, output_tokens = ? WHERE id = ?')
      .run(status, result?.inputTokens ?? null, result?.outputTokens ?? null, job.id)
    this.db.prepare('UPDATE chats SET version = version + 1, updated_at = ? WHERE id = ?').run(Date.now(), job.chatId)
    this.db.prepare('DELETE FROM generation_jobs WHERE id = ?').run(job.id)
  }

  finish(job: JobRef, worker: string, now: number, result: RunResult) {
    return tx(this.db, () => {
      const row = get<{ stop_reason: StopReason | null }>(this.db,
        'SELECT stop_reason FROM generation_jobs WHERE id = ? AND worker_id = ? AND lease_until > ?', job.id, worker, now)
      if (!row) return null
      const stop = row.stop_reason
      this.settle(job, stop === 'stopped' ? 'stopped' : stop ? 'interrupted' : result.status,
        stop === 'stopped' ? null : stop ?? result.error, result)
      const title = !stop && result.status === 'completed' ? this.claimTitle(job.chatId, now, result.text) : null
      return { title }
    })
  }

  private claimTitle(chatId: string, now: number, reply: string): TitleJob | null {
    // -1 permits one title attempt. An expired claim still keeps the provisional title after a worker restart.
    const until = now + titleTimeoutMs
    if (!this.db.prepare('UPDATE chats SET title_job_until = ? WHERE id = ? AND title_job_until = -1').run(until, chatId).changes) return null
    const first = get<{ text: string }>(this.db, `
      SELECT substr(content, 1, 512) AS text FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY rowid LIMIT 1
    `, chatId)
    return { chatId, until, text: first?.text.trim() || reply.slice(0, 512).trim() }
  }

  finishTitle(job: TitleJob, title: string | null) {
    this.db.prepare(`
      UPDATE chats SET title = COALESCE(?, title), title_job_until = 0
      WHERE id = ? AND title_job_until = ?
    `).run(title, job.chatId, job.until)
  }

  stop(owner: string, reason: StopReason, chatId?: string) {
    tx(this.db, () => {
      const jobs = all<JobRef & { worker_id: string | null }>(this.db, `
        SELECT j.id, a.chat_id AS chatId, a.assistant_id AS assistantId, j.worker_id
        FROM attempts a JOIN generation_jobs j ON j.id = a.id WHERE a.status = 'streaming' AND a.owner_id = ?
        ${chatId === undefined ? '' : 'AND a.chat_id = ?'}
      `, owner, ...(chatId === undefined ? [] : [chatId]))
      for (const job of jobs) {
        if (job.worker_id) {
          this.db.prepare("UPDATE generation_jobs SET stop_reason = ? WHERE id = ? AND stop_reason IS NOT 'disabled'").run(reason, job.id)
        } else this.settle(job, reason === 'stopped' ? 'stopped' : 'interrupted', reason === 'disabled' ? reason : null)
      }
    })
  }

  recoverExpired(now: number) {
    const jobs = all<JobRef & { stop_reason: StopReason | null }>(this.db, `
      SELECT j.id, a.chat_id AS chatId, a.assistant_id AS assistantId, j.stop_reason
      FROM generation_jobs j JOIN attempts a ON a.id = j.id WHERE j.lease_until <= ?
    `, now)
    if (!jobs.length) return
    tx(this.db, () => {
      for (const job of jobs) {
        const row = get<{ stop_reason: StopReason | null }>(this.db, 'SELECT stop_reason FROM generation_jobs WHERE id = ? AND lease_until <= ?', job.id, now)
        if (row) this.settle(job, row.stop_reason === 'stopped' ? 'stopped' : 'interrupted',
          row.stop_reason === 'stopped' ? null : row.stop_reason ?? 'interrupted')
      }
    })
  }
}
