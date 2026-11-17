import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreHost } from './panel-core-host.mjs'
import { registerRouter } from '../../packages/dsh-tool-ultra-core/lib/router/index.js'

function router(answer, { throws = false } = {}) {
  const tools = new Map(['alpha', 'beta'].map(name => [name, {
    name, short: name, group: 'work', category: 'code', summary: `work ${name}`,
    description: `work ${name}`, tokens: 10,
  }]))
  const calls = [], events = [], registered = []
  const catalog = { get: () => ({ tools }), load: async (_, names) => { calls.push(names); return 'Loaded' },
    allowFor: () => ['alpha'], deniedFor: () => ['beta'] }
  const llm = { async *stream() { if (throws) throw Error('provider failed'); yield { type: 'text-delta', text: answer } } }
  registerRouter({ tools: { schemas: () => [], register: tool => registered.push(tool) },
    get: name => name === 'llm' ? llm : undefined, on: () => () => {}, effect() {},
    emit: (name, event) => events.push({ name, event }), logger: { warn() {} } },
  { model: { provider: 'fixture', model: 'fixture' }, sidecar: { bin: '/nonexistent' } }, catalog)
  return { call: args => registered.find(t => t.name === 'tools_route').execute(args, { agent: { id: 'agent' } }), calls, events }
}

test('explicit model none is an abstention; irrelevant candidates are not loaded', async () => {
  const r = router('none')
  assert.match(await r.call({ query: 'work', limit: 1 }), /No tools matched/)
  assert.deepEqual(r.calls, [])
  assert.equal(r.events.at(-1).event.route.rerank, 'none')
  assert.deepEqual(r.events.at(-1).event.route.selected, [])
})

test('malformed or failed reranking falls back and the trace names the fallback', async () => {
  for (const [answer, options] of [['1st, please', {}], ['', { throws: true }]]) {
    const r = router(answer, options)
    await r.call({ query: 'work', limit: 1 })
    assert.equal(r.calls.length, 1)
    assert.equal(r.events.at(-1).event.route.rerank, 'fallback')
  }
})

test('trace distinguishes selected, callable and denied, and never retains intent text', async () => {
  const r = router('2')
  await r.call({ query: 'work PRIVATE_INTENT', limit: 1 })
  const trace = r.events.at(-1).event.route
  assert.deepEqual(trace.candidates.sort(), ['alpha', 'beta'])
  assert.deepEqual(trace.selected, ['beta'])
  assert.deepEqual(trace.callable, [])
  assert.deepEqual(trace.denied, ['beta'])
  assert.equal(r.events.at(-1).event.ok, false)
  assert.equal(trace.rerank, 'model')
  assert.ok(trace.durationMs >= 0)
  assert.equal(JSON.stringify(r.events).includes('PRIVATE_INTENT'), false)
})

test('retrieval-only trace does not claim a load or callable observation', async () => {
  const r = router('1')
  await r.call({ query: 'work', limit: 1, load: false })
  assert.equal(r.calls.length, 0)
  assert.equal(r.events.at(-1).event.route.loadRequested, false)
  assert.equal(r.events.at(-1).event.route.callable, null)
})

test('core audit detaches nested route data and final-result counters retain no payload', async t => {
  const { catalog, agent, ctx } = coreHost(t)
  await catalog.load(agent, ['alpha_tool'])
  await ctx.tools.schemas().find(t => t.name === 'tools_route').execute({ query: 'alpha_tool SECRET', load: false }, { agent })
  const row = catalog.audit().find(row => row.kind === 'route')
  assert.ok(row)
  assert.equal(JSON.stringify(row).includes('SECRET'), false)
  row.route.selected.length = 0
  assert.ok(catalog.audit().find(row => row.kind === 'route').route.selected.length)
  ctx.emit('tools/result', { agent, name: 'alpha_tool' }, { isError: true, content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }] })
  ctx.emit('tools/result', { agent, name: 'alpha_tool' }, { isError: false, content: [] })
  assert.deepEqual(catalog.resultStats(agent), { results: 2, errorResults: 1 })
  const stats = catalog.resultStats(agent); stats.results = 900
  assert.equal(catalog.resultStats(agent).results, 2)
  assert.equal(JSON.stringify(catalog.audit()).includes('PRIVATE_OUTPUT'), false)
})

test('hook-refused loads are retained as unsuccessful audit entries', async t => {
  const { catalog, agent, on } = coreHost(t)
  on('tool-catalog/before-load', () => { throw Error('policy') })
  assert.match(await catalog.load(agent, ['alpha_tool']), /Load refused/)
  assert.equal(catalog.audit()[0].ok, false)
  assert.equal(catalog.audit()[0].kind, 'load')
  assert.equal(catalog.stateOf(agent).loaded.has('alpha_tool'), false)
})

test('invalid routing limits use the configured default rather than broad or empty slices', async () => {
  for (const limit of [0, -1, NaN, Infinity]) {
    const r = router('1')
    await r.call({ query: 'work', limit })
    assert.equal(r.calls[0].length, 2)
  }
})
