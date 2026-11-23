import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup } from 'node:sqlite'
import pg from 'pg'
import { importSnapshot } from '../server/postgres/import.ts'
import { pgAccounts } from '../server/postgres/accounts.ts'
import { PgGateway } from '../server/postgres/settings.ts'
import { BrowserlessClient, startSite, adminEmail, mockKey } from './support.ts'

test(
  'SQLite import keeps the existing signed session and refuses to merge or decrypt with the wrong secret',
  {
    skip: !process.env.MOONWARD_TEST_ADMIN_DATABASE_URL,
  },
  async () => {
    const dbName = 'import_' + randomUUID().replaceAll('-', ''),
      url = new URL(process.env.MOONWARD_TEST_ADMIN_DATABASE_URL!)
    const admin = new pg.Client({ connectionString: url.href })
    url.pathname = '/' + dbName
    const target = new pg.Client({ connectionString: url.href }),
      pool = new pg.Pool({ connectionString: url.href })
    const dir = await mkdtemp(join(tmpdir(), 'moonward-import-')),
      snapshot = join(dir, 'backup.sqlite')
    const site = await startSite('https://example.test', { worker: false }),
      client = new BrowserlessClient(site.origin)
    try {
      await client.login()
      await backup(site.db, snapshot)
      await admin.connect()
      await admin.query(`CREATE DATABASE ${dbName}`)
      await target.connect()
      await assert.rejects(importSnapshot(snapshot, target, randomUUID()))
      assert.equal((await target.query("SELECT to_regclass('profiles') AS t")).rows[0].t, null)
      const counts = await importSnapshot(snapshot, target, site.config.secret)
      assert.equal(counts.user, 1)
      assert.equal(counts.session, 1)
      const user = await (await pgAccounts(site.config, pool)).requireUser(new Headers({ cookie: client.cookie }))
      assert.equal(user.email, adminEmail)
      assert.equal(user.role, 'admin')
      assert.equal((await new PgGateway(pool, site.config).connection()).apiKey, mockKey)
      await assert.rejects(importSnapshot(snapshot, target, site.config.secret), /empty/)
    } finally {
      await site.shutdown()
      await target.end()
      await pool.end()
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`)
      } finally {
        await admin.end()
        await rm(dir, { recursive: true, force: true })
      }
    }
  },
)
