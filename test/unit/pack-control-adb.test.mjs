// Fake adb only: no devices, network or KernelSU authorization are needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ADB_ROOT_TOOL_NAMES, ADB_TOOL_NAMES, TOOL_NAMES, apply, checkSerial, createTools, gate, parseUiDump, shq,
} from '../../packages/dsh-tool-ultra-pack-control/lib/index.js'
import { DEFAULT_GROUP_CATEGORIES, rulesClassifier } from '../../packages/dsh-tool-ultra-classifier-rules/lib/index.js'

const XML = readFileSync(new URL('../fixtures/pack-control/ui.xml', import.meta.url), 'utf8')
const SERIALS = { example: 'phone.example:5555', secondary: 'example-serial' }
const ok = (out = '', extra = {}) => ({ code: 0, stdout: String(out), stdoutBytes: Buffer.from(out), stderr: '', timedOut: false, truncated: false, ...extra })
function fake(reply = ok()) {
  const calls = []
  const exec = async (argv, options = {}) => {
    calls.push({ argv, options })
    if (argv[1] === 'connect') return ok(`connected to ${argv[2]}\n`)
    return typeof reply === 'function' ? reply(argv, options) : reply
  }
  return { exec, calls }
}
const config = { packs: { ssh: false, adb: true, 'adb-root': true }, serials: SERIALS }
const tools = (opts = {}) => Object.fromEntries(createTools({ ...config, ...opts }).map((s) => [s.name, s]))
const commands = (f) => f.calls.filter((c) => c.argv[1] !== 'connect')
const deviceArgs = (extra = {}) => ({ device: 'example', ...extra })
async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'control-adb-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('adb: opt-in, readOnly, disable, catalog declarations and compact schemas', () => {
  assert.equal(createTools().some((s) => s.name.startsWith('adb_')), false)
  const all = Object.values(tools())
  assert.deepEqual(all.map((s) => s.name), [...ADB_TOOL_NAMES, ...ADB_ROOT_TOOL_NAMES])
  assert.deepEqual(Object.keys(tools({ readOnly: true })), ['adb_devices', 'adb_info', 'adb_screen', 'adb_ui', 'adb_logcat'])
  assert.equal(tools({ disable: ['adb_shell'] }).adb_shell, undefined)
  assert.equal(tools({ packs: { ssh: false, adb: true } }).adb_shell, undefined)
  const metadata = JSON.parse(readFileSync(new URL('../../packages/dsh-tool-ultra-pack-control/package.json', import.meta.url))).dsh.toolCatalog.tools
  assert.deepEqual(Object.keys(metadata).sort(), [...TOOL_NAMES].sort())
  for (const s of all) {
    assert.deepEqual(metadata[s.name], { group: s.pack, category: 'device', risk: s.risk })
    assert.ok(Object.keys(s.parameters).length <= 4, s.name)
    assert.ok(Math.ceil(JSON.stringify(s.parameters).length / 4) <= 120, `${s.name}: approximate schema token budget`)
  }
  for (const [pack, budget] of [['adb', 1500], ['adb-root', 900]]) {
    const schema = all.filter((s) => s.pack === pack).map(({ name, description, parameters }) => ({ name, description, parameters }))
    assert.ok(Math.ceil(JSON.stringify(schema).length / 4) <= budget, pack)
  }
  assert.equal(rulesClassifier({ name: 'example', priority: 100, groupCategories: DEFAULT_GROUP_CATEGORIES }).categorize({ name: 'adb-root', tools: [] }), 'device')
})

test('adb: disabled packs ignore invalid device config; either enabled pack validates it', () => {
  for (const serials of [
    { '-example': 'example-serial' },
    { example: '-s' },
    { example: 'example-serial', secondary: 'example-serial' },
  ]) {
    assert.deepEqual(createTools({ serials }).map((s) => s.name), ['ssh_hosts', 'ssh_sys', 'ssh_read', 'ssh_log'])
    const h = host({ serials, packs: { ssh: true, adb: false, 'adb-root': false } })
    assert.deepEqual(h.packs.map((p) => p.id), ['ssh'])
    assert.equal(h.registered.some((s) => s.name.startsWith('adb_')), false)
    for (const pack of ['adb', 'adb-root']) {
      assert.throws(() => createTools({ serials, packs: { [pack]: true } }), /Bad|unique alias/)
    }
  }
})

