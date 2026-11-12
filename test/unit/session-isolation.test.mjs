import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../packages/dsh-tool-ultra-core/lib/index.js'

// A host with two live sessions (agents), each with its own restrictable tool
// view, mirroring bot mode where several Bots run concurrently. The loaded
// state must stay per session: a tools_load in one session never appears in
// another, and an unload in one never touches the other.
function twoSessionHost(t) {
  const dir = mkdtempSync(join(tmpdir(), 'b5-sess-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const definitions = new Map(['alpha_tool', 'beta_tool', 'read'].map((name) => [name, { name, description: name, parameters: {} }]))
  const listeners = new Map()
  const disposers = []
  const on = (event, fn) => {
    const handlers = listeners.get(event) ?? []
    listeners.set(event, [...handlers, fn])
    return () => listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== fn))
  }
  const effect = (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) }
  t.after(() => disposers.reverse().forEach((dispose) => dispose()))
  const makeAgent = (id) => {
    const restrictions = new Set()
    const agent = {
      id, options: { provider: 'fake' },
      ctx: { tools: {
        restrictions,
        restrict: ({ allow }) => { const entry = new Set(allow); restrictions.add(entry); return () => restrictions.delete(entry) },
      } },
    }
    // The allow list of the agent's live restriction, sorted.
    agent.active = () => [...restrictions].flatMap((s) => [...s]).sort()
    return agent
  }
  const agents = [makeAgent('session-a'), makeAgent('session-b')]
  const services = {}
  const ctx = {
    logger: () => ({ warn() {}, info() {}, debug() {} }),
    tools: {
      schemas: (scope) => {
        if (!scope) return [...definitions.values()]
        return [...definitions.values()].filter((def) => [...scope.ctx.tools.restrictions].every((allow) => allow.has(def.name)))
      },
      register: (def) => { definitions.set(def.name, def); return () => definitions.delete(def.name) },
    },
    effect, on,
    emit: (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args) },
    serial: async (event, ...args) => { for (const fn of listeners.get(event) ?? []) await fn(...args) },
    provide: (name, service) => { services[name] = service },
    inject: (_deps, fn) => fn({ agents: { list: () => agents, get: () => undefined }, effect, on }),
    get: () => undefined,
  }
  const settingsFile = join(dir, 'settings.json')
  apply(ctx, { settingsFile, metadataFile: join(dir, 'metadata.json'), exemptFile: join(dir, 'exempt.json'), manifestFile: '', sidecar: { bin: '/nonexistent' } })
  // Registration finishes after the initial visibility mount, as in host startup.
  services.toolCatalog.refresh()
  return {
    catalog: services.toolCatalog,
    agents,
    execute: (name, args = {}, agent) => definitions.get(name).execute(args, { agent }),
  }
}

test('two sessions interleave tools_load / tools_unload without leaking', async (t) => {
  const { catalog, agents, execute } = twoSessionHost(t)
  const [a, b] = agents

  // Each session starts with only the pinned tools; neither sees the other's tools.
  assert.ok(!a.active().includes('alpha_tool'))
  assert.ok(!b.active().includes('alpha_tool'))
  assert.ok(!a.active().includes('beta_tool'))
  assert.ok(!b.active().includes('beta_tool'))

  // Session A loads alpha_tool; session B loads beta_tool, interleaved.
  await execute('tools_load', { targets: ['alpha_tool'] }, a)
  assert.ok(a.active().includes('alpha_tool'), 'A sees its own load')
  assert.ok(!b.active().includes('alpha_tool'), 'A\'s load does not leak to B')

  await execute('tools_load', { targets: ['beta_tool'] }, b)
  assert.ok(b.active().includes('beta_tool'), 'B sees its own load')
  assert.ok(!a.active().includes('beta_tool'), 'B\'s load does not leak to A')

  // Both keep their own tools and only those.
  assert.ok(a.active().includes('alpha_tool'))
  assert.ok(!a.active().includes('beta_tool'))
  assert.ok(b.active().includes('beta_tool'))
  assert.ok(!b.active().includes('alpha_tool'))

  // Unload interleaved: each session unloads its own tool.
  await execute('tools_unload', { targets: ['alpha_tool'] }, a)
  assert.ok(!a.active().includes('alpha_tool'), 'A unloaded its own tool')
  assert.ok(b.active().includes('beta_tool'), 'B unaffected by A\'s unload')

  await execute('tools_unload', { targets: ['beta_tool'] }, b)
  assert.ok(!b.active().includes('beta_tool'), 'B unloaded its own tool')
  assert.ok(!a.active().includes('beta_tool'), 'A unaffected by B\'s unload')

  // The per-session state agrees with the active restriction.
  assert.equal(catalog.stateOf(a).loaded.size, 0)
  assert.equal(catalog.stateOf(b).loaded.size, 0)
})

test('a load in one session does not survive the other session unloading all', async (t) => {
  const { catalog, agents, execute } = twoSessionHost(t)
  const [a, b] = agents

  await execute('tools_load', { targets: ['alpha_tool'] }, a)
  await execute('tools_load', { targets: ['beta_tool'] }, b)
  assert.ok(a.active().includes('alpha_tool'))
  assert.ok(b.active().includes('beta_tool'))

  // "all" in one session clears only that session's state.
  await execute('tools_unload', { targets: ['all'] }, a)
  assert.ok(!a.active().includes('alpha_tool'), 'A cleared its own state')
  assert.ok(b.active().includes('beta_tool'), 'B keeps its own load after A unloads all')
  assert.equal(catalog.stateOf(b).loaded.size, 1)
})