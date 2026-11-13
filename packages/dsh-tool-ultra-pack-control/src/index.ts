/** SSH, Android, remote browser and desktop packs, sharing audit and call approval. */
import { createHash } from 'node:crypto'
import { localExec } from './kit/exec.js'
import { inCall, observedExec } from './kit/scope.js'
import { redact } from './kit/policy.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createAudit, defaultAuditFile, type Audit } from './kit/audit.js'
import type { ToolSpec } from './kit/spec.js'
import { attachScreenshot, SCREENSHOT_OUTPUT } from './kit/screenshot.js'
import { PACKS, checkConfig, buildTools, type Config, type CreateOptions, type PackId, type AllowSpec } from './tools.js'

export { TOOL_NAMES, PACKS, createTools } from './tools.js'
export type { Config, CreateOptions, PackId, AllowSpec } from './tools.js'

export * from './kit/audit.js'
export * from './kit/exec.js'
export * from './kit/policy.js'
export * from './kit/spec.js'
export * from './ssh.js'
export * from './adb.js'
export * from './desktop.js'
export * from './browser.js'

export const name = 'tool-ultra-pack-control'
export const inject = ['tools']

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: String(value) }],
} as const

/** The part of a `tools/pre-execute` event the gate reads. */
export interface PreExecute {
  token?: symbol
  callId?: unknown
  signal?: AbortSignal
  name: string
  agent?: { id?: unknown, session?: { id?: unknown } }
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
  allow = structuredClone(allow)
  const byName = new Map(specs.map((s) => [s.name, s]))
  return (exec: PreExecute) => {
    const spec = byName.get(exec.name)
    if (!spec?.approve) return undefined
    const args = exec.arguments ?? {}
    const reason = inCall({ session: sessionId(exec), failed: false }, () => spec.approve!(args))
    if (!reason) return undefined
    const session = sessionId(exec)
    const always = typeof spec.alwaysAsk === 'function' ? spec.alwaysAsk(exec.arguments ?? {}) : spec.alwaysAsk
    const oversized = JSON.stringify(args).length > 4096 || (typeof (args as { cmd?: unknown }).cmd === 'string' && (args as { cmd: string }).cmd.length > 300)
    if (!always && !oversized && allowed(allow[session] ?? allow[String(exec.agent?.id ?? '')] ?? allow['*'], spec.name)) return undefined
    return {
      kind: 'ask' as const,
      reason: `${spec.name}: ${redact(spec.describe(exec.arguments ?? {}))}`,
      displayReason: { en: `Allow ${spec.name}? ${reason}`, 'zh-CN': `允许 ${spec.name}？${reason}` },
    }
  }
}

function sessionId(exec?: PreExecute): string {
  return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
}
function fingerprint(spec: ToolSpec, args: unknown, exec?: PreExecute): string {
  return createHash('sha256').update(JSON.stringify([spec.name, sessionId(exec), args, inCall({ session: sessionId(exec), failed: false }, () => spec.approve?.(args))])).digest('hex')
}

