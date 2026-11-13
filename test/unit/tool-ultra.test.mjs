import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../packages/dsh-tool-ultra-core/lib/index.js'
import { pickToolUltra, RISK_LEVELS } from '../../packages/dsh-tool-ultra-core/lib/catalog.js'

test('pickToolUltra keeps valid fields and normalizes the category', () => {
  assert.deepEqual(pickToolUltra({ category: '/memory', risk: 'high', pinned: true }, 'x'), {
    category: 'memory', risk: 'high', pinned: true,
  })
  assert.deepEqual(pickToolUltra({ category: 'memory', risk: 'low' }, 'x'), { category: 'memory', risk: 'low' })
  assert.deepEqual(pickToolUltra({ pinned: false }, 'x'), { pinned: false })
  assert.deepEqual(pickToolUltra(undefined, 'x'), {})
  assert.deepEqual(pickToolUltra({}, 'x'), {})
  assert.deepEqual(RISK_LEVELS, ['low', 'medium', 'high'])
})

test('pickToolUltra drops invalid values and reports them', () => {
  const warnings = []
  const logger = { warn: (m) => warnings.push(m) }
  assert.deepEqual(pickToolUltra({ category: 3, risk: 'critical', pinned: 'yes' }, 'bad', logger), {})
  assert.equal(warnings.length, 3)
  assert.ok(warnings.some((w) => w.includes('bad') && w.includes('category')))
  assert.ok(warnings.some((w) => w.includes('bad') && w.includes('risk')))
  assert.ok(warnings.some((w) => w.includes('bad') && w.includes('pinned')))
  // A non-object declaration is dropped as a whole.
  assert.deepEqual(pickToolUltra('memory', 'bad', logger), {})
  assert.equal(warnings.length, 4)
  // Valid fields next to invalid ones are kept.
  assert.deepEqual(pickToolUltra({ category: '/code', risk: 'nope' }, 'mix', logger), { category: 'code' })
  assert.equal(warnings.length, 5)
})

// A host with a few tools, some of them carrying a toolUltra declaration.
function host(t, definitions) {
  const dir = mkdtempSync(join(tmpdir(), 'b5-toolultra-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const listeners = new Map()
  const disposers = []
  const on = (event, fn) => {
    const handlers = listeners.get(event) ?? []
    listeners.set(event, [...handlers, fn])
    return () => listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== fn))
  }
  const effect = (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) }
  t.after(() => disposers.reverse().forEach((dispose) => dispose()))
  const restrictions = new Set()
  const agent = { id: 'session-toolultra', options: { provider: 'fake' }, ctx: { tools: { restrict: ({ allow }) => { const entry = new Set(allow); restrictions.add(entry); return () => restrictions.delete(entry) } } } }
  const services = {}
  const warnings = []
  const ctx = {
    logger: () => ({ warn: (m) => warnings.push(m), info() {}, debug() {} }),
    tools: {
      schemas: (scope) => [...definitions.values()].filter((def) => !scope || [...restrictions].every((allow) => allow.has(def.name))),
      register: (def) => { definitions.set(def.name, def); return () => definitions.delete(def.name) },
    },
    effect, on,
    emit: (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args) },
    serial: async (event, ...args) => { for (const fn of listeners.get(event) ?? []) await fn(...args) },
    provide: (name, service) => { services[name] = service },
    inject: (_deps, fn) => fn({ agents: { list: () => [agent], get: () => undefined }, effect, on }),
    get: () => undefined,
  }
  apply(ctx, { settingsFile: join(dir, 'settings.json'), metadataFile: join(dir, 'metadata.json'), exemptFile: join(dir, 'exempt.json'), manifestFile: '', sidecar: { bin: '/nonexistent' } })
  // Registration finishes after the initial visibility mount, as in host startup.
  services.toolCatalog.refresh()
  // Register a tool after startup, the way a late MCP connection or a freshly
  // installed plugin does: the host adds the schema and emits tools/change.
  const register = (def) => { ctx.tools.register(def); ctx.emit('tools/change') }
  // The tools the host would actually hand the agent: the installed restriction.
  const visibleFor = (scope) => ctx.tools.schemas(scope).map((def) => def.name)
  return { catalog: services.toolCatalog, agent, warnings, register, visibleFor }
}

