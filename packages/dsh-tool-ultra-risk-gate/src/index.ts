// dsh-tool-ultra-risk-gate: confirm loading high-risk tools.
//
// Loading a tool only makes it visible; it does not run anything. That is why
// ordinary loads need no confirmation. A few tools are different — merging a
// pull request, deleting a file — and those are confirmed at load time, so the
// model cannot quietly arm one and call it a step later.
//
// How it works:
//   - registers a risk gate on `toolCatalog`, which is what tells the core a
//     gate exists (without one, high-risk loads are refused outright);
//   - listens on `tools/pre-execute`; when a `tools_load` would load at least
//     one high-risk tool, it returns `{ kind: 'ask' }`;
//   - DSH routes that to its approval channel. A session with no channel
//     (headless, a bot without approvals) is denied automatically by the host,
//     which is the safe default;
//   - a per-session allowlist in config lets a known session skip the prompt,
//     so an unattended bot can still be given these tools deliberately.
//
// High-risk tools are only ever loaded one at a time; loading a whole group
// skips them and tells the model to load them individually. That keeps each
// confirmation tied to exactly one dangerous tool.

import type { Agent, Catalog, ExtensionContext } from '@lvy-jsd/dsh-tool-ultra-core'

/** One `allow` entry: `true` or "*" for every high-risk tool, or a list of names. */
export type AllowSpec = boolean | string | string[]

export interface RiskGateConfig {
  enabled?: boolean
  /** Extra tool names (full or short) treated as high risk. */
  highRisk?: string[]
  /** Set false to drop DEFAULT_HIGH_RISK. */
  defaultHighRisk?: boolean
  /** Per session id, or "*" for every session. */
  allow?: Record<string, AllowSpec>
}

/** The part of a tools/pre-execute event this gate reads. */
interface PreExecute {
  name: string
  agent?: Agent
  arguments?: { targets?: string[] }
}

export const name = 'tool-manager-risk-gate'
export const inject = ['toolCatalog']

/** Tools that are dangerous to run, used when a catalog entry declares none. */
export const DEFAULT_HIGH_RISK = [
  'merge_pull_request',
  'delete_file',
  'delete_branch',
  'create_or_update_file',
  'push_files',
  'delete_repository',
]

/** `mcp__server__tool` -> `tool`; other names unchanged. */
const shortOf = (name: string): string => (name.startsWith('mcp__') ? name.split('__').pop()! : name)

/**
 * Read an `allow` entry. `true` or "*" allows every high-risk tool in that
 * session; a list allows only the named tools. Anything else allows none.
 */
function allowedTools(spec: AllowSpec | undefined): '*' | string[] {
  if (spec === true || spec === '*') return '*'
  if (Array.isArray(spec)) return spec.includes('*') ? '*' : spec
  return []
}

