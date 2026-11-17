import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function client() {
  let plugin
  const h = (type, props, ...children) => ({ type, props, children })
  const react = { createElement: h }
  const window = { __ModuleLoader__: { load(registration) { plugin = registration.factory(() => react) } } }
  vm.runInNewContext(readFileSync(new URL('../../packages/dsh-tool-ultra-panel/lib/client.js', import.meta.url), 'utf8'), { window })
  return plugin
}

test('panel keeps its settings entry without requiring Better Sidebar', () => {
  const plugin = client(), registered = []
  assert.equal(plugin.inject.includes('betterSidebar'), false)
  const ctx = { get: name => name === 'slots' ? {
    inject: (_, fn) => fn(), register: spec => { registered.push(spec); return () => {} },
  } : undefined, effect: fn => fn() }
  plugin.apply(ctx)
  assert.equal(registered.length, 1)
})

test('optional sidebar registration follows scope, unmounts hidden content and disposes cleanly', () => {
  const plugin = client(), tabs = [], disposers = []
  let removed = 0
  const sidebar = { registerTab: tab => { tabs.push(tab); return () => removed++ } }
  plugin.apply({
    get: name => name === 'slots' ? { inject: (_, fn) => fn(), register: () => () => {} } : undefined,
    effect: fn => fn(),
    inject(names, fn) {
      assert.equal(names[0], 'betterSidebar')
      fn({ get: () => sidebar, effect: fn => disposers.push(fn()) })
    },
  })
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].single, true)
  const visible = tabs[0].component({ scope: { sessionId: 'current-session' }, visible: true })
  assert.equal(visible.props.sessionId, 'current-session')
  assert.equal(tabs[0].component({ scope: { sessionId: 'other' }, visible: false }), null)
  disposers.forEach(dispose => dispose())
  assert.equal(removed, 1)
})
