import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { createMcpServer, serveMcpStdio, MAX_MCP_MESSAGE_BYTES } from '../../packages/dsh-tool-ultra-pack-control/lib/mcp.js'
import { loadControlConfig, parseControlConfig } from '../../packages/dsh-tool-ultra-pack-control/lib/mcp-config.js'
import { createTools } from '../../packages/dsh-tool-ultra-pack-control/lib/tools.js'
import { sessionKey } from '../../packages/dsh-tool-ultra-pack-control/lib/kit/scope.js'
import { PNG } from '../fixtures/pack-control/fake-cdp.mjs'
import fakeSshFixture from '../fixtures/pack-control/mcp-fake-ssh.cjs'

const packs = { ssh: true, 'ssh-exec': true, adb: true, 'adb-root': true, desktop: true, browser: true }
const base = { packs, hosts: { box: { target: 'user@box.example.com' } }, serials: { phone: 'phone-serial' }, auditFile: '', multiplex: false, adbConnect: false }
const ok = (text = '', more = {}) => ({ code: 0, stdout: text, stdoutBytes: Buffer.from(text), stderr: '', truncated: false, timedOut: false, ...more })
const request = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', method, params, id })
const init = (protocolVersion = '2025-11-25') => request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } })
async function ready(options = {}) {
  const server = createMcpServer({ ...base, ...options })
  assert.ok((await server.handle(init())).result)
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined)
  return server
}
const call = (server, name, args = {}, extra = {}) => server.handle(request('tools/call', { name, arguments: args, ...extra }))
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'control-mcp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('MCP: packaged runtime imports and serves tools without DSH peers installed', async (t) => {
  const dir = await temporary(t)
  const source = new URL('../../packages/dsh-tool-ultra-pack-control/', import.meta.url)
  await cp(new URL('lib/', source), join(dir, 'lib'), { recursive: true })
  await cp(new URL('package.json', source), join(dir, 'package.json'))
  await mkdir(join(dir, 'node_modules'))
  const parser = dirname(createRequire(import.meta.url).resolve('js-yaml'))
  await symlink(parser, join(dir, 'node_modules/js-yaml'), 'junction')
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  assert.equal(manifest.bin['pack-control-mcp'], 'lib/mcp-cli.js')
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional, true)
  assert.match(await readFile(join(dir, manifest.bin['pack-control-mcp']), 'utf8'), /^#!\/usr\/bin\/env node\n/)
  const { parseControlConfig: parse } = await import(pathToFileURL(join(dir, 'lib/mcp-config.js')).href)
  const { createMcpServer: create } = await import(pathToFileURL(join(dir, 'lib/mcp.js')).href)
  const server = create(parse('hosts: { example: { target: "reader@server.example.com" } }\nauditFile: ""'))
  await server.handle(init())
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.match((await call(server, 'ssh_hosts')).result.content[0].text, /reader@server.example.com/)
})

test('MCP config: full example, bare mapping, JSON, flow YAML and literal scalar types', async (t) => {
  const example = await loadControlConfig(new URL('../../packages/dsh-tool-ultra-pack-control/examples/control.yml', import.meta.url))
  assert.equal(example.hosts.server.target, 'operator@server.example.com')
  assert.equal(example.packConfig.adb.adbAskInput, true)
  assert.doesNotThrow(() => createMcpServer(example))
  const text = '# comment\nhosts: { box: { target: "user@box.example.com", packs: [ssh] } }\nreadOnly: false\nauditFile: ""\n'
  assert.deepEqual(parseControlConfig(text), { hosts: { box: { target: 'user@box.example.com', packs: ['ssh'] } }, readOnly: false, auditFile: '' })
  assert.deepEqual(parseControlConfig(JSON.stringify(base)), base)
  assert.throws(() => createMcpServer(parseControlConfig('readOnly: "false"')), /must be boolean/)
  const file = join(await temporary(t), 'config.yml')
  await writeFile(file, text)
  assert.deepEqual(await loadControlConfig(file), parseControlConfig(text))
  await assert.rejects(loadControlConfig(join(file, 'missing')), /ENOTDIR|ENOENT/)
})

test('MCP config: refuse ambiguous entries, malformed YAML, duplicates, tags and runner injection', () => {
  for (const text of ['', 'null', '42', '[]', '- name: other\n  config: {}', '- name: "@lvy-jsd/dsh-tool-ultra-pack-control"', 'readOnly: true\nreadOnly: false', 'hosts: [', '!!js/function "() => 1"', 'exec: arbitrary', 'readOny: true', '<<: { readOnly: true }', 'readOnly: true\n---\nreadOnly: false']) assert.throws(() => parseControlConfig(text), /Control config|control config/)
  const entry = '- name: "@lvy-jsd/dsh-tool-ultra-pack-control"\n  config: {}\n'
  assert.throws(() => parseControlConfig(entry.repeat(2)), /exactly one/)
  assert.throws(() => parseControlConfig(' '.repeat(MAX_MCP_MESSAGE_BYTES + 1)), /exceeds/)
  assert.throws(() => createMcpServer({ ...base, packConfig: { ssh: { timeoutMs: '1000' } } }), /Invalid control config/)
  assert.throws(() => createMcpServer({ ...base, allow: { '*': 'ssh_run' } }), /Invalid control config/)
})

