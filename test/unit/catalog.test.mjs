import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCatalog, resolveTarget, estimateTokens, UNCATEGORIZED } from '../../packages/dsh-tool-ultra-core/lib/catalog.js'
import { createRegistries, listPluginPackages, packageNameOf, readManifestAnnotations } from '../../packages/dsh-tool-ultra-core/lib/service.js'
import {
  rulesClassifier, groupCategoriesFrom, DEFAULT_GROUP_RULES, DEFAULT_GROUP_CATEGORIES, DEFAULT_EXTRA_CATEGORIES, USER_PRIORITY, DEFAULT_PRIORITY,
  apply as applyRules,
} from '../../packages/dsh-tool-ultra-classifier-rules/lib/index.js'
import { DEFAULT_CATEGORIES } from '../../packages/dsh-tool-ultra-core/lib/catalog.js'

const schemas = [
  'adb_install', 'adb_logcat', 'create_bot', 'list_bots', 'mcp__amap__maps_weather',
  'mcp__phone__android__mobile_tap', 'lingshu_cg', 'lingshu_stg', 'list_models',
].map((name) => ({ name, description: `${name} does things. More text.` }))

const defaults = rulesClassifier({ name: 'rules:defaults', priority: DEFAULT_PRIORITY, groupRules: DEFAULT_GROUP_RULES, groupCategories: DEFAULT_GROUP_CATEGORIES })
const category = (cat, tool) => cat.tools.get(tool).category
const group = (cat, tool) => cat.tools.get(tool).group

test('core alone: structural groups, everything uncategorized', () => {
  const cat = buildCatalog(schemas)
  for (const tool of cat.tools.values()) assert.equal(tool.category, UNCATEGORIZED)
  assert.equal(group(cat, 'adb_install'), 'adb')
  assert.equal(group(cat, 'mcp__amap__maps_weather'), 'amap')
  assert.equal(group(cat, 'mcp__phone__android__mobile_tap'), 'phone-android')
  assert.equal(group(cat, 'create_bot'), 'misc', 'verb prefixes never form a group')
})

test('rules plugin defaults place known groups', () => {
  const cat = buildCatalog(schemas, { classifiers: [defaults] })
  assert.equal(category(cat, 'adb_install'), 'device')
  assert.equal(group(cat, 'create_bot'), 'bots')
  assert.equal(category(cat, 'list_bots'), 'collaboration')
  assert.equal(category(cat, 'mcp__amap__maps_weather'), 'maps')
  assert.equal(category(cat, 'lingshu_cg'), UNCATEGORIZED, 'unknown groups stay uncategorized')
})

test('rules plugin defaults place common MCP server names', () => {
  const mcp = ['mcp__search__searxng_web_search', 'mcp__email__list_emails', 'mcp__email__send_email', 'mcp__playwright__browser_click', 'mcp__brave-search__web']
    .map((name) => ({ name, description: `${name} does things.` }))
  const cat = buildCatalog(mcp, { classifiers: [defaults], categories: { ...DEFAULT_CATEGORIES, ...DEFAULT_EXTRA_CATEGORIES } })
  assert.equal(category(cat, 'mcp__search__searxng_web_search'), 'search')
  assert.equal(category(cat, 'mcp__brave-search__web'), 'search')
  assert.equal(category(cat, 'mcp__email__send_email'), 'mail')
  assert.equal(category(cat, 'mcp__playwright__browser_click'), 'browser')
})

