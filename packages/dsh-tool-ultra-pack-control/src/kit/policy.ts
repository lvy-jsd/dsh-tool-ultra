// Small pure helpers shared by the control tools: shell quoting for the remote
// side, secret redaction, output capping and the read-only command check.

/** Single-quote a string for a POSIX shell. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g

/** Hide private keys and `name=value` secrets in text that may reach a model or a log. */
export function redact(text: string): string {
  return text.replace(PEM_BLOCK, '[private key removed]').replace(SECRET_ASSIGNMENT, '$1$2***')
}

/** Keep the start and the end of long output, with a note about the middle. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(text.length - tail)}`
}

/** An integer argument clamped to [min, max]; `fallback` when it is missing or not a number. */
export function intArg(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && value !== undefined && value !== null && value !== '' ? Math.min(max, Math.max(min, n)) : fallback
}

// --- read-only commands ------------------------------------------------------------------
//
// A command that may run without asking must be plainly harmless: only characters
// that cannot start a second command, a redirect, a substitution or a glob, a first
// word from a short list, and no option that makes the program write. Anything else
// is "not known to be read-only", which is not the same as "dangerous".

const SAFE_CHARS = /^[A-Za-z0-9 _./:=@%+,-]+$/
const SYSTEMCTL_READ = new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat', 'list-units', 'list-unit-files', 'list-timers'])
// Only exact, known flags. Never infer option arity from the next non-option:
// systemctl -p status stop actually executes stop, not status.
const SIMPLE_FLAGS: Record<string, string[]> = {
  ls: ['-l', '-a', '-la', '-al', '-h', '-lh', '-lah', '--all', '--long'],
  cat: ['-n', '-b', '-s', '-v', '-A'], head: [], tail: [], pwd: ['-L', '-P'],
  uname: ['-a', '-s', '-r', '-m', '-srm'], uptime: ['-p', '-s'], whoami: [], id: ['-u', '-g', '-G', '-n'],
  df: ['-h', '-T', '-i'], free: ['-h', '-m', '-g', '-b'], du: ['-h', '-s', '-sh'],
  lsblk: ['-f', '-a'], lsusb: [], lspci: [], 'nixos-version': [], stat: [], wc: ['-l', '-c', '-w', '-m'],
  which: ['-a'], file: ['-b', '-i'], nproc: ['--all'],
}
const DATE_ARGS = new Set(['-u', '--utc', '-R', '--rfc-email'])

/** Only a deliberately small grammar may bypass approval. Unknown flags ask. */
export function isReadOnlyCommand(cmd: string, deny: readonly RegExp[] = []): boolean {
  const text = cmd.trim()
  if (!text || text.length > 300 || !SAFE_CHARS.test(text)) return false
  const [first, ...rest] = text.split(/ +/)
  // Reject option=value altogether, including paths hidden behind option names.
  if (rest.some((w) => w.includes('=') || w.split('/').includes('..') || (w.includes('/') && isDeniedPath(w, deny)))) return false
  if (Object.hasOwn(SIMPLE_FLAGS, first)) {
    const flags = SIMPLE_FLAGS[first]
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]
      if (!w.startsWith('-')) continue
      if ((first === 'head' || first === 'tail') && ['-n', '-c'].includes(w) && /^\d{1,8}$/.test(rest[i + 1] ?? '')) { i++; continue }
      if (!flags.includes(w)) return false
    }
    return true
  }
  if (first === 'hostname') return rest.length === 0
  if (first === 'date') return rest.every((w) => w.startsWith('+') || DATE_ARGS.has(w))
  if (first === 'systemctl') {
    if (rest.some((w) => w.startsWith('-') && !['--no-pager', '--failed', '--all', '-a', '--user', '--system', '-l', '--full'].includes(w))) return false
    return SYSTEMCTL_READ.has(rest.find((w) => !w.startsWith('-')) ?? '')
  }
  if (first === 'journalctl') {
    const values = ['-u', '--unit', '-n', '--lines', '-p', '--priority', '-o', '--output', '--since', '--until']
    const flags = ['-b', '--boot', '-r', '--reverse', '-k', '--dmesg', '-e', '--no-pager', '--system', '--user', '-x']
    for (let i = 0; i < rest.length; i++) {
      if (values.includes(rest[i])) { if (!rest[i + 1] || rest[++i].startsWith('-')) return false }
      else if (!flags.includes(rest[i])) return false
    }
    return true
  }
  return false
}

// --- paths ---------------------------------------------------------------------------------

/** Remote files a read tool refuses by default: credentials and process secrets. Not a security boundary (symlinks get around it); a guard against asking a model to read them by accident. */
export const DEFAULT_DENY_PATHS: readonly string[] = [
  '^/etc/g?shadow-?$',
  '(^|/)\\.ssh/(id_[^/]*|authorized_keys)$',
  '^/etc/ssh/ssh_host_[^/]*_key$',
  '^/proc/[^/]+/(?:task/[^/]+/)?environ$',
]

/** Collapse `.` and `..` segments of an absolute or relative POSIX path. */
export function normalizePosix(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
    } else out.push(part)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/**
 * Does the path match one of the deny patterns? The path is made absolute and
 * normalized first (a relative path is taken from `/`, since the remote working
 * directory is not known here), so `..`, `.` and doubled slashes cannot hide it.
 */
export function isDeniedPath(path: string, deny: readonly RegExp[]): boolean {
  const normal = normalizePosix(path.startsWith('/') ? path : `/${path}`)
  return deny.some((re) => re.test(normal))
}
