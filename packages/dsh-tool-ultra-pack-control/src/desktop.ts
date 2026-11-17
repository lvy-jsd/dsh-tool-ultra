// Remote desktop only: every probe and desktop command goes through SSH.
import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSshTransport, type SshOptions } from './ssh.js'
import { capText, redact, shq } from './kit/policy.js'
import { markFailed } from './kit/scope.js'
import type { ExecResult } from './kit/exec.js'
import type { ToolSpec } from './kit/spec.js'
import { checkDesktopSession, desktopProbeScript, selectDesktopSession, type DesktopBackend } from './desktop-session.js'
import { ydotoolKeys, ydotoolSocket } from './desktop-input.js'
import { COMMON_DEFAULTS, configInteger, configText } from './kit/config.js'

export * from './desktop-session.js'
export const DESKTOP_TOOL_NAMES = ['desktop_screen', 'desktop_windows', 'desktop_focus', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_clipboard_get', 'desktop_clipboard_set'] as const
export interface DesktopConfig {
  outputDir?: string
  /** Cache successful sessions per host, default 3000 ms; 0 disables it. Failures invalidate. */
  desktopCacheMs?: number
}
export interface DesktopOptions extends SshOptions, DesktopConfig {}

const hostParam = { type: 'string', required: true, description: 'Remote host alias from hosts / ssh_hosts.' } as const
const packages: Record<string, string> = { 'wl-copy': 'wl-clipboard', 'wl-paste': 'wl-clipboard', swaymsg: 'sway', hyprctl: 'hyprland' }
const command = (...argv: string[]) => argv.map(shq).join(' ')
function requireCommands(names: string[]): string {
  return [...new Set(names)].map((name) => `command -v ${shq(name)} >/dev/null 2>&1 || { printf '%s\n' ${shq(`Missing remote command: ${name}. Make it available to the SSH user (NixOS package: ${packages[name] ?? name}); nothing was installed.`)} >&2; exit 127; }`).join('\n')
}
function textArg(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.includes('\0') || Buffer.byteLength(value) > max) throw new Error(`Give ${label} as text without NUL, at most ${max} bytes.`)
  return value
}
function coordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000) throw new Error('Coordinates must be integers from 0 to 100000.')
  return value
}