test('MCP: whole-tool read-only registration cannot be widened by allow, readOnly:false or adbAskInput:false', async () => {
  const expected = ['ssh_hosts', 'ssh_sys', 'ssh_read', 'ssh_log', 'adb_devices', 'adb_info', 'adb_screen', 'adb_ui', 'adb_logcat', 'desktop_screen', 'desktop_windows', 'browser_tabs', 'browser_page', 'browser_shot']
  for (const allow of [{}, { '*': true }, { '*': '*' }, { '*': createTools(base).map((s) => s.name) }]) {
    let executions = 0
    const server = await ready({ readOnly: false, adbAskInput: false, allow, exec: async () => { executions++; return ok() } })
    const tools = (await server.handle(request('tools/list'))).result.tools
    assert.deepEqual(tools.map((t) => t.name), expected)
    assert.ok(!tools.some((t) => t.name === 'desktop_clipboard_get'), 'clipboard reads are never exposed over MCP')
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object')
      assert.equal(tool.inputSchema.additionalProperties, false)
      assert.equal(tool.annotations.readOnlyHint, true)
      assert.ok(Object.values(tool.inputSchema.properties).every((p) => !Object.hasOwn(p, 'required')))
    }
    const read = tools.find((t) => t.name === 'ssh_read').inputSchema
    assert.deepEqual(read.required, ['host', 'path'])
    assert.equal(read.properties.max_bytes.type, 'integer')
    assert.deepEqual(tools.find((t) => t.name === 'browser_page').inputSchema.properties.mode.enum, ['text', 'refs'])
    for (const spec of createTools({ ...base, adbAskInput: false })) {
      if (!expected.includes(spec.name)) assert.equal((await call(server, spec.name, { host: 'box', device: 'phone', cmd: 'uptime', action: 'list', root: false })).error.code, -32602, spec.name)
    }
    assert.equal(executions, 0)
  }
  const disabled = await ready({ disable: ['ssh_read'], packs: { ssh: true, adb: false, desktop: false, browser: false } })
  assert.deepEqual((await disabled.handle(request('tools/list'))).result.tools.map((t) => t.name), ['ssh_hosts', 'ssh_sys', 'ssh_log'])
  assert.equal((await call(disabled, 'ssh_read', { host: 'box', path: '/tmp/a' })).error.code, -32602)
})

test('MCP: lifecycle, version negotiation, notifications, ping and protocol errors', async () => {
  const server = createMcpServer(base)
  assert.equal((await server.handle(request('tools/list'))).error.code, -32600)
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined)
  assert.equal((await server.handle(request('initialize'))).error.code, -32602)
  assert.deepEqual((await server.handle(request('ping'))).result, {})
  assert.equal((await server.handle(init('future-version'))).result.protocolVersion, '2025-11-25')
  assert.equal((await server.handle(request('tools/list'))).error.code, -32600)
  assert.equal((await server.handle(init())).error.code, -32600)
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal((await server.handle(request('unknown'))).error.code, -32601)
  assert.equal((await server.handle(request('tools/list', { cursor: 'unknown' }))).error.code, -32602)
  assert.equal((await server.handle(request('tools/call', {}))).error.code, -32602)
  assert.equal((await server.handle(request('tools/list', []))).error.code, -32602)
  for (const invalid of [null, [], [request('ping')], { method: 'ping', id: 1 }, { jsonrpc: '2.0', method: 'ping', id: null }]) assert.equal((await server.handle(invalid)).error.code, -32600)
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'unknown' }), undefined)
  for (const v of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) assert.equal((await createMcpServer(base).handle(init(v))).result.protocolVersion, v)
})

test('MCP: validate arguments and host/path boundaries before transport, report transport/tool failures as isError', async () => {
  let executions = 0
  const server = await ready({ exec: async () => { executions++; return ok('example text') } })
  for (const args of [null, [], 'text', { path: '/tmp/a' }, { host: 'box', path: '/tmp/a', max_bytes: '2' }, { host: 'box', path: '/tmp/a', max_bytes: 2.5 }, { host: 'box', path: '/tmp/a', extra: true }, { host: 'unknown', path: '/tmp/a' }, { host: 'box', path: '/etc/shadow' }]) assert.equal((await call(server, 'ssh_read', args)).result.isError, true)
  assert.equal((await call(server, 'ssh_hosts', { check: 'false' })).result.isError, true)
  assert.equal((await call(server, 'browser_page', { host: 'box', mode: 'unknown' })).result.isError, true)
  assert.equal(executions, 0)
  const result = (await call(server, 'ssh_read', { host: 'box', path: '/tmp/example.txt' })).result
  assert.equal(result.isError, false)
  assert.deepEqual(result.content, [{ type: 'text', text: 'example text' }])
  const failed = await ready({ exec: async () => ok('', { code: 255, stderr: 'token=example-secret' }) })
  const error = (await call(failed, 'ssh_sys', { host: 'box' })).result
  assert.equal(error.isError, true)
  assert.ok(!JSON.stringify(error).includes('example-secret'))
})

