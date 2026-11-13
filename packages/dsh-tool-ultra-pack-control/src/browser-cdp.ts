import { unixDiscovery, UnixCdpSocket } from './kit/unix-cdp.js'
// Bounded CDP client over an owned SSH forward. Never trusts an advertised host.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CdpValue = Record<string, any>
export class Cdp {
  private next = 0
  private pending = new Map<number, { resolve: (v: CdpValue) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  private failure?: Error
  private constructor(private ws: EventTarget & { send(text: string): void, close(): void }, private timeout: number, private maxBytes: number) {
    ws.addEventListener('message', (event) => {
      const data = (event as MessageEvent).data
      if (typeof data !== 'string' || Buffer.byteLength(data) > maxBytes) { this.stop(new Error('CDP reply exceeded the byte limit or was not text.')); return }
      try {
        const message = JSON.parse(data)
        const p = this.pending.get(message.id)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(message.id)
        if (message.error) p.reject(new Error(`CDP error: ${JSON.stringify(message.error).slice(0, 1000)}`))
        else p.resolve(message.result ?? {})
      } catch { this.stop(new Error('Malformed CDP JSON.')) }
    })
    ws.addEventListener('close', () => this.stop(new Error('CDP connection closed.')))
    ws.addEventListener('error', (event) => { const why = String((event as Event & { message?: string }).message ?? '').trim(); this.stop(new Error(why ? `CDP connection failed: ${why}` : 'CDP connection failed.')) })
  }
  static async connect(port: number | string, remotePort: number, timeout: number, maxBytes: number): Promise<Cdp> {
    if (typeof globalThis.WebSocket !== 'function') throw new Error('Browser control needs Node >=22 with built-in WebSocket.')
    let body: string
    if (typeof port === 'string') body = await unixDiscovery(port, timeout)
    else {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(timeout) })
      if (!res.ok || !res.body) throw new Error('CDP /json/version is unavailable.')
      const reader = res.body.getReader()
      body = ''
      let bytes = 0
      try {
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
          if (bytes > 64_000) throw new Error('CDP discovery exceeded the byte limit.')
          body += decoder.decode(value, { stream: true })
        }
        body += decoder.decode()
      } finally { await reader.cancel().catch(() => {}) }
    }
    const advertised = new URL(JSON.parse(body).webSocketDebuggerUrl)
    if (advertised.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(advertised.hostname)
      || Number(advertised.port) !== remotePort || advertised.username || advertised.password || advertised.search || advertised.hash
      || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(advertised.pathname)) throw new Error('Unsafe CDP discovery endpoint; expected remote loopback browser WebSocket.')
    if (typeof port === 'string') return new Cdp(await UnixCdpSocket.connect(port, advertised.pathname, timeout, maxBytes), timeout, maxBytes)
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${port}${advertised.pathname}`)
    const client = new Cdp(ws, timeout, maxBytes)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP WebSocket handshake timed out.')), timeout)
        ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket handshake failed.')) }, { once: true })
        ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('CDP WebSocket closed during handshake.')) }, { once: true })
      })
      return client
    } catch (e) { client.close(); throw e }
  }
  send(method: string, params: CdpValue = {}, sessionId?: string): Promise<CdpValue> {
    if (this.failure) return Promise.reject(this.failure)
    const message = JSON.stringify({ id: ++this.next, method, params, ...(sessionId ? { sessionId } : {}) })
    if (Buffer.byteLength(message) > this.maxBytes) return Promise.reject(new Error('CDP request exceeded the byte limit.'))
    return new Promise((resolve, reject) => {
      const id = this.next
      const timer = setTimeout(() => this.stop(new Error(`CDP ${method} timed out; action was not replayed.`)), this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.ws.send(message) } catch { this.stop(new Error('CDP send failed.')) }
    })
  }
  private stop(error: Error) {
    if (this.failure) return
    this.failure = error
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear()
    this.ws.close()
  }
  close() { this.stop(new Error('CDP call complete.')) }
}
