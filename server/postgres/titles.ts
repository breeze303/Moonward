import type { Pool } from 'pg'
import { transaction } from './queue.ts'

type Title = {
  chat: string
  model: string
  output_tokens: number
  gateway_version: number
  text: string | null
  until: number
}

export async function claimTitle(db: Pool): Promise<Title | undefined> {
  if (!(await db.query('SELECT 1 FROM title_jobs LIMIT 1')).rowCount) return
  return transaction(db, async (c) => {
    const {
      rows: [limits],
    } = await c.query('SELECT running_limit FROM site_settings WHERE id=1 FOR UPDATE')
    await c.query(`DELETE FROM title_jobs j WHERE until_ms<=extract(epoch FROM clock_timestamp())*1000 OR (until_ms IS NULL
      AND NOT EXISTS(SELECT FROM chats ch JOIN profiles p ON p.id=ch.owner_id JOIN gateway_settings g ON g.version=j.gateway_version
      WHERE ch.id=j.chat_id AND ch.title_job_until=-1 AND p.disabled=0))`)
    const {
      rows: [load],
    } = await c.query(`SELECT count(*) FILTER (WHERE worker_id IS NULL) AS waiting,
      count(*)+(SELECT count(*) FROM title_jobs WHERE until_ms IS NOT NULL) AS total FROM generation_jobs`)
    if (Number(load.waiting) || Number(load.total) >= limits.running_limit) return
    const {
      rows: [job],
    } = await c.query(`SELECT j.chat_id AS chat,j.model,j.output_tokens,j.gateway_version,
      (SELECT substr(content,1,512) FROM messages WHERE chat_id=ch.id AND role='user' ORDER BY ordinal LIMIT 1) AS text,
      (floor(extract(epoch FROM clock_timestamp())*1000)+12000)::float8 AS until FROM title_jobs j JOIN chats ch ON ch.id=j.chat_id
      WHERE j.until_ms IS NULL AND ch.title_job_until=-1 ORDER BY j.ordinal LIMIT 1 FOR UPDATE OF j,ch`)
    if (!job) return
    await c.query('UPDATE title_jobs SET until_ms=$2 WHERE chat_id=$1', [job.chat, job.until])
    await c.query('UPDATE chats SET title_job_until=$2 WHERE id=$1', [job.chat, job.until])
    return job as Title
  })
}

export async function finishTitle(db: Pool, job: Title, name: string | null) {
  await transaction(db, async (c) => {
    if (
      !(await c.query('DELETE FROM title_jobs WHERE chat_id=$1 AND until_ms=$2 RETURNING 1', [job.chat, job.until]))
        .rowCount
    )
      return
    await c.query('UPDATE chats SET title=coalesce($3,title),title_job_until=0 WHERE id=$1 AND title_job_until=$2', [
      job.chat,
      job.until,
      name,
    ])
  })
}
