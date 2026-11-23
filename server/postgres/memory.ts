import type { Pool, PoolClient } from 'pg'
import type { Express, Request } from 'express'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { transaction } from './queue.ts'
import { HttpError } from '../errors.ts'
import { read } from '../validation.ts'
import type { RunInput } from '../store.ts'

export function memoryRoutes(
  app: Express,
  db: Pool,
  user: (req: Request) => Promise<{ id: string }>,
  admin: (req: Request) => Promise<unknown>,
) {
  const json = express.json({ limit: '8kb' }),
    body = z.string().trim().min(1).max(500),
    scope = z.string().trim().max(60)
  async function mutate(owner: string, fn: (c: PoolClient) => Promise<void>) {
    await transaction(db, async (c) => {
      await c.query('UPDATE profiles SET memory_epoch=memory_epoch+1 WHERE id=$1', [owner])
      await fn(c)
    })
  }
  async function safe(c: PoolClient, owner: string, text: string) {
    if (
      !(
        await c.query('SELECT FROM profiles WHERE id=$1 AND memory_enabled AND NOT memory_sensitive($2)', [
          owner,
          text,
        ])
      ).rowCount
    )
      throw new HttpError(400, 'memory_rejected')
  }
  app.get('/api/memory', async (req, res) => {
    const { id } = await user(req)
    const prefs = (
      await db.query('SELECT memory_enabled AS enabled,memory_auto AS automatic FROM profiles WHERE id=$1', [id])
    ).rows[0]
    const items = (
      await db.query(
        `SELECT m.id,m.body,m.scope,m.changed,m.revision,m.locked,m.source,c.title AS origin FROM memories m LEFT JOIN messages s ON s.id=m.source LEFT JOIN chats c ON c.id=s.chat_id WHERE m.owner_id=$1 ORDER BY changed DESC`,
        [id],
      )
    ).rows
    res.json({ ...prefs, items })
  })
  app.patch('/api/memory/settings', json, async (req, res) => {
    const { id } = await user(req),
      v = read(z.strictObject({ enabled: z.boolean().optional(), automatic: z.boolean().optional() }), req.body)
    await mutate(id, async (c) => {
      await c.query(
        'UPDATE profiles SET memory_enabled=coalesce($2,memory_enabled),memory_auto=coalesce($3,memory_auto) WHERE id=$1',
        [id, v.enabled, v.automatic],
      )
    })
    res.sendStatus(204)
  })
  app.post('/api/memory', json, async (req, res) => {
    const { id } = await user(req),
      v = read(z.strictObject({ body, scope }), req.body)
    await mutate(id, async (c) => {
      await safe(c, id, v.body + ' ' + v.scope)
      if ((await c.query('SELECT count(*)::int AS n FROM memories WHERE owner_id=$1', [id])).rows[0].n >= 200)
        throw new HttpError(409, 'memory_limit')
      await c.query('INSERT INTO memories(owner_id,topic,body,scope,locked) VALUES($1,$2,$3,$4,true)', [
        id,
        randomUUID(),
        v.body,
        v.scope,
      ])
    })
    res.sendStatus(204)
  })
  app.delete('/api/memory', json, async (req, res) => {
    const { id } = await user(req)
    read(z.strictObject({ confirm: z.literal(true) }), req.body)
    await mutate(id, async (c) => {
      await c.query('DELETE FROM memories WHERE owner_id=$1', [id])
    })
    res.sendStatus(204)
  })
  app.post('/api/memory/:id', json, async (req, res) => {
    const owner = (await user(req)).id,
      id = read(z.uuid(), req.params.id),
      v = read(
        z.discriminatedUnion('action', [
          z.strictObject({ action: z.literal('edit'), body, scope, revision: z.int().positive() }),
          z.strictObject({ action: z.enum(['delete', 'undo']), revision: z.int().positive() }),
        ]),
        req.body,
      )
    await mutate(owner, async (c) => {
      const m = (
        await c.query('SELECT prior,source FROM memories WHERE id=$1 AND owner_id=$2 AND revision=$3 FOR UPDATE', [
          id,
          owner,
          v.revision,
        ])
      ).rows[0]
      if (!m || (v.action === 'undo' && !m.source)) throw new HttpError(409, 'conflict')
      if (v.action === 'edit') {
        await safe(c, owner, v.body + ' ' + v.scope)
        await c.query(
          'UPDATE memories SET body=$2,scope=$3,locked=true,source=NULL,prior=NULL,revision=revision+1,changed=now() WHERE id=$1',
          [id, v.body, v.scope],
        )
      } else if (v.action === 'undo' && m.prior)
        await c.query(
          'UPDATE memories SET body=$2,locked=$3,source=NULL,prior=NULL,revision=revision+1,changed=now() WHERE id=$1',
          [id, m.prior.body, m.prior.locked],
        )
      else await c.query('DELETE FROM memories WHERE id=$1', [id])
    })
    res.sendStatus(204)
  })
  app.get('/api/admin/memory', async (req, res) => {
    await admin(req)
    res.json(
      (
        await db.query(
          "SELECT memory_model AS model,(SELECT count(*)::int FROM memory_jobs WHERE started IS NOT NULL) AS calls,(SELECT count(*)::int FROM memory_jobs WHERE state='failed') AS failures FROM site_settings WHERE id=1",
        )
      ).rows[0],
    )
  })
  app.put('/api/admin/memory', json, async (req, res) => {
    await admin(req)
    const { model } = read(z.strictObject({ model: z.string().max(128).nullable() }), req.body)
    if (
      model !== null &&
      !(
        await db.query(
          `SELECT FROM model_catalog,jsonb_array_elements(selection::jsonb->'models') m WHERE m->>'id'=$1 AND m->>'enabled'='true'`,
          [model],
        )
      ).rowCount
    )
      throw new HttpError(400, 'model_unavailable')
    await db.query('UPDATE site_settings SET memory_model=$1 WHERE id=1', [model])
    res.sendStatus(204)
  })
}

