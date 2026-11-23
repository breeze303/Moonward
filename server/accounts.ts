import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../shared/contract.ts'
import type { AdminUser, AdminUserInput, AdminUserPatch, User } from '../shared/contract.ts'
import type { Config } from './config.ts'
import { all, get, migrateApp, tx, usage } from './db.ts'
import { HttpError } from './errors.ts'
import type { Pool } from 'pg'

const dayMs = 86_400_000
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

type Profile = Omit<AdminUser, 'usage' | 'disabled'> & { disabled: number }
type Invitation = { email: string; expires_at: number }

export function siteAuth(config: Config, db: DatabaseSync | Pool) {
  return betterAuth({
    database: db,
    baseURL: config.origin,
    trustedOrigins: config.origins,
    secret: config.secret,
    emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: MIN_PASSWORD_LENGTH, maxPasswordLength: MAX_PASSWORD_LENGTH },
    session: { expiresIn: 7 * 86_400, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: config.secure, defaultCookieAttributes: { sameSite: 'lax', httpOnly: true } },
    // Rate limits are applied by the HTTP layer using its trusted proxy configuration.
    rateLimit: { enabled: false },
    logger: { disabled: true },
  })
}

export async function initializeAccounts(config: Config, db: DatabaseSync) {
  const auth = siteAuth(config, db)
  const migrations = await getMigrations(auth.options)
  await migrations.runMigrations()
  migrateApp(db, config.siteLimit)
  const { password: passwordService, generateId } = await auth.$context
  const hasAdmin = () => Boolean(get(db, "SELECT 1 FROM profiles WHERE role = 'admin' LIMIT 1"))

  const lookup = (id: string) => get<Profile>(db, `
    SELECT p.id, p.role, p.disabled, u.name, u.email FROM profiles AS p JOIN "user" AS u ON u.id = p.id WHERE p.id = ?
  `, id)
  const view = ({ disabled, ...profile }: Profile): AdminUser => ({
    ...profile, disabled: Boolean(disabled), usage: usage(db, profile.id),
  })
  const credential = (email: string) => get<{ id: string; hash: string }>(db, `
    SELECT u.id, a.password AS hash FROM "user" AS u JOIN "account" AS a ON a."userId" = u.id
    WHERE u.email = ? AND a."providerId" = 'credential' AND a."accountId" = u.id AND a.password IS NOT NULL
  `, email)
  const assertEmailAvailable = (email: string, id = '') => {
    if (get(db, 'SELECT 1 FROM "user" WHERE email = ? AND id <> ?', email, id)) throw new HttpError(409, 'email_exists')
  }
  const pendingInvite = (hash: string) => {
    const row = get<Invitation>(db, 'SELECT email, expires_at FROM invitations WHERE token_hash = ? AND expires_at > ? AND redeemed_at IS NULL', hash, Date.now())
    if (!row) throw new HttpError(404, 'invite_invalid')
    return row
  }
  const requireUser = async (headers: Headers): Promise<User> => {
    const session = await auth.api.getSession({ headers })
    if (!session) throw new HttpError(401, 'unauthenticated')
    const profile = lookup(session.user.id)
    if (!profile || profile.disabled) throw new HttpError(403, 'disabled')
    const { disabled: _, ...user } = view(profile)
    return user
  }

  // Call inside a synchronous SQLite transaction so identity, credentials and profile commit together.
  function provision(email: string, name: string, hash: string, role: User['role'], limit = config.userLimit) {
    assertEmailAvailable(email)
    const id = generateId({ model: 'user' }) || randomUUID()
    const accountId = generateId({ model: 'account' }) || randomUUID()
    const now = new Date().toISOString()
    db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, ?, ?)')
      .run(id, name, email, now, now)
    db.prepare(`INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
      VALUES (?, ?, 'credential', ?, ?, ?, ?)`).run(accountId, id, id, hash, now, now)
    db.prepare('INSERT INTO profiles (id, role, daily_limit) VALUES (?, ?, ?)').run(id, role, limit)
    return id
  }

  return {
    auth,
    hasAdmin,
    requireUser,
    signIn: async (email: string, password: string, headers: Headers) => {
      const before = credential(email)
      const result = await auth.api.signInEmail({ body: { email, password }, headers, returnHeaders: true }).catch((error: unknown) => {
        if (error instanceof APIError && [400, 401].includes(error.statusCode)) throw new HttpError(401, 'invalid_credentials')
        throw error
      })
      const profile = lookup(result.response.user.id)
      if (!profile || profile.disabled) {
        db.prepare('DELETE FROM "session" WHERE token = ?').run(result.response.token)
        throw new HttpError(403, 'disabled')
      }
      // Resetting credentials while a sign-in is hashing must invalidate the new session too.
      const after = credential(email)
      if (before?.id !== profile.id || after?.id !== profile.id || before.hash !== after.hash) {
        db.prepare('DELETE FROM "session" WHERE token = ?').run(result.response.token)
        throw new HttpError(401, 'invalid_credentials')
      }
      return result.headers.getSetCookie()
    },
    createAdmin: async (email: string, name: string, password: string) => {
      const hash = await passwordService.hash(password)
      return tx(db, () => {
        if (hasAdmin()) throw new HttpError(409, 'admin_exists')
        return provision(email, name, hash, 'admin')
      })
    },
    create: async ({ email, name, password, limit }: AdminUserInput) => {
      const hash = await passwordService.hash(password)
      return tx(db, () => {
        const id = provision(email, name, hash, 'user', limit)
        db.prepare('DELETE FROM invitations WHERE email = ? AND redeemed_at IS NULL').run(email)
        return view(lookup(id)!)
      })
    },
    invite: (admin: string, email: string, origin: string) => tx(db, () => {
      assertEmailAvailable(email)
      const token = randomBytes(32).toString('base64url')
      const expiresAt = Date.now() + dayMs
      db.prepare('DELETE FROM invitations WHERE email = ? OR expires_at <= ?').run(email, Date.now())
      db.prepare('INSERT INTO invitations (token_hash, email, expires_at, created_by) VALUES (?, ?, ?, ?)')
        .run(tokenHash(token), email, expiresAt, admin)
      // The fragment keeps the credential out of access logs and referrer headers.
      return { url: `${origin}/#invite=${token}`, expiresAt }
    }),
    inspectInvite: (token: string) => {
      const row = pendingInvite(tokenHash(token))
      return { email: row.email, expiresAt: row.expires_at }
    },
    redeem: async (token: string, name: string, password: string) => {
      const hash = tokenHash(token)
      pendingInvite(hash)
      try {
        const passwordHash = await passwordService.hash(password)
        tx(db, () => {
          const { email } = pendingInvite(hash)
          provision(email, name, passwordHash, 'user')
          db.prepare('UPDATE invitations SET redeemed_at = ? WHERE token_hash = ?').run(Date.now(), hash)
        })
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(500, 'signup_failed')
      }
    },
    list: () => all<Profile>(db, `
      SELECT p.id, p.role, p.disabled, u.name, u.email FROM profiles AS p JOIN "user" AS u ON u.id = p.id
      ORDER BY p.role, LOWER(u.name), u.email
    `).map(view),
    update: async (id: string, patch: AdminUserPatch) => {
      const hash = patch.password === undefined ? undefined : await passwordService.hash(patch.password)
      return tx(db, () => {
        const profile = lookup(id)
        if (!profile) throw new HttpError(404, 'not_found')
        if (patch.disabled && profile.role === 'admin') throw new HttpError(400, 'cannot_disable_admin')
        const email = patch.email ?? profile.email
        const emailChanged = email !== profile.email
        if (emailChanged) {
          assertEmailAvailable(email, id)
          db.prepare('DELETE FROM invitations WHERE email IN (?, ?) AND redeemed_at IS NULL').run(profile.email, email)
        }
        const now = new Date().toISOString()
        if (emailChanged || patch.name !== undefined) {
          db.prepare(`UPDATE "user" SET name = ?, email = ?, "emailVerified" = CASE WHEN ? THEN 0 ELSE "emailVerified" END,
            "updatedAt" = ? WHERE id = ?`).run(patch.name ?? profile.name, email, Number(emailChanged), now, id)
        }
        if (hash !== undefined) {
          const result = db.prepare(`UPDATE "account" SET password = ?, "updatedAt" = ?
            WHERE "userId" = ? AND "accountId" = ? AND "providerId" = 'credential'`).run(hash, now, id, id)
          if (result.changes !== 1) throw new HttpError(409, 'credential_missing')
        }
        if (patch.limit !== undefined) db.prepare('UPDATE profiles SET daily_limit = ? WHERE id = ?').run(patch.limit, id)
        if (patch.disabled !== undefined) {
          db.prepare('UPDATE profiles SET disabled = ? WHERE id = ?').run(Number(patch.disabled), id)
        }
        const sessionsRevoked = emailChanged || hash !== undefined || patch.disabled === true
        if (sessionsRevoked) db.prepare('DELETE FROM "session" WHERE "userId" = ?').run(id)
        return { user: view(lookup(id)!), sessionsRevoked }
      })
    },
    remove: (id: string) => tx(db, () => {
      const profile = lookup(id)
      if (!profile) throw new HttpError(404, 'not_found')
      if (profile.role === 'admin') throw new HttpError(400, 'cannot_delete_admin')
      db.prepare('DELETE FROM invitations WHERE created_by = ? OR email = ?').run(id, profile.email)
      // Cascades remove sessions, chats and jobs. The worker aborts when it loses its job lease.
      db.prepare('DELETE FROM "user" WHERE id = ?').run(id)
    }),
  }
}