test('a declared category places the tool in that category', (t) => {
  const definitions = new Map([
    ['memory_note', { name: 'memory_note', description: 'Store a note.', parameters: {}, toolUltra: { category: '/memory' } }],
    ['mcp__plain__do_thing', { name: 'mcp__plain__do_thing', description: 'Does things.', parameters: {} }],
  ])
  const { catalog } = host(t, definitions)
  const cat = catalog.get()
  assert.equal(cat.tools.get('memory_note').category, 'memory')
  assert.equal(cat.tools.get('mcp__plain__do_thing').category, 'uncategorized', 'no declaration keeps the existing logic')
  // The tool is reachable by its declared path.
  assert.equal(catalog.resolve('/memory/misc/memory_note').kind, 'tool')
})

test('a declared risk marks the tool high risk for the gate', async (t) => {
  const definitions = new Map([
    ['danger_tool', { name: 'danger_tool', description: 'Deletes things.', parameters: {}, toolUltra: { risk: 'high' } }],
    ['safe_tool', { name: 'safe_tool', description: 'Reads things.', parameters: {}, toolUltra: { risk: 'low' } }],
  ])
  const { catalog, agent } = host(t, definitions)
  const cat = catalog.get()
  assert.equal(cat.tools.get('danger_tool').highRisk, true)
  assert.equal(cat.tools.get('safe_tool').highRisk, false)
  // Without a gate, a high-risk load is refused through the existing path.
  const result = await catalog.load(agent, ['danger_tool'])
  assert.match(result, /high risk, no risk gate/)
})

test('a declared pinned tool is always on and not listed', (t) => {
  const definitions = new Map([
    ['always_on', { name: 'always_on', description: 'Used from prompts.', parameters: {}, toolUltra: { pinned: true } }],
  ])
  const { catalog, agent } = host(t, definitions)
  assert.ok(catalog.allowFor(agent).includes('always_on'), 'visible without a load')
  assert.equal(catalog.get().tools.has('always_on'), false, 'pinned tools are not listed')
})

test('a high-risk tool ignores its own pinned declaration (no risk gate)', async (t) => {
  const definitions = new Map([
    ['risky_pinned', { name: 'risky_pinned', description: 'Deletes things.', parameters: {}, toolUltra: { risk: 'high', pinned: true } }],
  ])
  const { catalog, agent } = host(t, definitions)
  // It is high risk, so its self-declared pin is ignored: not visible without a load.
  assert.ok(!catalog.allowFor(agent).includes('risky_pinned'), 'not visible without a load')
  assert.equal(catalog.get().tools.get('risky_pinned').highRisk, true, 'still high risk')
  // Without a gate, the load is refused through the existing path.
  const result = await catalog.load(agent, ['risky_pinned'])
  assert.match(result, /high risk, no risk gate/)
})

test('a self-declared low risk cannot lower an explicit high annotation', (t) => {
  const definitions = new Map([
    ['annotated', { name: 'annotated', description: 'Does things.', parameters: {}, toolUltra: { risk: 'low' } }],
  ])
  const { catalog } = host(t, definitions)
  // A runtime annotation marks it high risk; the self-declared low must not lower it.
  catalog.annotate('annotated', { risk: 'high' })
  assert.equal(catalog.get().tools.get('annotated').highRisk, true, 'the explicit annotation wins')
})

test('a self-declared high risk marks an ordinary tool high risk', (t) => {
  const definitions = new Map([
    ['plain', { name: 'plain', description: 'Does things.', parameters: {}, toolUltra: { risk: 'high' } }],
  ])
  const { catalog } = host(t, definitions)
  assert.equal(catalog.get().tools.get('plain').highRisk, true, 'the self-declaration raises the risk')
})

