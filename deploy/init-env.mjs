import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { isIPv4 } from 'node:net'

const ip = process.env.BIND_IP || '127.0.0.1'
const port = Number(process.env.PUBLISH_PORT || 18091)
if (!isIPv4(ip) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bind address or port')
function origin(value) {
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (!localHttp && url.protocol !== 'https:')) throw new Error('Expected an HTTPS origin (HTTP is allowed on loopback)')
  return url.origin
}
const site = origin(process.env.APP_ORIGIN || `http://localhost:${port}`)
const aliases = (process.env.APP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).map(origin)
if (aliases.some(s => new URL(s).protocol !== new URL(site).protocol)) throw new Error('All origins must use the same protocol')
const secret = () => randomBytes(32).toString('hex')
const config = { BIND_IP: ip, PUBLISH_PORT: port, APP_ORIGIN: site, APP_ALLOWED_ORIGINS: aliases.join(','), TRUST_PROXY: '', AUTH_SECRET: secret(), APP_DB_PASSWORD: secret(), POSTGRES_PASSWORD: secret() }
writeFileSync('.env', Object.entries(config).map(([key, value]) => `${key}=${value}\n`).join(''), { flag: 'wx', mode: 0o600 })
console.log('Created .env (0600); keep it private and back it up with the database.')
console.log(`After startup, open ${site}/setup to create the first administrator.`)
