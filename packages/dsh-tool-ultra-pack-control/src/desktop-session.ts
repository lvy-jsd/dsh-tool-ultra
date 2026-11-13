// The remote probe transports data, never shell assignments to evaluate. Session
// selection happens locally; graphical values are quoted only after selection.
import { shq } from './kit/policy.js'

export const DESKTOP_ENV = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'SWAYSOCK', 'HYPRLAND_INSTANCE_SIGNATURE', 'NIRI_SOCKET', 'YDOTOOL_SOCKET'] as const
export const DESKTOP_BACKENDS = ['x11', 'sway', 'hyprland', 'niri', 'wayland'] as const
export type DesktopKind = typeof DESKTOP_BACKENDS[number]
export interface DesktopSessionConfig {
  /** Graphical account name or UID. Root drops to this account; other logins cannot switch UID. */
  user?: string
  backend?: DesktopKind
  env?: Partial<Record<typeof DESKTOP_ENV[number], string>>
}
export interface DesktopUser { name: string, uid: number, gid: number, home: string }
export interface DesktopSocket { path: string, uid: number, inode: string }
export interface DesktopBackend {
  kind: DesktopKind
  env: Record<string, string>
  loginUid: number
  user: DesktopUser
  socket: DesktopSocket
  sessionId?: string
}

const USER = /^(?:[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?|\d{1,10})$/
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export function checkDesktopSession(config: DesktopSessionConfig = {}): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('desktop must be a session configuration object.')
  if (config.user !== undefined && (typeof config.user !== 'string' || !USER.test(config.user))) throw new Error('desktop.user must be an account name or numeric UID.')
  if (config.backend !== undefined && !DESKTOP_BACKENDS.includes(config.backend)) throw new Error('Bad desktop backend: use x11, sway, hyprland, niri or wayland.')
  if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env))) throw new Error('desktop.env must be an object.')
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!(DESKTOP_ENV as readonly string[]).includes(key) || typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error(`Invalid desktop environment override: ${key}.`)
  }
}

/** POSIX shell syntax with Linux coreutils and GNU grep. No Python, jq or eval.
 * NUL-delimited /proc entries are filtered with grep -z BEFORE base64 encoding,
 * so embedded newlines/quotes cannot introduce records or shell assignments.
 * loginctl/getent are optional; live sockets/processes and /etc/passwd are the fallback.
 */
export const DESKTOP_PROBE = String.raw`
# DSH_DESKTOP_PROBE_V2
set -eu
export LC_ALL=C
for cmd in id stat grep base64 tr cut; do
  command -v "$cmd" >/dev/null 2>&1 || { printf 'Missing remote probe command: %s (coreutils / GNU grep).\n' "$cmd" >&2; exit 127; }
done
b64() { base64 | tr -d '\n'; }
login_uid=$(id -u)
printf 'DSH_DESKTOP_V2\nI\t%s\n' "$login_uid"
printf 'U\t'
if command -v getent >/dev/null 2>&1; then
  getent passwd | cut -d: -f1,3,4,6 | b64
else
  cut -d: -f1,3,4,6 /etc/passwd | b64
fi
printf '\n'
if [ -n "$desktop_user" ] && command -v getent >/dev/null 2>&1; then
  printf 'U\t'; getent passwd "$desktop_user" | cut -d: -f1,3,4,6 | b64; printf '\n'
fi
if command -v loginctl >/dev/null 2>&1; then
  loginctl list-sessions --no-legend --no-pager 2>/dev/null | while read -r sid rest; do
    case "$sid" in ''|*[!a-zA-Z0-9_.-]*) continue;; esac
    props=$(loginctl show-session "$sid" --no-pager -p User -p Active -p Type -p Class -p Display -p State 2>/dev/null) || continue
    printf 'L\t%s\t' "$sid"; printf '%s\n' "$props" | b64; printf '\n'
  done
fi
for proc in /proc/[0-9]*/environ; do
  owner=$(stat -c %u -- "$proc" 2>/dev/null) || continue
  [ "$login_uid" = 0 ] || [ "$owner" = "$login_uid" ] || continue
  data=$(grep -z -E '^(DISPLAY|XAUTHORITY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|SWAYSOCK|HYPRLAND_INSTANCE_SIGNATURE|NIRI_SOCKET|YDOTOOL_SOCKET|XDG_SESSION_ID)=' "$proc" 2>/dev/null | b64)
  [ -n "$data" ] || continue
  printf 'P\t%s\t%s\n' "$owner" "$data"
done
sockets() {
  for path do
    [ -S "$path" ] || continue
    meta=$(stat -c '%u:%i' -- "$path" 2>/dev/null) || continue
    printf 'S\t%s\t' "$meta"; printf '%s' "$path" | b64; printf '\n'
  done
}
sockets /run/user/[0-9]*/wayland-* /run/user/[0-9]*/sway-ipc.*.sock /run/user/[0-9]*/niri.*.sock /run/user/[0-9]*/hypr/*/.socket.sock /tmp/.X11-unix/X*
if [ -n "$desktop_runtime" ]; then
  sockets "$desktop_runtime"/wayland-* "$desktop_runtime"/sway-ipc.*.sock "$desktop_runtime"/niri.*.sock "$desktop_runtime"/hypr/*/.socket.sock
fi
printf 'END\n'
`