/** A compact supported subset of XKB keysyms; no arbitrary command chains/options. */
export function desktopCombo(value: unknown): { modifiers: string[], key: string } {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Give one key combo, such as ctrl+l or alt+Tab.')
  const parts = value.split('+')
  const aliases: Record<string, string> = { enter: 'Return', return: 'Return', escape: 'Escape', esc: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', left: 'Left', right: 'Right', up: 'Up', down: 'Down', plus: 'plus', minus: 'minus' }
  const last = parts.pop()!
  const key = Object.hasOwn(aliases, last.toLowerCase()) ? aliases[last.toLowerCase()] : /^[a-z0-9]$/i.test(last) ? last : /^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(last) ? last.toUpperCase() : ''
  const modifiers = parts.map((v) => v.toLowerCase()).map((v) => ['super', 'win', 'meta'].includes(v) ? 'logo' : v)
  if (!key || modifiers.length > 4 || new Set(modifiers).size !== modifiers.length || modifiers.some((v) => !['ctrl', 'alt', 'shift', 'logo'].includes(v))) throw new Error('Unsupported key combo. Use ctrl/alt/shift/super plus a letter, digit, F1-F24, navigation key, plus or minus.')
  return { modifiers, key }
}

function failure(r: ExecResult, maxChars: number): string {
  markFailed()
  return capText(redact(`${r.timedOut ? 'SSH desktop command timed out' : `SSH desktop exit ${r.code ?? 'not started'}`}${r.truncated ? ' [output truncated]' : ''}\n${r.stderr || r.stdout}`), maxChars)
}

/** Root only selects the wrapper; graphical env and executable lookup happen after dropping UID. */
export function desktopCommandScript(b: DesktopBackend, needs: string[], script: string): string {
  const env = Object.entries(b.env).filter(([, v]) => v).map(([k, v]) => `${k}=${shq(v)}`).join(' ')
  const refuse = `printf '%s\\n' 'Desktop session changed or is no longer active; refresh the session and try again.' >&2; exit 75`
  const guard = `[ "$(id -u)" = ${shq(String(b.user.uid))} ]${b.loginUid === 0 ? ` && [ "$(id -g)" = ${shq(String(b.user.gid))} ]` : ''} || { ${refuse}; }\n[ -S ${shq(b.socket.path)} ] && [ "$(stat -c '%u:%i' -- ${shq(b.socket.path)} 2>/dev/null)" = ${shq(`${b.socket.uid}:${b.socket.inode}`)} ] || { ${refuse}; }`
  const active = b.sessionId ? `\n[ "$(loginctl show-session ${shq(b.sessionId)} -p Active --value 2>/dev/null)" = yes ] && [ "$(loginctl show-session ${shq(b.sessionId)} -p User --value 2>/dev/null)" = ${shq(String(b.user.uid))} ] || { ${refuse}; }` : ''
  const inner = `set -e\n${guard}${active}\nunset DISPLAY XAUTHORITY WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE XDG_CURRENT_DESKTOP SWAYSOCK HYPRLAND_INSTANCE_SIGNATURE NIRI_SOCKET YDOTOOL_SOCKET\n${env ? `export ${env}\n` : ''}${b.loginUid === 0 ? 'cd "$HOME"\n' : ''}${requireCommands(needs)}\n${script}`
  if (b.loginUid !== 0) return inner
  // Never execute a graphical utility or source a user profile while UID 0.
  const path = `${b.user.home}/.nix-profile/bin:${b.user.home}/.local/state/nix/profiles/profile/bin:/etc/profiles/per-user/${b.user.name}/bin:/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin`
  const child = ['env', '-i', `HOME=${b.user.home}`, `USER=${b.user.name}`, `LOGNAME=${b.user.name}`, `PATH=${path}`, 'LANG=C.UTF-8', 'sh', '-c', inner]
  return `set -e\n[ "$(id -u)" = 0 ] && [ "$(id -u -- ${shq(b.user.name)} 2>/dev/null)" = ${shq(String(b.user.uid))} ] || { ${refuse}; }\nif command -v setpriv >/dev/null 2>&1; then\n  exec ${command('setpriv', '--reuid', String(b.user.uid), '--regid', String(b.user.gid), '--init-groups', '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--no-new-privs', '--', ...child)}\nelif command -v runuser >/dev/null 2>&1; then\n  exec ${command('runuser', '-u', b.user.name, '--', ...child)}\nelse\n  printf '%s\\n' 'Root desktop control needs setpriv or runuser (util-linux) to drop to the graphical user. No command was run as root.' >&2; exit 127\nfi`
}

/** Normalize native IDs without treating window titles as selectors or code. */
export function desktopWindows(backend: DesktopBackend['kind'], raw: string): string {
  let rows: { id: string, app: string, title: string, focused: boolean, rect?: unknown }[] = []
  if (backend === 'x11') {
    const [active, ...lines] = raw.trimEnd().split('\n')
    rows = lines.filter(Boolean).map((line) => {
      const m = /^(0x[\da-f]+)\s+-?\d+\s+(\S+)\s+\S+\s*(.*)$/i.exec(line)
      if (!m) throw new Error('Invalid wmctrl window list.')
      return { id: m[1], app: m[2], title: m[3], focused: BigInt(m[1]) === BigInt(active) }
    })
  } else {
    const data = JSON.parse(raw)
    if (backend === 'sway') {
      const visit = (node: Record<string, unknown>) => {
        if ((node.app_id || node.window) && node.type === 'con') rows.push({ id: String(node.id), app: String(node.app_id ?? (node.window_properties as Record<string, unknown>)?.class ?? ''), title: String(node.name ?? ''), focused: node.focused === true, rect: node.rect })
        for (const child of [...(Array.isArray(node.nodes) ? node.nodes : []), ...(Array.isArray(node.floating_nodes) ? node.floating_nodes : [])]) visit(child)
      }
      visit(data)
    } else {
      const windows = data.windows ?? data
      if (!Array.isArray(windows)) throw new Error('Invalid compositor window list.')
      rows = windows.map((w) => {
        const common = { app: String(w.app_id ?? w.class ?? ''), title: String(w.title ?? '') }
        if (backend === 'hyprland') return {
          ...common, id: String(w.address), focused: w.address === data.active?.address,
          rect: { x: w.at?.[0], y: w.at?.[1], width: w.size?.[0], height: w.size?.[1] },
        }
        const layout = w.layout
        const pair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
        // niri layout positions belong to a workspace view, not the global
        // output/screenshot coordinate space. Older versions omit this data.
        const rect = layout && pair(layout.tile_pos_in_workspace_view) && pair(layout.window_offset_in_tile) && pair(layout.window_size)
          ? { x: layout.tile_pos_in_workspace_view[0] + layout.window_offset_in_tile[0], y: layout.tile_pos_in_workspace_view[1] + layout.window_offset_in_tile[1], width: layout.window_size[0], height: layout.window_size[1] }
          : undefined
        return {
          ...common, id: String(w.id), workspace_id: w.workspace_id ?? null,
          focused: Object.hasOwn(data, 'active') ? w.id === data.active?.id : w.is_focused === true,
          ...(layout ? { layout, coordinate_space: 'workspace-view logical pixels' } : {}),
          ...(rect ? { rect } : {}),
        }
      })
    }
  }
  return `${backend}: ${rows.length} windows\n${rows.map((w) => JSON.stringify(w)).join('\n')}`.trimEnd()
}

export function createDesktopTools(options: DesktopOptions = {}): ToolSpec[] {
  const { remote, hostOf } = createSshTransport(options)
  for (const host of Object.values(options.hosts ?? {})) checkDesktopSession(host.desktop)
  const maxChars = options.maxChars ?? COMMON_DEFAULTS.maxChars
  const maxTransfer = options.maxTransferBytes ?? COMMON_DEFAULTS.maxTransferBytes
  const outputDir = options.outputDir ?? join(options.transferDir ?? join(homedir(), 'dsh-transfers'), 'screens')
  configText(options.outputDir, 'desktop.outputDir')
  const cacheMs = configInteger(options.desktopCacheMs, 3000, 0, 30_000, 'desktop.desktopCacheMs')
  const cache = new Map<string, { backend: DesktopBackend, expires: number }>()
  const discoveredAt = new WeakMap<DesktopBackend, number>()

  async function session(host: unknown): Promise<DesktopBackend> {
    const config = hostOf(host).desktop ?? {}
    const cached = cache.get(String(host))
    if (cached && cached.expires > Date.now()) return cached.backend
    cache.delete(String(host))
    const { result } = await remote(host, desktopProbeScript(config), { bytes: 2_000_000 })
    if (result.code !== 0 || result.timedOut || result.truncated) throw new Error(failure(result, maxChars))
    const backend = selectDesktopSession(result.stdout, config)
    discoveredAt.set(backend, Date.now())
    return backend
  }
  async function run(host: unknown, b: DesktopBackend, needs: string[], script: string, stdin?: string, bytes?: number) {
    const { result } = await remote(host, desktopCommandScript(b, needs, script), { stdin, bytes })
    if (result.code === 0 && !result.timedOut && !result.truncated) {
      if (cacheMs) cache.set(String(host), { backend: b, expires: (discoveredAt.get(b) ?? Date.now()) + cacheMs })
    } else cache.delete(String(host))
    return result
  }
  function wm(b: DesktopBackend): string {
    if (b.kind === 'wayland') throw new Error(`Window enumeration/focus is unsupported for this Wayland compositor (${b.env.XDG_CURRENT_DESKTOP || 'unknown'}). Supported: Sway, Hyprland, niri; set desktop.backend/desktop.env if detection was incomplete. Xwayland tools are not a native Wayland fallback.`)
    return { x11: 'wmctrl', sway: 'swaymsg', hyprland: 'hyprctl', niri: 'niri' }[b.kind]
  }
  const summary = (host: unknown, action: string) => `${host}: ${action}`
  const done = (r: ExecResult, action: string) => r.code !== 0 || r.timedOut || r.truncated ? failure(r, maxChars) : action

  const specs: ToolSpec[] = [
    {
      name: 'desktop_screen', pack: 'desktop', risk: 'low',
      screenshot: true,
      description: 'Screenshot a remote Linux desktop over SSH. Returns an image when DSH attachments are available, plus a local PNG path. Never changes the clipboard.',
      parameters: { host: hostParam }, describe: (a) => summary(a?.host, 'desktop screenshot'),
      async execute(a) {
        const b = await session(a?.host)
        const cmd = b.kind === 'x11' ? 'scrot' : 'grim'
        const r = await run(a.host, b, [cmd], command(cmd, ...(cmd === 'grim' ? ['-t', 'png', '-'] : ['-F', '-'])), undefined, maxTransfer + 1)
        if (r.code !== 0 || r.timedOut) return failure(r, maxChars) + (b.kind !== 'x11' ? '\nWayland capture requires grim and a compositor with wlr-screencopy or ext-image-copy-capture support; check versions/protocols. No portal prompt or clipboard fallback was attempted.' : '')
        if (r.truncated || r.stdoutBytes.length > maxTransfer) throw new Error('Screenshot exceeds maxTransferBytes or was truncated; nothing saved.')
        if (!r.stdoutBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Remote screenshot is not a PNG; nothing saved.')
        await mkdir(outputDir, { recursive: true, mode: 0o700 })
        const path = join(outputDir, `desktop-${a.host}-${randomUUID()}.png`)
        const file = await open(path, 'wx', 0o600)
        try { await file.writeFile(r.stdoutBytes) } finally { await file.close() }
        return `screenshot: ${path}`
      },
    },
    {
      name: 'desktop_windows', pack: 'desktop', risk: 'low',
      description: 'List remote desktop windows over SSH: native id, title, app, focus and available geometry. Use the id with desktop_focus.',
      parameters: { host: hostParam }, describe: (a) => summary(a?.host, 'list desktop windows'),
      async execute(a) {
        const b = await session(a?.host), cmd = wm(b)
        const scripts = { x11: `${command('xdotool', 'getactivewindow')} || printf '0\n'\n${command('wmctrl', '-lx')}`, sway: command('swaymsg', '-r', '-t', 'get_tree'), hyprland: `printf '{"windows":'\n${command('hyprctl', '-j', 'clients')}\nprintf ',"active":'\n${command('hyprctl', '-j', 'activewindow')}\nprintf '}'`, niri: `printf '{"windows":'\n${command('niri', 'msg', '--json', 'windows')}\nprintf ',"active":'\n${command('niri', 'msg', '--json', 'focused-window')}\nprintf '}'`, wayland: '' }
        const r = await run(a.host, b, b.kind === 'x11' ? [cmd, 'xdotool'] : [cmd], scripts[b.kind])
        if (r.code !== 0 || r.timedOut || r.truncated) return failure(r, maxChars)
        return capText(redact(desktopWindows(b.kind, r.stdout)), maxChars)
      },
    },
    {
      name: 'desktop_focus', pack: 'desktop', risk: 'medium', alwaysAsk: true,
      description: 'Focus a remote desktop window by native id from desktop_windows. Always asks before changing focus; titles are not accepted.',
      parameters: { host: hostParam, window: { type: 'string', required: true, description: 'Exact native window id, never a title/pattern.' } },
      describe: (a) => summary(a?.host, `focus desktop window ${a?.window}`), approve: (a) => summary(a?.host, `focus desktop window ${a?.window}`),
      async execute(a) {
        const id = textArg(a?.window, 'a window id', 32)
        if (!/^(?:0x[\da-fA-F]{1,16}|[1-9]\d{0,15})$/.test(id)) throw new Error('Give a native window id from desktop_windows, not a title or pattern.')
        const b = await session(a?.host), cmd = wm(b)
        if (['sway', 'niri'].includes(b.kind) && !/^[1-9]\d*$/.test(id)) throw new Error('This compositor requires a decimal window id.')
        if (b.kind === 'hyprland' && !/^0x[\da-fA-F]+$/.test(id)) throw new Error('Hyprland requires a hexadecimal window address.')
        const scripts = { x11: command('xdotool', 'windowactivate', '--sync', id), sway: command('swaymsg', '-r', `[con_id=${id}] focus`), hyprland: command('hyprctl', 'dispatch', 'focuswindow', `address:${id}`), niri: command('niri', 'msg', 'action', 'focus-window', '--id', id), wayland: '' }
        const r = await run(a.host, b, [b.kind === 'x11' ? 'xdotool' : cmd], scripts[b.kind])
        // IPC replies can report failure despite a zero process exit status.
        if (b.kind === 'sway' && r.code === 0 && !r.truncated && !r.timedOut) {
          const replies = JSON.parse(r.stdout)
          if (!Array.isArray(replies) || !replies.length || replies.some((v) => v.success !== true)) throw new Error(capText(redact(`Sway focus failed: ${r.stdout}`), maxChars))
        }
        if (b.kind === 'hyprland' && r.code === 0 && r.stdout.trim() !== 'ok') throw new Error(capText(redact(`Hyprland focus failed: ${r.stdout}`), maxChars))
        return done(r, `focused ${id}`)
      },
    },
    {
      name: 'desktop_click', pack: 'desktop', risk: 'medium', alwaysAsk: true,
      description: 'Click remote desktop coordinates over SSH. Always asks. Wayland uses an existing ydotoold socket; coordinates need manual calibration with scaling/multiple outputs or acceleration. Never starts a daemon.',
      parameters: { host: hostParam, x: { type: 'integer', required: true, description: 'Desktop x coordinate.' }, y: { type: 'integer', required: true, description: 'Desktop y coordinate.' }, button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Default left; one click.' } },
      describe: (a) => summary(a?.host, `click desktop ${a?.x},${a?.y} (${a?.button ?? 'left'})`), approve: (a) => summary(a?.host, `click desktop at ${a?.x},${a?.y} (${a?.button ?? 'left'})`),
      async execute(a) {
        const x = String(coordinate(a?.x)), y = String(coordinate(a?.y)), button = a?.button ?? 'left'
        if (!['left', 'middle', 'right'].includes(button)) throw new Error('Button must be left, middle or right.')
        const b = await session(a?.host)
        let script: string
        const cmd = b.kind === 'x11' ? 'xdotool' : 'ydotool'
        if (b.kind === 'x11') script = command(cmd, 'mousemove', '--sync', x, y, 'click', String({ left: 1, middle: 2, right: 3 }[button as string]))
        else {
          script = `${ydotoolSocket(b)}\n${command(cmd, 'mousemove', '--absolute', '-x', x, '-y', y)} && ${command(cmd, 'click', String({ left: '0xC0', middle: '0xC2', right: '0xC1' }[button as string]))}`
        }
        return done(await run(a.host, b, [cmd], script), `clicked ${x},${y} (${button})`)
      },
    },
    {
      name: 'desktop_type', pack: 'desktop', risk: 'medium', alwaysAsk: true,
      description: 'Type text into the focused remote desktop window. Always asks; newline/tab can activate UI. niri defaults to ydotool (ASCII, US layout); optional wtype supports UTF-8. Does not paste or change clipboard.',
      parameters: { host: hostParam, text: { type: 'string', required: true, description: 'Literal text, max 20000 UTF-8 bytes.' } },
      describe: (a) => summary(a?.host, `type ${Buffer.byteLength(String(a?.text ?? ''))} bytes on desktop`), approve: (a) => summary(a?.host, `type in the focused window (newlines may submit):\n${String(a?.text ?? '')}`),
      async execute(a) {
        const text = textArg(a?.text, 'text', 20_000)
        const b = await session(a?.host), cmd = b.kind === 'x11' ? 'xdotool' : hostOf(a.host).desktop?.keyboard ?? (b.kind === 'niri' ? 'ydotool' : 'wtype')
        if (cmd === 'ydotool' && /[^\x20-\x7e\n\t]/.test(text)) throw new Error('ydotool typing supports printable ASCII, tab and newline on a US keyboard layout only. For Unicode use desktop.keyboard: wtype if the compositor supports virtual-keyboard; no text was sent.')
        const script = b.kind === 'x11' ? command(cmd, 'type', '--clearmodifiers', '--file', '-') : cmd === 'ydotool' ? `${ydotoolSocket(b)}\n${command(cmd, 'type', '--file', '-')}` : command(cmd, '-')
        return done(await run(a.host, b, [cmd], script, text), `typed ${Buffer.byteLength(text)} bytes`)
      },
    },
    {
      name: 'desktop_key', pack: 'desktop', risk: 'medium', alwaysAsk: true,
      description: 'Send one key combination to the focused remote desktop window, e.g. ctrl+l, alt+Tab, Return. Always asks. niri defaults to ydotool evdev keys; optional wtype needs virtual-keyboard support.',
      parameters: { host: hostParam, combo: { type: 'string', required: true, description: 'ctrl/alt/shift/super + letter, digit, F1-F24 or navigation key.' } },
      describe: (a) => summary(a?.host, `desktop key combo ${a?.combo}`), approve: (a) => summary(a?.host, `send desktop key ${String(a?.combo ?? '')}`),
      async execute(a) {
        const { modifiers, key } = desktopCombo(a?.combo)
        const b = await session(a?.host), cmd = b.kind === 'x11' ? 'xdotool' : hostOf(a.host).desktop?.keyboard ?? (b.kind === 'niri' ? 'ydotool' : 'wtype')
        const xmods: Record<string, string> = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', logo: 'super' }
        const args = b.kind === 'x11' ? ['key', '--clearmodifiers', [...modifiers.map((m) => xmods[m]), key].join('+')] : cmd === 'ydotool' ? ['key', ...ydotoolKeys(modifiers, key)] : [...modifiers.flatMap((m) => ['-M', m]), '-k', key, ...[...modifiers].reverse().flatMap((m) => ['-m', m])]
        return done(await run(a.host, b, [cmd], `${cmd === 'ydotool' ? ydotoolSocket(b) + '\n' : ''}${command(cmd, ...args)}`), 'sent desktop key combo')
      },
    },
    {
      name: 'desktop_clipboard_get', pack: 'desktop', risk: 'low',
      description: 'Read remote desktop clipboard text over SSH. Output is bounded and redacted; does not watch the clipboard.',
      parameters: { host: hostParam }, describe: (a) => summary(a?.host, 'read desktop clipboard'),
      async execute(a) {
        const b = await session(a?.host), cmd = b.kind === 'x11' ? 'xclip' : 'wl-paste'
        const args = b.kind === 'x11' ? ['-selection', 'clipboard', '-out'] : ['--no-newline', '--type', 'text']
        const r = await run(a.host, b, [cmd], command(cmd, ...args))
        return r.code !== 0 || r.timedOut || r.truncated ? failure(r, maxChars) : capText(redact(r.stdout), maxChars)
      },
    },
    {
      name: 'desktop_clipboard_set', pack: 'desktop', risk: 'medium', alwaysAsk: true,
      description: 'Replace remote desktop clipboard text over SSH. Always asks. An empty string clears text; clipboard ownership may need a background helper.',
      parameters: { host: hostParam, text: { type: 'string', required: true, description: 'Literal UTF-8 clipboard text, max 20000 bytes.' } },
      describe: (a) => summary(a?.host, `write ${Buffer.byteLength(String(a?.text ?? ''))} clipboard bytes`), approve: (a) => summary(a?.host, `replace desktop clipboard text:\n${String(a?.text ?? '')}`),
      async execute(a) {
        const text = textArg(a?.text, 'clipboard text', 20_000, true)
        const b = await session(a?.host), cmd = b.kind === 'x11' ? 'xclip' : 'wl-copy'
        const args = b.kind === 'x11' ? ['-selection', 'clipboard', '-in', '-silent'] : ['--type', 'text/plain;charset=utf-8']
        // Both utilities fork the owner by default; discard inherited SSH pipes
        // so an owner waiting for paste requests cannot keep the call open.
        const script = `umask 077\nd=$(mktemp -d)\ntrap 'rm -rf -- "$d"' EXIT HUP INT TERM\nif ${command(cmd, ...args)} >/dev/null 2>"$d/error"; then :; else cat "$d/error" >&2; exit 1; fi`
        return done(await run(a.host, b, [cmd, 'mktemp', 'cat', 'rm'], script, text), `wrote ${Buffer.byteLength(text)} clipboard bytes`)
      },
    },
  ]
  return specs.map((spec) => ({ ...spec, async execute(args) {
    try { return await spec.execute(args) } catch (error) { cache.delete(String(args?.host)); throw error }
  } }))
}
