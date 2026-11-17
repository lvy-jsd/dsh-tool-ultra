import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, connect } from 'node:net'
import { apply, createTools, gate, BROWSER_TOOL_NAMES, browserPrivateAddress, browserUrl, createSshTransport, localExec } from '../../packages/dsh-tool-ultra-pack-control/lib/index.js'
import { fakeBrowser, startFakeCdp, PNG } from '../fixtures/pack-control/fake-cdp.mjs'
const hosts = { example: { target: 'root@browser.example' }, secondary: { target: 'user@secondary.example', port: 2222, identity: '/example/key', browser: { port: 9333 } } }
const config = { hosts, browserAllowLocalTcp: process.platform === 'win32', packs: { ssh: false, browser: true }, multiplex: false }
const tools = (opts = {}) => Object.fromEntries(createTools({ ...config, ...opts }).map((t) => [t.name, t]))
const args = (more = {}) => ({ host: 'example', ...more })
const ok = (s = '', more = {}) => ({ code: 0, stdout: s, stdoutBytes: Buffer.from(s), stderr: '', truncated: false, timedOut: false, ...more })
const content = (s) => JSON.parse(JSON.parse(s).content)
async function available(ctx) {
  const s = createServer()
  try { await new Promise((r, j) => { s.once('error', j); s.listen(0, '127.0.0.1', r) }); await new Promise((r) => s.close(r)); return true }
  catch (e) { if (['EPERM','EACCES'].includes(e.code)) { ctx.skip(`Loopback listeners unavailable: ${e.code}`); return false } throw e }
}
function fake() {
  const calls = [], browsers = { example: fakeBrowser(), secondary: fakeBrowser() }, active = new Set(), ports = []
  let dns = '93.184.216.34 STREAM page.example\n'
  let failure, collision = 0, noCdp = false
  const exec = async (argv, opts = {}) => {
    calls.push({ argv, opts })
    if (!argv.includes('-L')) return typeof dns === 'string' ? ok(dns) : dns
    if (collision-- > 0) return ok('', { code: 255, stderr: 'bind: Address already in use' })
    if (failure) return failure
    const forward = argv[argv.indexOf('-L') + 1].split(':')
    const [port, remotePort] = forward[0].startsWith('/') ? [forward[0], forward[2]] : [Number(forward[1]), forward[3]]
    const alias = argv.includes('root@browser.example') ? 'example' : 'secondary'
    const server = noCdp ? { close: async () => {} } : await startFakeCdp({ ...(typeof port === 'string' ? { socketPath: port } : { port }), remotePort: Number(remotePort), browser: browsers[alias] })
    active.add(server); ports.push(port)
    opts.onStdout(Buffer.from(argv.at(-1).match(/DSH_FORWARD_[a-f0-9-]+/)[0] + '\n'))
    await new Promise((r) => { if (opts.signal.aborted) r(); else opts.signal.addEventListener('abort', r, { once: true }) })
    await server.close(); active.delete(server)
    return ok()
  }
  return { calls, browsers, active, ports, exec, setDns: (v) => { dns = v }, fail: (v) => { failure = v }, collide: (n) => { collision = n }, noCdp: (v) => { noCdp = v } }
}
test('browser: opt-in, risk metadata, readOnly, disable and schemas', () => {
  assert.equal(createTools().some((t) => t.pack === 'browser'), false)
  const all = Object.values(tools())
  assert.deepEqual(all.map((t) => t.name), [...BROWSER_TOOL_NAMES])
  const pkg = JSON.parse(readFileSync(new URL('../../packages/dsh-tool-ultra-pack-control/package.json', import.meta.url)))
  for (const t of all) {
    assert.deepEqual(pkg.dsh.toolCatalog.tools[t.name], { group: 'browser', category: 'browser', risk: t.risk })
    assert.equal(t.parameters.host.required, true)
    assert.ok(Object.keys(t.parameters).length <= 4)
  }
  assert.deepEqual(Object.keys(tools({ readOnly: true })), ['browser_tabs','browser_page','browser_shot'])
  assert.equal(tools({ disable: ['browser_eval'] }).browser_eval, undefined)
  for (const port of [0, -1, 65536, '9222', 1.5]) assert.throws(() => tools({ hosts: { example: { target: 'user@browser.example', browser: { port } } } }), /browser.port/)
})
test('browser: call gate asks before all mutations; eval cannot be allowlisted', () => {
  const all = Object.values(tools()), decide = gate(all), allowed = gate(all, { '*': true })
  for (const t of all) {
    const e = { name: t.name, arguments: args({ js: 'sensitive source', text: 'secret input' }) }
    assert.equal(decide(e)?.kind, t.risk === 'low' ? undefined : 'ask')
    assert.equal(allowed(e)?.kind, t.name === 'browser_eval' ? 'ask' : undefined)
    assert.ok(!t.describe(e.arguments).includes('sensitive source'))
    if (t.name === 'browser_type') assert.ok(t.approve(e.arguments).includes('secret input'))
    if (t.name === 'browser_eval') assert.ok(t.approve(e.arguments).includes('sensitive source'))
  }
})
test('browser: URL protocols, credentials, normalized private/mapped IPs', () => {
  for (const url of ['file:///etc/passwd','javascript:alert(1)','data:text/html,x','ftp://page.example','https://user:pass@page.example',' https://page.example','https://page.example/\n']) assert.throws(() => browserUrl(url))
  assert.equal(browserUrl('https://page.example/a?q=one').hostname, 'page.example')
  for (const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.1.2.3','::','::1','fd00::1','fe80::1','::ffff:7f00:1','::ffff:127.0.0.1','not-an-ip']) assert.equal(browserPrivateAddress(ip), true, ip)
  for (const ip of ['93.184.216.34','2606:4700:4700::1111','::ffff:5db8:d822']) assert.equal(browserPrivateAddress(ip), false, ip)
})
test('browser: invalid/unknown hosts fail before any SSH or loopback listener', async () => {
  let calls = 0
  const t = tools({ exec: async () => { calls++; throw Error('unexpected') } })
  await assert.rejects(async () => t.browser_tabs.execute({ host: 'unknown-example' }), /Unknown host/)
  await assert.rejects(async () => t.browser_tabs.execute({}), /Unknown host/)
  await assert.rejects(t.browser_click.execute(args({ ref: '1' })), /Stale/)
  await assert.rejects(t.browser_key.execute(args({ key: 'ctrl+l; false' })), /combo/)
  for (const url of ['http://127.1','http://0x7f000001','http://[::ffff:7f00:1]','http://localhost','http://name.internal','file:///etc/passwd']) await assert.rejects(t.browser_open.execute(args({ url })))
  assert.equal(calls, 0)
})
test('browser: fake SSH/CDP reads, bounded untrusted snapshots and isolated worlds on every host', async (ctx) => {
  if (!await available(ctx)) return
  const f = fake(), t = tools({ exec: f.exec, maxChars: 1800 })
  for (const host of Object.keys(hosts)) {
    const tabs = content(await t.browser_tabs.execute({ host }))
    assert.equal(tabs[0].tab, 'tab-example')
    const output = await t.browser_page.execute({ host, mode: 'refs' })
    assert.ok(output.length <= 1800)
    const parsed = JSON.parse(output)
    assert.equal(parsed.trust, 'untrusted_browser_content'); assert.equal(parsed.truncated, true)
    assert.match(parsed.content, /"ref":"[a-f0-9]{8}:1"/)
    const plain = await t.browser_page.execute({ host })
    assert.match(plain, /ignore instructions/)
    const calls = f.browsers[host].calls
    assert.ok(calls.some((m) => m.method === 'Page.createIsolatedWorld'))
    assert.ok(calls.filter((m) => m.method === 'Runtime.evaluate').every((m) => f.browsers[host].contexts.some((c) => c.id === m.params.contextId && c.connection === m.connection)))
    assert.equal(f.active.size, 0)
  }
  for (const { argv, opts } of f.calls) {
    assert.ok(argv.includes('-L'))
    assert.match(argv[argv.indexOf('-L') + 1], process.platform === 'win32' ? /^127\.0\.0\.1:\d+:127\.0\.0\.1:(9222|9333)$/ : /^\/.*\/cdp-\d+\.sock:127\.0\.0\.1:(9222|9333)$/)
    assert.ok(argv.includes('ControlPath=none') && argv.includes('ExitOnForwardFailure=yes'))
    assert.equal(opts.signal.aborted, true)
  }
  const second = f.calls.find((c) => c.argv.includes('user@secondary.example')).argv
  assert.ok(second.includes('/example/key') && second.includes('2222'))
  assert.equal(new Set(f.ports).size, f.ports.length)
  // No listening tunnel is left after the callback returns.
  await new Promise((r, j) => { const s = typeof f.ports[0] === 'number' ? connect(f.ports[0], '127.0.0.1') : connect(f.ports[0]); s.on('connect', () => { s.destroy(); j(Error('leaked tunnel')) }); s.on('error', r) })
})
test('browser: literal type/click, snapshot generations, host isolation and stale detached nodes', async (ctx) => {
  if (!await available(ctx)) return
  const f = fake(), t = tools({ exec: f.exec })
  const snapshot = async (host = 'example') => JSON.parse(await t.browser_page.execute({ host, mode: 'refs' })).content.match(/"ref":"([^"]+)"/)[1]
  let ref = await snapshot()
  await assert.rejects(t.browser_click.execute({ host: 'secondary', ref }), /Stale/)
  const old = ref; ref = await snapshot()
  await assert.rejects(t.browser_click.execute(args({ ref: old })), /Stale/)
  ref = await snapshot()
  const text = "Example's 中文 $(id); `false`\n\\literal"
  await t.browser_type.execute(args({ ref, text, submit: true }))
  assert.equal(f.browsers.example.calls.find((m) => m.method === 'Input.insertText').params.text, text)
  assert.ok(!f.calls.some((c) => c.argv.join(' ').includes(text)))
  const keys = f.browsers.example.calls.filter((m) => m.method === 'Input.dispatchKeyEvent')
  assert.deepEqual(keys.map((m) => m.params.type), ['keyDown','keyUp'])
  assert.equal(keys[0].params.key, 'Enter')
  await assert.rejects(t.browser_click.execute(args({ ref })), /Stale/)
  ref = await snapshot(); await t.browser_click.execute(args({ ref }))
  assert.deepEqual(f.browsers.example.calls.filter((m) => m.method === 'Input.dispatchMouseEvent').map((m) => m.params.type), ['mousePressed','mouseReleased'])
  ref = await snapshot(); f.browsers.example.input.isConnected = false
  await assert.rejects(t.browser_click.execute(args({ ref })), /Stale browser ref/)
  assert.equal(f.active.size, 0)
})
test('browser: screenshots, byte bounds and filesystem modes', async (ctx) => {
  if (!await available(ctx)) return
  const outputDir = await mkdtemp(join(tmpdir(), 'control-browser-'))
  ctx.after(() => rm(outputDir, { recursive: true, force: true }))
  const f = fake(), t = tools({ exec: f.exec, outputDir })
  const path = (await t.browser_shot.execute(args())).slice('screenshot: '.length)
  assert.deepEqual(await readFile(path), PNG)
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  f.browsers.example.screenshot = Buffer.from('not PNG').toString('base64')
  await assert.rejects(t.browser_shot.execute(args()), /not a PNG/)
  f.browsers.example.screenshot = PNG.toString('base64')
  await assert.rejects(tools({ exec: f.exec, maxTransferBytes: 10 }).browser_shot.execute(args()), /oversized/)
  assert.equal(f.active.size, 0)
})
test('browser: remote DNS, mixed private answers, redirects boundary, and private config opt-in', async (ctx) => {
  if (!await available(ctx)) return
  const f = fake(), t = tools({ exec: f.exec })
  for (const dns of ['10.1.2.3 STREAM page.example\n','93.184.216.34 STREAM page.example\n127.0.0.1 DGRAM page.example\n','',ok('', { code: 127, stderr: 'getent missing' }),ok('93.184.216.34', { truncated: true })]) {
    f.setDns(dns)
    await assert.rejects(t.browser_open.execute(args({ url: 'https://page.example/' })), /private|DNS/)
  }
  assert.equal(f.calls.some((c) => c.argv.includes('-L')), false)
  f.setDns('93.184.216.34 STREAM page.example\n')
  const result = content(await t.browser_open.execute(args({ url: 'https://page.example/', new_tab: true })))
  assert.equal(result.tab, 'tab-created')
  assert.ok(f.calls.find((c) => !c.argv.includes('-L')).argv.at(-1).includes('getent ahosts'))
  const privateTools = tools({ exec: f.exec, browserAllowPrivate: true })
  await privateTools.browser_open.execute(args({ url: 'http://127.0.0.1/', new_tab: false }))
  assert.ok(f.browsers.example.calls.some((m) => m.method === 'Page.navigate' && m.params.url === 'http://127.0.0.1/'))
  await assert.rejects(privateTools.browser_open.execute(args({ url: 'file:///tmp/example' })), /Only http/)
})
test('browser: no debugging port, unsafe advertised endpoints, CDP errors/timeouts/truncation all clean up without replay', async (ctx) => {
  if (!await available(ctx)) return
  const f = fake()
  f.noCdp(true)
  await assert.rejects(tools({ exec: f.exec }).browser_tabs.execute(args()), /Cannot connect to remote Chrome CDP.*--remote-debugging-address=127.0.0.1/)
  assert.equal(f.active.size, 0)
  f.noCdp(false)
  for (const endpoint of ['ws://evil.example:9222/devtools/browser/example','ws://127.0.0.1:80/devtools/browser/example','ws://127.0.0.1:9222/not-cdp','wss://127.0.0.1:9222/devtools/browser/example']) {
    f.browsers.example.discovery = endpoint
    await assert.rejects(tools({ exec: f.exec }).browser_tabs.execute(args()), /start Chrome\/Chromium manually.*--user-data-dir/)
    assert.equal(f.active.size, 0)
  }
  f.browsers.example.discovery = undefined
  for (const property of ['fail','hang','malformed','frameLimit']) {
    f.browsers.example[property] = 'Target.getTargets'
    await assert.rejects(tools({ exec: f.exec, timeoutMs: 200, maxBytes: 1024 }).browser_tabs.execute(args()), /CDP|timed out/)
    f.browsers.example[property] = undefined
    assert.equal(f.active.size, 0)
  }
  f.fail(ok('', { code: 255, stderr: 'SSH refused' }))
  await assert.rejects(tools({ exec: f.exec }).browser_tabs.execute(args()), /SSH refused/)
  f.fail(undefined); f.collide(1)
  assert.equal(content(await tools({ exec: f.exec }).browser_tabs.execute(args()))[0].tab, 'tab-example')
  const transport = createSshTransport({ hosts, allowLocalTcp: process.platform === 'win32', exec: f.exec })
  await assert.rejects(transport.withForward('example', 9222, async () => { throw Error('callback failed') }), /callback failed/)
  assert.equal(f.active.size, 0)
})
test('browser: multiple tabs require stable selection and eval is bounded untrusted output', async (ctx) => {
  if (!await available(ctx)) return
  const f = fake(), t = tools({ exec: f.exec })
  f.browsers.example.tabs.push({ targetId: 'tab-second', type: 'page', title: 'Second', url: 'https://second.example' })
  await assert.rejects(t.browser_page.execute(args()), /Select an existing tab ID/)
  await t.browser_page.execute(args({ tab: 'tab-second' }))
  const output = await t.browser_eval.execute(args({ js: 'location.href' }))
  assert.equal(JSON.parse(output).trust, 'untrusted_browser_content')
  assert.ok(f.browsers.example.calls.some((m) => m.method === 'Runtime.evaluate' && m.params.expression === 'location.href' && !m.params.contextId))
})
test('browser: per-host concurrent calls serialize refs without leaking SSH processes', async (ctx) => {
  if (!await available(ctx)) return
  const f = fake(), t = tools({ exec: f.exec })
  await Promise.all([t.browser_page.execute(args({ mode: 'refs' })),t.browser_key.execute(args({ key: 'ctrl+a' })),t.browser_tabs.execute({ host: 'secondary' })])
  assert.equal(f.active.size, 0)
  assert.equal(f.calls.length, 3)
})
test('browser: DSH adapter advertises both hosts and gate denies mutations before transport', async () => {
  const registered = [], packs = [], hooks = {}; let calls = 0
  const ctx = { logger: { warn() {} }, tools: { register: (t) => registered.push(t) }, effect: (f) => f(), on: (n, f) => { hooks[n] = f }, inject: (_d, f) => f({ effect: (f) => f(), toolCatalog: { registerToolPack: (p) => packs.push(p) } }) }
  apply(ctx, { ...config, auditFile: '', exec: async () => { calls++; throw Error('unexpected') } })
  assert.deepEqual(packs.map((p) => p.id), ['browser'])
  assert.deepEqual(packs[0].items().map((i) => i.id), Object.keys(hosts))
  for (const name of ['browser_open','browser_click','browser_type','browser_key','browser_eval']) {
    const t = registered.find((t) => t.name === name)
    assert.equal((await hooks['tools/pre-execute']({ name, arguments: args() }, () => t.execute(args()))).kind, 'deny')
  }
  assert.ok(registered.every((t) => t.isConcurrencySafe() === false))
  assert.equal(calls, 0)
})
test('browser transport: real foreground runner abort cleans up child and stdin', async (ctx) => {
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ready")'], { encoding: 'utf8' })
  if (probe.error) return ctx.skip(`Child processes unavailable: ${probe.error.code}`)
  const controller = new AbortController()
  let ready = false
  const r = await localExec([process.execPath, '-e', "process.stdout.write('ready'); process.stdin.resume()"], { keepStdinOpen: true, signal: controller.signal, timeoutMs: 1500, onStdout: () => { ready = true; controller.abort() } })
  if (r.stderr.includes('EPERM') || r.stderr.includes('EACCES')) return ctx.skip('Child processes unavailable')
  assert.equal(ready, true, r.stderr)
  assert.equal(r.timedOut, false)
  assert.equal(controller.signal.aborted, true)
})

