import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  apply, checkDesktopSession, createTools, DESKTOP_PROBE, DESKTOP_TOOL_NAMES,
  desktopCombo, desktopWindows, gate, shq, selectDesktopSession, desktopCommandScript,
} from '../../packages/dsh-tool-ultra-pack-control/lib/index.js'

const HOSTS = {
  example: { target: 'user@desktop.example' },
  secondary: { target: 'user@secondary.example', port: 2222, identity: '/example/key', desktop: { env: { WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000' } } },
}
const config = { hosts: HOSTS, packs: { ssh: false, desktop: true }, multiplex: false, desktopCacheMs: 0 }
const encode = (value) => Buffer.from(value).toString('base64')
const record = (uid, env) => ({ uid, env })
function snapshot({ loginUid = 1000, users = ['root:0:0:/root', 'example:1000:1000:/home/example', 'secondary:1001:1001:/home/secondary'], records = [], sockets = [], logins = [] } = {}) {
  return ['DSH_DESKTOP_V2', `I\t${loginUid}`, `U\t${encode(users.join('\n'))}`,
    ...logins.map((l) => `L\t${l.id}\t${encode(Object.entries({ User: l.uid, Active: 'yes', Type: 'wayland', Class: 'user', State: 'active', ...l.props }).map(([k, v]) => `${k}=${v}`).join('\n'))}`),
    ...records.map((r) => `P\t${r.uid}\t${encode(Object.entries(r.env).map(([k, v]) => `${k}=${v}\0`).join(''))}`),
    ...sockets.map((s) => `S\t${s.uid ?? 1000}:${s.inode ?? '42'}\t${encode(s.path)}`), 'END'].join('\n') + '\n'
}
const wayland = (more = {}, uid = 1000, display = 'wayland-1') => ({ WAYLAND_DISPLAY: display, XDG_RUNTIME_DIR: `/run/user/${uid}`, ...more })
const session = (kind = 'x11', env = {}, more = {}) => snapshot({
  records: [record(1000, kind === 'x11' ? { DISPLAY: ':0', XAUTHORITY: "/example/user's authority", ...env } : wayland({ ...({ sway: { SWAYSOCK: '/run/user/1000/sway-ipc.example.sock' }, niri: { NIRI_SOCKET: '/run/user/1000/niri.wayland-1.example.sock' }, hyprland: { HYPRLAND_INSTANCE_SIGNATURE: 'example-signature' } }[kind] ?? {}), ...env }))],
  sockets: [{ path: kind === 'x11' ? '/tmp/.X11-unix/X0' : '/run/user/1000/wayland-1' }], ...more,
})
const ok = (data = '', extra = {}) => ({ code: 0, stdout: Buffer.isBuffer(data) ? data.toString('utf8') : data, stdoutBytes: Buffer.from(data), stderr: '', truncated: false, timedOut: false, ...extra })
// Undo only the shell quoting emitted by the shared transport.
const scriptOf = ({ argv }) => argv.at(-1).slice("sh -c '".length, -1).split(`'\\''`).join("'")
function fake(reply = () => ok(), probe) {
  const calls = []
  const exec = async (argv, options = {}) => {
    const call = { argv, options }
    calls.push(call)
    return scriptOf(call).includes('# DSH_DESKTOP_PROBE_V2')
      ? typeof probe === 'function' ? probe(call) : ok(probe ?? (argv.includes('user@secondary.example') ? session('sway') : session()))
      : reply(call)
  }
  return { exec, calls, actions: () => calls.filter((c) => !scriptOf(c).includes('# DSH_DESKTOP_PROBE_V2')) }
}
const tools = (opts = {}) => Object.fromEntries(createTools({ ...config, ...opts }).map((t) => [t.name, t]))
const args = (extra = {}) => ({ host: 'example', ...extra })
async function folder(ctx) {
  const dir = await mkdtemp(join(tmpdir(), 'control-desktop-'))
  ctx.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('desktop: opt-in, metadata, small schemas, readOnly and disable', () => {
  assert.equal(createTools().some((t) => t.pack === 'desktop'), false)
  const all = Object.values(tools())
  assert.deepEqual(all.map((t) => t.name), [...DESKTOP_TOOL_NAMES])
  const pkg = JSON.parse(readFileSync(new URL('../../packages/dsh-tool-ultra-pack-control/package.json', import.meta.url)))
  for (const t of all) {
    assert.deepEqual(pkg.dsh.toolCatalog.tools[t.name], { group: 'desktop', category: 'device', risk: t.risk })
    assert.equal(t.parameters.host.required, true)
    assert.ok(Object.keys(t.parameters).length <= 4)
    assert.ok(JSON.stringify(t.parameters).length <= 600, t.name)
  }
  assert.deepEqual(Object.keys(tools({ readOnly: true })).sort(), ['desktop_clipboard_get', 'desktop_screen', 'desktop_windows'])
  assert.equal(tools({ disable: ['desktop_key'] }).desktop_key, undefined)
  assert.doesNotThrow(() => createTools({ ...config, packs: { ssh: false }, hosts: { example: { target: 'user@desktop.example', desktop: { env: { PATH: 'ignored-when-disabled' } } } } }))
})

test('desktop: every configured host works, using shared SSH flags and strict alias selection', async () => {
  const f = fake(() => ok('example clipboard'))
  const t = tools({ exec: f.exec, sshBin: 'example-ssh', timeoutMs: 3210, maxBytes: 1234 })
  for (const host of Object.keys(HOSTS)) assert.equal(await t.desktop_clipboard_get.execute({ host }), 'example clipboard')
  assert.equal(f.calls.length, 4)
  assert.deepEqual(f.calls.map((c) => c.argv[c.argv.indexOf('--') + 1]), ['user@desktop.example', 'user@desktop.example', 'user@secondary.example', 'user@secondary.example'])
  assert.equal(f.calls[0].argv[0], 'example-ssh')
  assert.ok(f.calls[0].argv.includes('BatchMode=yes'))
  assert.ok(!f.calls[0].argv.includes('ControlMaster=auto'))
  assert.ok(f.calls[2].argv.includes('2222'))
  assert.ok(f.calls[2].argv.includes('/example/key'))
  assert.equal(f.calls[2].options.stdin, undefined)
  assert.ok(scriptOf(f.calls[2]).includes("desktop_runtime='/run/user/1000'"))
  assert.doesNotMatch(scriptOf(f.calls[2]), /python|eval\s/)
  assert.equal(f.actions()[0].options.maxBytes, 1234)
  assert.equal(f.actions()[0].options.timeoutMs, 3210)
  assert.match(scriptOf(f.actions()[0]), /unset DISPLAY XAUTHORITY WAYLAND_DISPLAY/)
  assert.ok(scriptOf(f.actions()[0]).includes(`XAUTHORITY=${shq("/example/user's authority")}`))
  const count = f.calls.length
  for (const host of [undefined, '', 'user@desktop.example', '-option', 'toString', '__proto__', ['example']]) await assert.rejects(t.desktop_windows.execute({ host }), /Unknown host/)
  assert.equal(f.calls.length, count)
  await assert.rejects(tools({ hosts: {}, exec: f.exec }).desktop_windows.execute(args()), /No ssh hosts/)
})

test('desktop: config/probe validation and failures stop before any action', async () => {
  for (const env of [{ PATH: '/example' }, { DISPLAY: ':0\nexec false' }, { DISPLAY: 1 }, { DISPLAY: 'a\0b' }]) assert.throws(() => checkDesktopSession({ env }), /Invalid desktop/)
  for (const value of [null, [], 'x11']) assert.throws(() => checkDesktopSession(value), /configuration object/)
  assert.throws(() => checkDesktopSession({ backend: 'unknown' }), /Bad desktop backend/)
  for (const reply of [ok('', { code: 127, stderr: 'Missing remote probe command: base64' }), ok('', { timedOut: true }), ok('{}', { truncated: true }), ok('not a probe'), ok('DSH_DESKTOP_V2\nI\t0\nEND'), ok('DSH_DESKTOP_V2\nI\t0\nU\t$$\nEND')]) {
    const f = fake(() => { throw new Error('Action must not run') }, () => reply)
    await assert.rejects(tools({ exec: f.exec }).desktop_windows.execute(args()))
    assert.equal(f.actions().length, 0)
  }
})

test('desktop: all mutations always ask even in allowed sessions; reads proceed', async () => {
  const all = Object.values(tools())
  const decide = gate(all)
  for (const t of all) {
    const decision = decide({ name: t.name, arguments: args(), agent: { id: 'example-session' } })
    assert.equal(decision?.kind, t.risk === 'low' ? undefined : 'ask', t.name)
  }
  assert.equal(gate(all, { 'example-session': ['desktop_key'] })({ name: 'desktop_key', arguments: args({ combo: 'Return' }), agent: { id: 'example-session' } }).kind, 'ask')
  assert.equal(gate(all, { '*': true })({ name: 'desktop_type', arguments: args({ text: 'example' }) }).kind, 'ask')
  const secret = 'example-body $(id); password=example-secret'
  for (const name of ['desktop_type', 'desktop_clipboard_set']) {
    assert.ok(!tools()[name].describe(args({ text: secret })).includes(secret))
    assert.ok(tools()[name].approve(args({ text: secret })).includes(secret))
  }
})

test('desktop: binary screenshots are private unique local PNGs and partial/error payloads are never saved', async (ctx) => {
  const dir = await folder(ctx)
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 128, 0])
  let reply = ok(png)
  const f = fake(() => reply)
  const t = tools({ exec: f.exec, outputDir: dir, maxTransferBytes: 100 })
  const a = (await t.desktop_screen.execute(args())).slice('screenshot: '.length)
  const b = (await t.desktop_screen.execute(args())).slice('screenshot: '.length)
  assert.notEqual(a, b)
  assert.deepEqual(await readFile(a), png)
  if (process.platform !== 'win32') assert.equal((await stat(a)).mode & 0o777, 0o600)
  assert.equal(f.actions()[0].options.maxBytes, 101)
  assert.ok(scriptOf(f.actions()[0]).endsWith("'scrot' '-F' '-'"))
  for (const extra of [{ truncated: true }, { stdoutBytes: Buffer.alloc(101) }, { stdoutBytes: Buffer.from('not png') }]) {
    reply = ok(png, extra)
    await assert.rejects(t.desktop_screen.execute(args()), /truncated|PNG/)
  }
  reply = ok(png, { code: 1, stderr: 'capture failed' })
  assert.match(await t.desktop_screen.execute(args()), /capture failed/)
  assert.equal((await readdir(dir)).length, 2)
  const w = fake(() => ok(png), session('niri'))
  await tools({ exec: w.exec, outputDir: dir }).desktop_screen.execute(args())
  assert.ok(scriptOf(w.actions()[0]).endsWith("'grim' '-t' 'png' '-'"))
  assert.doesNotMatch(scriptOf(w.actions()[0]), /screenshot-screen|wl-copy/)
})

test('desktop: native window listings include IDs, focus and quoted titles for all backends', async () => {
  const fixtures = {
    x11: '42\n0x0000002a  0 Example.App desktop.example Example title\n',
    sway: JSON.stringify({ type: 'root', nodes: [{ type: 'con', id: 42, app_id: 'example', name: 'Example title', focused: true, rect: { x: 1, y: 2, width: 3, height: 4 } }], floating_nodes: [{ type: 'con', id: 43, window: 43, window_properties: { class: 'example' }, name: "Example's $(id); title", focused: false }] }),
    hyprland: JSON.stringify({ windows: [{ address: '0x2a', class: 'example', title: 'Example title', focusHistoryID: 0, at: [1, 2], size: [3, 4] }], active: { address: '0x2a' } }),
    niri: JSON.stringify([{ id: 42, app_id: 'example', title: 'Example title', is_focused: true }]),
  }
  const commands = { x11: "'wmctrl' '-lx'", sway: "'swaymsg' '-r' '-t' 'get_tree'", hyprland: "'hyprctl' '-j' 'activewindow'\nprintf '}'", niri: "'niri' 'msg' '--json' 'windows'" }
  for (const [kind, raw] of Object.entries(fixtures)) {
    const f = fake(() => ok(raw), session(kind))
    const out = await tools({ exec: f.exec }).desktop_windows.execute(args())
    assert.match(out, /Example title/)
    assert.match(out, /"focused":true/)
    assert.ok(scriptOf(f.actions()[0]).endsWith(commands[kind]))
  }
  assert.match(desktopWindows('sway', fixtures.sway), /Example's \$\(id\); title/)
  const inactive = JSON.parse(fixtures.hyprland)
  inactive.active = {}
  assert.match(desktopWindows('hyprland', JSON.stringify(inactive)), /"focused":false/, 'focus history is not proof a client currently has focus')
  assert.throws(() => desktopWindows('niri', '{}'), /Invalid compositor/)
  const f = fake(() => { throw new Error('must not use Xwayland') }, session('wayland', { XDG_CURRENT_DESKTOP: 'ExampleDE' }))
  await assert.rejects(tools({ exec: f.exec }).desktop_windows.execute(args()), /unsupported.*ExampleDE/)
})

test('desktop: focus accepts strict native IDs only and recognizes IPC failures', async () => {
  for (const [kind, id, reply, ending] of [
    ['x11', '0x2a', '', "'xdotool' 'windowactivate' '--sync' '0x2a'"],
    ['sway', '42', '[{"success":true}]', "'swaymsg' '-r' '[con_id=42] focus'"],
    ['hyprland', '0x2a', 'ok\n', "'hyprctl' 'dispatch' 'focuswindow' 'address:0x2a'"],
    ['niri', '42', '', "'niri' 'msg' 'action' 'focus-window' '--id' '42'"],
  ]) {
    const f = fake(() => ok(reply), session(kind))
    assert.match(await tools({ exec: f.exec }).desktop_focus.execute(args({ window: id })), /focused/)
    assert.ok(scriptOf(f.actions()[0]).endsWith(ending))
  }
  const f = fake()
  for (const window of ["Example's $(id)", '42] exec false', '-1', '42; false', '', '0x1\n']) await assert.rejects(tools({ exec: f.exec }).desktop_focus.execute(args({ window })), /window id/)
  assert.equal(f.calls.length, 0)
  const failed = fake(() => ok('[{"success":false,"error":"no matching window"}]'), session('sway'))
  await assert.rejects(tools({ exec: failed.exec }).desktop_focus.execute(args({ window: '42' })), /Sway focus failed/)
  const hypr = fake(() => ok('Invalid window'), session('hyprland'))
  await assert.rejects(tools({ exec: hypr.exec }).desktop_focus.execute(args({ window: '0x2a' })), /Hyprland focus failed/)
})

test('desktop: text/clipboard travel on stdin literally, with no shell or option injection', async () => {
  const text = "--help '中文' $(id); `false` \\ \"example\"\nnext\tline"
  for (const kind of ['x11', 'sway']) {
    const f = fake(() => ok(), session(kind))
    const t = tools({ exec: f.exec })
    await t.desktop_type.execute(args({ text }))
    await t.desktop_clipboard_set.execute(args({ text }))
    for (const c of f.actions()) {
      assert.equal(c.options.stdin, text)
      assert.ok(!c.argv.join(' ').includes(text))
    }
    assert.ok(scriptOf(f.actions()[0]).endsWith(kind === 'x11' ? "'xdotool' 'type' '--clearmodifiers' '--file' '-'" : "'wtype' '-'"))
    assert.match(scriptOf(f.actions()[1]), /trap.*rm -rf/)
    await t.desktop_clipboard_set.execute(args({ text: '' }))
    assert.equal(f.actions().at(-1).options.stdin, '')
    const seen = f.calls.length
    for (const text of [undefined, null, 'a\0b', 'x'.repeat(20001)]) {
      await assert.rejects(t.desktop_type.execute(args({ text })), /Give text/)
      await assert.rejects(t.desktop_clipboard_set.execute(args({ text })), /Give clipboard/)
    }
    assert.equal(f.calls.length, seen)
  }
})

test('desktop: key combos are bounded tokens, and Wayland modifiers are released in reverse order', async () => {
  for (const combo of ['ctrl+l', 'super+shift+F12', 'Return', 'alt+Tab', 'ctrl+plus']) assert.ok(desktopCombo(combo))
  for (const combo of ['ctrl+l; false', 'ctrl+$(id)', '--help', 'ctrl+ctrl+l', 'ctrl+', 'ctrl+a key b', 'x'.repeat(101), undefined]) assert.throws(() => desktopCombo(combo), /combo/)
  const f = fake(() => ok(), session('sway'))
  await tools({ exec: f.exec }).desktop_key.execute(args({ combo: 'ctrl+shift+l' }))
  assert.ok(scriptOf(f.actions()[0]).endsWith("'wtype' '-M' 'ctrl' '-M' 'shift' '-k' 'l' '-m' 'shift' '-m' 'ctrl'"))
})

test('desktop: click validates coordinates/buttons and Wayland never starts a daemon or escalates', async () => {
  const f = fake()
  const t = tools({ exec: f.exec })
  for (const more of [{ x: '1', y: 2 }, { x: -1, y: 2 }, { x: 1.1, y: 2 }, { x: 1, y: 100001 }, { x: 1, y: 2, button: '1;false' }]) await assert.rejects(t.desktop_click.execute(args(more)))
  assert.equal(f.calls.length, 0)
  await t.desktop_click.execute(args({ x: 1, y: 2, button: 'right' }))
  assert.ok(scriptOf(f.actions()[0]).endsWith("'xdotool' 'mousemove' '--sync' '1' '2' 'click' '3'"))
  const missing = fake(() => ok(), session('niri'))
  await assert.rejects(tools({ exec: missing.exec }).desktop_click.execute(args({ x: 1, y: 2 })), /YDOTOOL_SOCKET/)
  assert.equal(missing.actions().length, 0)
  const inherited = fake(() => ok(), session('niri', { YDOTOOL_SOCKET: '/example/inherited-seat.sock' }))
  await assert.rejects(tools({ exec: inherited.exec }).desktop_click.execute(args({ x: 1, y: 2 })), /YDOTOOL_SOCKET/)
  assert.equal(inherited.actions().length, 0, 'an inherited daemon socket does not authorize seat-level input')
  const wayland = fake(() => ok(), session('hyprland', { YDOTOOL_SOCKET: "/example/socket's $(id)" }))
  const hosts = { example: { target: 'user@desktop.example', desktop: { env: { YDOTOOL_SOCKET: "/example/socket's $(id)" } } } }
  await tools({ exec: wayland.exec, hosts }).desktop_click.execute(args({ x: 1, y: 2, button: 'middle' }))
  const script = scriptOf(wayland.actions()[0])
  assert.ok(script.includes(`YDOTOOL_SOCKET=${shq("/example/socket's $(id)")}`))
  assert.ok(script.endsWith("'ydotool' 'mousemove' '--absolute' '-x' '1' '-y' '2' && 'ydotool' 'click' '0xC2'"))
  assert.doesNotMatch(script, /sudo|ydotoold|systemctl/)
})

test('desktop: text failures, timeout and truncation are explicit and redacted', async () => {
  for (const extra of [{ code: 127, stderr: 'Missing remote command: wl-paste. password=example-secret' }, { code: null, timedOut: true }, { truncated: true }]) {
    const f = fake(() => ok('x'.repeat(4000), extra), session('sway'))
    const out = await tools({ exec: f.exec, maxChars: 200 }).desktop_clipboard_get.execute(args())
    assert.doesNotMatch(out, /example-secret/)
    assert.match(out, /SSH desktop/)
  }
})

test('desktop: DSH adapter advertises all hosts and refuses mutations before even the probe', async () => {
  const registered = [], packs = [], hooks = {}, f = fake()
  const ctx = {
    logger: { warn() {} }, tools: { register: (t) => registered.push(t) },
    effect: (fn) => fn(), on: (name, fn) => { hooks[name] = fn },
    inject: (_deps, fn) => fn({ effect: (f) => f(), toolCatalog: { registerToolPack: (p) => packs.push(p) } }),
  }
  apply(ctx, { ...config, auditFile: '', exec: f.exec })
  assert.deepEqual(packs.map((p) => p.id), ['desktop'])
  assert.deepEqual(packs[0].items().map((i) => i.id), ['example', 'secondary'])
  const key = registered.find((t) => t.name === 'desktop_key')
  const value = args({ combo: 'Return' })
  const decision = await hooks['tools/pre-execute']({ name: key.name, arguments: value }, () => key.execute(value))
  assert.equal(decision.kind, 'deny')
  assert.equal(f.calls.length, 0)
  assert.equal(key.isConcurrencySafe(), false)
})


test('desktop: root selects the unique active graphical user without manually configured env', () => {
  for (const kind of ['sway', 'hyprland', 'niri']) {
    const raw = session(kind, { XDG_SESSION_ID: 'example-session' }, { loginUid: 0, logins: [{ id: 'example-session', uid: 1000 }] })
    const b = selectDesktopSession(raw)
    assert.equal(b.kind, kind)
    assert.equal(b.loginUid, 0)
    assert.deepEqual(b.user, { name: 'example', uid: 1000, gid: 1000, home: '/home/example' })
    assert.equal(b.sessionId, 'example-session')
    assert.equal(b.env.XDG_SESSION_ID, undefined, 'session identity is kept as data rather than exported')
  }
  const x11 = snapshot({ loginUid: 0, records: [record(1000, { DISPLAY: ':0', XAUTHORITY: '/run/user/1000/example.Xauthority', XDG_SESSION_ID: 'example-x' })], sockets: [{ path: '/tmp/.X11-unix/X0', uid: 0 }], logins: [{ id: 'example-x', uid: 1000, props: { Type: 'x11', Display: ':0' } }] })
  assert.equal(selectDesktopSession(x11).kind, 'x11')
  assert.equal(selectDesktopSession(x11).env.XAUTHORITY, '/run/user/1000/example.Xauthority')
})

test('desktop: inactive sessions and greeters do not compete with the active root-selected desktop', () => {
  const fixture = { loginUid: 0,
    records: [record(1000, wayland({ XDG_SESSION_ID: 'active-example' })), record(1001, wayland({ XDG_SESSION_ID: 'inactive-example' }, 1001))],
    sockets: [{ path: '/run/user/1000/wayland-1' }, { path: '/run/user/1001/wayland-1', uid: 1001 }],
    logins: [{ id: 'active-example', uid: 1000 }, { id: 'inactive-example', uid: 1001, props: { Active: 'no', State: 'online' } }],
  }
  assert.equal(selectDesktopSession(snapshot(fixture)).user.uid, 1000)
  fixture.logins[1].props = { Class: 'greeter' }
  assert.equal(selectDesktopSession(snapshot(fixture)).user.uid, 1000)
  fixture.logins[0].props = { Active: 'no' }
  assert.throws(() => selectDesktopSession(snapshot(fixture)), /No active graphical session/)
  const sameUser = snapshot({ loginUid: 0,
    records: [record(1000, wayland({ XDG_SESSION_ID: 'active-example' })), record(1000, wayland({ XDG_SESSION_ID: 'inactive-example' }, 1000, 'wayland-2'))],
    sockets: [{ path: '/run/user/1000/wayland-1' }, { path: '/run/user/1000/wayland-2' }],
    logins: [{ id: 'active-example', uid: 1000 }, { id: 'inactive-example', uid: 1000, props: { Active: 'no' } }],
  })
  assert.equal(selectDesktopSession(sameUser).env.WAYLAND_DISPLAY, 'wayland-1')
})

test('desktop: multiple active users/sessions refuse, and configured user or UID selects an account', () => {
  const raw = snapshot({ loginUid: 0, records: [record(1000, wayland()), record(1001, wayland({}, 1001))],
    sockets: [{ path: '/run/user/1000/wayland-1' }, { path: '/run/user/1001/wayland-1', uid: 1001 }],
    logins: [{ id: 'example-a', uid: 1000 }, { id: 'example-b', uid: 1001 }],
  })
  assert.throws(() => selectDesktopSession(raw), /Multiple active graphical sessions.*desktop.user/)
  assert.throws(() => selectDesktopSession(session('sway', {}, { loginUid: 0, logins: [{ id: 'example-a', uid: 1000 }, { id: 'example-b', uid: 1001 }] })), /Multiple active graphical sessions/, 'a second active logind session is not ignored when its display environment is unavailable')
  assert.equal(selectDesktopSession(raw, { user: 'secondary' }).user.uid, 1001)
  assert.equal(selectDesktopSession(raw, { user: '1000' }).user.name, 'example')
  assert.throws(() => selectDesktopSession(raw, { user: 'missing-example' }), /Unknown desktop.user/)
  assert.throws(() => selectDesktopSession(raw, { user: 'root' }), /drop to a non-root/)
  const sameUid = snapshot({ loginUid: 0,
    records: [record(1000, wayland({ XDG_SESSION_ID: 'example-a' })), record(1000, wayland({ XDG_SESSION_ID: 'example-b' }, 1000, 'wayland-2'))],
    sockets: [{ path: '/run/user/1000/wayland-1' }, { path: '/run/user/1000/wayland-2' }],
    logins: [{ id: 'example-a', uid: 1000 }, { id: 'example-b', uid: 1000 }],
  })
  assert.throws(() => selectDesktopSession(sameUid, { user: 'example' }), /Multiple graphical sessions/)
  const chosen = selectDesktopSession(sameUid, { user: 'example', env: { WAYLAND_DISPLAY: 'wayland-2' } })
  assert.equal(chosen.env.WAYLAND_DISPLAY, 'wayland-2')
  assert.equal(chosen.sessionId, 'example-b')
})

test('desktop: socket/proc fallback works without loginctl, excludes stale and cross-user sockets', () => {
  const b = selectDesktopSession(snapshot({ loginUid: 0, sockets: [{ path: '/run/user/1000/wayland-1' }, { path: '/run/user/1000/niri.wayland-1.example.sock' }] }))
  assert.equal(b.user.uid, 1000)
  assert.equal(b.kind, 'niri')
  const x = selectDesktopSession(session('x11', {}, { loginUid: 0 }))
  assert.equal(x.user.uid, 1000)
  assert.throws(() => selectDesktopSession(snapshot({ loginUid: 0, records: [record(1000, wayland())] })), /No active/)
  assert.throws(() => selectDesktopSession(snapshot({ loginUid: 0, records: [record(1000, wayland())], sockets: [{ path: '/run/user/1000/wayland-1', uid: 1001 }] })), /No active|Multiple graphical/)
})

test('desktop: non-root discovery stays on its UID and cannot request another account', () => {
  const raw = snapshot({ records: [record(1000, wayland()), record(1001, wayland({}, 1001))], sockets: [{ path: '/run/user/1000/wayland-1' }, { path: '/run/user/1001/wayland-1', uid: 1001 }] })
  assert.equal(selectDesktopSession(raw).user.uid, 1000)
  assert.throws(() => selectDesktopSession(raw, { user: 'secondary' }), /Non-root SSH logins cannot switch/)
  assert.throws(() => selectDesktopSession(raw, { user: '0' }), /Non-root SSH logins cannot switch/)
  assert.equal(selectDesktopSession(raw, { user: '1000' }).user.uid, 1000)
})

test('desktop: Xwayland is suppressed and env overrides preserve literal data without eval', () => {
  const raw = snapshot({ loginUid: 0,
    records: [record(1000, wayland({ DISPLAY: ':1', SWAYSOCK: "/run/user/1000/example's $(id).sock" })), record(1000, { DISPLAY: ':1' })],
    sockets: [{ path: '/run/user/1000/wayland-1' }, { path: '/tmp/.X11-unix/X1', uid: 0 }],
  })
  assert.equal(selectDesktopSession(raw).kind, 'sway')
  assert.equal(selectDesktopSession(raw).env.SWAYSOCK, "/run/user/1000/example's $(id).sock")
  const conflict = snapshot({ records: [record(1000, { DISPLAY: ':0', XAUTHORITY: '/example/a' }), record(1000, { DISPLAY: ':0', XAUTHORITY: '/example/b' })], sockets: [{ path: '/tmp/.X11-unix/X0', uid: 0 }] })
  assert.throws(() => selectDesktopSession(conflict), /Conflicting graphical session/)
  assert.equal(selectDesktopSession(conflict, { env: { XAUTHORITY: '/example/selected' } }).env.XAUTHORITY, '/example/selected')
  for (const user of ['-option', 'example;id', '$(id)', 'example\nroot', 1000]) assert.throws(() => checkDesktopSession({ user }), /desktop.user/)
})

test('desktop: root drops UID/groups and strips the root environment before looking up desktop utilities', async () => {
  const f = fake(() => ok(), session('sway', {}, { loginUid: 0, logins: [{ id: 'example-session', uid: 1000 }] }))
  const t = tools({ exec: f.exec, hosts: { example: { target: 'root@desktop.example' } } })
  const text = "Example's $(id); 中文"
  await t.desktop_type.execute(args({ text }))
  const action = f.actions()[0], script = scriptOf(action)
  assert.equal(action.options.stdin, text)
  assert.ok(!script.includes(text))
  assert.ok(script.includes("'setpriv' '--reuid' '1000' '--regid' '1000' '--init-groups'"))
  assert.ok(script.includes("'--inh-caps=-all' '--ambient-caps=-all' '--bounding-set=-all' '--no-new-privs'"))
  assert.ok(script.includes("'runuser' '-u' 'example' '--' 'env' '-i'"))
  assert.ok(script.includes("'HOME=/home/example'"))
  assert.ok(script.includes('/etc/profiles/per-user/example/bin'))
  assert.ok(script.includes('Root desktop control needs setpriv or runuser'))
  assert.ok(!script.includes('/root/.nix-profile'))
  const b = selectDesktopSession(session('x11'))
  const nonroot = desktopCommandScript(b, ['xdotool'], "'xdotool' 'key' 'Return'")
  assert.doesNotMatch(nonroot, /setpriv|runuser|sudo/)
  assert.match(nonroot, /stat -c '%u:%i'/)
})

test('desktop: per-host success cache expires without extending TTL and failures invalidate without replay', async (ctx) => {
  let now = 10000
  ctx.mock.method(Date, 'now', () => now)
  let reply = ok('example clipboard')
  const f = fake(() => reply)
  const t = tools({ exec: f.exec, desktopCacheMs: 3000 })
  await t.desktop_clipboard_get.execute(args())
  await t.desktop_clipboard_get.execute(args())
  assert.equal(f.calls.length, 3, 'second call uses one SSH action only')
  await t.desktop_clipboard_get.execute({ host: 'secondary' })
  assert.equal(f.calls.length, 5, 'a different alias probes independently')
  now += 2999
  await t.desktop_clipboard_get.execute(args())
  assert.equal(f.calls.length, 6)
  now += 2
  await t.desktop_clipboard_get.execute(args())
  assert.equal(f.calls.length, 8, 'successful actions do not prolong the original discovery TTL')
  reply = ok('', { code: 75, stderr: 'Desktop session changed' })
  assert.match(await t.desktop_key.execute(args({ combo: 'Return' })), /session changed/)
  assert.equal(f.calls.length, 9, 'failed mutation is not replayed')
  reply = ok('example clipboard')
  await t.desktop_clipboard_get.execute(args())
  assert.equal(f.calls.length, 11, 'next call probes again after failure')
  const probeFails = fake(() => ok('example clipboard'), () => ok('', { code: 1, stderr: 'No active graphical session found' }))
  const failed = tools({ exec: probeFails.exec, desktopCacheMs: 3000 })
  for (let i = 0; i < 2; i++) await assert.rejects(failed.desktop_clipboard_get.execute(args()), /No active graphical/)
  assert.equal(probeFails.calls.length, 2, 'probe failures never enter the cache')
  const malformed = fake(() => ok('not png'))
  const screen = tools({ exec: malformed.exec, desktopCacheMs: 3000 })
  await assert.rejects(screen.desktop_screen.execute(args()), /not a PNG/)
  await screen.desktop_clipboard_get.execute(args())
  assert.equal(malformed.calls.length, 4, 'post-processing errors also invalidate the cache')
  for (const desktopCacheMs of [-1, 30001, 1.1, '3000']) assert.throws(() => tools({ desktopCacheMs }), /desktopCacheMs/)
})

test('desktop: shell probe uses NUL-safe records and no remote language runtime', () => {
  assert.doesNotMatch(DESKTOP_PROBE, /python|jq|eval\s/)
  assert.match(DESKTOP_PROBE, /grep -z -E/)
  assert.match(DESKTOP_PROBE, /loginctl show-session/)
  assert.match(DESKTOP_PROBE, /getent passwd/)
  assert.match(DESKTOP_PROBE, /cut -d: -f1,3,4,6/, 'passwd password fields never leave the host')
  assert.match(DESKTOP_PROBE, /\[ "\$login_uid" = 0 \] \|\| \[ "\$owner" = "\$login_uid" \]/)
})

// Syntax-check generated shells without executing any graphical utility. The
// host may disallow child processes; all selection/transport tests above remain pure.
test('desktop: root/non-root generated shell scripts parse under POSIX sh', async (ctx) => {
  const dir = await folder(ctx)
  for (const raw of [session('sway'), session('sway', {}, { loginUid: 0 })]) {
    const b = selectDesktopSession(raw)
    const script = desktopCommandScript(b, ['wtype'], "'wtype' '-'")
    const path = join(dir, `desktop-${b.loginUid}.sh`)
    await writeFile(path, script)
    const r = spawnSync('sh', ['-n', path], { encoding: 'utf8', timeout: 5000 })
    if (r.error) return ctx.skip(`Shell subprocess unavailable: ${r.error.code}`)
    assert.equal(r.status, 0, r.stderr)
  }
})
