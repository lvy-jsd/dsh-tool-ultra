// Types shared by the core modules and exported for extension plugins.
//
// The host surface is described structurally (only what this plugin touches)
// instead of importing the host's Cordis types, so the package type-checks
// without the host packages installed next to it.

// --- catalog -------------------------------------------------------------------

/** A tool schema as the host lists it. */
export interface ToolSchema {
  name: string
  description?: string
  parameters?: unknown
  [key: string]: unknown
}

/** Metadata a plugin can attach to tools (package.json `dsh.toolCatalog` or annotate()). */
export interface ToolMeta {
  group?: string
  category?: string
  risk?: string
  summary?: string
}

/** Risk levels a plugin can declare on its own tools. */
export type RiskLevel = 'low' | 'medium' | 'high'

/**
 * Optional self-declaration a plugin carries on each tool schema it registers
 * (the `toolUltra` field). The catalog prefers it over the classification
 * logic; user settings (metadata.json, settings.json) still win over it.
 */
export interface ToolUltraMeta {
  /** Category name, with or without a leading "/" (e.g. "memory" or "/memory"). */
  category?: string
  /** Risk level; "high" marks the tool high risk for the risk gate. */
  risk?: RiskLevel
  /** Always-on (pinned) tool, not listed in the directory. */
  pinned?: boolean
}

export interface Annotation {
  source?: string
  match: string | RegExp
  meta: ToolMeta
}

export interface ToolEntry {
  name: string
  /** Name inside its group (MCP routing prefix dropped). */
  short: string
  group: string
  /** Where the structural fallback alone would have put the tool. */
  fallbackGroup: string
  category: string
  summary: string
  description: string
  tokens: number
  highRisk: boolean
  annotation: ToolMeta
}

export interface Group {
  name: string
  category: string
  tools: ToolEntry[]
}

export interface Category {
  name: string
  description: string
  groups: Group[]
  /** Set on a synthetic alias node (several targets behind one name). */
  alias?: string[]
  /** The exact tools an alias stands for; load these, never their whole groups. */
  aliasTools?: ToolEntry[]
}

export interface Catalog {
  tools: Map<string, ToolEntry>
  groups: Map<string, Group>
  categories: Map<string, Category>
}

export type CatalogNode =
  | { kind: 'root' }
  | { kind: 'category', category: Category }
  | { kind: 'group', group: Group }
  | { kind: 'tool', tool: ToolEntry }
  | { kind: 'missing', target: string }

/** What a classifier sees of one tool. */
export interface ToolProbe {
  name: string
  description: string
  annotation: ToolMeta
}

/** What a classifier sees of one group. */
export interface GroupProbe {
  name: string
  tools: ToolProbe[]
}

export interface Classifier {
  name?: string
  priority?: number
  /** Group name for a tool, or undefined to pass. */
  group?(tool: ToolProbe): string | undefined
  /** Category for a group, or undefined to pass. */
  categorize?(group: GroupProbe): string | undefined
}

export interface VisibilityFilter {
  name?: string
  /** Names to keep out of `names`; may only narrow. */
  filter(agent: Agent, names: string[]): Iterable<string> | undefined | null
}

export interface TargetResolver {
  name?: string
  /** Targets starting with this prefix are offered to `resolve` first. */
  prefix?: string
  /**
   * One or more ordinary targets to resolve instead, or undefined to pass.
   * `agent` is the caller when known (tools_load, tools_ls), so a resolver can
   * answer per session (for example `device:current`).
   */
  resolve(target: string, agent?: Agent): string | string[] | undefined | null
}

/** A note shown after a group's line in tools_ls. */
export interface GroupNote {
  name?: string
  note(group: Group): string | undefined
}

/** A registry entry after registration (defaults filled in). */
export interface RegisteredResolver {
  name: string
  prefix: string
  resolve: TargetResolver['resolve']
}

export type Disposer = () => void

// --- per-agent state ---------------------------------------------------------

export interface LoadState {
  /** Individual tool names. */
  loaded: Set<string>
  /** Subscribed group names (tools the group gains later included). */
  groups: Set<string>
  /** Tools unloaded from inside a subscribed group. */
  excluded: Set<string>
  /** Groups handed to subagents started later. */
  handoffGroups: Set<string>
  /** Tools handed to subagents started later. */
  handoffTools: Set<string>
}

/** Plain JSON form of a LoadState (sorted arrays). */
export type SerializedState = { [K in keyof LoadState]: string[] }

export interface StateProvider {
  name?: string
  /** A serialized state for the agent, or null when there is none. */
  load?(agent: Agent): Partial<SerializedState> | null | undefined
  save?(agent: Agent, state: SerializedState): void
}

export interface RiskGate {
  name?: string
}

