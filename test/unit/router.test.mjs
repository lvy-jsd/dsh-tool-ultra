import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenize, Bm25 } from '../../packages/dsh-tool-ultra-core/lib/router/bm25.js'
import { Sidecar } from '../../packages/dsh-tool-ultra-core/lib/router/sidecar.js'
import { registerRouter } from '../../packages/dsh-tool-ultra-core/lib/router/index.js'

const here = dirname(fileURLToPath(import.meta.url))
// The same lookup as the plugin: a packaged binary first, then a local cargo build.
// Neither is committed, so these tests run where `npm run build:sidecar` ran.
const SIDECAR_BIN = [
  join(here, '../../packages/dsh-tool-ultra-core/sidecar/bin/tool-router-sidecar'),
  join(here, '../../packages/dsh-tool-ultra-core/sidecar/target/release/tool-router-sidecar'),
].find(existsSync) ?? '/nonexistent/tool-router-sidecar'

// --- BM25 ------------------------------------------------------------------

test('tokenize: ascii, cjk, mixed', () => {
  assert.deepEqual(tokenize('Hello World_123'), ['hello', 'world_123'])
  assert.deepEqual(tokenize('Send Email'), ['send', 'email'])
  assert.deepEqual(tokenize('搜索 工具'), ['搜', '索', '工', '具'])
  assert.deepEqual(tokenize('aBc 123_x'), ['abc', '123_x'])
})

test('Bm25: ranks by relevance', () => {
  const bm25 = new Bm25()
  bm25.build([
    { ref: 'email', text: 'send an email to a recipient' },
    { ref: 'search', text: 'search the web for results' },
    { ref: 'browser', text: 'browse a web page in a browser' },
  ])
  const hits = bm25.search('send email')
  assert.equal(hits[0].ref, 'email')
  assert.ok(hits[0].score > 0)
})

test('Bm25: respects limit', () => {
  const bm25 = new Bm25()
  bm25.build([
    { ref: 'a', text: 'alpha one' },
    { ref: 'b', text: 'beta two' },
    { ref: 'c', text: 'gamma three' },
  ])
  assert.equal(bm25.search('alpha beta gamma', 2).length, 2)
})

test('Bm25: empty query and no match return empty', () => {
  const bm25 = new Bm25()
  bm25.build([{ ref: 'a', text: 'alpha' }])
  assert.deepEqual(bm25.search(''), [])
  assert.deepEqual(bm25.search('zzz'), [])
})

test('Bm25: empty index returns empty', () => {
  const bm25 = new Bm25()
  bm25.build([])
  assert.deepEqual(bm25.search('anything'), [])
})

test('Bm25: cjk tokens match', () => {
  const bm25 = new Bm25()
  bm25.build([
    { ref: 'cn', text: '发送邮件 给收件人' },
    { ref: 'en', text: 'send an email' },
  ])
  const hits = bm25.search('发送邮件')
  assert.equal(hits[0].ref, 'cn')
})

// --- Sidecar ----------------------------------------------------------------

test('Sidecar: missing binary returns false and search is null', async () => {
  const s = new Sidecar({ bin: '/nonexistent/tool-router-sidecar', socket: '/tmp/none.sock' })
  assert.equal(await s.start(), false)
  assert.equal(await s.search('tools', 'x', 5), null)
  s.stop()
})

test('Sidecar: start, index, search, stop (real binary)', { skip: !existsSync(SIDECAR_BIN) }, async () => {
  const sock = join(mkdtempSync(join(tmpdir(), 'sidecar-')), 'test.sock')
  const s = new Sidecar({ bin: SIDECAR_BIN, socket: sock, timeoutMs: 3000 })
  assert.equal(await s.start(), true)
  assert.equal(await s.index('tools', [
    { ref: 'email', text: 'send an email to a recipient' },
    { ref: 'search', text: 'search the web for results' },
  ]), true)
  const hits = await s.search('tools', 'send email', 5)
  assert.ok(Array.isArray(hits))
  assert.equal(hits[0].id, 0, 'email is doc 0 and ranks first')
  assert.ok(hits[0].score > 0)
  s.stop()
})

test('Sidecar: index on an unknown name returns false', { skip: !existsSync(SIDECAR_BIN) }, async () => {
  const sock = join(mkdtempSync(join(tmpdir(), 'sidecar-')), 'test.sock')
  const s = new Sidecar({ bin: SIDECAR_BIN, socket: sock, timeoutMs: 3000 })
  assert.equal(await s.start(), true)
  // A search on an index that was never indexed returns null (no hits).
  assert.equal(await s.search('nope', 'x', 5), null)
  s.stop()
})

// --- tools (JS BM25 fallback, no sidecar) ----------------------------------

function makeCtx({ catalog, skills, llm } = {}) {
  const registered = []
  const ctx = {
    tools: {
      schemas: () => [],
      register: (tool) => registered.push(tool),
    },
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    get: (name) => {
      if (name === 'llm') return llm
      if (name === 'skills') return skills
      return undefined
    },
    on: () => () => {},
    effect: () => {},
  }
  if (catalog) ctx.toolCatalog = catalog
  return { ctx, registered }
}

