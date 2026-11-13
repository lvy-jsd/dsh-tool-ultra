import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Load a hand-written browser module (window.__ModuleLoader__.load({...})) and
// return its factory, without a browser. `globals` are extra browser globals
// the module's factory may touch (document, MutationObserver, ...).
function loadFactory(path, globals = {}) {
  let registered
  const window = { __ModuleLoader__: { load: (spec) => { registered = spec } } }
  runInNewContext(readFileSync(new URL(path, import.meta.url), 'utf8'), { window, ...globals })
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
  const spec = loadFactory('../../packages/dsh-tool-manager-dsbot-entry/lib/client.js')
  const mod = spec.factory((id) => {
    if (id === '@lvy-jsd/dsh-tool-ultra-panel') throw new Error('module not found')
    return id === 'react' ? react : { createPortal: () => null }
  })
  const { ctx, registrations } = makeCtx()
  mod.apply(ctx)
  assert.equal(registrations.length, 0)
})

// A minimal DOM stub just big enough for the entry's sync logic, so the
// findDialog result and the injected CSS can be observed without a browser.
function makeDom() {
  const element = (tag) => ({
    tag,
    nodeType: 1,
    isConnected: true,
    hidden: false,
    childNodes: [],
    attributes: {},
    dataset: {},
    listeners: {},
    append(node) { this.childNodes.push(node) },
    appendChild(node) { this.childNodes.push(node) },
    insertBefore(node) { this.childNodes.push(node) },
    remove() { this.isConnected = false },
    setAttribute(name, value) { this.attributes[name] = value },
    removeAttribute(name) { delete this.attributes[name] },
    toggleAttribute(name, on) { if (on) this.attributes[name] = ''; else delete this.attributes[name] },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
    removeEventListener() {},
    querySelector: () => null,
    closest: () => null,
  })
  const nav = element('nav')
  const main = element('main')
  const dialog = element('dialog')
  dialog.querySelector = (sel) => (sel === ':scope > nav.bt-settings-nav' ? nav : sel === ':scope > .bt-settings-main' ? main : null)
  const document = {
    body: element('body'),
    head: element('head'),
    createElement: (tag) => element(tag),
    createTextNode: (value) => ({ nodeType: 3, textContent: value }),
    querySelector: (sel) => (sel === '.bt-settings[role=dialog]' ? dialog : null),
  }
  return { document, dialog, nav, main }
}

// The entry CSS with the inline theme mapping, as origin/main produced it.
const FALLBACK_CSS = `
.bt-settings[data-tool-manager-open] .bt-settings-nav>.bt-thumb{opacity:0}
.bt-settings[data-tool-manager-open] .bt-settings-item[aria-current=page]{background:none;color:var(--bt-ink-2)}
.bt-settings-item[data-tool-manager-entry][data-active]{background:var(--bt-active);color:var(--bt-ink)}
.tm-dsbot-host{position:absolute;top:0;bottom:0;left:198px;right:0;z-index:2;overflow-y:auto;box-sizing:border-box;padding:16px 56px 24px 20px;background:var(--bt-main);scrollbar-width:thin;
--dsw-alias-label-primary:var(--bt-ink);--dsw-alias-label-secondary:var(--bt-ink-2);--dsw-alias-label-tertiary:var(--bt-ink-3);
--dsw-alias-border-l2:var(--bt-line-2);--dsw-alias-bg-layer-1:var(--bt-card);--dsw-alias-bg-layer-2:var(--bt-hover);
--dsw-alias-interactive-bg-hover:var(--bt-hover);--dsw-alias-state-business-primary:var(--bt-accent);
--dsw-alias-state-success-primary:var(--bt-green,#00c972);--dsw-alias-state-warn-primary:var(--bt-star,#ff9800);--dsw-alias-state-warn-label:var(--bt-star,#ff9800);
--dsw-radius-md:10px;--dsw-radius-sm:8px}
.tm-dsbot-host .tmp-section{max-width:none}
.tm-dsbot-host .tmp-heading{font-size:15px;line-height:24px}
.bt-settings-close{z-index:3}
`

test('dsbot entry falls back to the inline helpers when the /dsbot module is missing, and uses the module when it is there', () => {
  const panel = loadFactory('../../packages/dsh-tool-ultra-panel/lib/client.js').factory((id) => (id === 'react' ? react : {}))
  // A React fake that runs effects, so the entry's sync logic can be observed.
  const reactLive = { createElement: () => null, useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect: (fn) => { fn() } }
  const loadEntry = (dom, dsbotRequire) => loadFactory('../../packages/dsh-tool-manager-dsbot-entry/lib/client.js', {
    document: dom.document,
    MutationObserver: class { observe() {} disconnect() {} },
    Node: { TEXT_NODE: 3 },
  }).factory((id) => {
    if (id === '@lvy-jsd/dsh-tool-ultra-panel/dsbot') return dsbotRequire()
    return id === 'react' ? reactLive : id === 'react-dom' ? { createPortal: () => null } : id === '@lvy-jsd/dsh-tool-ultra-panel' ? panel : {}
  })

  // No /dsbot module: the entry does not throw, and the inline helpers work.
  const dom = makeDom()
  const mod = loadEntry(dom, () => { throw new Error('module not found') })
  const { ctx, registrations } = makeCtx()
  mod.apply(ctx)
  assert.equal(registrations.length, 1)
  registrations[0].component({})
  assert.equal(dom.nav.childNodes.length, 1)
  assert.equal(dom.nav.childNodes[0].attributes['data-tool-manager-entry'], '')
  // The injected CSS is the inline copy of the theme mapping.
  assert.equal(dom.document.head.childNodes[0].textContent, FALLBACK_CSS)

  // /dsbot module present: the module's helpers are used instead.
  const dom2 = makeDom()
  dom2.document.querySelector = () => null // the inline check would find nothing
  const calls = []
  const dsbot = {
    findDsbotSettingsDialog: (root) => { calls.push(root); return { dialog: dom2.dialog, nav: dom2.nav, main: dom2.main } },
    dsbotThemeCss: () => '--dsw-alias-label-primary:var(--bt-ink)',
  }
  const mod2 = loadEntry(dom2, () => dsbot)
  const { ctx: ctx2, registrations: registrations2 } = makeCtx()
  mod2.apply(ctx2)
  assert.equal(registrations2.length, 1)
  registrations2[0].component({})
  assert.equal(calls.length, 1)
  assert.equal(dom2.nav.childNodes.length, 1)
  const css2 = dom2.document.head.childNodes[0].textContent
  assert.ok(css2.includes('--dsw-alias-label-primary:var(--bt-ink)'))
  assert.ok(!css2.includes('--dsw-radius-md:10px'))
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
