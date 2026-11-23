import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { GatewaySettings } from '../shared/contract.ts'
import type { Config } from './config.ts'
import { get, tx } from './db.ts'
import { HttpError } from './errors.ts'
import { gatewayBaseUrl } from './gatewayNetwork.ts'
import { versionSchema } from './validation.ts'

export const gatewayUpdateSchema = z.object({
  version: versionSchema,
  baseUrl: z.string().trim().min(1).max(2_048),
  apiKey: z.string().trim().min(1).max(4_096).regex(/^[\x21-\x7e]+$/).optional(),
}).strict()

export type GatewayRow = { version: number; base_url: string; encrypted_key: string | null }
export type Destination = { version: number; baseUrl: string; apiKey: string }

export class GatewayKeys {
  protected config: Config
  private key: Buffer

  constructor(config: Config) {
    this.config = config
    this.key = Buffer.from(hkdfSync('sha256', config.secret, 'wenji', 'gateway-key-v1', 32))
  }

  encrypt(baseUrl: string, key: string) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv).setAAD(Buffer.from(baseUrl))
    const contents = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), contents].map((item) => item.toString('base64url')).join('.')
  }

  decrypt(row: GatewayRow): Destination {
    const baseUrl = gatewayBaseUrl(row.base_url, this.config.allowLoopbackGateway)
    if (!row.encrypted_key) return { version: row.version, baseUrl, apiKey: '' }
    try {
      const [iv, tag, contents] = row.encrypted_key.split('.').map((item) => Buffer.from(item, 'base64url'))
      const cipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 })
        .setAAD(Buffer.from(row.base_url)).setAuthTag(tag)
      return { version: row.version, baseUrl, apiKey: Buffer.concat([cipher.update(contents), cipher.final()]).toString('utf8') }
    } catch { throw new HttpError(503, 'gateway_key_unreadable') }
  }
}

export class GatewayStore extends GatewayKeys {
  private db: DatabaseSync
  constructor(db: DatabaseSync, config: Config) { super(config); this.db = db }
  private row() { return get<GatewayRow>(this.db, 'SELECT version, base_url, encrypted_key FROM gateway_settings WHERE id = 1') }
  bootstrap() {
    if (this.row()) return
    const legacy = this.config.legacyGateway()
    const baseUrl = gatewayBaseUrl(legacy.baseUrl, this.config.allowLoopbackGateway)
    this.db.prepare('INSERT INTO gateway_settings VALUES (1, 0, ?, ?)').run(baseUrl,legacy.apiKey ? this.encrypt(baseUrl, legacy.apiKey) : null)
  }
  read(): GatewaySettings {
    const row = this.row()!
    return {version:row.version,baseUrl:row.base_url,hasKey:row.encrypted_key!==null}
  }
  connection(row = this.row()!): Destination {return this.decrypt(row)}

  private assertIdle(version: number, row = this.row()!) {
    if (row.version !== version) throw new HttpError(409, 'gateway_conflict')
    if (get(this.db, "SELECT 1 FROM attempts WHERE status = 'streaming' LIMIT 1")) throw new HttpError(409, 'gateway_busy')
  }

  prepare({ version, baseUrl: input, apiKey: key }: z.output<typeof gatewayUpdateSchema>): Destination {
    const baseUrl = gatewayBaseUrl(input, this.config.allowLoopbackGateway)
    const row = this.row()!
    this.assertIdle(version, row)
    const apiKey = key ?? (baseUrl === row.base_url ? this.connection(row).apiKey : '')
    if (!apiKey) throw new HttpError(400, 'gateway_key_required')
    return { version, baseUrl, apiKey }
  }

  save({ version, baseUrl, apiKey }: Destination) {
    return tx(this.db, () => {
      this.assertIdle(version)
      this.db.prepare('UPDATE gateway_settings SET base_url = ?, encrypted_key = ?, version = version + 1 WHERE id = 1')
        .run(baseUrl, this.encrypt(baseUrl, apiKey))
      return this.read()
    })
  }
}