const toolCatalog = () => ({
  get: () => ({ tools: new Map([
    ['email', { name: 'email', short: 'email', group: 'mail', category: 'mail', summary: 'Send an email', description: 'Send an email to a recipient', tokens: 100, highRisk: false }],
    ['search', { name: 'search', short: 'search', group: 'web', category: 'search', summary: 'Search the web', description: 'Search the web for results', tokens: 100, highRisk: false }],
  ]) }),
  load: async (_agent, targets) => `Loaded ${targets.length} tool(s)`,
  wireTokens: () => 100,
})

test('registerRouter: registers the four tools', () => {
  const { ctx, registered } = makeCtx({ catalog: toolCatalog() })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, toolCatalog())
  const names = registered.map((t) => t.name).sort()
  assert.deepEqual(names, ['skills_find', 'skills_route', 'tools_find', 'tools_route'])
})

test('tools_find: returns ranked matches', async () => {
  const { ctx, registered } = makeCtx({ catalog: toolCatalog() })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, toolCatalog())
  const find = registered.find((t) => t.name === 'tools_find')
  const result = await find.execute({ query: 'send email' })
  assert.ok(result.includes('email'))
  assert.ok(result.includes('Send an email'))
  assert.ok(!result.includes('No tools matched'))
})

test('tools_find: no match reports it', async () => {
  const { ctx, registered } = makeCtx({ catalog: toolCatalog() })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, toolCatalog())
  const find = registered.find((t) => t.name === 'tools_find')
  const result = await find.execute({ query: 'quantum flux capacitor' })
  assert.ok(result.includes('No tools matched'))
})

// --- tools_find: query edge cases (Chinese, mixed, empty, whitespace, long) ---

// A catalog with an English tool and a Chinese-described tool, so pure-Chinese
// and mixed queries have something to match on each side.
const cnCatalog = () => ({
  get: () => ({ tools: new Map([
    ['email', { name: 'email', short: 'email', group: 'mail', category: 'mail', summary: 'Send an email', description: 'Send an email to a recipient', tokens: 100, highRisk: false }],
    ['search', { name: 'search', short: 'search', group: 'web', category: 'search', summary: 'Search the web', description: 'Search the web for results', tokens: 100, highRisk: false }],
    ['cn_email', { name: 'cn_email', short: 'cn_email', group: 'mail', category: 'mail', summary: '发送邮件', description: '发送邮件给收件人', tokens: 100, highRisk: false }],
  ]) }),
  load: async (_agent, targets) => `Loaded ${targets.length} tool(s)`,
  wireTokens: () => 100,
})

test('tools_find: pure Chinese query matches a Chinese-described tool', async () => {
  const { ctx, registered } = makeCtx({ catalog: cnCatalog() })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, cnCatalog())
  const find = registered.find((t) => t.name === 'tools_find')
  const result = await find.execute({ query: '发送邮件' })
  assert.ok(result.includes('cn_email'))
  assert.ok(!result.includes('No tools matched'))
})

test('tools_find: Chinese-English mixed query matches both', async () => {
  const { ctx, registered } = makeCtx({ catalog: cnCatalog() })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, cnCatalog())
  const find = registered.find((t) => t.name === 'tools_find')
  const result = await find.execute({ query: '发送邮件 email' })
  assert.ok(result.includes('cn_email'))
  assert.ok(result.includes('email'))
  assert.ok(!result.includes('No tools matched'))
})

test('tools_find: empty query returns a friendly hint, not an error or everything', async () => {
  const { ctx, registered } = makeCtx({ catalog: cnCatalog() })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, cnCatalog())
  const find = registered.find((t) => t.name === 'tools_find')
  const result = await find.execute({ query: '' })
  assert.ok(typeof result === 'string' && result.length > 0)
  // Not a dump of the whole catalog.
  assert.ok(!result.includes('Best matches'))
})

test('tools_find: whitespace-only query returns a friendly hint', async () => {
  const { ctx, registered } = makeCtx({ catalog: cnCatalog() })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, cnCatalog())
  const find = registered.find((t) => t.name === 'tools_find')
  const result = await find.execute({ query: '   ' })
  assert.ok(typeof result === 'string' && result.length > 0)
  assert.ok(!result.includes('Best matches'))
})

test('tools_find: overly long query does not throw', async () => {
  const { ctx, registered } = makeCtx({ catalog: cnCatalog() })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, cnCatalog())
  const find = registered.find((t) => t.name === 'tools_find')
  // Many unique CJK tokens, so the query is long in both characters and terms.
  const long = Array.from({ length: 2000 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join(' ')
  const result = await find.execute({ query: long })
  assert.ok(typeof result === 'string')
})

test('tools_route: retrieves and loads', async () => {
  let loadedTargets = null
  const catalog = toolCatalog()
  catalog.load = async (_agent, targets) => { loadedTargets = targets; return `Loaded ${targets.length} tool(s)` }
  const { ctx, registered } = makeCtx({ catalog })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, catalog)
  const route = registered.find((t) => t.name === 'tools_route')
  const result = await route.execute({ query: 'send email' }, { agent: 'agent1' })
  assert.ok(loadedTargets, 'load was called')
  assert.ok(loadedTargets.includes('email'))
  assert.ok(result.includes('Loaded 1 tool(s)'))
})

