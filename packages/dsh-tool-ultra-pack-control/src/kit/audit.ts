// An append-only record of what the control tools did, kept apart from the
// catalog's audit (whose entry kinds are fixed to loads and settings).
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface AuditLine {
  tool: string
  event?: 'approved' | 'denied' | 'result'
  /** Redacted, one short line. */
  summary: string
  ok: boolean
  ms: number
}

export type Audit = (line: AuditLine) => void

export function defaultAuditFile(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.config', 'deepseek-harness')
  return join(home, 'tool-manager', 'control-audit.jsonl')
}

/** Writes JSON lines to `file`; '' turns it off. Failures are reported once and never reach the tool. */
export function createAudit(file: string, warn: (message: string) => void = () => {}): Audit {
  if (!file) return () => {}
  let warned = false
  let ready: Promise<unknown> | undefined
  return (line) => {
    ready ??= mkdir(dirname(file), { recursive: true, mode: 0o700 })
    // Serialize appends so completion order cannot reorder audit records.
    ready = ready.then(() => appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, { mode: 0o600 })).catch((e: Error) => {
      if (!warned) warn(`tool-ultra-pack-control: cannot write audit log ${file}: ${e.message}`)
      warned = true
    })
  }
}
