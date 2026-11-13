import { AsyncLocalStorage } from 'node:async_hooks'
import type { Exec } from './exec.js'

export interface CallScope { session: string, failed: boolean }
const calls = new AsyncLocalStorage<CallScope>()
export const inCall = <T>(scope: CallScope, run: () => T): T => calls.run(scope, run)
export function markFailed(): void { const scope = calls.getStore(); if (scope) scope.failed = true }
export const sessionKey = (target: string): string => JSON.stringify([calls.getStore()?.session ?? '', target])
/** Keep transport failures out of successful adapter results, even for text-returning tools. */
export function observedExec(exec: Exec): Exec {
  return async (argv, options) => {
    const result = await exec(argv, options)
    const scope = calls.getStore()
    // An owned tunnel is intentionally killed after its callback finishes.
    if (scope && !options?.keepStdinOpen && (result.code !== 0 || result.timedOut)) scope.failed = true
    return result
  }
}
