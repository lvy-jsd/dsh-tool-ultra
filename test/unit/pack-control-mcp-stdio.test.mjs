// Real executable + real process runner, with an SSH stand-in and no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const cli = fileURLToPath(new URL('../../packages/dsh-tool-ultra-pack-control/lib/mcp-cli.js', import.meta.url))
const fixture = fileURLToPath(new URL('../fixtures/pack-control/mcp-fake-ssh.cjs', import.meta.url))
test('MCP executable: file config → initialize → tools/list → tools/call over stdio with fake SSH', { timeout: 15_000 }, async (t) => {
  const probe = spawnSync(process.execPath, ['-e', ''], { timeout: 2000 })
  if (probe.error && ['EPERM', 'EACCES'].includes(probe.error.code)) return t.skip(`Child processes unavailable: ${probe.error.code}`)
  if (process.platform === 'win32') return t.skip('Fake ssh executable uses a POSIX shebang.')
  if (probe.error) throw probe.error
  const dir = await mkdtemp(join(tmpdir(), 'control-mcp-stdio-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ssh = join(dir, 'fake-ssh'), config = join(dir, 'control.yml'), log = join(dir, 'ssh.json')
  await writeFile(ssh, await readFile(fixture), { mode: 0o700 })
  // The exact examples/control.yml wrapper; no peer host is needed by the CLI.
  await writeFile(config, `- id: tool-ultra-pack-control
  name: '@lvy-jsd/dsh-tool-ultra-pack-control'
  config:
    hosts:
      example: { target: 'reader@server.example.com', packs: [ssh] }
    sshBin: ${JSON.stringify(ssh)}
    multiplex: false
    packs: { ssh: true, ssh-exec: true }
    allow: { '*': true }
    auditFile: ''
`)
  const child = spawn(process.execPath, [cli, '--config', config], { env: { ...process.env, CONTROL_MCP_FAKE_SSH_LOG: log }, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n')
  const next = async (id) => {
    const line = await lines.next()
    assert.equal(line.done, false, stderr)
    const response = JSON.parse(line.value)
    assert.equal(response.id, id)
    assert.equal(response.jsonrpc, '2.0')
    assert.equal(response.error, undefined)
    return response.result
  }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-client', version: '1' } } })
  const initialized = await next(1)
  assert.equal(initialized.protocolVersion, '2025-11-25')
  assert.deepEqual(initialized.capabilities, { tools: {} })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.deepEqual((await next(2)).tools.map((t) => t.name), ['ssh_hosts', 'ssh_sys', 'ssh_read', 'ssh_log'])
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ssh_read', arguments: { host: 'example', path: '/srv/example.txt' } } })
  assert.deepEqual(await next(3), { content: [{ type: 'text', text: 'hello from fake SSH\n' }], isError: false })
  child.stdin.end()
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr)
  assert.equal((await lines.next()).done, true, 'stdout contains only the three replies')
  assert.equal(stderr, '')
  const invocation = JSON.parse(await readFile(log, 'utf8'))
  assert.ok(invocation.argv.includes('reader@server.example.com'))
  assert.ok(invocation.argv.includes('BatchMode=yes'))
  assert.match(invocation.argv.at(-1), /\/srv\/example\.txt/)
  assert.match(invocation.argv.at(-1), /dd if=/)
  assert.equal(invocation.stdin, '')
})

test('MCP executable: invalid config exits nonzero with diagnostics confined to stderr', { timeout: 5000 }, (t) => {
  const child = spawnSync(process.execPath, [cli, '--config', '/path/to/missing-control-example.yml'], { encoding: 'utf8', timeout: 3000 })
  if (child.error && ['EPERM', 'EACCES'].includes(child.error.code)) return t.skip(`Child processes unavailable: ${child.error.code}`)
  assert.equal(child.error, undefined)
  assert.equal(child.status, 1)
  assert.equal(child.stdout, '')
  assert.match(child.stderr, /pack-control-mcp:.*ENOENT/)
})
