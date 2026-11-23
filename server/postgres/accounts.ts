import { randomUUID, randomBytes, createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { APIError } from 'better-auth/api'
import { siteAuth } from '../accounts.ts'
import type { Config } from '../config.ts'
import { HttpError } from '../errors.ts'
import { usagePG } from './chat.ts'
import { disableJobs, transaction } from './queue.ts'
import type { AdminUser, AdminUserInput, AdminUserPatch } from '../../shared/contract.ts'

const hashToken = (s: string) => createHash('sha256').update(s).digest('hex')
export async function pgAccounts(config: Config, db: Pool) {
  const auth = siteAuth(config, db),
    { password } = await auth.$context
  const hasAdmin = async (c: Pool | PoolClient = db) =>
    !!(await c.query("SELECT 1 FROM profiles WHERE role='admin' LIMIT 1")).rowCount
  async function profile(id: string, c: Pool | PoolClient = db): Promise<AdminUser> {
    const {
      rows: [r],
    } = await c.query(
      'SELECT u.id,u.name,u.email,p.role,p.disabled FROM profiles p JOIN "user" u USING(id) WHERE u.id=$1',
      [id],
    )
    if (!r) throw new HttpError(404, 'not_found')
    return { ...r, disabled: !!r.disabled, usage: await usagePG(c, id) } as AdminUser
  }
  async function mutation<T>(body: (c: PoolClient) => Promise<T>) {
    return transaction(db, async (c) => {
      await c.query('SELECT id FROM site_settings WHERE id=1 FOR UPDATE')
      return body(c)
    })
  }
  async function checkEmail(c: PoolClient, email: string, id = '') {
    if ((await c.query('SELECT 1 FROM "user" WHERE email=$1 AND id<>$2', [email, id])).rowCount)
      throw new HttpError(409, 'email_exists')
  }
  async function provision(
    c: PoolClient,
    email: string,
    name: string,
    hash: string,
    role: string,
    limit = config.userLimit,
  ) {
    await checkEmail(c, email)
    const id = randomUUID()
    await c.query('INSERT INTO "user"(id,email,name) VALUES($1,$2,$3)', [id, email, name])
    await c.query(
      `INSERT INTO account(id,"accountId","userId","providerId",password) VALUES($1,$2,$2,'credential',$3)`,
      [randomUUID(), id, hash],
    )
    await c.query('INSERT INTO profiles(id,role,daily_limit) VALUES($1,$2,$3)', [id, role, limit])
    return id
  }
  async function inviteRow(token: string, c: Pool | PoolClient = db) {
    const {
      rows: [r],
    } = await c.query(
      'SELECT email,expires_at::float8 AS "expiresAt" FROM invitations WHERE token_hash=$1 AND expires_at>$2 AND redeemed_at IS NULL',
      [hashToken(token), Date.now()],
    )
    if (!r) throw new HttpError(404, 'invite_invalid')
    return r
  }
  return {
    auth,
    hasAdmin,
    async requireUser(headers: Headers) {
      const session = await auth.api.getSession({ headers })
      if (!session) throw new HttpError(401, 'unauthenticated')
      const { disabled, ...u } = await profile(session.user.id)
      if (disabled) throw new HttpError(403, 'disabled')
      return u
    },
    async signIn(email: string, pw: string, headers: Headers) {
      const credential = async () =>
        (
          await db.query(
            `SELECT u.id,a.password FROM "user" u JOIN account a ON a."userId"=u.id WHERE u.email=$1 AND a."providerId"='credential'`,
            [email],
          )
        ).rows[0]
      const before = await credential(),
        result = await auth.api
          .signInEmail({ body: { email, password: pw }, headers, returnHeaders: true })
          .catch((e: unknown) => {
            if (e instanceof APIError && [400, 401].includes(e.statusCode))
              throw new HttpError(401, 'invalid_credentials')
            throw e
          })
      const after = await credential(),
        p = await profile(result.response.user.id)
      if (
        !before ||
        !after ||
        before.id !== p.id ||
        after.id !== p.id ||
        before.password !== after.password ||
        p.disabled
      ) {
        await db.query('DELETE FROM session WHERE token=$1', [result.response.token])
        throw new HttpError(p.disabled ? 403 : 401, p.disabled ? 'disabled' : 'invalid_credentials')
      }
      return result.headers.getSetCookie()
    },
    async createAdmin(email: string, name: string, pw: string) {
      const hash = await password.hash(pw)
      return mutation(async (c) => {
        if (await hasAdmin(c)) throw new HttpError(409, 'admin_exists')
        return provision(c, email, name, hash, 'admin')
      })
    },
    async create(u: AdminUserInput) {
      const hash = await password.hash(u.password)
      return mutation(async (c) => {
        const id = await provision(c, u.email, u.name, hash, 'user', u.limit)
        await c.query('DELETE FROM invitations WHERE email=$1 AND redeemed_at IS NULL', [u.email])
        return profile(id, c)
      })
    },
    async list() {
      const { rows } = await db.query(
        'SELECT u.id FROM "user" u JOIN profiles p USING(id) ORDER BY role,lower(name),email',
      )
      return Promise.all(rows.map((r) => profile(r.id)))
    },
    async invite(admin: string, email: string, origin: string) {
      return mutation(async (c) => {
        await checkEmail(c, email)
        const token = randomBytes(32).toString('base64url'),
          expiresAt = Date.now() + 86400000
        await c.query('DELETE FROM invitations WHERE email=$1 OR expires_at<=$2', [email, Date.now()])
        await c.query('INSERT INTO invitations(token_hash,email,expires_at,created_by) VALUES($1,$2,$3,$4)', [
          hashToken(token),
          email,
          expiresAt,
          admin,
        ])
        return { url: `${origin}/#invite=${token}`, expiresAt }
      })
    },
    inspectInvite: inviteRow,
    async redeem(token: string, name: string, pw: string) {
      await inviteRow(token)
      const hash = await password.hash(pw)
      await mutation(async (c) => {
        const r = await inviteRow(token, c)
        await provision(c, r.email, name, hash, 'user')
        await c.query('UPDATE invitations SET redeemed_at=$2 WHERE token_hash=$1', [hashToken(token), Date.now()])
      })
    },
    async update(id: string, patch: AdminUserPatch) {
      const hash = patch.password === undefined ? undefined : await password.hash(patch.password)
      return mutation(async (c) => {
        const p = await profile(id, c)
        if (p.role === 'admin' && patch.disabled) throw new HttpError(400, 'cannot_disable_admin')
        const email = patch.email ?? p.email,
          changed = email !== p.email
        if (changed) {
          await checkEmail(c, email, id)
          await c.query('DELETE FROM invitations WHERE email IN ($1,$2) AND redeemed_at IS NULL', [p.email, email])
        }
        await c.query(
          'UPDATE "user" SET name=$2,email=$3,"emailVerified"=CASE WHEN $4 THEN false ELSE "emailVerified" END,"updatedAt"=now() WHERE id=$1',
          [id, patch.name ?? p.name, email, changed],
        )
        if (
          hash &&
          !(
            await c.query(
              `UPDATE account SET password=$2,"updatedAt"=now() WHERE "userId"=$1 AND "accountId"=$1 AND "providerId"='credential'`,
              [id, hash],
            )
          ).rowCount
        )
          throw new HttpError(409, 'credential_missing')
        await c.query(
          'UPDATE profiles SET daily_limit=coalesce($2,daily_limit),disabled=coalesce($3,disabled) WHERE id=$1',
          [id, patch.limit, patch.disabled === undefined ? null : Number(patch.disabled)],
        )
        const sessionsRevoked = changed || !!hash || patch.disabled === true
        if (patch.disabled === true) await disableJobs(c, id)
        if (sessionsRevoked) {
          await c.query('DELETE FROM session WHERE "userId"=$1', [id])
          await c.query("SELECT pg_notify('moonward_revoke',$1)", [id])
        }
        return { user: await profile(id, c), sessionsRevoked }
      })
    },
    async remove(id: string) {
      await mutation(async (c) => {
        const p = await profile(id, c)
        if (p.role === 'admin') throw new HttpError(400, 'cannot_delete_admin')
        await c.query('DELETE FROM invitations WHERE email=$1 OR created_by=$2', [p.email, id])
        await c.query('DELETE FROM "user" WHERE id=$1', [id])
        await c.query("SELECT pg_notify('moonward_revoke',$1)", [id])
      })
    },
  }
}