// Exercise actual snapshot/ref JavaScript even on hosts that forbid listeners.
// The separate tests above cover the real built-in WebSocket framing when allowed.
async function memory(ctx) {
  const { default: net } = await import('node:net')
  const { syncBuiltinESMExports } = await import('node:module')
  const { Cdp } = await import('../../packages/dsh-tool-ultra-pack-control/lib/browser-cdp.js')
  let port = 45000, active = 0
  ctx.mock.method(net, 'createServer', () => ({ once() {}, listen(_port, _host, fn) { fn() }, address: () => ({ port: port++ }), close(fn) { fn() } }))
  syncBuiltinESMExports()
  ctx.after(() => { ctx.mock.restoreAll(); syncBuiltinESMExports() })
  const browser = fakeBrowser()
  ctx.mock.method(Cdp, 'connect', async () => {
    const connection = browser.connect()
    return { async send(method, params = {}, sessionId) {
      const reply = await connection.handle({ id: 1, method, params, sessionId })
      if (reply.error) throw Error(reply.error.message)
      return reply.result
    }, close: connection.close }
  })
  const exec = async (argv, opts) => {
    if (!argv.includes('-L')) return ok('93.184.216.34 STREAM page.example\n')
    active++
    opts.onStdout(Buffer.from(argv.at(-1).match(/DSH_FORWARD_[a-f0-9-]+/)[0] + '\n'))
    await new Promise((r) => opts.signal.addEventListener('abort', r, { once: true }))
    active--
    return ok()
  }
  const outputDir = await mkdtemp(join(tmpdir(), 'control-browser-memory-'))
  ctx.after(() => rm(outputDir, { recursive: true, force: true }))
  const t = tools({ exec, outputDir })
  const snapshot = async () => JSON.parse(await t.browser_page.execute(args({ mode: 'refs' }))).content.match(/"ref":"([^"]+)"/)[1]
  return { browser, t, snapshot, active: () => active, options: { ...config, exec, outputDir } }
}

