import { existsSync, mkdirSync, chmodSync, openSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { DEFAULT_MODEL_LIMITS, MAX_MODEL_LIMITS, MIN_OUTPUT_TOKENS } from '../shared/contract.ts'
import { HttpError } from './errors.ts'

export const today = () => new Date().toISOString().slice(0, 10)
export const appSchemaVersion = 6

export function openDb(path: string) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
    chmodSync(path, 0o600)
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  return db
}

export function migrateApp(db: DatabaseSync, defaultSiteLimit: number) {
  const version = get<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version
  if (version === appSchemaVersion) return
  if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new Error('Unsupported database schema version')
  if (version === 0) tx(db, () => {
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('admin','user')),
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
        daily_limit INTEGER NOT NULL CHECK (daily_limit >= 0)
      );
      CREATE TABLE site_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        daily_limit INTEGER NOT NULL CHECK (daily_limit >= 0)
      );
      CREATE TABLE invitations (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        redeemed_at INTEGER,
        created_by TEXT NOT NULL REFERENCES profiles(id)
      );
      CREATE INDEX invitations_by_email ON invitations(email);
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        leaf_id TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX chats_owner ON chats(owner_id, updated_at);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        model TEXT,
        citations TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX messages_chat ON messages(chat_id);
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        bytes BLOB NOT NULL
      );
      CREATE INDEX attachments_chat ON attachments(chat_id);
      CREATE TABLE message_attachments (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (message_id, position)
      );
      CREATE INDEX message_attachments_attachment ON message_attachments(attachment_id);
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        assistant_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        day TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER
      );
      CREATE INDEX attempts_site_day ON attempts(day);
      CREATE INDEX attempts_owner_day ON attempts(owner_id, day);
      CREATE INDEX attempts_active ON attempts(status) WHERE status = 'streaming';
      PRAGMA user_version = 1;
    `)
    db.prepare('INSERT INTO site_settings VALUES (1, ?)').run(defaultSiteLimit)
  })
  if (version < 2) tx(db, () => {
    db.exec(`
      CREATE TABLE model_catalog (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL CHECK (version >= 0),
        selection TEXT
      );
      INSERT INTO model_catalog VALUES (1, 0, NULL);
      ALTER TABLE messages ADD COLUMN thinking TEXT;
      PRAGMA user_version = 2;
    `)
  })
  if (version < 3) tx(db, () => {
    db.exec(`
      CREATE TABLE generation_jobs (
        id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
        effort TEXT,
        web INTEGER NOT NULL CHECK (web IN (0,1)),
        summary INTEGER NOT NULL CHECK (summary IN (0,1)),
        worker_id TEXT,
        lease_until INTEGER,
        stop_reason TEXT CHECK (stop_reason IN ('stopped','disabled')),
        CHECK ((worker_id IS NULL) = (lease_until IS NULL))
      ) STRICT;
      UPDATE chats SET version = version + 1 WHERE id IN (SELECT chat_id FROM attempts WHERE status = 'streaming');
      UPDATE messages SET status = 'interrupted', error = 'interrupted' WHERE status = 'streaming';
      UPDATE attempts SET status = 'interrupted' WHERE status = 'streaming';
      PRAGMA user_version = 3;
    `)
  })
  if (version < 4) tx(db, () => {
    db.exec(`
      CREATE TABLE gateway_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL CHECK (version >= 0),
        base_url TEXT NOT NULL,
        encrypted_key TEXT
      ) STRICT;
      PRAGMA user_version = 4;
    `)
  })
  if (version < 5) tx(db, () => {
    db.exec(`
      ALTER TABLE generation_jobs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT ${DEFAULT_MODEL_LIMITS.outputTokens}
        CHECK (output_tokens BETWEEN ${MIN_OUTPUT_TOKENS} AND ${MAX_MODEL_LIMITS.outputTokens});
      ALTER TABLE generation_jobs ADD COLUMN context_chars INTEGER NOT NULL DEFAULT ${DEFAULT_MODEL_LIMITS.contextChars}
        CHECK (context_chars BETWEEN 1 AND ${MAX_MODEL_LIMITS.contextChars});
      PRAGMA user_version = 5;
    `)
  })
  tx(db, () => {
    db.exec(`
      ALTER TABLE chats ADD COLUMN title_job_until INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version = 6;
    `)
  })
}

export function tx<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = body()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function get<T>(db: DatabaseSync, sql: string, ...args: SQLInputValue[]) {
  return db.prepare(sql).get(...args) as T | undefined
}

export function all<T>(db: DatabaseSync, sql: string, ...args: SQLInputValue[]) {
  return db.prepare(sql).all(...args) as T[]
}

export function usage(db: DatabaseSync, owner: string | null, day = today()) {
  const totals = get<{ count: number; inputTokens: number; outputTokens: number }>(db, `
    SELECT COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens
    FROM attempts WHERE day = ? ${owner === null ? '' : 'AND owner_id = ?'}
  `, day, ...(owner === null ? [] : [owner]))!
  const limit = owner === null
    ? get<{ daily_limit: number }>(db, 'SELECT daily_limit FROM site_settings WHERE id = 1')?.daily_limit
    : get<{ daily_limit: number }>(db, 'SELECT daily_limit FROM profiles WHERE id = ?', owner)?.daily_limit
  if (limit === undefined) throw new HttpError(404, 'not_found')
  return { ...totals, day, limit }
}