test('MCP: trusted unique session scope survives async execution and ignores client session metadata', async () => {
  const scopes = []
  const exec = async () => { await Promise.resolve(); scopes.push(sessionKey('box')); return ok(scopes.at(-1)) }
  const a = await ready({ exec }), b = await ready({ exec })
  const meta = { _meta: { session: 'same-client-claimed-session' } }
  await call(a, 'ssh_sys', { host: 'box' }, meta)
  await call(a, 'ssh_sys', { host: 'box' }, meta)
  await call(b, 'ssh_sys', { host: 'box' }, meta)
  assert.equal(scopes[0], scopes[1])
  assert.notEqual(scopes[0], scopes[2])
  assert.match(scopes[0], /mcp:/)
  assert.ok(!scopes[0].includes('same-client-claimed-session'))
})

test('MCP: screenshots are PNG image content and audit records successful, denied and failed calls without bodies', async (t) => {
  const dir = await temporary(t), auditFile = join(dir, 'audit.jsonl')
  const server = await ready({ auditFile, outputDir: dir, exec: async () => ok('', { stdoutBytes: PNG }) })
  const result = (await call(server, 'adb_screen', { device: 'phone' })).result
  assert.equal(result.isError, false)
  assert.match(result.content[0].text, /^screenshot: /)
  assert.deepEqual(result.content[1], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' })
  await call(server, 'ssh_write', { host: 'box', path: '/tmp/a', content: 'private body' })
  await call(server, 'ssh_read', { host: 'unknown', path: '/tmp/a' })
  let lines = []
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lines = (await readFile(auditFile, 'utf8')).trim().split('\n').map(JSON.parse) } catch { /* append is asynchronous */ }
    if (lines.length === 3) break
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.deepEqual(lines.map((l) => [l.tool, l.event, l.ok]), [['adb_screen', 'result', true], ['ssh_write', 'denied', false], ['ssh_read', 'result', false]])
  assert.ok(!JSON.stringify(lines).includes('private body'))
  assert.ok(!JSON.stringify(lines).includes(PNG.toString('base64')))
})

test('MCP stdio: fragmented UTF-8/CRLF, parse errors, batches, oversized messages and EOF', async () => {
  const messages = [init(), { jsonrpc: '2.0', method: 'notifications/initialized' }, request('tools/list', {}, '中文'), request('tools/call', { name: 'ssh_hosts' }, 3)]
  const wire = Buffer.from(messages.map((m) => JSON.stringify(m)).join('\r\n') + '\n')
  const unicode = wire.indexOf(Buffer.from('中文'))
  const chunks = [Buffer.from('{bad}\n[]\n'), wire.subarray(0, unicode + 1), wire.subarray(unicode + 1), Buffer.alloc(MAX_MCP_MESSAGE_BYTES + 1, 32), Buffer.from('\n'), Buffer.from(JSON.stringify(request('ping', {}, 4)) + '\n'), Buffer.from('{unfinished')]
  let output = ''
  await serveMcpStdio(base, Readable.from(chunks), new Writable({ write(chunk, _encoding, cb) { output += chunk.toString(); cb() } }))
  const replies = output.trim().split('\n').map(JSON.parse)
  assert.deepEqual(replies.map((r) => r.error?.code ?? r.id), [-32700, -32600, 1, '中文', 3, -32600, 4, -32700])
  assert.equal(replies[4].result.isError, false)
  assert.match(replies[4].result.content[0].text, /user@box.example.com/)
})

test('MCP stdio: fake SSH fixture completes initialize → list → call even when subprocesses are forbidden', async () => {
  let executions = 0
  const exec = async (argv, opts) => {
    executions++
    return ok(fakeSshFixture.fakeSsh(argv.slice(1), opts.stdin ?? ''))
  }
  const messages = [init(), { jsonrpc: '2.0', method: 'notifications/initialized' }, request('tools/list', {}, 2), request('tools/call', { name: 'ssh_read', arguments: { host: 'example', path: '/srv/example.txt' } }, 3)]
  let output = ''
  await serveMcpStdio({ ...base, packs: { ssh: true }, hosts: { example: { target: 'reader@server.example.com' } }, exec }, Readable.from(messages.map((m) => JSON.stringify(m) + '\n')), new Writable({ write(chunk, _encoding, cb) { output += chunk.toString(); cb() } }))
  const replies = output.trim().split('\n').map(JSON.parse)
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3])
  assert.equal(replies[0].result.protocolVersion, '2025-11-25')
  assert.deepEqual(replies[1].result.tools.map((t) => t.name), ['ssh_hosts', 'ssh_sys', 'ssh_read', 'ssh_log'])
  assert.deepEqual(replies[2].result, { content: [{ type: 'text', text: 'hello from fake SSH\n' }], isError: false })
  assert.equal(executions, 1)
})
