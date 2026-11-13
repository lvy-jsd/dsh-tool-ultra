// End-to-end tests in a throwaway DSH_HOME. Never touches the real profile.
//
// Boots the shipped headless profile with the plugins under test, the test kit
// (fake tools, a simulated MCP reconnect, a veto hook, a visibility filter and
// a package.json tool declaration) and a scripted fake model, then asserts on
// the exact tool list and tool results of every model request.
//
// Two profiles:
//   core    Tool Ultra only (no classifier plugin)
//   rules   Tool Ultra + dsh-tool-ultra-classifier-rules with a user override
//   preset  core + tools that exist only in a preset (ancestor) layer of the
//           agent, which is how the DSH web profile registers most tools
//   persist core + dsh-tool-ultra-persist (T14b: state survives a restart)
//   gate    core + dsh-tool-ultra-risk-gate (high-risk loads ask)
//   llm     core + dsh-tool-ultra-classifier-llm: the small-model classifier
//           asks the fake model and caches the answer
//   cap     core + dsh-tool-ultra-capability-bridge: tools_load("cap:<name>")
//   attr-rules rules + scan + a declaration-free device package: renamed groups
//           keep their category
//   attr    core + dsh-tool-ultra-attribution-scan: tools are grouped by the
//           plugin package whose source defines them
//   devices core + dsh-tool-ultra-devices + a fake Swiftnest hub: /device/<slug>,
//           device:current / device:<slug> / device:all, [offline] notes
//   packs   core + the essentials, web and mcp packs: pack:<id> loads a pack,
//           pack tools run, mcp_presets reports keyless/keyed presets
//   control core + risk-gate + the control pack with a fake ssh client: read-only
//           tools run, a read-only ssh_run runs, any other call is refused for want
//           of an approval channel and never reaches the client
//   control-adb core + risk-gate + the Android packs with a fake adb client:
//           UI dumps run; root shell calls require an approval channel
//   control-desktop core + risk-gate + desktop over fake SSH hosts:
//           native window lists/screenshots run; input needs call approval (full tier)
//
//   control-browser core + risk-gate + remote Chrome via fake SSH/CDP (full tier)
//
// Usage: node test/e2e.mjs [path/to/dsh]   (default: ~/.local/bin/dsh)
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packages = resolve(here, '..', 'packages')
// Bundles are named by package directory; the published names are scoped.
const packageName = (b) => b.name ?? `@lvy-jsd/${b}`
const dsh = process.argv[2] ?? join(homedir(), '.local/bin/dsh')
const port = 18000 + Math.floor(Math.random() * 1000)
const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'dsh-tm-e2e-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(work, { recursive: true })
const env = { ...process.env, DSH_HOME: home, FAKE_LLM_KEY: 'x', DSH_TELEMETRY_MODE: 'DISABLED' }

// --- tiers ---------------------------------------------------------------------
// `core` runs only the core tool-management paths (the PR gate); `full` runs
// everything. In CI (GitHub Actions sets CI=true) the default is core; locally
// it is full. TM_E2E_TIER overrides either.
const tier = process.env.TM_E2E_TIER ?? (process.env.CI ? 'core' : 'full')
const CORE = new Set(['core-main', 'core-deny', 'core-ptc', 'rules-main', 'attr-main', 'devices-main', 'control-main'])
const include = (label) => tier === 'full' || CORE.has(label)
// A profile is created only if one of its scenarios runs.
const profileNeeds = {
  core: ['core-main', 'core-deny', 'rescue-main'],
  rules: ['rules-main'], preset: ['preset-main'], ptc: ['core-ptc'],
  persist: ['persist-main', 'persist-resume'], attr: ['attr-main'],
  'attr-rules': ['attr-rules-main'], exempt: ['exempt-main'], gate: ['gate-main'],
  cap: ['cap-main'], llm: ['llm-main'], devices: ['devices-main'], packs: ['packs-main'],
  control: ['control-main', 'control-adb-disabled', 'control-desktop-disabled', 'control-browser-disabled'], 'control-adb': ['control-adb-main'],
  'control-desktop': ['control-desktop-main'], 'control-desktop-niri': ['control-desktop-niri'], 'control-browser': ['control-browser-main'],
}
const needProfile = (name) => profileNeeds[name].some(include)

// --- profiles ------------------------------------------------------------------
// testkit-devices resolves @deepseek-ai/dsh-tools through the testkit's links.
if (!existsSync(join(here, 'testkit-devices', 'node_modules'))) symlinkSync('../testkit/node_modules', join(here, 'testkit-devices', 'node_modules'))
if (!existsSync(join(here, 'testkit-swiftnest', 'node_modules'))) symlinkSync('../testkit/node_modules', join(here, 'testkit-swiftnest', 'node_modules'))

// A bundle is a package under packages/, or { name, dir } for a test package.
function makeProfile(name, bundles, extraPatch = '') {
  spawnSync(dsh, ['--profile', name, '--from-default-profile', 'headless', '--dump-config'], { env, stdio: 'ignore' })
  const dir = join(home, 'profiles', name)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`, private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-tm-testkit', ...bundles.map(packageName)] } },
  }, null, 2))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(join(here, 'testkit'), join(dir, 'node_modules', 'dsh-tm-testkit'))
  for (const b of bundles) {
    const link = join(dir, 'node_modules', packageName(b))
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(b.dir ?? join(packages, b), link)
  }
  writeFileSync(join(dir, 'cordis.patch.yml'), `
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      fake:
        apiKeyEnv: FAKE_LLM_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        models:
          - { id: fake-1, name: Fake 1, contextWindow: 131072, maxTokens: 4096, reasoningEfforts: false, input: [text, image] }
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config: { provider: fake, model: fake-1 }
- id: tool-manager
  name: '@lvy-jsd/dsh-tool-ultra-core'
  config:
    pinned: [testkit_reconnect, testkit_service_load, testkit_service_unload, testkit_wire_tokens, testkit_deny]
${extraPatch}`)
}

if (needProfile('core')) makeProfile('core', ['dsh-tool-ultra-core'])
if (needProfile('rules')) makeProfile('rules', ['dsh-tool-ultra-core', 'dsh-tool-ultra-classifier-rules'], `
- id: tool-manager-classifier-rules
  name: '@lvy-jsd/dsh-tool-ultra-classifier-rules'
  config:
    defaults: true
    categories:
      maps: { groups: [fake] }
`)

if (needProfile('preset')) makeProfile('preset', ['dsh-tool-ultra-core', 'dsh-tool-ultra-classifier-rules'], `
- id: tm-testkit
  name: dsh-tm-testkit
  config: { simulatePresetLayer: true }
`)

// PTC mode. DSH 0.2.2+ selects the executor in the profile; DSH 0.2.1 reads
// DSH_TOOLS_MODE (set by the run below) and ignores these rows.
if (needProfile('ptc')) makeProfile('ptc', ['dsh-tool-ultra-core'], `
- id: tool-executor-native
  disabled: true
- id: tool-executor-ptc
  disabled: false
`)

if (needProfile('persist')) makeProfile('persist', ['dsh-tool-ultra-core', 'dsh-tool-ultra-persist'])
if (needProfile('attr')) makeProfile('attr', ['dsh-tool-ultra-core', 'dsh-tool-ultra-attribution-scan'])
const devices = { name: 'dsh-tm-testkit-devices', dir: join(here, 'testkit-devices') }
if (needProfile('attr-rules')) makeProfile('attr-rules', ['dsh-tool-ultra-core', 'dsh-tool-ultra-classifier-rules', 'dsh-tool-ultra-attribution-scan', devices])
// The fake model's route stands in for claude-code: an exempt route is never narrowed.
if (needProfile('exempt')) makeProfile('exempt', ['dsh-tool-ultra-core'], `
- id: tool-manager
  name: '@lvy-jsd/dsh-tool-ultra-core'
  config:
    pinned: [testkit_reconnect, testkit_service_load, testkit_service_unload, testkit_wire_tokens]
    exemptProviders: [fake]
`)

if (needProfile('gate')) makeProfile('gate', ['dsh-tool-ultra-core', 'dsh-tool-ultra-risk-gate'], `
- id: tool-manager-risk-gate
  name: '@lvy-jsd/dsh-tool-ultra-risk-gate'
  config:
    highRisk: []
`)

if (needProfile('cap')) makeProfile('cap', ['dsh-tool-ultra-core', 'dsh-tool-ultra-capability-bridge'], `
- id: tool-manager-capability-bridge
  name: '@lvy-jsd/dsh-tool-ultra-capability-bridge'
  config:
    packs:
      static: ['/uncategorized/fake']
      # Two tools that each live in a group with an unlisted sibling. Loading
      # this pack must add exactly these two, never the whole groups.
      pair: ['mcp__fake__ping', 'phone_fake_tap']
`)

if (needProfile('llm')) makeProfile('llm', ['dsh-tool-ultra-core', 'dsh-tool-ultra-classifier-llm'], `
- id: tool-manager-classifier-llm
  name: '@lvy-jsd/dsh-tool-ultra-classifier-llm'
  config:
    model: { provider: fake, model: fake-1 }
    cacheFile: ${join(root, 'llm-cache.json')}
`)

if (needProfile('devices')) makeProfile('devices', ['dsh-tool-ultra-core', 'dsh-tool-ultra-devices', { name: 'dsh-tm-testkit-swiftnest', dir: join(here, 'testkit-swiftnest') }])

if (needProfile('packs')) makeProfile('packs', ['dsh-tool-ultra-core', 'dsh-tool-ultra-pack-essentials', 'dsh-tool-ultra-pack-web', 'dsh-tool-ultra-pack-mcp'], `
- id: tool-ultra-pack-mcp
  name: '@lvy-jsd/dsh-tool-ultra-pack-mcp'
  config:
    # No servers start in the test: npx would download them.
    defaults: false
`)


// The control pack runs a fake `ssh`: a script that records its last argument (the
// remote command) and prints a marker. A call that reaches it shows up in the log.
const fakeSsh = join(root, 'fake-ssh.sh')
const fakeSshLog = join(root, 'fake-ssh.log')
if (needProfile('control')) {
  writeFileSync(fakeSsh, `#!/bin/sh\nfor last; do :; done\necho "$last" >> ${fakeSshLog}\necho FAKE-SSH-OUTPUT\n`, { mode: 0o755 })
  makeProfile('control', ['dsh-tool-ultra-core', 'dsh-tool-ultra-risk-gate', 'dsh-tool-ultra-pack-control'], `
# Loads pass without a question, so only the call-time gate is under test.
- id: tool-manager-risk-gate
  name: '@lvy-jsd/dsh-tool-ultra-risk-gate'
  config:
    allow: { '*': true }
- id: tool-ultra-pack-control
  name: '@lvy-jsd/dsh-tool-ultra-pack-control'
  config:
    packs: { ssh: true, ssh-exec: true }
    sshBin: ${fakeSsh}
    multiplex: false
    auditFile: ${join(root, 'control-audit.jsonl')}
    hosts:
      t: { target: 'root@fake.invalid' }
`)
}