test('browser: fake SSH/CDP screenshot reaches defineTool model output as an image attachment', async (ctx) => {
  const { options, active } = await memory(ctx)
  const registered = [], saved = []
  const ref = { attachmentId: 'b'.repeat(64), mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 }
  const store = { async saveImage(input) { saved.push(input); return ref } }
  apply({ tools: { register: (t) => registered.push(t) }, get: () => store, on() {} }, { ...options, auditFile: '' })
  const tool = registered.find((t) => t.name === 'browser_shot')
  const value = await tool.execute(args(), { agent: { session: { id: 'session' } } })
  const blocks = tool.output.render(args(), value)
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'image'])
  assert.deepEqual(blocks[1], { type: 'image', attachment: ref })
  assert.match(blocks[0].text, /screenshot: .*\.png/)
  assert.deepEqual(saved[0].data, PNG)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.equal(active(), 0)
})

test('browser: in-memory CDP exercises isolated snapshot, click/type, keys, eval and navigation', async (ctx) => {
  const { browser, t, snapshot, active } = await memory(ctx)
  assert.equal(content(await t.browser_tabs.execute(args()))[0].tab, 'tab-example')
  let ref = await snapshot()
  await t.browser_click.execute(args({ ref }))
  await assert.rejects(t.browser_click.execute(args({ ref })), /Stale/)
  ref = await snapshot()
  const text = "'中文' $(example); `literal`\n"
  await t.browser_type.execute(args({ ref, text, submit: true }))
  assert.equal(browser.calls.find((m) => m.method === 'Input.insertText').params.text, text)
  ref = await snapshot(); browser.input.isConnected = false
  await assert.rejects(t.browser_click.execute(args({ ref })), /Stale/)
  browser.input.isConnected = true
  await t.browser_key.execute(args({ key: 'ctrl+a' }))
  assert.equal(browser.calls.filter((m) => m.method === 'Input.dispatchKeyEvent').at(-1).params.modifiers, 2)
  assert.equal(JSON.parse(await t.browser_eval.execute(args({ js: 'location.href' }))).trust, 'untrusted_browser_content')
  const path = (await t.browser_shot.execute(args())).slice('screenshot: '.length)
  assert.deepEqual(await readFile(path), PNG)
  await t.browser_open.execute(args({ url: 'https://page.example/', new_tab: false }))
  await t.browser_open.execute(args({ url: 'https://page.example/' }))
  assert.equal(active(), 0)
})