test('adb: validates configured targets and never accepts a raw serial, option or inherited alias', async () => {
  for (const serial of ['-s', 'phone.example:0', 'phone.example:65536', 'phone.example:abc', 'example serial', 'example;id', 'example\nserial', 'example/serial']) {
    assert.throws(() => checkSerial('example', serial), /Bad/)
  }
  assert.throws(() => checkSerial('-example', 'example-serial'), /Bad/)
  assert.doesNotThrow(() => checkSerial('example', '[2001:db8::1]:5555'))
  assert.throws(() => tools({ serials: { a: 'example-serial', b: 'example-serial' } }), /unique alias/)
  const f = fake()
  const t = tools({ exec: f.exec })
  for (const device of [undefined, 'phone.example:5555', 'example-serial', '-s', 'toString', '__proto__']) {
    await assert.rejects(t.adb_info.execute({ device }), /Unknown device alias/)
  }
  assert.equal(f.calls.length, 0)
  await t.adb_info.execute({ device: 'secondary' })
  assert.deepEqual(f.calls[0].argv, ['adb', '-s', 'example-serial', 'shell', '-T', 'sh'])
  const serials = { ...SERIALS }
  const copied = tools({ exec: f.exec, serials })
  serials.example = 'other.example:5555'
  await copied.adb_info.execute(deviceArgs())
  assert.equal(commands(f).at(-1).argv[2], SERIALS.example, 'config mutation does not retarget tools')
})

test('adb: connects only configured wireless targets, reports authorization and filters unrelated devices', async () => {
  const f = fake(ok('List of devices attached\nphone.example:5555 device product:example model:Example_Phone\nexample-serial unauthorized\nunconfigured-serial device model:Private\n'))
  const t = tools({ exec: f.exec, adbBin: 'example-adb' })
  const out = await t.adb_devices.execute({})
  assert.match(out, /example: phone.example:5555 - device .*model:Example_Phone/)
  assert.match(out, /secondary: example-serial - unauthorized/)
  assert.doesNotMatch(out, /unconfigured|Private/)
  assert.deepEqual(f.calls.map((c) => c.argv), [['example-adb', 'connect', 'phone.example:5555'], ['example-adb', 'devices', '-l']])
  await t.adb_info.execute(deviceArgs())
  assert.deepEqual(f.calls.at(-1).argv.slice(0, 3), ['example-adb', '-s', 'phone.example:5555'])
  assert.match(f.calls.at(-1).options.stdin, /getprop ro.product.model/)
  const off = fake()
  await tools({ exec: off.exec, adbConnect: false }).adb_info.execute(deviceArgs())
  assert.equal(off.calls.length, 1)
  const failedCalls = []
  const failed = tools({ exec: async (argv) => { failedCalls.push(argv); return ok('failed to connect: token=example-secret') } })
  await assert.rejects(failed.adb_info.execute(deviceArgs()), /connect example failed/)
  assert.equal(failedCalls.length, 1, 'no device operation after failed connection')
  assert.doesNotMatch(await failed.adb_devices.execute({}), /example-secret/)
  assert.match(await tools({ serials: {}, exec: f.exec }).adb_devices.execute({}), /No adb devices/)
})

