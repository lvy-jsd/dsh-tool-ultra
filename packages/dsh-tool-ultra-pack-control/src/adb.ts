// Android control over configured adb targets. Scripts travel on stdin to a
// non-PTY shell; KernelSU root uses `su -c sh`, never `adb root`.
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { localExec, type Exec, type ExecOptions, type ExecResult } from './kit/exec.js'
import { DEFAULT_DENY_PATHS, capText, intArg, isDeniedPath, isReadOnlyCommand, redact, shq } from './kit/policy.js'
import { readTransfer } from './kit/files.js'
import { COMMON_DEFAULTS, checkCommonConfig, configBoolean, configInteger, configObject, configText, type CommonConfig } from './kit/config.js'
import { sessionKey } from './kit/scope.js'
import type { ToolSpec } from './kit/spec.js'

export const ADB_TOOL_NAMES = ['adb_devices', 'adb_info', 'adb_screen', 'adb_ui', 'adb_tap', 'adb_input', 'adb_app', 'adb_logcat'] as const
export const ADB_ROOT_TOOL_NAMES = ['adb_shell', 'adb_push', 'adb_pull', 'adb_install'] as const

export interface AdbConfig extends CommonConfig {
  /** Alias -> adb serial or wireless host:port. Only aliases are tool arguments. */
  serials?: Record<string, string>
  adbBin?: string
  /** Reconnect configured wireless targets before use. Default true; pairing is manual. */
  adbConnect?: boolean
  /** Ask before taps, input and app start/stop. Default true. */
  adbAskInput?: boolean
  /** Numbered UI snapshots expire after this time. Default 30000 ms. */
  adbUiTtlMs?: number
  outputDir?: string
}
export interface AdbOptions extends AdbConfig { exec?: Exec }

export function checkSerial(alias: string, serial: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(alias)) throw new Error(`Invalid control config: Bad device alias "${alias}".`)
  if (typeof serial !== 'string' || !serial || serial.length > 200) throw new Error(`Invalid control config: Bad adb serial for "${alias}".`)
  if (serial.includes(':')) {
    const endpoint = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[A-Fa-f0-9:]+\]):([0-9]{1,5})$/.exec(serial)
    if (!endpoint || Number(endpoint[1]) < 1 || Number(endpoint[1]) > 65535) throw new Error(`Invalid control config: Bad wireless adb endpoint for "${alias}"; use host:port.`)
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(serial)) throw new Error(`Invalid control config: Bad adb serial for "${alias}".`)
}

export interface UiElement {
  n: number
  text: string
  description: string
  className: string
  x: number
  y: number
}

function xmlText(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-f]+));)/i.test(value)) throw new Error('Invalid XML entity in UI dump.')
  return value.replace(/&([^;]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (Object.hasOwn(named, entity)) return named[entity]
    const match = /^#(x[0-9a-f]+|[0-9]+)$/i.exec(entity)
    const n = match ? (match[1][0].toLowerCase() === 'x' ? parseInt(match[1].slice(1), 16) : Number(match[1])) : -1
    if (n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error('Invalid XML entity in UI dump.')
    return String.fromCodePoint(n)
  })
}

