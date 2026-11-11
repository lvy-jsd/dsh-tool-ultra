// Recording proxy for trial runs against a real OpenAI-compatible provider.
//
// DSH talks to this proxy with a dummy key; the proxy forwards to UPSTREAM
// with the real key from its own environment (UPSTREAM_KEY), so the key never
// enters DSH's config or any file. Every chat request is logged with the tool
// names and schema size the model was offered, and the provider's usage block
// (including cache-hit token counts) is captured from the response stream.
//
// Usage: UPSTREAM=https://api.deepseek.com UPSTREAM_KEY=... node record-proxy.mjs <port> <log.jsonl>
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const [port, logPath] = process.argv.slice(2)
const upstream = (process.env.UPSTREAM ?? '').replace(/\/+$/, '')
const key = process.env.UPSTREAM_KEY
if (!upstream || !key) {
  console.error('UPSTREAM and UPSTREAM_KEY are required')
  process.exit(2)
}
let seq = 0

createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const path = req.url.replace(/^\/v1/, '')
  let entry = null
  if (req.method === 'POST' && body.length) {
    try {
      const payload = JSON.parse(body.toString('utf8'))
      const tools = payload.tools ?? []
      entry = {
        seq: ++seq,
        at: new Date().toISOString(),
        model: payload.model,
        messages: payload.messages?.length ?? 0,
        tools: tools.map((t) => t.function?.name ?? t.name),
        toolSchemaChars: JSON.stringify(tools).length,
        promptChars: body.length,
      }
    } catch {
      // not JSON; forward untouched
    }
  }
  const headers = { 'content-type': req.headers['content-type'] ?? 'application/json', authorization: `Bearer ${key}` }
  let upstreamRes
  try {
    upstreamRes = await fetch(`${upstream}${path}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : body })
  } catch (error) {
    res.writeHead(502).end(String(error))
    return
  }
  res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' })
  let tail = ''
  let usage = null
  let finish = null
  const decoder = new TextDecoder()
  for await (const piece of upstreamRes.body) {
    res.write(piece)
    if (!entry) continue
    tail += decoder.decode(piece, { stream: true })
    const lines = tail.split('\n')
    tail = lines.pop()
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
      if (!data || data === '[DONE]') continue
      try {
        const j = JSON.parse(data)
        if (j.usage) usage = j.usage
        const f = j.choices?.[0]?.finish_reason
        if (f) finish = f
      } catch {
        // partial or non-JSON line
      }
    }
  }
  res.end()
  if (entry) {
    if (!usage && tail.trim().startsWith('{')) {
      try { usage = JSON.parse(tail).usage ?? null } catch { /* no usage in this tail */ }
    }
    appendFileSync(logPath, JSON.stringify({ ...entry, status: upstreamRes.status, finish, usage }) + '\n')
  }
}).listen(Number(port), '127.0.0.1', () => console.error(`record-proxy on ${port} -> ${upstream}`))