test('adb: fixed UI XML produces stable numbered centers, decodes entities and skips disabled/empty bounds', () => {
  const elements = parseUiDump(XML)
  assert.equal(elements.length, 5)
  assert.deepEqual(elements[0], { n: 1, text: '设置 & Tools', description: '', className: 'android.widget.Button', x: 120, y: 140 })
  assert.equal(elements[1].description, 'Search "apps"')
  assert.equal(elements[4].text, "🔍 A ' < >")
  assert.deepEqual([elements[4].x, elements[4].y], [50, 424])
  for (const xml of ['<!DOCTYPE hierarchy><hierarchy/>', '<hierarchy><node></hierarchy>', '<hierarchy/>trailing', '<hierarchy/><hierarchy/>', '<hierarchy bad="&external;"/>', '<hierarchy bad="bare & text"/>', '<hierarchy><other/></hierarchy>', '<hierarchy bad="x" bad="y"/>', '']) {
    assert.throws(() => parseUiDump(xml), /XML/)
  }
})

test('adb: UI references are device-specific, expire, reject ambiguity and are invalidated by input', async (ctx) => {
  const f = fake((_argv, options) => ok(options.stdin?.includes('uiautomator dump') ? XML : ''))
  const t = tools({ exec: f.exec })
  let now = 1000
  ctx.mock.method(Date, 'now', () => now)
  const out = await t.adb_ui.execute(deviceArgs())
  assert.match(out, /^\[1\] Button "设置 & Tools" \(120,140\)/)
  assert.match(commands(f)[0].options.stdin, /trap .*rm -f .* EXIT; uiautomator dump --compressed/)
  await assert.rejects(t.adb_tap.execute({ device: 'secondary', target: '1' }), /snapshot/)
  await assert.rejects(t.adb_tap.execute(deviceArgs({ target: 'text:Duplicate' })), /ambiguous/)
  await assert.rejects(t.adb_tap.execute(deviceArgs({ target: '999' })), /missing/)
  now += 30_001
  await assert.rejects(t.adb_tap.execute(deviceArgs({ target: '1' })), /expired/)
  await t.adb_ui.execute(deviceArgs())
  await t.adb_ui.execute({ device: 'secondary' })
  await t.adb_tap.execute(deviceArgs({ target: '1' }))
  assert.equal(commands(f).at(-1).options.stdin, 'input tap 120 140\n')
  await assert.rejects(t.adb_tap.execute(deviceArgs({ target: '1' })), /snapshot/)
  await t.adb_tap.execute({ device: 'secondary', target: 'text:Search "apps"' })
  assert.equal(commands(f).at(-1).options.stdin, 'input tap 950 150\n')
  await t.adb_ui.execute(deviceArgs())
  await t.adb_input.execute(deviceArgs({ kind: 'key', value: 'KEYCODE_HOME' }))
  await assert.rejects(t.adb_tap.execute(deviceArgs({ target: '1' })), /snapshot/)
  await t.adb_tap.execute(deviceArgs({ target: '12,34' }))
  assert.equal(commands(f).at(-1).options.stdin, 'input tap 12 34\n')
  for (const target of ['-1,2', '1,2;id', '100001,0']) await assert.rejects(t.adb_tap.execute(deviceArgs({ target })))
})

test('adb: failed, malformed, truncated and oversized UI refreshes cannot leave a previous reference usable', async () => {
  let reply = ok(XML)
  const f = fake(() => reply)
  const t = tools({ exec: f.exec })
  for (const next of [ok('bad xml'), ok(XML, { truncated: true }), ok('', { code: 1, stderr: 'UI dump failed' }), ok(XML, { timedOut: true })]) {
    reply = ok(XML)
    await t.adb_ui.execute(deviceArgs())
    reply = next
    await t.adb_ui.execute(deviceArgs()).catch(() => {})
    await assert.rejects(t.adb_tap.execute(deviceArgs({ target: '1' })), /snapshot/)
  }
  await assert.rejects(tools({ exec: fake(ok(XML)).exec, maxChars: 10 }).adb_ui.execute(deviceArgs()), /exceeds maxChars/)
})

