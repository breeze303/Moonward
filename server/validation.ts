import { z } from 'zod'
import { acceptedMime, effortLevels, MAX_FILE_BYTES, MAX_FILES, MAX_MODEL_LIMITS, MAX_PASSWORD_LENGTH, MAX_TURN_BYTES, MIN_PASSWORD_LENGTH } from '../shared/contract.ts'
import type { FileInput } from '../shared/contract.ts'
import { HttpError } from './errors.ts'

export const emailSchema = z.string().trim().toLowerCase().max(254).email()
export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH)
export const nameSchema = z.string().trim().min(1).max(60)
export const idSchema = z.uuid()
export const versionSchema = z.number().int().min(0)
export const limitSchema = z.number().int().min(0).max(100_000)
export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const modelIdSchema = z.string().regex(/^[a-zA-Z0-9._:/-]{1,100}$/)
export const effortSchema = z.enum(effortLevels)
export const effortsSchema = z.array(effortSchema).max(effortLevels.length)
  .refine((levels) => new Set(levels).size === levels.length)

const fileSchema = z.object({
  name: z.string().trim().min(1).max(180).regex(/^[^/\\\u0000-\u001f\u007f]+$/u),
  mime: z.enum(acceptedMime),
  data: z.string().min(4).max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
}).strict()

export const turnSchema = z.object({
  chatId: idSchema,
  version: versionSchema,
  action: z.enum(['send', 'edit', 'retry']),
  target: idSchema.optional(),
  text: z.string().trim().max(MAX_MODEL_LIMITS.contextChars).optional(),
  files: z.array(fileSchema).max(MAX_FILES).optional(),
  model: modelIdSchema,
  effort: effortSchema.optional(),
  web: z.boolean().optional(),
}).strict().refine((v) => {
  if (v.action === 'send') return !v.target && Boolean(v.text || v.files?.length)
  if (v.action === 'edit') return Boolean(v.target && v.text) && v.files === undefined
  return Boolean(v.target) && v.text === undefined && v.files === undefined
})

export function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new HttpError(400, 'invalid_input')
  return parsed.data
}

export type Upload = { name: string; mime: FileInput['mime']; bytes: Buffer }

export function decodeFiles(files: FileInput[]): Upload[] {
  let total = 0
  return files.map(({ name, mime, data }) => {
    const bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64') !== data || !bytes.length) throw new HttpError(400, 'invalid_file')
    total += bytes.length
    if (bytes.length > MAX_FILE_BYTES || total > MAX_TURN_BYTES) throw new HttpError(413, 'attachment_too_large')
    let valid = false
    switch (mime) {
      case 'image/png': valid = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')); break
      case 'image/jpeg': valid = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')); break
      case 'image/webp': valid = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'; break
      case 'application/pdf': valid = bytes.toString('ascii', 0, 5) === '%PDF-'; break
      case 'text/plain':
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          valid = !bytes.includes(0)
        } catch { /* Invalid UTF-8 is not a text attachment. */ }
        break
    }
    if (!valid) throw new HttpError(400, 'invalid_file')
    return { name, mime, bytes }
  })
}
