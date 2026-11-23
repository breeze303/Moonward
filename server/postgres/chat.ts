import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { MAX_TURN_BYTES, MiB } from '../../shared/contract.ts'
import type { Chat, ChatSummary, FileView, Message, ModelConfig, Turn, Usage } from '../../shared/contract.ts'
import type { RunInput } from '../store.ts'
import type { Upload } from '../validation.ts'
import { HttpError } from '../errors.ts'
import { today } from '../db.ts'
import { admit, cancel, transaction } from './queue.ts'

type Conn = Pool | PoolClient
export async function usagePG(db: Conn, owner: string | null): Promise<Usage> {
  const day = today()
  const {
    rows: [row],
  } = await db.query(
    `SELECT count(*)::int AS count,coalesce(sum(input_tokens),0)::float8 AS "inputTokens",
    coalesce(sum(output_tokens),0)::float8 AS "outputTokens" FROM attempts WHERE day=$1 AND ($2::text IS NULL OR owner_id=$2)`,
    [day, owner],
  )
  const {
    rows: [policy],
  } =
    owner === null
      ? await db.query('SELECT daily_limit FROM site_settings WHERE id=1')
      : await db.query('SELECT daily_limit FROM profiles WHERE id=$1', [owner])
  if (!policy) throw new HttpError(404, 'not_found')
  return { ...row, day, limit: policy.daily_limit } as Usage
}

const fields = `id,title,version,updated_at::float8 AS "updatedAt",(title_job_until>$2 OR
  (title_job_until=-1 AND EXISTS(SELECT FROM title_jobs t WHERE t.chat_id=chats.id AND t.until_ms IS NULL))) AS "titlePending"`
async function path(c: Conn, chat: string, leaf: string | null) {
  return (
    await c.query(
      `WITH RECURSIVE path AS (SELECT m.*,0 AS depth FROM messages m WHERE chat_id=$1 AND id=$2
    UNION ALL SELECT m.*,p.depth+1 FROM path p JOIN messages m ON m.id=p.parent_id AND m.chat_id=$1 WHERE p.depth<400)
    SELECT p.*,coalesce((SELECT json_agg(json_build_object('id',a.id,'name',a.name,'mime',a.mime,'size',a.size) ORDER BY ma.position)
      FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=p.id),'[]') AS files,
      ARRAY(SELECT id FROM messages WHERE chat_id=$1 AND parent_id IS NOT DISTINCT FROM p.parent_id ORDER BY ordinal) AS siblings
    FROM path p ORDER BY depth DESC`,
      [chat, leaf],
    )
  ).rows
}

async function context(c: Conn, chat: string, leaf: string, limit: number, model?: ModelConfig): Promise<RunInput> {
  const input: RunInput = []
  let chars = 0,
    bytes = 0
  for (const m of await path(c, chat, leaf)) {
    chars += m.content.length
    if (chars > limit) throw new HttpError(413, 'context_too_large')
    if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content })
      continue
    }
    const content: Extract<RunInput[number], { role: 'user' }>['content'] = m.content
      ? [{ type: 'input_text', text: m.content }]
      : []
    for (const f of m.files as FileView[]) {
      bytes += f.size
      if (bytes > MAX_TURN_BYTES) throw new HttpError(413, 'context_too_large')
      const image = f.mime.startsWith('image/')
      if (model) {
        if (!(image ? model.vision : model.files)) throw new HttpError(400, 'model_attachment')
        continue
      }
      const {
        rows: [blob],
      } = await c.query('SELECT bytes FROM attachments WHERE id=$1 AND chat_id=$2', [f.id, chat])
      const data = `data:${f.mime};base64,${blob.bytes.toString('base64')}`
      content.push(
        image
          ? { type: 'input_image', image_url: data, detail: 'low' }
          : { type: 'input_file', filename: f.name, file_data: data },
      )
    }
    input.push({ role: 'user', content })
  }
  return input
}