test('a user-pinned high-risk tool stays pinned', (t) => {
  const definitions = new Map([
    ['user_pinned', { name: 'user_pinned', description: 'Deletes things.', parameters: {}, toolUltra: { risk: 'high', pinned: true } }],
  ])
  const { catalog, agent } = host(t, definitions)
  // The user explicitly pins it in the settings; that wins over the high-risk rule.
  catalog.updateConfig({ pinned: ['user_pinned'] })
  assert.ok(catalog.allowFor(agent).includes('user_pinned'), 'the user pin wins')
})

test('user settings override a toolUltra declaration', (t) => {
  const definitions = new Map([
    ['memory_note', { name: 'memory_note', description: 'Store a note.', parameters: {}, toolUltra: { category: 'memory' } }],
    ['always_on', { name: 'always_on', description: 'Used from prompts.', parameters: {}, toolUltra: { pinned: true } }],
  ])
  const { catalog, agent } = host(t, definitions)
  assert.equal(catalog.get().tools.get('memory_note').category, 'memory')
  assert.ok(catalog.allowFor(agent).includes('always_on'))

  // The panel's metadata edit wins over the declared category.
  catalog.updateToolMeta('memory_note', { category: 'device' })
  assert.equal(catalog.get().tools.get('memory_note').category, 'device')

  // The settings unpin wins over the declared pinned.
  catalog.updateConfig({ unpin: ['always_on'] })
  assert.ok(!catalog.allowFor(agent).includes('always_on'))
  assert.equal(catalog.get().tools.has('always_on'), true, 'back in the directory')
})

test('invalid toolUltra values are ignored and logged once', (t) => {
  const definitions = new Map([
    ['bad_tool', { name: 'bad_tool', description: 'Bad declaration.', parameters: {}, toolUltra: { category: 3, risk: 'critical', pinned: 'yes' } }],
  ])
  const { catalog, agent, warnings } = host(t, definitions)
  const cat = catalog.get()
  assert.equal(cat.tools.get('bad_tool').category, 'uncategorized', 'falls back to the existing logic')
  assert.equal(cat.tools.get('bad_tool').highRisk, false)
  assert.ok(!catalog.allowFor(agent).includes('bad_tool'), 'not pinned')
  assert.ok(warnings.some((w) => w.includes('bad_tool') && w.includes('category')))
  assert.ok(warnings.some((w) => w.includes('bad_tool') && w.includes('risk')))
  assert.ok(warnings.some((w) => w.includes('bad_tool') && w.includes('pinned')))
  // The warning is not repeated on every rebuild.
  const before = warnings.length
  catalog.refresh()
  catalog.get()
  catalog.allowFor(agent)
  assert.equal(warnings.length, before)
})

