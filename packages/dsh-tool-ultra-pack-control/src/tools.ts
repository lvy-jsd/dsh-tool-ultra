/** Shared tool construction and validation, independent of the DSH runtime. */
import { BROWSER_TOOL_NAMES, createBrowserTools, type BrowserConfig } from './browser.js'
import { ADB_ROOT_TOOL_NAMES, ADB_TOOL_NAMES, createAdbTools, type AdbConfig } from './adb.js'
import { DESKTOP_TOOL_NAMES, createDesktopTools, type DesktopConfig } from './desktop.js'
import { SSH_EXEC_TOOL_NAMES, SSH_TOOL_NAMES, checkHost, createSshTools, type SshConfig } from './ssh.js'
import type { ToolSpec } from './kit/spec.js'
import { PACK_KEYS, checkCommonConfig, configBoolean, configError, configKeys, configObject, configStrings, configText } from './kit/config.js'

export const TOOL_NAMES = [...SSH_TOOL_NAMES, ...SSH_EXEC_TOOL_NAMES, ...ADB_TOOL_NAMES, ...ADB_ROOT_TOOL_NAMES, ...DESKTOP_TOOL_NAMES, ...BROWSER_TOOL_NAMES] as const

export const PACKS = {
  browser: { title: 'Browser (remote over SSH/CDP)', summary: 'Remote Chrome tabs via configured SSH host aliases. Read untrusted page text or numbered refs, then click/type with approval; refresh refs after input. JavaScript always asks.' },
  desktop: { title: 'Desktop (remote over SSH)', summary: 'Remote Linux desktops via configured SSH host aliases. Inspect screenshots/windows, then focus or send input with call approval. X11 and supported Wayland compositors.' },
  adb: { title: 'Android (observe and input)', summary: 'Configured Android aliases over wireless adb. Inspect with adb_ui, tap a numbered element, and refresh after input.' },
  'adb-root': { title: 'Android (shell and transfer)', summary: 'Android shell, KernelSU su, file transfers and APK installation. Root, upload and install calls ask first.' },
  ssh: { title: 'SSH (read-only)', summary: 'Look at remote hosts over SSH: overview, files, logs. Hosts come from the config.' },
  'ssh-exec': { title: 'SSH (run and write)', summary: 'Run commands and change files on remote hosts over SSH. Commands that only read run at once; everything else asks the user first.' },
} as const
export type PackId = keyof typeof PACKS

/** `true` or "*" skips waivable questions; browser_eval always asks. A list names the tools that skip it. */
export type AllowSpec = boolean | '*' | string[]

export interface Config extends SshConfig, AdbConfig, DesktopConfig, BrowserConfig {
  /** Which packs are on. Default: ssh on, all other packs off. */
  packs?: Partial<Record<PackId, boolean>>
  /** Optional per-pack overrides, merged over the legacy top-level settings. */
  packConfig?: { ssh?: SshConfig, adb?: AdbConfig, desktop?: SshConfig & DesktopConfig, browser?: SshConfig & BrowserConfig }
  /** Register only the read-only tools, whatever `packs` says. */
  readOnly?: boolean
  /** Tool names to leave out. */
  disable?: string[]
  /** Per session id, or "*" for every session: calls that skip the approval question. */
  allow?: Record<string, AllowSpec>
  /** JSON-lines log of what the tools did; '' turns it off. Default <DSH_HOME>/tool-manager/control-audit.jsonl. */
  auditFile?: string
}

export type CreateOptions = Config & { exec?: import('./kit/exec.js').Exec }

export function checkConfig(opts: Config): void {
  configObject(opts, 'config')
  configBoolean(opts.readOnly, 'readOnly')
  configStrings(opts.disable, 'disable')
  configText(opts.auditFile, 'auditFile', true)
  if (opts.packs !== undefined) {
    configObject(opts.packs, 'packs')
    configKeys(opts.packs, Object.keys(PACKS), 'packs')
    for (const [pack, value] of Object.entries(opts.packs)) configBoolean(value, `packs.${pack}`)
  }
  if (opts.packConfig !== undefined) {
    configObject(opts.packConfig, 'packConfig')
    configKeys(opts.packConfig, Object.keys(PACK_KEYS), 'packConfig')
  }
  if (opts.allow !== undefined) {
    configObject(opts.allow, 'allow')
    for (const [id, value] of Object.entries(opts.allow)) {
      if (typeof value === 'boolean' || value === '*') continue
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) configError(`allow.${id}`, 'must be boolean, "*", or an array of tool names.')
    }
  }
}

/** Every tool of the packs that are on, as plain specs. Invalid config throws. */
export function createTools(opts: CreateOptions = {}): ToolSpec[] {
  return buildTools(opts)
}

/** The DSH adapter can quarantine a bad family without registering partial tools. */
export function buildTools(opts: CreateOptions, onError?: (pack: string, error: unknown) => void): ToolSpec[] {
  checkConfig(opts)
  const on = (id: PackId) => opts.packs?.[id] ?? id === 'ssh'
  const disabled = new Set(opts.disable ?? [])
  const settings = (pack: keyof typeof PACK_KEYS) => {
    const override = opts.packConfig?.[pack]
    if (override !== undefined) {
      configObject(override, `packConfig.${pack}`)
      configKeys(override, PACK_KEYS[pack], `packConfig.${pack}`)
    }
    const merged = { ...opts, ...override }
    checkCommonConfig(merged, pack)
    return merged
  }
  const forHostPack = (pack: PackId, config: typeof opts) => {
    if (config.hosts !== undefined) configObject(config.hosts, 'hosts')
    // Validate before filtering: a malformed whitelist must never silently grant access.
    for (const [alias, host] of Object.entries(config.hosts ?? {})) checkHost(alias, host)
    return { ...config, hosts: Object.fromEntries(Object.entries(config.hosts ?? {}).filter(([, h]) => !h.packs || h.packs.includes(pack))) }
  }
  const build = (pack: keyof typeof PACK_KEYS, enabled: boolean, factory: () => ToolSpec[]) => {
    if (!enabled) return []
    try { return factory() } catch (error) {
      if (!onError) throw error
      onError(pack, error)
      return []
    }
  }
  const ssh = build('ssh', on('ssh') || on('ssh-exec'), () => (['ssh', 'ssh-exec'] as const).flatMap((pack) => on(pack) ? createSshTools(forHostPack(pack, settings('ssh'))).filter((t) => t.pack === pack) : []))
  const adb = build('adb', on('adb') || on('adb-root'), () => createAdbTools(settings('adb')))
  const desktop = build('desktop', on('desktop'), () => createDesktopTools(forHostPack('desktop', settings('desktop'))))
  // Legacy shared limits may exceed browser's safety caps. Clamp inherited values;
  // explicit browser overrides still receive strict validation by the browser factory.
  const browser = build('browser', on('browser'), () => {
    const browserOptions = settings('browser')
    for (const [key, min, max] of [['timeoutMs', 100, 120_000], ['maxTransferBytes', 1, 40_000_000], ['maxBytes', 1024, 64_000_000], ['maxChars', 128, 200_000]] as const) {
      const value = browserOptions[key]
      if (value !== undefined && opts.packConfig?.browser?.[key] === undefined && Number.isSafeInteger(value) && value > 0) browserOptions[key] = Math.max(min, Math.min(max, value))
    }
    return createBrowserTools(forHostPack('browser', browserOptions))
  })
  return [...ssh, ...adb, ...desktop, ...browser].filter((t) => on(t.pack as PackId) && !disabled.has(t.name) && !(opts.readOnly && t.risk !== 'low'))
}

