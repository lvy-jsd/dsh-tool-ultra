// Scripted OpenAI-compatible Chat Completions server for end-to-end tests.
//
// Every request that carries tools takes the next step from the script and is
// logged with the exact tool names the model was offered. Requests without
// tools (title generation and similar) get a plain text answer — except a
// classifier prompt, which gets the category set by FAKE_CLASSIFIER_CATEGORY
// (default "maps") so dsh-tool-ultra-classifier-llm can be exercised.
//
// Usage: node fake-llm.mjs <port> <script.json> <log.jsonl>
//   script: [{ "tool_calls": [{ "name": "...", "arguments": {...} }] } | { "text": "..." }, ...]
//
// Subagents run concurrently with their parent (DSH 0.2.1 never waits for a
// child), so requests from different agents interleave. A step with
// `"agent": "<marker>"` belongs to the conversation whose first user message
// contains that marker; every other step belongs to the main conversation.
// Each conversation takes its own steps in script order. A step with
// `"skipUnless": "<regex>"` is skipped when the last message does not match,
// so one script covers DSH versions that differ in what a tool returns.
// The log records `step` as the index into the script (-1 once it runs out),
// and `systemFake`: the fake MCP tools the system prompt names (in PTC mode the
// callable tools are SDK declarations there, not tool schemas).
import { createServer } from 'node:http'
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'

const [port, scriptPath, logPath] = process.argv.slice(2)
const script = JSON.parse(readFileSync(scriptPath, 'utf8'))
const markers = [...new Set(script.map((s) => s.agent).filter(Boolean))]
const cursors = new Map()
let callSeq = 0

const textOf = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))

function agentOf(messages) {
  const first = textOf(messages.find((m) => m.role === 'user'))
  return markers.find((marker) => first.includes(marker)) ?? 'main'
}

// Index of the next step for `agent`, or -1 when its steps are used up.
function nextStep(agent, last) {
  let i = cursors.get(agent) ?? 0
  for (; i < script.length; i += 1) {
    const s = script[i]
    if ((s.agent ?? 'main') !== agent) continue
    if (s.skipUnless && !new RegExp(s.skipUnless).test(last)) continue
    break
  }
  cursors.set(agent, i + 1)
  return i < script.length ? i : -1
}

function systemText(messages) {
  return messages.filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
}

// Wait until `file` contains `marker` (a line written by the in-process test
// kit), so a step can wait for an in-process event — the post-scan catalog
// rebuild — instead of guessing a sleep.
async function waitForFile(file, marker, timeoutMs = 30000) {
  const start = Date.now()
  for (;;) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { /* not there yet */ }
    if (text.split('\n').includes(marker)) return
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${file} has no "${marker}" line`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function completion(model, delta, finish) {
  const base = { id: `fake-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]
}

createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }))
    return
  }
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const payload = JSON.parse(body || '{}')
    const tools = (payload.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean)
    const messages = payload.messages ?? []
    if (tools.length === 0) {
      const text = systemText(messages) + messages.map((m) => JSON.stringify(m.content ?? '')).join(' ')
      const isClassifier = /Answer with exactly one of these category names/.test(text)
      appendFileSync(logPath, JSON.stringify({ kind: 'no-tools', classifier: isClassifier }) + '\n')
      sse(res, completion(payload.model, { content: isClassifier ? (process.env.FAKE_CLASSIFIER_CATEGORY ?? 'maps') : 'Test session' }, 'stop'))
      return
    }
    const sys = systemText(messages)
    const agent = agentOf(messages)
    const lastContent = textOf(messages.at(-1))
    const step = nextStep(agent, lastContent)
    const current = script[step] ?? { text: 'done' }
    appendFileSync(logPath, JSON.stringify({
      kind: 'turn', step, agent, tools,
      systemFake: [...new Set(sys.match(/mcp__fake__\w+/g) ?? [])].sort(),
      subagent: /delegat|subagent/i.test(sys.slice(0, 20000)) && /You are a subagent|delegated/i.test(sys),
      lastRole: messages.at(-1)?.role,
      lastContent: lastContent.slice(0, 6000),
    }) + '\n')
    // `openGate` creates a file the in-process test kit watches, releasing a
    // held catalog refresh (the scan's post-scan rebuild). `waitFor` holds the
    // answer until that rebuild is logged. `delayMs` still holds the answer back
    // for background work (a classifier) with no observable signal.
    void answer(current, payload.model)
  })
  async function answer(current, model) {
    if (current.openGate) {
      try { writeFileSync(current.openGate, 'open\n') } catch { /* test-only */ }
    }
    if (current.waitFor) await waitForFile(current.waitFor, current.waitForMarker ?? 'gate')
    if (current.delayMs) await new Promise((r) => setTimeout(r, current.delayMs))
    reply(current, model)
  }
  function reply(current, model) {
    if (current.tool_calls) {
      const calls = current.tool_calls.map((c, index) => ({
        index, id: `call_${++callSeq}`, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      }))
      sse(res, completion(model, { content: null, tool_calls: calls }, 'tool_calls'))
    } else {
      sse(res, completion(model, { content: current.text ?? 'done' }, 'stop'))
    }
  }
}).listen(Number(port), '127.0.0.1', () => console.error(`fake-llm on ${port}`))
