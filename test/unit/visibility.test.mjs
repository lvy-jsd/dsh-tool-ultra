import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVisibilityController } from '../../packages/dsh-tool-ultra-core/lib/visibility.js'
import { buildCatalog } from '../../packages/dsh-tool-ultra-core/lib/catalog.js'

function lifecycleHost() {
  const handlers = new Map()
  const parent = { id: 'parent', options: {} }, child = { id: 'child', options: {}, session: { header: { parentSession: 'parent' } } }
  const live = new Map([[parent.id, parent], [child.id, child]])
  const names = ['mcp__x__read', 'mcp__y__read']
  const catalog = buildCatalog(names.map(name => ({ name, description: name })))
  const vis = createVisibilityController({ tools: { schemas: () => names.map(name => ({ name })) } },
    { pinned: () => [], getCatalog: () => catalog })
  vis.mount({ agents: { list: () => [...live.values()], get: id => live.get(id) },
    on: (name, fn) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {} } })
  const fire = (name, event) => { for (const fn of handlers.get(name) ?? []) fn(event) }
  vis.update(parent, state => { state.groups.add('x'); state.handoffGroups.add('x') })
  return { parent, child, vis, fire, live }
}

test('new hosts inherit only from local published residency, not transcript ancestry', () => {
  const { vis, parent, child, fire, live } = lifecycleHost()
  assert.deepEqual(vis.allowFor(child), [])
  assert.equal(vis.parentOf(child), undefined)
  fire('subagent/start', { id: 'child', parentSessionId: 'parent', runId: 'external', local: false })
  assert.deepEqual(vis.allowFor(child), [])
  fire('subagent/start', { id: 'child', parentSessionId: 'parent', runId: 'live', local: true })
  assert.deepEqual(vis.allowFor(child), ['mcp__x__read'])
  assert.equal(vis.parentOf(child), parent)
  fire('subagent/end', { id: 'child', runId: 'old-epoch' })
  assert.equal(vis.parentOf(child), parent)
  live.delete('parent')
  assert.equal(vis.parentOf(child), undefined)
  vis.dispose()
})

test('residency notification preserves explicit edits and restored child state', () => {
  for (const persisted of [false, true]) {
    const { vis, child, fire } = lifecycleHost()
    if (persisted) vis.registerStateProvider({ load: agent => agent === child ? { loaded: ['mcp__y__read'] } : null })
    else vis.update(child, state => state.loaded.add('mcp__y__read'))
    fire('subagent/start', { id: 'child', parentSessionId: 'parent', runId: 'live', local: true })
    assert.deepEqual(vis.allowFor(child), ['mcp__y__read'])
    vis.dispose()
  }
})

// A host with several live agents: the panel's Sessions view asks for each
// agent's parent. Regression: the core used to read `ctx.agents` there, which
// the plugin ctx does not inject, so the view threw once a second agent existed.
test('parentOf resolves subagents through the injected agents API', () => {
  const parent = { id: 'p', options: {} }
  const child = { id: 'c', options: {} }
  const other = { id: 'o', options: {} }
  const ctx = {
    tools: { schemas: () => [], restrict: () => () => {} },
    get agents() { throw new Error('cannot get property "agents" without inject') },
  }
  const vis = createVisibilityController(ctx, { pinned: () => new Set(), getCatalog: () => null })
  const agentCtx = {
    agents: {
      list: () => [parent, child, other],
      isOwnedBy: (id, candidate) => id === 'c' && candidate === parent,
      get: () => undefined,
    },
    on: () => () => {},
  }
  vis.mount(agentCtx)
  assert.deepEqual(vis.agents().map((a) => a.id), ['p', 'c', 'o'])
  assert.equal(vis.parentOf(child), parent)
  assert.equal(vis.parentOf(parent), undefined)
  assert.equal(vis.parentOf(other), undefined)
})

// The startup window: DSH can resume sessions before this plugin mounts (a
// resumed web session, or the plugin enabled at runtime). Those agents must be
// narrowed at mount exactly like new ones, and the host's synchronous
// tools/change from restrict() must not stack a second restriction.
test('startup window: agents that exist before mount are restricted once, then follow loads', async () => {
  const { buildCatalog } = await import('../../packages/dsh-tool-ultra-core/lib/catalog.js')
  const names = ['bash', 'mcp__x__a', 'mcp__x__b']
  const handlers = new Map()
  const fire = (event, ...args) => { for (const h of handlers.get(event) ?? []) h(...args) }
  const makeAgent = (id) => {
    const restrictions = []
    return {
      id, options: {}, restrictions,
      active: () => restrictions.filter((r) => !r.disposed),
      ctx: {
        tools: {
          restrict: ({ allow }) => {
            const r = { allow: [...allow].sort(), disposed: false }
            restrictions.push(r)
            fire('tools/change')   // the host emits this synchronously
            return () => { r.disposed = true }
          },
        },
      },
    }
  }
  const a = makeAgent('a'), b = makeAgent('b')
  const live = [a, b]
  const ctx = {
    tools: {
      schemas: () => names.map((name) => ({ name, description: name })),
      view: () => ({ restrictableNames: names }),
    },
  }
  const catalog = buildCatalog(names.filter((n) => n !== 'bash').map((name) => ({ name, description: name })))
  const vis = createVisibilityController(ctx, { pinned: () => new Set(['bash']), getCatalog: () => catalog })
  const unmount = vis.mount({
    agents: { list: () => [...live], get: () => undefined },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => handlers.set(event, handlers.get(event).filter((h) => h !== handler))
    },
  })

  for (const agent of [a, b]) {
    assert.equal(agent.active().length, 1, `${agent.id}: one restriction after mount`)
    assert.deepEqual(agent.active()[0].allow, ['bash'], `${agent.id}: pinned only`)
  }

  vis.update(a, (state) => { state.groups.add('x') })
  assert.equal(a.active().length, 1, 'a load replaces the restriction instead of stacking one')
  assert.deepEqual(a.active()[0].allow, ['bash', 'mcp__x__a', 'mcp__x__b'])
  assert.deepEqual(b.active()[0].allow, ['bash'], 'the other agent is unaffected')

  const c = makeAgent('c')
  live.push(c)
  fire('agent/created', { agent: c })
  assert.equal(c.active().length, 1, 'an agent created after mount is restricted too')

  unmount()
  for (const agent of [a, b, c]) assert.equal(agent.active().length, 0, `${agent.id}: released on unmount`)
})