// Log every invocation, including connection attempts, before responding. This
// lets the scenario prove a refused root call never even starts the adb client.
const fakeAdb = join(root, 'fake-adb.mjs')
const fakeAdbLog = join(root, 'fake-adb.log.jsonl')
if (needProfile('control-adb')) {
  writeFileSync(fakeAdb, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const stdin = readFileSync(0, 'utf8')
appendFileSync(${JSON.stringify(fakeAdbLog)}, JSON.stringify({ argv, stdin }) + '\\n')
if (JSON.stringify(argv) === JSON.stringify(['connect', 'phone.example:5555'])) {
  process.stdout.write('connected to phone.example:5555\\n')
} else if (JSON.stringify(argv) === JSON.stringify(['-s', 'phone.example:5555', 'shell', '-T', 'sh']) && stdin.includes('uiautomator dump --compressed ')) {
  process.stdout.write(readFileSync(${JSON.stringify(join(here, 'fixtures', 'pack-control', 'ui.xml'))}))
} else {
  process.stderr.write('Unexpected fake adb invocation\\n')
  process.exitCode = 1
}
`, { mode: 0o755 })
  makeProfile('control-adb', ['dsh-tool-ultra-core', 'dsh-tool-ultra-risk-gate', 'dsh-tool-ultra-pack-control'], `
# Permit loading adb_shell to isolate its call-time approval from loading approval.
- id: tool-manager-risk-gate
  name: '@lvy-jsd/dsh-tool-ultra-risk-gate'
  config:
    allow: { '*': true }
- id: tool-ultra-pack-control
  name: '@lvy-jsd/dsh-tool-ultra-pack-control'
  config:
    packs: { ssh: false, adb: true, adb-root: true }
    adbBin: ${fakeAdb}
    auditFile: ${join(root, 'control-adb-audit.jsonl')}
    serials:
      example-phone: 'phone.example:5555'
`)
}

// Each fake destination reports a different compositor. Unknown hosts must not
// reach even the probe; a refused input call must produce no SSH invocation.
const fakeDesktopSsh = join(root, 'fake-desktop-ssh.mjs')
const fakeDesktopLog = join(root, 'fake-desktop-ssh.jsonl')
const desktopOutputDir = join(root, 'desktop-screens')
const desktopPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAbElEQVR4nA3JQQEAMAgDMZSgpEqqhOepQAlKqmjLN1VFFypcTLHFFSmqmm7UuJlmm2vSP0QLCYsRK05EP0wbGZsxa87EP4YeNHiYYYcbMj+WXrR4mWWXW7I/jj50+JhjjztyP0IHBYcJGy4kPLAsVIExyOP/AAAAAElFTkSuQmCC', 'base64') // valid 8x8 sRGB PNG: DSH attachments decode it fully
if (needProfile('control-desktop') || needProfile('control-desktop-niri')) {
  writeFileSync(fakeDesktopSsh, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2), remote = argv.at(-1), stdin = readFileSync(0, 'utf8')
const target = argv[argv.indexOf('--') + 1]
appendFileSync(${JSON.stringify(fakeDesktopLog)}, JSON.stringify({ argv, stdin }) + '\\n')
const kind = target === 'root@desktop.example' ? 'x11' : target === 'user@wayland.example' ? 'sway' : target === 'user@niri.example' ? 'niri' : null
if (!kind) throw new Error('Unexpected fake SSH destination')
if (remote.includes('# DSH_DESKTOP_PROBE_V2')) {
  const b64 = (s) => Buffer.from(s).toString('base64')
  const env = kind === 'x11' ? { DISPLAY: ':0', XAUTHORITY: '/run/user/1000/example.Xauthority', XDG_SESSION_ID: 'example-session' } : kind === 'niri' ? { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'niri', NIRI_SOCKET: '/run/user/1000/niri.wayland-1.example.sock' } : { WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000', SWAYSOCK: '/run/user/1000/sway-ipc.example.sock' }
  process.stdout.write(['DSH_DESKTOP_V2', 'I\\t' + (kind === 'x11' ? '0' : '1000'),
    'U\\t' + b64('root:0:0:/root\\nexample:1000:1000:/home/example'),
    'L\\texample-session\\t' + b64('User=1000\\nActive=yes\\nType=' + (kind === 'x11' ? 'x11' : 'wayland') + '\\nClass=user\\nState=active'),
    'P\\t1000\\t' + b64(Object.entries(env).map(([k, v]) => k + '=' + v + '\\0').join('')),
    'S\\t' + (kind === 'x11' ? '0' : '1000') + ':42\\t' + b64(kind === 'x11' ? '/tmp/.X11-unix/X0' : '/run/user/1000/wayland-1'), 'END', ''].join('\\n'))
} else if (kind === 'x11' && (!remote.includes('--reuid') || !remote.includes('--init-groups') || !remote.includes('runuser'))) {
  throw new Error('Root desktop action must drop to the graphical user')
} else if (remote.includes('get_tree')) {
  process.stdout.write(JSON.stringify({ type: 'root', nodes: [{ type: 'con', id: 42, app_id: 'example.app', name: 'Example Wayland window', focused: true }] }))
} else if (remote.includes('getactivewindow')) {
  process.stdout.write('42\\n0x0000002a 0 example.App desktop.example Example X11 window\\n')
} else if (kind === 'niri' && remote.includes('focused-window')) {
  process.stdout.write(JSON.stringify({ windows: [{ id: 42, title: 'Example niri window', app_id: 'example.app', workspace_id: 1, layout: { tile_pos_in_workspace_view: [10,20], window_offset_in_tile: [2,2], window_size: [400,300], tile_size: [404,304] } }], active: { id: 42 } }))
} else if (kind === 'niri' && remote.includes('Missing remote command: ydotool.')) {
  if (!remote.includes('/run/ydotoold/socket') || remote.includes('Missing remote command: wtype.') || remote.includes('Missing remote command: xdotool.')) throw Error('niri must use ydotool with automatic socket discovery')
} else if (kind === 'niri' && remote.includes('focus-window')) {
  // Focus succeeds; the assertion below checks the quoted native id.
} else if (remote.includes('Missing remote command: scrot.') || remote.includes('Missing remote command: grim.')) {
  process.stdout.write(Buffer.from(${JSON.stringify(desktopPng.toString('base64'))}, 'base64'))
} else if (remote.includes('Missing remote command: wl-paste.') || remote.includes('Missing remote command: xclip.')) {
  process.stdout.write('Example desktop clipboard')
} else {
  process.stderr.write('Unexpected fake desktop action\\n')
  process.exitCode = 1
}
`, { mode: 0o755 })
  for (const profile of ['control-desktop', 'control-desktop-niri'].filter(needProfile)) makeProfile(profile, ['dsh-tool-ultra-core', 'dsh-tool-ultra-risk-gate', 'dsh-tool-ultra-pack-control'], `
- id: tool-manager-risk-gate
  name: '@lvy-jsd/dsh-tool-ultra-risk-gate'
  config:
    allow: { '*': true }
- id: tool-ultra-pack-control
  name: '@lvy-jsd/dsh-tool-ultra-pack-control'
  config:
    packs: { ssh: false, desktop: true }
    sshBin: ${fakeDesktopSsh}
    multiplex: false
    desktopCacheMs: 0
    allow: {}
    outputDir: ${desktopOutputDir}
    auditFile: ${join(root, 'control-desktop-audit.jsonl')}
    hosts:
      example: { target: 'root@desktop.example' }
      example-wayland: { target: 'user@wayland.example' }
      example-niri: { target: 'user@niri.example' }
${profile === 'control-desktop-niri' ? `- id: tm-testkit
  name: dsh-tm-testkit
  config: { approveTools: [desktop_focus, desktop_click, desktop_type, desktop_key] }
` : ''}`)
}

