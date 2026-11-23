import type { Pool, PoolClient } from 'pg'
import type { ModelSelection, ModelCatalog } from '../../shared/contract.ts'
import { GatewayKeys, type GatewayRow, type Destination } from '../gateway.ts'
import { selectionSchema } from '../models.ts'
import type { Config } from '../config.ts'
import { gatewayBaseUrl } from '../gatewayNetwork.ts'
import { HttpError } from '../errors.ts'
import { transaction } from './queue.ts'

export class PgGateway extends GatewayKeys {
  db: Pool
  constructor(db: Pool, config: Config) {
    super(config)
    this.db = db
  }
  private async row(c: Pool | PoolClient = this.db) {
    return (await c.query<GatewayRow>('SELECT * FROM gateway_settings WHERE id=1')).rows[0]
  }
  private reading?: Promise<Destination>
  connection() {
    return (this.reading ??= this.row()
      .then((row) => this.decrypt(row))
      .finally(() => {
        this.reading = undefined
      }))
  }
  async read() {
    const row = await this.row()
    return { version: row.version, baseUrl: row.base_url, hasKey: row.encrypted_key !== null }
  }
  async prepare({ version, baseUrl: input, apiKey: key }: { version: number; baseUrl: string; apiKey?: string }) {
    const row = await this.row(),
      baseUrl = gatewayBaseUrl(input, this.config.allowLoopbackGateway)
    if (row.version !== version) throw new HttpError(409, 'gateway_conflict')
    const apiKey = key ?? (row.base_url === baseUrl ? this.decrypt(row).apiKey : '')
    if (!apiKey) throw new HttpError(400, 'gateway_key_required')
    return { baseUrl, apiKey, version }
  }
  async save({ baseUrl, apiKey, version }: Destination) {
    await transaction(this.db, async (c) => {
      await c.query('SELECT id FROM site_settings WHERE id=1 FOR UPDATE')
      if (
        (
          await c.query(
            'SELECT 1 FROM generation_jobs UNION ALL SELECT 1 FROM title_jobs WHERE until_ms>extract(epoch FROM clock_timestamp())*1000 LIMIT 1',
          )
        ).rowCount
      )
        throw new HttpError(409, 'gateway_busy')
      if (
        !(
          await c.query(
            'UPDATE gateway_settings SET base_url=$1,encrypted_key=$2,version=version+1 WHERE id=1 AND version=$3',
            [baseUrl, this.encrypt(baseUrl, apiKey), version],
          )
        ).rowCount
      )
        throw new HttpError(409, 'gateway_conflict')
    })
    return this.read()
  }
}
export class PgCatalog {
  db: Pool
  constructor(db: Pool) {
    this.db = db
  }
  private reading?: Promise<ModelCatalog>
  read() {
    return (this.reading ??= this.db
      .query('SELECT * FROM model_catalog WHERE id=1')
      .then(({ rows: [r] }) => ({ ...selectionSchema.parse(JSON.parse(r.selection)), version: Number(r.version) }))
      .finally(() => {
        this.reading = undefined
      }))
  }
  async save(version: number, selection: ModelSelection) {
    if (
      !(
        await this.db.query('UPDATE model_catalog SET version=version+1,selection=$2 WHERE version=$1 AND id=1', [
          version,
          JSON.stringify(selection),
        ])
      ).rowCount
    )
      throw new HttpError(409, 'catalog_conflict')
    return this.read()
  }
  async available(ids: ReadonlySet<string>) {
    const { models, defaultId } = await this.read()
    return models
      .filter((m) => m.enabled && ids.has(m.id))
      .sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId))
  }
}
