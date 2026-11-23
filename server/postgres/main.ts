import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { loadConfig } from '../config.ts'
import { createPgApplication } from '../app.ts'
import { pgWorker } from './worker.ts'
import { mountFrontend } from '../static.ts'

process.umask(0o077)
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required; PostgreSQL mode cannot fall back to SQLite')
const config = loadConfig()
let close: () => Promise<void>
if (process.argv.includes('--worker')) {
  const pool = new pg.Pool({ connectionString: url })
  pool.on('error', () => console.error('[postgres] idle connection lost'))
  await pool.query('SELECT running_limit FROM site_settings WHERE id=1')
  const worker = pgWorker(pool, config, () => writeFileSync('/tmp/wenji-worker-ready', ''))
  close = async () => {
    await worker.close()
    await pool.end()
  }
} else {
  const app = await createPgApplication(config, url)
  mountFrontend(app.app)
  const server = createServer({ requestTimeout: 45000, headersTimeout: 15000 }, app.app)
  server.listen(config.port, config.host, () => {
    console.log(`API ready at ${config.origin}`)
  })
  close = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    await app.drain()
    await closed
    await app.close()
  }
}
let stopping = false
for (const s of ['SIGINT', 'SIGTERM'] as const)
  process.once(s, () => {
    if (stopping) return
    stopping = true
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