// Each forwarding invocation starts a local fake CDP server in the fake SSH
// subprocess. DSH itself is spawnSync'd, so the server must live outside this process.
const fakeBrowserSsh = join(root, 'fake-browser-ssh.mjs')
const fakeBrowserLog = join(root, 'fake-browser-ssh.jsonl')
const browserOutputDir = join(root, 'browser-screens')
if (needProfile('control-browser')) {
  writeFileSync(fakeBrowserSsh, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { startFakeCdp } from ${JSON.stringify(new URL('./fixtures/pack-control/fake-cdp.mjs', import.meta.url).href)}
const argv = process.argv.slice(2), target = argv[argv.indexOf('--') + 1], command = argv.at(-1)
appendFileSync(${JSON.stringify(fakeBrowserLog)}, JSON.stringify({ argv }) + '\\n')
if (!['root@browser.example', 'user@secondary.example'].includes(target)) throw Error('Unexpected fake browser host')
if (argv.includes('-L')) {
  const spec = argv[argv.indexOf('-L') + 1].split(':')
  const unix = spec[0].startsWith('/')
  if (unix ? spec[1] !== '127.0.0.1' : (spec[0] !== '127.0.0.1' || spec[2] !== '127.0.0.1')) throw Error('Non-loopback forward')
  if (unix && !argv.includes('StreamLocalBindMask=0177')) throw Error('Non-private Unix forward')
  if (!argv.includes('ExitOnForwardFailure=yes') || !argv.includes('ControlPath=none')) throw Error('Unowned forward')
  const remotePort = target === 'root@browser.example' ? 9222 : 9333
  if (Number(spec[unix ? 2 : 3]) !== remotePort) throw Error('Wrong remote CDP port')
  const server = await startFakeCdp({ ...(unix ? { socketPath: spec[0] } : { port: Number(spec[1]) }), remotePort })
  process.stdout.write(command.match(/DSH_FORWARD_[a-f0-9-]+/)[0] + '\\n')
  process.stdin.resume()
  process.stdin.on('end', async () => { await server.close() })
} else if (command.includes('getent ahosts')) {
  process.stdout.write('93.184.216.34 STREAM page.example\\n')
} else throw Error('Unexpected fake browser SSH command')
`, { mode: 0o755 })
  makeProfile('control-browser', ['dsh-tool-ultra-core', 'dsh-tool-ultra-risk-gate', 'dsh-tool-ultra-pack-control'], `
- id: tool-manager-risk-gate
  name: '@lvy-jsd/dsh-tool-ultra-risk-gate'
  config:
    allow: { '*': true }
- id: tool-ultra-pack-control
  name: '@lvy-jsd/dsh-tool-ultra-pack-control'
  config:
    packs: { ssh: false, browser: true }
    browserAllowLocalTcp: ${process.platform === 'win32'}
    sshBin: ${fakeBrowserSsh}
    multiplex: false
    outputDir: ${browserOutputDir}
    auditFile: ${join(root, 'control-browser-audit.jsonl')}
    hosts:
      example: { target: 'root@browser.example' }
      secondary: { target: 'user@secondary.example', browser: { port: 9333 } }
`)
}

// --- runner --------------------------------------------------------------------
async function run(profile, label, script, args, extraEnv = {}) {
  const t0 = Date.now()
  const scriptPath = join(root, `${label}.script.json`)
  const logPath = join(root, `${label}.log.jsonl`)
  writeFileSync(scriptPath, JSON.stringify(script))
  writeFileSync(logPath, '')
  const llm = spawn(process.execPath, [join(here, 'fake-llm.mjs'), String(port), scriptPath, logPath], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 400))
  const result = spawnSync(dsh, ['--profile', profile, '--json', ...args], { env: { ...env, ...extraEnv }, cwd: work, encoding: 'utf8', timeout: 180_000 })
  llm.kill()
  if (result.status !== 0) throw new Error(`${label}: dsh exited ${result.status}\n${result.stderr}`)
  // Indexed by script step, so concurrent agents and skipped steps keep the
  // indexes the scenario comments give. Requests past the script are dropped.
  const turns = []
  for (const line of readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)) {
    const d = JSON.parse(line)
    if (d.kind === 'turn' && d.step >= 0) turns[d.step] = d
  }
  if (process.env.TM_E2E_TIMING) console.log(`[timing] ${label}: ${Date.now() - t0}ms`)
  return turns
}
const fakeTools = (turn, prefix = 'mcp__fake__') => turn.tools.filter((n) => n.startsWith(prefix)).sort()

const call = (name, args = {}) => ({ tool_calls: [{ name, arguments: args }] })
let failures = 0
function check(label, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${detail}`}`)
}
function expect(label, actual, wanted) {
  check(label, JSON.stringify(actual) === JSON.stringify([...wanted].sort()), `got ${JSON.stringify(actual)} want ${JSON.stringify([...wanted].sort())}`)
}
function contains(label, text, ...needles) {
  const missing = needles.filter((n) => !(n instanceof RegExp ? n.test(text) : text.includes(n)))
  check(label, missing.length === 0, `missing ${missing.join(' | ')} in:\n${text}`)
}

// --- core profile: visibility (T4, T7, T14) + no-classifier placement ----------
const P = 'mcp__fake__ping', E = 'mcp__fake__echo', F = 'mcp__fake__fresh'
if (include('core-main')) {
console.log('# core profile')
const main = await run('core', 'core-main', [
  call('tools_ls', { path: '/' }),                            // 0
  call('tools_load', { targets: ['fake'] }),                  // 1
  call('testkit_reconnect'),                                  // 2
  call('tools_unload', { targets: ['fake'] }),                // 3
  call('testkit_reconnect'),                                  // 4
  call('tools_load', { targets: ['mcp__fake__ping'] }),       // 5
  call('testkit_reconnect'),                                  // 6
  // Children run concurrently from DSH 0.2.1 on. The child answers late, so the
  // parent ends its turn first (8) and resumes on the completion notice (10);
  // DSH 0.2.0 honours run_in_background: false and waits instead, so step 8
  // does not match and is skipped.
  call('subagent', { description: 'child one', prompt: 'child-one: hi', run_in_background: false }), // 7
  { text: 'waiting for child one', skipUnless: '^started subagent' }, // 8
  { agent: 'child-one', text: 'child one done', delayMs: 1500 },     // 9 (child)
  call('tools_load', { targets: ['/uncategorized/fake'], forSubagents: true }), // 10
  call('subagent', { description: 'child two', prompt: 'child-two: hi', run_in_background: false }), // 11
  { text: 'waiting for child two', skipUnless: '^started subagent' }, // 12
  { agent: 'child-two', text: 'child two done', delayMs: 1500 },     // 13 (child)
  call('tools_ls', { path: '/uncategorized' }),               // 14
  call('tools_load', { targets: ['veto-me'] }),               // 15
  call('tools_load', { targets: ['adb_fake_two'] }),          // 16 declared high risk, no gate installed
  call('testkit_service_load', { targets: ['/uncategorized/phone'] }), // 17 the panel path
  { text: 'all done' },                                       // 18
], ['run the scenario'])
const m = main.map((t) => fakeTools(t))

expect('T14a fresh session: first request hides unloaded tools', m[0], [])
contains('no classifier: root lists only uncategorized and the declared category', main[1].lastContent, /uncategorized\//, /code\//)
check('no classifier: no rule-based categories at root', !/device\/|maps\//.test(main[1].lastContent), main[1].lastContent)
expect('load group: visible from the next step', m[2], [E, P])
expect('T4 reconnect, group loaded: same names back + new tool joins', m[3], [E, F, P])
expect('unload group: hidden again', m[4], [])
expect('T4 reconnect, nothing loaded: old and new names stay hidden', m[5], [])
expect('load by exact tool name', m[6], [P])
expect('T4 reconnect, single tool loaded: it survives, others hidden', m[7], [P])
expect('T7 child without handoff: starts from pinned only', m[9], [])
expect('parent unaffected by child', m[10], [P])
expect('T7 child after forSubagents handoff: gets the group', m[13], [E, F, P])
contains('no classifier: fake and phone groups are uncategorized', main[15].lastContent, 'fake/', 'phone/')
contains('hook: before-load listener can veto a load', main[16].lastContent, 'Load refused: vetoed by testkit hook')
contains('no gate installed: high-risk load is refused, not silently allowed', main[17].lastContent, 'no risk gate is installed')
// The testkit visibility filter still narrows the panel path.
expect('toolCatalog.load (the panel path) exposes the group it loaded', fakeTools(main[18], 'phone_fake_'), ['phone_fake_tap'])
}

// --- core profile: a tool another plugin denies is marked, not offered --------
if (include('core-deny')) {
console.log('# deny (core profile)')
const dn = await run('core', 'core-deny', [
  call('tools_load', { targets: ['/uncategorized/fake'] }),      // 0
  call('testkit_deny', { names: ['mcp__fake__echo'] }),          // 1 connector-style deny
  call('tools_ls', { path: '/uncategorized/fake' }),             // 2
  call('tools_unload', { targets: ['/uncategorized/fake'] }),    // 3
  call('tools_load', { targets: ['/uncategorized/fake'] }),      // 4
  { text: 'done' },                                               // 5
], ['deny'])
expect('deny: the other plugin\'s deny wins over a load', fakeTools(dn[2]), [P])
contains('deny: tools_ls marks the denied tool', dn[3].lastContent, /\[denied\][^\n]*mcp__fake__echo|echo[^\n]*\[denied\]/)
check('deny: tools_ls leaves the callable tool unmarked', !/ping[^\n]*\[denied\]/.test(dn[3].lastContent), dn[3].lastContent)
contains('deny: tools_load reports the denied tool as not callable', dn[5].lastContent, /Denied by another plugin[^\n]*mcp__fake__echo/)
check('deny: tools_load does not list the denied tool as callable', !/callable from your next step:[^]*\n\s{2}mcp__fake__echo\n/.test(`${dn[5].lastContent}\n`), dn[5].lastContent)
}

// --- core profile in PTC mode: the model calls tools from run_code -----------
// The host offers only run_code and declares the callable tools as an SDK in
// the system prompt; that SDK comes from the same restricted view.
if (include('core-ptc')) {
console.log('# ptc profile')
const code = (body) => call('run_code', { code: body, description: 'test step' })
const pt = await run('ptc', 'core-ptc', [
  code("return await tools.tools_ls({ path: '/uncategorized' })"),        // 0
  code("return await tools.tools_load({ targets: ['/uncategorized/fake'] })"), // 1
  code("return await tools.mcp__fake__ping({ text: 'x' })"),               // 2
  { text: 'done' },                                                         // 3
], ['ptc'], { DSH_TOOLS_MODE: 'ptc' })
check('ptc: only run_code is offered as a schema', pt.every((t) => t.tools.length === 1 && t.tools[0] === 'run_code'), JSON.stringify(pt.map((t) => t.tools)))
expect('ptc: the SDK hides unloaded tools', pt[0].systemFake, [])
contains('ptc: tools_ls works from inside run_code', pt[1].lastContent, 'fake/')
expect('ptc: a load adds the group to the SDK from the next step', pt[2].systemFake, [E, P])
contains('ptc: the loaded tool is callable from run_code', pt[3].lastContent, 'mcp__fake__ping:x')
}

// --- persist profile: T14b, loaded state survives a DSH restart ---------------
if (include('persist-main')) {
console.log('# persist profile')
const ps = await run('persist', 'persist-main', [
  call('tools_load', { targets: ['/uncategorized/fake'] }),   // 0
  { text: 'loaded' },                                          // 1
], ['persist load'])
expect('persist: group loaded in the first run', fakeTools(ps[1]), [E, P])
const stateFiles = readdirSync(join(home, 'tool-manager', 'sessions'))
check('persist: one state file written for the session', stateFiles.length === 1, `got ${stateFiles.join(', ')}`)
const savedState = JSON.parse(readFileSync(join(home, 'tool-manager', 'sessions', stateFiles[0]), 'utf8'))
check('persist: file records the subscribed group', savedState.groups?.includes('fake'), JSON.stringify(savedState))
const sessionId = stateFiles[0].replace(/\.json$/, '')
const resumed = await run('persist', 'persist-resume', [{ text: 'resumed' }], ['--session-id', decodeURIComponent(sessionId), 'continue'])
expect('T14b resumed session: restored loads, nothing else exposed', fakeTools(resumed[0]), [E, P])
}

// --- gate profile: high-risk loads need confirmation --------------------------
if (include('gate-main')) {
console.log('# gate profile')
const g = await run('gate', 'gate-main', [
  call('tools_load', { targets: ['adb_fake_two'] }),          // 0 high risk, no approval channel
  call('tools_load', { targets: ['adb_fake_one'] }),           // 1 not high risk: no prompt
  { text: 'done' },                                            // 2
], ['gate'])
contains('gate: high-risk load denied with no approval channel', g[1].lastContent, /requires approval|approval/i)
expect('gate: the denied high-risk tool stays hidden', fakeTools(g[1], 'adb_fake_'), [])
expect('gate: ordinary tools still load without a prompt', fakeTools(g[2], 'adb_fake_'), ['adb_fake_one'])
}

// --- exempt profile: a route whose tool list cannot be refreshed ---------------
// Claude Code gets DSH tools once at session start through the MCP bridge, so a
// session on that route must not be narrowed at all.
if (include('exempt-main')) {
console.log('# exempt profile')
const ex = await run('exempt', 'exempt-main', [
  call('mcp__fake__ping', { text: 'x' }),                      // 0 not pinned, not loaded
  call('tools_ls', { path: '/' }),                             // 1 directory still works
  { text: 'done' },                                            // 2
], ['exempt'])
expect('exempt route: first request offers every tool, unloaded included', fakeTools(ex[0]), ['mcp__fake__echo', 'mcp__fake__ping'])
contains('exempt route: a non-pinned tool runs directly', ex[1].lastContent, 'mcp__fake__ping:x')
contains('exempt route: the directory is still available', ex[2].lastContent, 'uncategorized/')
}

// --- rescue profile: a direct call of a hidden tool ----------------------------
// The real incident: a plugin's prompt tells the model to call a tool that this
// plugin hid. It must not fail with "unknown tool".
if (include('rescue-main')) {
console.log('# rescue profile')
// DSH 0.2.2+ fixes a step's callable tools when the step starts, so there the
// rescued call is refused with "call it again" and the retry (step 1) runs it.
const resc = await run('core', 'rescue-main', [
  call('testkit_protocol_reply', { text: 'hello' }),           // 0 hidden, ordinary: auto-loads
  { ...call('testkit_protocol_reply', { text: 'hello' }), skipUnless: 'call it again' }, // 1 DSH 0.2.2+ retry
  call('adb_fake_two', {}),                                     // 2 hidden, declared high risk
  call('testkit_protocol_reply', { text: 'again' }),            // 3 now loaded, still callable
  call('no_such_tool_at_all', {}),                              // 4 genuinely unknown
  { text: 'done' },                                             // 5
], ['rescue'])
const retried = resc[1]?.lastContent
contains('rescue: a hidden ordinary tool is auto-loaded and runs', resc[2].lastContent, 'protocol reply:hello')
check('rescue: a refused first call names the tool and asks for a retry', retried === undefined || /testkit_protocol_reply.*call it again/.test(retried), retried)
contains('rescue: a hidden high-risk tool gets the load instruction, not unknown', resc[3].lastContent, /adb_fake_two.*high risk.*tools_load/s)
contains('rescue: the ordinary tool stays loaded for the next call', resc[4].lastContent, 'protocol reply:again')
check('rescue: no rescued call reports an unknown tool', [retried, resc[2].lastContent, resc[3].lastContent].every((t) => !/unknown tool/.test(t ?? '')), `${retried} | ${resc[2].lastContent} | ${resc[3].lastContent}`)
contains('rescue: a genuinely unknown tool still reports unknown', resc[5].lastContent, 'unknown tool')
}

// --- cap profile: a capability pack loads as one target ------------------------
if (include('cap-main')) {
console.log('# cap profile')
const cap = await run('cap', 'cap-main', [
  call('tools_load', { targets: ['cap:static'] }),             // 0 a pack from config
  call('tools_unload', { targets: ['all'] }),                  // 1 start clean
  call('tools_load', { targets: ['cap:pair'] }),               // 2 two tools from shared groups
  call('tools_load', { targets: ['cap:nope'] }),               // 3 an unknown pack reports cleanly
  { text: 'done' },                                            // 4
], ['capability'])
expect('cap: tools_load("cap:static") loads exactly the pack tools', fakeTools(cap[1]), [E, P])
expect('cap: unload all clears the pack', fakeTools(cap[2]), [])
// The pack names ping and phone_tap only: their group siblings (echo,
// phone_fake_swipe) must stay hidden.
expect('cap: a pack loads exactly its tools, not their group siblings', fakeTools(cap[3]), [P])
expect('cap: the same applies to the other group in the pack', fakeTools(cap[3], 'phone_fake_'), ['phone_fake_tap'])
contains('cap: an unknown pack is a normal miss, not a crash', cap[4].lastContent, /skipped cap:nope/)
}

// --- devices profile: the device namespace ----------------------------------
if (include('devices-main')) {
console.log('# devices profile')
const dv = await run('devices', 'devices-main', [
  call('tools_ls', { path: '/device' }),                                  // 0
  call('tools_load', { targets: ['device:current'] }),                    // 1
  call('tools_unload', { targets: ['all'] }),                             // 2
  call('tools_load', { targets: ['device:pixel/screen_capture'] }),       // 3
  call('tools_unload', { targets: ['all'] }),                             // 4
  call('tools_load', { targets: ['device:all'] }),                        // 5
  call('tools_ls', { path: '/device/pixel' }),                            // 6
  call('tools_load', { targets: ['device:nope'] }),                       // 7
  { text: 'done' },                                                       // 8
], ['devices'])
const devTools = (turn) => turn.tools.filter((n) => n.startsWith('device__')).sort()
expect('devices: device tools start hidden', devTools(dv[0]), [])
contains('devices: /device lists each device as a group', dv[1].lastContent, /laptop\/[^\n]*\(EliteBook, desktop\)/, /pixel\/[^\n]*\(Pixel 8, android\) \[offline, last seen 2026-11-02T05:00:00Z\]/)
expect('devices: device:current loads the current device only', devTools(dv[2]), ['device__laptop__screen_capture', 'device__laptop__shell_run'])
expect('devices: device:<slug>/<capability> loads one tool', devTools(dv[4]), ['device__pixel__screen_capture'])
expect('devices: device:all loads every device', devTools(dv[6]), ['device__laptop__screen_capture', 'device__laptop__shell_run', 'device__pixel__notify_list', 'device__pixel__screen_capture'])
contains('devices: a device group header carries its offline note', dv[7].lastContent, /^\/device\/pixel\/ .*\[offline/m)
contains('devices: an unknown device is a normal miss', dv[8].lastContent, /skipped device:nope/)
}

// --- packs profile: tool packs register, load by pack:<id>, and run -----------
if (include('packs-main')) {
console.log('# packs profile')
const pk = await run('packs', 'packs-main', [
  call('tools_ls', { path: '/' }),                                         // 0
  call('tools_load', { targets: ['pack:essentials'] }),                    // 1
  call('math_eval', { expression: '5 km to mile' }),                       // 2
  call('time_convert', { time: '2026-11-01 15:30', from_tz: 'Asia/Shanghai', to_tz: 'UTC' }), // 3
  call('tools_load', { targets: ['pack:mcp'] }),                           // 4
  call('mcp_presets'),                                                     // 5
  call('tools_load', { targets: ['pack:web'] }),                           // 6
  call('web_read', { url: 'http://127.0.0.1:9/' }),                        // 7 private address refused
  call('tools_load', { targets: ['pack:nope'] }),                          // 8
  { text: 'done' },                                                        // 9
], ['packs'])
const ESS = ['date_diff', 'geo_search', 'math_eval', 'time_convert', 'time_now', 'weather_forecast', 'wiki_search', 'wiki_summary']
check('packs: pack tools start hidden', !pk[0].tools.some((n) => ESS.includes(n) || n === 'web_read'), pk[0].tools.join(','))
expect('packs: pack:essentials loads exactly the pack', pk[2].tools.filter((n) => ESS.includes(n)).sort(), ESS)
contains('packs: math_eval runs with units', pk[3].lastContent, /3\.10685\d* mile/)
contains('packs: time_convert converts zones', pk[4].lastContent, /UTC: 2026-11-01T07:30:00\+00:00/)
check('packs: pack:mcp is registered (the bundle loaded on this DSH)', !/skipped pack:mcp/.test(pk[5].lastContent), pk[5].lastContent)
contains('packs: mcp_presets lists keyless and keyed presets', pk[6].lastContent, /memory \[memory\] off/, /github \[code\] (off|waiting for GITHUB_TOKEN)/)
check('packs: pack:web loads web_read and web_links', pk[7].tools.includes('web_read') && pk[7].tools.includes('web_links'), pk[7].tools.join(','))
contains('packs: web_read refuses private addresses', pk[8].lastContent, /private address/)
contains('packs: an unknown pack is a normal miss', pk[9].lastContent, /skipped pack:nope/)
}

// --- control profile: ssh tools run, risky calls are refused without an approver -
if (include('control-main')) {
console.log('# control profile')
const ct = await run('control', 'control-main', [
  call('tools_ls', { path: '/' }),                                                 // 0
  call('tools_load', { targets: ['pack:ssh'] }),                                   // 1
  call('ssh_read', { host: 't', path: '/etc/hostname' }),                          // 2
  call('tools_load', { targets: ['pack:ssh-exec'] }),                              // 3
  call('ssh_run', { host: 't', cmd: 'uptime' }),                                   // 4 read-only: no question
  call('ssh_run', { host: 't', cmd: 'rm -rf /srv/data' }),                         // 5 asks, nobody to answer
  call('ssh_write', { host: 't', path: '/etc/motd', content: 'hi' }),              // 6 asks, nobody to answer
  call('ssh_read', { host: 'evil', path: '/etc/hostname' }),                       // 7 not a configured alias
  { text: 'done' },                                                                // 8
], ['control'])
const SSH_READ = ['ssh_hosts', 'ssh_log', 'ssh_read', 'ssh_sys'], SSH_EXEC = ['ssh_get', 'ssh_put', 'ssh_run', 'ssh_write']
check('control: ssh tools start hidden', !ct[0].tools.some((n) => n.startsWith('ssh_')), ct[0].tools.join(','))
expect('control: pack:ssh loads the read-only tools only', ct[2].tools.filter((n) => n.startsWith('ssh_')).sort(), SSH_READ)
contains('control: ssh_read goes through the ssh client', ct[3].lastContent, 'FAKE-SSH-OUTPUT')
expect('control: pack:ssh-exec adds the changing tools', ct[4].tools.filter((n) => n.startsWith('ssh_')).sort(), [...SSH_READ, ...SSH_EXEC])
contains('control: a read-only ssh_run runs without a question', ct[5].lastContent, /^exit 0/, 'FAKE-SSH-OUTPUT')
check('control: ssh_run of a changing command is refused', /approval/i.test(ct[6].lastContent) && !ct[6].lastContent.includes('FAKE-SSH-OUTPUT'), ct[6].lastContent)
check('control: ssh_write is refused', /approval/i.test(ct[7].lastContent) && !ct[7].lastContent.includes('FAKE-SSH-OUTPUT'), ct[7].lastContent)
contains('control: an unknown host alias is an error, not a login attempt', ct[8].lastContent, 'Unknown host "evil"')
const sshSeen = existsSync(fakeSshLog) ? readFileSync(fakeSshLog, 'utf8').trim().split('\n') : []
check('control: only the two permitted calls reached the ssh client', sshSeen.length === 2 && sshSeen[1].includes('uptime') && !sshSeen.some((l) => /rm -rf|motd/.test(l)), sshSeen.join(' | '))
}

// --- Android control scenarios (full tier only) -------------------------------
// The shared testkit has unrelated adb_fake_* tools, so compare the exact names
// supplied by the control pack rather than treating every adb_* as ours.
const ADB_READ_INPUT = ['adb_devices', 'adb_info', 'adb_screen', 'adb_ui', 'adb_tap', 'adb_input', 'adb_app', 'adb_logcat']
const ADB_ROOT = ['adb_shell', 'adb_push', 'adb_pull', 'adb_install']
const controlAdbTools = (turn) => turn.tools.filter((name) => [...ADB_READ_INPUT, ...ADB_ROOT].includes(name)).sort()
if (include('control-adb-disabled')) {
console.log('# control profile: Android packs disabled')
const off = await run('control', 'control-adb-disabled', [
  call('tools_ls', { path: '/device/adb' }),                                     // 0
  call('tools_load', { targets: ['pack:adb', 'pack:adb-root'] }),                  // 1
  { text: 'done' },                                                              // 2
], ['Android packs disabled'])
for (const turn of off) expect('control adb: disabled tools are never offered', controlAdbTools(turn), [])
contains('control adb: disabled pack is absent from the directory', off[1].lastContent, 'No such path: /device/adb')
contains('control adb: disabled packs cannot load', off[2].lastContent, /skipped pack:adb:/, /skipped pack:adb-root:/)
}

if (include('control-adb-main')) {
console.log('# control-adb profile')
writeFileSync(fakeAdbLog, '')
const ad = await run('control-adb', 'control-adb-main', [
  call('tools_ls', { path: '/' }),                                               // 0
  call('tools_load', { targets: ['pack:adb'] }),                                  // 1
  call('adb_ui', { device: 'example-phone' }),                                   // 2
  call('tools_load', { targets: ['adb_shell'] }),                                 // 3
  call('adb_shell', { device: 'example-phone', cmd: 'id', root: true }),           // 4
  { text: 'done' },                                                              // 5
], ['Android control'])
expect('control adb: enabled tools start hidden', controlAdbTools(ad[0]), [])
expect('control adb: pack:adb loads exactly observation and input tools', controlAdbTools(ad[2]), ADB_READ_INPUT)
contains('control adb: adb_ui parses XML from the fake client', (() => { try { return JSON.parse(ad[3].lastContent).content } catch { return ad[3].lastContent } })(), '[1] Button "设置 & Tools" (120,140)', '[2] ImageButton "Search \\"apps\\"" (950,150)')
expect('control adb: adb_shell loads before its call-time gate is tested', controlAdbTools(ad[4]), [...ADB_READ_INPUT, 'adb_shell'])
contains('control adb: root shell is refused without an approval channel', ad[5].lastContent, /approval/i)
const adbSeen = readFileSync(fakeAdbLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
check('control adb: only the permitted UI call reached the adb client',
  adbSeen.length === 2
  && JSON.stringify(adbSeen[0].argv) === JSON.stringify(['connect', 'phone.example:5555'])
  && JSON.stringify(adbSeen[1].argv) === JSON.stringify(['-s', 'phone.example:5555', 'shell', '-T', 'sh'])
  && adbSeen[1].stdin.includes('uiautomator dump --compressed '),
  JSON.stringify(adbSeen))
}

// --- Remote browser control (full tier only, fake SSH + real local CDP WebSocket) ---
const BROWSER = ['browser_tabs', 'browser_page', 'browser_shot', 'browser_open', 'browser_click', 'browser_type', 'browser_key', 'browser_eval'].sort()
const browserTools = (turn) => turn.tools.filter((name) => BROWSER.includes(name)).sort()
if (include('control-browser-disabled')) {
const off = await run('control', 'control-browser-disabled', [
  call('tools_ls', { path: '/browser/browser' }),
  call('tools_load', { targets: ['pack:browser'] }),
  { text: 'done' },
], ['Browser pack disabled'])
for (const turn of off) expect('control browser: disabled tools are never offered', browserTools(turn), [])
contains('control browser: disabled directory is absent', off[1].lastContent, 'No such path: /browser/browser')
contains('control browser: disabled pack cannot load', off[2].lastContent, /skipped pack:browser:/)
}
if (include('control-browser-main')) {
console.log('# control-browser profile')
const bt = await run('control-browser', 'control-browser-main', [
  call('tools_ls', { path: '/browser/browser' }),                               // 0
  call('tools_load', { targets: ['pack:browser'] }),                            // 1 (risk-gate allows pack loading)
  call('browser_tabs', { host: 'example' }),                                   // 2
  call('browser_page', { host: 'example', mode: 'refs' }),                      // 3
  call('browser_page', { host: 'secondary', mode: 'text' }),                    // 4
  call('browser_shot', { host: 'secondary' }),                                 // 5
  call('browser_open', { host: 'example', url: 'https://page.example/' }),      // 6 refused before DNS/tunnel
  call('browser_click', { host: 'example', ref: '00000000:1' }),                // 7 refused before stale-ref check
  call('browser_type', { host: 'example', ref: '00000000:1', text: 'Example' }), // 8 refused
  call('browser_key', { host: 'example', key: 'Enter' }),                       // 9 refused
  call('tools_load', { targets: ['browser_eval'] }),                           // 10 individually load eval
  call('browser_eval', { host: 'example', js: 'location.href' }),               // 11 refused
  call('browser_tabs', { host: 'unknown-example' }),                           // 12 unknown alias
  { text: 'done' },                                                           // 13
], ['Remote browser control'])
expect('control browser: starts hidden', browserTools(bt[0]), [])
expect('control browser: enabled pack loads eight tools', browserTools(bt[2]), BROWSER)
contains('control browser: tabs arrive through the SSH CDP forward', bt[3].lastContent, 'tab-example', 'untrusted_browser_content')
contains('control browser: refs snapshot is untrusted content', bt[4].lastContent, 'untrusted_browser_content', 'Example input', /[a-f0-9]{8}:1/)
contains('control browser: another configured remote host works', bt[5].lastContent, 'Untrusted page', 'untrusted_browser_content')
contains('control browser: screenshot saved locally', bt[6].lastToolContent, `screenshot: ${browserOutputDir}`)
check('control browser: model request carries actual image content', bt[6].images?.some((i) => i.image && i.bytes > 8), JSON.stringify(bt[6].images))
const images = existsSync(browserOutputDir) ? readdirSync(browserOutputDir) : []
check('control browser: local PNG bytes preserved', images.length === 1 && readFileSync(join(browserOutputDir, images[0])).equals(desktopPng), images.join(','))
for (const i of [7,8,9,10,12]) contains('control browser: every mutation needs a call approval channel', bt[i].lastContent, /approval/i)
expect('control browser: high risk tool loads individually', browserTools(bt[11]), BROWSER)
contains('control browser: unknown alias fails without SSH', bt[13].lastContent, 'Unknown host "unknown-example"')
const seen = existsSync(fakeBrowserLog) ? readFileSync(fakeBrowserLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
check('control browser: exactly four reads reach SSH; refused mutations cannot resolve or connect', seen.length === 4 && seen.every((s) => s.argv.includes('-L')), JSON.stringify(seen))
expect('control browser: both fake hosts are addressed', seen.map((s) => s.argv[s.argv.indexOf('--') + 1]), ['root@browser.example','root@browser.example','user@secondary.example','user@secondary.example'])
check('control browser: every listener is private Unix or loopback and has an owned SSH process', seen.every((s) => (process.platform === 'win32' ? /^127\.0\.0\.1:\d+:127\.0\.0\.1:(9222|9333)$/ : /^\/.*\/cdp-\d+\.sock:127\.0\.0\.1:(9222|9333)$/).test(s.argv[s.argv.indexOf('-L') + 1]) && s.argv.includes('ControlPath=none') && s.argv.includes('StreamLocalBindMask=0177')), JSON.stringify(seen))
}

// --- Remote desktop control scenarios (full tier only) -----------------------
const DESKTOP = ['desktop_screen', 'desktop_windows', 'desktop_focus', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_clipboard_get', 'desktop_clipboard_set'].sort()
const desktopTools = (turn) => turn.tools.filter((name) => DESKTOP.includes(name)).sort()
if (include('control-desktop-disabled')) {
console.log('# control profile: desktop pack disabled')
const off = await run('control', 'control-desktop-disabled', [
  call('tools_ls', { path: '/device/desktop' }),
  call('tools_load', { targets: ['pack:desktop'] }),
  { text: 'done' },
], ['Desktop pack disabled'])
for (const turn of off) expect('control desktop: disabled tools are never offered', desktopTools(turn), [])
contains('control desktop: disabled directory is absent', off[1].lastContent, 'No such path: /device/desktop')
contains('control desktop: disabled pack cannot load', off[2].lastContent, /skipped pack:desktop:/)
}
if (include('control-desktop-main')) {
console.log('# control-desktop profile')
writeFileSync(fakeDesktopLog, '')
const dt = await run('control-desktop', 'control-desktop-main', [
  call('tools_ls', { path: '/' }),                                               // 0
  call('tools_load', { targets: ['pack:desktop'] }),                              // 1
  call('desktop_windows', { host: 'example' }),                                  // 2
  call('desktop_windows', { host: 'example-wayland' }),                          // 3
  call('desktop_screen', { host: 'example-wayland' }),                           // 4
  call('desktop_clipboard_get', { host: 'example' }),                            // 5
  call('desktop_click', { host: 'example', x: 10, y: 20 }),                       // 6 refused before probing
  call('desktop_type', { host: 'example-wayland', text: "Example's $(id); text" }), // 7 refused
  call('desktop_key', { host: 'example', combo: 'Return' }),                     // 8 refused
  call('desktop_focus', { host: 'example-wayland', window: '42' }),             // 9 refused
  call('desktop_clipboard_set', { host: 'example', text: 'Example text' }),      // 10 refused
  call('desktop_windows', { host: 'unknown-example' }),                         // 11 unknown alias
  { text: 'done' },                                                              // 12
], ['Remote desktop control'])
expect('control desktop: tools start hidden', desktopTools(dt[0]), [])
expect('control desktop: pack loads all eight tools', desktopTools(dt[2]), DESKTOP)
contains('control desktop: X11 native list via configured host', dt[3].lastContent, 'Example X11 window', '0x0000002a', '"focused":true')
contains('control desktop: Wayland native list via another host', dt[4].lastContent, 'Example Wayland window', '"id":"42"', '"focused":true')
contains('control desktop: screenshot returns a local path', dt[5].lastToolContent, `screenshot: ${desktopOutputDir}`)
check('control desktop: model request carries actual image content', dt[5].images?.some((i) => i.image && i.bytes > 8), JSON.stringify(dt[5].images))
const images = existsSync(desktopOutputDir) ? readdirSync(desktopOutputDir) : []
check('control desktop: screenshot preserves PNG bytes', images.length === 1 && readFileSync(join(desktopOutputDir, images[0])).equals(desktopPng), images.join(','))
contains('control desktop: clipboard read runs', dt[6].lastContent, 'Example desktop clipboard')
for (let i = 7; i <= 11; i++) contains('control desktop: mutation refused without approval channel', dt[i].lastContent, /approval/i)
contains('control desktop: unknown aliases are errors', dt[12].lastContent, 'Unknown host "unknown-example"')
const seen = readFileSync(fakeDesktopLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
check('control desktop: exactly four permitted reads with their probes reached SSH', seen.length === 8, JSON.stringify(seen.map((s) => s.argv.at(-1).slice(-120))))
const desktopTargets = seen.map((s) => s.argv[s.argv.indexOf('--') + 1])
const wantTargets = ['root@desktop.example', 'root@desktop.example', 'user@wayland.example', 'user@wayland.example', 'user@wayland.example', 'user@wayland.example', 'root@desktop.example', 'root@desktop.example']
check('control desktop: reads target both configured machines in call order', JSON.stringify(desktopTargets) === JSON.stringify(wantTargets), JSON.stringify(desktopTargets))
check('control desktop: root actions include a drop to the graphical UID', seen.filter((s) => s.argv.includes('root@desktop.example') && !s.argv.at(-1).includes('# DSH_DESKTOP_PROBE_V2')).every((s) => s.argv.at(-1).includes('--reuid') && s.argv.at(-1).includes('--init-groups')), 'root actions must not execute graphical utilities as UID 0')
}

if (include('control-desktop-niri')) {
console.log('# control-desktop niri profile (input approved once through the DSH approval service)')
writeFileSync(fakeDesktopLog, '')
const nt = await run('control-desktop-niri', 'control-desktop-niri', [
  call('tools_load', { targets: ['pack:desktop'] }),
  call('desktop_windows', { host: 'example-niri' }),
  call('desktop_screen', { host: 'example-niri' }),
  call('desktop_focus', { host: 'example-niri', window: '42' }),
  call('desktop_click', { host: 'example-niri', x: 12, y: 22 }),
  call('desktop_type', { host: 'example-niri', text: "Example's $(id); literal\\n" }),
  call('desktop_key', { host: 'example-niri', combo: 'ctrl+shift+l' }),
  { text: 'done' },
], ['Remote niri control'])
contains('control niri: native focus and workspace-view geometry', nt[2].lastContent, 'Example niri window', '"focused":true', '"x":12', 'workspace-view logical pixels')
contains('control niri: screenshot path accompanies image', nt[3].lastToolContent, `screenshot: ${desktopOutputDir}`)
check('control niri: image reaches model request', nt[3].images?.some((i) => i.image && i.bytes > 8), JSON.stringify(nt[3].images))
for (const [index, expected] of [[4, 'focused 42'], [5, 'clicked 12,22'], [6, 'typed'], [7, 'sent desktop key combo']]) contains('control niri: approved input runs', nt[index].lastContent, expected)
const approvedEvents = readFileSync(join(root, 'control-desktop-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)).filter((r) => r.event === 'approved').map((r) => r.tool)
check('control niri: each input was approved once through DSH approval', JSON.stringify(approvedEvents) === JSON.stringify(['desktop_focus', 'desktop_click', 'desktop_type', 'desktop_key']), JSON.stringify(approvedEvents))
const calls = readFileSync(fakeDesktopLog, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s))
check('control niri: six calls plus probes all reach niri host', calls.length === 12 && calls.every((s) => s.argv.includes('user@niri.example')), JSON.stringify(calls.map((s) => s.argv.at(-1).slice(-100))))
const actions = calls.filter((s) => !s.argv.at(-1).includes('# DSH_DESKTOP_PROBE_V2'))
const script = (s) => s.argv.at(-1).slice("sh -c '".length, -1).split(`'\\''`).join("'")
check('control niri: focus uses native id', script(actions[2]).endsWith("'niri' 'msg' 'action' 'focus-window' '--id' '42'"), script(actions[2]))
check('control niri: click discovers system socket', script(actions[3]).includes('/run/ydotoold/socket') && script(actions[3]).endsWith("'ydotool' 'mousemove' '--absolute' '-x' '12' '-y' '22' && 'ydotool' 'click' '0xC0'"), script(actions[3]))
check('control niri: type uses stdin without shell interpolation', actions[4].stdin === "Example's $(id); literal\\n" && script(actions[4]).endsWith("'ydotool' 'type' '--file' '-'"), JSON.stringify(actions[4]))
check('control niri: keys use evdev and reverse modifier release', script(actions[5]).endsWith("'ydotool' 'key' '29:1' '42:1' '38:1' '38:0' '42:0' '29:0'"), script(actions[5]))
}

