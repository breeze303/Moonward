import type { Pool, PoolClient } from 'pg'
import type { Thinking, Citation, ReplyStatus, Effort } from '../../shared/contract.ts'
import { HttpError } from '../errors.ts'

export async function transaction<T>(db: Pool, body: (c: PoolClient) => Promise<T>) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const result = await body(c)
    await c.query('COMMIT')
    return result
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
  }
}

const notify = (c: PoolClient, id: string) => c.query("SELECT pg_notify('moonward_runs',$1)", [id])
type Limits = { running_limit: number; waiting_limit: number }
type Job = {
  id: string
  owner: string
  chat: string
  assistant: string
  model: string
  effort: Effort | null
  web: number
  summary: number
  output_tokens: number
  context_chars: number
}
type Result = {
  status: Exclude<ReplyStatus, 'streaming'>
  error: string | null
  content: string
  thinking: Thinking | null
  citations: Citation[]
  inputTokens: number | null
  outputTokens: number | null
}

// Call in the same transaction as quota checks, message creation and the attempts INSERT.
export async function admit(c: PoolClient) {
  const {
    rows: [limits],
  } = await c.query<Limits>('SELECT running_limit,waiting_limit FROM site_settings WHERE id=1 FOR UPDATE')
  const {
    rows: [load],
  } = await c.query(
    'SELECT (SELECT count(*) FROM generation_jobs)+(SELECT count(*) FROM title_jobs WHERE until_ms>extract(epoch FROM clock_timestamp())*1000) AS total',
  )
  if (load.total >= limits.running_limit + limits.waiting_limit) throw new HttpError(429, 'queue_full')
}

export async function claim(db: Pool, worker: string) {
  return transaction(db, async (c) => {
    const {
      rows: [limits],
    } = await c.query<Limits>('SELECT running_limit FROM site_settings WHERE id=1 FOR UPDATE')
    const {
      rows: [load],
    } = await c.query(`SELECT (SELECT count(*) FROM generation_jobs WHERE worker_id IS NOT NULL)+
      (SELECT count(*) FROM title_jobs WHERE until_ms>extract(epoch FROM clock_timestamp())*1000) AS active`)
    if (load.active >= limits.running_limit) return null
    const {
      rows: [job],
    } = await c.query<Job>(`SELECT j.id,a.owner_id AS owner,a.chat_id AS chat,a.assistant_id AS assistant,a.model,
      j.effort,j.web,j.summary,j.output_tokens,j.context_chars FROM generation_jobs j JOIN attempts a USING(id)
      JOIN profiles p ON p.id=a.owner_id WHERE j.worker_id IS NULL AND a.status='queued' AND p.disabled=0
      ORDER BY p.last_served,j.ordinal LIMIT 1 FOR UPDATE OF j`)
    if (!job) return null
    await c.query("UPDATE profiles SET last_served=nextval('dispatch_order') WHERE id=$1", [job.owner])
    await c.query(
      "UPDATE generation_jobs SET worker_id=$2,lease_until=clock_timestamp()+interval '10 seconds' WHERE id=$1",
      [job.id, worker],
    )
    await c.query("UPDATE attempts SET status='streaming' WHERE id=$1", [job.id])
    await c.query("UPDATE messages SET status='streaming' WHERE id=$1", [job.assistant])
    await notify(c, job.id)
    return job
  })
}

export async function renew(db: Pool, worker: string, ids: string[]) {
  return (
    await db.query<{ id: string; stop_reason: string | null }>(
      `UPDATE generation_jobs SET lease_until=clock_timestamp()+interval '10 seconds'
    WHERE worker_id=$1 AND id=ANY($2::text[]) AND lease_until>clock_timestamp() RETURNING id,stop_reason`,
      [worker, ids],
    )
  ).rows
}

export async function append(
  db: Pool,
  id: string,
  worker: string,
  seq: number,
  delta: string,
  thinking: Thinking | null,
) {
  return transaction(db, async (c) => {
    const r = await c.query(
      `UPDATE generation_jobs SET last_seq=$3 WHERE id=$1 AND worker_id=$2 AND lease_until>clock_timestamp()
      AND stop_reason IS NULL AND last_seq=$3::integer-1`,
      [id, worker, seq],
    )
    if (!r.rowCount) return false
    await c.query('INSERT INTO run_chunks VALUES ($1,$2,$3,$4)', [id, seq, delta, thinking && JSON.stringify(thinking)])
    await notify(c, id)
    return true
  })
}

