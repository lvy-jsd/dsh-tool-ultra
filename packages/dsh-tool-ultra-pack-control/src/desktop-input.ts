import { shq } from './kit/policy.js'
import type { DesktopBackend } from './desktop-session.js'

/** Runs as the selected graphical account, after env overrides. Never starts a daemon. */
export function ydotoolSocket(b: DesktopBackend): string {
  const runtime = b.env.XDG_RUNTIME_DIR || `/run/user/${b.user.uid}`
  const candidates = ['/run/ydotoold/socket', `${runtime}/ydotoold/socket`, `${runtime}/ydotool.sock`, `${runtime}/.ydotool_socket`, '/tmp/.ydotool_socket']
  return `if [ -z "\${YDOTOOL_SOCKET:-}" ]; then
  for candidate in ${candidates.map(shq).join(' ')}; do
    if [ -S "$candidate" ] && [ -w "$candidate" ]; then export YDOTOOL_SOCKET="$candidate"; break; fi
  done
fi
if [ -z "\${YDOTOOL_SOCKET:-}" ] || [ ! -S "$YDOTOOL_SOCKET" ] || [ ! -w "$YDOTOOL_SOCKET" ]; then
  printf '%s\\n' 'No accessible ydotoold socket. Enable programs.ydotool on NixOS, grant the graphical user ydotool group access and re-login, or set hosts.<alias>.desktop.env.YDOTOOL_SOCKET (e.g. /run/ydotoold/socket). No daemon was started.' >&2
  exit 69
fi`
}

// Linux evdev codes, deliberately independent of X11/XKB names. The compositor
// still applies its active keyboard layout to these physical keys.
const codes: Record<string, number> = {
  ...Object.fromEntries('1234567890'.split('').map((k, i) => [k, i + 2])),
  ...Object.fromEntries('qwertyuiop'.split('').map((k, i) => [k, i + 16])),
  ...Object.fromEntries('asdfghjkl'.split('').map((k, i) => [k, i + 30])),
  ...Object.fromEntries('zxcvbnm'.split('').map((k, i) => [k, i + 44])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`F${i + 1}`, i + 59])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 13}`, i + 183])),
  F11: 87, F12: 88, Return: 28, Escape: 1, Tab: 15, space: 57,
  BackSpace: 14, Delete: 111, Insert: 110, Home: 102, End: 107,
  Prior: 104, Next: 109, Left: 105, Right: 106, Up: 103, Down: 108,
  minus: 12, plus: 13,
}
export function ydotoolKeys(modifiers: string[], key: string): string[] {
  const mods: Record<string, number> = { ctrl: 29, alt: 56, shift: 42, logo: 125 }
  const held = [...modifiers]
  if ((/^[A-Z]$/.test(key) || key === 'plus') && !held.includes('shift')) held.push('shift')
  const code = codes[key.length === 1 ? key.toLowerCase() : key]
  if (code === undefined) throw new Error('Unsupported ydotool key.')
  return [...held.map((m) => `${mods[m]}:1`), `${code}:1`, `${code}:0`, ...held.reverse().map((m) => `${mods[m]}:0`)]
}
