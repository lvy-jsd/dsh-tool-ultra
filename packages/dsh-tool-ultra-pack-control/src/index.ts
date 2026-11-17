/**
 * Tool Ultra control pack: SSH root control, as tools small models can use.
 *
 * Two packs. `ssh` is on by default; `ssh-exec` is off until the config turns it on:
 *
 * - ssh       ssh_hosts, ssh_sys, ssh_read, ssh_log        (read-only)
 * - ssh-exec  ssh_run, ssh_write, ssh_get, ssh_put         (changes things)
 *
 * The tools are plain `ToolSpec` objects (`createTools`) with no host types in
 * them, so this adapter and any other front end (an MCP server) share them.
 * Three layers keep a model on a short leash: a pack must be switched on, the
 * hosts are aliases from the config, and every call that may change something
 * asks the user first (see `gate`). `readOnly` removes the changing tools.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createAudit, defaultAuditFile, type Audit } from './kit/audit.js'
import type { ToolSpec } from './kit/spec.js'
import { SSH_EXEC_TOOL_NAMES, SSH_TOOL_NAMES, createSshTools, type SshConfig } from './ssh.js'

export * from './kit/audit.js'
export * from './kit/exec.js'
export * from './kit/policy.js'
export * from './kit/spec.js'
export * from './ssh.js'

export const name = 'tool-ultra-pack-control'
export const inject = ['tools']

export const TOOL_NAMES = [...SSH_TOOL_NAMES, ...SSH_EXEC_TOOL_NAMES] as const

export const PACKS = {
  ssh: { title: 'SSH (read-only)', summary: 'Look at remote hosts over SSH: overview, files, logs. Hosts come from the config.' },
  'ssh-exec': { title: 'SSH (run and write)', summary: 'Run commands and change files on remote hosts over SSH. Commands that only read run at once; everything else asks the user first.' },
} as const
export type PackId = keyof typeof PACKS

/** `true` or "*" skips the question for every tool; a list names the tools that skip it. */
export type AllowSpec = boolean | string | string[]

export interface Config extends SshConfig {
  /** Which packs are on. Default: ssh on, ssh-exec off. */
  packs?: Partial<Record<PackId, boolean>>
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

/** Every tool of the packs that are on, as plain specs. */
export function createTools(opts: CreateOptions = {}): ToolSpec[] {
  const on = (id: PackId) => opts.packs?.[id] ?? id === 'ssh'
  const disabled = new Set(opts.disable ?? [])
  return createSshTools(opts).filter((t) => on(t.pack as PackId) && !disabled.has(t.name) && !(opts.readOnly && t.risk !== 'low'))
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: String(value) }],
} as const

/** The part of a `tools/pre-execute` event the gate reads. */
interface PreExecute {
  name: string
  agent?: { id?: unknown }
  arguments?: unknown
}

function allowed(spec: AllowSpec | undefined, tool: string): boolean {
  if (spec === true || spec === '*') return true
  return Array.isArray(spec) && (spec.includes('*') || spec.includes(tool))
}

/**
 * The approval question. Returns `{ kind: 'ask' }` for a call whose tool says it needs
 * confirming; DSH routes that to the user, and a session with nobody to ask is refused.
 * Returns undefined when the call may go ahead.
 */
export function gate(specs: readonly ToolSpec[], allow: Record<string, AllowSpec> = {}) {
  const byName = new Map(specs.map((s) => [s.name, s]))
  return (exec: PreExecute) => {
    const spec = byName.get(exec.name)
    if (!spec?.approve) return undefined
    const reason = spec.approve(exec.arguments ?? {})
    if (!reason) return undefined
    const session = exec.agent?.id === undefined ? '' : String(exec.agent.id)
    if (allowed(allow[session] ?? allow['*'], spec.name)) return undefined
    return {
      kind: 'ask' as const,
      reason: `${spec.name}: ${reason}`,
      displayReason: { en: `Allow ${spec.name}? ${reason}`, 'zh-CN': `允许 ${spec.name}？${reason}` },
    }
  }
}

// The host context is structural and differs between DSH and a plain Cordis context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any, config: Config = {}) {
  const logger = (typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger) ?? console
  const audit: Audit = createAudit(config.auditFile ?? defaultAuditFile(), (m) => logger.warn?.(m))
  const specs = createTools(config)
  const hostNames = Object.keys(config.hosts ?? {})

  if (typeof ctx.inject === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.inject(['toolCatalog'], (c: any) => {
      if (typeof c.toolCatalog?.registerToolPack !== 'function') return
      for (const id of Object.keys(PACKS) as PackId[]) {
        const tools = specs.filter((s) => s.pack === id).map((s) => s.name)
        if (!tools.length) continue
        c.effect(() => c.toolCatalog.registerToolPack({
          id,
          title: PACKS[id].title,
          summary: PACKS[id].summary,
          source: '@lvy-jsd/dsh-tool-ultra-pack-control',
          tools,
          items: () => hostNames.length
            ? hostNames.map((h) => ({ id: h, title: h, state: 'on' as const, detail: config.hosts![h].target }))
            : [{ id: 'hosts', title: 'Hosts', state: 'waiting' as const, detail: 'no hosts configured' }],
        }))
      }
    })
  }

  for (const spec of specs) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => spec.risk === 'low',
      async execute(args: unknown) {
        const started = Date.now()
        let ok = false
        try {
          const out = await spec.execute(args)
          ok = true
          return out
        } finally {
          audit({ tool: spec.name, summary: spec.describe(args), ok, ms: Date.now() - started })
        }
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any))
  }

  if (specs.some((s) => s.approve) && typeof ctx.on === 'function') {
    const decide = gate(specs, config.allow)
    const hook = (exec: PreExecute, next: () => Promise<unknown>) => decide(exec) ?? next()
    if (typeof ctx.effect === 'function') ctx.effect(() => ctx.on('tools/pre-execute', hook), 'tool-ultra-pack-control.gate()')
    else ctx.on('tools/pre-execute', hook)
  }
}

export default { name, inject, apply }