/** Parse the bounded uiautomator format, without evaluating DTDs or external entities. */
export function parseUiDump(xml: string): UiElement[] {
  if (xml.length > 2_000_000 || /<!/i.test(xml)) throw new Error('Unsupported UI XML (size or declaration).')
  const elements: UiElement[] = []
  const stack: { tag: string, enabled: boolean }[] = []
  let end = 0
  let root = false
  const tags = /<\?xml\s[^<>]*\?>|<\/?[a-z]+\b[^<>]*>/g
  for (const match of xml.matchAll(tags)) {
    if (xml.slice(end, match.index).trim()) throw new Error('Malformed UI XML.')
    end = match.index! + match[0].length
    const tag = match[0]
    if (tag.startsWith('<?')) { if (root) throw new Error('Malformed UI XML.'); continue }
    const m = /^<(\/?)(hierarchy|node)\b([\s\S]*?)(\/?)>$/.exec(tag)
    if (!m) throw new Error('Unsupported UI XML tag.')
    if (m[1]) {
      if (m[3].trim() || m[4] || stack.pop()?.tag !== m[2]) throw new Error('Malformed UI XML nesting.')
      continue
    }
    if ((!stack.length && (root || m[2] !== 'hierarchy')) || (stack.length && m[2] !== 'node')) throw new Error('Malformed UI XML root.')
    root = true
    const attrs: Record<string, string> = Object.create(null)
    let rest = m[3]
    while (rest.trim()) {
      const a = /^\s+([a-zA-Z][\w-]*)="([^"<>]*)"/.exec(rest)
      if (!a || Object.hasOwn(attrs, a[1])) throw new Error('Malformed UI XML attributes.')
      attrs[a[1]] = xmlText(a[2])
      rest = rest.slice(a[0].length)
    }
    const enabled = (stack.at(-1)?.enabled ?? true) && attrs.enabled !== 'false'
    if (!m[4]) stack.push({ tag: m[2], enabled })
    if (m[2] !== 'node' || !enabled) continue
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds ?? '')?.slice(1).map(Number)
    if (!bounds || bounds.some((v) => v > 100_000) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) continue
    if (!attrs.text && !attrs['content-desc'] && !['clickable', 'focusable', 'checkable', 'scrollable'].some((k) => attrs[k] === 'true')) continue
    if (elements.length >= 1000) throw new Error('Too many UI elements.')
    elements.push({ n: elements.length + 1, text: attrs.text ?? '', description: attrs['content-desc'] ?? '', className: attrs.class ?? 'View', x: Math.floor((bounds[0] + bounds[2]) / 2), y: Math.floor((bounds[1] + bounds[3]) / 2) })
  }
  if (!root || stack.length || xml.slice(end).trim()) throw new Error('Malformed UI XML.')
  return elements
}

function resultText(r: ExecResult, maxChars: number): string {
  return [`${r.timedOut ? 'timed out' : r.code === null ? 'did not run' : `exit ${r.code}`}${r.truncated ? ' [output cut at the byte limit]' : ''}`, r.stdout && capText(redact(r.stdout).trimEnd(), maxChars), r.stderr && `stderr: ${capText(redact(r.stderr).trimEnd(), maxChars)}`].filter(Boolean).join('\n')
}