test('browser CDP: correlation, discovery validation, frame cap, malformed data and timeout without listeners', async (ctx) => {
  const { Cdp } = await import('../../packages/dsh-tool-ultra-pack-control/lib/browser-cdp.js')
  let endpoint = 'ws://127.0.0.1:9222/devtools/browser/example'
  let reply = (m) => ({ id: m.id, result: { method: m.method } })
  let sent = 0, closed = 0
  ctx.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, 'http://127.0.0.1:45000/json/version')
    assert.equal(opts.redirect, 'error')
    return new Response(JSON.stringify({ webSocketDebuggerUrl: endpoint }))
  })
  class FakeSocket extends EventTarget {
    constructor(url) { super(); assert.equal(url, 'ws://127.0.0.1:45000/devtools/browser/example'); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    send(raw) {
      sent++
      const message = reply(JSON.parse(raw))
      if (message !== undefined) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: typeof message === 'string' ? message : JSON.stringify(message) })))
    }
    close() { closed++ }
  }
  const OriginalSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeSocket
  ctx.after(() => { globalThis.WebSocket = OriginalSocket })
  let cdp = await Cdp.connect(45000, 9222, 100, 1024)
  assert.deepEqual(await Promise.all([cdp.send('one'),cdp.send('two')]), [{ method: 'one' },{ method: 'two' }])
  cdp.close()
  for (const unsafe of ['ws://evil.example:9222/devtools/browser/example','ws://127.0.0.1:9333/devtools/browser/example','ws://127.0.0.1:9222/devtools/page/example','ws://user:pass@127.0.0.1:9222/devtools/browser/example']) {
    endpoint = unsafe
    await assert.rejects(Cdp.connect(45000, 9222, 100, 1024), /Unsafe/)
  }
  endpoint = 'ws://127.0.0.1:9222/devtools/browser/example'
  for (const [handler, reason] of [
    [(m) => ({ id: m.id, error: { message: 'Example failure' } }), /CDP error/],
    [() => 'invalid JSON', /Malformed/],
    [(m) => ({ id: m.id, result: { data: 'x'.repeat(2000) } }), /byte limit/],
    [() => undefined, /timed out/],
  ]) {
    reply = handler
    cdp = await Cdp.connect(45000, 9222, 50, 1024)
    const before = sent
    await assert.rejects(cdp.send('example-operation'), reason)
    assert.equal(sent, before + 1, 'failed command is never replayed')
    cdp.close()
  }
  assert.ok(closed >= 5)
})