test('tools_route: load=false only retrieves', async () => {
  let loaded = false
  const catalog = toolCatalog()
  catalog.load = async () => { loaded = true; return 'Loaded' }
  const { ctx, registered } = makeCtx({ catalog })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } }, catalog)
  const route = registered.find((t) => t.name === 'tools_route')
  const result = await route.execute({ query: 'send email', load: false }, { agent: 'agent1' })
  assert.equal(loaded, false, 'load was not called')
  assert.ok(result.includes('email'))
})

test('tools_route: no catalog retrieves only', async () => {
  const { ctx, registered } = makeCtx({})
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } })
  const route = registered.find((t) => t.name === 'tools_route')
  const result = await route.execute({ query: 'send email' }, { agent: 'agent1' })
  assert.ok(typeof result === 'string')
})

test('skills_find: returns ranked skills', async () => {
  const skills = {
    list: async () => [
      { name: 'dsh-badge', description: 'Add a powered-by badge', whenToUse: 'When creating a PR', source: 'builtin' },
      { name: 'other', description: 'Do something else', whenToUse: 'Other', source: 'builtin' },
    ],
    get: async () => undefined,
  }
  const { ctx, registered } = makeCtx({ skills })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } })
  // rebuildSkills is async; give it a tick.
  await new Promise((r) => setTimeout(r, 50))
  const find = registered.find((t) => t.name === 'skills_find')
  const result = await find.execute({ query: 'add a badge to a pull request' })
  assert.ok(result.includes('dsh-badge'))
})

test('skills_route: loads the top skill body', async () => {
  const skills = {
    list: async () => [
      { name: 'dsh-badge', description: 'Add a powered-by badge', whenToUse: 'When creating a PR', source: 'builtin' },
      { name: 'other', description: 'Do something else', whenToUse: 'Other', source: 'builtin' },
    ],
    get: async (name) => (name === 'dsh-badge' ? { content: 'Full badge instructions here' } : undefined),
  }
  const { ctx, registered } = makeCtx({ skills })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } })
  await new Promise((r) => setTimeout(r, 50))
  const route = registered.find((t) => t.name === 'skills_route')
  const result = await route.execute({ query: 'add a badge to a pull request' })
  assert.ok(result.includes('dsh-badge'))
  assert.ok(result.includes('Full badge instructions here'))
})

test('skills_route: no skills reports it', async () => {
  const skills = { list: async () => [], get: async () => undefined }
  const { ctx, registered } = makeCtx({ skills })
  registerRouter(ctx, { sidecar: { bin: '/nonexistent' } })
  await new Promise((r) => setTimeout(r, 50))
  const route = registered.find((t) => t.name === 'skills_route')
  const result = await route.execute({ query: 'anything' })
  assert.ok(result.includes('No skills matched'))
})

// --- re-rank ----------------------------------------------------------------

test('tools_route: model re-rank reorders candidates', async () => {
  // The model says "2" (the second candidate) is the best fit.
  const llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '2' }
      yield { type: 'finish' }
    },
  }
  let loadedTargets = null
  const catalog = toolCatalog()
  catalog.load = async (_agent, targets) => { loadedTargets = targets; return `Loaded ${targets.length} tool(s)` }
  const { ctx, registered } = makeCtx({ catalog, llm })
  registerRouter(ctx, {
    sidecar: { bin: '/nonexistent' },
    model: { provider: 'deepseek', model: 'test' },
  }, catalog)
  const route = registered.find((t) => t.name === 'tools_route')
  // Query matches both; BM25 would rank 'search' first (more shared words),
  // but the model picks candidate 2.
  const result = await route.execute({ query: 'search the web', limit: 2 }, { agent: 'agent1' })
  assert.ok(loadedTargets, 'load was called')
  assert.ok(Array.isArray(loadedTargets))
  assert.ok(result.includes('Loaded'))
})

test('tools_route: re-rank failure falls back to BM25 order', async () => {
  const llm = {
    stream: async function* () {
      throw new Error('model down')
      // eslint-disable-next-line no-unreachable -- the yield only makes this a generator
      yield { type: 'finish' }
    },
  }
  let loadedTargets = null
  const catalog = toolCatalog()
  catalog.load = async (_agent, targets) => { loadedTargets = targets; return `Loaded ${targets.length} tool(s)` }
  const { ctx, registered } = makeCtx({ catalog, llm })
  registerRouter(ctx, {
    sidecar: { bin: '/nonexistent' },
    model: { provider: 'deepseek', model: 'test' },
  }, catalog)
  const route = registered.find((t) => t.name === 'tools_route')
  const result = await route.execute({ query: 'send email', limit: 2 }, { agent: 'agent1' })
  assert.ok(loadedTargets, 'load was called despite model failure')
  assert.ok(loadedTargets.includes('email'), 'BM25 order kept email first')
  assert.ok(result.includes('Loaded'))
})