test('adb: text, key, swipe, package and logcat parameters cannot inject shell commands', async () => {
  const f = fake(ok('token=example-secret\n'))
  const t = tools({ exec: f.exec })
  const value = `hello ' ; $(id) & > /example`
  assert.doesNotMatch(await t.adb_input.execute(deviceArgs({ kind: 'text', value })), /example-secret/)
  assert.equal(commands(f).at(-1).options.stdin, `input text ${shq(value.replace(/ /g, '%s'))}\n`)
  assert.deepEqual(commands(f).at(-1).argv, ['adb', '-s', 'phone.example:5555', 'shell', '-T', 'sh'])
  assert.doesNotMatch(t.adb_input.describe(deviceArgs({ value: 'PRIVATE-TEXT' })), /PRIVATE-TEXT/)
  await t.adb_input.execute(deviceArgs({ kind: 'swipe', value: '1,2,30,40,500' }))
  assert.equal(commands(f).at(-1).options.stdin, 'input swipe 1 2 30 40 500\n')
  await t.adb_input.execute(deviceArgs({ kind: 'swipe', value: '1,2,30,40' }))
  assert.equal(commands(f).at(-1).options.stdin, 'input swipe 1 2 30 40 300\n')
  for (const [kind, value] of [['key', 'KEYCODE_HOME;id'], ['swipe', '1,2,3,4;id'], ['swipe', '1,2,3,4,0'], ['text', '中文'], ['text', 'literal%s'], ['other', 'x']]) {
    await assert.rejects(t.adb_input.execute(deviceArgs({ kind, value })))
  }
  for (const action of ['current', 'list', 'start', 'stop']) await t.adb_app.execute(deviceArgs({ action, pkg: 'org.example.app' }))
  assert.equal(commands(f).at(-1).options.stdin, "am force-stop 'org.example.app'\n")
  assert.ok(commands(f).some((c) => c.options.stdin === "monkey -p 'org.example.app' -c android.intent.category.LAUNCHER 1\n"))
  await assert.rejects(t.adb_app.execute(deviceArgs({ action: 'start', pkg: 'org.example.app;id' })), /package id/)
  await assert.rejects(t.adb_app.execute(deviceArgs({ action: 'install' })), /App action/)
  await t.adb_logcat.execute(deviceArgs({ lines: 9999, tag: 'ExampleTag', level: 'E' }))
  assert.equal(commands(f).at(-1).options.stdin, "logcat -d -t 500 'ExampleTag:E' '*:S'\n")
  await t.adb_logcat.execute(deviceArgs())
  assert.equal(commands(f).at(-1).options.stdin, "logcat -d -t 50 '*:I'\n")
  for (const tag of ['Example;id', '-c']) await assert.rejects(t.adb_logcat.execute(deviceArgs({ tag })), /Invalid logcat tag/)
  await assert.rejects(t.adb_logcat.execute(deviceArgs({ level: 'E;id' })), /Invalid logcat level/)
})

test('adb: shell commands use stdin, root is KernelSU su -c sh, and time/output limits apply', async () => {
  const f = fake(ok('password=example-secret\n' + 'x'.repeat(1000), { stderr: 'token=example-private', truncated: true }))
  const t = tools({ exec: f.exec, maxChars: 100, maxBytes: 1234 })
  const cmd = `printf '%s' "$(id)"; echo "it's root"`
  const out = await t.adb_shell.execute(deviceArgs({ cmd, root: true, timeout_s: 9999 }))
  const call = commands(f).at(-1)
  assert.deepEqual(call.argv, ['adb', '-s', 'phone.example:5555', 'shell', '-T', 'su', '-c', 'sh'])
  assert.equal(call.options.stdin, `${cmd}\n`)
  assert.equal(call.options.timeoutMs, 600_000)
  assert.equal(call.options.maxBytes, 1234)
  assert.doesNotMatch(out, /example-secret|example-private/)
  assert.match(out, /omitted|byte limit/)
  assert.ok(!f.calls.some((c) => c.argv.includes('root') || c.argv.includes('reboot')))
  await t.adb_shell.execute(deviceArgs({ cmd: 'id', root: false }))
  assert.deepEqual(commands(f).at(-1).argv.slice(3), ['shell', '-T', 'sh'])
  for (const root of ['false', 1, null]) await assert.rejects(t.adb_shell.execute(deviceArgs({ cmd: 'id', root })), /boolean/)
  for (const cmd of ['', '\0', '  ']) await assert.rejects(t.adb_shell.execute(deviceArgs({ cmd })), /Give a shell command/)
})

