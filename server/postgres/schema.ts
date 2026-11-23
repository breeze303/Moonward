import { readFile } from 'node:fs/promises'

export async function freshSchema() {
  return (
    await Promise.all(
      ['schema.sql', 'memory-v1.sql'].map((name) => readFile(new URL(name, import.meta.url), 'utf8')),
    )
  ).join('\n')
}
