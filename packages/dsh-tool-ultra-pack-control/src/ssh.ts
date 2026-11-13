// SSH tools. Two packs over one transport:
//
//   ssh        read-only: ssh_hosts, ssh_sys, ssh_read, ssh_log
//   ssh-exec   changes things: ssh_run, ssh_write, ssh_get, ssh_put
//
// Hosts are aliases from the config, never free-form: a model names `nix`, the
// config says it is root@host.example port 22. The ssh client runs with an argument
// vector (no local shell), no password prompt and, where the platform allows it,
// one multiplexed connection per host.
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { localExec, type Exec, type ExecResult } from './kit/exec.js'
import { DEFAULT_DENY_PATHS, capText, intArg, isDeniedPath, isReadOnlyCommand, redact, shq } from './kit/policy.js'
import type { ToolSpec } from './kit/spec.js'

export const SSH_TOOL_NAMES = ['ssh_hosts', 'ssh_sys', 'ssh_read', 'ssh_log'] as const
export const SSH_EXEC_TOOL_NAMES = ['ssh_run', 'ssh_write', 'ssh_get', 'ssh_put'] as const

export interface HostConfig {
  /** `user@host` or a Host alias from ~/.ssh/config. */
  target: string
  port?: number
  /** Private key file; only this key is offered. */
  identity?: string
  /** Graphical session selection/overrides for the remote desktop pack. */
  desktop?: import('./desktop-session.js').DesktopSessionConfig
  /** Remote loopback CDP port (default 9222). Browser is never started automatically. */
  browser?: { port?: number }
}

export interface SshConfig {
  hosts?: Record<string, HostConfig>
  /** The ssh client to run (default `ssh`). */
  sshBin?: string
  /** Reuse one connection per host for a minute (default true, off on Windows). */
  multiplex?: boolean
  connectTimeoutS?: number
  timeoutMs?: number
  maxBytes?: number
  maxChars?: number
  /** Where ssh_get saves and ssh_put reads: only file names, never paths, come from the model. */
  transferDir?: string
  maxTransferBytes?: number
  /** Extra remote path patterns (regular expressions) the read tools refuse. */
  denyPaths?: string[]
}

export interface SshOptions extends SshConfig {
  exec?: Exec
}