export function createAdbTools(options: AdbOptions = {}): ToolSpec[] {
  checkCommonConfig(options, 'adb')
  configText(options.adbBin, 'adb.adbBin')
  configText(options.outputDir, 'adb.outputDir')
  configBoolean(options.adbConnect, 'adb.adbConnect')
  configBoolean(options.adbAskInput, 'adb.adbAskInput')
  configInteger(options.adbUiTtlMs, 30_000, 0, 2_147_483_647, 'adb.adbUiTtlMs')
  if (options.serials !== undefined) configObject(options.serials, 'adb.serials')
  const exec = options.exec ?? localExec
  // Copy to prevent config mutation from changing an already approved target.
  const serials = { ...options.serials }
  for (const [alias, serial] of Object.entries(serials)) checkSerial(alias, serial)
  if (new Set(Object.values(serials)).size !== Object.keys(serials).length) throw new Error('Each adb target must have a unique alias.')
  const bin = options.adbBin ?? 'adb'
  const maxChars = options.maxChars ?? COMMON_DEFAULTS.maxChars
  const maxBytes = options.maxBytes ?? COMMON_DEFAULTS.maxBytes
  const maxTransfer = options.maxTransferBytes ?? COMMON_DEFAULTS.maxTransferBytes
  const transferDir = options.transferDir ?? join(homedir(), 'dsh-transfers')
  const outputDir = options.outputDir ?? join(transferDir, 'screens')
  const deny = [...DEFAULT_DENY_PATHS, ...(options.denyPaths ?? [])].map((p) => new RegExp(p))
  const snapshots = new Map<string, { at: number, elements: UiElement[], revision: number }>()
  const revisions = new Map<string, number>()
  const dumps = new Map<string, string>()
  function invalidate(alias: string): number {
    snapshots.delete(sessionKey(alias))
    const revision = (revisions.get(alias) ?? 0) + 1
    revisions.set(alias, revision)
    return revision
  }
  const device = { type: 'string', required: true, description: 'Configured device alias from adb_devices.' } as const
  const rootParam = { type: 'boolean', description: 'Use KernelSU su; always asks first.' } as const
  const requiredString = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error(`Give a valid ${label}.`)
    return value
  }
  function aliasOf(value: unknown): string {
    if (typeof value !== 'string' || !Object.hasOwn(serials, value)) throw new Error(`Unknown device alias. Configured: ${Object.keys(serials).join(', ') || '(none)'}.`)
    return value
  }
  function rootOf(value: unknown): boolean {
    if (value !== undefined && typeof value !== 'boolean') throw new Error('root must be a boolean.')
    return value === true
  }
  const run = (argv: string[], extra: ExecOptions = {}) => exec([bin, ...argv], { timeoutMs: options.timeoutMs ?? COMMON_DEFAULTS.timeoutMs, maxBytes, ...extra })
  async function connect(alias: string) {
    if (options.adbConnect === false || !serials[alias].includes(':')) return
    const r = await run(['connect', serials[alias]], { timeoutMs: 15_000, maxBytes: 10_000 })
    if (r.code !== 0 || r.timedOut || r.truncated || !/^(?:already )?connected to /m.test(r.stdout)) throw new Error(`adb connect ${alias} failed: ${resultText(r, 1000)}`)
  }
  async function onDevice(value: unknown, args: string[], extra: ExecOptions = {}) {
    const alias = aliasOf(value)
    await connect(alias)
    return run(['-s', serials[alias], ...args], extra)
  }
  function suUnavailable(r: ExecResult): boolean {
    // Only the missing-binary message. A command that itself exits 127 must not
    // be retried without su.
    if (r.code === 0 || r.timedOut) return false
    return /(?:^|\n|\/sh: |\/bash: )\s*su: (?:inaccessible or )?not found\b|su: command not found\b/i.test(`${r.stderr}\n${r.stdout}`)
  }
  async function shell(value: unknown, script: string, root = false, extra: ExecOptions = {}) {
    // adb joins remote argv into a shell command. These argv are all constants;
    // only the stdin script contains data, with every built-in argument quoted.
    // root prefers KernelSU `su -c sh`. If su is missing and adbd is already
    // uid 0 (typical for a root wireless adbd), the same script runs there.
    // Never invoke `adb root` or `adb unroot`.
    const run = (useSu: boolean) => onDevice(value, ['shell', '-T', ...(useSu ? ['su', '-c', 'sh'] : ['sh'])], { ...extra, stdin: `${script}\n` })
    if (!root) return run(false)
    const first = await run(true)
    if (!suUnavailable(first)) return first
    const id = await onDevice(value, ['shell', '-T', 'sh'], { stdin: 'id -u\n', timeoutMs: 15_000, maxBytes: 4000 })
    if (id.code === 0 && !id.timedOut && id.stdout.trim() === '0') return run(false)
    return first
  }

  function remotePath(value: unknown): string {
    const path = requiredString(value, 'absolute remote file path')
    if (!path.startsWith('/') || path === '/' || path.endsWith('/') || [...path].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) || path.split('/').some((s) => s === '.' || s === '..')) throw new Error('Remote file paths must be absolute, without . or .. segments or a trailing slash.')
    if (isDeniedPath(path, deny)) throw new Error(`Refusing ${path}: it holds credentials or process secrets.`)
    return path
  }
  function fileName(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,100}$/.test(value)) throw new Error('Give a plain local file name in transferDir, not a path.')
    return value
  }
  async function localBytes(value: unknown): Promise<{ name: string, bytes: Buffer }> {
    const name = fileName(value)
    const path = join(transferDir, name)
    return { name, bytes: await readTransfer(path, name, maxTransfer) }
  }

  async function staged(value: unknown, action: (path: string, size: number) => Promise<string>, apk = false): Promise<string> {
    const { name, bytes } = await localBytes(value)
    if (apk && !name.toLowerCase().endsWith('.apk')) throw new Error('Give an .apk file name.')
    // adb itself opens this private copy, never a model-selected path or symlink.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adb-'))
    try {
      const path = join(dir, name)
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      return await action(path, bytes.length)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
  async function save(bytes: Buffer, dir: string, name: string): Promise<string> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, name)
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(bytes) } catch (e) { await file.close(); await rm(path, { force: true }); throw e }
    await file.close()
    return path
  }
  function checkBinary(r: ExecResult): void {
    if (r.truncated || r.stdoutBytes.length > maxTransfer) throw new Error(`Binary output exceeded ${maxTransfer} bytes or was truncated; nothing saved.`)
  }
  const askInput = (a: unknown) => options.adbAskInput !== false ? `Android input or app change: ${JSON.stringify(a)}` : undefined
  const summary = (action: string) => (a: { device?: unknown }) => `${a?.device}: ${action}`
  const coordinate = (s: string) => {
    if (!/^\d{1,6},\d{1,6}$/.test(s)) throw new Error('Give coordinates as x,y.')
    const point = s.split(',').map(Number)
    if (point.some((v) => v > 100_000)) throw new Error('Coordinates are out of range.')
    return point
  }

  return [
    {
      name: 'adb_devices', pack: 'adb', risk: 'low',
      description: 'List configured Android adb aliases, serials, models and authorization states; connect wireless targets.',
      parameters: {}, describe: () => 'list configured Android devices',
      async execute() {
        if (!Object.keys(serials).length) return 'No adb devices configured. Add aliases under serials.'
        const failures = new Map<string, string>()
        for (const alias of Object.keys(serials)) {
          try { await connect(alias) } catch (e) { failures.set(alias, capText(redact((e as Error).message), 1000)) }
        }
        const r = await run(['devices', '-l'])
        if (r.code !== 0 || r.timedOut || r.truncated) return resultText({ ...r, stdout: '' }, maxChars)
        const lines = new Map(r.stdout.split('\n').map((line) => { const [serial, ...rest] = line.trim().split(/\s+/); return [serial, rest.join(' ')] }))
        return capText(Object.entries(serials).map(([alias, serial]) => `${alias}: ${serial} - ${failures.get(alias) ?? lines.get(serial) ?? 'not connected'}`).join('\n'), maxChars)
      },
    },
    {
      name: 'adb_info', pack: 'adb', risk: 'low',
      description: 'Android adb overview: model, OS version, battery, foreground app and lock state.',
      parameters: { device }, describe: summary('device overview'),
      async execute(a) {
        return resultText(await shell(a?.device, 'echo "## model"; getprop ro.product.model; echo "## Android"; getprop ro.build.version.release; echo "## battery"; dumpsys battery; echo "## foreground"; dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"; echo "## lock"; dumpsys window policy | grep -E "showing=|isStatusBarKeyguard|mKeyguard|mShowingLockscreen"'), maxChars)
      },
    },
    {
      name: 'adb_screen', pack: 'adb', risk: 'low',
      screenshot: true,
      description: 'Capture an Android adb screenshot as a PNG image.',
      parameters: { device }, describe: summary('screenshot'),
      async execute(a) {
        const alias = aliasOf(a?.device)
        const r = await shell(alias, 'exec screencap -p', false, { maxBytes: maxTransfer + 1 })
        if (r.code !== 0 || r.timedOut) return resultText({ ...r, stdout: '' }, maxChars)
        checkBinary(r)
        if (!r.stdoutBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('adb did not return a PNG screenshot; nothing saved.')
        return `screenshot: ${await save(r.stdoutBytes, outputDir, `${alias}-${randomUUID()}.png`)}`
      },
    },
    {
      name: 'adb_ui', pack: 'adb', risk: 'low',
      description: 'Dump Android UI as numbered elements and centers. Then adb_tap using a number or text; refresh after changes.',
      parameters: { device }, describe: summary('UI snapshot'),
      async execute(a) {
        const alias = aliasOf(a?.device)
        const revision = revisions.get(alias) ?? 0
        const dump = randomUUID()
        const key = sessionKey(alias)
        snapshots.delete(key)
        dumps.set(key, dump)
        // A unique shell-owned file avoids collisions across calls; trap removes
        // it on both success and error. /dev/tty dumps mix status text with XML.
        const path = `/data/local/tmp/dsh-ui-${randomUUID()}.xml`
        const r = await shell(alias, `trap ${shq(`rm -f -- ${shq(path)}`)} EXIT; uiautomator dump --compressed ${shq(path)} >/dev/null && cat -- ${shq(path)}`, false, { maxBytes: Math.min(maxBytes, 2_000_000) })
        if (r.code !== 0 || r.timedOut) return resultText(r, maxChars)
        if (r.truncated) throw new Error('UI dump truncated; refresh with a larger maxBytes.')
        const elements = parseUiDump(r.stdout)
        const text = elements.map((e) => `[${e.n}] ${e.className.split('.').pop()} ${JSON.stringify(e.text || e.description)} (${e.x},${e.y})`).join('\n')
        if (text.length > maxChars) throw new Error('UI snapshot exceeds maxChars; increase it before tapping by reference.')
        if ((revisions.get(alias) ?? 0) !== revision || dumps.get(key) !== dump) throw new Error('UI changed during the dump; run adb_ui again.')
        snapshots.set(key, { at: Date.now(), elements, revision })
        return JSON.stringify({ trust: 'untrusted_android_content', content: redact(text) || 'No visible UI elements.' })
      },
    },
    {
      name: 'adb_tap', pack: 'adb', risk: 'medium', approve: askInput,
      description: 'Tap Android UI: target is a recent adb_ui number, text:LABEL, or x,y coordinates.',
      parameters: { device, target: { type: 'string', required: true, description: 'Element number, text:LABEL, or x,y.' } }, describe: summary('tap'),
      async execute(a) {
        const alias = aliasOf(a?.device)
        const target = requiredString(a?.target, 'tap target')
        let point: number[]
        if (target.includes(',') && !target.startsWith('text:')) point = coordinate(target)
        else {
          const snapshot = snapshots.get(sessionKey(alias))
          if (!snapshot || snapshot.revision !== (revisions.get(alias) ?? 0) || Date.now() - snapshot.at > (options.adbUiTtlMs ?? 30_000)) throw new Error('Run adb_ui for this device first; its snapshot is missing or expired.')
          const matches = target.startsWith('text:') ? snapshot.elements.filter((e) => e.text === target.slice(5) || e.description === target.slice(5)) : snapshot.elements.filter((e) => /^\d+$/.test(target) && e.n === Number(target))
          if (matches.length !== 1) throw new Error('Tap target missing or ambiguous; refresh adb_ui or use coordinates.')
          point = [matches[0].x, matches[0].y]
        }
        invalidate(alias)
        return resultText(await shell(alias, `input tap ${point.join(' ')}`), maxChars)
      },
    },
    {
      name: 'adb_input', pack: 'adb', risk: 'medium', approve: askInput,
      description: 'Android adb input: ASCII text, key code, or swipe coordinates. Text content stays out of audit logs.',
      parameters: { device, kind: { type: 'string', required: true, enum: ['text', 'key', 'swipe'] }, value: { type: 'string', required: true, description: 'Text; KEYCODE_HOME; or x1,y1,x2,y2[,ms].' } }, describe: summary('input'),
      async execute(a) {
        const alias = aliasOf(a?.device)
        const value = requiredString(a?.value, 'input value')
        let cmd: string
        if (a?.kind === 'text') {
          if (!/^[\x20-\x7e]{1,4096}$/.test(value) || value.includes('%s')) throw new Error('adb input text supports printable ASCII only, without literal %s.')
          cmd = `input text ${shq(value.replace(/ /g, '%s'))}`
        } else if (a?.kind === 'key') {
          if (!/^(?:KEYCODE_[A-Z0-9_]{1,60}|\d{1,3})$/.test(value)) throw new Error('Give a key code such as KEYCODE_HOME.')
          cmd = `input keyevent ${shq(value)}`
        } else if (a?.kind === 'swipe') {
          const parts = value.split(',')
          if (parts.length !== 4 && parts.length !== 5) throw new Error('Give swipe as x1,y1,x2,y2[,ms].')
          const points = [...coordinate(parts.slice(0, 2).join(',')), ...coordinate(parts.slice(2, 4).join(','))]
          if (parts[4] !== undefined && (!/^\d{1,5}$/.test(parts[4]) || Number(parts[4]) < 1 || Number(parts[4]) > 10000)) throw new Error('Swipe duration must be 1-10000 ms.')
          cmd = `input swipe ${points.join(' ')} ${parts[4] === undefined ? 300 : Number(parts[4])}`
        } else throw new Error('Input kind must be text, key or swipe.')
        invalidate(alias)
        return resultText(await shell(alias, cmd), maxChars)
      },
    },
    {
      name: 'adb_app', pack: 'adb', risk: 'medium',
      description: 'Android apps over adb: current foreground, list packages, start launcher activity, or force-stop a package.',
      parameters: { device, action: { type: 'string', required: true, enum: ['current', 'list', 'start', 'stop'] }, pkg: { type: 'string', description: 'Android package id for start/stop.' } },
      approve: (a) => ['current', 'list'].includes(a?.action) ? undefined : askInput(a), describe: (a) => `${a?.device}: app ${a?.action} ${a?.pkg ?? ''}`,
      async execute(a) {
        const alias = aliasOf(a?.device)
        let cmd: string
        if (a?.action === 'current') cmd = 'dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"'
        else if (a?.action === 'list') cmd = 'pm list packages'
        else if (a?.action === 'start' || a?.action === 'stop') {
          const pkg = requiredString(a?.pkg, 'package id')
          if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg) || pkg.length > 200) throw new Error('Invalid Android package id.')
          cmd = a.action === 'start' ? `monkey -p ${shq(pkg)} -c android.intent.category.LAUNCHER 1` : `am force-stop ${shq(pkg)}`
          invalidate(alias)
        } else throw new Error('App action must be current, list, start or stop.')
        return resultText(await shell(alias, cmd), maxChars)
      },
    },
    {
      name: 'adb_logcat', pack: 'adb', risk: 'low',
      description: 'Read a bounded Android adb logcat snapshot; optional tag and minimum priority, never follows.',
      parameters: { device, lines: { type: 'integer', description: '1-500 lines; default 50.' }, tag: { type: 'string' }, level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'] } }, describe: summary('logcat snapshot'),
      async execute(a) {
        const tag = a?.tag === undefined ? '' : requiredString(a.tag, 'log tag')
        if (tag && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(tag)) throw new Error('Invalid logcat tag.')
        const level = a?.level ?? 'I'
        if (!['V', 'D', 'I', 'W', 'E', 'F'].includes(level)) throw new Error('Invalid logcat level.')
        return resultText(await shell(a?.device, `logcat -d -t ${intArg(a?.lines, 50, 1, 500)} ${tag ? `${shq(`${tag}:${level}`)} '*:S'` : shq(`*:${level}`)}`), maxChars)
      },
    },
    {
      name: 'adb_shell', pack: 'adb-root', risk: 'high',
      description: 'Run Android shell commands via adb; root uses KernelSU su. Root always asks; non-root read-only commands may skip.',
      parameters: { device, cmd: { type: 'string', required: true }, root: rootParam, timeout_s: { type: 'integer', description: '1-600 seconds; default 60.' } },
      alwaysAsk: (a) => a?.root !== false && a?.root !== undefined,
      approve: (a) => (a?.root === false || a?.root === undefined) && isReadOnlyCommand(String(a?.cmd ?? ''), deny) ? undefined : `${a?.device}: ${a?.root ? 'KernelSU root shell: ' : ''}${String(a?.cmd ?? '')}`,
      describe: (a) => `${a?.device}: ${a?.root ? 'root ' : ''}shell (command omitted)`,
      async execute(a) {
        const alias = aliasOf(a?.device)
        const root = rootOf(a?.root)
        if (typeof a?.cmd !== 'string' || !a.cmd.trim() || a.cmd.includes('\0')) throw new Error('Give a shell command without NUL bytes.')
        invalidate(alias)
        return resultText(await shell(alias, a.cmd, root, { timeoutMs: intArg(a?.timeout_s, Math.round((options.timeoutMs ?? COMMON_DEFAULTS.timeoutMs) / 1000), 1, 600) * 1000 }), maxChars)
      },
    },
    {
      name: 'adb_push', pack: 'adb-root', risk: 'high', alwaysAsk: true,
      description: 'Upload a regular file from transferDir using adb push (shell permissions); always asks. Local is a plain file name.',
      parameters: { device, local: { type: 'string', required: true }, remote: { type: 'string', required: true, description: 'Absolute Android destination path.' } },
      approve: (a) => `${a?.device}: push ${String(a?.local)} to ${String(a?.remote)}`, describe: (a) => `${a?.device}: push ${a?.local} to ${a?.remote}`,
      async execute(a) {
        const alias = aliasOf(a?.device)
        const remote = remotePath(a?.remote)
        invalidate(alias)
        return staged(a?.local, async (path, size) => {
          const r = await onDevice(alias, ['push', path, remote], { timeoutMs: 300_000 })
          return r.code === 0 && !r.timedOut ? `uploaded ${size} bytes to ${remote}\n${resultText(r, maxChars)}` : resultText(r, maxChars)
        })
      },
    },
    {
      // Static high risk because the same tool can read protected files as root.
      name: 'adb_pull', pack: 'adb-root', risk: 'high',
      description: 'Download one Android file into transferDir, never overwrite. Optional KernelSU root always asks first.',
      parameters: { device, remote: { type: 'string', required: true }, local: { type: 'string', required: true, description: 'New plain file name in transferDir.' }, root: rootParam },
      alwaysAsk: (a) => a?.root !== false && a?.root !== undefined,
      approve: (a) => a?.root === false || a?.root === undefined ? undefined : `${a?.device}: KernelSU root pull ${String(a?.remote)} as ${String(a?.local)}`, describe: (a) => `${a?.device}: pull ${a?.remote} as ${a?.local}`,
      async execute(a) {
        const alias = aliasOf(a?.device)
        const remote = remotePath(a?.remote)
        const name = fileName(a?.local)
        const r = await shell(alias, `if [ -f ${shq(remote)} ]; then exec head -c ${maxTransfer + 1} -- ${shq(remote)}; else echo 'Remote path must be a regular file.' >&2; exit 1; fi`, rootOf(a?.root), { timeoutMs: 300_000, maxBytes: maxTransfer + 1 })
        if (r.code !== 0 || r.timedOut) return resultText({ ...r, stdout: '' }, maxChars)
        checkBinary(r)
        return `saved ${r.stdoutBytes.length} bytes to ${await save(r.stdoutBytes, transferDir, name)}`
      },
    },
    {
      name: 'adb_install', pack: 'adb-root', risk: 'high', alwaysAsk: true,
      description: 'Install one APK from transferDir over adb, without replacement or downgrade flags; always asks.',
      parameters: { device, apk: { type: 'string', required: true, description: 'Plain .apk file name in transferDir.' } },
      approve: (a) => `${a?.device}: install ${String(a?.apk)}`, describe: (a) => `${a?.device}: install ${a?.apk}`,
      async execute(a) {
        const alias = aliasOf(a?.device)
        invalidate(alias)
        return staged(a?.apk, async (path) => resultText(await onDevice(alias, ['install', path], { timeoutMs: 300_000 }), maxChars), true)
      },
    },
  ]
}
