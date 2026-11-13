import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreHost } from './panel-core-host.mjs'
import { closestNames } from '../../packages/dsh-tool-ultra-core/lib/catalog.js'

// "Did you mean" hints for tools_ls / tools_load / tools_find when a path or
// tool name does not exist: at most 3 closest names (optimal string alignment
// distance or prefix, case-insensitive, Chinese included), and no hint for an
// unrelated query.

function setup(t) {
  const host = coreHost(t)
  const { ctx, catalog } = host
  for (const name of ['web_read', 'web_links', 'mcp__GitHub__get_file', '发送邮件']) {
    ctx.tools.register({ name, description: name, parameters: {} })
  }
  catalog.refresh()
  return host
}

test('a one-letter typo in tools_load suggests the closest tool', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_load', { targets: ['web_readd'] })
  assert.match(result, /not found/)
  assert.match(result, /Did you mean: web_read/)
})

test('a case difference in tools_load suggests the exact tool', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_load', { targets: ['MCP__GITHUB__get_file'] })
  assert.match(result, /not found/)
  assert.match(result, /Did you mean: mcp__GitHub__get_file/)
})

test('an unrelated name in tools_load gets no suggestion', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_load', { targets: ['zzzqqq'] })
  assert.match(result, /not found/)
  assert.doesNotMatch(result, /Did you mean/)
})

test('a one-character typo in a Chinese name is suggested', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_load', { targets: ['发送邮建'] })
  assert.match(result, /not found/)
  assert.match(result, /Did you mean: 发送邮件/)
})

test('tools_ls on a misspelled path suggests the closest names', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_ls', { path: '/uncategorizd' })
  assert.match(result, /No such path/)
  assert.match(result, /Did you mean: uncategorized/)
})

test('a transposed letter in a tools_ls path suggests the closest name', async (t) => {
  const { ctx, catalog, execute } = setup(t)
  ctx.tools.register({ name: 'memory_store', description: 'memory_store', parameters: {} })
  catalog.annotate('memory_store', { group: 'memory', category: 'memory' })
  catalog.refresh()
  const result = await execute('tools_ls', { path: '/memroy' })
  assert.match(result, /No such path/)
  assert.match(result, /Did you mean: memory/)
})

test('a transposed letter in a tool name is suggested', () => {
  const catalog = { tools: new Map([['tools_load', { name: 'tools_load', short: 'tools_load' }]]) }
  assert.deepEqual(closestNames(catalog, 'tools_lod'), ['tools_load'])
})

test('tools_ls on an unrelated path gets no suggestion', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_ls', { path: '/zzzqqq' })
  assert.match(result, /No such path/)
  assert.doesNotMatch(result, /Did you mean/)
})

test('a tools_ls query that matches nothing suggests a close tool name', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_ls', { query: 'web_readd' })
  assert.match(result, /No tools match/)
  assert.match(result, /Did you mean: web_read/)
})

test('an unrelated tools_ls query gets no suggestion', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_ls', { query: 'zzzqqq' })
  assert.match(result, /No tools match/)
  assert.doesNotMatch(result, /Did you mean/)
})

test('at most three suggestions are offered', async (t) => {
  const { ctx, execute } = setup(t)
  for (const name of ['tool_a', 'tool_b', 'tool_c', 'tool_d']) {
    ctx.tools.register({ name, description: name, parameters: {} })
  }
  const result = await execute('tools_load', { targets: ['tool_e'] })
  const match = result.match(/Did you mean: (.+)?/)
  assert.ok(match, 'a suggestion was offered')
  assert.equal(match[1].split(', ').length, 3)
})

test('tools_find with no match suggests a close tool name', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_find', { query: 'web_readd' })
  assert.match(result, /No tools matched/)
  assert.match(result, /Did you mean: web_read/)
})

test('tools_find with an unrelated query gets no suggestion', async (t) => {
  const { execute } = setup(t)
  const result = await execute('tools_find', { query: 'zzzqqq' })
  assert.match(result, /No tools matched/)
  assert.doesNotMatch(result, /Did you mean/)
})