// --- host surface --------------------------------------------------------------

export interface Logger {
  debug?(message: string): void
  info?(message: string): void
  warn?(message: string): void
}

export interface SessionEvent {
  type?: string
  data?: { provider?: string, [key: string]: unknown }
}

export interface Session {
  id?: unknown
  seq?: number
  eventAt?(seq: number): SessionEvent | undefined
  requestHeader?(): { provider?: string } | undefined
}

/** An agent as this plugin uses it. */
export interface Agent {
  id: unknown
  options?: { provider?: string }
  session?: Session
  ctx?: {
    tools?: {
      restrict?(spec: { allow?: string[], deny?: string[] }): Disposer
    }
  }
}

export interface AgentsApi {
  list(): Agent[]
  get?(id: unknown): Agent | undefined
  isOwnedBy?(childId: unknown, candidate: Agent): boolean
}

/** Context a plugin receives once `agents` is injected. */
export interface AgentContext {
  agents: AgentsApi
  effect(fn: () => Disposer | void, label?: string): void
  // any: each event passes its own argument types, and a handler typed
  // (...args: unknown[]) would reject every concretely typed listener.
  on(event: string, handler: (...args: any[]) => unknown): Disposer
}

export interface ToolLayer {
  tools: Map<string, { description?: string, parameters?: unknown }>
}

export interface HostTools {
  schemas(agent?: Agent): ToolSchema[]
  register(definition: unknown): Disposer | void
  /** `visible` is what the agent ends up with after every layer's restrictions. */
  view?(agent: Agent): { restrictableNames: Iterable<string>, visible?: { has(name: string): boolean } }
  schemaOf?(definition: unknown, deferred: boolean): ToolSchema
  layers?: {
    chainLayers?(agent: Agent): Iterable<ToolLayer>
    peek?(agent: Agent): ToolLayer | undefined
  }
}

/** The tools a step may call, fixed when the step starts (DSH 0.2.2+). */
export interface StepToolSet {
  view(agent: Agent | undefined): { has(name: string): boolean }
}

/** The part of a pending call (`tools/pre-execute`) this plugin reads. */
export interface PendingCall {
  agent?: Agent
  name: string
  /** Absent on hosts that resolve the tool at dispatch (DSH 0.2.1). */
  toolSet?: StepToolSet
}

export interface LoaderEntry {
  options?: { name?: unknown, disabled?: boolean }
}

export interface Loader {
  entries?(): Iterable<LoaderEntry>
  baseUrl?: string
  ctx?: { baseUrl?: string }
}

/** The host context the core plugin is applied to. */
export interface HostContext {
  tools: HostTools
  logger?: ((name: string) => Logger) | Logger
  baseUrl?: string
  get?(name: string): unknown
  emit(event: string, ...args: unknown[]): void
  serial(event: string, ...args: unknown[]): Promise<unknown>
  // any: each event passes its own argument types, and a handler typed
  // (...args: unknown[]) would reject every concretely typed listener.
  on(event: string, handler: (...args: any[]) => unknown): Disposer
  effect(fn: () => Disposer | void, label?: string): void
  inject?(deps: string[], fn: (ctx: AgentContext) => void): void
  provide(name: string, service: unknown): void
}

/**
 * Settings a UI may edit at runtime. Each key is an independent list, so two
 * writers editing different keys cannot clobber each other.
 */
export interface AuditEntry {
  at: number
  kind: 'load' | 'unload' | 'config' | 'paused'
  agentId: string
  summary: string
  ok: boolean
}

export interface LoadRefusal { ok: false, message: string }

export interface ToolManagerSettings {
  /** Stop loading new tools; already-loaded tools remain usable. */
  paused?: boolean
  /** Extra always-on tools. */
  pinned?: string[]
  /** Tools removed from the default always-on list. */
  unpin?: string[]
  /** Tool names treated as high risk. */
  highRisk?: string[]
}

/** Configuration of the core plugin. */
export interface CoreConfig {
  /** Extra always-on tools. */
  pinned?: string[]
  /** Tools removed from the default always-on list. */
  unpin?: string[]
  /** Tool names treated as high risk. */
  highRisk?: string[]
  /** Model routes never narrowed (default ["claude-code"]). */
  exemptProviders?: string[]
  /**
   * Where UI-edited settings are persisted (default
   * <DSH_HOME>/tool-manager/config.json). Those values win over the fields
   * above, per key.
   */
  settingsFile?: string
  /**
   * Where UI-edited tool metadata is persisted (default
   * <DSH_HOME>/tool-manager/metadata.json).
   */
  metadataFile?: string
  /**
   * Where the plain-text tool manifest is written (default
   * ~/.claude/dsh-tool-catalog.md). Set to '' to turn it off.
   */
  manifestFile?: string
  /**
   * Where the exemption list is read from (default
   * <DSH_HOME>/tool-manager/exempt.json). When the file exists its `providers`
   * and `sessions` win over `exemptProviders` above; when it does not, the
   * config list is used.
   */
  exemptFile?: string
  // --- retrieval + routing (tools_find / tools_route / skills_find / skills_route) ---
  /** Model used to re-rank tools_route / skills_route candidates. */
  model?: { provider?: string; model?: string }
  /** Max tokens for the re-rank call. */
  maxTokens?: number
  /** Default number of results for the find/route tools. */
  topK?: number
  /** Token budget for loaded tool schemas, reported by tools_route. */
  maxBudget?: number
  /** BM25 parameters (JS fallback index). */
  k1?: number
  b?: number
  /** Rust sidecar overrides. */
  sidecar?: { bin?: string; socket?: string; timeoutMs?: number }
}

