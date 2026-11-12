// Tool Ultra: browse every DSH tool as a directory tree
// (category -> group -> tool) and load tools on demand per agent.
//
// Loaded tools are native: the model receives their full parameter schema.
// Visibility is enforced with the host's per-agent `tools.restrict({ allow })`.
//
// The core ships no placement rules: without a classifier plugin every group
// is `uncategorized`. Placement, metadata, hooks and extra visibility narrowing
// are provided by other plugins through the `toolCatalog` service.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildCatalog, closestNames, resolveTarget, toolsUnder, estimateTokens, pickToolUltra, UNCATEGORIZED } from './catalog.js'
import { createMetadataStore, defaultMetadataFile } from './metadata.js'
import { createExemptStore, defaultExemptFile } from './exempt.js'
import { defaultManifestFile, syncManifest } from './manifest.js'
import { createSettingsStore, defaultSettingsFile } from './settings.js'
import { createVisibilityController } from './visibility.js'
import { createRegistries, readManifestAnnotations, listPluginPackages } from './service.js'
import { registerRouter } from './router/index.js'
import { Bm25 } from './router/bm25.js'
import type { Agent, AuditEntry, LoadRefusal, Annotation, Catalog, CatalogNode, CoreConfig, Disposer, FoundTool, HostContext, Logger, RiskGate, SearchFallback, SerializedState, ToolCatalogService, ToolEntry, ToolMeta, ToolPack, ToolPackItem, ToolSchema, ToolUltraMeta, GroupNote, Group, PendingCall } from './types.js'

export type * from './types.js'
export { buildCatalog, closestNames, resolveTarget, toolsUnder, estimateTokens, pickToolUltra, RISK_LEVELS, summary, shortName, structuralGroup, DEFAULT_CATEGORIES, UNCATEGORIZED, MISC_GROUP, OVERRIDE_PRIORITY } from './catalog.js'
export type { BuildOptions } from './catalog.js'
export type { RegisteredClassifier, RegisteredFilter } from './service.js'
export type { VisibilityController, VisibilityOptions } from './visibility.js'

export const name = 'tool-manager'
export const inject = ['tools']

export const ENTRY_TOOLS = ['tools_ls', 'tools_load', 'tools_unload']

// Host transports that are not capabilities: never listed, loaded or restricted.
// `run_code` carries every call in DSH's PTC mode; the host refuses to restrict
// it and adds it to the view after all restrictions, so treating it as a hidden
// tool would block PTC mode outright.
export const HOST_RESERVED = ['run_code']

// Always visible and never listed in the directory. Names the host does not
// have are ignored, so this list survives DSH renames. Config `pinned` adds to
// it; config `unpin` removes from it.
export const DEFAULT_PINNED = [
  // DSH core
  'bash', 'read', 'write', 'edit', 'str_replace_editor', 'glob', 'grep', 'read_image',
  'ask_user_question', 'ask_user', 'exit_plan_mode', 'workflow', 'todo_write', 'present', 'skill', 'plan',
  'web_fetch', 'web_search', 'job_list', 'job_output', 'job_kill', 'create_goal', 'get_goal', 'update_goal',
  // delegation
  'subagent', 'subagent_fork', 'list_subagent_models', 'wait_agent', 'interrupt_agent', 'list_agents',
  // memory lookup is small and frequent
  'recall',
  // team chat: a Bot's group prompt tells it to answer through these, so they
  // must never sit behind tools_load
  'group_relay', 'post_to_group', 'read_group_chat', 'read_own_chat', 'message_bot', 'list_bots',
  // ds-bot: a Bot's prompt tells it to call these directly (show a view, read
  // the browser, create and update its own Bot), so they must never sit behind
  // tools_load; ask_user is already pinned above with the DSH core
  'show_view', 'read_browser', 'create_bot', 'update_bot',
  // dsh-auto-memory: same reason as recall — small and frequent; the write
  // operations (memory_write, memory_delete, ...) stay lazy
  'memory_search', 'memory_read',
]

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: String(value) }],
} as const

