// risk-gate: whole-group loads must not ask for high-risk tools the core skips.
//
// The core loads a group/category by skipping its high-risk tools (they can
// only be loaded one at a time), so the gate must not ask for them when a
// whole group is loaded; a direct load of a high-risk tool still asks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyRiskGate } from '../../packages/dsh-tool-ultra-risk-gate/lib/index.js'

/** A fake extension context around a small memory catalog. */
function gateContext() {
  const listeners = new Map()
  const tools = new Map([
    ['memory_delete_all', { name: 'memory_delete_all', highRisk: true }],
    ['memory_add', { name: 'memory_add', highRisk: false }],
    ['memory_search', { name: 'memory_search', highRisk: false }],
  ])
  const group = { name: 'memory', tools: [...tools.values()] }
  const ctx = {
    toolCatalog: {
      registerRiskGate: () => {},
      annotate: () => {},
      resolve: (raw) => {
        if (raw === '/memory/memory') return { kind: 'group', group }
        if (raw === '/memory') return { kind: 'category', category: { name: 'memory', groups: [group] } }
        const tool = tools.get(String(raw))
        return tool ? { kind: 'tool', tool } : { kind: 'missing' }
      },
      get: () => ({ tools }),
      toolPacks: () => [],
    },
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
    effect: (fn) => fn(),
    logger: () => ({ info() {}, warn() {} }),
  }
  applyRiskGate(ctx, {})
  return listeners.get('tools/pre-execute')
}

test('risk-gate: loading a group with a high-risk tool does not ask', async () => {
  const handler = gateContext()
  const result = await handler(
    { name: 'tools_load', agent: { id: 'sess-1' }, arguments: { targets: ['/memory/memory'] } },
    async () => 'loaded',
  )
  assert.equal(result, 'loaded')
})

test('risk-gate: loading a category with a high-risk tool does not ask', async () => {
  const handler = gateContext()
  const result = await handler(
    { name: 'tools_load', agent: { id: 'sess-1' }, arguments: { targets: ['/memory'] } },
    async () => 'loaded',
  )
  assert.equal(result, 'loaded')
})

test('risk-gate: loading the high-risk tool on its own asks', async () => {
  const handler = gateContext()
  const result = await handler(
    { name: 'tools_load', agent: { id: 'sess-1' }, arguments: { targets: ['memory_delete_all'] } },
    async () => 'loaded',
  )
  assert.equal(result.kind, 'ask')
})