test('browser refs: new CDP connection and fresh world can click/type using only local backend IDs', async (ctx) => {
  const { browser, t, snapshot, active } = await memory(ctx)
  let ref = await snapshot()
  assert.equal(browser.liveObjects, 0, 'snapshot handles are released before disconnect')
  await t.browser_click.execute(args({ ref }))
  ref = await snapshot()
  await t.browser_type.execute(args({ ref, text: 'Across connections' }))
  const describes = browser.calls.filter((m) => m.method === 'DOM.describeNode')
  const resolves = browser.calls.filter((m) => m.method === 'DOM.resolveNode')
  assert.equal(browser.connections, 4)
  assert.equal(new Set(browser.contexts.map((c) => c.id)).size, 4)
  assert.equal(new Set(browser.contexts.map((c) => c.world)).size, 4)
  assert.ok(browser.contexts.every((c) => c.world.__dshRefs === undefined))
  assert.deepEqual(resolves.map((m) => m.params.backendNodeId), [1, 1], 'same DOM node survives fresh CDP sessions')
  for (let i = 0; i < 2; i++) {
    assert.notEqual(describes[i].connection, resolves[i].connection)
    assert.ok(describes[i].params.objectId.startsWith(`connection-${describes[i].connection}-`))
    const call = browser.calls.find((m) => m.connection === resolves[i].connection && m.method === 'Runtime.callFunctionOn')
    assert.ok(call.params.objectId.startsWith(`connection-${resolves[i].connection}-`), 'only freshly resolved object handles reach input checks')
    assert.match(call.params.functionDeclaration, /const el = this/)
  }
  assert.equal(browser.liveObjects, 0)
  assert.equal(active(), 0)
})

