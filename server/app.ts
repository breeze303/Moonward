import { once } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import { z } from 'zod'
import { MAX_PASSWORD_LENGTH, MiB } from '../shared/contract.ts'
import type { AdminAccountsView, ChatEvent, Thinking, User } from '../shared/contract.ts'
import { initializeAccounts } from './accounts.ts'
import { openDb, tx, usage } from './db.ts'
import type { Config } from './config.ts'
import { HttpError } from './errors.ts'
import { GatewayStore, gatewayUpdateSchema } from './gateway.ts'
import { CatalogStore, catalogUpdateSchema } from './models.ts'
import { ChatStore } from './store.ts'
import pg from 'pg'
import { PgChats, usagePG } from './postgres/chat.ts'
import { pgAccounts } from './postgres/accounts.ts'
import { PgGateway,PgCatalog } from './postgres/settings.ts'
import { RunFeed } from './postgres/feed.ts'
import { createUpstream } from './upstream.ts'
import { decodeFiles, emailSchema, idSchema, invitationTokenSchema, limitSchema, nameSchema, passwordSchema, read, turnSchema, versionSchema } from './validation.ts'

function rateLimit(max: number, period: number) {
  const buckets = new Map<string, { count: number; until: number }>()
  let sweepAt = 0
  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now()
    if (now >= sweepAt) {
      for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key)
      sweepAt = now + period
    }
    const key = req.ip || req.socket.remoteAddress || 'unknown'
    let bucket = buckets.get(key)
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 4_096 && !bucket) return next(new HttpError(429, 'rate_limited'))
      bucket = { count: 0, until: now + period }
      buckets.set(key, bucket)
    }
    if (++bucket.count > max) return next(new HttpError(429, 'rate_limited'))
    next()
  }
}

const id = (req: Request) => read(idSchema, req.params.id)
const userId = (req: Request) => read(z.string().min(1).max(128), req.params.id)
const smallJson = express.json({ limit: '32kb' })
const userCreateSchema = z.strictObject({ email: emailSchema, name: nameSchema, password: passwordSchema, limit: limitSchema.optional() })
const userPatchSchema = userCreateSchema.partial().extend({ disabled: z.boolean().optional() }).refine((patch) => Object.keys(patch).length > 0)

async function write(res: Response, event: ChatEvent, signal?: AbortSignal) {
  if (res.destroyed || res.writableEnded) return
  if (!res.write(`data: ${JSON.stringify(event)}\n\n`) && signal) {
    await once(res, 'drain', { signal })
  }
}

export async function createApplication(config: Config, options: { db?: DatabaseSync; dev?: boolean } = {}) {
  const db = options.db ?? openDb(config.dbPath)
  const accounts = await initializeAccounts(config, db)
  const store = new ChatStore(db)
  const gateway = new GatewayStore(db, config)
  const catalog = new CatalogStore(db)
  tx(db, () => { gateway.bootstrap(); catalog.bootstrap(config.legacyModels) })
  return {...await routes(config,options,{db,accounts,store,gateway,catalog}),db,accounts}
}

export async function createPgApplication(config:Config,url:string){
  const db=new pg.Pool({connectionString:url}),feed=new RunFeed(url)
  db.on('error',()=>console.error('[postgres] idle connection lost'))
  try {
    const accounts=await pgAccounts(config,db)
    await feed.start()
    return {...await routes(config,{},{db,accounts,store:new PgChats(db),gateway:new PgGateway(db,config),catalog:new PgCatalog(db),feed}),db,accounts}
  }catch(e){await feed.close();await db.end();throw e}
}

