// CDP's HTTP/WebSocket transport over an owner-only OpenSSH Unix socket.
// No local TCP debugging endpoint is exposed to other login users.
import { request } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'

export async function unixDiscovery(socketPath: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/json/version', headers: { Host: '127.0.0.1' } })
    const timer = setTimeout(() => req.destroy(new Error('CDP discovery timed out.')), timeout)
    req.on('error', reject)
    req.on('close', () => clearTimeout(timer))
    req.on('response', (res) => {
      if (res.statusCode !== 200) { res.destroy(); reject(new Error('CDP discovery failed.')); return }
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (data: Buffer) => {
        bytes += data.length
        if (bytes > 64_000) req.destroy(new Error('CDP discovery exceeded the byte limit.'))
        else chunks.push(data)
      })
      res.on('error', reject)
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.end()
  })
}

/** A bounded RFC6455 text client for a local Unix stream, including fragmentation and ping. */
export class UnixCdpSocket extends EventTarget {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private size = 0
  private closed = false
  private constructor(private socket: Duplex, private maxBytes: number) {
    super()
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('error', () => this.fail('CDP Unix stream failed.'))
    socket.on('close', () => { this.closed = true; this.dispatchEvent(new Event('close')) })
  }
  static connect(socketPath: string, path: string, timeout: number, maxBytes: number): Promise<UnixCdpSocket> {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64')
      const req = request({ socketPath, path, headers: { Host: '127.0.0.1', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } })
      const timer = setTimeout(() => req.destroy(new Error('CDP Unix WebSocket handshake timed out.')), timeout)
      req.on('error', reject)
      req.on('close', () => clearTimeout(timer))
      req.on('response', (res) => { res.destroy(); reject(new Error('CDP Unix WebSocket upgrade refused.')) })
      req.on('upgrade', (res, socket, head) => {
        clearTimeout(timer)
        const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== expected || String(res.headers.upgrade).toLowerCase() !== 'websocket'
          || res.headers['sec-websocket-extensions'] || res.headers['sec-websocket-protocol']) {
          socket.destroy(); reject(new Error('Invalid CDP Unix WebSocket handshake.')); return
        }
        socket.pause()
        const client = new UnixCdpSocket(socket, maxBytes)
        // Let Cdp install its message/error handlers before consuming upgrade data.
        resolve(client)
        queueMicrotask(() => { if (head.length) client.receive(head); socket.resume() })
      })
      req.end()
    })
  }
  private fail(message: string): void {
    if (this.closed) return
    this.dispatchEvent(Object.assign(new Event('error'), { message }))
    this.close()
  }
  private receive(chunk: Buffer): void {
    if (this.closed) return
    // Parse each bounded frame before appending more socket data. Do not retain
    // an unbounded peer-controlled frame waiting for its advertised length.
    let offset = 0
    while (offset < chunk.length && !this.closed) {
      const room = this.maxBytes + 14 - this.buffer.length
      if (room <= 0) { this.fail('CDP frame exceeded the byte limit.'); return }
      const end = Math.min(chunk.length, offset + room)
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)])
      offset = end
      while (this.buffer.length >= 2 && !this.closed) {
        const a = this.buffer[0], b = this.buffer[1], opcode = a & 15, fin = !!(a & 128)
        let length = b & 127, header = 2
        if ((a & 112) || (b & 128)) { this.fail('Invalid CDP WebSocket flags.'); return }
        if (length === 126) { if (this.buffer.length < 4) break; length = this.buffer.readUInt16BE(2); header = 4 }
        if (length === 127) {
          if (this.buffer.length < 10) break
          const big = this.buffer.readBigUInt64BE(2)
          if (big > BigInt(this.maxBytes)) { this.fail('CDP frame exceeded the byte limit.'); return }
          length = Number(big); header = 10
        }
        if (length > this.maxBytes || (opcode >= 8 && (!fin || length > 125))) { this.fail('CDP frame exceeded the byte limit or invalid control frame.'); return }
        if (this.buffer.length < header + length) break
        const data = this.buffer.subarray(header, header + length)
        this.buffer = this.buffer.subarray(header + length)
        if (opcode === 8) { this.close(); return }
        if (opcode === 9) { this.frame(10, data); continue }
        if (opcode === 10) continue
        if ((opcode !== 0 && opcode !== 1) || (opcode === 0 && !this.fragments.length) || (opcode === 1 && this.fragments.length)) { this.fail('Invalid CDP text frame.'); return }
        this.size += data.length
        if (this.size > this.maxBytes) { this.fail('CDP message exceeded the byte limit.'); return }
        this.fragments.push(data)
        if (fin) {
          const bytes = Buffer.concat(this.fragments)
          this.fragments = []; this.size = 0
          let text: string
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { this.fail('Invalid CDP UTF-8.'); return }
          this.dispatchEvent(new MessageEvent('message', { data: text }))
        }
      }
    }
  }
  private frame(opcode: number, data: Buffer): void {
    const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10)
    header[0] = 128 | opcode
    if (header.length === 2) header[1] = 128 | data.length
    else if (header.length === 4) { header[1] = 128 | 126; header.writeUInt16BE(data.length, 2) }
    else { header[1] = 128 | 127; header.writeBigUInt64BE(BigInt(data.length), 2) }
    const mask = randomBytes(4)
    const body = Buffer.from(data)
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
    this.socket.write(Buffer.concat([header, mask, body]))
  }
  send(text: string): void {
    if (this.closed) throw new Error('CDP Unix socket is closed.')
    const data = Buffer.from(text)
    if (data.length > this.maxBytes) throw new Error('CDP request exceeded the byte limit.')
    this.frame(1, data)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.buffer = Buffer.alloc(0); this.fragments = []
    this.socket.destroy()
  }
}