test('browser refs: navigation, unavailable nodes and old documents fail stale before input', async (ctx) => {
  const { browser, t, snapshot } = await memory(ctx)
  const inputs = () => browser.calls.filter((m) => m.method.startsWith('Input.')).length
  let ref = await snapshot()
  browser.navigate()
  await assert.rejects(t.browser_click.execute(args({ ref })), /Stale browser ref after navigation/)
  assert.equal(browser.calls.some((m) => m.method === 'DOM.resolveNode'), false, 'a new loader cannot reuse an old backend ID')
  ref = await snapshot()
  browser.forgetNode()
  await assert.rejects(t.browser_type.execute(args({ ref, text: 'must not appear' })), /Stale or unavailable browser ref/)
  await assert.rejects(t.browser_click.execute(args({ ref })), /Stale or unknown/)
  ref = await snapshot()
  // A document replacement with unchanged frame/loader IDs must still fail the
  // node's ownerDocument check inside the freshly created isolated world.
  browser.document = { ...browser.document }
  await assert.rejects(t.browser_click.execute(args({ ref })), /Stale browser ref/)
  assert.equal(inputs(), 0)
  assert.equal(browser.liveObjects, 0, 'failed resolution/checks release all temporary handles')
})

test('browser refs: resolved nodes still enforce visibility, occlusion and editability', async (ctx) => {
  const { browser, t, snapshot } = await memory(ctx)
  let ref = await snapshot()
  browser.document.elementFromPoint = () => null
  await assert.rejects(t.browser_click.execute(args({ ref })), /hidden or covered/)
  browser.document.elementFromPoint = () => browser.input
  ref = await snapshot(); browser.input.disabled = true
  await assert.rejects(t.browser_click.execute(args({ ref })), /disabled/)
  browser.input.disabled = false
  ref = await snapshot(); browser.input.readOnly = true
  await assert.rejects(t.browser_type.execute(args({ ref, text: 'blocked' })), /not editable/)
  assert.equal(browser.calls.some((m) => m.method.startsWith('Input.')), false)
  assert.equal(browser.liveObjects, 0)
})

