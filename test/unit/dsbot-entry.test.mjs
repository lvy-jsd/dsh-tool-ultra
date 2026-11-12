import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Load a hand-written browser module (window.__ModuleLoader__.load({...})) and
// return its factory, without a browser.
function loadFactory(path) {
  let registered
  const window = { __ModuleLoader__: { load: (spec) => { registered = spec } } }
  runInNewContext(readFileSync(new URL(path, import.meta.url), 'utf8'), { window })
  return registered
}

const react = { createElement: () => null, useEffect() {}, useRef: () => ({}), useState: (v) => [v, () => {}], useCallback: (f) => f }
const makeCtx = () => {
  const registrations = []
  const slots = { inject: (_name, fn) => fn(), register: (spec, component) => { registrations.push({ spec, component }); return () => {} } }
  return { registrations, ctx: { get: (name) => (name === 'slots' ? slots : undefined), effect: (fn) => fn() } }
}

test('panel client exports its section component for other entry points', () => {
  const spec = loadFactory('../../packages/dsh-tool-ultra-panel/lib/client.js')
  assert.equal(spec.id, '@lvy-jsd/dsh-tool-ultra-panel')
  const mod = spec.factory((id) => (id === 'react' ? react : {}))
  assert.equal(typeof mod.ToolManagerSection, 'function')
  assert.equal(mod.NS, 'tool-manager.panel')
})

test('dsbot entry registers one shell overlay with the panel dictionaries', () => {
  const panel = loadFactory('../../packages/dsh-tool-ultra-panel/lib/client.js').factory((id) => (id === 'react' ? react : {}))
  const dsbot = loadDsbot()
  const spec = loadFactory('../../packages/dsh-tool-manager-dsbot-entry/lib/client.js')
  const mod = spec.factory((id) => (id === 'react' ? react : id === 'react-dom' ? { createPortal: () => null } : id === '@lvy-jsd/dsh-tool-ultra-panel' ? panel : id === '@lvy-jsd/dsh-tool-ultra-panel/dsbot' ? dsbot : {}))
  const { ctx, registrations } = makeCtx()
  mod.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].spec.name, 'shell.overlay')
  assert.equal(registrations[0].spec.locale, 'tool-manager.panel')
})

test('dsbot entry stays silent when the panel plugin is not loaded', () => {
  const dsbot = loadDsbot()
  const spec = loadFactory('../../packages/dsh-tool-manager-dsbot-entry/lib/client.js')
  const mod = spec.factory((id) => {
    if (id === '@lvy-jsd/dsh-tool-ultra-panel') throw new Error('module not found')
    return id === 'react' ? react : id === '@lvy-jsd/dsh-tool-ultra-panel/dsbot' ? dsbot : { createPortal: () => null }
  })
  const { ctx, registrations } = makeCtx()
  mod.apply(ctx)
  assert.equal(registrations.length, 0)
})

// --- dsbot pure module tests ---

function loadDsbot() {
  const spec = loadFactory('../../packages/dsh-tool-ultra-panel/lib/dsbot.js')
  assert.equal(spec.id, '@lvy-jsd/dsh-tool-ultra-panel/dsbot')
  return spec.factory(() => ({}))
}

test('dsbot findDsbotSettingsDialog returns the dialog, nav, and main when the DOM is valid', () => {
  const mod = loadDsbot()
  const nav = {}
  const main = {}
  const dialog = {
    querySelector: (sel) => (sel === ':scope > nav.bt-settings-nav' ? nav : sel === ':scope > .bt-settings-main' ? main : null),
  }
  const root = { querySelector: (sel) => (sel === '.bt-settings[role=dialog]' ? dialog : null) }
  const result = mod.findDsbotSettingsDialog(root)
  // The object is created in a different VM context, so compare by reference.
  assert.equal(result.dialog, dialog)
  assert.equal(result.nav, nav)
  assert.equal(result.main, main)
})

test('dsbot findDsbotSettingsDialog returns null when there is no dialog', () => {
  const mod = loadDsbot()
  const root = { querySelector: () => null }
  assert.equal(mod.findDsbotSettingsDialog(root), null)
})

test('dsbot findDsbotSettingsDialog returns null when the dialog has no nav', () => {
  const mod = loadDsbot()
  const dialog = { querySelector: () => null }
  const root = { querySelector: (sel) => (sel === '.bt-settings[role=dialog]' ? dialog : null) }
  assert.equal(mod.findDsbotSettingsDialog(root), null)
})

test('dsbot findDsbotSettingsDialog returns null when the dialog has no main', () => {
  const mod = loadDsbot()
  const nav = {}
  const dialog = { querySelector: (sel) => (sel === ':scope > nav.bt-settings-nav' ? nav : null) }
  const root = { querySelector: (sel) => (sel === '.bt-settings[role=dialog]' ? dialog : null) }
  assert.equal(mod.findDsbotSettingsDialog(root), null)
})

test('dsbot DSBOT_THEME is complete and maps every panel variable to a ds-bot value', () => {
  const mod = loadDsbot()
  const expected = {
    '--dsw-alias-label-primary': 'var(--bt-ink)',
    '--dsw-alias-label-secondary': 'var(--bt-ink-2)',
    '--dsw-alias-label-tertiary': 'var(--bt-ink-3)',
    '--dsw-alias-border-l2': 'var(--bt-line-2)',
    '--dsw-alias-bg-layer-1': 'var(--bt-card)',
    '--dsw-alias-bg-layer-2': 'var(--bt-hover)',
    '--dsw-alias-interactive-bg-hover': 'var(--bt-hover)',
    '--dsw-alias-state-business-primary': 'var(--bt-accent)',
    '--dsw-alias-state-success-primary': 'var(--bt-green,#00c972)',
    '--dsw-alias-state-warn-primary': 'var(--bt-star,#ff9800)',
    '--dsw-alias-state-warn-label': 'var(--bt-star,#ff9800)',
    '--dsw-radius-md': '10px',
    '--dsw-radius-sm': '8px',
  }
  // The object is created in a different VM context, so compare entries by value.
  assert.deepEqual(Object.keys(mod.DSBOT_THEME).sort(), Object.keys(expected).sort())
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(mod.DSBOT_THEME[name], value)
  }
})

test('dsbot dsbotThemeCss generates the CSS declarations from the mapping table', () => {
  const mod = loadDsbot()
  const css = mod.dsbotThemeCss()
  // Every entry in the mapping table appears as a declaration.
  for (const [name, value] of Object.entries(mod.DSBOT_THEME)) {
    assert.ok(css.includes(`${name}:${value}`), `missing ${name}:${value}`)
  }
  // The declarations are joined with semicolons.
  const parts = css.split(';')
  assert.equal(parts.length, Object.keys(mod.DSBOT_THEME).length)
})