test('rules plugin defaults place third-party plugin tools', () => {
  const thirdParty = [
    'memory_list', 'memory_read', 'memory_search', 'memory_write', 'memory_delete', 'memory_delete_all', 'memory_prune',
    'dsh_delegation', 'dsh_editor_git_commit', 'dsh_docs', 'dsh_plugins',
    'dsh_editor_web_search', 'dsh_editor_session_manager', 'dsh_session_manager_retries',
    'cua',
    'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  ].map((name) => ({ name, description: `${name} does things.` }))
  const cat = buildCatalog(thirdParty, { classifiers: [defaults] })
  const expect = (tool, wantGroup, wantCategory) => {
    assert.equal(group(cat, tool), wantGroup, tool)
    assert.equal(category(cat, tool), wantCategory, tool)
  }
  for (const tool of ['memory_list', 'memory_read', 'memory_search', 'memory_write', 'memory_delete', 'memory_delete_all', 'memory_prune']) expect(tool, 'memory', 'memory')
  expect('dsh_delegation', 'delegation', 'collaboration')
  expect('dsh_editor_git_commit', 'git', 'code')
  expect('dsh_docs', 'dev-index', 'code')
  expect('dsh_plugins', 'dev-index', 'code')
  expect('dsh_editor_web_search', 'web-search', 'search')
  expect('dsh_editor_session_manager', 'session', 'collaboration')
  expect('dsh_session_manager_retries', 'session', 'collaboration')
  expect('cua', 'cua', 'device')
  for (const tool of ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list']) expect(tool, 'terminal', 'system')
  for (const tool of cat.tools.values()) assert.notEqual(tool.category, UNCATEGORIZED, tool.name)
})

test('rules plugin defines the categories its defaults use, and only with defaults on', () => {
  const run = (config) => {
    const defined = new Map()
    const ctx = {
      toolCatalog: {
        registerClassifier: () => () => {},
        defineCategory: (name, description) => { defined.set(name, description); return () => defined.delete(name) },
      },
      effect: (fn) => fn(),
    }
    const dispose = applyRules(ctx, config) ?? undefined
    return { defined, dispose }
  }
  const on = run({})
  for (const name of Object.keys(DEFAULT_EXTRA_CATEGORIES)) assert.ok(on.defined.has(name), name)
  assert.equal(on.defined.get('mail'), DEFAULT_EXTRA_CATEGORIES.mail)
  assert.equal(run({ defaults: false }).defined.size, 0)
  const own = run({ categories: { mail: { description: 'My mail', groups: ['post'] } } })
  assert.equal(own.defined.get('mail'), 'My mail', 'a user description wins over the default one')
})

test('plugin declaration beats default rules', () => {
  const cat = buildCatalog(schemas, {
    classifiers: [defaults],
    annotations: [{ match: /^adb_/, meta: { category: 'code' } }],
  })
  assert.equal(category(cat, 'adb_install'), 'code')
})

test('declared group and summary are used', () => {
  const cat = buildCatalog(schemas, {
    annotations: [{ match: /^lingshu_/, meta: { group: 'lingshu-engine', category: 'system', summary: 'Lingshu engine. Extra.' } }],
  })
  assert.equal(group(cat, 'lingshu_cg'), 'lingshu-engine')
  assert.equal(category(cat, 'lingshu_stg'), 'system')
  assert.equal(cat.tools.get('lingshu_cg').summary, 'Lingshu engine.')
})

test('user override beats plugin declaration', () => {
  const user = rulesClassifier({ name: 'rules:user', priority: USER_PRIORITY, groupCategories: groupCategoriesFrom({ media: { groups: ['adb'] } }) })
  const cat = buildCatalog(schemas, {
    classifiers: [defaults, user],
    annotations: [{ match: /^adb_/, meta: { category: 'code' } }],
  })
  assert.equal(category(cat, 'adb_install'), 'media')
})

test('risk: declaration or config marks high risk', () => {
  const cat = buildCatalog(schemas, {
    annotations: [{ match: 'adb_install', meta: { risk: 'high' } }],
    highRisk: ['list_models'],
  })
  assert.equal(cat.tools.get('adb_install').highRisk, true)
  assert.equal(cat.tools.get('list_models').highRisk, true)
  assert.equal(cat.tools.get('adb_logcat').highRisk, false)
})

test('a throwing classifier is skipped', () => {
  const bad = { name: 'bad', priority: 500, categorize() { throw new Error('boom') } }
  const cat = buildCatalog(schemas, { classifiers: [bad, defaults] })
  assert.equal(category(cat, 'adb_install'), 'device')
})

test('resolveTarget: paths, group names, exact and short tool names', () => {
  const cat = buildCatalog(schemas, { classifiers: [defaults] })
  assert.equal(resolveTarget(cat, '/device/adb').kind, 'group')
  assert.equal(resolveTarget(cat, 'amap').kind, 'group')
  assert.equal(resolveTarget(cat, 'mcp__amap__maps_weather').tool.name, 'mcp__amap__maps_weather')
  assert.equal(resolveTarget(cat, 'maps_weather').tool.name, 'mcp__amap__maps_weather')
  assert.equal(resolveTarget(cat, '/maps/amap/maps_weather').kind, 'tool')
  assert.equal(resolveTarget(cat, '/nope').kind, 'missing')
})

test('registries: register/dispose notify, filters validated', () => {
  let changes = 0
  const r = createRegistries(() => { changes += 1 })
  const off = r.registerClassifier({ name: 'x', categorize: () => 'code' })
  const offAnn = r.annotate('^a', { category: 'code', bogus: 1 })
  const offCat = r.defineCategory('games', 'Game tools')
  assert.equal(r.classifiers.size, 1)
  assert.deepEqual(r.annotations[0].meta, { category: 'code' })
  assert.equal(r.categories.get('games'), 'Game tools')
  off(); offAnn(); offCat(); off()
  assert.equal(r.classifiers.size, 0)
  assert.equal(r.annotations.length, 0)
  assert.equal(r.categories.has('games'), false)
  assert.equal(changes, 6, 'each register and each first dispose notifies once')
  assert.throws(() => r.registerClassifier({ name: 'empty' }))
  assert.throws(() => r.registerVisibilityFilter({ name: 'empty' }))
})

test('packageNameOf handles scoped and subpath specifiers', () => {
  assert.equal(packageNameOf('@scope/pkg/sub'), '@scope/pkg')
  assert.equal(packageNameOf('dsh-adb'), 'dsh-adb')
  assert.equal(packageNameOf('@deepseek-ai/dsh-tool-subagent/list-agents'), '@deepseek-ai/dsh-tool-subagent')
})

// The packages themselves are scoped (@lvy-jsd/…), so a scoped package's
// dsh.toolCatalog must be found from its loader entry, including when its
// exports hide package.json and the manifest is found by walking up.
test('dsh.toolCatalog declarations of scoped packages are read from loader entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-scoped-'))
  const write = (dir, manifest) => {
    const pkgDir = join(root, 'node_modules', dir)
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export default {}\n')
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ type: 'module', main: 'lib/index.js', ...manifest }))
  }
  write('@acme/dsh-open', {
    name: '@acme/dsh-open',
    dsh: { toolCatalog: { match: '^open_', category: 'vendor', tools: { open_danger: { risk: 'high' } } } },
  })
  write('@acme/dsh-hidden', {
    name: '@acme/dsh-hidden',
    exports: { '.': './lib/index.js' },
    dsh: { toolCatalog: { tools: { hidden_tool: { group: 'hidden' } } } },
  })
  const entries = [
    { options: { name: '@acme/dsh-open/lib/index.js' } },
    { options: { name: '@acme/dsh-hidden' } },
    { options: { name: '@acme/dsh-open' } }, // the same package twice is listed once
  ]
  const ctx = { get: (name) => (name === 'loader' ? { baseUrl: pathToFileURL(join(root, 'noop.js')).href, entries: () => entries } : undefined) }

  assert.deepEqual(listPluginPackages(ctx).map((p) => p.name), ['@acme/dsh-open', '@acme/dsh-hidden'])
  const annotations = readManifestAnnotations(ctx)
  assert.deepEqual(annotations.map((a) => [a.source, String(a.match), a.meta]), [
    ['@acme/dsh-open', '/^open_/', { category: 'vendor' }],
    ['@acme/dsh-open', 'open_danger', { category: 'vendor', risk: 'high' }],
    ['@acme/dsh-hidden', 'hidden_tool', { group: 'hidden' }],
  ])
})

