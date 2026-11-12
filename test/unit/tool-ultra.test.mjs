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
  return { catalog: services.toolCatalog, agent, warnings }
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

// Like host(), but `schemas()` returns the given list verbatim, so two
// "providers" can register the same tool name (the host dedupes by name, so
// the real host only surfaces a collision through the layer merge). The
// registered entry tools are captured so a test can call tools_ls directly.
function hostWithSchemas(t, schemas) {
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
  const agent = { id: 'session-dup', options: { provider: 'fake' }, ctx: { tools: { restrict: ({ allow }) => { const entry = new Set(allow); restrictions.add(entry); return () => restrictions.delete(entry) } } } }
  const services = {}
  const warnings = []
  const registered = new Map()
  const ctx = {
    logger: () => ({ warn: (m) => warnings.push(m), info() {}, debug() {} }),
    tools: {
      schemas: () => schemas,
      register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name) },
    },
    effect, on,
    emit: (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args) },
    serial: async (event, ...args) => { for (const fn of listeners.get(event) ?? []) await fn(...args) },
    provide: (name, service) => { services[name] = service },
    inject: (_deps, fn) => fn({ agents: { list: () => [agent], get: () => undefined }, effect, on }),
    get: () => undefined,
  }
  apply(ctx, { settingsFile: join(dir, 'settings.json'), metadataFile: join(dir, 'metadata.json'), exemptFile: join(dir, 'exempt.json'), manifestFile: '', sidecar: { bin: '/nonexistent' } })
  services.toolCatalog.refresh()
  return { catalog: services.toolCatalog, agent, warnings, registered }
}

test('duplicate tool names: first registration wins, warning logged, entry marked', (t) => {
  // Two providers register the same name; the host (first) version must win.
  const schemas = [
    { name: 'dup_tool', description: 'Host version.', parameters: {} },
    { name: 'dup_tool', description: 'Plugin version.', parameters: {} },
    { name: 'unique_tool', description: 'Only one registration.', parameters: {} },
  ]
  const { catalog, warnings } = hostWithSchemas(t, schemas)
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

test('duplicate tool names: the shadowed flag reaches tools_ls and find()', async (t) => {
  const schemas = [
    { name: 'dup_tool', description: 'Host version.', parameters: {} },
    { name: 'dup_tool', description: 'Plugin version.', parameters: {} },
  ]
  const { catalog, agent, registered } = hostWithSchemas(t, schemas)
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
  const schemas = [
    { name: 'alpha_tool', description: 'First.', parameters: {} },
    { name: 'beta_tool', description: 'Second.', parameters: {} },
  ]
  const { catalog, warnings } = hostWithSchemas(t, schemas)
  const cat = catalog.get()
  for (const tool of cat.tools.values()) assert.equal(tool.shadowed, undefined, tool.name)
  assert.equal(warnings.filter((w) => w.includes('duplicate')).length, 0)
  // The structured find() result has no shadowed field.
  const found = catalog.find('alpha_tool')
  assert.equal(found.length, 1)
  assert.equal(found[0].shadowed, undefined)
})