function fmtTokens(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k tok` : `~${n} tok`
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text + ' '.repeat(width - text.length)
}

// A directory page: listings longer than this are truncated, and the hint at
// the end tells the model how to continue.
const LIST_PAGE = 50

/** One page of entry lines, with a continue hint when more entries follow. */
function pageLines(entries: string[], offset: number, limit: number): string[] {
  const start = Math.max(0, Math.floor(Number(offset) || 0))
  const end = Math.min(entries.length, start + Math.max(1, Math.floor(Number(limit) || LIST_PAGE)))
  const shown = entries.slice(start, end)
  const rest = entries.length - end
  if (rest > 0) shown.push(`  … ${rest} more; continue with offset=${end}`)
  return shown
}

export function apply(ctx: HostContext, config: CoreConfig = {}) {
  const logger: Logger = (typeof ctx.logger === 'function' ? ctx.logger('tool-manager') : ctx.logger) ?? console
  // Values a UI may edit live in their own file, which wins per key over the
  // plugin config: an operator editing cordis.patch.yml must not have a stale
  // panel overwrite it on the next click, and a panel edit must not be undone
  // by the next restart.
  const settings = createSettingsStore({
    file: config.settingsFile ?? defaultSettingsFile(),
    base: { pinned: config.pinned, unpin: config.unpin, highRisk: config.highRisk },
    logger,
  })
  // Panel-edited tool metadata (group, category, risk, summary). Applied after
  // every other annotation, so an edit corrects a package declaration instead of
  // being overruled by it.
  const metadata = createMetadataStore({ file: config.metadataFile ?? defaultMetadataFile(), logger })
  // Model routes whose tool list is handed to an external client once per
  // session and never refreshed (Claude Code receives DSH tools through an MCP
  // bridge at startup). Narrowing such a session hides tools it can then never
  // load, and the client already lazy-loads schemas itself (ToolSearch), so
  // these agents are left unrestricted.
  //
  // The list in force comes from the exemption file when it exists, else from
  // config `exemptProviders` (default ["claude-code"]; [] restricts every
  // route). A file entry can also name a single session id, so one session can
  // be exempted without touching the route it uses.
  const exemptions = createExemptStore({
    file: config.exemptFile ?? defaultExemptFile(),
    configProviders: config.exemptProviders ?? ['claude-code'],
    logger,
  })

  // Audit is deliberately process-local and bounded; no state provider persists it.
  const auditEntries: AuditEntry[] = []
  function recordAudit(entry: Omit<AuditEntry, 'at'>) {
    const row = { at: Date.now(), ...entry }
    auditEntries.push(row)
    if (auditEntries.length > 200) auditEntries.shift()
    ctx.emit('tool-catalog/audit', { entry: { ...row } })
  }
  function recordPauseChange(before: boolean) {
    const paused = settings.effective().paused
    if (paused !== before) recordAudit({ kind: 'config', agentId: '', summary: paused ? 'paused loading' : 'resumed loading', ok: true })
  }
  function pausedRefusal(agent: Agent, targets: readonly string[]): LoadRefusal | undefined {
    if (!settings.effective().paused) return undefined
    recordAudit({ kind: 'paused', agentId: String(agent.id), summary: `paused loading: ${targets.join(', ')}`, ok: false })
    return { ok: false, message: 'tool loading is paused; turn it back on in the tool panel' }
  }

  /** Session id used to match a per-session exemption, with the agent id as fallback. */
  function sessionIdOf(agent: Agent): string | undefined {
    const id = agent?.session?.id ?? agent?.id
    return id === undefined || id === null || id === '' ? undefined : String(id)
  }

  /** Why this agent is not narrowed, if it is not. */
  function exemptionOf(agent: Agent) {
    return exemptions.reasonFor(providerOf(agent), sessionIdOf(agent))
  }

  /** The route an agent's next request will use: latest model/selection, else its options. */
  const selectionScan = new WeakMap<object, { seq: number, provider: string | undefined }>() // session -> incremental scan
  function providerOf(agent: Agent): string | undefined {
    const session = agent?.session
    try {
      if (session && typeof session.eventAt === 'function' && Number.isInteger(session.seq)) {
        const memo = selectionScan.get(session) ?? { seq: 0, provider: undefined }
        for (let seq = memo.seq; seq < session.seq!; seq += 1) {
          const event = session.eventAt(seq)
          if (event?.type === 'model/selection' && event.data?.provider) memo.provider = event.data.provider
        }
        memo.seq = session.seq!
        selectionScan.set(session, memo)
        if (memo.provider) return memo.provider
      }
    } catch {
      // fall back to the agent's options
    }
    return agent?.options?.provider ?? session?.requestHeader?.()?.provider
  }

  // High-risk tools can be loaded individually only while at least one risk
  // gate (e.g. dsh-tool-ultra-risk-gate) is registered; the gate confirms the
  // load before it executes. With no gate, high-risk loads are refused.
  const riskGates = new Set<{ name: string }>()

  // Search fallbacks: extensions that can find tools the keyword match missed.
  // They run only when the keyword match was weak, so a clear query never
  // reaches a model, and a missing one is worth the extra call.
  const searchFallbacks = new Set<SearchFallback>()

  // Tool packs: installed packages of tools (essentials, web, MCP presets...).
  // Each is listed in the panel and loadable in one call as `pack:<id>`.
  // Short per-group notes in tools_ls (for example "[offline]" from a device plugin).
  const groupNotes = new Set<GroupNote>()
  const noteFor = (group: Group): string => {
    const parts: string[] = []
    for (const n of groupNotes) {
      try {
        const text = n.note(group)
        if (text) parts.push(text)
      } catch {
        // a broken note never breaks the listing
      }
    }
    return parts.length ? `  ${parts.join(' ')}` : ''
  }
  const toolPacks = new Map<string, ToolPack>()
  const packToolNames = (pack: ToolPack): string[] => {
    const names = [...getCatalog().tools.keys()]
    return names.filter((n) => pack.tools.some((m) => (typeof m === 'string' ? m === n : new RegExp(m.source, m.flags.replace('g', '')).test(n)))).sort()
  }
  const packItems = (pack: ToolPack): ToolPackItem[] => {
    try {
      return pack.items?.() ?? []
    } catch (error) {
      return [{ id: pack.id, state: 'failed', detail: `status unavailable: ${(error as Error).message}` }]
    }
  }

  // A tool's own toolUltra declaration (see pickToolUltra). A bad value is
  // warned about once per tool, not on every rebuild: the catalog is rebuilt
  // often, and the log is for the operator.
  const warnedToolUltra = new Set<string>()
  // Duplicate tool names (two plugins, or a pack tool and a host/other-plugin
  // tool, registered the same name) are warned about once per name, not on
  // every rebuild, for the same reason.
  const warnedShadowed = new Set<string>()
  function declaredMeta(schema: ToolSchema): ToolUltraMeta {
    if (schema.toolUltra === undefined) return {}
    const once = warnedToolUltra.has(schema.name) ? undefined : {
      warn: (message: string) => { warnedToolUltra.add(schema.name); logger.warn?.(message) },
    }
    return pickToolUltra(schema.toolUltra, schema.name, once)
  }

  const pinnedSet = () => {
    const current = settings.effective()
    const set = new Set([...DEFAULT_PINNED, ...current.pinned])
    for (const n of current.unpin) set.delete(n)
    for (const n of ENTRY_TOOLS) set.add(n)
    // A tool's own toolUltra.pinned declaration applies only when the user has
    // not set the tool explicitly: settings win over declarations.
    for (const schema of ctx.tools.schemas()) {
      const declared = declaredMeta(schema)
      if (declared.pinned === undefined) continue
      if (current.pinned.includes(schema.name) || current.unpin.includes(schema.name)) continue
      if (declared.pinned) set.add(schema.name)
      else set.delete(schema.name)
    }
    return set
  }

  /**
   * Configuration as one object for UIs. `extraPinned`/`unpinned` show the
   * settings file, so the panel edits exactly what it displays; `pinned` is the
   * resulting always-on set, defaults and entry tools included.
   */
  function configSnapshot() {
    const current = settings.effective()
    return {
      paused: current.paused,
      pinned: [...pinnedSet()],
      entryTools: [...ENTRY_TOOLS],
      extraPinned: [...current.pinned],
      unpinned: [...current.unpin],
      highRisk: [...current.highRisk],
      exemptProviders: [...exemptions.effective().providers],
      exemptSessions: [...exemptions.effective().sessions],
      exemptFile: exemptions.file,
      hasExemptFile: exemptions.present(),
      defaults: [...DEFAULT_PINNED],
      settingsFile: settings.file,
      // An empty file is not an override, so count keys rather than existence.
      hasSettings: Object.keys(settings.stored()).length > 0,
    }
  }

  /**
   * One tool's metadata plus every layer behind it, so the panel can show what
   * is declared, what was edited, and what the model actually gets. A tool that
   * is pinned away or not registered is reported as missing rather than absent,
   * so the UI can explain why there is nothing to edit.
   */
  function toolMetaSnapshot(name: string) {
    const entry = getCatalog().tools.get(name)
    const declared: ToolMeta = { ...annotationForLayers(name) }
    return {
      name,
      found: entry !== undefined,
      effective: entry?.annotation ?? declared,
      edited: metadata.get(name) ?? {},
      declared,
      group: entry?.group ?? declared.group ?? '',
      category: entry?.category ?? declared.category ?? '',
      summary: entry?.summary ?? declared.summary ?? '',
      highRisk: entry?.highRisk === true,
      path: entry ? `/${entry.category}/${entry.group}/${entry.short}` : '',
      missing: entry === undefined,
    }
  }

  /**
   * The declared metadata only: package.json first, runtime annotate() after,
   * then the tool's own toolUltra declaration, with panel edits left out so
   * the UI can tell the two apart.
   */
  function annotationForLayers(name: string): ToolMeta {
    manifestAnnotations ??= readManifestAnnotations(ctx, logger)
    const merged: ToolMeta = {}
    for (const annotation of [...manifestAnnotations, ...registries.annotations]) {
      const hit = typeof annotation.match === 'string' ? annotation.match === name : annotation.match.test(name)
      if (hit) Object.assign(merged, annotation.meta)
    }
    const schema = ctx.tools.schemas().find((s) => s.name === name)
    if (schema) Object.assign(merged, declaredMeta(schema))
    return merged
  }

  // --- catalog -----------------------------------------------------------------
  // The directory is built per agent: global tools plus tools registered in the
  // agent's ancestor scopes (its preset). In the DSH web profile most tools
  // live in a preset layer, so a global-only catalog would hide them without
  // listing them. Agents with the same tool set share one cached catalog.
  const catalogs = new Map<string, Catalog>()  // key (sorted names) -> catalog
  // One keyword-search index per catalog, so a plain-language query ("is my
  // phone charged") can still find a tool whose schema never says "charged".
  // It costs memory, not tokens: no schema is added and no tool is loaded.
  const searchIndex = new WeakMap<Catalog, Bm25<ToolEntry>>()
  // Estimated tokens of final tool results delivered to each agent. A WeakMap
  // keeps the ledger tied to agent lifetime; `tools/result` is observe-only.
  const resultTokensByAgent = new WeakMap<Agent, number>()
  let manifestAnnotations: Annotation[] | null = null
  const invalidate = () => { catalogs.clear() }
  const registries = createRegistries(() => {
    invalidate()
    visibility?.refresh()
  })

  // Keep the fallback outside the registry: plugins may register at any time,
  // but every registered resolver must get its original target before it does.
  const bareTargetResolver = {
    prefix: '',
    resolve(target: string, agent?: Agent) {
      if (!target || /[/:]/.test(target)) return undefined
      for (const prefix of ['pack:', 'cap:', 'device:']) {
        for (const resolver of registries.resolvers) {
          if (resolver.prefix !== prefix) continue
          try {
            const expanded = resolver.resolve(`${prefix}${target}`, agent)
            // Devices use [] for an unknown target; let normal lookup proceed.
            if (expanded == null || (Array.isArray(expanded) && !expanded.length)) continue
            return expanded
          } catch {
            // A failing resolver passes, just as in resolveTarget.
          }
        }
      }
      return undefined
    },
  }
  const resolveCatalogTarget = (catalog: Catalog, target: string, agent?: Agent) =>
    resolveTarget(catalog, target, [...registries.resolvers], agent, bareTargetResolver)

  function schemaOf(definition: { description?: string, parameters?: unknown }, name: string): ToolSchema {
    try {
      if (typeof ctx.tools.schemaOf === 'function') return ctx.tools.schemaOf(definition, false)
    } catch {
      // fall through to the public fields
    }
    return { name, description: definition.description ?? '', parameters: definition.parameters ?? {} }
  }

  /** Schemas of tools an agent inherits from its ancestor (preset) layers. */
  function inheritedSchemas(agent: Agent | undefined): ToolSchema[] {
    const layers = ctx.tools.layers
    if (!agent || typeof layers?.chainLayers !== 'function') return []
    const own = layers.peek?.(agent)
    const out: ToolSchema[] = []
    for (const layer of layers.chainLayers(agent)) {
      if (layer === own) continue
      for (const [name, definition] of layer.tools.entries()) out.push(schemaOf(definition, name))
    }
    return out
  }

  /** Catalog for one agent, or for the union of all live agents when omitted. */
  const getCatalog = (agent?: Agent): Catalog => {
    const pinned = pinnedSet()
    // Duplicate names: the first registration wins. The host's merged view is
    // added before the inherited (ancestor-layer) tools, so the host and the
    // earlier registration take priority over a later one. The kept entry is
    // marked `shadowed` so tools_ls and the panel can show the collision.
    const byName = new Map<string, ToolSchema>()
    const shadowed = new Set<string>()
    const addSchema = (s: ToolSchema) => {
      if (byName.has(s.name)) { shadowed.add(s.name); return }
      byName.set(s.name, s)
    }
    for (const s of ctx.tools.schemas()) addSchema(s)
    for (const a of agent ? [agent] : visibility.agents()) {
      for (const s of inheritedSchemas(a)) addSchema(s)
    }
    for (const name of shadowed) {
      if (!warnedShadowed.has(name)) {
        warnedShadowed.add(name)
        logger.warn?.(`tool-manager: duplicate tool name "${name}": keeping the first registration, shadowing the later one(s)`)
      }
    }
    const schemas = [...byName.values()].filter((s) => !pinned.has(s.name) && !HOST_RESERVED.includes(s.name))
    // The shadowed names join the key, so a collision appearing or going away
    // rebuilds the catalog instead of reusing a stale mark.
    const key = schemas.map((s) => s.name).concat([...shadowed].map((n) => `shadow:${n}`)).sort().join('\n')
    const cached = catalogs.get(key)
    if (cached) return cached
    ctx.emit('tool-catalog/before-rebuild', {})
    manifestAnnotations ??= readManifestAnnotations(ctx, logger)
    // A tool's own toolUltra declaration: after the package and runtime
    // annotations, so it beats them, and before the panel edits, so the
    // user's edits beat it.
    const declared = schemas.map((s) => ({ source: 'toolUltra', match: s.name, meta: declaredMeta(s) }))
      .filter((a) => Object.keys(a.meta).length > 0)
    const catalog = buildCatalog(schemas, {
      classifiers: [...registries.classifiers],
      // Package declarations first, runtime annotate() after, so runtime wins —
      // then the tool's own toolUltra declaration, and panel edits last of all,
      // so they win over everything.
      annotations: [...manifestAnnotations, ...registries.annotations, ...declared, ...metadata.annotations()],
      categories: Object.fromEntries(registries.categories),
      highRisk: settings.effective().highRisk,
    })
    for (const name of shadowed) {
      const entry = catalog.tools.get(name)
      if (entry) entry.shadowed = true
    }
    catalogs.set(key, catalog)
    searchIndex.set(catalog, buildSearchIndex(catalog))
    // A client that receives its tool list once per session cannot discover the
    // directory by asking, so it gets the index as a file instead. Written here,
    // after every rebuild, so it cannot drift from what tools_load would answer.
    // An empty path turns it off.
    const manifestFile = config.manifestFile ?? defaultManifestFile()
    if (manifestFile) syncManifest(catalog, manifestFile, logger)
    ctx.emit('tool-catalog/after-rebuild', { catalog })
    return catalog
  }

  const visibility = createVisibilityController(ctx, {
    pinned: () => [...pinnedSet()],
    entryTools: ENTRY_TOOLS,
    getFilters: () => [...registries.filters],
    getCatalog,
    // The catalog is rebuilt lazily after any registry change.
    invalidate,
    onStateChange: (agent, state) => ctx.emit('tool-catalog/state-changed', { agent, state }),
    isExempt: (agent) => exemptionOf(agent).exempt,
    logger,
  })

  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (agentCtx) => {
      agentCtx.effect(() => visibility.mount(agentCtx), 'tool-manager.visibility()')
    })
  } else {
    logger.warn?.('tool-manager: host has no ctx.inject; per-agent visibility is disabled')
  }
  ctx.effect(() => () => visibility.dispose(), 'tool-manager.dispose()')

  // Rescue a direct call of a hidden tool (see rescueHiddenCall). Runs before
  // dispatch resolves the name, so loading here makes the call succeed.
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec: PendingCall | undefined, next: () => unknown) => {
    const agent = exec?.agent
    if (!agent || pinnedSet().has(exec!.name) || ENTRY_TOOLS.includes(exec!.name)) return next()
    const refusal = await rescueHiddenCall(agent, exec!.name) ?? retryAfterRescue(exec!)
    if (refusal !== undefined) return { kind: 'deny', reason: refusal }
    return next()
  }), 'tool-manager.rescue-hidden-call()')

  // `tools/result` carries the deep-frozen final result after post-execute
  // policies. Observe it only: never mutate the result, never change the call.
  ctx.effect(() => ctx.on('tools/result', (exec: { agent?: Agent }, result: { content?: unknown }) => {
    const agent = exec?.agent
    if (!agent) return
    const cost = estimateTokens(result?.content ?? null)
    resultTokensByAgent.set(agent, (resultTokensByAgent.get(agent) ?? 0) + cost)
  }), 'tool-manager.result-tokens()')

  // DSH 0.2.2+ fixes the callable tools when a step starts (`exec.toolSet`), so
  // a tool loaded during the step only becomes callable from the next one.
  // The set is read-only by contract: say so, rather than let the host report
  // the tool as unknown. Older hosts resolve at dispatch and need nothing here.
  function retryAfterRescue({ agent, name, toolSet }: PendingCall): string | undefined {
    if (!toolSet || toolSet.view(agent).has(name)) return undefined
    if (!visibility.stateOf(agent!).loaded.has(name) || deniedFor(agent).has(name)) return undefined
    return `"${name}" was not loaded, so this call did not run. It is loaded now: call it again.`
  }

  // --- the toolCatalog service ---------------------------------------------------
  const service = {
    registerClassifier: registries.registerClassifier,
    annotate: registries.annotate,
    defineCategory: registries.defineCategory,
    registerVisibilityFilter: registries.registerVisibilityFilter,
    /**
     * Own a target prefix (`"cap:"`) in tools_load / tools_ls / tools_unload.
     * `resolve(target)` returns one or more ordinary targets to resolve
     * instead, or undefined to pass. Returns a disposer.
     */
    registerTargetResolver: registries.registerTargetResolver,
    /**
     * Let loaded state outlive the process (DSH restart). `load(agent)` returns
     * a serialized state or null, `save(agent, state)` receives plain JSON.
     * Returns a disposer. See dsh-tool-ultra-persist.
     */
    registerStateProvider: visibility.registerStateProvider,
    /**
     * Declare that a plugin confirms high-risk loads (normally by returning
     * {kind:'ask'} from tools/pre-execute for tools_load). Returns a disposer.
     */
    registerRiskGate(gate: RiskGate = {}): Disposer {
      const entry = { name: gate.name ?? 'anonymous' }
      riskGates.add(entry)
      return () => { riskGates.delete(entry) }
    },
    riskGates: () => [...riskGates].map((g) => g.name),
    /**
     * Add a fallback that can find what the keyword match missed (a small
     * model, say). It runs only when the keyword match was weak, so a good
     * query never reaches a model. Returns a disposer.
     */
    registerSearchFallback(fallback: SearchFallback): Disposer {
      if (typeof fallback !== 'function') throw new TypeError('registerSearchFallback: provide a function')
      searchFallbacks.add(fallback)
      return () => { searchFallbacks.delete(fallback) }
    },
    registerGroupNote(note: GroupNote): Disposer {
      if (typeof note?.note !== 'function') throw new TypeError('registerGroupNote: provide note(group)')
      const entry = { name: note.name ?? 'anonymous', note: note.note }
      groupNotes.add(entry)
      return () => { groupNotes.delete(entry) }
    },
    registerToolPack(pack: ToolPack): Disposer {
      const id = String(pack?.id ?? '')
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) throw new Error(`tool pack id "${id}" must be lowercase letters, digits and dashes`)
      const entry = { ...pack, id, tools: [...(pack.tools ?? [])] }
      toolPacks.set(id, entry)
      ctx.emit('tool-catalog/packs-changed', { id })
      return () => {
        if (toolPacks.get(id) === entry) toolPacks.delete(id)
        ctx.emit('tool-catalog/packs-changed', { id })
      }
    },
    toolPacks: () => [...toolPacks.values()].map((pack) => ({
      id: pack.id,
      title: pack.title,
      summary: pack.summary,
      source: pack.source,
      tools: packToolNames(pack),
      items: packItems(pack),
    })),
    /** Re-read package declarations and rebuild. */
    refresh() {
      manifestAnnotations = null
      invalidate()
      visibility.refresh()
    },
    /** Catalog as one agent sees it, or the union over live agents. */
    get: (agent?: Agent) => getCatalog(agent),
    resolve: (target: string, agent?: Agent) => resolveCatalogTarget(getCatalog(agent), target, agent),
    /** Loaded state of one agent: { loaded, groups, excluded, handoffGroups, handoffTools } (Sets). */
    stateOf: (agent: Agent) => visibility.stateOf(agent),
    /** Plain JSON of an agent's loaded state, for persistence plugins. */
    exportState: (agent: Agent) => visibility.exportState(agent),
    /** Replace an agent's loaded state (e.g. restored after a restart). */
    importState: (agent: Agent, state: Partial<SerializedState>) => visibility.importState(agent, state),
    allowFor: (agent: Agent) => visibility.allowFor(agent),
    deniedFor: (agent: Agent) => [...deniedFor(agent)],
    /** True when the agent's model route is in `exemptProviders` (never narrowed). */
    isExempt: (agent: Agent) => visibility.isExempt(agent),
    /** Why an agent is exempt, so the panel can label a route-wide exemption. */
    exemptionOf: (agent: Agent) => exemptionOf(agent),
    /**
     * Load/unload on behalf of an agent, through the same path as the entry
     * tools (hooks, vetoes, risk gates and persistence all apply). Returns the
     * same text the model would see. Intended for UI plugins such as
     * dsh-tool-ultra-panel.
     */
    load: (agent: Agent, targets: readonly string[], options?: LoadOptions) => loadTargets(agent, targets, options),
    unload: (agent: Agent, targets: readonly string[]) => unloadTargets(agent, targets),
    audit: () => auditEntries.slice().reverse().map((entry) => ({ ...entry })),
    clearAudit() {
      auditEntries.length = 0
      ctx.emit('tool-catalog/audit', {})
    },
    /** Live agents, each with its parent when it is a subagent. */
    agents: () => {
      // The parent lookup goes through the injected agents API: the plugin ctx
      // itself does not inject `agents`, and reading it there throws.
      // The session title (a Bot's name, set by ds-bot) is read through the
      // session-title service so the panel can label each session.
      const titles = ctx.get?.('sessionTitle') as { get?(session: unknown): { title?: string } | undefined } | undefined
      return visibility.agents().map((agent) => {
        const parent = visibility.parentOf(agent)
        const title = agent.session ? titles?.get?.(agent.session)?.title : undefined
        // The agent's model route (provider/model), when the host exposes it.
        const options = (agent as { options?: { provider?: string, model?: string } }).options
        const model = options?.model ? `${options.provider ?? ''}${options.provider ? '/' : ''}${options.model}` : options?.provider
        return { agent, id: String(agent.id), parentId: parent ? String(parent.id) : null, title, model }
      })
    },
    /** Effective configuration, for UI display and editing. */
    config: () => configSnapshot(),
    /**
     * Persist UI-edited settings and apply them at once. The catalog is rebuilt
     * because a changed always-on or high-risk list changes every directory.
     */
    updateConfig(patch) {
      const wasPaused = settings.effective().paused
      settings.update(patch)
      recordPauseChange(wasPaused)
      invalidate()
      visibility.refresh()
      ctx.emit('tool-catalog/settings-changed', { config: configSnapshot() })
      return configSnapshot()
    },
    /** Re-read the settings file, for after an external edit. */
    reloadConfig() {
      const wasPaused = settings.effective().paused
      settings.reload()
      recordPauseChange(wasPaused)
      invalidate()
      visibility.refresh()
      ctx.emit('tool-catalog/settings-changed', { config: configSnapshot() })
      return configSnapshot()
    },
    /**
     * Exempt one session from narrowing, or stop exempting it. Written to the
     * exemption file, so the choice survives a restart and is reversible by
     * editing or deleting that one file.
     */
    setExemptSession(sessionId: string, exempt: boolean) {
      exemptions.setSession(String(sessionId), exempt)
      // An exemption installs or lifts a restriction, so re-apply it now.
      visibility.refresh()
      ctx.emit('tool-catalog/settings-changed', { config: configSnapshot() })
      return configSnapshot()
    },
    /** Re-read the exemption file, for after an external edit. */
    reloadExempt() {
      exemptions.reload()
      visibility.refresh()
      ctx.emit('tool-catalog/settings-changed', { config: configSnapshot() })
      return configSnapshot()
    },
    /** Metadata of one tool, with the layers that decide each field. */
    toolMeta: (name: string) => toolMetaSnapshot(String(name)),
    /**
     * Edit metadata from the panel. The store wins over the package
     * declaration, and the catalog is rebuilt so the Directory tab moves the
     * tool at once.
     */
    updateToolMeta(name, meta) {
      metadata.set(String(name), meta)
      invalidate()
      visibility.refresh()
      ctx.emit('tool-catalog/metadata-changed', { name: String(name) })
      return toolMetaSnapshot(String(name))
    },
    /** Drop every edited field of one tool, falling back to its declaration. */
    clearToolMeta(name) {
      metadata.clear(String(name))
      invalidate()
      visibility.refresh()
      ctx.emit('tool-catalog/metadata-changed', { name: String(name) })
      return toolMetaSnapshot(String(name))
    },
    metadataFile: () => metadata.file,
    /** Enabled plugin packages on this host: `{ name, dir, manifest }[]`. */
    packages: () => listPluginPackages(ctx),
    /** Registered extension points, so a UI can show what is active. */
    extensions: () => ({
      classifiers: [...registries.classifiers].map((c) => ({ name: c.name, priority: c.priority ?? 0 })),
      filters: [...registries.filters].map((f) => f.name),
      annotations: registries.annotations.map((a) => ({ source: a.source, match: String(a.match) })),
      categories: [...registries.categories.keys()],
      riskGates: [...riskGates].map((g) => g.name),
      stateProviders: visibility.stateProviders(),
    }),
    /**
     * Structured cross-directory search for UIs: the same matching rules as
     * tools_ls(query), returned as data instead of text.
     */
    find: (query: string, path = '/') => {
      const cat = getCatalog()
      const node = resolveCatalogTarget(cat, path)
      if (node.kind === 'missing') return []
      return matchingTools(cat, node, query).slice(0, 200).map(toFoundTool)
    },
    /** Schema tokens actually sent for an agent: pinned tools plus its loaded set. */
    wireTokens: (agent: Agent) => {
      const visible = new Set(visibility.allowFor(agent) ?? [])
      const cat = getCatalog(agent)
      let tokens = 0
      for (const schema of ctx.tools.schemas(agent)) {
        if (!visible.has(schema.name)) continue
        tokens += cat.tools.get(schema.name)?.tokens ?? estimateTokens(schema)
      }
      return tokens
    },
    /** Registered tools, including always-on and entry tools, excluding host transports. */
    toolCounts: (agent: Agent) => ({
      installed: new Set([...ctx.tools.schemas(), ...inheritedSchemas(agent)].filter((s) => !HOST_RESERVED.includes(s.name)).map((s) => s.name)).size,
      visible: new Set(ctx.tools.schemas(agent).filter((s) => !HOST_RESERVED.includes(s.name)).map((s) => s.name)).size,
    }),
    /** Estimated tokens of final tool results delivered to this agent (not schema tokens). */
    resultTokens: (agent: Agent) => resultTokensByAgent.get(agent) ?? 0,
  } satisfies ToolCatalogService
  // `pack:<id>` in tools_load / tools_unload resolves to the pack's current tools.
  ctx.effect(() => registries.registerTargetResolver({
    name: 'tool-packs',
    prefix: 'pack:',
    resolve(target) {
      const pack = toolPacks.get(target.slice('pack:'.length).trim())
      return pack ? packToolNames(pack) : undefined
    },
  }), 'tool-manager.tool-packs()')

  ctx.provide('toolCatalog', service)
  // Same service under the Tool Ultra name. Extensions may inject either;
  // `toolCatalog` stays the documented name so existing extensions keep working.
  ctx.provide('toolUltra', service)

  // --- the retrieval + routing layer ---------------------------------------------
  //
  // The router reuses the toolCatalog service just provided: it indexes the same
  // catalog, loads through the same path, and reports the same token budget. It
  // adds tools_find / tools_route / skills_find / skills_route on top of the
  // directory tools above.
  registerRouter(ctx, config, service)

  // --- direct calls of a hidden tool -----------------------------------------------
  //
  // A tool this plugin hid is still a registered tool: the model may call it by
  // name, and the host would answer "unknown tool" — which reads like a broken
  // plugin and, for a protocol tool a plugin's own prompt tells the model to
  // use, breaks the feature outright (a group Bot replying through group_relay,
  // for instance).
  //
  // So a direct call of a hidden tool is handled here, before dispatch:
  //   - an ordinary tool is loaded on the spot and the call proceeds;
  //   - a high-risk tool is refused with the exact load instruction, so it still
  //     has to go through the risk gate and its approval.
  // The cost is a few tokens when the model skips the directory; the benefit is
  // that forgetting to pin a protocol tool degrades instead of breaking.
  async function rescueHiddenCall(agent: Agent, name: string): Promise<string | undefined> {
    // allowFor() is null for an agent this plugin does not track (and for one
    // whose context cannot restrict at all): nothing to rescue there.
    if (visibility.allowFor(agent) === null) return undefined
    const state = visibility.stateOf(agent)
    if (state.loaded.has(name)) return undefined
    // Only tools this plugin manages: pinned tools and entry tools are always
    // visible, and anything else is hidden by the host or another plugin, which
    // is not ours to override.
    const catalog = getCatalog(agent)
    const tool = catalog.tools.get(name)
    if (!tool) return undefined
    // Group-loaded tools are already callable even when absent from state.loaded.
    if (settings.effective().paused && visibility.allowFor(agent)?.includes(name)) return undefined
    const paused = pausedRefusal(agent, [name])
    if (paused) return paused.message
    if (tool.highRisk) {
      return `"${name}" is high risk and is not loaded. Load it first with tools_load(["${name}"]), which asks for approval.`
    }
    // An auto-load is still a load: a before-load veto must stop it too.
    try {
      await ctx.serial('tool-catalog/before-load', { agent, targets: [name], names: [name], rescue: true })
    } catch (error) {
      return `Load of "${name}" refused: ${errorText(error)}`
    }
    const pausedAfterHook = pausedRefusal(agent, [name])
    if (pausedAfterHook) return pausedAfterHook.message
    visibility.update(agent, (next) => {
      next.loaded.add(name)
      next.excluded.delete(name)
    })
    // A visibility filter (or a connector deny) may still keep it out; say so
    // rather than letting the host report an unknown tool.
    if (!(visibility.allowFor(agent) ?? []).includes(name)) {
      // Undo the load, or a tool the session cannot see would sit in its state
      // (and be persisted) as if it had been loaded.
      visibility.update(agent, (next) => { next.loaded.delete(name) })
      return `"${name}" is not available in this session. Use tools_ls to see what is.`
    }
    recordAudit({ kind: 'load', agentId: String(agent.id), summary: name, ok: true })
    ctx.emit('tool-catalog/auto-loaded', { agent, name })
    return undefined
  }

  // --- tools another layer hides ---------------------------------------------------
  // Our allowlist intersects with every other restriction on the agent (MCP
  // connector governance, its per-session injection, other plugins), so a tool
  // can be pinned or loaded here and still never reach the model. The host's
  // final view tells them apart; without it nothing is reported.
  function deniedFor(agent: Agent | undefined): Set<string> {
    const allow = agent ? visibility.allowFor(agent) : null
    if (!agent || !allow || typeof ctx.tools.view !== 'function') return new Set()
    let visible: { has(name: string): boolean } | undefined
    try {
      visible = ctx.tools.view(agent).visible
    } catch {
      return new Set()
    }
    if (!visible) return new Set()
    const cat = getCatalog(agent)
    return new Set(allow.filter((name) => cat.tools.has(name) && !visible!.has(name)))
  }

  const warnedDenied = new Set<string>()
  function warnDenied(names: readonly string[]) {
    const fresh = names.filter((name) => !warnedDenied.has(name))
    if (!fresh.length) return
    for (const name of fresh) warnedDenied.add(name)
    logger?.warn?.(`tool-manager: loaded but hidden by another restriction: ${fresh.join(', ')}. If these are MCP tools, check the connector's governance rules and set the connection to "always inject" (per-session injection narrows on top of this plugin).`)
  }

  // --- listing -------------------------------------------------------------------
  function visibleSetFor(agent: Agent | undefined): Set<string> | null {
    const allow = agent ? visibility.allowFor(agent) : null
    return allow ? new Set(allow) : null
  }

  function toolLine(tool: ToolEntry, visible: Set<string> | null, denied: Set<string>, withPath = false): string {
    const marks = `${visible?.has(tool.name) ? '*' : ' '}${tool.highRisk ? '!' : ' '}`
    const label = withPath ? `/${tool.category}/${tool.group}/${tool.short}` : tool.short
    return `  ${marks} ${pad(label, withPath ? 48 : 34)}${pad(fmtTokens(tool.tokens), 11)}${denied.has(tool.name) ? '[denied] ' : ''}${tool.shadowed ? '[shadowed] ' : ''}${tool.summary}`
  }

  function listing(cat: Catalog, node: CatalogNode, visible: Set<string> | null, denied: Set<string> = new Set(), offset = 0, limit = LIST_PAGE): string {
    const count = (tools: readonly ToolEntry[]) => ({
      n: tools.length,
      loaded: tools.filter((t) => visible?.has(t.name)).length,
      tokens: tools.reduce((s, t) => s + t.tokens, 0),
    })
    const lines: string[] = []
    if (node.kind === 'root') {
      lines.push('/  (categories; * = loaded, ! = high risk, [denied] = loaded but blocked by another plugin; tools_ls with query searches everything)')
      const entries: string[] = []
      for (const category of cat.categories.values()) {
        const c = count(category.groups.flatMap((g) => g.tools))
        if (c.n === 0 && category.name !== UNCATEGORIZED) continue
        entries.push(`  ${pad(`${category.name}/`, 16)}${pad(`${c.n} tools`, 10)}${pad(`${c.loaded} loaded`, 11)}${pad(fmtTokens(c.tokens), 11)}${category.description}`)
      }
      lines.push(...pageLines(entries, offset, limit))
    } else if (node.kind === 'category') {
      lines.push(`/${node.category.name}/  ${node.category.description}`)
      const entries: string[] = []
      for (const group of node.category.groups) {
        const c = count(group.tools)
        entries.push(`  ${pad(`${group.name}/`, 22)}${pad(`${c.n} tools`, 10)}${pad(`${c.loaded} loaded`, 11)}${fmtTokens(c.tokens)}${noteFor(group)}`)
      }
      lines.push(...pageLines(entries, offset, limit))
    } else if (node.kind === 'group') {
      lines.push(`/${node.group.category}/${node.group.name}/${noteFor(node.group)}`)
      lines.push(...pageLines(node.group.tools.map((tool) => toolLine(tool, visible, denied)), offset, limit))
    } else if (node.kind === 'tool') {
      const t = node.tool
      lines.push(`/${t.category}/${t.group}/${t.short}`, `  name: ${t.name}`, `  ${t.summary}`, `  schema ${fmtTokens(t.tokens)}${t.highRisk ? ' · high risk: load it on its own' : ''}${visible?.has(t.name) ? ' · loaded' : ''}${denied.has(t.name) ? ' · denied by another plugin (e.g. an MCP connector rule): not callable' : ''}`)
    }
    return lines.join('\n')
  }

  /** Tools under `node` matching every word of `query` (name, group, category, description). */
  /** The text one tool is indexed by: everything a person might call it. */
  function searchText(tool: ToolEntry): string {
    return `${tool.name} ${tool.short} ${tool.group} ${tool.category} ${tool.summary} ${tool.description}`
  }

  /** Build the keyword index for one catalog. */
  function buildSearchIndex(catalog: Catalog): Bm25<ToolEntry> {
    const index = new Bm25<ToolEntry>()
    index.build([...catalog.tools.values()].map((tool) => ({ ref: tool, text: searchText(tool) })))
    return index
  }

  /** One tool as the directory reports it. */
  function toFoundTool(tool: ToolEntry): FoundTool {
    const out: FoundTool = {
      name: tool.name,
      short: tool.short,
      path: `/${tool.category}/${tool.group}/${tool.short}`,
      category: tool.category,
      group: tool.group,
      summary: tool.summary,
      tokens: tool.tokens,
      highRisk: tool.highRisk === true,
    }
    // Only present on a collision, so a duplicate-free directory is unchanged.
    if (tool.shadowed) out.shadowed = true
    return out
  }

  /** The strict keyword match: every word of the query appears in the text. */
  function keywordTools(cat: Catalog, node: CatalogNode, query: unknown): ToolEntry[] {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    return toolsUnder(cat, node).filter((t) => {
      const hay = `${t.name} ${t.group} ${t.category} ${t.description}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }

  /** The ranked guesses for a query the keyword match could not answer. */
  function rankedTools(cat: Catalog, node: CatalogNode, query: unknown): ToolEntry[] {
    const index = searchIndex.get(cat)
    if (!index) return []
    const under = toolsUnder(cat, node)
    const scope = new Set(under.map((t) => t.name))
    return index
      .search(String(query), 20)
      .map((hit) => hit.ref)
      .filter((tool) => scope.has(tool.name))
  }

  function matchingTools(cat: Catalog, node: CatalogNode, query: unknown): ToolEntry[] {
    const keyword = keywordTools(cat, node, query)
    if (keyword.length) return keyword
    // The keyword match found nothing: fall back to the ranked index, which
    // scores words instead of requiring all of them. Scoped to the same path,
    // so browsing a category still only returns that category.
    return rankedTools(cat, node, query)
  }

  /** A "did you mean" suffix for a target the catalog does not know. */
  function didYouMean(cat: Catalog, target: string): string {
    const suggestions = closestNames(cat, target)
    return suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''
  }

  /** The model-facing text for a set of hits. */
  function formatSearch(query: string, hits: ToolEntry[], visible: Set<string> | null, denied: Set<string> = new Set(), cat?: Catalog): string {
    if (!hits.length) {
      // A single-word query that names no tool may be a misspelling of one.
      const words = query.trim().split(/\s+/).filter(Boolean)
      return `No tools match "${query}".${words.length === 1 && cat ? didYouMean(cat, words[0]!) : ''}`
    }
    const shown = hits.slice(0, 40)
    return [`${hits.length} match(es) for "${query}" (load by path or full name):`, ...shown.map((t) => toolLine(t, visible, denied, true)), hits.length > shown.length ? `  … ${hits.length - shown.length} more; narrow the query or the path` : ''].filter(Boolean).join('\n')
  }

  function agentOf(exec: { agent?: unknown } | undefined): Agent {
    if (!exec?.agent) throw new Error('tool-manager: this tool must be called by an agent')
    return exec.agent as Agent
  }

  /**
   * Ask the registered fallbacks for more tools. It runs only when the keyword
   * match found nothing at all: a clear query never reaches a model, and only
   * a request the cheap paths could not read is worth the extra call. A
   * fallback that fails is skipped — a search must not break because an
   * extension had a bad day.
   */
  async function runSearchFallbacks(query: string, hits: FoundTool[]): Promise<FoundTool[]> {
    if (searchFallbacks.size === 0) return []
    const extra: FoundTool[] = []
    for (const fallback of searchFallbacks) {
      try {
        const more = await fallback(query, hits)
        if (more?.length) extra.push(...more)
      } catch (error) {
        logger.warn?.(`tool-manager: a search fallback failed: ${errorText(error)}`)
      }
    }
    return extra
  }

  // --- load / unload (shared by the entry tools and the toolCatalog service) -------

  /**
   * Subscribe an agent to targets. Runs the before-load hook (which may veto) and
   * returns the model-facing text; the panel calls this same path, so hooks
   * apply identically; risk-gate approval does not, since a panel click is
   * itself the user's consent.
   */
  async function loadTargets(agent: Agent, targets: readonly string[], { forSubagents = false }: LoadOptions = {}): Promise<string | LoadRefusal> {
    const paused = pausedRefusal(agent, targets)
    if (paused) return paused
    const cat = getCatalog(agent)
    // Report each target once: deduplicate on the trimmed name, keeping first
    // order, so a repeated name is resolved, loaded and reported a single time.
    const seen = new Set<string>()
    const nodes: { raw: string, node: CatalogNode }[] = []
    for (const raw of targets) {
      const key = String(raw).trim()
      if (seen.has(key)) continue
      seen.add(key)
      nodes.push({ raw: key, node: resolveCatalogTarget(cat, key, agent) })
    }
    const uniqueTargets = nodes.map(({ raw }) => raw)
    const names = nodes.flatMap(({ node }) => (node.kind === 'root' || node.kind === 'missing' ? [] : toolsUnder(cat, node).map((t) => t.name)))
    try {
      await ctx.serial('tool-catalog/before-load', { agent, targets: uniqueTargets, names })
    } catch (error) {
      return `Load refused: ${errorText(error)}`
    }
    const pausedAfterHook = pausedRefusal(agent, targets)
    if (pausedAfterHook) return pausedAfterHook
    const before = new Set(visibility.allowFor(agent) ?? [])
    const notes: string[] = []
    visibility.update(agent, (state) => {
      for (const { node } of nodes) {
        if (node.kind === 'missing' || node.kind === 'root') continue
        // An alias (e.g. a capability pack) names exact tools: add those, never
        // the whole group they happen to live in.
        if (node.kind === 'category' && node.category.aliasTools) {
          for (const tool of node.category.aliasTools) {
            if (tool.highRisk && riskGates.size === 0) {
              notes.push(`${tool.name} is high risk and no risk gate is installed to confirm it; not loaded`)
              continue
            }
            state.loaded.add(tool.name)
            state.excluded.delete(tool.name)
            if (forSubagents) state.handoffTools.add(tool.name)
          }
          continue
        }
        const groups = node.kind === 'category' ? node.category.groups : node.kind === 'group' ? [node.group] : []
        for (const group of groups) {
          state.groups.add(group.name)
          if (forSubagents) state.handoffGroups.add(group.name)
          for (const tool of group.tools) state.excluded.delete(tool.name)
          const risky = group.tools.filter((t) => t.highRisk).map((t) => t.short)
          if (risky.length) notes.push(`${group.name}: high-risk tools not included (${risky.join(', ')}); load them one by one`)
        }
        if (node.kind === 'tool') {
          if (node.tool.highRisk && riskGates.size === 0) continue
          state.loaded.add(node.tool.name)
          state.excluded.delete(node.tool.name)
          if (forSubagents) state.handoffTools.add(node.tool.name)
        }
      }
    })
    const after = visibility.allowFor(agent) ?? []
    const added = after.filter((n) => !before.has(n))
    recordAudit({ kind: 'load', agentId: String(agent.id), summary: uniqueTargets.join(', '), ok: true })
    ctx.emit('tool-catalog/after-load', { agent, targets: uniqueTargets, added })
    const denied = deniedFor(agent)
    const blocked = added.filter((n) => denied.has(n))
    const callable = added.filter((n) => !denied.has(n))
    if (blocked.length) warnDenied(blocked)
    const tokens = callable.reduce((sum, n) => sum + (cat.tools.get(n)?.tokens ?? 0), 0)
    // One line per target, so a mixed batch reports each target (loaded /
    // already loaded / not found / refused) instead of failing the whole call.
    const addedSet = new Set(added)
    const perTarget = nodes.map(({ raw, node }) => {
      if (node.kind === 'missing') return `skipped ${raw}: not found (try tools_ls with query)${didYouMean(cat, raw)}`
      if (node.kind === 'root') return `skipped ${raw}: cannot load the whole tree`
      if (node.kind === 'tool' && node.tool.highRisk && riskGates.size === 0 && !before.has(node.tool.name)) return `refused: ${raw} (high risk, no risk gate is installed to confirm it)`
      const tools = toolsUnder(cat, node)
      const newTools = tools.filter((t) => addedSet.has(t.name))
      if (newTools.length) {
        // Every tool this target added is blocked by another plugin: it is
        // loaded but not callable, so say denied instead of loaded.
        if (newTools.every((t) => denied.has(t.name))) return `denied: ${raw} (blocked by another plugin)`
        return `loaded: ${raw}`
      }
      // Nothing was added under this target. "already loaded" is only true when
      // every tool under it was already loaded before this call; a group of
      // high-risk tools (skipped) or one blocked by another plugin is not.
      if (tools.length && tools.every((t) => t.highRisk)) return `skipped ${raw}: only high-risk tools, load them one by one`
      if (tools.length && tools.every((t) => denied.has(t.name))) return `denied: ${raw} (blocked by another plugin)`
      if (tools.length && tools.every((t) => before.has(t.name))) return `already loaded: ${raw}`
      // Nothing was loaded and not everything was already loaded: the tools
      // were filtered out or are unavailable in this session.
      if (tools.every((t) => !t.highRisk && !denied.has(t.name) && !before.has(t.name))) return `skipped ${raw}: not available in this session`
      return `already loaded: ${raw}`
    })
    return [
      callable.length ? `Loaded ${callable.length} tool(s), ${fmtTokens(tokens)}; callable from your next step:` : 'Nothing new loaded.',
      ...callable.map((n) => `  ${n}`),
      ...(blocked.length ? [`Denied by another plugin (e.g. an MCP connector rule), not callable even when loaded: ${blocked.join(', ')}`] : []),
      ...perTarget,
      ...notes,
    ].join('\n')
  }

  /** Hide targets again. Returns the model-facing text. */
  async function unloadTargets(agent: Agent, targets: readonly string[]): Promise<string> {
    const cat = getCatalog(agent)
    // Report each target once: deduplicate on the trimmed name, keeping first
    // order, so a repeated name is resolved and reported a single time.
    const seen = new Set<string>()
    const nodes: { raw: string, all: boolean, node: CatalogNode }[] = []
    for (const raw of targets) {
      const key = String(raw).trim()
      if (seen.has(key)) continue
      seen.add(key)
      const all = key.toLowerCase() === 'all'
      nodes.push({ raw: key, all, node: all ? { kind: 'root' } : resolveCatalogTarget(cat, key, agent) })
    }
    const uniqueTargets = nodes.map(({ raw }) => raw)
    try {
      await ctx.serial('tool-catalog/before-unload', { agent, targets: uniqueTargets })
    } catch (error) {
      recordAudit({ kind: 'unload', agentId: String(agent.id), summary: uniqueTargets.join(', '), ok: false })
      return `Unload refused: ${errorText(error)}`
    }
    const before = new Set(visibility.allowFor(agent) ?? [])
    visibility.update(agent, (state) => {
      for (const { all, node } of nodes) {
        if (all) {
          for (const set of Object.values(state)) set.clear()
          continue
        }
        if (node.kind === 'category' && node.category.aliasTools) {
          for (const tool of node.category.aliasTools) {
            state.loaded.delete(tool.name)
            state.handoffTools.delete(tool.name)
          }
          continue
        }
        const groups = node.kind === 'category' ? node.category.groups : node.kind === 'group' ? [node.group] : []
        for (const group of groups) {
          state.groups.delete(group.name)
          state.handoffGroups.delete(group.name)
          for (const tool of group.tools) state.loaded.delete(tool.name)
        }
        if (node.kind === 'tool') {
          state.loaded.delete(node.tool.name)
          state.handoffTools.delete(node.tool.name)
          if (state.groups.has(node.tool.group)) state.excluded.add(node.tool.name)
        }
      }
    })
    const after = new Set(visibility.allowFor(agent) ?? [])
    const removed = [...before].filter((n) => !after.has(n))
    recordAudit({ kind: 'unload', agentId: String(agent.id), summary: uniqueTargets.join(', '), ok: true })
    ctx.emit('tool-catalog/after-unload', { agent, targets: uniqueTargets, removed })
    const removedSet = new Set(removed)
    // One line per target, so a mixed batch reports each target (unloaded /
    // not loaded / not found) instead of only the tools that left.
    const perTarget = nodes.map(({ raw, all, node }) => {
      if (all) return removed.length ? `unloaded all: ${removed.length} tool(s)` : 'nothing was loaded'
      if (node.kind === 'missing') {
        // An always-on (pinned) tool is outside the directory, so it resolves
        // to missing; say it cannot be unloaded instead of "not found".
        if (pinnedSet().has(raw.replace(/^\/+/, ''))) return `${raw} is always on and cannot be unloaded`
        return `skipped ${raw}: not found (try tools_ls with query)${didYouMean(cat, raw)}`
      }
      if (node.kind === 'root') return `skipped ${raw}: cannot unload the whole tree (use "all")`
      const removedTools = toolsUnder(cat, node).filter((t) => removedSet.has(t.name))
      return removedTools.length ? `unloaded: ${raw}` : `not loaded: ${raw}`
    })
    return [
      removed.length ? `Unloaded ${removed.length} tool(s):` : 'Nothing was unloaded.',
      ...removed.map((n) => `  ${n}`),
      ...perTarget,
    ].join('\n')
  }

  // --- tools -----------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'tools_ls',
    description:
      'Browse every available tool as a directory: / lists categories, /<category> lists groups (a connector or plugin), /<category>/<group> lists tools with a one-line summary and schema size. Tools marked * are loaded (callable now). Most tools are hidden until loaded with tools_load. Pass query to search names and descriptions across the whole tree (or under path) in one step; search results are capped at 40, so narrow the query to see more. Directory listings longer than 50 entries are truncated with a hint; pass offset (and limit) to page through them (pagination applies to listings only, not to search results).',
    parameters: {
      path: { type: 'string', description: 'Directory path such as "/", "/code", "/code/github", or a group or tool name. Default "/".' },
      query: { type: 'string', description: 'Search words matched against tool name, group, category and description; searches everything under path.' },
      offset: { type: 'number', description: 'Skip this many entries of the listing (default 0); the truncation hint names the offset to continue with.' },
      limit: { type: 'number', description: `How many entries to show (default ${LIST_PAGE}).` },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cat = getCatalog(exec?.agent as Agent | undefined)
      const node = resolveCatalogTarget(cat, args.path ?? '/', exec?.agent as Agent | undefined)
      if (node.kind === 'missing') return `No such path: ${node.target}. Start from tools_ls("/") or search with tools_ls({query}).${didYouMean(cat, node.target)}`
      const agent = exec?.agent as Agent | undefined
      const visible = visibleSetFor(agent)
      const denied = deniedFor(agent)
      if (!args.query) return listing(cat, node, visible, denied, args.offset ?? 0, args.limit ?? LIST_PAGE)
      // The keyword match first; when it finds nothing, the ranked index
      // guesses, and a fallback (a small model) may say better.
      const keyword = keywordTools(cat, node, args.query)
      const hits = keyword.length ? keyword : rankedTools(cat, node, args.query)
      const extra = keyword.length ? [] : await runSearchFallbacks(args.query, hits.map(toFoundTool))
      if (extra.length) {
        const known = new Set(hits.map((t) => t.name))
        for (const found of extra) {
          if (known.has(found.name)) continue
          const tool = cat.tools.get(found.name)
          if (!tool) continue      // the fallback named a tool this catalog does not have
          hits.push(tool)
          known.add(tool.name)
        }
      }
      return formatSearch(args.query, hits, visible, denied, cat)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tools_load',
    description:
      'Make tools callable for the rest of this session. Each target is a group path ("/code/github"), a category ("/maps"), one tool by path or exact name ("mcp__github__get_file_contents"), or a whole tool pack ("pack:web"). Bare names try pack: → cap: → device:, first match only. Loading a group also includes tools the group gains later. Prefer one group load over many single tools. Loaded tools are available from your next step. Set forSubagents to also hand these targets to subagents you start afterwards. Every target is reported individually (loaded, already loaded, not found, or refused with the reason), so one bad name does not fail the rest of the batch.',
    parameters: {
      targets: { type: 'array', items: { type: 'string' }, required: true, description: 'Paths, group names or exact tool names.' },
      forSubagents: { type: 'boolean', description: 'Also give these targets to subagents started from now on.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const result = await loadTargets(agentOf(exec), args.targets ?? [], { forSubagents: args.forSubagents === true })
      return typeof result === 'string' ? result : result.message
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tools_unload',
    description:
      'Hide loaded tools again to keep context small. Targets use the same forms as tools_load; "all" returns to the always-on set. Always-on tools cannot be unloaded. Every target is reported individually (unloaded, not loaded, not found), so one bad name does not fail the rest of the batch.',
    parameters: {
      targets: { type: 'array', items: { type: 'string' }, required: true, description: 'Paths, group names, exact tool names, or "all".' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return unloadTargets(agentOf(exec), args.targets ?? [])
    },
  }))
}

/** Options for toolCatalog.load / tools_load. */
export interface LoadOptions {
  /** Also hand the targets to subagents started afterwards. */
  forSubagents?: boolean
}

/** The message of a thrown value, whatever was thrown. */
function errorText(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message ?? error)
}

export default { name, inject, apply }