async function settle(c: PoolClient, id: string, status: Result['status'], error: string | null, result?: Result) {
  // Retain acknowledged text even if the worker crashed before delivering its terminal snapshot.
  await c.query(
    `UPDATE messages m SET status=$2,error=$3,content=coalesce($4,(SELECT string_agg(delta,'' ORDER BY seq) FROM run_chunks WHERE run_id=$1),m.content),
    thinking=coalesce($5,(SELECT thinking FROM run_chunks WHERE run_id=$1 AND thinking IS NOT NULL ORDER BY seq DESC LIMIT 1),m.thinking),
    citations=coalesce($6,m.citations) FROM attempts a WHERE a.id=$1 AND m.id=a.assistant_id`,
    [
      id,
      status,
      error,
      result?.content,
      result?.thinking && JSON.stringify(result.thinking),
      result && JSON.stringify(result.citations),
    ],
  )
  await c.query('UPDATE attempts SET status=$2,input_tokens=$3,output_tokens=$4 WHERE id=$1', [
    id,
    status,
    result?.inputTokens,
    result?.outputTokens,
  ])
  await c.query(
    'UPDATE chats SET version=version+1,updated_at=$2 FROM attempts a WHERE a.id=$1 AND chats.id=a.chat_id',
    [id, Date.now()],
  )
  if (status === 'completed')
    await c.query(
      `INSERT INTO title_jobs(chat_id,model,output_tokens,gateway_version)
    SELECT a.chat_id,a.model,j.output_tokens,g.version FROM attempts a JOIN generation_jobs j USING(id) JOIN chats ch ON ch.id=a.chat_id
    CROSS JOIN gateway_settings g WHERE a.id=$1 AND ch.title_job_until=-1 ON CONFLICT(chat_id) DO NOTHING`,
      [id],
    )
  await c.query('DELETE FROM generation_jobs WHERE id=$1', [id])
  await c.query('DELETE FROM run_chunks WHERE run_id=$1', [id])
  await notify(c, id)
}

export async function finish(db: Pool, id: string, worker: string, result: Result) {
  return transaction(db, async (c) => {
    const {
      rows: [job],
    } = await c.query(
      'SELECT stop_reason FROM generation_jobs WHERE id=$1 AND worker_id=$2 AND lease_until>clock_timestamp() FOR UPDATE',
      [id, worker],
    )
    if (!job) return false
    const stop = job.stop_reason
    await settle(
      c,
      id,
      stop === 'disabled' ? 'interrupted' : (stop ?? result.status),
      stop === 'stopped' ? null : (stop ?? result.error),
      result,
    )
    return true
  })
}

export async function cancel(db: Pool, owner: string, id: string, reason: 'stopped' | 'disabled') {
  return transaction(db, async (c) => {
    const {
      rows: [job],
    } = await c.query(
      `SELECT j.worker_id FROM generation_jobs j JOIN attempts a USING(id)
      WHERE a.owner_id=$1 AND j.id=$2 FOR UPDATE OF j`,
      [owner, id],
    )
    if (!job) return false
    if (!job.worker_id)
      await settle(c, id, reason === 'stopped' ? 'stopped' : 'interrupted', reason === 'stopped' ? null : reason)
    else
      await c.query(
        "UPDATE generation_jobs SET stop_reason=$2 WHERE id=$1 AND stop_reason IS DISTINCT FROM 'disabled'",
        [id, reason],
      )
    return true
  })
}

// Atomically retire queued work with the account change, even if the API is restarted
// immediately after the administrator gets a successful response.
export async function disableJobs(c: PoolClient, owner: string) {
  const { rows } = await c.query(
    `SELECT j.id,j.worker_id FROM generation_jobs j JOIN attempts a USING(id)
    WHERE a.owner_id=$1 ORDER BY j.id FOR UPDATE OF j`,
    [owner],
  )
  for (const job of rows) {
    if (job.worker_id) await c.query("UPDATE generation_jobs SET stop_reason='disabled' WHERE id=$1", [job.id])
    else await settle(c, job.id, 'interrupted', 'disabled')
  }
}

export async function recover(db: Pool) {
  return transaction(db, async (c) => {
    const { rows } = await c.query(
      'SELECT id,stop_reason FROM generation_jobs WHERE lease_until<=clock_timestamp() ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED',
    )
    for (const { id, stop_reason } of rows)
      await settle(
        c,
        id,
        stop_reason === 'stopped' ? 'stopped' : 'interrupted',
        stop_reason === 'stopped' ? null : (stop_reason ?? 'interrupted'),
      )
    return rows.length
  })
}

// One statement gives terminal state and its replay data a consistent MVCC snapshot.
export async function replay(db: Pool, owner: string, id: string, after: number) {
  const {
    rows: [state],
  } = await db.query(
    `SELECT a.status,a.chat_id,a.assistant_id,m.error,
    CASE WHEN j.id IS NULL THEN m.content END AS final_content,coalesce(j.last_seq,0) AS cursor,
    coalesce((SELECT json_agg(json_build_object('seq',seq,'delta',delta,'thinking',thinking) ORDER BY seq)
      FROM (SELECT * FROM run_chunks WHERE run_id=a.id AND seq>$3 ORDER BY seq LIMIT 128) page),'[]') AS chunks
    FROM attempts a JOIN messages m ON m.id=a.assistant_id LEFT JOIN generation_jobs j ON j.id=a.id WHERE a.id=$1 AND a.owner_id=$2`,
    [id, owner, after],
  )
  if (!state) throw new HttpError(404, 'not_found')
  return state
}
