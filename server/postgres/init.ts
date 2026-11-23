import pg from 'pg'
import { freshSchema } from './schema.ts'
import { loadConfig } from '../config.ts'
import { transaction } from './queue.ts'

const config = loadConfig()
if (!process.env.DATABASE_URL) throw new Error('Expected a dedicated empty PostgreSQL database')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  await transaction(pool, async (c) => {
    await c.query('SET LOCAL search_path TO public')
    if (
      (
        await c.query(
          "SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S','f') LIMIT 1",
        )
      ).rowCount
    )
      throw new Error('Target must be empty')
    await c.query(await freshSchema())
    await c.query(
      'INSERT INTO gateway_settings VALUES(1,0,\'https://api.openai.com/v1\',NULL); INSERT INTO model_catalog VALUES(1,0,\'{"models":[],"defaultId":null}\')',
    )
    await c.query('INSERT INTO site_settings(id,daily_limit) VALUES(1,$1)', [config.siteLimit])
  })
} finally {
  await pool.end()
}