test('browser refs: fake SSH/WebSocket reconnect resolves backend IDs in a new world', async (ctx) => {
  if (!await available(ctx)) return
  const f = fake(), t = tools({ exec: f.exec })
  const ref = JSON.parse(await t.browser_page.execute(args({ mode: 'refs' }))).content.match(/"ref":"([^"]+)"/)[1]
  await t.browser_click.execute(args({ ref }))
  const b = f.browsers.example
  const describe = b.calls.find((m) => m.method === 'DOM.describeNode')
  const resolve = b.calls.find((m) => m.method === 'DOM.resolveNode')
  assert.notEqual(describe.connection, resolve.connection)
  assert.notEqual(b.contexts[0].world, b.contexts[1].world)
  assert.equal(b.liveObjects, 0)
  assert.equal(f.active.size, 0)
})

test('browser refs: failed backend-ID snapshot clears old refs and releases temporary objects', async (ctx) => {
  const { browser, t, snapshot } = await memory(ctx)
  const ref = await snapshot()
  browser.fail = 'DOM.describeNode'
  await assert.rejects(snapshot(), /Example CDP failure/)
  browser.fail = undefined
  await assert.rejects(t.browser_click.execute(args({ ref })), /Stale or unknown/)
  assert.equal(browser.liveObjects, 0)
  assert.equal(browser.calls.some((m) => m.method.startsWith('Input.')), false)
})

test('browser refs: session-local snapshots and selected tabs cannot cross into another session', async (ctx) => {
  const { inCall } = await import('../../packages/dsh-tool-ultra-pack-control/lib/kit/scope.js')
  const { browser, t } = await memory(ctx)
  const as = (session, fn) => inCall({ session, failed: false }, fn)
  const snapshot = (session) => as(session, async () => JSON.parse(await t.browser_page.execute(args({ mode: 'refs', tab: 'tab-example' }))).content.match(/"ref":"([^"]+)"/)[1])
  const a = await snapshot('a')
  await assert.rejects(as('b', () => t.browser_click.execute(args({ ref: a }))), /Stale/)
  await snapshot('b')
  const prompt = as('a', () => t.browser_click.approve(args({ ref: a })))
  assert.match(prompt, /tab-example/)
  assert.match(prompt, /Example input/)
  await as('a', () => t.browser_click.execute(args({ ref: a })))
  browser.tabs.push({ targetId: 'tab-two', type: 'page', title: 'Second', url: 'https://page.example/second' })
  await assert.rejects(as('c', () => t.browser_page.execute(args())), /Select an existing tab/)
  await as('a', () => t.browser_page.execute(args()))
})