/** A plugin package the host loader knows. */
export interface PluginPackage {
  name: string
  dir: string
  manifest: string
}

// --- the toolCatalog service -----------------------------------------------------

/** A search hit from toolCatalog.find(). */
export interface FoundTool {
  name: string
  short: string
  path: string
  category: string
  group: string
  summary: string
  tokens: number
  highRisk: boolean
}

/**
 * A search fallback: the keyword match found too little, so an extension (a
 * small model, say) gets a chance to find more. It returns extra hits or
 * nothing; the core never lets it break a search.
 */
export type SearchFallback = (query: string, hits: FoundTool[]) => Promise<FoundTool[] | undefined>

/** Status of one part of a tool pack (an MCP preset, say). */
export interface ToolPackItem {
  id: string
  title?: string
  /** on: running; waiting: needs a key or setting; off: switched off; failed: tried and failed. */
  state: 'on' | 'waiting' | 'off' | 'failed'
  /** What is missing or what went wrong, without secrets. */
  detail?: string
}

/** An installed package of tools, registered with toolCatalog.registerToolPack(). */
export interface ToolPack {
  /** Short id, used as `pack:<id>` in tools_load. Lowercase letters, digits and dashes. */
  id: string
  title: string
  summary?: string
  /** npm package or URL the pack comes from. */
  source?: string
  /** Exact tool names or name patterns that belong to the pack. */
  tools: (string | RegExp)[]
  /** Optional per-part status, read each time a UI asks. */
  items?(): ToolPackItem[]
}

/** A tool pack as UIs see it: the tools it currently has, and its parts' status. */
export interface ToolPackSnapshot {
  id: string
  title: string
  summary?: string
  source?: string
  tools: string[]
  items: ToolPackItem[]
}

