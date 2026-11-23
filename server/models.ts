import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { DEFAULT_MODEL_LIMITS, effortLevels, MAX_MODEL_LIMITS, MAX_MODELS, MIN_OUTPUT_TOKENS } from '../shared/contract.ts'
import type { ModelCatalog, ModelConfig, ModelSelection } from '../shared/contract.ts'
import { get, tx } from './db.ts'
import { HttpError } from './errors.ts'
import { effortSchema, effortsSchema, modelIdSchema, versionSchema } from './validation.ts'

const modelLimitsSchema = z.object({
  outputTokens: z.number().int().min(MIN_OUTPUT_TOKENS).max(MAX_MODEL_LIMITS.outputTokens),
  contextChars: z.number().int().min(1).max(MAX_MODEL_LIMITS.contextChars),
}).strict()

const modelSchema = z.object({
  id: modelIdSchema,
  label: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/u),
  enabled: z.boolean(),
  vision: z.boolean(),
  files: z.boolean(),
  web: z.boolean(),
  efforts: effortsSchema.transform((allowed) => effortLevels.filter((effort) => allowed.includes(effort))),
  defaultEffort: effortSchema.nullable(),
  summary: z.boolean(),
  limits: modelLimitsSchema.default(DEFAULT_MODEL_LIMITS),
}).strict().refine((model) => model.defaultEffort === null || model.efforts.includes(model.defaultEffort))

export const selectionSchema = z.object({ models: z.array(modelSchema).max(MAX_MODELS), defaultId: modelIdSchema.nullable() }).strict()
  .refine(({ models, defaultId }) => new Set(models.map((model) => model.id)).size === models.length &&
    (defaultId === null ? models.every((model) => !model.enabled) : models.some((model) => model.id === defaultId && model.enabled)))

export const catalogUpdateSchema = z.object({ version: versionSchema, selection: selectionSchema }).strict()

export class CatalogStore {
  private db: DatabaseSync
  constructor(db: DatabaseSync) { this.db = db }

  bootstrap(seed: () => ModelConfig[]) {
    if (get<{ selection: string | null }>(this.db, 'SELECT selection FROM model_catalog WHERE id = 1')!.selection !== null) return
    const models = seed()
    this.db.prepare('UPDATE model_catalog SET selection = ? WHERE id = 1').run(JSON.stringify({ models, defaultId: models[0]?.id ?? null }))
  }

  read(): ModelCatalog {
    const { selection, version } = get<{ selection: string; version: number }>(this.db,
      'SELECT selection, version FROM model_catalog WHERE id = 1')!
    return { ...selectionSchema.parse(JSON.parse(selection)), version }
  }

  save(version: number, selection: ModelSelection) {
    return tx(this.db, () => {
      const result = this.db.prepare('UPDATE model_catalog SET selection = ?, version = version + 1 WHERE id = 1 AND version = ?')
        .run(JSON.stringify(selection), version)
      if (!result.changes) throw new HttpError(409, 'catalog_conflict')
      return this.read()
    })
  }

  available(ids: ReadonlySet<string>) {
    const { models, defaultId } = this.read()
    return models.filter((model) => model.enabled && ids.has(model.id))
      .sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId))
  }
}
