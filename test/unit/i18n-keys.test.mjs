// i18n: every user-facing zh/en dictionary must keep both languages in lockstep.
//
// The dictionaries under test:
//   - panel (src/client.ts): the `en` and `zh` dictionaries registered with the
//     host locale service;
//   - risk-gate (src/index.ts): the `displayReason` of the high-risk load prompt
//     (`en` and `zh-CN`);
//   - core: no user-facing zh/en dictionary (its user-facing strings are
//     English-only model messages), so there is nothing to check there.
//
// For each dictionary: the zh and en key sets must be identical, and no value
// may be an empty string (an empty value renders as a blank, not a fallback).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply as applyRiskGate } from '../../packages/dsh-tool-ultra-risk-gate/lib/index.js'

// --- shared checks -------------------------------------------------------------

function checkDictionary(label, en, zh) {
  const enKeys = Object.keys(en).sort()
  const zhKeys = Object.keys(zh).sort()
  assert.ok(enKeys.length > 0, `${label}: the en dictionary is empty`)
  assert.deepEqual(zhKeys, enKeys, `${label}: zh and en key sets differ`)
  for (const [dict, lang] of [[en, 'en'], [zh, 'zh']]) {
    const empty = Object.keys(dict).filter((key) => dict[key] === '')
    assert.deepEqual(empty, [], `${label}: empty ${lang} strings: ${empty.join(', ')}`)
  }
}

// --- panel ----------------------------------------------------------------------

/** Load the browser half (a classic script) and capture its locale dictionaries. */
function panelDictionaries() {
  const source = readFileSync(new URL('../../packages/dsh-tool-ultra-panel/lib/client.js', import.meta.url), 'utf8')
  // The factory only needs React at load time; nothing is rendered here.
  const React = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
  }
  let registration
  new Function('window', 'require', source)(
    { __ModuleLoader__: { load: (reg) => { registration = reg } } },
    (specifier) => (specifier === 'react' ? React : null),
  )
  let dictionaries
  const ctx = {
    get: (name) => {
      if (name === 'slots') return { inject: () => () => {}, register: () => () => {} }
      if (name === 'locale') return {
        register: (namespace, dicts) => { dictionaries = dicts },
        bind: () => (key) => key,
      }
      return undefined
    },
    effect: (fn) => fn(),
  }
  registration.factory((specifier) => (specifier === 'react' ? React : null)).apply(ctx)
  return dictionaries
}

test('panel: the en and zh dictionaries have identical keys and no empty strings', () => {
  const { en, zh } = panelDictionaries()
  checkDictionary('panel', en, zh)
})

// --- risk-gate ------------------------------------------------------------------

test('risk-gate: the high-risk prompt has matching en and zh-CN keys', async () => {
  const listeners = new Map()
  const ctx = {
    toolCatalog: {
      registerRiskGate: () => {},
      annotate: () => {},
      resolve: (raw) => ({ kind: 'tool', tool: { name: String(raw) } }),
      get: () => ({ tools: new Map([['merge_pull_request', { name: 'merge_pull_request', highRisk: true }]]) }),
      toolPacks: () => [{ id: 'github', title: 'GitHub', tools: ['merge_pull_request'] }],
    },
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
    effect: (fn) => fn(),
    logger: () => ({ info() {}, warn() {} }),
  }
  applyRiskGate(ctx, {})
  const handler = listeners.get('tools/pre-execute')
  const result = await handler(
    { name: 'tools_load', agent: { id: 'sess-1' }, arguments: { targets: ['merge_pull_request'] } },
    async () => {},
  )
  assert.equal(result.kind, 'ask')
  // The prompt is one message per language, not a key/value dictionary: both
  // languages must be present, and neither may be empty.
  assert.deepEqual(Object.keys(result.displayReason).sort(), ['en', 'zh-CN'])
  assert.ok(typeof result.displayReason.en === 'string' && result.displayReason.en.length > 0, 'risk-gate: empty en prompt')
  assert.ok(typeof result.displayReason['zh-CN'] === 'string' && result.displayReason['zh-CN'].length > 0, 'risk-gate: empty zh-CN prompt')
  // The prompt must name the tool, its pack, why it is high risk, and what
  // approving does — in both languages.
  for (const [lang, needles] of [
    ['en', ['merge_pull_request', 'GitHub', 'marked high-risk', 'loads them into this session']],
    ['zh-CN', ['merge_pull_request', 'GitHub', '被标记为高危', '加载到当前会话']],
  ]) {
    const prompt = result.displayReason[lang]
    for (const needle of needles) assert.ok(prompt.includes(needle), `risk-gate: ${lang} prompt missing "${needle}"`)
  }
})