import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, DEFAULT_PINNED } from '../../packages/dsh-tool-ultra-core/lib/index.js'

// Tools other plugins call directly from their prompts: a Bot's prompt names
// ds-bot's tools, and the memory prompt names the memory lookups. If one of
// them sits behind tools_load, the prompt breaks, so they stay pinned.
test('tools other plugins call from their prompts are pinned by default', () => {
  const pinned = new Set(DEFAULT_PINNED)
  // ds-bot: a Bot's prompt tells it to call these directly
  for (const name of ['ask_user', 'show_view', 'read_browser', 'create_bot', 'update_bot']) {
    assert.ok(pinned.has(name), `${name} must be pinned`)
  }
  // dsh-auto-memory: small and frequent, same as recall
  for (const name of ['recall', 'memory_search', 'memory_read']) {
    assert.ok(pinned.has(name), `${name} must be pinned`)
  }
  // Write operations stay lazy: loaded on demand, never pinned
  for (const name of ['memory_write', 'memory_delete', 'memory_delete_all']) {
    assert.ok(!pinned.has(name), `${name} must stay lazy`)
  }
})

// A host with the ds-bot and memory tools registered, so the allowlist can
// show them: pinned tools are visible without a load, and config `unpin`
// removes them again.
function pinnedHost(t) {
  const dir = mkdtempSync(join(tmpdir(), 'b5-pinned-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const names = ['ask_user', 'show_view', 'read_browser', 'create_bot', 'update_bot', 'memory_search', 'memory_read', 'memory_write', 'memory_delete_all']
  const definitions = new Map(names.map((name) => [name, { name, description: name, parameters: {} }]))
  const listeners = new Map()
  const disposers = []
  const on = (event, fn) => {
    const handlers = listeners.get(event) ?? []
    listeners.set(event, [...handlers, fn])
    return () => listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== fn))
  }
  const effect = (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) }
  t.after(() => disposers.reverse().forEach((dispose) => dispose()))
  const restrictions = new Set()
  const agent = { id: 'session-pinned', options: { provider: 'fake' }, ctx: { tools: { restrict: ({ allow }) => { const entry = new Set(allow); restrictions.add(entry); return () => restrictions.delete(entry) } } } }
  const services = {}
  const ctx = {
    logger: () => ({ warn() {}, info() {}, debug() {} }),
    tools: {
      schemas: (scope) => [...definitions.values()].filter((def) => !scope || [...restrictions].every((allow) => allow.has(def.name))),
      register: (def) => { definitions.set(def.name, def); return () => definitions.delete(def.name) },
    },
    effect, on,
    emit: (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args) },
    serial: async (event, ...args) => { for (const fn of listeners.get(event) ?? []) await fn(...args) },
    provide: (name, service) => { services[name] = service },
    inject: (_deps, fn) => fn({ agents: { list: () => [agent], get: () => undefined }, effect, on }),
    get: () => undefined,
  }
  const settingsFile = join(dir, 'settings.json')
  apply(ctx, { settingsFile, metadataFile: join(dir, 'metadata.json'), exemptFile: join(dir, 'exempt.json'), manifestFile: '', sidecar: { bin: '/nonexistent' } })
  // Registration finishes after the initial visibility mount, as in host startup.
  services.toolCatalog.refresh()
  return { catalog: services.toolCatalog, agent }
}

test('config unpin removes a default-pinned tool from the allowlist', async (t) => {
  const { catalog, agent } = pinnedHost(t)
  const visible = catalog.allowFor(agent)
  for (const name of ['ask_user', 'show_view', 'read_browser', 'create_bot', 'update_bot', 'memory_search', 'memory_read']) {
    assert.ok(visible.includes(name), `${name} must be visible without a load`)
  }
  assert.ok(!visible.includes('memory_delete_all'), 'a lazy tool is not visible')

  const config = catalog.updateConfig({ unpin: ['memory_search', 'show_view'] })
  assert.deepEqual(config.unpinned, ['memory_search', 'show_view'])
  assert.ok(!config.pinned.includes('memory_search'), 'unpin removes it from the effective pinned set')
  assert.ok(config.defaults.includes('memory_search'), 'the default list itself is unchanged')

  const after = catalog.allowFor(agent)
  assert.ok(!after.includes('memory_search'))
  assert.ok(!after.includes('show_view'))
  for (const name of ['memory_read', 'read_browser', 'create_bot', 'update_bot', 'ask_user']) {
    assert.ok(after.includes(name), `${name} stays visible`)
  }
})