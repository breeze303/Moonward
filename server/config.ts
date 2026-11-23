import { resolve } from 'node:path'
import { z } from 'zod'
import { DEFAULT_MODEL_LIMITS, MAX_MODELS } from '../shared/contract.ts'
import type { ModelConfig } from '../shared/contract.ts'
import { effortsSchema, modelIdSchema } from './validation.ts'

const modelsSchema = z.record(z.string(), z.object({
  vision: z.boolean().default(false),
  files: z.boolean().default(false),
  web: z.boolean().default(false),
  efforts: effortsSchema.default([]),
}).strict())

const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopback(host: string) {
  return loopback.has(host) || host === '::1'
}

function httpUrl(raw: string, name: string) {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed on loopback only)`)
  }
  return url
}

function appUrl(raw: string, name: string) {
  const url = httpUrl(raw, name)
  if (url.pathname !== '/') throw new Error(`${name} must not include a path`)
  return url
}

function int(raw: string | undefined, fallback: number, min: number, max: number, name: string) {
  const n = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`)
  return n
}

function legacyModels(env: NodeJS.ProcessEnv): ModelConfig[] {
  if (!env.OPENAI_MODELS && !env.OPENAI_MODEL_CAPABILITIES && !env.OPENAI_API_KEY?.trim()) return []
  const ids = [...new Set((env.OPENAI_MODELS || 'gpt-6.2-sol').split(',').map((id) => id.trim()).filter(Boolean))]
  if (!ids.length || ids.length > MAX_MODELS || ids.some((id) => !modelIdSchema.safeParse(id).success)) {
    throw new Error('OPENAI_MODELS must be a comma-separated list of model IDs')
  }
  const caps = modelsSchema.parse(JSON.parse(env.OPENAI_MODEL_CAPABILITIES || '{}'))
  return ids.map((id) => ({
    id, label: id, enabled: true, defaultEffort: null, summary: false, limits: DEFAULT_MODEL_LIMITS,
    ...(Object.hasOwn(caps, id) ? caps[id] : id === 'gpt-6.2-sol'
      ? { vision: true, files: true, web: true, efforts: ['low', 'medium'] }
      : { vision: false, files: false, web: false, efforts: [] }),
  }))
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = int(env.PORT, 8090, 1, 65535, 'PORT')
  const origin = appUrl(env.APP_ORIGIN || `http://localhost:${port}`, 'APP_ORIGIN')
  const aliases = (env.APP_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)
    .map((value) => appUrl(value, 'APP_ALLOWED_ORIGINS'))
  if (aliases.some((url) => url.protocol !== origin.protocol)) throw new Error('All app origins must use the same protocol')
  const origins = [...new Set([origin, ...aliases].map((url) => url.origin))]
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error('Set a strong AUTH_SECRET (at least 32 characters)')
  return {
    port,
    host: env.HOST || '127.0.0.1',
    origin: origin.origin,
    origins,
    secure: origin.protocol === 'https:',
    secret: env.AUTH_SECRET,
    dbPath: env.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(env.DATABASE_PATH || 'data/chat.sqlite'),
    allowLoopbackGateway: origin.protocol === 'http:' && isLoopback(env.HOST || '127.0.0.1'),
    legacyGateway: () => ({ baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: env.OPENAI_API_KEY?.trim() || '' }),
    legacyModels: () => legacyModels(env),
    userLimit: int(env.USER_DAILY_LIMIT, 30, 0, 100_000, 'USER_DAILY_LIMIT'),
    siteLimit: int(env.SITE_DAILY_LIMIT, 200, 0, 100_000, 'SITE_DAILY_LIMIT'),
    trustProxy: env.TRUST_PROXY || '',
  }
}

export type Config = ReturnType<typeof loadConfig>
