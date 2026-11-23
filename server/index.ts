import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { mountFrontend } from './static.ts'
import { createApplication } from './app.ts'
import { isLoopback, loadConfig } from './config.ts'
import { startWorker } from './worker.ts'

const config = loadConfig()
const dev = process.argv.includes('--dev')
const apiOnly = process.argv.includes('--api-only')
const serveFrontend = !process.argv.includes('--no-frontend')
if (dev && (!isLoopback(config.host) || config.origins.some((origin) => !isLoopback(new URL(origin).hostname)))) {
  throw new Error('The development server must bind to loopback')
}
const dist = resolve('dist')
const publicDir = resolve('public')
if ([dist, publicDir].some((dir) => config.dbPath === dir || config.dbPath.startsWith(dir + sep))) {
  throw new Error('DATABASE_PATH must not be inside a static directory')
}
if (!dev && serveFrontend && !existsSync(resolve(dist, 'index.html'))) throw new Error('Run npm run build before starting the server')

function instanceLock(path: string) {
  if (path === ':memory:') return () => {}
  const lock = `${path}.server.lock`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const pid = String(process.pid)
  const write = () => writeFileSync(lock, pid, { flag: 'wx', mode: 0o600 })
  try { write() } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
    throw new Error(`Database lock exists (${lock}); verify the previous instance is stopped before removing it`)
  }
  return () => { if (existsSync(lock) && readFileSync(lock, 'utf8') === pid) unlinkSync(lock) }
}

process.umask(0o077)
const release = instanceLock(config.dbPath)
process.on('exit', release)
const server = createServer({ requestTimeout: 45_000, headersTimeout: 15_000 })
const application = await createApplication(config, { dev })
const worker = apiOnly ? undefined : startWorker(config, application.db)
const { app } = application
let closeFrontend: (() => Promise<void>) | undefined

if (dev) {
  const { createServer: createVite } = await import('vite')
  const vite = await createVite({
    server: {
      middlewareMode: true, hmr: { server },
      fs: { deny: ['.env', '.env.*', '.git/**', '*.{crt,pem}', '**/.moonward/**', '**/data/**', '**/*.sqlite*', `${config.dbPath}*`] },
    },
    appType: 'spa',
  })
  app.use(vite.middlewares)
  closeFrontend = () => vite.close()
} else if (serveFrontend) {
  mountFrontend(app, dist)
}

if (config.dbPath !== ':memory:') chmodSync(config.dbPath, 0o600)
server.on('request', app)
server.listen(config.port, config.host, () => {
  console.log(`Chat is ready at ${config.origin}`)
})
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeIdleConnections()
  await application.drain()
  await closeFrontend?.()
  await closed
  await worker?.close()
  await application.close()
}
for (const name of ['SIGINT', 'SIGTERM'] as const) {
  process.once(name, () => {
    const force = setTimeout(() => process.exit(1), 8_000)
    void shutdown().then(() => { clearTimeout(force); process.exit(0) }, () => process.exit(1))
  })
}