async function routes(config:Config,options:{dev?:boolean},{db,accounts,store,gateway,catalog,feed}:{
  db: DatabaseSync|pg.Pool; accounts:Awaited<ReturnType<typeof initializeAccounts>>|Awaited<ReturnType<typeof pgAccounts>>;
  store:ChatStore|PgChats;gateway:GatewayStore|PgGateway;catalog:CatalogStore|PgCatalog;feed?:RunFeed
}){
  let needsSetup = !await accounts.hasAdmin()
  const quota=(owner:string|null)=>db instanceof pg.Pool?usagePG(db,owner):usage(db,owner)
  const upstream = createUpstream(() => {throw new Error('Missing request destination')}, config.allowLoopbackGateway)
  const subscriptions = new Map<AbortController, string>()
  const disconnectUser = (id: string) => {
    for (const [subscription, owner] of subscriptions) if (owner === id) subscription.abort()
  }
  if(feed)feed.onRevoke=id=>{if(id)disconnectUser(id);else for(const ctrl of subscriptions.keys())ctrl.abort()}
  let draining = false
  // Share only overlapping validations of an identical session. Never retain a successful
  // result across requests: revocation must be visible on the next lookup.
  const validating=new Map<string,Promise<User>>()
  const requireUser = (req: Request) => {
    const key=req.headers.cookie
    if(!feed||!key)return accounts.requireUser(fromNodeHeaders(req.headers))
    const pending=validating.get(key);if(pending)return pending
    const result=accounts.requireUser(fromNodeHeaders(req.headers)).finally(()=>validating.delete(key));validating.set(key,result);return result
  }
  const requireAdmin = async (req: Request) => {
    const user = await requireUser(req)
    if (user.role !== 'admin') throw new HttpError(403, 'forbidden')
    return user
  }

  const app = express()
  app.disable('x-powered-by')
  app.enable('case sensitive routing')
  if (config.trustProxy) app.set('trust proxy', config.trustProxy)
  app.use((_req, res, next) => {
    const script = options.dev ? "'self' 'unsafe-inline'" : "'self'"
    const connect = options.dev ? "'self' ws: wss:" : "'self'"
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'self'; script-src ${script}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    })
    if (config.secure) res.set('Strict-Transport-Security', 'max-age=31536000')
    next()
  })
  app.get('/healthz', async (_req, res) => { if(db instanceof pg.Pool)await db.query('SELECT id FROM site_settings WHERE id=1');res.json({ ok: true }) })
  const origins = new Map(config.origins.map((origin) => [new URL(origin).host, origin]))
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    const origin = origins.get(req.get('Host')?.toLowerCase() || '')
    if (!origin || (!['GET', 'HEAD'].includes(req.method) && req.get('Origin') !== origin)) {
      throw new HttpError(403, 'invalid_origin')
    }
    res.locals.origin = origin
    next()
  })

  const authHandler = toNodeHandler(accounts.auth)
  const loginLimit = rateLimit(20, 60_000)
  app.post('/api/auth/sign-in/email', loginLimit, smallJson, async (req, res) => {
    const { email, password } = read(z.object({ email: emailSchema, password: z.string().min(1).max(MAX_PASSWORD_LENGTH) }).strict(), req.body)
    const cookies = await accounts.signIn(email, password, fromNodeHeaders(req.headers))
    for (const cookie of cookies) res.append('Set-Cookie', cookie)
    res.json({ ok: true })
  })
  app.post('/api/auth/sign-out', loginLimit, authHandler)
  app.use('/api/auth', (_req, _res, next) => next(new HttpError(404, 'not_found')))

  const registrationLimit = rateLimit(18, 60_000)
  app.post('/api/setup', rateLimit(8, 60_000), smallJson, async (req, res) => {
    if (!needsSetup || await accounts.hasAdmin()) throw new HttpError(409, 'admin_exists')
    const { email, name, password } = read(z.strictObject({
      email: emailSchema, name: nameSchema, password: passwordSchema,
    }), req.body)
    await accounts.createAdmin(email, name, password)
    needsSetup = false
    res.status(201).json({ ok: true })
  })
  app.post('/api/invite/inspect', registrationLimit, smallJson, async (req, res) => {
    const { token } = read(z.object({ token: invitationTokenSchema }).strict(), req.body)
    res.json(await accounts.inspectInvite(token))
  })
  app.post('/api/invite/redeem', registrationLimit, smallJson, async (req, res) => {
    const { token, name, password } = read(z.object({ token: invitationTokenSchema, name: nameSchema, password: passwordSchema }).strict(), req.body)
    await accounts.redeem(token, name, password)
    res.status(201).json({ ok: true })
  })
  app.get('/api/me', async (req, res) => {
    if (needsSetup) {
      if (!await accounts.hasAdmin()) throw new HttpError(401, 'setup_required')
      needsSetup = false
    }
    res.json(await requireUser(req))
  })
  app.get('/api/models', async (req, res) => {
    await requireUser(req)
    const destination = await gateway.connection()
    const models = destination.apiKey ? await catalog.available(await upstream.modelIds(false, destination)) : []
    res.json(models.map(({ enabled: _enabled, summary: _summary, ...model }) => model))
  })

  app.get('/api/admin', async (req, res) => {
    await requireAdmin(req)
    const capacity=db instanceof pg.Pool?(await db.query('SELECT running_limit AS running,waiting_limit AS waiting FROM site_settings WHERE id=1')).rows[0] as AdminAccountsView['capacity']:undefined
    res.json({ users: await accounts.list(), site: await quota(null), defaultUserLimit: config.userLimit,capacity } satisfies AdminAccountsView)
  })
  app.patch('/api/admin/capacity',smallJson,async(req,res)=>{
    await requireAdmin(req);if(!(db instanceof pg.Pool))throw new HttpError(404,'not_found')
    const v=read(z.strictObject({running:z.number().int().min(1).max(1000).optional(),waiting:z.number().int().min(0).max(10000).optional()}).refine(v=>v.running!==undefined||v.waiting!==undefined),req.body)
    res.json((await db.query('UPDATE site_settings SET running_limit=coalesce($1,running_limit),waiting_limit=coalesce($2,waiting_limit) WHERE id=1 RETURNING running_limit AS running,waiting_limit AS waiting',[v.running,v.waiting])).rows[0])
  })
  app.get('/api/admin/gateway', async (req, res) => {
    await requireAdmin(req)
    res.json(await gateway.read())
  })
  app.put('/api/admin/gateway', rateLimit(12, 60_000), smallJson, async (req, res) => {
    await requireAdmin(req)
    const destination = await gateway.prepare(read(gatewayUpdateSchema, req.body))
    await upstream.probe(destination)
    res.json(await gateway.save(destination))
  })
  app.get('/api/admin/models', async (req, res) => {
    await requireAdmin(req)
    res.json(await catalog.read())
  })
  app.get('/api/admin/models/available', rateLimit(20, 60_000), async (req, res) => {
    await requireAdmin(req)
    res.json([...await upstream.modelIds(req.query.refresh === '1',await gateway.connection())].sort())
  })
  app.put('/api/admin/models', smallJson, async (req, res) => {
    await requireAdmin(req)
    const { version, selection } = read(catalogUpdateSchema, req.body)
    res.json(await catalog.save(version, selection))
  })
  app.post('/api/admin/invitations', smallJson, async (req, res) => {
    const admin = await requireAdmin(req)
    const { email } = read(z.object({ email: emailSchema }).strict(), req.body)
    res.status(201).json(await accounts.invite(admin.id, email, res.locals.origin))
  })
  app.patch('/api/admin/site', smallJson, async (req, res) => {
    await requireAdmin(req)
    const { limit } = read(z.object({ limit: limitSchema }).strict(), req.body)
    if(db instanceof pg.Pool)await db.query('UPDATE site_settings SET daily_limit=$1 WHERE id=1',[limit]);else db.prepare('UPDATE site_settings SET daily_limit = ? WHERE id = 1').run(limit)
    res.json(await quota(null))
  })
  app.post('/api/admin/users', smallJson, async (req, res) => {
    await requireAdmin(req)
    res.status(201).json(await accounts.create(read(userCreateSchema, req.body)))
  })
  app.patch('/api/admin/users/:id', smallJson, async (req, res) => {
    await requireAdmin(req)
    const patch = read(userPatchSchema, req.body)
    const { user, sessionsRevoked } = await accounts.update(userId(req), patch)
    if (patch.disabled && store instanceof ChatStore) await store.stop(user.id, 'disabled')
    else if (sessionsRevoked) disconnectUser(user.id)
    res.json(user)
  })
  app.delete('/api/admin/users/:id', async (req, res) => {
    await requireAdmin(req)
    const target = userId(req)
    await accounts.remove(target)
    disconnectUser(target)
    res.status(204).end()
  })

  app.get('/api/chats', async (req, res) => { res.json(await store.list((await requireUser(req)).id)) })
  app.post('/api/chats', async (req, res) => { res.status(201).json(await store.create((await requireUser(req)).id)) })
  app.get('/api/chats/:id', async (req, res) => { res.json(await store.read((await requireUser(req)).id, id(req))) })
  app.patch('/api/chats/:id', smallJson, async (req, res) => {
    const user = await requireUser(req)
    const data = read(z.union([
      z.object({ version: versionSchema, title: z.string().trim().min(1).max(100) }).strict(),
      z.object({ version: versionSchema, selected: idSchema }).strict(),
    ]), req.body)
    res.json('title' in data ? await store.rename(user.id, id(req), data.version, data.title)
      : await store.select(user.id, id(req), data.version, data.selected))
  })
  app.delete('/api/chats/:id', smallJson, async (req, res) => {
    const user = await requireUser(req)
    const { version } = read(z.object({ version: versionSchema }).strict(), req.body)
    await store.remove(user.id, id(req), version)
    res.status(204).end()
  })
  app.get('/api/files/:id', async (req, res) => {
    const file = await store.getFile((await requireUser(req)).id, id(req))
    if (!(file.mime.startsWith('image/') && req.query.inline === '1')) res.attachment(file.name)
    res.type(file.mime).set('Content-Security-Policy', 'sandbox').send(Buffer.from(file.bytes))
  })
  app.post('/api/chats/:id/stop', async (req, res) => {
    const user = await requireUser(req)
    const chat = await store.read(user.id, id(req))
    if (chat.activeRunId) {
      await store.stop(user.id, 'stopped', chat.id)
      const until = Date.now() + 1_000
      while (!draining && !res.destroyed && Date.now() < until && (store instanceof PgChats ? (await store.read(user.id,chat.id)).activeRunId : store.progress(chat.activeRunId, user.id)?.status === 'streaming')) {
        await sleep(60)
      }
    }
    res.json({ chat: await store.read(user.id, chat.id), usage: await quota(user.id) })
  })

  app.post('/api/runs', async (req, res, next) => {
    res.locals.user = await requireUser(req)
    next()
  }, express.json({ limit: 15 * MiB }), async (req, res) => {
    const user = res.locals.user as User
    const requested = read(turnSchema, req.body)
    if(store instanceof ChatStore)store.read(user.id, requested.chatId)
    const destination = await gateway.connection()
    const model = (await catalog.available(await upstream.modelIds(false, destination))).find((item) => item.id === requested.model)
    if (!model) throw new HttpError(400, 'model_unavailable')
    if ((requested.effort && !model.efforts.includes(requested.effort)) || (requested.web && !model.web)) throw new HttpError(400, 'model_feature')
    const turn = { ...requested, effort: requested.effort ?? model.defaultEffort ?? undefined }
    if (res.destroyed) return
    if (draining) throw new HttpError(503, 'unavailable')
    const receipt = await store.reserve(user.id, turn, model, decodeFiles(turn.files || []), destination.version)
    res.status(202).json(receipt)
  })

  app.get('/api/runs/:id/events', async (req, res) => {
    const user = await requireUser(req)
    const runId = id(req)
    if(store instanceof PgChats && feed){
      if(draining)throw new HttpError(503,'unavailable')
      if(subscriptions.size>=4096)throw new HttpError(429,'site_busy')
      const ctrl=new AbortController(),lost=()=>ctrl.abort();subscriptions.set(ctrl,user.id);res.once('close',lost)
      try {await feed.follow(store,runId,user.id,ctrl.signal,async event=>{
        if(!res.headersSent)res.set({'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no'})
        await write(res,event,ctrl.signal)
      },()=>{if(!res.destroyed&&!res.writableNeedDrain)res.write(': keepalive\n\n')})}
      finally {subscriptions.delete(ctrl);res.off('close',lost);if(!res.destroyed){if(res.headersSent)res.end();else if(ctrl.signal.aborted)res.destroy()}}
      return
    }
    if(!(store instanceof ChatStore))throw new HttpError(503,'unavailable')
    const initial = store.progress(runId, user.id)
    if (!initial) throw new HttpError(404, 'not_found')
    if (draining) throw new HttpError(503, 'unavailable')
    if (subscriptions.size >= 128 || [...subscriptions.values()].filter((owner) => owner === user.id).length >= 8) {
      throw new HttpError(429, 'site_busy')
    }
    const downstream = new AbortController()
    const signal = downstream.signal
    const lost = () => downstream.abort()
    subscriptions.set(downstream, user.id)
    res.once('close', lost)
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' })
    try {
      res.flushHeaders()
      const chat = await store.read(user.id, initial.chatId)
      const reply = chat.messages.find((message) => message.id === initial.assistantId)
      let content = reply?.content ?? ''
      let thinking = initial.thinking
      let heartbeat = Date.now()
      await write(res, { type: 'start', chat }, signal)
      while (!signal.aborted) {
        const current = store.progress(runId, user.id)
        if (!current) { await write(res, { type: 'error', code: 'not_found' }, signal); break }
        if (current.error === 'disabled') { await write(res, { type: 'error', code: 'disabled' }, signal); break }
        if (current.content !== content && current.status !== 'stopped') {
          await write(res, current.content.startsWith(content)
            ? { type: 'delta', content: current.content.slice(content.length) }
            : { type: 'replace', content: current.content }, signal)
          content = current.content
        }
        if (current.status !== 'streaming') {
          await write(res, { type: 'done', chat: await store.read(user.id, current.chatId), usage: await quota(user.id) }, signal)
          break
        }
        if (current.thinking && current.thinking !== thinking) {
          thinking = current.thinking
          await write(res, { type: 'thinking', thinking: JSON.parse(thinking) as Thinking }, signal)
        }
        const now = Date.now()
        if (now - heartbeat >= 12_000 && !res.writableNeedDrain) {
          heartbeat = now
          res.write(': keepalive\n\n')
        }
        await sleep(60, undefined, { signal })
      }
    } catch {
      if (!signal.aborted) await write(res, { type: 'error', code: 'interrupted' }).catch(() => {})
    } finally {
      subscriptions.delete(downstream)
      res.off('close', lost)
      if (!res.destroyed) res.end()
    }
  })

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found')))
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(new Error('Response failed'))
    if (error instanceof HttpError) {if(error.code==='queue_full')res.set('Retry-After','5');return res.status(error.status).json({ code: error.code })}
    if (error && typeof error === 'object' && 'type' in error) {
      if (error.type === 'entity.too.large') return res.status(413).json({ code: 'payload_too_large' })
      if (error.type === 'entity.parse.failed') return res.status(400).json({ code: 'invalid_input' })
    }
    console.error('Request failed (internal_error)')
    res.status(500).json({ code: 'internal_error' })
  })

  const drain = async () => {
    draining = true
    for (const subscriber of subscriptions.keys()) subscriber.abort()
  }
  return { app, db, accounts, drain, async close() {
    await drain()
    await upstream.close()
    await feed?.close();if(db instanceof pg.Pool)await db.end();else db.close()
  } }
}
