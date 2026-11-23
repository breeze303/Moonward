import { existsSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { loadConfig } from './config.ts'

const source = loadConfig().dbPath
const destination = process.argv[2] ? resolve(process.argv[2]) : null
if (source === ':memory:' || !existsSync(source) || !destination || existsSync(destination)) {
  throw new Error('Provide a new destination path for an existing on-disk database')
}
process.umask(0o077)
const db = new DatabaseSync(source, { readOnly: true })
try {
  await backup(db, destination)
  chmodSync(destination, 0o600)
  const snapshot = new DatabaseSync(destination, { readOnly: true })
  try {
    if (snapshot.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Backup verification failed')
  } finally { snapshot.close() }
  console.log('Backup written and SQLite integrity check passed')
} finally { db.close() }