test('adb: root calls always ask, conservative non-root reads skip, and allow can waive approval per session', () => {
  const specs = Object.values(tools())
  const decide = gate(specs)
  const call = (name, args = {}) => decide({ name, arguments: deviceArgs(args), agent: { id: 'example-session' } })
  for (const name of ['adb_push', 'adb_install']) assert.equal(call(name).kind, 'ask')
  for (const cmd of ['id', 'cat /example', 'ls']) assert.equal(call('adb_shell', { cmd, root: true }).kind, 'ask')
  for (const cmd of ['id', 'ls /sdcard']) assert.equal(call('adb_shell', { cmd }), undefined)
  for (const cmd of ['ls; id', 'ls $(id)', 'ls > /example', 'reboot', 'cat /proc/1/environ']) assert.equal(call('adb_shell', { cmd }).kind, 'ask')
  assert.equal(call('adb_pull', { root: true }).kind, 'ask')
  assert.equal(call('adb_pull'), undefined)
  assert.equal(call('adb_input'), undefined)
  const ask = gate(Object.values(tools({ adbAskInput: true })))
  for (const name of ['adb_tap', 'adb_input']) assert.equal(ask({ name, arguments: deviceArgs() }).kind, 'ask')
  assert.equal(ask({ name: 'adb_app', arguments: deviceArgs({ action: 'start' }) }).kind, 'ask')
  assert.equal(ask({ name: 'adb_app', arguments: deviceArgs({ action: 'current' }) }), undefined)
  assert.equal(gate(specs, { 'example-session': ['adb_shell'] })({ name: 'adb_shell', arguments: deviceArgs({ root: true, cmd: 'id' }), agent: { id: 'example-session' } }), undefined)
})

test('adb: binary screenshots save private unique PNG files and reject partial/error output', async (ctx) => {
  const dir = await folder(ctx)
  // Fixed binary payload, including bytes which would be corrupted by UTF-8 decoding.
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128])
  let reply = ok(png)
  const f = fake(() => reply)
  const t = tools({ exec: f.exec, outputDir: dir, maxTransferBytes: 100 })
  const first = (await t.adb_screen.execute(deviceArgs())).slice('screenshot: '.length)
  const second = (await t.adb_screen.execute(deviceArgs())).slice('screenshot: '.length)
  assert.notEqual(first, second)
  assert.deepEqual(await readFile(first), png)
  if (process.platform !== 'win32') assert.equal((await stat(first)).mode & 0o777, 0o600)
  assert.equal(commands(f).at(-1).options.stdin, 'exec screencap -p\n')
  assert.equal(commands(f).at(-1).options.maxBytes, 101)
  for (const extra of [{ truncated: true }, { stdoutBytes: Buffer.alloc(101) }, { stdoutBytes: Buffer.from('not png') }]) {
    reply = ok(png, extra)
    await assert.rejects(t.adb_screen.execute(deviceArgs()), /truncated|PNG/)
  }
  reply = ok('', { code: 1, stderr: 'device unauthorized' })
  assert.match(await t.adb_screen.execute(deviceArgs()), /unauthorized/)
  assert.equal((await readdir(dir)).length, 2)
})

