/** File loading only; authorization and family validation remain in createTools. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { PACK_KEYS, configKeys, configObject } from './kit/config.js'
import type { Config } from './tools.js'

// Keep the parser's small boundary typed without adding a types-only dependency.
const { load, JSON_SCHEMA } = createRequire(import.meta.url)('js-yaml') as {
  load(text: string, options: { schema: unknown }): unknown
  JSON_SCHEMA: unknown
}
const packageName = '@lvy-jsd/dsh-tool-ultra-pack-control'

export function parseControlConfig(text: string): Config {
  if (Buffer.byteLength(text) > 1_048_576) throw new Error('Control config exceeds 1 MiB.')
  let value: unknown
  try { value = load(text, { schema: JSON_SCHEMA }) }
  catch { throw new Error('Invalid control config YAML (check syntax, duplicate keys and unsupported tags).') }
  if (Array.isArray(value)) {
    const entries = value.filter((v) => v && typeof v === 'object' && v.name === packageName)
    if (entries.length !== 1) throw new Error(`Control config must contain exactly one ${packageName} plugin entry.`)
    value = entries[0].config
  }
  configObject(value, 'config')
  // Never accept runner injection or misspelled settings from a file.
  configKeys(value as object, ['packs', 'packConfig', 'readOnly', 'disable', 'allow', 'auditFile', ...new Set(Object.values(PACK_KEYS).flat())], 'config')
  return value as Config
}

/** Accept a bare config mapping or the profile-patch list in examples/control.yml. */
export async function loadControlConfig(file: string): Promise<Config> {
  return parseControlConfig(await readFile(file, 'utf8'))
}
