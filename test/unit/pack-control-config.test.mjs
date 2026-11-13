// Configuration is an authorization boundary: malformed values never widen access.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, createTools, createSshTools, createAdbTools, createDesktopTools, createBrowserTools } from '../../packages/dsh-tool-ultra-pack-control/lib/index.js'

const factories = { ssh: createSshTools, adb: createAdbTools, desktop: createDesktopTools, browser: createBrowserTools }
const packs = { ssh: true, 'ssh-exec': true, adb: true, 'adb-root': true, desktop: true, browser: true }
const base = { packs, hosts: { example: { target: 'user@host.example.com' } }, serials: { phone: 'phone.example.com:5555' }, auditFile: '', multiplex: false }
function mount(config) {
  const tools = [], logs = [], catalog = []
  const ctx = {
    tools: { register: (t) => tools.push(t.name) },
    logger: { warn: (m) => logs.push(m) }, on() {},
    inject: (_deps, fn) => fn({ effect: (f) => f(), toolCatalog: { registerToolPack: (p) => { catalog.push(p); p.items() } } }),
  }
  assert.doesNotThrow(() => apply(ctx, config))
  return { tools, logs, catalog }
}

test('config: shared fields reject wrong types, null, unsafe numbers and invalid regex consistently in every factory', () => {
  for (const [pack, factory] of Object.entries(factories)) {
    for (const field of ['timeoutMs', 'maxBytes', 'maxChars', 'maxTransferBytes']) {
      for (const value of [null, '1000', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => factory({ [field]: value }), /Invalid control config: .*must be an integer/, `${pack}.${field}=${value}`)
      }
    }
    for (const value of [null, '', 42, 'bad\0path']) assert.throws(() => factory({ transferDir: value }), /Invalid control config: .*transferDir/)
    assert.throws(() => factory({ denyPaths: 'secret' }), /Invalid control config: .*denyPaths/)
    assert.throws(() => factory({ denyPaths: ['['] }), /Invalid control config: .*denyPaths\[0\]/)
    assert.doesNotThrow(() => factory({}))
  }
})

test('config: boolean, path, host/session and TTL settings are strict', () => {
  for (const [pack, field] of [['ssh', 'multiplex'], ['adb', 'adbConnect'], ['adb', 'adbAskInput'], ['browser', 'browserAllowPrivate'], ['browser', 'browserAllowLocalTcp']]) {
    assert.throws(() => factories[pack]({ [field]: 'false' }), /must be boolean/)
  }
  for (const [pack, field] of [['ssh', 'sshBin'], ['adb', 'adbBin'], ['adb', 'outputDir'], ['desktop', 'outputDir'], ['browser', 'outputDir']]) {
    assert.throws(() => factories[pack]({ [field]: '' }), /Invalid control config/)
  }
  assert.throws(() => createSshTools({ hosts: [] }), /hosts must be an object/)
  assert.throws(() => createAdbTools({ serials: [] }), /serials must be an object/)
  assert.throws(() => createSshTools({ hosts: { bad: { target: 'user@host.example.com\0' } } }), /valid ssh destination/)
  assert.throws(() => createBrowserTools({ hosts: { bad: { target: 'user@host.example.com', browser: [] } } }), /browser must be an object/)
  assert.throws(() => createDesktopTools({ desktopCacheMs: 30_001 }), /desktopCacheMs must be an integer/)
  assert.throws(() => createAdbTools({ adbUiTtlMs: -1 }), /adbUiTtlMs must be an integer/)
  assert.doesNotThrow(() => createAdbTools({ adbUiTtlMs: 0 }))
})