test('adb: pull preserves bytes, quotes remote paths, confines local names and never overwrites', async (ctx) => {
  const dir = await folder(ctx)
  const payload = Buffer.from([0, 1, 255, 128])
  let reply = ok(payload)
  const f = fake(() => reply)
  const t = tools({ exec: f.exec, transferDir: dir, maxTransferBytes: 10 })
  const remote = "/sdcard/example's $(id); file.bin"
  assert.match(await t.adb_pull.execute(deviceArgs({ remote, local: 'example.bin', root: true })), /saved 4 bytes/)
  assert.deepEqual(await readFile(join(dir, 'example.bin')), payload)
  const call = commands(f).at(-1)
  assert.equal(call.options.stdin, `if [ -f ${shq(remote)} ]; then exec head -c 11 -- ${shq(remote)}; else echo 'Remote path must be a regular file.' >&2; exit 1; fi\n`)
  assert.deepEqual(call.argv.slice(3), ['shell', '-T', 'su', '-c', 'sh'])
  await assert.rejects(t.adb_pull.execute(deviceArgs({ remote, local: 'example.bin' })), /EEXIST/)
  for (const local of ['../escape', '/tmp/example', 'a/b', '-option', '.hidden', 'a\\b', '']) {
    await assert.rejects(t.adb_pull.execute(deviceArgs({ remote, local })), /plain local file name/)
  }
  for (const remote of ['relative', '/sdcard/../example', '/sdcard/./example', '/', '/sdcard/', '/sdcard/a\nfile', '/etc/shadow']) {
    await assert.rejects(t.adb_pull.execute(deviceArgs({ remote, local: 'never.bin' })))
    await assert.rejects(t.adb_push.execute(deviceArgs({ remote, local: 'never.bin' })))
  }
  await assert.rejects(tools({ exec: f.exec, transferDir: dir, denyPaths: ['^/data/private/'] }).adb_pull.execute(deviceArgs({ remote: '/data/private/example', local: 'never.bin' })), /credentials/)
  for (const extra of [{ truncated: true }, { stdoutBytes: Buffer.alloc(11) }]) {
    reply = ok(payload, extra)
    await assert.rejects(t.adb_pull.execute(deviceArgs({ remote, local: 'never.bin' })), /nothing saved/)
  }
  reply = ok(payload, { code: 1 })
  assert.match(await t.adb_pull.execute(deviceArgs({ remote, local: 'never.bin' })), /exit 1/)
  assert.deepEqual(await readdir(dir), ['example.bin'])
})

test('adb: push and install use bounded private copies, refuse symlinks/traversal and clean staging on failures', async (ctx) => {
  const dir = await folder(ctx)
  await writeFile(join(dir, 'example.bin'), Buffer.from([0, 255, 1]))
  await writeFile(join(dir, 'example.apk'), 'example apk')
  const staged = []
  const f = fake(async (argv) => {
    const path = argv.at(-2) === 'install' ? argv.at(-1) : argv.at(-2)
    staged.push(path)
    assert.notEqual(dirname(path), dir)
    assert.ok(path.endsWith('example.bin') || path.endsWith('example.apk'), 'staging preserves the name for adb directory destinations')
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600)
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700)
    }
    return ok(await readFile(path))
  })
  const t = tools({ exec: f.exec, transferDir: dir, maxTransferBytes: 100 })
  const remote = '/sdcard/example $(id); file.bin'
  assert.match(await t.adb_push.execute(deviceArgs({ local: 'example.bin', remote })), /uploaded 3 bytes/)
  assert.deepEqual(commands(f)[0].argv.slice(0, 4), ['adb', '-s', 'phone.example:5555', 'push'])
  assert.equal(commands(f)[0].argv.at(-1), remote)
  await t.adb_install.execute(deviceArgs({ apk: 'example.apk' }))
  assert.deepEqual(commands(f).at(-1).argv.slice(0, 4), ['adb', '-s', 'phone.example:5555', 'install'])
  for (const path of staged) await assert.rejects(stat(dirname(path)), /ENOENT/)
  for (const local of ['../escape', '/tmp/example', '-option', 'a/b']) {
    await assert.rejects(t.adb_push.execute(deviceArgs({ local, remote })), /plain local/)
    await assert.rejects(t.adb_install.execute(deviceArgs({ apk: local })), /plain local/)
  }
  await ctx.test('symlink sources are refused before push or install', async (sub) => {
    try {
      await symlink(join(dir, 'example.bin'), join(dir, 'link.apk'))
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(e.code)) {
        sub.skip(`Windows cannot create symlinks here: ${e.code}`)
        return
      }
      throw e
    }
    const seen = f.calls.length
    await assert.rejects(t.adb_push.execute(deviceArgs({ local: 'link.apk', remote })), /symlinks are not allowed|ELOOP/)
    await assert.rejects(t.adb_install.execute(deviceArgs({ apk: 'link.apk' })), /symlinks are not allowed|ELOOP/)
    assert.equal(f.calls.length, seen, 'refused symlinks never reach adb')
  })
  await mkdir(join(dir, 'directory'))
  await assert.rejects(t.adb_push.execute(deviceArgs({ local: 'directory', remote })), /regular file/)
  await assert.rejects(t.adb_install.execute(deviceArgs({ apk: 'example.bin' })), /\.apk/)
  await assert.rejects(tools({ exec: f.exec, transferDir: dir, maxTransferBytes: 1 }).adb_push.execute(deviceArgs({ local: 'example.bin', remote })), /larger than/)
  let failedPath
  const failing = tools({ transferDir: dir, adbConnect: false, exec: async (argv) => { failedPath = argv.at(-1); throw new Error('example runner failure') } })
  await assert.rejects(failing.adb_install.execute(deviceArgs({ apk: 'example.apk' })), /runner failure/)
  await assert.rejects(stat(dirname(failedPath)), /ENOENT/)
})

