import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreHost } from './panel-core-host.mjs'

// tools_load reports a per-target result (loaded / already loaded / not found /
// refused) for a batch of names, so one bad target does not fail the whole call,
// and a repeated name is resolved, loaded and reported a single time.

const count = (text, needle) => text.split(needle).length - 1

test('a mixed batch loads the good targets and reports the bad ones per target', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  const result = await execute('tools_load', { targets: ['alpha_tool', 'no-such-tool'] })
  assert.equal(typeof result, 'string', 'one missing target must not fail the whole call')
  assert.ok(catalog.stateOf(agent).loaded.has('alpha_tool'), 'the good target is loaded')
  assert.match(result, /loaded: alpha_tool/)
  assert.match(result, /skipped no-such-tool: not found/)
  assert.match(result, /Loaded 1 tool/)
})

test('a batch with only missing targets loads nothing and reports each target', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  const result = await execute('tools_load', { targets: ['no-such-one', 'no-such-two'] })
  assert.equal(typeof result, 'string')
  assert.match(result, /Nothing new loaded/)
  assert.match(result, /skipped no-such-one: not found/)
  assert.match(result, /skipped no-such-two: not found/)
  assert.equal(catalog.stateOf(agent).loaded.size, 0)
})

test('a repeated name is deduplicated: resolved, loaded and reported once', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  const result = await execute('tools_load', { targets: ['alpha_tool', 'alpha_tool', 'alpha_tool'] })
  assert.ok(catalog.stateOf(agent).loaded.has('alpha_tool'))
  assert.equal(count(result, 'loaded: alpha_tool'), 1, 'a repeated loaded target is reported once')
  const missing = await execute('tools_load', { targets: ['no-such-tool', 'no-such-tool'] })
  assert.equal(count(missing, 'skipped no-such-tool'), 1, 'a repeated missing target is reported once')
})

test('a target that is already loaded is reported as already loaded, not re-loaded', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  const first = await execute('tools_load', { targets: ['alpha_tool'] })
  assert.match(first, /loaded: alpha_tool/)
  const second = await execute('tools_load', { targets: ['alpha_tool'] })
  assert.match(second, /Nothing new loaded/)
  assert.match(second, /already loaded: alpha_tool/)
  assert.equal(catalog.stateOf(agent).loaded.size, 1)
})

test('a mixed batch with a group, a tool in it and a miss reports each target', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  const result = await execute('tools_load', { targets: ['misc', 'beta_tool', 'no-such-tool'] })
  assert.equal(typeof result, 'string')
  assert.ok(catalog.stateOf(agent).loaded.has('beta_tool'))
  assert.match(result, /loaded: misc/)
  assert.match(result, /loaded: beta_tool/)
  assert.match(result, /skipped no-such-tool: not found/)
})

test('a high-risk tool with no gate is refused per target while the batch still loads the rest', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  catalog.updateConfig({ highRisk: ['beta_tool'] })
  const result = await execute('tools_load', { targets: ['alpha_tool', 'beta_tool'] })
  assert.equal(typeof result, 'string')
  assert.ok(catalog.stateOf(agent).loaded.has('alpha_tool'))
  assert.ok(!catalog.stateOf(agent).loaded.has('beta_tool'))
  assert.match(result, /loaded: alpha_tool/)
  assert.match(result, /refused: beta_tool/)
  assert.match(result, /no risk gate is installed/)
})

test('a group of only high-risk tools with no gate is skipped, not reported as already loaded', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  catalog.updateConfig({ highRisk: ['alpha_tool', 'beta_tool'] })
  const result = await execute('tools_load', { targets: ['misc'] })
  assert.equal(catalog.stateOf(agent).loaded.size, 0, 'nothing was loaded')
  assert.match(result, /Nothing new loaded/)
  assert.match(result, /skipped misc: only high-risk tools, load them one by one/)
  assert.ok(!result.includes('already loaded'), 'a group that loaded nothing is not "already loaded"')
})

test('a group that is already loaded is still reported as already loaded', async (t) => {
  const { execute } = coreHost(t)
  await execute('tools_load', { targets: ['misc'] })
  const result = await execute('tools_load', { targets: ['misc'] })
  assert.match(result, /Nothing new loaded/)
  assert.match(result, /already loaded: misc/)
})