// Like host(), but with real tool layers: the host's merged view (deduped by
// name, as in the real host) plus a preset (ancestor) layer the agents
// inherit, the way the DSH web profile registers most tools. `agentIds` are
// the live agents; the registered entry tools are captured so a test can call
// tools_ls directly.
function hostWithLayers(t, hostSchemas, presetTools, agentIds) {
  const dir = mkdtempSync(join(tmpdir(), 'b5-toolultra-dup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const listeners = new Map()
  const disposers = []
  const on = (event, fn) => {
    const handlers = listeners.get(event) ?? []
    listeners.set(event, [...handlers, fn])
    return () => listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== fn))
  }
  const effect = (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) }
  t.after(() => disposers.reverse().forEach((dispose) => dispose()))
  const restrictions = new Set()
  const agents = agentIds.map((id) => ({ id, options: { provider: 'fake' }, ctx: { tools: { restrict: ({ allow }) => { const entry = new Set(allow); restrictions.add(entry); return () => restrictions.delete(entry) } } } }))
  const services = {}
  const warnings = []
  const registered = new Map()
  // One shared preset layer, plus an (empty) own layer per agent, so
  // chainLayers(agent) is the preset followed by the agent's own layer.
  const presetLayer = { tools: new Map(presetTools) }
  const ownLayers = new Map(agents.map((a) => [a, { tools: new Map() }]))
  const ctx = {
    logger: () => ({ warn: (m) => warnings.push(m), info() {}, debug() {} }),
    tools: {
      schemas: () => hostSchemas,
      register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name) },
      layers: {
        chainLayers: (agent) => [presetLayer, ownLayers.get(agent)],
        peek: (agent) => ownLayers.get(agent),
      },
    },
    effect, on,
    emit: (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args) },
    serial: async (event, ...args) => { for (const fn of listeners.get(event) ?? []) await fn(...args) },
    provide: (name, service) => { services[name] = service },
    inject: (_deps, fn) => fn({ agents: { list: () => agents, get: () => undefined }, effect, on }),
    get: () => undefined,
  }
  apply(ctx, { settingsFile: join(dir, 'settings.json'), metadataFile: join(dir, 'metadata.json'), exemptFile: join(dir, 'exempt.json'), manifestFile: '', sidecar: { bin: '/nonexistent' } })
  services.toolCatalog.refresh()
  return { catalog: services.toolCatalog, agent: agents[0], warnings, registered }
}

test('an inherited tool with the same name but different content: first registration wins, warning logged, entry marked', (t) => {
  // The host's merged view and the agent's preset layer register the same
  // name with different content: a real collision. The host (first) version
  // must win.
  const hostSchemas = [
    { name: 'dup_tool', description: 'Host version.', parameters: {} },
    { name: 'unique_tool', description: 'Only one registration.', parameters: {} },
  ]
  const presetTools = new Map([['dup_tool', { name: 'dup_tool', description: 'Preset version.', parameters: {} }]])
  const { catalog, warnings } = hostWithLayers(t, hostSchemas, presetTools, ['session-dup'])
  const cat = catalog.get()
  // Only one entry, and it is the first registration (the host's).
  assert.equal(cat.tools.size, 2, 'the duplicate collapses to a single entry')
  assert.equal(cat.tools.get('dup_tool').description, 'Host version.')
  assert.equal(cat.tools.get('dup_tool').shadowed, true, 'the kept entry is marked')
  // The unique tool is not marked.
  assert.equal(cat.tools.get('unique_tool').shadowed, undefined)
  // A warning names the collision.
  assert.ok(warnings.some((w) => w.includes('dup_tool') && w.includes('duplicate')))
  // The warning is not repeated on every rebuild.
  const before = warnings.length
  catalog.refresh()
  catalog.get()
  assert.equal(warnings.length, before)
})

test('agents sharing one preset layer: the shared tools are not duplicates (no shadowed flag, no warning)', (t) => {
  // Two bots inherit the same preset layer; the host's view is deduped by
  // name, so the shared tools reach the catalog twice with identical content.
  const hostSchemas = [{ name: 'host_tool', description: 'Host tool.', parameters: {} }]
  const presetTools = new Map([['shared_tool', { name: 'shared_tool', description: 'Preset tool.', parameters: {} }]])
  const { catalog, warnings } = hostWithLayers(t, hostSchemas, presetTools, ['session-a', 'session-b'])
  const cat = catalog.get()
  assert.equal(cat.tools.size, 2, 'host tool plus the shared preset tool')
  for (const tool of cat.tools.values()) assert.equal(tool.shadowed, undefined, tool.name)
  assert.equal(warnings.filter((w) => w.includes('duplicate')).length, 0)
  // The structured find() result has no shadowed field.
  const found = catalog.find('shared_tool')
  assert.equal(found.length, 1)
  assert.equal(found[0].shadowed, undefined)
})