test('a renamed group inherits the category of the structural group its tools came from', () => {
  const tools = ['zap_one', 'zap_two', 'zap_three', 'lingshu_cg', 'lingshu_stg'].map((name) => ({ name, description: '' }))
  const rename = { name: 'rename', priority: 10, group: (t) => (t.name.startsWith('zap_') ? 'zap-plugin' : t.name.startsWith('lingshu_') ? 'lingshu-plugin' : undefined) }
  const rules = { name: 'rules', priority: 100, categorize: (g) => ({ zap: 'device' })[g.name] }
  const cat = buildCatalog(tools, { classifiers: [rules, rename] })
  assert.equal(group(cat, 'zap_one'), 'zap-plugin')
  assert.equal(category(cat, 'zap_one'), 'device', 'zap -> device carries over to zap-plugin')
  assert.equal(category(cat, 'lingshu_cg'), UNCATEGORIZED, 'nothing to inherit stays uncategorized')
  // A rule for the new name still wins over inheritance.
  const named = { name: 'named', priority: 100, categorize: (g) => ({ 'zap-plugin': 'media', zap: 'device' })[g.name] }
  assert.equal(category(buildCatalog(tools, { classifiers: [named, rename] }), 'zap_one'), 'media')
})

test('group and category lookup ignores case; names keep theirs', () => {
  const cat = buildCatalog([{ name: 'mcp__GitHub__get_me', description: '' }, { name: 'mcp__GitHub__list_issues', description: '' }])
  assert.equal(group(cat, 'mcp__GitHub__get_me'), 'GitHub')
  for (const target of ['github', 'GitHub', '/uncategorized/github', '/Uncategorized/GitHub']) {
    const node = resolveTarget(cat, target)
    assert.equal(node.kind, 'group', target)
    assert.equal(node.group.name, 'GitHub')
  }
  assert.equal(resolveTarget(cat, 'UNCATEGORIZED').kind, 'category')
})

test('token estimate counts wide characters as about one token each', () => {
  const ascii = { name: 'x', description: 'a'.repeat(400) }
  assert.equal(estimateTokens(ascii), Math.ceil(JSON.stringify(ascii).length / 4))
  const cjk = { name: 'x', description: '查'.repeat(400) }
  const overhead = JSON.stringify({ name: 'x', description: '' }).length
  assert.equal(estimateTokens(cjk), Math.ceil(overhead / 4 + 400))
})