/** Shared SSH transport: the same alias table, connection flags and limits for all packs. */
export function createSshTransport(options: SshOptions = {}) {
  const exec = options.exec ?? localExec
  const hosts = options.hosts ?? {}
  for (const [alias, host] of Object.entries(hosts)) checkHost(alias, host)
  const controlDir = join(tmpdir(), `dsh-control-ssh-${process.getuid?.() ?? 'u'}`)
  const argvOptions = { sshBin: options.sshBin, multiplex: options.multiplex ?? process.platform !== 'win32', connectTimeoutS: options.connectTimeoutS, controlDir }
  let controlReady: Promise<unknown> | undefined
  function hostOf(alias: unknown): HostConfig {
    const names = Object.keys(hosts)
    if (!names.length) throw new Error('No ssh hosts are configured. Add them under hosts in the tool-ultra-pack-control config.')
    if (typeof alias !== 'string' || !Object.hasOwn(hosts, alias)) throw new Error(`Unknown host "${String(alias)}". Configured: ${names.join(', ')}.`)
    return hosts[alias]
  }
  async function remote(alias: unknown, script: string, { stdin, timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs, bytes = options.maxBytes ?? DEFAULTS.maxBytes }: { stdin?: string | Buffer, timeoutMs?: number, bytes?: number } = {}) {
    const host = hostOf(alias)
    if (argvOptions.multiplex) await (controlReady ??= mkdir(controlDir, { recursive: true, mode: 0o700 }).catch(() => {}))
    const started = Date.now()
    const result = await exec(sshArgv(host, remoteSh(script), argvOptions), { stdin, timeoutMs, maxBytes: bytes })
    return { result, ms: Date.now() - started }
  }
  /** A foreground, non-multiplexed forward owned by this call; never leaves a master forward behind. */
  async function withForward<T>(alias: unknown, remotePort: number, use: (port: number) => Promise<T>): Promise<T> {
    const host = hostOf(alias)
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('Bad remote forwarding port.')
    for (let attempt = 0; ; attempt++) {
      // Let the OS choose a free loopback port. SSH owns the subsequent bind;
      // ExitOnForwardFailure plus retry handles the small reservation/bind race.
      const reservation = createServer()
      await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
      const port = (reservation.address() as import('node:net').AddressInfo).port
      await new Promise<void>((resolve, reject) => reservation.close((e) => e ? reject(e) : resolve()))
      const controller = new AbortController()
      const marker = `DSH_FORWARD_${randomUUID()}`
      let output = ''
      let ready!: () => void
      let failed!: (e: Error) => void
      const readiness = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
      const argv = sshArgv(host, remoteSh(`printf '%s\\n' ${shq(marker)}; cat >/dev/null`), { ...argvOptions, multiplex: false })
      argv.splice(argv.indexOf('--'), 0, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForkAfterAuthentication=no', '-o', 'StdinNull=no', '-o', 'SessionType=default', '-o', 'GatewayPorts=no', '-o', 'PermitLocalCommand=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`)
      const lifetime = options.timeoutMs ?? DEFAULTS.timeoutMs
      const timer = setTimeout(() => { failed(new Error('SSH browser tunnel timed out.')); controller.abort() }, lifetime)
      const running = Promise.resolve().then(() => exec(argv, {
        timeoutMs: lifetime, maxBytes: 16_000, signal: controller.signal, keepStdinOpen: true,
        onStdout: (chunk) => { output = (output + chunk.toString()).slice(-512); if (output.includes(marker + '\n')) ready() },
      })).then((r) => { failed(new Error(`SSH browser tunnel closed: ${redact(r.stderr).slice(0, 1000) || (r.timedOut ? 'timed out' : `exit ${r.code}`)}`)); return r }, (e) => { failed(e); return undefined })
      let established = false
      try {
        await readiness
        established = true
        return await use(port)
      } catch (e) {
        if (established || attempt >= 2 || !/address already in use|cannot listen/i.test(String(e))) throw e
      } finally {
        clearTimeout(timer)
        controller.abort()
        await running
      }
    }
  }
  return { hostOf, remote, withForward }
}

const DEFAULTS = {
  connectTimeoutS: 10,
  timeoutMs: 60_000,
  maxBytes: 2_000_000,
  maxChars: 20_000,
  maxTransferBytes: 50_000_000,
}

/** Throws on a host entry that could be read as an ssh option or is otherwise unusable. */
export function checkHost(alias: string, host: HostConfig): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(alias)) throw new Error(`Bad host alias "${alias}": use letters, digits, . _ -`)
  if (typeof host?.target !== 'string' || !host.target.trim()) throw new Error(`Host "${alias}" needs a target (user@host).`)
  if (host.target.startsWith('-') || /\s/.test(host.target)) throw new Error(`Host "${alias}": target "${host.target}" is not a valid ssh destination.`)
  if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) throw new Error(`Host "${alias}": bad port ${host.port}.`)
}

/** The ssh argument vector for a remote command on a configured host. Pure. */
export function sshArgv(host: HostConfig, remote: string, { sshBin = 'ssh', multiplex = true, connectTimeoutS = DEFAULTS.connectTimeoutS, controlDir = join(tmpdir(), 'dsh-control-ssh') } = {}): string[] {
  const argv = [sshBin, '-T', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeoutS}`]
  if (multiplex) argv.push('-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${controlDir}/%C`)
  if (host.port) argv.push('-p', String(host.port))
  if (host.identity) argv.push('-i', host.identity, '-o', 'IdentitiesOnly=yes')
  argv.push('--', host.target, remote)
  return argv
}

/** `sh -c '<script>'`, so the remote login shell (bash, fish, ...) never parses the script. */
const remoteSh = (script: string): string => `sh -c ${shq(script)}`

function describeResult(r: ExecResult, ms: number, maxChars: number, timeoutS?: number): string {
  const status = r.timedOut ? `timed out${timeoutS ? ` after ${timeoutS}s` : ''}` : r.code === null ? 'did not run' : `exit ${r.code}`
  const out = redact(r.stdout).trimEnd()
  const err = redact(r.stderr).trimEnd()
  const parts = [`${status} (${ms} ms)${r.truncated ? ' [output cut at the byte limit]' : ''}`]
  if (out) parts.push('--- stdout', capText(out, maxChars))
  if (err) parts.push('--- stderr', capText(err, Math.max(1000, Math.floor(maxChars / 4))))
  return parts.join('\n')
}

export function createSshTools(options: SshOptions = {}): ToolSpec[] {
  const { remote } = createSshTransport(options)
  const hosts = options.hosts ?? {}
  const maxChars = options.maxChars ?? DEFAULTS.maxChars
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const maxTransfer = options.maxTransferBytes ?? DEFAULTS.maxTransferBytes
  const transferDir = options.transferDir ?? join(homedir(), 'dsh-transfers')
  const deny = [...DEFAULT_DENY_PATHS, ...(options.denyPaths ?? [])].map((p) => new RegExp(p))

  const checkPath = (value: unknown, label = 'path'): string => {
    const path = String(value ?? '')
    if (!path || path.includes('\0') || path.includes('\n')) throw new Error(`Give a ${label}.`)
    // The remote working directory is unknown, so only absolute paths mean something.
    if (!path.startsWith('/')) throw new Error(`The ${label} must be absolute (start with /), not "${path}".`)
    if (isDeniedPath(path, deny)) throw new Error(`Refusing ${path}: it holds credentials or process secrets.`)
    return path
  }
  const checkFileName = (value: unknown): string => {
    const name = String(value ?? '')
    if (!/^[\w][\w.-]{0,100}$/.test(name) || name !== basename(name)) throw new Error(`Bad file name "${name}": give a plain name such as backup.tar, not a path.`)
    return name
  }

  const hostParam = { type: 'string', required: true, description: 'Host alias from ssh_hosts.' } as const

  const ssh: ToolSpec[] = [
    {
      name: 'ssh_hosts',
      pack: 'ssh',
      risk: 'low',
      description: 'List the SSH hosts you can use (alias, target). Set check to test that each one answers.',
      parameters: { check: { type: 'boolean', description: 'Try to log in to each host.' } },
      describe: (a) => `list${a?.check ? ' (check)' : ''}`,
      async execute(args) {
        const names = Object.keys(hosts)
        if (!names.length) return 'No ssh hosts are configured.'
        const lines: string[] = []
        for (const alias of names) {
          const h = hosts[alias]
          let state = ''
          if (args?.check) {
            const { result } = await remote(alias, 'true', { timeoutMs: 15_000, bytes: 10_000 })
            state = result.code === 0 ? ' - reachable' : ` - unreachable: ${redact(result.stderr).trim().split('\n').pop() || (result.timedOut ? 'timed out' : 'failed')}`
          }
          lines.push(`${alias}: ${h.target}${h.port ? ` port ${h.port}` : ''}${state}`)
        }
        return lines.join('\n')
      },
    },
    {
      name: 'ssh_sys',
      pack: 'ssh',
      risk: 'low',
      description: 'Overview of a remote Linux host: kernel, uptime, memory, disk, failed services.',
      parameters: { host: hostParam },
      describe: (a) => `${a?.host}: system overview`,
      async execute(args) {
        const script = 'echo "## kernel"; uname -srm; echo "## uptime"; uptime; echo "## memory"; free -h; echo "## disk"; df -h /; echo "## failed services"; systemctl --failed --no-legend --no-pager 2>/dev/null | head -20; echo "## os"; (nixos-version 2>/dev/null || head -n 2 /etc/os-release 2>/dev/null || true)'
        const { result, ms } = await remote(args?.host, script, { timeoutMs: 30_000 })
        return describeResult(result, ms, maxChars)
      },
    },
    {
      name: 'ssh_read',
      pack: 'ssh',
      risk: 'low',
      description: 'Read a remote file (text), or list a directory. Use offset and max_bytes for big files.',
      parameters: {
        host: hostParam,
        path: { type: 'string', required: true, description: 'Absolute path on the host.' },
        max_bytes: { type: 'integer', description: 'Bytes to read, 1-200000. Default 20000.' },
        offset: { type: 'integer', description: 'Bytes to skip first.' },
      },
      describe: (a) => `${a?.host}: read ${a?.path}`,
      async execute(args) {
        const path = checkPath(args?.path)
        const n = intArg(args?.max_bytes, 20_000, 1, 200_000)
        const skip = intArg(args?.offset, 0, 0, 2 ** 40)
        const script = `p=${shq(path)}; if [ -d "$p" ]; then ls -la -- "$p"; else tail -c +${skip + 1} -- "$p" | head -c ${n}; fi`
        const { result, ms } = await remote(args?.host, script, { bytes: n + 100_000 })
        if (result.code !== 0) return describeResult(result, ms, maxChars)
        return capText(redact(result.stdout), Math.max(maxChars, n))
      },
    },
    {
      name: 'ssh_log',
      pack: 'ssh',
      risk: 'low',
      description: 'Recent log lines from a remote host: a systemd unit, a log file, or the whole journal.',
      parameters: {
        host: hostParam,
        unit: { type: 'string', description: 'systemd unit, such as sshd.service.' },
        path: { type: 'string', description: 'Absolute path of a log file, instead of the journal.' },
        lines: { type: 'integer', description: 'How many lines, 1-500. Default 50.' },
        since: { type: 'string', description: 'Journal only: "10 min ago", "today", "2026-11-01 08:00".' },
      },
      describe: (a) => `${a?.host}: log ${a?.path ?? a?.unit ?? 'journal'}`,
      async execute(args) {
        const n = intArg(args?.lines, 50, 1, 500)
        let script: string
        if (args?.path) script = `tail -n ${n} -- ${shq(checkPath(args.path))}`
        else {
          const unit = args?.unit === undefined ? '' : String(args.unit)
          if (unit && !/^[\w@.:-]{1,120}$/.test(unit)) throw new Error(`Bad unit name "${unit}".`)
          const since = args?.since === undefined ? '' : String(args.since)
          if (since && !/^[\w :.+-]{1,60}$/.test(since)) throw new Error(`Bad since "${since}".`)
          script = `journalctl --no-pager -n ${n}${unit ? ` -u ${shq(unit)}` : ''}${since ? ` --since ${shq(since)}` : ''}`
        }
        const { result, ms } = await remote(args?.host, script, { timeoutMs: 30_000 })
        return describeResult(result, ms, maxChars)
      },
    },
  ]

  const exec_: ToolSpec[] = [
    {
      name: 'ssh_run',
      pack: 'ssh-exec',
      risk: 'high',
      description: 'Run a shell command on a remote host (as the configured user, often root). Returns exit code, stdout and stderr. Commands that only read run at once; the rest ask the user first.',
      parameters: {
        host: hostParam,
        cmd: { type: 'string', required: true, description: 'Command line for sh.' },
        cwd: { type: 'string', description: 'Directory to run in.' },
        timeout_s: { type: 'integer', description: 'Seconds before it is killed, 1-600. Default 60.' },
      },
      approve(args) {
        const cmd = String(args?.cmd ?? '')
        if (!args?.cwd && isReadOnlyCommand(cmd, deny)) return undefined
        return `${args?.host}: ${capText(redact(cmd), 300)}${args?.cwd ? ` (in ${args.cwd})` : ''}`
      },
      describe: (a) => `${a?.host}: ${capText(redact(String(a?.cmd ?? '')), 200)}`,
      async execute(args) {
        const cmd = String(args?.cmd ?? '')
        if (!cmd.trim()) throw new Error('Give a command.')
        const seconds = intArg(args?.timeout_s, Math.round(defaultTimeoutMs / 1000), 1, 600)
        const script = args?.cwd ? `cd ${shq(String(args.cwd))} && { ${cmd}\n}` : cmd
        const { result, ms } = await remote(args?.host, script, { timeoutMs: seconds * 1000 })
        return describeResult(result, ms, maxChars, seconds)
      },
    },
    {
      name: 'ssh_write',
      pack: 'ssh-exec',
      risk: 'high',
      description: 'Write text to a file on a remote host (replaces it, or appends). Always asks the user first.',
      parameters: {
        host: hostParam,
        path: { type: 'string', required: true, description: 'Absolute path on the host.' },
        content: { type: 'string', required: true, description: 'Text to write.' },
        append: { type: 'boolean', description: 'Add to the end instead of replacing.' },
      },
      approve: (a) => `${a?.host}: ${a?.append ? 'append' : 'write'} ${Buffer.byteLength(String(a?.content ?? ''))} bytes to ${a?.path}`,
      describe: (a) => `${a?.host}: ${a?.append ? 'append' : 'write'} ${Buffer.byteLength(String(a?.content ?? ''))} bytes to ${a?.path}`,
      async execute(args) {
        const path = checkPath(args?.path)
        const content = String(args?.content ?? '')
        const { result, ms } = await remote(args?.host, `cat ${args?.append ? '>>' : '>'} ${shq(path)}`, { stdin: content, bytes: 100_000 })
        return result.code === 0 ? `wrote ${Buffer.byteLength(content)} bytes to ${path} (${ms} ms)` : describeResult(result, ms, maxChars)
      },
    },
    {
      name: 'ssh_get',
      pack: 'ssh-exec',
      risk: 'medium',
      description: 'Download a remote file into the transfer folder under the name you give. Never overwrites.',
      parameters: {
        host: hostParam,
        remote: { type: 'string', required: true, description: 'Absolute path on the host.' },
        name: { type: 'string', required: true, description: 'File name to save as (no folders).' },
      },
      describe: (a) => `${a?.host}: get ${a?.remote} as ${a?.name}`,
      async execute(args) {
        const path = checkPath(args?.remote, 'remote path')
        const name = checkFileName(args?.name)
        const { result, ms } = await remote(args?.host, `cat -- ${shq(path)}`, { timeoutMs: 300_000, bytes: maxTransfer + 1 })
        if (result.code !== 0) return describeResult(result, ms, maxChars)
        if (result.stdoutBytes.length > maxTransfer) throw new Error(`${path} is larger than ${maxTransfer} bytes; nothing was saved.`)
        await mkdir(transferDir, { recursive: true })
        const target = join(transferDir, name)
        const file = await open(target, 'wx').catch((e: NodeJS.ErrnoException) => {
          throw new Error(e.code === 'EEXIST' ? `${target} already exists; pick another name.` : e.message)
        })
        try { await file.writeFile(result.stdoutBytes) } finally { await file.close() }
        return `saved ${result.stdoutBytes.length} bytes to ${target} (${ms} ms)`
      },
    },
    {
      name: 'ssh_put',
      pack: 'ssh-exec',
      risk: 'high',
      description: 'Upload a file from the transfer folder to a remote host. Always asks the user first.',
      parameters: {
        host: hostParam,
        name: { type: 'string', required: true, description: 'File name in the transfer folder (no folders).' },
        remote: { type: 'string', required: true, description: 'Absolute destination path on the host.' },
      },
      approve: (a) => `${a?.host}: upload ${a?.name} to ${a?.remote}`,
      describe: (a) => `${a?.host}: put ${a?.name} to ${a?.remote}`,
      async execute(args) {
        const name = checkFileName(args?.name)
        const path = checkPath(args?.remote, 'remote path')
        const source = join(transferDir, name)
        const size = (await stat(source).catch(() => undefined))?.size
        if (size === undefined) throw new Error(`${source} does not exist.`)
        if (size > maxTransfer) throw new Error(`${name} is larger than ${maxTransfer} bytes.`)
        const { result, ms } = await remote(args?.host, `cat > ${shq(path)}`, { stdin: await readFile(source), timeoutMs: 300_000, bytes: 100_000 })
        return result.code === 0 ? `uploaded ${size} bytes to ${path} (${ms} ms)` : describeResult(result, ms, maxChars)
      },
    },
  ]

  return [...ssh, ...exec_]
}