test('an inherited tool with the same name but different content: the shadowed flag reaches tools_ls and find()', async (t) => {
  const hostSchemas = [{ name: 'dup_tool', description: 'Host version.', parameters: {} }]
  const presetTools = new Map([['dup_tool', { name: 'dup_tool', description: 'Preset version.', parameters: {} }]])
  const { catalog, agent, registered } = hostWithLayers(t, hostSchemas, presetTools, ['session-dup'])
  // The tools_ls listing of the group shows the [shadowed] marker.
  const node = catalog.resolve('dup_tool')
  assert.equal(node.kind, 'tool')
  const listing = await registered.get('tools_ls').execute({ path: `/${node.tool.category}/${node.tool.group}` }, { agent })
  // The [shadowed] marker sits on the dup_tool line (before its summary).
  const line = listing.split('\n').find((l) => l.includes('dup_tool'))
  assert.ok(line, `dup_tool line missing:\n${listing}`)
  assert.ok(line.includes('[shadowed]'), `no [shadowed] marker:\n${listing}`)
  // The structured find() result carries the flag.
  const found = catalog.find('dup_tool')
  assert.equal(found.length, 1)
  assert.equal(found[0].shadowed, true)
})

test('no duplicate names: output is unchanged (no shadowed flag, no warning)', (t) => {
  const hostSchemas = [
    { name: 'alpha_tool', description: 'First.', parameters: {} },
    { name: 'beta_tool', description: 'Second.', parameters: {} },
  ]
  const { catalog, warnings } = hostWithLayers(t, hostSchemas, new Map(), ['session-dup'])
  const cat = catalog.get()
  for (const tool of cat.tools.values()) assert.equal(tool.shadowed, undefined, tool.name)
  assert.equal(warnings.filter((w) => w.includes('duplicate')).length, 0)
  // The structured find() result has no shadowed field.
  const found = catalog.find('alpha_tool')
  assert.equal(found.length, 1)
  assert.equal(found[0].shadowed, undefined)
})

test('a tool registered after startup is re-catalogued: classified, searchable, and joins a loaded group', async (t) => {
  const definitions = new Map([
    ['mcp__fake__ping', { name: 'mcp__fake__ping', description: 'Ping the fake server.', parameters: {} }],
    ['mcp__fake__echo', { name: 'mcp__fake__echo', description: 'Echo on the fake server.', parameters: {} }],
  ])
  const { catalog, agent, register, visibleFor } = host(t, definitions)
  // Load the fake group before the new tool exists.
  await catalog.load(agent, ['fake'])
  assert.ok(visibleFor(agent).includes('mcp__fake__ping'))
  assert.ok(!visibleFor(agent).includes('mcp__fake__fresh'), 'not there yet')

  // A late MCP connection (or a freshly installed plugin) adds a tool to the group.
  register({ name: 'mcp__fake__fresh', description: 'A tool the fake server gained later.', parameters: {} })

  // It is re-catalogued: classified into the group and a category.
  const entry = catalog.get().tools.get('mcp__fake__fresh')
  assert.ok(entry, 'the new tool is in the catalog')
  assert.equal(entry.group, 'fake', 'classified into the group by its name')
  assert.equal(entry.category, 'uncategorized', 'no classifier, so uncategorized')

  // It is searchable through the structured find() and through tools_ls(query).
  const found = catalog.find('fresh')
  assert.equal(found.length, 1)
  assert.equal(found[0].name, 'mcp__fake__fresh')
  const ls = await definitions.get('tools_ls').execute({ query: 'fresh' }, { agent })
  assert.ok(ls.includes('/uncategorized/fake/fresh'), `tools_ls(query) should list it:\n${ls}`)

  // The group loaded earlier now includes the new tool automatically: the host's
  // installed restriction is refreshed, so the tool is callable without a reload.
  assert.ok(visibleFor(agent).includes('mcp__fake__fresh'), 'a loaded group gains its new tool')
})