export function desktopProbeScript(config: DesktopSessionConfig): string {
  return `desktop_user=${shq(config.user ?? '')}\ndesktop_runtime=${shq(config.env?.XDG_RUNTIME_DIR ?? '')}\n${DESKTOP_PROBE}`
}

function number(value: string): number {
  if (!/^\d{1,10}$/.test(value) || Number(value) > 0xffffffff) throw new Error('Invalid desktop probe UID/GID.')
  return Number(value)
}
function decode(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid desktop probe encoding.')
  return Buffer.from(value, 'base64').toString('utf8')
}
function envRecord(raw: string, separator: string): Record<string, string> {
  const env: Record<string, string> = Object.create(null)
  for (const part of raw.split(separator)) {
    const at = part.indexOf('=')
    if (at < 0) continue
    const key = part.slice(0, at), value = part.slice(at + 1)
    if (Object.hasOwn(env, key) && env[key] !== value) throw new Error('Conflicting desktop probe environment entries.')
    env[key] = value
  }
  return env
}

/** Parse only data from the probe; no remote environment or passwd entry becomes code. */
export function selectDesktopSession(raw: string, config: DesktopSessionConfig = {}): DesktopBackend {
  checkDesktopSession(config)
  const lines = raw.trimEnd().split('\n')
  if (lines.shift() !== 'DSH_DESKTOP_V2' || lines.pop() !== 'END') throw new Error('Invalid remote desktop session probe output.')
  let loginUid: number | undefined
  const users = new Map<string, DesktopUser>(), sockets = new Map<string, DesktopSocket>()
  const records: { uid: number, env: Record<string, string> }[] = []
  const logins: { id: string, uid: number, type: string, active: boolean, display: string }[] = []
  for (const line of lines) {
    const [tag, a, b, ...rest] = line.split('\t')
    if (rest.length) throw new Error('Invalid desktop probe record.')
    if (tag === 'I' && loginUid === undefined && b === undefined) loginUid = number(a)
    else if (tag === 'U' && b === undefined) {
      for (const row of decode(a).split('\n').filter(Boolean)) {
        const [name, uid, gid, home, ...extra] = row.split(':')
        if (extra.length || !USER.test(name) || !home?.startsWith('/') || /[\0\r\n]/.test(home)) throw new Error('Invalid graphical account in desktop probe.')
        users.set(name, { name, uid: number(uid), gid: number(gid), home })
      }
    } else if (tag === 'S') {
      const [uid, inode, ...extra] = a.split(':')
      const path = decode(b)
      if (extra.length || !/^\d{1,30}$/.test(inode) || !path.startsWith('/') || /[\0\r\n]/.test(path)) throw new Error('Invalid desktop socket record.')
      sockets.set(path, { path, uid: number(uid), inode })
    } else if (tag === 'P') {
      const env = envRecord(decode(b), '\0')
      const { XDG_SESSION_ID: sessionId, ...graphical } = env
      checkDesktopSession({ env: graphical })
      records.push({ uid: number(a), env: { ...graphical, ...(sessionId ? { XDG_SESSION_ID: sessionId } : {}) } })
    } else if (tag === 'L' && SESSION.test(a)) {
      const e = envRecord(decode(b), '\n')
      if (['x11', 'wayland'].includes(e.Type)) logins.push({ id: a, uid: number(e.User), type: e.Type, active: ['user', 'user-early'].includes(e.Class) && e.Active === 'yes' && e.State !== 'closing', display: e.Display ?? '' })
    } else throw new Error('Invalid desktop probe record.')
  }
  if (loginUid === undefined) throw new Error('Missing SSH login identity in desktop probe.')
  const configuredUser = config.user === undefined ? undefined : [...users.values()].find((u) => /^\d+$/.test(config.user!) ? u.uid === Number(config.user) : u.name === config.user)
  if (config.user !== undefined && !configuredUser) throw new Error(`Unknown desktop.user "${config.user}" on the remote host.`)
  if (loginUid !== 0 && configuredUser && configuredUser.uid !== loginUid) throw new Error('Non-root SSH logins cannot switch desktop user; use the login account or a separately configured SSH host.')
  if (loginUid === 0 && configuredUser?.uid === 0) throw new Error('Root SSH desktop control must drop to a non-root desktop.user.')
  const targetUid = configuredUser?.uid ?? (loginUid === 0 ? undefined : loginUid)
  // logind is authoritative for root when it knows graphical user sessions.
  // Ignore inactive sessions and greeters; without logind use live sockets/proc.
  const active = logins.filter((l) => l.active && l.uid !== 0 && (targetUid === undefined || l.uid === targetUid))
  if (loginUid === 0 && !configuredUser && active.length > 1) throw new Error('Multiple active graphical sessions; refusing to choose. Set hosts.<alias>.desktop.user to an account name/UID, and desktop.env if that account has several sessions.')
  const permitted = (uid: number) => (targetUid === undefined || targetUid === uid) && (loginUid !== 0 || uid !== 0) && (loginUid !== 0 || !logins.length || active.some((l) => l.uid === uid))
  const override = config.env ?? {}
  const sessionPath = (uid: number, env: Record<string, string>) => env.WAYLAND_DISPLAY ? (env.WAYLAND_DISPLAY.startsWith('/') ? env.WAYLAND_DISPLAY : `${env.XDG_RUNTIME_DIR || `/run/user/${uid}`}/${env.WAYLAND_DISPLAY}`) : /^:\d+(?:\.\d+)?$/.test(env.DISPLAY ?? '') ? `/tmp/.X11-unix/X${env.DISPLAY.slice(1).split('.')[0]}` : undefined
  const associations = new Map<string, { active: Set<string>, inactive: boolean }>()
  for (const r of records) {
    const path = sessionPath(r.uid, r.env)
    if (!path || !r.env.XDG_SESSION_ID) continue
    const key = `${r.uid}:${path}`, entry = associations.get(key) ?? { active: new Set<string>(), inactive: false }
    if (active.some((l) => l.id === r.env.XDG_SESSION_ID && l.uid === r.uid)) entry.active.add(r.env.XDG_SESSION_ID)
    else entry.inactive = true
    associations.set(key, entry)
  }
  for (const socket of sockets.values()) {
    const runtimeUid = /^\/run\/user\/(\d+)\//.exec(socket.path)?.[1]
    if (runtimeUid && Number(runtimeUid) !== socket.uid) continue
    if (/(?:^|\/)wayland-[^/]+$/.test(socket.path) && permitted(socket.uid)) records.push({ uid: socket.uid, env: { WAYLAND_DISPLAY: socket.path.slice(socket.path.lastIndexOf('/') + 1), XDG_RUNTIME_DIR: socket.path.slice(0, socket.path.lastIndexOf('/')) } })
  }
  for (const l of logins) if (permitted(l.uid) && (loginUid !== 0 || l.active) && l.type === 'x11' && l.display) records.push({ uid: l.uid, env: { DISPLAY: l.display, XDG_SESSION_ID: l.id } })
  if (targetUid !== undefined && Object.keys(override).length) records.push({ uid: targetUid, env: {} })
  type Candidate = { uid: number, type: string, env: Record<string, string>, socket: DesktopSocket, sessionIds: Set<string> }
  const groups = new Map<string, Candidate>()
  const selectors = ['WAYLAND_DISPLAY', 'DISPLAY', 'XDG_RUNTIME_DIR', 'SWAYSOCK', 'NIRI_SOCKET', 'HYPRLAND_INSTANCE_SIGNATURE']
  for (const record of records) {
    if (!permitted(record.uid)) continue
    const userLogins = active.filter((l) => l.uid === record.uid)
    if (loginUid === 0 && logins.length && record.env.XDG_SESSION_ID && !userLogins.some((l) => l.id === record.env.XDG_SESSION_ID)) continue
    if (selectors.some((k) => override[k as keyof typeof override] && record.env[k] && override[k as keyof typeof override] !== record.env[k])) continue
    const env: Record<string, string> = { ...record.env, ...override }
    delete env.XDG_SESSION_ID
    let type: string, path: string
    if (env.WAYLAND_DISPLAY) {
      type = 'wayland'
      env.XDG_RUNTIME_DIR ||= `/run/user/${record.uid}`
      path = env.WAYLAND_DISPLAY.startsWith('/') ? env.WAYLAND_DISPLAY : `${env.XDG_RUNTIME_DIR}/${env.WAYLAND_DISPLAY}`
    } else if (/^:\d+(?:\.\d+)?$/.test(env.DISPLAY ?? '')) {
      type = 'x11'; path = `/tmp/.X11-unix/X${env.DISPLAY.slice(1).split('.')[0]}`
    } else continue
    if (loginUid === 0 && logins.length && !userLogins.some((l) => l.type === type)) continue
    if (config.backend && (config.backend === 'x11') !== (type === 'x11')) continue
    const socket = sockets.get(path)
    if (!socket || (type === 'wayland' && socket.uid !== record.uid)) continue
    const association = associations.get(`${record.uid}:${path}`)
    if (loginUid === 0 && logins.length && association?.inactive && !association.active.size) continue
    const key = `${record.uid}:${type}:${path}`
    const group = groups.get(key) ?? { uid: record.uid, type, env: {}, socket, sessionIds: new Set<string>() }
    if (association) for (const id of association.active) group.sessionIds.add(id)
    for (const [k, v] of Object.entries(env)) {
      if (!v) continue
      if (group.env[k] && group.env[k] !== v && ['XAUTHORITY', 'SWAYSOCK', 'NIRI_SOCKET', 'HYPRLAND_INSTANCE_SIGNATURE'].includes(k)) throw new Error('Conflicting graphical session environments; set hosts.<alias>.desktop.user and desktop.env explicitly.')
      group.env[k] = v
    }
    groups.set(key, group)
  }
  for (const [key, group] of groups) if (group.type === 'x11' && config.backend !== 'x11' && [...groups.values()].some((g) => g.uid === group.uid && g.type === 'wayland' && g.env.DISPLAY?.split('.')[0] === group.env.DISPLAY?.split('.')[0])) groups.delete(key)
  if (groups.size !== 1) throw new Error(`${groups.size ? 'Multiple graphical sessions; refusing to choose.' : 'No active graphical session found.'} Set hosts.<alias>.desktop.user to an account name/UID${groups.size ? ' and desktop.env to select a display if that user has several sessions' : ', and desktop.env if automatic detection is incomplete'}.`)
  const group = [...groups.values()][0]
  const user = configuredUser ?? [...users.values()].find((u) => u.uid === group.uid)
  if (!user) throw new Error('No account entry for the graphical session UID; configure desktop.user and ensure passwd/getent resolves it.')
  const related = (loginUid === 0 ? active : logins).filter((l) => l.uid === group.uid && l.type === group.type && (!l.display || l.display.split('.')[0] === group.env.DISPLAY?.split('.')[0]) && (!group.sessionIds.size || group.sessionIds.has(l.id)))
  if (loginUid === 0 && related.length > 1) throw new Error('Multiple active graphical sessions for this desktop.user; select desktop.env.DISPLAY/WAYLAND_DISPLAY explicitly or close the extra session.')
  const env = group.env
  let kind: DesktopKind = 'x11'
  if (group.type === 'wayland') {
    const runtime = env.XDG_RUNTIME_DIR
    const owned = [...sockets.values()].filter((s) => s.uid === group.uid && s.path.startsWith(`${runtime}/`))
    const onlyDisplay = owned.filter((s) => /^wayland-[^/]+$/.test(s.path.slice(runtime.length + 1))).length === 1
    for (const [name, matches] of [
      ['NIRI_SOCKET', owned.filter((s) => s.path.startsWith(`${runtime}/niri.${env.WAYLAND_DISPLAY}.`) && s.path.endsWith('.sock'))],
      ['SWAYSOCK', onlyDisplay ? owned.filter((s) => /\/sway-ipc\.[^/]+\.sock$/.test(s.path)) : []],
      ['HYPRLAND_INSTANCE_SIGNATURE', onlyDisplay ? owned.filter((s) => /\/hypr\/[^/]+\/\.socket\.sock$/.test(s.path)) : []],
    ] as const) if (!env[name] && matches.length === 1) env[name] = name === 'HYPRLAND_INSTANCE_SIGNATURE' ? matches[0].path.split('/').at(-2)! : matches[0].path
    const detected = (['sway', 'hyprland', 'niri'] as const).filter((k) => env[{ sway: 'SWAYSOCK', hyprland: 'HYPRLAND_INSTANCE_SIGNATURE', niri: 'NIRI_SOCKET' }[k]])
    if (!config.backend && detected.length > 1) throw new Error('Multiple compositor IPC sockets; set hosts.<alias>.desktop.backend and desktop.env.')
    kind = config.backend ?? detected[0] ?? (['sway', 'hyprland', 'niri'] as const).find((k) => env.XDG_CURRENT_DESKTOP?.toLowerCase().includes(k)) ?? 'wayland'
  }
  env.XDG_SESSION_TYPE = group.type
  return { kind, env, loginUid, user, socket: group.socket, ...(related.length === 1 && related[0].active ? { sessionId: related[0].id } : {}) }
}