function host(extra = {}) {
  const registered = [], packs = [], hooks = {}
  const ctx = {
    logger: { warn() {} }, tools: { register: (t) => registered.push(t) },
    effect: (fn) => fn(), on: (name, hook) => { hooks[name] = hook },
    inject: (_deps, fn) => fn({ effect: (f) => f(), toolCatalog: { registerToolPack: (p) => packs.push(p) } }),
  }
  apply(ctx, { ...config, auditFile: '', ...extra })
  return { registered, packs, hooks }
}

test('adb: DSH adapter registers packs and blocks execution when call approval is refused', async () => {
  const f = fake()
  const h = host({ exec: f.exec })
  assert.deepEqual(h.packs.map((p) => p.id), ['adb', 'adb-root'])
  assert.deepEqual(h.packs[0].items().map((i) => i.id), ['example', 'secondary'])
  assert.match(h.packs[0].items()[0].detail, /configured:.*use adb_devices/)
  assert.deepEqual(host({ serials: {} }).packs[0].items().map((i) => i.state), ['waiting'])
  const spec = h.registered.find((t) => t.name === 'adb_shell')
  const args = deviceArgs({ cmd: 'id', root: true })
  const decision = await h.hooks['tools/pre-execute']({ name: 'adb_shell', arguments: args }, () => spec.execute(args))
  assert.equal(decision.kind, 'ask')
  assert.equal(f.calls.length, 0, 'gate returns ask before the runner is invoked')
  assert.equal(spec.isConcurrencySafe(), false)
  assert.equal(h.registered.find((t) => t.name === 'adb_ui').isConcurrencySafe(), false)
  assert.equal(host({ readOnly: true }).registered.some((t) => t.name === 'adb_shell'), false)
})

test('adb: an input concurrent with a UI dump cannot publish stale numbered references', async () => {
  let finishDump
  const f = fake((_argv, options) => options.stdin?.includes('uiautomator dump') ? new Promise((resolve) => { finishDump = resolve }) : ok())
  const t = tools({ exec: f.exec, adbConnect: false })
  const dumping = t.adb_ui.execute(deviceArgs())
  await t.adb_input.execute(deviceArgs({ kind: 'key', value: 'KEYCODE_HOME' }))
  finishDump(ok(XML))
  await assert.rejects(dumping, /UI changed during the dump/)
  await assert.rejects(t.adb_tap.execute(deviceArgs({ target: '1' })), /snapshot/)
})