export class PgChats {
  db: Pool
  private firstBatch: { args: unknown[]; resolve: (result: string) => void; reject: (err: unknown) => void }[] = []
  private dispatching = false
  constructor(db: Pool) {
    this.db = db
  }
  private first(args: unknown[]): Promise<string> {
    return new Promise((resolve, reject) => {
      this.firstBatch.push({ args, resolve, reject })
      if (!this.dispatching) {
        this.dispatching = true
        setImmediate(() => void this.flushFirst())
      }
    })
  }
  private async flushFirst() {
    // Ordinality maps independent business errors back to their own request. A transport
    // error is never retried automatically: PostgreSQL may already have committed it.
    let client: PoolClient | undefined
    try {
      client = await this.db.connect()
      while (this.firstBatch.length) {
        const batch = this.firstBatch.splice(0, 32)
        try {
          const { rows } = await client.query('SELECT result FROM submit_batch($1::jsonb) ORDER BY n', [
            JSON.stringify(batch.map((b) => b.args)),
          ])
          rows.forEach((r, i) => batch[i].resolve(r.result))
        } catch (e) {
          batch.forEach((b) => b.reject(e))
          throw e
        }
      }
    } catch (e) {
      this.firstBatch.splice(0).forEach((b) => b.reject(e))
    } finally {
      client?.release()
      this.dispatching = false
    }
  }
  async list(owner: string): Promise<ChatSummary[]> {
    return (
      await this.db.query(`SELECT ${fields} FROM chats WHERE owner_id=$1 ORDER BY updated_at DESC,id`, [
        owner,
        Date.now(),
      ])
    ).rows as ChatSummary[]
  }
  async create(owner: string) {
    const id = randomUUID()
    await transaction(this.db, async (c) => {
      await c.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE', [owner])
      if ((await c.query('SELECT count(*)::int AS n FROM chats WHERE owner_id=$1', [owner])).rows[0].n >= 300)
        throw new HttpError(409, 'chat_limit')
      await c.query("INSERT INTO chats(id,owner_id,title,updated_at,title_job_until) VALUES($1,$2,'',$3,-1)", [
        id,
        owner,
        Date.now(),
      ])
    })
    return this.read(owner, id)
  }
  async read(owner: string, id: string): Promise<Chat> {
    return transaction(this.db, async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      const {
        rows: [chat],
      } = await c.query(`SELECT ${fields},leaf_id FROM chats WHERE id=$3 AND owner_id=$1`, [owner, Date.now(), id])
      if (!chat) throw new HttpError(404, 'not_found')
      const {
        rows: [run],
      } = await c.query(
        "SELECT a.id,j.last_seq FROM attempts a JOIN generation_jobs j USING(id) WHERE chat_id=$1 AND status IN ('queued','streaming')",
        [id],
      )
      const { leaf_id, ...meta } = chat
      const messages = (await path(c, id, leaf_id)).map(
        ({ id, role, content, status, error, model, thinking, citations, files, siblings }) => ({
          id,
          role,
          content,
          status,
          error,
          model,
          thinking: thinking
            ? { ...JSON.parse(thinking), active: status === 'streaming' && JSON.parse(thinking).active }
            : null,
          citations: JSON.parse(citations),
          files,
          siblings,
        }),
      ) as Message[]
      if (run && messages.length) {
        const {
          rows: [chunks],
        } = await c.query(
          "SELECT string_agg(delta,'' ORDER BY seq) AS text,(array_agg(thinking ORDER BY seq DESC) FILTER(WHERE thinking IS NOT NULL))[1] AS thinking FROM run_chunks WHERE run_id=$1",
          [run.id],
        )
        const last = messages.at(-1)!
        if (chunks.text) last.content = chunks.text
        if (chunks.thinking) last.thinking = JSON.parse(chunks.thinking)
      }
      return { ...meta, messages, activeRunId: run?.id ?? null, cursor: run?.last_seq ?? 0 } as Chat
    })
  }
  private async lock(c: PoolClient, owner: string, id: string, version: number) {
    const {
      rows: [chat],
    } = await c.query('SELECT * FROM chats WHERE owner_id=$1 AND id=$2 FOR UPDATE', [owner, id])
    if (!chat) throw new HttpError(404, 'not_found')
    if (chat.version !== version) throw new HttpError(409, 'conflict')
    if ((await c.query("SELECT 1 FROM attempts WHERE chat_id=$1 AND status IN ('queued','streaming')", [id])).rowCount)
      throw new HttpError(409, 'chat_busy')
    return chat
  }
  async rename(owner: string, id: string, version: number, title: string) {
    await transaction(this.db, async (c) => {
      await this.lock(c, owner, id, version)
      await c.query('UPDATE chats SET title=$2,title_job_until=0,version=version+1 WHERE id=$1', [id, title])
    })
    return this.read(owner, id)
  }
  async remove(owner: string, id: string, version: number) {
    await transaction(this.db, async (c) => {
      await this.lock(c, owner, id, version)
      await c.query('DELETE FROM chats WHERE id=$1', [id])
    })
  }
  async select(owner: string, id: string, version: number, selected: string) {
    await transaction(this.db, async (c) => {
      await this.lock(c, owner, id, version)
      const nodes = (await c.query('SELECT id,parent_id FROM messages WHERE chat_id=$1 ORDER BY ordinal', [id])).rows
      if (!nodes.some((n) => n.id === selected)) throw new HttpError(404, 'not_found')
      const children = new Map(nodes.map((n) => [n.parent_id, n.id]))
      let leaf = selected
      while (children.has(leaf)) leaf = children.get(leaf)
      await c.query('UPDATE chats SET leaf_id=$2,version=version+1 WHERE id=$1', [id, leaf])
    })
    return this.read(owner, id)
  }
  async getFile(owner: string, id: string) {
    const {
      rows: [f],
    } = await this.db.query(
      'SELECT a.* FROM attachments a JOIN chats c ON c.id=a.chat_id WHERE c.owner_id=$1 AND a.id=$2',
      [owner, id],
    )
    if (!f) throw new HttpError(404, 'not_found')
    return f
  }
  async stop(owner: string, reason: 'disabled' | 'stopped', chat?: string) {
    const { rows } = await this.db.query(
      "SELECT id FROM attempts WHERE owner_id=$1 AND ($2::text IS NULL OR chat_id=$2) AND status IN ('queued','streaming')",
      [owner, chat],
    )
    for (const { id } of rows) await cancel(this.db, owner, id, reason)
  }
  async input(job: { chat: string; assistant: string; context_chars: number }) {
    const {
      rows: [m],
    } = await this.db.query('SELECT parent_id FROM messages WHERE id=$1', [job.assistant])
    return context(this.db, job.chat, m.parent_id, job.context_chars)
  }
  async reserve(owner: string, turn: Turn, model: ModelConfig, uploads: Upload[], gatewayVersion: number) {
    const id = randomUUID(),
      assistant = randomUUID(),
      { chatId } = turn
    if (turn.text && (turn.text.includes('\0') || !turn.text.isWellFormed())) throw new HttpError(400, 'invalid_input')
    if (turn.action === 'send' && !uploads.length && turn.version === 0) {
      const text = turn.text ?? ''
      if (text.length > model.limits.contextChars) throw new HttpError(413, 'context_too_large')
      const user = randomUUID(),
        now = Date.now(),
        title = Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, 45).join('')
      const result = await this.first([
        owner,
        chatId,
        turn.version,
        gatewayVersion,
        text,
        title,
        model.id,
        turn.effort ?? null,
        Number(turn.web ?? false),
        Number(model.summary),
        model.limits.outputTokens,
        model.limits.contextChars,
        today(),
        id,
        user,
        assistant,
        now,
      ])
      if (result.startsWith('ok:')) {
        const node = { error: null, thinking: null, citations: [], files: [] }
        const chat: Chat = {
          id: chatId,
          title: result.slice(3),
          updatedAt: now,
          version: 1,
          cursor: 0,
          activeRunId: id,
          messages: [
            { ...node, id: user, role: 'user', content: text, status: 'completed', model: null, siblings: [user] },
            {
              ...node,
              id: assistant,
              role: 'assistant',
              content: '',
              status: 'queued',
              model: model.id,
              siblings: [assistant],
            },
          ],
        }
        return { runId: id, chat }
      }
      if (result !== 'history') {
        throw new HttpError(
          result === 'not_found'
            ? 404
            : result === 'disabled'
              ? 403
              : ['queue_full', 'user_limit', 'site_limit'].includes(result)
                ? 429
                : 409,
          result,
        )
      }
    }
    await transaction(this.db, async (c) => {
      await admit(c)
      if (!(await c.query('SELECT 1 FROM gateway_settings WHERE version=$1 FOR SHARE', [gatewayVersion])).rowCount)
        throw new HttpError(409, 'gateway_conflict')
      if (!(await c.query('SELECT 1 FROM profiles WHERE id=$1 AND disabled=0 FOR SHARE', [owner])).rowCount)
        throw new HttpError(403, 'disabled')
      const chat = await this.lock(c, owner, chatId, turn.version)
      for (const target of [owner, null]) {
        const q = await usagePG(c, target)
        if (q.count >= q.limit) throw new HttpError(429, target ? 'user_limit' : 'site_limit')
      }
      const n = (await c.query('SELECT count(*)::int AS n FROM messages WHERE chat_id=$1', [chatId])).rows[0].n
      if (n + (turn.action === 'retry' ? 1 : 2) > 400) throw new HttpError(409, 'message_limit')
      if (uploads.length) {
        const {
          rows: [r],
        } = await c.query(
          'SELECT coalesce(sum(size),0)::float8 AS bytes FROM attachments a JOIN chats c ON c.id=a.chat_id WHERE c.owner_id=$1',
          [owner],
        )
        if (r.bytes + uploads.reduce((n, f) => n + f.bytes.length, 0) > 128 * MiB)
          throw new HttpError(413, 'file_quota')
      }
      const branch = await path(c, chatId, chat.leaf_id),
        target = branch.find((m) => m.id === turn.target)
      let userId: string
      if (turn.action === 'retry') {
        if (target?.role !== 'assistant' || !target.parent_id) throw new HttpError(400, 'invalid_branch')
        userId = target.parent_id
      } else {
        if (turn.action === 'edit' ? target?.role !== 'user' : branch.at(-1)?.role === 'user')
          throw new HttpError(400, 'invalid_branch')
        userId = randomUUID()
        await c.query(
          "INSERT INTO messages(id,chat_id,parent_id,role,content,status) VALUES($1,$2,$3,'user',$4,'completed')",
          [userId, chatId, turn.action === 'edit' ? target!.parent_id : chat.leaf_id, turn.text ?? ''],
        )
        if (turn.action === 'edit')
          await c.query(
            'INSERT INTO message_attachments SELECT $1,attachment_id,position FROM message_attachments WHERE message_id=$2',
            [userId, target!.id],
          )
        else
          for (const [i, f] of uploads.entries()) {
            const aid = randomUUID()
            await c.query('INSERT INTO attachments VALUES($1,$2,$3,$4,$5,$6)', [
              aid,
              chatId,
              f.name,
              f.mime,
              f.bytes.length,
              f.bytes,
            ])
            await c.query('INSERT INTO message_attachments VALUES($1,$2,$3)', [userId, aid, i])
          }
      }
      await context(c, chatId, userId, model.limits.contextChars, model)
      await c.query(
        "INSERT INTO messages(id,chat_id,parent_id,role,content,status,model) VALUES($1,$2,$3,'assistant','','queued',$4)",
        [assistant, chatId, userId, model.id],
      )
      await c.query(
        "INSERT INTO attempts(id,owner_id,chat_id,assistant_id,day,status,model) VALUES($1,$2,$3,$4,$5,'queued',$6)",
        [id, owner, chatId, assistant, today(), model.id],
      )
      await c.query(
        'INSERT INTO generation_jobs(id,effort,web,summary,output_tokens,context_chars) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          turn.effort ?? null,
          Number(turn.web ?? false),
          Number(model.summary),
          model.limits.outputTokens,
          model.limits.contextChars,
        ],
      )
      await c.query('UPDATE chats SET title=$2,leaf_id=$3,version=version+1,updated_at=$4 WHERE id=$1', [
        chatId,
        chat.title ||
          Array.from(turn.text || uploads[0]?.name || '')
            .slice(0, 45)
            .join(''),
        assistant,
        Date.now(),
      ])
    })
    return { runId: id, chat: await this.read(owner, chatId) }
  }
}