export async function recall(
  db: Pool,
  job: { owner: string; chat: string; assistant: string; context_chars: number },
  input: RunInput,
) {
  const texts = input.flatMap((m) =>
    typeof m.content === 'string'
      ? [m.content]
      : m.content.flatMap((p) => (p.type === 'input_text' ? [p.text] : [])),
  )
  const q = (texts.at(-1) || '').toLowerCase(),
    aliases: Record<string, RegExp> = {
      部署: /部署|安装|上线|deploy|install|容器|docker|podman/,
      数据库: /数据库|存储|postgres|mysql|database/,
    }
  const rows = (
    await db.query(
      `SELECT m.id,m.body,m.scope FROM memories m JOIN profiles p ON p.id=m.owner_id JOIN chats c ON c.owner_id=p.id WHERE c.id=$1 AND p.id=$2 AND c.memory_enabled AND p.memory_enabled ORDER BY changed DESC LIMIT 200`,
      [job.chat, job.owner],
    )
  ).rows
  let budget = Math.min(1000, job.context_chars - texts.reduce((n, s) => n + s.length, 0)),
    selected = 0
  const prefix = '以下是用户保存的背景资料，仅供参考，以本轮要求为准：\n'
  budget -= prefix.length
  const refs: { id: string; text: string }[] = []
  for (const m of rows
    .filter((m) => !m.scope || q.includes(m.scope.toLowerCase()) || aliases[m.scope]?.test(q))
    .sort((a, b) => Number(!!b.scope) - Number(!!a.scope))) {
    const n = JSON.stringify(m.body).length + 2
    if (n > budget) continue
    refs.push({ id: m.id, text: m.body })
    budget -= n
    if (++selected === 5) break
  }
  if (!refs.length) return
  await db.query(
    `INSERT INTO memory_references SELECT $1,m.id,r.text FROM jsonb_to_recordset($2::jsonb) r(id uuid,text text) JOIN memories m ON m.id=r.id AND m.owner_id=$3 ON CONFLICT DO NOTHING`,
    [job.assistant, JSON.stringify(refs), job.owner],
  )
  input.unshift({
    role: 'user',
    content: [{ type: 'input_text', text: prefix + JSON.stringify(refs.map((r) => r.text)) }],
  })
}