// --- llm profile: small-model classification, cached --------------------------
if (include('llm-main')) {
console.log('# llm profile')
const llmRun = await run('llm', 'llm-main', [
  call('tools_ls', { path: '/' }),                            // 0 classifier runs after this build
  call('tools_ls', { path: '/' }),                            // 1 the answer is cached by now
  { text: 'done' },                                           // 2
], ['classify'])
contains('llm: the model answer places the fake group under maps', llmRun[2].lastContent, /maps\//)
contains('llm: groups the model did not answer stay uncategorized', llmRun[2].lastContent, /uncategorized\//)
const cacheRaw = JSON.parse(readFileSync(join(root, 'llm-cache.json'), 'utf8'))
check('llm: answers are cached per group', Object.values(cacheRaw).includes('maps'), JSON.stringify(cacheRaw))
const classifierCalls = readFileSync(join(root, 'llm-main.log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.classifier === true)
check('llm: one classification request per group, not per rebuild', classifierCalls.length > 0 && classifierCalls.length <= 8, `${classifierCalls.length} classifier call(s)`)
}

// --- attr profile: group by the defining plugin package -------------------------
// The scan starts after the first build and refreshes the catalog when it
// finishes. The test kit holds that refresh behind a gate file and logs a
// "gate" line when it runs: step 0 lists before the gate opens (prefix
// fallback), step 1 opens the gate and waits for the post-scan rebuild before
// listing (attribution).
if (include('attr-main')) {
console.log('# attr profile')
const at = await run('attr', 'attr-main', [
  call('tools_ls', { path: '/uncategorized' }),               // 0 the scan starts after this build
  { ...call('tools_ls', { path: '/uncategorized' }), openGate: join(root, 'attr-gate'), waitFor: join(root, 'attr-rebuilds') }, // 1 scanned by now
  call('tools_ls', { query: 'fake' }),                        // 2
  { text: 'done' },                                           // 3
], ['attribute'], { TM_TESTKIT_REBUILD_LOG: join(root, 'attr-rebuilds'), TM_TESTKIT_GATE_REFRESH: join(root, 'attr-gate') })
contains('attr: before the scan, phone tools use the prefix fallback', at[1].lastContent, 'phone/')
check('attr: after the scan, the prefix group is gone', !/\bphone\//.test(at[2].lastContent), at[2].lastContent)
contains('attr: undeclared testkit tools group under their package', at[3].lastContent, '/tm-testkit/phone_fake_tap')
contains('attr: a declared category still applies to the attributed group', at[3].lastContent, '/code/tm-testkit/adb_fake_one')
contains('attr: MCP tools keep the per-server group', at[3].lastContent, '/uncategorized/fake/ping')
}

// --- attr-rules profile: a renamed group keeps its category ---------------------
// The scan renames phone/desktop/mcp groups after their package; the rules only
// know the old names. Those tools must not fall into /uncategorized.
if (include('attr-rules-main')) {
console.log('# attr-rules profile')
const ar = await run('attr-rules', 'attr-rules-main', [
  call('tools_ls', { path: '/' }),                            // 0 the scan starts after this build
  { ...call('tools_ls', { query: '_dev_' }), openGate: join(root, 'attr-rules-gate'), waitFor: join(root, 'attr-rules-rebuilds') }, // 1 scanned by now
  call('tools_ls', { path: '/uncategorized' }),               // 2
  { text: 'done' },                                           // 3
], ['attribute with rules'], { TM_TESTKIT_REBUILD_LOG: join(root, 'attr-rules-rebuilds'), TM_TESTKIT_GATE_REFRESH: join(root, 'attr-rules-gate') })
contains('attr-rules: the scan renamed the group after the package', ar[2].lastContent, '/tm-testkit-devices/phone_dev_tap')
check('attr-rules: phone, desktop and connector tools stay out of /uncategorized', !/\/uncategorized\/tm-testkit-devices\//.test(ar[2].lastContent), ar[2].lastContent)
contains('attr-rules: the renamed group inherits device', ar[2].lastContent, '/device/tm-testkit-devices/desktop_dev_click')
check('attr-rules: /uncategorized lists no testkit-devices group', !/tm-testkit-devices\//.test(ar[3].lastContent), ar[3].lastContent)
}

// --- rules profile: classifier plugin, declarations, overrides, search, filter --
if (include('rules-main')) {
console.log('# rules profile')
const r = await run('rules', 'rules-main', [
  call('tools_ls', { path: '/' }),                            // 0
  call('tools_ls', { path: '/device' }),                      // 1
  call('tools_ls', { path: '/code/adb' }),                    // 2
  call('tools_ls', { query: 'ping' }),                        // 3
  call('tools_load', { targets: ['/device/phone', '/code/adb'] }), // 4
  { text: 'done' },                                           // 5
], ['classify'])

contains('rules: user override places fake under maps', r[1].lastContent, /maps\/\s+2 tools/)
contains('rules: default rules place phone under device', r[2].lastContent, 'phone/')
contains('rules: package.json declaration beats the default adb -> device rule', r[3].lastContent, 'adb_fake_one', 'adb_fake_two')
contains('rules: declared risk marks adb_fake_two high risk', r[3].lastContent, /!\s+adb_fake_two/)
contains('search from root finds tools across directories with full paths', r[4].lastContent, '/maps/fake/ping')
expect('group load skips declared high-risk tool', fakeTools(r[5], 'adb_fake_'), ['adb_fake_one'])
expect('visibility filter narrows: phone_fake_swipe stays hidden', fakeTools(r[5], 'phone_fake_'), ['phone_fake_tap'])
}

// --- preset profile: tools registered only in a preset layer ------------------
if (include('preset-main')) {
console.log('# preset profile')
const pr = await run('preset', 'preset-main', [
  call('tools_ls', { query: 'preset_only' }),                 // 0
  call('tools_load', { targets: ['preset_only_ping'] }),      // 1
  { text: 'done' },                                           // 2
], ['preset tools'])
expect('preset-layer tools hidden until loaded', fakeTools(pr[0], 'preset_only_'), [])
contains('preset-layer tools are listed in the directory', pr[1].lastContent, 'preset_only_ping', 'preset_only_echo')
expect('preset-layer tool loadable by exact name', fakeTools(pr[2], 'preset_only_'), ['preset_only_ping'])
}

console.log(`tier: ${tier}`)
console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
console.log(`artifacts: ${root}`)
process.exit(failures === 0 ? 0 : 1)
