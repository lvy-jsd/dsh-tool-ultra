// Running a program without a shell: argv in, bytes out, with a time and size limit.
import { spawn } from 'node:child_process'

export interface ExecOptions {
  stdin?: string | Buffer
  timeoutMs?: number
  /** Per stream; the rest is dropped and `truncated` is set. */
  maxBytes?: number
  /** Long-lived SSH forwarding: abort closes the process and its stdin. */
  signal?: AbortSignal
  keepStdinOpen?: boolean
  /** Exploratory probes: do not mark the call scope failed on a nonzero exit. */
  allowFailure?: boolean
  onStdout?: (chunk: Buffer) => void
}

export interface ExecResult {
  /** Exit code, or null when the program did not start or was killed. */
  code: number | null
  stdout: string
  stdoutBytes: Buffer
  stderr: string
  timedOut: boolean
  truncated: boolean
}

export type Exec = (argv: string[], options?: ExecOptions) => Promise<ExecResult>

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BYTES = 1_000_000

/** The real thing: `spawn` with an argument vector, never through a shell. */
export const localExec: Exec = (argv, { stdin, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, signal, keepStdinOpen, onStdout } = {}) => new Promise((resolve) => {
  const [cmd, ...args] = argv
  if (signal?.aborted) { resolve(result(null, [], [], false, false)); return }
  let timedOut = false
  let truncated = false
  const chunks: Record<'out' | 'err', Buffer[]> = { out: [], err: [] }
  const sizes = { out: 0, err: 0 }
  let child
  try {
    child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    resolve(result(null, [], [Buffer.from(`cannot start ${cmd}: ${(e as Error).message}`)], false, false))
    return
  }
  const collect = (which: 'out' | 'err') => (data: Buffer) => {
    const room = maxBytes - sizes[which]
    if (room <= 0) { truncated = true; return }
    chunks[which].push(data.length > room ? data.subarray(0, room) : data)
    sizes[which] += Math.min(room, data.length)
    if (data.length > room) truncated = true
  }
  child.stdout.on('data', collect('out'))
  if (onStdout) child.stdout.on('data', onStdout)
  child.stderr.on('data', collect('err'))
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
  const abort = () => { child.stdin.destroy(); child.kill('SIGKILL') }
  signal?.addEventListener('abort', abort, { once: true })
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  child.on('error', (e: NodeJS.ErrnoException) => {
    cleanup()
    const why = e.code === 'ENOENT' ? `${cmd}: command not found` : `cannot start ${cmd}: ${e.message}`
    resolve(result(null, chunks.out, [...chunks.err, Buffer.from(why)], timedOut, truncated))
  })
  child.on('close', (code) => {
    cleanup()
    resolve(result(code, chunks.out, chunks.err, timedOut, truncated))
  })
  child.stdin.on('error', () => {})
  if (keepStdinOpen) { if (stdin !== undefined) child.stdin.write(stdin) }
  else child.stdin.end(stdin)
})

function result(code: number | null, out: Buffer[], err: Buffer[], timedOut: boolean, truncated: boolean): ExecResult {
  const stdoutBytes = Buffer.concat(out)
  return { code, stdout: stdoutBytes.toString('utf8'), stdoutBytes, stderr: Buffer.concat(err).toString('utf8'), timedOut, truncated }
}