export function apply(ctx: ExtensionContext, config: RiskGateConfig = {}) {
  const logger = (typeof ctx.logger === 'function' ? ctx.logger('tool-manager-risk-gate') : ctx.logger) ?? console
  if (config.enabled === false) return
  const extraHighRisk = new Set([...(config.highRisk ?? []), ...(config.defaultHighRisk === false ? [] : DEFAULT_HIGH_RISK)])
  // { "<session id>": ["merge_pull_request", ...] | "*" }
  const allow: Record<string, AllowSpec> = config.allow ?? {}

  /** Is this tool high-risk? Catalog declaration first, then the configured list. */
  function isRisky(catalog: Catalog | undefined, toolName: string): boolean {
    const tool = catalog?.tools?.get(toolName)
    return Boolean(tool?.highRisk) || extraHighRisk.has(toolName) || extraHighRisk.has(shortOf(toolName))
  }

  /** High-risk tools among the given names: catalog declaration first. */
  function riskyAmong(catalog: Catalog | undefined, names: Iterable<string>): string[] {
    const risky: string[] = []
    for (const toolName of names) {
      if (isRisky(catalog, toolName)) risky.push(toolName)
    }
    return risky
  }

  /** The pack a tool belongs to (its title), or undefined when it is in none. */
  function packOf(toolName: string): string | undefined {
    if (typeof ctx.toolCatalog.toolPacks !== 'function') return undefined
    return ctx.toolCatalog.toolPacks().find((pack) => pack.tools.includes(toolName))?.title
  }

  /** Tool names for the prompt, each with its pack when one is registered. */
  function labeled(names: string[]): string {
    return names.map((toolName) => {
      const pack = packOf(toolName)
      return pack ? `${toolName} (pack: ${pack})` : toolName
    }).join(', ')
  }

  /** Tools a tools_load call would add, resolved against the caller's catalog. */
  function targetsOf(agent: Agent | undefined, args: PreExecute['arguments']): string[] {
    const catalog = ctx.toolCatalog.get(agent)
    const names = new Set<string>()
    for (const raw of args?.targets ?? []) {
      const node = ctx.toolCatalog.resolve(raw, agent)
      if (node?.kind === 'tool') names.add(node.tool.name)
      // Group and category loads skip high-risk tools (they load one at a
      // time), so only the tools that would actually be loaded count here.
      else if (node?.kind === 'group') for (const tool of node.group.tools.filter((t) => !isRisky(catalog, t.name))) names.add(tool.name)
      else if (node?.kind === 'category') for (const group of node.category.groups) for (const tool of group.tools.filter((t) => !isRisky(catalog, t.name))) names.add(tool.name)
    }
    return [...names]
  }

  ctx.effect(() => ctx.toolCatalog.registerRiskGate({ name }), 'tool-manager-risk-gate.gate()')

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (extraHighRisk.size) {
    // Tell the core, so group loads skip these tools and a direct call of a
    // hidden one is refused instead of auto-loaded (rescueHiddenCall).
    const pattern = new RegExp(`(^|__)(${[...extraHighRisk].map(escape).join('|')})$`)
    ctx.effect(() => ctx.toolCatalog.annotate(pattern, { risk: 'high' }), 'tool-manager-risk-gate.annotate()')
  }

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec: PreExecute, next: () => Promise<unknown>) => {
    if (exec.name !== 'tools_load') return next()
    const agent = exec.agent
    const sessionId = agent?.id === undefined ? undefined : String(agent.id)
    // A session entry wins; "*" applies to every session.
    const spec = allow[String(sessionId)] ?? allow['*']
    const preApproved = allowedTools(spec)
    if (preApproved === '*') return next()
    const catalog = ctx.toolCatalog.get(agent)
    const risky = riskyAmong(catalog, targetsOf(agent, exec.arguments))
    if (risky.length === 0) return next()
    // A per-session allowlist entry naming these tools skips the prompt.
    if (risky.every((toolName) => preApproved.includes(toolName) || preApproved.includes(shortOf(toolName)))) return next()
    logger.info?.(`tool-manager-risk-gate: confirming load of ${risky.join(', ')}`)
    const list = labeled(risky)
    return {
      kind: 'ask',
      reason: `Loading high-risk tool(s): ${list}`,
      displayReason: {
        en: `Load high-risk tool(s)? ${list}\nWhy: these tools are marked high-risk.\nApproving loads them into this session so the model can call them; nothing runs until the model calls one.`,
        'zh-CN': `加载高危工具？${list}\n原因：这些工具被标记为高危。\n批准后，这些工具会被加载到当前会话，模型可以调用它们；在模型调用之前不会执行任何操作。`,
      },
    }
  }), 'tool-manager-risk-gate.pre-execute()')

  return {
    riskyAmong,
    /** Whether this session may load the given tool without a prompt. */
    allowedFor: (sessionId: unknown, toolName: string): boolean => {
      const spec = allowedTools(allow[String(sessionId)])
      return spec === '*' || spec.includes(toolName) || spec.includes(shortOf(toolName))
    },
  }
}

export default { name, inject, apply }
