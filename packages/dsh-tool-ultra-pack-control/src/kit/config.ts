/** Shared configuration vocabulary and validation. Never coerce YAML strings. */
export interface CommonConfig {
  timeoutMs?: number
  maxBytes?: number
  maxChars?: number
  maxTransferBytes?: number
  transferDir?: string
  denyPaths?: string[]
}

export const COMMON_DEFAULTS = { timeoutMs: 60_000, maxBytes: 2_000_000, maxChars: 20_000, maxTransferBytes: 50_000_000 } as const
export const COMMON_KEYS = ['timeoutMs', 'maxBytes', 'maxChars', 'maxTransferBytes', 'transferDir', 'denyPaths'] as const
export const SSH_KEYS = ['hosts', 'sshBin', 'multiplex', 'connectTimeoutS', ...COMMON_KEYS] as const
export const PACK_KEYS = {
  ssh: SSH_KEYS,
  adb: ['serials', 'adbBin', 'adbConnect', 'adbAskInput', 'adbUiTtlMs', 'outputDir', ...COMMON_KEYS],
  desktop: ['outputDir', 'desktopCacheMs', ...SSH_KEYS],
  browser: ['outputDir', 'browserAllowPrivate', 'browserAllowLocalTcp', ...SSH_KEYS],
} as const

export function configError(path: string, message: string): never {
  throw new Error(`Invalid control config: ${path} ${message}`)
}
export function configObject(value: unknown, path: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) configError(path, 'must be an object.')
}
export function configKeys(value: object, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) configError(`${path}.${key}`, 'is not a supported setting.')
}
export function configInteger(value: unknown, fallback: number, min: number, max: number, path: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) configError(path, `must be an integer from ${min} to ${max}.`)
  return value
}
export function configBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'boolean') configError(path, 'must be boolean.')
}
export function configText(value: unknown, path: string, empty = false): void {
  if (value !== undefined && (typeof value !== 'string' || (!empty && !value.trim()) || /[\0\r\n]/.test(value))) configError(path, `must be ${empty ? '' : 'nonempty '}text without NUL or newlines.`)
}
export function configStrings(value: unknown, path: string): asserts value is string[] | undefined {
  if (value !== undefined && (!Array.isArray(value) || value.some((s) => typeof s !== 'string'))) configError(path, 'must be an array of strings.')
}
export function checkCommonConfig(options: CommonConfig, prefix: string): void {
  configObject(options, prefix)
  configInteger(options.timeoutMs, COMMON_DEFAULTS.timeoutMs, 1, 2_147_483_647, `${prefix}.timeoutMs`)
  for (const key of ['maxBytes', 'maxChars', 'maxTransferBytes'] as const) configInteger(options[key], COMMON_DEFAULTS[key], 1, Number.MAX_SAFE_INTEGER - 1, `${prefix}.${key}`)
  configText(options.transferDir, `${prefix}.transferDir`)
  configStrings(options.denyPaths, `${prefix}.denyPaths`)
  for (const [i, pattern] of (options.denyPaths ?? []).entries()) {
    try { new RegExp(pattern) } catch { configError(`${prefix}.denyPaths[${i}]`, 'must be a valid regular expression.') }
  }
}