test('config: enabled family errors are quarantined in DSH, strict plain API throws, and disabled settings are ignored', () => {
  for (const pack of Object.keys(factories)) {
    const config = { ...base, packConfig: { [pack]: { timeoutMs: 'typo' } } }
    assert.throws(() => createTools(config), /Invalid control config/)
    const { tools, logs, catalog } = mount(config)
    const prefix = pack === 'adb' ? 'adb_' : `${pack}_`
    assert.equal(tools.some((n) => n.startsWith(prefix)), false)
    assert.ok(tools.some((n) => n.startsWith(pack === 'ssh' ? 'adb_' : 'ssh_')))
    assert.equal(logs.length, 1)
    assert.match(logs[0], new RegExp(`Disabled control pack ${pack}`))
    assert.ok(catalog.length > 0)
    assert.doesNotThrow(() => createTools({ packs: { ssh: false }, packConfig: { [pack]: null }, hosts: null, serials: null }))
    assert.throws(() => createTools({ ...base, packConfig: { [pack]: { timeotMs: 1000 } } }), /timeotMs is not a supported setting/)
  }
  // A broken shared host table cannot break Android's catalog callback.
  const adb = mount({ ...base, hosts: { invalid: null } })
  assert.ok(adb.tools.includes('adb_ui'))
  assert.deepEqual(adb.catalog.map((p) => p.id).sort(), ['adb', 'adb-root'])
})

test('config: global authorization mistakes disable all control tools without crashing DSH', () => {
  for (const extra of [{ readOnly: 'false' }, { packs: { ssh: 'true' } }, { packs: { typo: true } }, { allow: '*' }, { allow: { '*': 'ssh_run' } }, { disable: 'ssh_write' }, { packConfig: [] }, { packConfig: { 'ssh-exec': {} } }, { auditFile: null }]) {
    const config = { ...base, ...extra }
    assert.throws(() => createTools(config), /Invalid control config/)
    const mounted = mount(config)
    assert.deepEqual(mounted.tools, [])
    assert.match(mounted.logs[0], /Disabled all control packs/)
  }
})

test('config: overrides replace maps/arrays, preserve explicit false, and stay local to each family', async () => {
  const calls = []
  const exec = async (argv, options) => { calls.push({ argv, options }); return { code: 0, stdout: '', stdoutBytes: Buffer.alloc(0), stderr: '', timedOut: false, truncated: false } }
  const tools = Object.fromEntries(createTools({ ...base, exec, adbAskInput: true, denyPaths: ['^/tmp/shared$'],
    packConfig: {
      ssh: { hosts: { scoped: { target: 'user@scoped.example.com' } }, timeoutMs: 2000, maxBytes: 321, denyPaths: ['^/tmp/scoped$'] },
      adb: { serials: { scopedPhone: 'scoped-phone.example.com:5555' }, adbAskInput: false, adbConnect: false, timeoutMs: 2345, maxBytes: 432 },
    },
  }).map((t) => [t.name, t]))
  assert.equal(await tools.ssh_hosts.execute({}), 'scoped: user@scoped.example.com')
  await tools.ssh_run.execute({ host: 'scoped', cmd: 'uptime' })
  await tools.adb_info.execute({ device: 'scopedPhone' })
  assert.deepEqual(calls.map((c) => [c.options.timeoutMs, c.options.maxBytes]), [[2000, 321], [2345, 432]])
  assert.ok(calls[1].argv.includes('scoped-phone.example.com:5555'))
  await assert.rejects(tools.adb_info.execute({ device: 'phone' }), /Unknown device/)
  await tools.ssh_read.execute({ host: 'scoped', path: '/tmp/shared' })
  await assert.rejects(tools.ssh_read.execute({ host: 'scoped', path: '/tmp/scoped' }), /Refusing/)
  assert.equal(tools.adb_input.approve({ device: 'scopedPhone', kind: 'key', value: 'KEYCODE_HOME' }), undefined)
  assert.ok(tools.desktop_click.alwaysAsk)
  assert.ok(tools.browser_eval.alwaysAsk)
  assert.throws(() => createTools({ ...base, hosts: { hidden: { target: 'user@host.example.com', packs: 'ssh' } } }), /bad packs whitelist/)
})
