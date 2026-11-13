import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyPersist, defaultDir, name as persistName } from '../../packages/dsh-tool-ultra-persist/lib/index.js'
import { apply as applyGate, DEFAULT_HIGH_RISK, name as gateName } from '../../packages/dsh-tool-ultra-risk-gate/lib/index.js'
import { createRegistries } from '../../packages/dsh-tool-ultra-core/lib/service.js'
import { buildCatalog } from '../../packages/dsh-tool-ultra-core/lib/catalog.js'
import { createVisibilityController } from '../../packages/dsh-tool-ultra-core/lib/visibility.js'

/** Minimal Cordis-like context: effects, events, inject, provide. */
function makeCtx(services = {}) {
  const disposers = []
  const listeners = new Map()
  const ctx = {
    logger: () => ({ warn() {}, info() {}, debug() {} }),
    effect: (fn) => {
      const dispose = typeof fn === 'function' ? fn() : undefined
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    inject: (deps, fn) => fn(ctx),
    ...services,
  }
  return { ctx, disposers, listeners }
}

const agent = (id) => ({ id })

// --- persist ------------------------------------------------------------------
test('persist: saves and restores per-session state, ignoring empty state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tm-persist-'))
  try {
    const { ctx } = makeCtx()
    let provider = null
    ctx.toolCatalog = { registerStateProvider: (p) => { provider = p; return () => { provider = null } } }
    applyPersist(ctx, { dir })

    assert.equal(provider.name, 'persist')
    assert.equal(provider.load(agent('sess-1')), null, 'no file yet')

    const state = { loaded: ['a'], groups: ['g'], excluded: [], handoffGroups: [], handoffTools: [] }
    provider.save(agent('sess-1'), state)
    assert.deepEqual(provider.load(agent('sess-1')), state)

    // An empty state removes the file instead of keeping an empty record.
    provider.save(agent('sess-1'), { loaded: [], groups: [], excluded: [], handoffGroups: [], handoffTools: [] })
    assert.equal(provider.load(agent('sess-1')), null)

    // Sessions do not see each other's state.
    provider.save(agent('sess-2'), { loaded: ['b'] })
    assert.deepEqual(provider.load(agent('sess-2')), { loaded: ['b'] })
    assert.equal(provider.load(agent('sess-1')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persist: an agent without an id is a no-op, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tm-persist-'))
  try {
    const { ctx } = makeCtx()
    let provider = null
    ctx.toolCatalog = { registerStateProvider: (p) => { provider = p } }
    applyPersist(ctx, { dir })
    assert.equal(provider.load({}), null)
    provider.save({}, { loaded: ['a'] })
    assert.equal(readdirSync(dir).length, 0, 'nothing is written for an id-less agent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persist: write:false restores but never writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tm-persist-'))
  try {
    const state = { loaded: ['a'] }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${encodeURIComponent('sess-1')}.json`), JSON.stringify(state))
    const { ctx } = makeCtx()
    let provider = null
    ctx.toolCatalog = { registerStateProvider: (p) => { provider = p } }
    applyPersist(ctx, { dir, write: false })
    assert.deepEqual(provider.load(agent('sess-1')), state)
    provider.save(agent('sess-2'), { loaded: ['b'] })
    assert.equal(existsSync(join(dir, `${encodeURIComponent('sess-2')}.json`)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persist: enabled:false registers nothing', () => {
  const { ctx } = makeCtx()
  let registered = false
  ctx.toolCatalog = { registerStateProvider: () => { registered = true } }
  applyPersist(ctx, { enabled: false })
  assert.equal(registered, false)
})

test('persist: default dir follows DSH_HOME', () => {
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home-example'
  try {
    assert.equal(defaultDir(), join('/tmp/dsh-home-example', 'tool-manager', 'sessions'))
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
})

// --- risk gate ----------------------------------------------------------------
const CATALOG = {
  tools: new Map([
    ['merge_pull_request', { name: 'merge_pull_request', highRisk: true }],
    ['read_file', { name: 'read_file', highRisk: false }],
    ['my_custom_danger', { name: 'my_custom_danger', highRisk: true }],
    // In the built-in list, but the catalog does not flag it: only the built-in
    // list can catch this one.
    ['delete_branch', { name: 'delete_branch', highRisk: false }],
  ]),
}

function gateCtx(config, resolve) {
  let provider = null
  const { ctx, listeners } = makeCtx()
  ctx.toolCatalog = {
    registerRiskGate: (g) => { provider = g; return () => { provider = null } },
    annotate: () => () => {},
    get: () => CATALOG,
    resolve: resolve ?? ((raw) => (raw.startsWith('/') ? { kind: 'group', group: { name: 'g', tools: [...CATALOG.tools.values()] } } : { kind: 'tool', tool: CATALOG.tools.get(raw) })),
  }
  const api = applyGate(ctx, config)
  return { ctx, listeners, api, provider: () => provider }
}

const runGate = (listeners, exec) => listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))

test('risk gate: registers a gate and declares its name', () => {
  const { provider } = gateCtx({})
  assert.equal(provider().name, gateName)
})

test('risk gate: ordinary load passes straight through', async () => {
  const { listeners } = gateCtx({})
  const decision = await runGate(listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['read_file'] } })
  assert.deepEqual(decision, { kind: 'allow' })
})

test('risk gate: a declared high-risk tool asks for approval', async () => {
  const { listeners } = gateCtx({})
  const decision = await runGate(listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['merge_pull_request'] } })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /merge_pull_request/)
  assert.match(decision.displayReason.en, /high-risk/i)
})

test('risk gate: the built-in list covers GitHub write tools', () => {
  assert.ok(DEFAULT_HIGH_RISK.includes('merge_pull_request'))
  assert.ok(DEFAULT_HIGH_RISK.includes('delete_file'))
  // The built-in list alone is enough, even for a tool the catalog does not flag.
  const { listeners } = gateCtx({})
  return runGate(listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['delete_branch'] } })
    .then((decision) => assert.equal(decision.kind, 'ask'))
})

test('risk gate: config can add a tool, defaultHighRisk:false can drop the built-ins', async () => {
  const added = gateCtx({ highRisk: ['read_file'] })
  assert.equal((await runGate(added.listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['read_file'] } })).kind, 'ask')

  const only = gateCtx({ defaultHighRisk: false })
  assert.deepEqual(await runGate(only.listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['delete_branch'] } }), { kind: 'allow' })
  // A catalog declaration still counts.
  assert.equal((await runGate(only.listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['my_custom_danger'] } })).kind, 'ask')
})

test('risk gate: group loads do not ask, the core skips the group\'s high-risk tools', async () => {
  const { listeners } = gateCtx({})
  const decision = await runGate(listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['/some/group'] } })
  assert.deepEqual(decision, { kind: 'allow' })
})

test('risk gate: per-session allowlist skips the prompt', async () => {
  const one = gateCtx({ allow: { s1: ['merge_pull_request'] } })
  assert.deepEqual(await runGate(one.listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['merge_pull_request'] } }), { kind: 'allow' })
  assert.equal(one.api.allowedFor('s1', 'merge_pull_request'), true)
  assert.equal(one.api.allowedFor('s1', 'my_custom_danger'), false)
  // A different session is unaffected.
  assert.equal((await runGate(one.listeners, { name: 'tools_load', agent: agent('s2'), arguments: { targets: ['merge_pull_request'] } })).kind, 'ask')

  const all = gateCtx({ allow: { s1: true } })
  assert.deepEqual(await runGate(all.listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['merge_pull_request', 'my_custom_danger'] } }), { kind: 'allow' })
  assert.equal(all.api.allowedFor('s1', 'anything'), true)

  const wildcard = gateCtx({ allow: { '*': ['merge_pull_request'] } })
  assert.deepEqual(await runGate(wildcard.listeners, { name: 'tools_load', agent: agent('s9'), arguments: { targets: ['merge_pull_request'] } }), { kind: 'allow' })
})

test('risk gate: an allowlist entry that names only one tool still prompts for another', async () => {
  const { listeners } = gateCtx({ allow: { s1: ['merge_pull_request'] } })
  const decision = await runGate(listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: ['merge_pull_request', 'my_custom_danger'] } })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /my_custom_danger/)
})

test('risk gate: other tools are never touched', async () => {
  const { listeners } = gateCtx({})
  assert.deepEqual(await runGate(listeners, { name: 'bash', agent: agent('s1'), arguments: { command: 'rm -rf /' } }), { kind: 'allow' })
})

test('risk gate: enabled:false registers nothing', () => {
  const { ctx } = makeCtx()
  let registered = false
  ctx.toolCatalog = { registerRiskGate: () => { registered = true }, annotate: () => { registered = true }, get: () => CATALOG, resolve: () => ({ kind: 'missing' }) }
  applyGate(ctx, { enabled: false })
  assert.equal(registered, false)
})

// The gate's list must reach the core catalog: the core skips high-risk tools
// in group loads and refuses to auto-load them on a direct call, but it only
// knows what the catalog says.
function gateWithRealCatalog(config) {
  const registries = createRegistries(() => {})
  const { ctx } = makeCtx()
  ctx.toolCatalog = {
    registerRiskGate: () => () => {},
    annotate: registries.annotate,
    get: () => CATALOG,
    resolve: () => ({ kind: 'missing' }),
  }
  applyGate(ctx, config)
  const schemas = ['mcp__github__merge_pull_request', 'mcp__github__get_me'].map((n) => ({ name: n, description: '' }))
  return buildCatalog(schemas, { annotations: registries.annotations })
}

test('risk gate: its list is annotated into the catalog, MCP names included', () => {
  const catalog = gateWithRealCatalog({})
  assert.equal(catalog.tools.get('mcp__github__merge_pull_request').highRisk, true)
  assert.equal(catalog.tools.get('mcp__github__get_me').highRisk, false)
  // defaultHighRisk:false leaves nothing to annotate.
  assert.equal(gateWithRealCatalog({ defaultHighRisk: false }).tools.get('mcp__github__merge_pull_request').highRisk, false)
})

test('risk gate: a group load leaves the annotated tool out', () => {
  const catalog = gateWithRealCatalog({})
  const group = catalog.tools.get('mcp__github__get_me').group
  const a = agent('s1')
  const vis = createVisibilityController(
    { tools: { schemas: () => [...catalog.tools.keys()].map((n) => ({ name: n })) } },
    { pinned: () => new Set(), getCatalog: () => catalog },
  )
  vis.mount({ agents: { list: () => [a], get: () => undefined }, on: () => () => {} })
  vis.update(a, (next) => { next.groups.add(group) })
  assert.deepEqual(vis.allowFor(a), ['mcp__github__get_me'])
})

test('risk gate: bare names in the list and the allowlist match MCP-prefixed tools', async () => {
  const full = 'mcp__github__merge_pull_request'
  const asked = gateCtx({}, () => ({ kind: 'tool', tool: { name: full, highRisk: false } }))
  assert.equal((await runGate(asked.listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: [full] } })).kind, 'ask')

  const allowed = gateCtx({ allow: { s1: ['merge_pull_request'] } }, () => ({ kind: 'tool', tool: { name: full, highRisk: false } }))
  assert.deepEqual(await runGate(allowed.listeners, { name: 'tools_load', agent: agent('s1'), arguments: { targets: [full] } }), { kind: 'allow' })
  assert.equal(allowed.api.allowedFor('s1', full), true)
  assert.equal(allowed.api.allowedFor('s2', full), false)
})

test('persist and risk-gate export the expected plugin names', () => {
  assert.equal(persistName, 'tool-manager-persist')
  assert.equal(gateName, 'tool-manager-risk-gate')
})
