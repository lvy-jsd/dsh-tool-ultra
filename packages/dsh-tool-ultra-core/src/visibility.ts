// Per-agent visibility: an allowlist installed with `agent.ctx.tools.restrict`.
//
//   allow(agent) = (pinned ∪ loaded tools ∪ tools of subscribed groups) − excluded
//                  ∩ names the host currently lets this agent's scope restrict
//
// An allowlist (not a denylist) means a tool that appears later — an MCP server
// reconnecting, a plugin installed, a tool renamed — stays hidden until loaded.
// Restrictions from other plugins (connector governance deny) intersect with
// ours, so a hard deny always wins.

import type { Agent, AgentContext, Catalog, Disposer, HostContext, LoadState, Logger, SerializedState, StateProvider } from './types.js'
import type { RegisteredFilter } from './service.js'

const STATE_KEYS = ['loaded', 'groups', 'excluded', 'handoffGroups', 'handoffTools'] as const

function emptyState(): LoadState {
  return {
    loaded: new Set(),      // individual tool names
    groups: new Set(),      // subscribed group names (future tools included)
    excluded: new Set(),    // tools unloaded from inside a subscribed group
    handoffGroups: new Set(),
    handoffTools: new Set(),
  }
}

/** Plain JSON form of one agent's state (sorted arrays). */
export function serializeState(state: LoadState): SerializedState {
  const out = {} as SerializedState
  for (const key of STATE_KEYS) out[key] = [...state[key]].sort()
  return out
}

/** Inverse of serializeState; unknown keys are ignored, values coerced to strings. */
export function deserializeState(raw: Partial<Record<keyof LoadState, Iterable<unknown>>> | null | undefined): LoadState {
  const state = emptyState()
  for (const key of STATE_KEYS) for (const value of raw?.[key] ?? []) state[key].add(String(value))
  return state
}

export interface VisibilityOptions {
  pinned: () => Iterable<string>
  entryTools?: readonly string[]
  getFilters?: () => readonly RegisteredFilter[]
  getCatalog: (agent?: Agent) => Catalog
  invalidate?: () => void
  onStateChange?: (agent: Agent, state: SerializedState) => void
  isExempt?: (agent: Agent) => boolean
  logger?: Logger
}

interface RegisteredProvider {
  name: string
  load: NonNullable<StateProvider['load']>
  save: NonNullable<StateProvider['save']>
}

export type VisibilityController = ReturnType<typeof createVisibilityController>

