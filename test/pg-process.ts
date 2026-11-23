// Child process of the isolated load probe; never read a production connection URL.
import { createServer } from 'node:http'
import pg from 'pg'
import { loadConfig } from '../server/config.ts'
import { createPgApplication } from '../server/app.ts'
import { pgWorker } from '../server/postgres/worker.ts'
import { PgChats } from '../server/postgres/chat.ts'
import { listen, closeServer } from './support.ts'

const url = process.env.MOONWARD_TEST_DATABASE_URL!
if (!process.send || !/^load_[a-f0-9]{32}$/.test(new URL(url).searchParams.get('options')?.split('=')[1] ?? ''))
  throw new Error('Expected an isolated load-test schema')
let close: () => Promise<void>
if (process.argv[2] === 'worker') {
  const pool = new pg.Pool({ connectionString: url }),
    worker = pgWorker(pool, loadConfig())
  close = async () => {
    await worker.close()
    await pool.end()
  }
  process.send('worker')
} else {
  const server = createServer(),
    backend = await listen(server, Number(process.env.MOONWARD_TEST_BACKEND_PORT || 0)),
    origin = process.env.MOONWARD_TEST_PROXY_PORT ? `http://127.0.0.1:${Number(process.env.MOONWARD_TEST_PROXY_PORT)}` : backend
  const api = await createPgApplication(loadConfig({ ...process.env, APP_ORIGIN: origin }), url)
  const durations: number[] = [],
    admissions: number[] = []
  const reserve = PgChats.prototype.reserve
  PgChats.prototype.reserve = async function (...args) {
    const begin = Date.now()
    try {
      return await reserve.apply(this, args)
    } finally {
      if (admissions.length < 200) admissions.push(Date.now() - begin)
    }
  }
  server.on('request', (req, res) => {
    if (req.url === '/api/runs' && req.method === 'POST') {
      const at = Date.now()
      res.setHeader('X-Probe-Received', String(at))
      res.once('finish', () => {
        durations.push(Date.now() - at)
        if (durations.length === 200)
          process.send?.({
            processingP95: [...durations].sort((a, b) => a - b)[189],
            admissionP95: [...admissions].sort((a, b) => a - b)[189],
          })
      })
    }
    api.app(req, res)
  })
  close = async () => {
    await api.drain()
    await closeServer(server)
    await api.close()
  }
  process.send(origin)
}
process.once(
  'disconnect',
  () =>
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    ),
)
