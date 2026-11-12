import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreHost } from './panel-core-host.mjs'

// Pagination for tools_ls: a listing longer than 50 entries is truncated with
// a hint naming the offset to continue with; short listings keep the old format.

function setup(t, names) {
  const host = coreHost(t)
  const { ctx, catalog } = host
  for (const name of names) ctx.tools.register({ name, description: name, parameters: {} })
  catalog.refresh()
  return host
}

// Zero-padded so the catalog's lexicographic sort matches numeric order.
const groupTools = (n) => Array.from({ length: n }, (_, i) => `bigtool_${String(i + 1).padStart(3, '0')}`)

// 60 groups of two tools each, all uncategorized.
const manyGroups = () => {
  const names = []
  for (let i = 1; i <= 60; i += 1) {
    const prefix = `grp${String(i).padStart(2, '0')}`
    names.push(`${prefix}_a`, `${prefix}_b`)
  }
  return names
}

test('a long group listing is truncated to 50 entries with a continue hint', async (t) => {
  const { execute } = setup(t, groupTools(75))
  const result = await execute('tools_ls', { path: '/uncategorized/bigtool' })
  assert.match(result, /bigtool_001/)
  assert.match(result, /bigtool_050/)
  assert.doesNotMatch(result, /bigtool_051/)
  assert.match(result, /… 25 more; continue with offset=50/)
  assert.equal(result.split('\n').length, 52, 'header + 50 entries + hint')
})

test('offset pages to the next entries', async (t) => {
  const { execute } = setup(t, groupTools(120))
  const result = await execute('tools_ls', { path: '/uncategorized/bigtool', offset: 50 })
  assert.doesNotMatch(result, /bigtool_001/)
  assert.match(result, /bigtool_051/)
  assert.match(result, /bigtool_100/)
  assert.doesNotMatch(result, /bigtool_101/)
  assert.match(result, /… 20 more; continue with offset=100/)
})

test('the last page has no continue hint', async (t) => {
  const { execute } = setup(t, groupTools(75))
  const result = await execute('tools_ls', { path: '/uncategorized/bigtool', offset: 50 })
  assert.match(result, /bigtool_051/)
  assert.match(result, /bigtool_075/)
  assert.doesNotMatch(result, /more; continue/)
  assert.equal(result.split('\n').length, 26, 'header + 25 entries, no hint')
})

test('limit shrinks the page and the hint names the next offset', async (t) => {
  const { execute } = setup(t, groupTools(75))
  const result = await execute('tools_ls', { path: '/uncategorized/bigtool', limit: 10 })
  assert.match(result, /bigtool_001/)
  assert.doesNotMatch(result, /bigtool_011/)
  assert.match(result, /… 65 more; continue with offset=10/)
})

test('a short listing keeps the existing format, no hint', async (t) => {
  const { execute } = setup(t, ['small_a', 'small_b', 'small_c'])
  const result = await execute('tools_ls', { path: '/uncategorized/small' })
  assert.match(result, /small_a/)
  assert.match(result, /small_b/)
  assert.match(result, /small_c/)
  assert.doesNotMatch(result, /more; continue/)
})

// The host's own tools add the misc, tools and skills groups to
// /uncategorized, so the 60 grp groups are 63 entries in total.
test('a long category listing paginates its groups', async (t) => {
  const { execute } = setup(t, manyGroups())
  const result = await execute('tools_ls', { path: '/uncategorized' })
  assert.match(result, /grp01\//)
  assert.match(result, /grp50\//)
  assert.doesNotMatch(result, /grp51\//)
  assert.match(result, /… 13 more; continue with offset=50/)
})

// The root listing keeps the empty uncategorized category and the host's own
// misc/tools/skills categories, so the 60 grp categories are 64 entries total.
test('a long root listing paginates its categories', async (t) => {
  const host = setup(t, manyGroups())
  host.catalog.registerClassifier({ name: 'test:cat', categorize: (group) => group.name })
  const result = await host.execute('tools_ls', { path: '/' })
  assert.match(result, /grp01\//)
  assert.match(result, /grp46\//)
  assert.doesNotMatch(result, /grp47\//)
  assert.match(result, /… 14 more; continue with offset=50/)
})