export function createVisibilityController(ctx: Pick<HostContext, 'tools'>, { pinned, entryTools = [], getFilters = () => [], getCatalog, invalidate, onStateChange, isExempt = () => false, logger }: VisibilityOptions) {
  const states = new Map<Agent, LoadState>()
  const installed = new Map<Agent, { key: string, dispose: Disposer }>()
  const providers: RegisteredProvider[] = []   // state providers (persistence plugins)
  const touched = new Set<Agent>()             // agents mutated by a load/unload
  const restoredAgents = new WeakSet<Agent>()
  const runtimeParents = new WeakMap<Agent, { parent: Agent, runId: string }>()
  let agentsApi: AgentContext['agents'] | null = null
  let syncing = false
  let disposed = false

  // --- names the host will accept in restrict() for this agent ------------
  function restrictableNames(agent: Agent): Set<string> {
    try {
      if (typeof ctx.tools.view === 'function') return new Set(ctx.tools.view(agent).restrictableNames)
    } catch (error) {
      logger?.debug?.(`tool-manager: view() unavailable: ${(error as Error).message}`)
    }
    return new Set(ctx.tools.schemas().map((s) => s.name))
  }

  function allowFor(agent: Agent): string[] {
    const state = states.get(agent)!
    const catalog = getCatalog(agent)
    const wanted = new Set(pinned())
    for (const name of state.loaded) wanted.add(name)
    for (const group of state.groups) {
      for (const tool of catalog.groups.get(group)?.tools ?? []) {
        if (!tool.highRisk && !state.excluded.has(tool.name)) wanted.add(tool.name)
      }
    }
    const known = restrictableNames(agent)
    let allow = [...wanted].filter((name) => known.has(name))
    // Extension filters may only narrow, and never hide the entry tools (the
    // model's way back to the directory).
    for (const { name, filter } of getFilters()) {
      try {
        const kept = new Set(filter(agent, [...allow]) ?? allow)
        allow = allow.filter((n) => kept.has(n) || entryTools.includes(n))
      } catch (error) {
        logger?.warn?.(`tool-manager: visibility filter ${name} failed: ${(error as Error).message}`)
      }
    }
    return allow.sort()
  }

  // restrict() emits tools/change synchronously, which re-enters install()
  // for the same agent before the outer call has recorded its disposer. A
  // nested install must not stack a second restriction (restrictions
  // intersect, and an orphan would hide every later load), so it only marks
  // the agent dirty and the outer call loops.
  const busy = new Set<Agent>()
  const dirty = new Set<Agent>()

  function install(agent: Agent) {
    if (!states.has(agent) || agent?.ctx?.tools?.restrict === undefined) return
    if (busy.has(agent)) {
      dirty.add(agent)
      return
    }
    busy.add(agent)
    try {
      do {
        dirty.delete(agent)
        installOnce(agent)
      } while (dirty.has(agent))
    } finally {
      busy.delete(agent)
    }
  }

  function installOnce(agent: Agent) {
    // An exempt agent (e.g. a Claude Code route, whose tool list is handed over
    // once at session start and never refreshed) gets no restriction at all; a
    // restriction installed before it switched route is lifted.
    if (isExempt(agent)) {
      installed.get(agent)?.dispose?.()
      installed.delete(agent)
      return
    }
    const allow = allowFor(agent)
    const key = allow.join('\n')
    const current = installed.get(agent)
    if (current?.key === key) return
    try {
      // New restriction first, then release the old one, so there is never a
      // moment with no restriction (which would expose every tool).
      const dispose = agent.ctx!.tools!.restrict!({ allow })
      installed.set(agent, { key, dispose })
      current?.dispose?.()
    } catch (error) {
      logger?.warn?.(`tool-manager: restrict agent ${String(agent?.id)} failed: ${(error as Error).message}`)
    }
  }

  function syncAll() {
    if (disposed || !agentsApi || syncing) return
    // restrict() emits tools/change synchronously; the nested event would only
    // rescan the same state.
    syncing = true
    try {
      for (const agent of agentsApi.list()) {
        if (!states.has(agent)) adopt(agent)
        install(agent)
      }
      const live = agentsApi.list()
      for (const agent of [...states.keys()]) if (!live.includes(agent)) forget(agent)
    } finally {
      syncing = false
    }
  }

  function parentOf(agent: Agent): Agent | undefined {
    const api = agentsApi
    if (typeof api?.isOwnedBy === 'function') {
      const legacy = api.list().find((candidate) => candidate !== agent && api.isOwnedBy!(agent.id, candidate))
      if (legacy) return legacy
    }
    const parent = runtimeParents.get(agent)?.parent
    return parent && api?.get?.(parent.id) === parent ? parent : undefined
  }

  /** State handed back by a provider, or null when none has any. */
  function stateFromProviders(agent: Agent): LoadState | null {
    for (const { name, load } of providers) {
      try {
        const raw = load(agent)
        if (raw) return deserializeState(raw)
      } catch (error) {
        logger?.warn?.(`tool-manager: state provider ${name} failed to load: ${(error as Error).message}`)
      }
    }
    return null
  }

  /** What an agent starts from: pinned tools plus the parent's handoff. */
  function fallbackState(agent: Agent): LoadState {
    const state = emptyState()
    const parent = parentOf(agent)
    const parentState = parent && states.get(parent)
    if (parentState) {
      for (const group of parentState.handoffGroups) state.groups.add(group)
      for (const tool of parentState.handoffTools) state.loaded.add(tool)
    }
    return state
  }

  function adopt(agent: Agent) {
    const saved = stateFromProviders(agent)
    if (saved) restoredAgents.add(agent)
    states.set(agent, saved ?? fallbackState(agent))
  }

  /** Save a state change through every provider (fire and forget). */
  function broadcast(agent: Agent, state: SerializedState) {
    for (const { name, save } of providers) {
      try {
        save(agent, state)
      } catch (error) {
        logger?.warn?.(`tool-manager: state provider ${name} failed to save: ${(error as Error).message}`)
      }
    }
  }

  /**
   * Register a state provider so loaded state can outlive the process (DSH
   * restart). `load(agent)` returns a serialized state or null; `save(agent,
   * state)` receives plain JSON. Returns a disposer.
   */
  function registerStateProvider(provider: StateProvider = {}): Disposer {
    const entry: RegisteredProvider = { name: provider.name ?? 'anonymous', load: provider.load ?? (() => null), save: provider.save ?? (() => {}) }
    providers.push(entry)
    // A persistence plugin normally mounts after this controller's first sync,
    // so agents already adopted from the fallback state (nothing loaded yet)
    // get one more chance to restore. An agent the user already changed is
    // never overwritten.
    for (const agent of [...states.keys()]) {
      if (touched.has(agent)) continue
      const restored = stateFromProviders(agent)
      if (restored) {
        // Keep persistence authoritative over a later residency-start event.
        restoredAgents.add(agent)
        states.set(agent, restored)
        install(agent)
      }
    }
    return () => {
      const i = providers.indexOf(entry)
      if (i >= 0) providers.splice(i, 1)
    }
  }

  function forget(agent: Agent) {
    states.delete(agent)
    touched.delete(agent)
    installed.get(agent)?.dispose?.()
    installed.delete(agent)
    runtimeParents.delete(agent)
    restoredAgents.delete(agent)
  }

  function mount(agentCtx: AgentContext): Disposer {
    agentsApi = agentCtx.agents
    const stops = [
      agentCtx.on('agent/created', ({ agent }: { agent: Agent }) => {
        invalidate?.()
        if (!states.has(agent)) adopt(agent)
        install(agent)
      }),
      agentCtx.on('agent/disposed', ({ agent }: { agent: Agent }) => forget(agent)),
      // DSH 0.2.2 no longer exposes agents.isOwnedBy(). Its subagent/start
      // event publishes the residency's direct creator before prompt delivery.
      // Do not infer authority from transcript headers or ambient initiators.
      agentCtx.on('subagent/start', (info: { id?: unknown, parentSessionId?: unknown, runId?: unknown, local?: boolean }) => {
        if (info?.local !== true || typeof info.runId !== 'string') return
        const child = agentsApi?.get?.(info.id)
        const parent = agentsApi?.get?.(info.parentSessionId)
        if (!child || !parent || child === parent) return
        runtimeParents.set(child, { parent, runId: info.runId })
        if (touched.has(child) || restoredAgents.has(child)) return
        states.set(child, fallbackState(child))
        install(child)
        onStateChange?.(child, serializeState(stateOf(child)))
      }),
      agentCtx.on('subagent/end', (info: { id?: unknown, runId?: unknown }) => {
        const child = agentsApi?.get?.(info?.id)
        if (child && runtimeParents.get(child)?.runId === info.runId) runtimeParents.delete(child)
      }),
      agentCtx.on('tools/change', () => { invalidate?.(); syncAll() }),
      // A route switch (model/selection) can make an agent exempt or not; it is
      // appended before the next request, so re-evaluate right away.
      agentCtx.on('session/event', (session: { id?: unknown } | undefined, event: { type?: string } | undefined) => {
        if (event?.type !== 'model/selection' && event?.type !== 'request/context') return
        const agent = agentsApi?.get?.(session?.id)
        if (agent && states.has(agent)) install(agent)
      }),
    ]
    // Agents that already exist (resumed before this plugin mounted).
    syncAll()
    return () => {
      for (const stop of stops) stop?.()
      for (const agent of [...installed.keys()]) forget(agent)
      agentsApi = null
    }
  }

  function stateOf(agent: Agent): LoadState {
    if (!states.has(agent)) adopt(agent)
    return states.get(agent)!
  }

  /** Apply a mutation to one agent's state, reinstall, and notify listeners. */
  function update<R>(agent: Agent, mutate: (state: LoadState) => R): R {
    const state = stateOf(agent)
    touched.add(agent)
    const result = mutate(state)
    install(agent)
    const plain = serializeState(state)
    broadcast(agent, plain)
    onStateChange?.(agent, plain)
    return result
  }

  /** Replace one agent's state (e.g. restored by a persistence plugin). */
  function importState(agent: Agent, raw: Parameters<typeof deserializeState>[0]) {
    states.set(agent, deserializeState(raw))
    install(agent)
  }

  return {
    mount,
    update,
    agents: (): Agent[] => agentsApi?.list() ?? [],
    parentOf,
    stateOf,
    registerStateProvider,
    stateProviders: () => providers.map((p) => p.name),
    exportState: (agent: Agent) => serializeState(stateOf(agent)),
    importState,
    // null for an agent this plugin does not restrict (untracked or exempt).
    allowFor: (agent: Agent): string[] | null => (states.has(agent) && !isExempt(agent) ? allowFor(agent) : null),
    isExempt: (agent: Agent) => isExempt(agent),
    refresh: syncAll,
    dispose() {
      disposed = true
      for (const agent of [...installed.keys()]) forget(agent)
    },
  }
}