/** The service the core provides as `toolCatalog` (inject it to extend the catalog). */
export interface ToolCatalogService {
  registerClassifier(classifier: Classifier): Disposer
  annotate(match: string | RegExp, meta: ToolMeta): Disposer
  defineCategory(name: string, description?: string): Disposer
  registerVisibilityFilter(filter: VisibilityFilter): Disposer
  /** Own a target prefix (`"cap:"`) in tools_load / tools_ls / tools_unload. */
  registerTargetResolver(resolver: TargetResolver): Disposer
  /** Let loaded state outlive the process (see dsh-tool-ultra-persist). */
  registerStateProvider(provider?: StateProvider): Disposer
  /** Declare that a plugin confirms high-risk loads; without one they are refused. */
  registerRiskGate(gate?: RiskGate): Disposer
  riskGates(): string[]
  /**
   * Add a short note to group lines in tools_ls (for example "[offline]").
   * `note(group)` returns the text or undefined. Returns a disposer.
   */
  registerGroupNote(note: GroupNote): Disposer
  /** Register a tool pack: listed in the panel and loadable as `pack:<id>`. */
  registerToolPack(pack: ToolPack): Disposer
  /** Registered tool packs with their current tools and status. */
  toolPacks(): ToolPackSnapshot[]
  /** Re-read package declarations and rebuild. */
  refresh(): void
  /** Catalog as one agent sees it, or the union over live agents. */
  get(agent?: Agent): Catalog
  resolve(target: string, agent?: Agent): CatalogNode
  stateOf(agent: Agent): LoadState
  exportState(agent: Agent): SerializedState
  importState(agent: Agent, state: Partial<SerializedState>): void
  /** Names visible to the agent, or null when this plugin does not restrict it. */
  allowFor(agent: Agent): string[] | null
  /**
   * Names this plugin lets the agent see (pinned or loaded) that another layer
   * still hides: an MCP connector governance `deny` rule, the connector's
   * per-session injection, or any other plugin's `restrict()`. Empty when the
   * host cannot report the agent's final view.
   */
  deniedFor(agent: Agent): string[]
  /** True when the agent is never narrowed, by route or by its session id. */
  isExempt(agent: Agent): boolean
  /**
   * Why the agent is exempt, so the UI can tell a route-wide exemption from one
   * session: { exempt, source } with source 'file:provider' | 'file:session' |
   * 'config:provider' | ''.
   */
  exemptionOf(agent: Agent): { exempt: boolean, source: string }
  /** Load through tools_load; pause refusals are structured for UI callers. */
  load(agent: Agent, targets: readonly string[], options?: { forSubagents?: boolean }): Promise<string | LoadRefusal>
  unload(agent: Agent, targets: readonly string[]): Promise<string>
  /** Process-local timeline, newest first. */
  audit(): AuditEntry[]
  clearAudit(): void
  /** Live agents, each with its parent when it is a subagent. */
  agents(): { agent: Agent, id: string, parentId: string | null, title?: string, model?: string }[]
  /** Effective configuration, for UI display. */
  config(): {
    paused: boolean
    pinned: string[]
    entryTools: string[]
    extraPinned: string[]
    unpinned: string[]
    highRisk: string[]
    exemptProviders: string[]
    /** Session ids exempted for their own lifetime by the exemption file. */
    exemptSessions: string[]
    defaults: string[]
    /** Where UI edits are persisted. */
    settingsFile: string
    /** True when a settings file exists and overrides the plugin config. */
    hasSettings: boolean
    /** Where the exemption list is read from. */
    exemptFile: string
    /** True when the exemption file exists and overrides `exemptProviders`. */
    hasExemptFile: boolean
  }
  /**
   * Add or remove one session id in the exemption file and apply it at once.
   * The first call creates the file from the lists already in force, so entries
   * visible in the UI are never dropped by a write.
   */
  setExemptSession(sessionId: string, exempt: boolean): ReturnType<ToolCatalogService['config']>
  /** Re-read the exemption file, for after an external edit. */
  reloadExempt(): ReturnType<ToolCatalogService['config']>
  /**
   * Persist UI-edited settings (merged per key) and apply them at once. The
   * values win over the plugin config from the next call on. Returns the new
   * effective configuration, in the same shape as config().
   */
  updateConfig(patch: ToolManagerSettings): ReturnType<ToolCatalogService['config']>
  /** Re-read the settings file, for after an external edit. */
  reloadConfig(): ReturnType<ToolCatalogService['config']>
  /**
   * Metadata of one tool as the catalog currently shows it, including which
   * layer decided each field (`manifest`, `runtime`, `metadata` or `classifier`).
   */
  toolMeta(name: string): {
    name: string
    found: boolean
    /** Effective values after every layer. */
    effective: ToolMeta
    /** Values edited from the panel, which win over the layers above. */
    edited: ToolMeta
    /** Values from package.json and runtime annotate() calls. */
    declared: ToolMeta
    group: string
    category: string
    summary: string
    highRisk: boolean
    /** The tool's directory path, for linking back to the Directory tab. */
    path: string
    /** True when the tool is not in the catalog (unregistered or pinned away). */
    missing: boolean
  }
  /**
   * Replace the editable metadata of one tool. Fields left out are dropped, so
   * an emptied field falls back to the package declaration; an empty object
   * removes the override entirely.
   */
  updateToolMeta(name: string, meta: ToolMeta): ReturnType<ToolCatalogService['toolMeta']>
  /** Drop every edited field of one tool, falling back to its declaration. */
  clearToolMeta(name: string): ReturnType<ToolCatalogService['toolMeta']>
  /** Where edited metadata is persisted. */
  metadataFile(): string
  packages(): PluginPackage[]
  extensions(): {
    classifiers: { name: string, priority: number }[]
    filters: string[]
    annotations: { source: string | undefined, match: string }[]
    categories: string[]
    riskGates: string[]
    stateProviders: string[]
  }
  /** Structured cross-directory search (same matching as tools_ls with a query). */
  find(query: string, path?: string): FoundTool[]
  /**
   * Add a fallback that can find what the keyword match missed. It runs only
   * when the keyword match was weak, so a good query never reaches a model.
   */
  registerSearchFallback(fallback: SearchFallback): Disposer
  /** Schema tokens actually sent for an agent: pinned tools plus its loaded set. */
  wireTokens(agent: Agent): number
  /** Registered tools including always-on and entry tools, excluding host transports. */
  toolCounts(agent: Agent): { installed: number, visible: number }
  /** Estimated tokens of final tool results delivered to this agent (observe-only). */
  resultTokens(agent: Agent): number
}

/** What an extension plugin uses of its context after `inject: ['toolCatalog']`. */
export interface ExtensionContext extends Pick<HostContext, 'logger' | 'effect' | 'on'> {
  toolCatalog: ToolCatalogService
}