// The host context is structural and differs between DSH and a plain Cordis context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any, config: Config = {}) {
  const logger = (typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger) ?? console
  let specs: ToolSpec[]
  try {
    checkConfig(config)
    specs = buildTools({ ...config, exec: observedExec((config as CreateOptions).exec ?? localExec) }, (pack, error) => {
      const family = pack === 'ssh' ? 'ssh/ssh-exec' : pack === 'adb' ? 'adb/adb-root' : pack
      logger.warn?.(`Disabled control pack ${family}: ${String(error)}`)
    })
  } catch (error) {
    logger.warn?.(`Disabled all control packs: ${String(error)}`)
    return
  }
  const audit: Audit = createAudit(config.auditFile ?? defaultAuditFile(), (m) => logger.warn?.(m))
  const decide = gate(specs, config.allow)
  const permits = new Map<symbol, string>()

  if (typeof ctx.inject === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.inject(['toolCatalog'], (c: any) => {
      if (typeof c.toolCatalog?.registerToolPack !== 'function') return
      for (const id of Object.keys(PACKS) as PackId[]) {
        const tools = specs.filter((s) => s.pack === id).map((s) => s.name)
        if (!tools.length) continue
        const hostConfig = id === 'adb' || id === 'adb-root' ? {} : config.packConfig?.[id === 'ssh-exec' ? 'ssh' : id]?.hosts ?? config.hosts ?? {}
        const hostNames = Object.keys(hostConfig).filter((h) => !hostConfig[h].packs || hostConfig[h].packs!.includes(id))
        const serials = config.packConfig?.adb?.serials ?? config.serials ?? {}
        c.effect(() => c.toolCatalog.registerToolPack({
          id,
          title: PACKS[id].title,
          summary: PACKS[id].summary,
          source: '@lvy-jsd/dsh-tool-ultra-pack-control',
          tools,
          items: () => id === 'adb' || id === 'adb-root'
            ? Object.keys(serials).length
              ? Object.entries(serials).map(([alias, serial]) => ({ id: alias, title: alias, state: 'on' as const, detail: `configured: ${serial} (use adb_devices to check)` }))
              : [{ id: 'serials', title: 'Devices', state: 'waiting' as const, detail: 'no adb devices configured' }]
            : hostNames.length
            ? hostNames.map((h) => ({ id: h, title: h, state: 'on' as const, detail: hostConfig[h].target }))
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
      output: spec.screenshot ? SCREENSHOT_OUTPUT : TEXT_OUTPUT,
      // UI snapshots have per-device state used by subsequent taps.
      isConcurrencySafe: () => spec.risk === 'low' && spec.name !== 'adb_ui' && spec.pack !== 'browser',
      async execute(args: unknown, exec?: PreExecute) {
        const started = Date.now()
        let ok = false
        try {
          // Re-evaluate the actual arguments and caller. A missed/renamed hook
          // cannot authorize a mutation; an approval is bound to this invocation.
          const needsApproval = decide({ ...exec, name: spec.name, arguments: args })
          const permit = exec?.token === undefined ? undefined : permits.get(exec.token)
          if (exec?.token !== undefined) permits.delete(exec.token)
          if (needsApproval && permit !== fingerprint(spec, args, exec)) {
            audit({ tool: spec.name, summary: redact(spec.describe(args)), event: 'denied', ok: false, ms: 0 })
            throw new Error('Control call has no matching one-use approval. Refusing execution; the control pre-execute gate must run.')
          }
          if (exec?.signal?.aborted) throw new Error('Control call cancelled before execution.')
          if ((spec.pack === 'browser' || ['adb_ui', 'adb_tap'].includes(spec.name)) && !sessionId(exec)) throw new Error('Control references require an identified session.')
          const scope = { session: sessionId(exec), failed: false }
          const out = await inCall(scope, () => spec.execute(args))
          if (scope.failed) throw new Error(out)
          ok = true
          return spec.screenshot ? await attachScreenshot(out, ctx.get?.('attachments')) : out
        } finally {
          audit({ tool: spec.name, summary: redact(spec.describe(args)), event: 'result', ok, ms: Date.now() - started })
        }
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any))
  }

  if (specs.some((s) => s.approve) && typeof ctx.on === 'function') {
    const hook = async (exec: PreExecute, next: () => Promise<unknown>) => {
      const ask = decide(exec)
      if (!ask) return next()
      const spec = specs.find((s) => s.name === exec.name)!
      const record = (event: 'approved' | 'denied') => audit({ tool: spec.name, summary: redact(spec.describe(exec.arguments ?? {})), event, ok: event === 'approved', ms: 0 })
      // Resolve through the same host approval seam as DSH, so we can retain
      // proof of the outcome instead of treating "ask was emitted" as consent.
      const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined
      if (!approval || !exec.agent || typeof exec.token !== 'symbol') {
        record('denied')
        return { kind: 'deny', reason: 'Control approval requires a host approval channel, agent and execution token.' }
      }
      const before = fingerprint(spec, exec.arguments ?? {}, exec)
      let outcome: unknown
      try { outcome = await approval.request({ agent: exec.agent, toolName: spec.name, callId: exec.callId, signal: exec.signal, reason: ask.reason, displayReason: ask.displayReason }) }
      catch { record('denied'); return { kind: 'deny', reason: 'Control approval failed.' } }
      if (outcome !== 'allowed-once' || exec.signal?.aborted || before !== fingerprint(spec, exec.arguments ?? {}, exec)) {
        record('denied')
        return { kind: 'deny', reason: 'Control approval rejected, unavailable, cancelled or arguments changed.' }
      }
      record('approved')
      permits.set(exec.token, before)
      try {
        const decision = await next()
        // A later hook may still ask (host rules, auto-review); our one-use permit survives that
        // second question and is consumed by execute or dropped on tools/result.
        if (decision && typeof decision === 'object' && 'kind' in decision && decision.kind !== 'allow' && decision.kind !== 'ask') permits.delete(exec.token)
        return decision
      } catch (e) { permits.delete(exec.token); throw e }
    }
    ctx.on('tools/result', (exec: PreExecute) => { if (exec.token !== undefined) permits.delete(exec.token) })
    if (typeof ctx.effect === 'function') ctx.effect(() => ctx.on('tools/pre-execute', hook), 'tool-ultra-pack-control.gate()')
    else ctx.on('tools/pre-execute', hook)
  }
}

export default { name, inject, apply }
