import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { GatewayStore } from '../gateway.ts'
import { loadConfig } from '../config.ts'

const tables = [
  'user',
  'account',
  'session',
  'verification',
  'profiles',
  'invitations',
  'site_settings',
  'chats',
  'messages',
  'attachments',
  'message_attachments',
  'attempts',
  'gateway_settings',
  'model_catalog',
  'generation_jobs',
]
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const dates = new Set(['createdAt', 'updatedAt', 'expiresAt', 'accessTokenExpiresAt', 'refreshTokenExpiresAt'])

function canonical(key: string, value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Uint8Array) return createHash('sha256').update(value).digest('hex')
  if (key === 'emailVerified') return value === true || value === 1 ? 'true' : 'false'
  if (dates.has(key)) return new Date(value as string | number).toISOString()
  return String(value)
}

// Both the DDL and data verification are in the same target transaction. Never merge into an existing site.
export async function importSnapshot(source: string, target: pg.Client, secret: string) {
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    db.exec('BEGIN')
    if (
      db.prepare('PRAGMA user_version').get()?.user_version !== 6 ||
      db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').get()
    )
      throw new Error('Expected an intact SQLite v6 snapshot')
    const names = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name)
      .sort()
    if (JSON.stringify(names) !== JSON.stringify([...tables].sort())) throw new Error('Unexpected source schema')
    if (
      db
        .prepare("SELECT 1 FROM generation_jobs UNION ALL SELECT 1 FROM attempts WHERE status='streaming' LIMIT 1")
        .get()
    )
      throw new Error('Drain workers before taking the snapshot')
    new GatewayStore(db, loadConfig({ AUTH_SECRET: secret })).connection()
    await target.query('BEGIN')
    try {
      await target.query('SET LOCAL search_path TO public')
      if (
        (
          await target.query(
            "SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S','f') LIMIT 1",
          )
        ).rowCount
      )
        throw new Error('Target database must be empty')
      await target.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
      const counts: Record<string, number> = {}
      for (const name of tables) {
        const columns = db
          .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
          .all(name)
          .map((row) => String(row.name))
        const fields = columns.map(quote).join(',')
        const sql = `INSERT INTO ${quote(name)} (${fields}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING ${fields}`
        let count = 0
        for (const row of db.prepare(`SELECT ${fields} FROM ${quote(name)} ORDER BY rowid`).iterate()) {
          const values = columns.map((key) =>
            dates.has(key) || key === 'emailVerified' ? canonical(key, row[key]) : row[key],
          )
          const {
            rows: [saved],
          } = await target.query(sql, values)
          if (!columns.every((key) => canonical(key, row[key]) === canonical(key, saved[key])))
            throw new Error(`Value mismatch in ${name}`)
          count++
        }
        counts[name] = count
      }
      // Strictly validate deferred branch references before publishing this database.
      await target.query('SET CONSTRAINTS ALL IMMEDIATE')
      await target.query('COMMIT')
      return counts
    } catch (error) {
      await target.query('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL || !process.env.AUTH_SECRET || !process.argv[2])
    throw new Error('Expected DATABASE_URL, original AUTH_SECRET and a drained SQLite snapshot path')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  try {
    await client.connect()
    console.log('Verified rows:', await importSnapshot(process.argv[2], client, process.env.AUTH_SECRET))
  } catch (error) {
    // Driver errors can contain an offending row, including credentials or message text.
    console.error(
      'Import refused or rolled back.',
      error instanceof pg.DatabaseError ? error.code : error instanceof Error ? error.message : 'Unknown error',
    )
    process.exitCode = 1
  } finally {
    await client.end()
  }
}
