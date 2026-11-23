import { readFileSync } from 'node:fs'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../shared/contract.ts'
import { loadConfig } from './config.ts'
import { initializeAccounts } from './accounts.ts'
import { openDb } from './db.ts'
import { emailSchema, nameSchema, passwordSchema } from './validation.ts'
import { HttpError } from './errors.ts'

try {
  const config = loadConfig()
  const email = emailSchema.parse(process.argv[2])
  const name = nameSchema.parse(process.argv[3] || 'Administrator')
  if (process.stdin.isTTY) throw new Error('Pass the password on stdin, not on the command line')
  const password = passwordSchema.parse(readFileSync(0, 'utf8').replace(/\r?\n$/, ''))
  const db = openDb(config.dbPath)
  try {
    await (await initializeAccounts(config, db)).createAdmin(email, name, password)
    console.log('Administrator created')
  } finally { db.close() }
} catch (error) {
  console.error(error instanceof HttpError && error.code === 'admin_exists'
    ? 'An administrator already exists.' : `Could not create administrator. Check configuration, email, and the ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} character password read from stdin.`)
  process.exitCode = 1
}
