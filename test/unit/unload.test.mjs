import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreHost } from './panel-core-host.mjs'

// tools_unload reports a per-target result (unloaded / not loaded / not found)
// for a batch of names, so one bad target does not fail the whole call, and a
// repeated name is resolved and reported a single time.

const count = (text, needle) => text.split(needle).length - 1

test('unloading a loaded tool reports the tool and the target', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  await execute('tools_load', { targets: ['alpha_tool'] })
  const result = await execute('tools_unload', { targets: ['alpha_tool'] })
  assert.ok(!catalog.stateOf(agent).loaded.has('alpha_tool'), 'the tool is unloaded')
  assert.match(result, /Unloaded 1 tool/)
  assert.ok(result.includes('\n  alpha_tool'), 'the removed tool is listed')
  assert.match(result, /unloaded: alpha_tool/)
})

test('unloading a tool that was never loaded says so, without failing', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  const result = await execute('tools_unload', { targets: ['alpha_tool'] })
  assert.equal(catalog.stateOf(agent).loaded.size, 0)
  assert.match(result, /Nothing was unloaded/)
  assert.match(result, /not loaded: alpha_tool/)
})

test('a missing target is reported per target, like tools_load', async (t) => {
  const { execute } = coreHost(t)
  const result = await execute('tools_unload', { targets: ['no-such-tool'] })
  assert.match(result, /Nothing was unloaded/)
  assert.match(result, /skipped no-such-tool: not found/)
})

test('a mixed batch reports each target: unloaded, not loaded, not found', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  await execute('tools_load', { targets: ['alpha_tool'] })
  const result = await execute('tools_unload', { targets: ['alpha_tool', 'beta_tool', 'no-such-tool'] })
  assert.equal(typeof result, 'string', 'one missing target must not fail the whole call')
  assert.ok(!catalog.stateOf(agent).loaded.has('alpha_tool'))
  assert.ok(!catalog.stateOf(agent).loaded.has('beta_tool'))
  assert.match(result, /Unloaded 1 tool/)
  assert.match(result, /unloaded: alpha_tool/)
  assert.match(result, /not loaded: beta_tool/)
  assert.match(result, /skipped no-such-tool: not found/)
})

test('a repeated name is deduplicated: resolved and reported once', async (t) => {
  const { execute } = coreHost(t)
  await execute('tools_load', { targets: ['alpha_tool'] })
  const result = await execute('tools_unload', { targets: ['alpha_tool', 'alpha_tool', 'alpha_tool'] })
  assert.equal(count(result, 'unloaded: alpha_tool'), 1, 'a repeated unloaded target is reported once')
  const missing = await execute('tools_unload', { targets: ['no-such-tool', 'no-such-tool'] })
  assert.equal(count(missing, 'skipped no-such-tool'), 1, 'a repeated missing target is reported once')
})

test('unloading a group hides its loaded tools and reports the group', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  await execute('tools_load', { targets: ['misc'] })
  const result = await execute('tools_unload', { targets: ['misc'] })
  assert.equal(catalog.stateOf(agent).groups.size, 0, 'the group subscription is gone')
  assert.match(result, /Unloaded 2 tool/)
  assert.ok(result.includes('\n  alpha_tool'), 'the removed tools are listed')
  assert.ok(result.includes('\n  beta_tool'))
  assert.match(result, /unloaded: misc/)
})

test('unloading a group with nothing loaded in it reports not loaded', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  const result = await execute('tools_unload', { targets: ['misc'] })
  assert.equal(catalog.stateOf(agent).groups.size, 0)
  assert.match(result, /Nothing was unloaded/)
  assert.match(result, /not loaded: misc/)
})

test('"all" clears every load and reports the count', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  await execute('tools_load', { targets: ['alpha_tool', 'misc'] })
  const result = await execute('tools_unload', { targets: ['all'] })
  assert.equal(catalog.stateOf(agent).loaded.size, 0)
  assert.equal(catalog.stateOf(agent).groups.size, 0)
  assert.match(result, /Unloaded 2 tool/)
  assert.match(result, /unloaded all: 2 tool/)
})

test('"all" with nothing loaded reports nothing was loaded', async (t) => {
  const { execute } = coreHost(t)
  const result = await execute('tools_unload', { targets: ['all'] })
  assert.match(result, /Nothing was unloaded/)
  assert.match(result, /nothing was loaded/)
})

test('a before-unload hook can veto the whole call, and the tool stays loaded', async (t) => {
  const { catalog, agent, execute, on } = coreHost(t)
  await execute('tools_load', { targets: ['alpha_tool'] })
  on('tool-catalog/before-unload', () => { throw new Error('vetoed by test') })
  const result = await execute('tools_unload', { targets: ['alpha_tool'] })
  assert.ok(catalog.stateOf(agent).loaded.has('alpha_tool'), 'the vetoed unload leaves the tool loaded')
  assert.match(result, /Unload refused: vetoed by test/)
  const refused = catalog.audit().find((entry) => entry.kind === 'unload' && !entry.ok)
  assert.ok(refused, 'the refused unload is audited')
})

test('a typo in an unload target gets the same did-you-mean hint as tools_load', async (t) => {
  const { execute } = coreHost(t)
  const result = await execute('tools_unload', { targets: ['alpha_too'] })
  assert.match(result, /not found/)
  assert.match(result, /Did you mean: alpha_tool/)
})

test('an always-on tool is outside the directory and says it cannot be unloaded', async (t) => {
  const { execute } = coreHost(t)
  const result = await execute('tools_unload', { targets: ['read'] })
  assert.match(result, /Nothing was unloaded/)
  assert.match(result, /read is always on and cannot be unloaded/)
  assert.ok(!result.includes('Did you mean'), 'no did-you-mean hint for an always-on tool')
})

test('unloading a mix of a loaded tool and an always-on tool reports each target', async (t) => {
  const { catalog, agent, execute } = coreHost(t)
  await execute('tools_load', { targets: ['alpha_tool'] })
  const result = await execute('tools_unload', { targets: ['alpha_tool', 'read'] })
  assert.ok(!catalog.stateOf(agent).loaded.has('alpha_tool'))
  assert.match(result, /Unloaded 1 tool/)
  assert.match(result, /unloaded: alpha_tool/)
  assert.match(result, /read is always on and cannot be unloaded/)
})