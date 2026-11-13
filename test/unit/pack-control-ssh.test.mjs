// Control pack, SSH half: argv construction, host aliases, the read-only command
// check, redaction, file transfer limits and the approval gate. A fake exec stands
// in for ssh, so nothing here touches a network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply, capText, checkHost, createTools, DEFAULT_DENY_PATHS, gate, isDeniedPath, isReadOnlyCommand, localExec,
  redact, shq, sshArgv, TOOL_NAMES,
} from '../../packages/dsh-tool-ultra-pack-control/lib/index.js'

const ok = (stdout = '', extra = {}) => ({ code: 0, stdout, stdoutBytes: Buffer.from(stdout), stderr: '', timedOut: false, truncated: false, ...extra })
function fake(reply = ok()) {
  const calls = []
  const exec = async (argv, options = {}) => { calls.push({ argv, options }); return typeof reply === 'function' ? reply(argv, options) : reply }
  return { exec, calls }
}
const HOSTS = { nix: { target: 'root@host.example' }, box: { target: 'root@box.example', port: 2222, identity: '/k/id' } }
const tools = (opts = {}) => Object.fromEntries(createTools({ hosts: HOSTS, packs: { ssh: true, 'ssh-exec': true }, ...opts }).map((t) => [t.name, t]))
const remoteOf = (call) => call.argv[call.argv.length - 1]
// The script inside `sh -c '<script>'`, with the outer quoting undone.
const scriptOf = (call) => remoteOf(call).replace(/^sh -c '/, '').replace(/'$/, '').split(`'\\''`).join("'")

test('control: tool names match the package.json declaration, risks included', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../packages/dsh-tool-ultra-pack-control/package.json', import.meta.url), 'utf8'))
  const declared = pkg.dsh.toolCatalog.tools
  assert.deepEqual(Object.keys(declared).sort(), [...TOOL_NAMES].sort())
  for (const t of Object.values(tools())) assert.equal(declared[t.name].risk, t.risk, t.name)
})

test('control: only the read-only pack is on by default; readOnly and disable narrow further', () => {
  const names = (o) => createTools({ hosts: HOSTS, ...o }).map((t) => t.name).sort()
  assert.deepEqual(names({}), ['ssh_hosts', 'ssh_log', 'ssh_read', 'ssh_sys'])
  assert.equal(names({ packs: { 'ssh-exec': true } }).length, 8)
  assert.deepEqual(names({ packs: { 'ssh-exec': true }, readOnly: true }), ['ssh_hosts', 'ssh_log', 'ssh_read', 'ssh_sys'], 'readOnly drops every changing tool')
  assert.ok(!names({ packs: { 'ssh-exec': true }, disable: ['ssh_put'] }).includes('ssh_put'))
  assert.deepEqual(names({ packs: { ssh: false } }), [])
})

test('control: ssh argv has no shell, no prompts, and the target after --', () => {
  const argv = sshArgv({ target: 'root@box.example', port: 2222, identity: '/k/id' }, 'uptime', { controlDir: '/tmp/c' })
  assert.deepEqual(argv, ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', 'ControlPath=/tmp/c/%C', '-p', '2222', '-i', '/k/id', '-o', 'IdentitiesOnly=yes', '--', 'root@box.example', 'uptime'])
  assert.ok(!sshArgv({ target: 'user@host.example' }, 'x', { multiplex: false }).some((a) => a.includes('Control')))
})

test('control: host entries that look like ssh options are refused', () => {
  assert.throws(() => checkHost('x', { target: '-oProxyCommand=evil' }), /not a valid ssh destination/)
  assert.throws(() => checkHost('x', { target: 'a b' }), /not a valid/)
  assert.throws(() => checkHost('-x', { target: 'user@host.example' }), /Bad host alias/)
  assert.throws(() => checkHost('x', { target: 'user@host.example', port: 70000 }), /bad port/)
  assert.throws(() => createTools({ hosts: { x: { target: '-F/etc/passwd' } } }), /not a valid/)
})

test('control: a model can only name configured aliases', async () => {
  const { exec, calls } = fake()
  const t = tools({ exec, multiplex: false })
  await assert.rejects(t.ssh_sys.execute({ host: 'evil@host' }), /Unknown host "evil@host". Configured: nix, box/)
  await assert.rejects(t.ssh_sys.execute({ host: '-oProxyCommand=x' }), /Unknown host/)
  assert.equal(calls.length, 0)
  await assert.rejects(tools({ exec, hosts: {} }).ssh_sys.execute({ host: 'nix' }), /No ssh hosts are configured/) // no hosts at all
})

test('control: shq survives quotes, and ssh_run wraps the command in sh -c', async () => {
  assert.equal(shq(`it's`), `'it'\\''s'`)
  const { exec, calls } = fake(ok('hi\n'))
  const t = tools({ exec, multiplex: false })
  const out = await t.ssh_run.execute({ host: 'nix', cmd: `echo "it's"; id` })
  assert.equal(remoteOf(calls[0]), `sh -c ${shq(`echo "it's"; id`)}`)
  assert.match(out, /^exit 0 \(\d+ ms\)\n--- stdout\nhi$/)
  await t.ssh_run.execute({ host: 'nix', cmd: 'ls', cwd: '/var/log' })
  assert.match(scriptOf(calls[1]), /^cd '\/var\/log' && \{ ls\n\}$/)
  await assert.rejects(t.ssh_run.execute({ host: 'nix', cmd: '  ' }), /Give a command/)
})

test('control: ssh_run reports failures and timeouts as text, with output redacted and capped', async () => {
  const t = tools({ maxChars: 400, exec: fake(ok('x'.repeat(5000), { code: 3, stderr: 'password=hunter2 denied' })).exec })
  const out = await t.ssh_run.execute({ host: 'nix', cmd: 'false' })
  assert.match(out, /^exit 3/)
  assert.match(out, /characters omitted/)
  assert.match(out, /password=\*\*\*/)
  assert.doesNotMatch(out, /hunter2/)
  const slow = tools({ exec: fake(ok('', { code: null, timedOut: true })).exec })
  assert.match(await slow.ssh_run.execute({ host: 'nix', cmd: 'sleep 99', timeout_s: 5 }), /^timed out after 5s/)
  const passed = []
  await tools({ exec: fake((a, o) => { passed.push(o.timeoutMs); return ok() }).exec }).ssh_run.execute({ host: 'nix', cmd: 'x', timeout_s: 100000 })
  assert.deepEqual(passed, [600_000], 'timeout is clamped')
})

test('control: read-only command check accepts plain reads and rejects everything it cannot prove', () => {
  for (const c of ['uptime', 'ls -la /var/log', 'cat /etc/os-release', 'systemctl status sshd.service', 'systemctl list-units --failed --no-pager', 'journalctl -u sshd -n 50 --no-pager', 'df -h', 'date +%s', 'hostname', 'tail -n 20 /var/log/syslog', 'free -m']) assert.ok(isReadOnlyCommand(c), c)
  for (const c of [
    'ls; rm -rf /', 'ls && reboot', 'cat /etc/passwd | sh', 'ls > /tmp/x', 'echo $(id)', 'cat `id`', 'ls *', 'ls\nreboot', 'rm -rf /', 'systemctl restart sshd', 'systemctl status x --force-me',
    'journalctl --vacuum-size=1M', 'journalctl --rotate', 'tail -f /var/log/syslog', 'hostname evil', 'date -s 2020-01-01', 'sed -i s/a/b/ f', 'find / -delete', 'dd if=/dev/zero of=/dev/sda', '', 'x'.repeat(400),
  ]) assert.ok(!isReadOnlyCommand(c), JSON.stringify(c))
  const deny = DEFAULT_DENY_PATHS.map((p) => new RegExp(p))
  for (const c of ['cat ..', 'ls ../etc', 'cat /var/log/../../etc/os-release', 'ls /var/..', 'cat ./../x', 'head -n 1 a/../b']) assert.ok(!isReadOnlyCommand(c, deny), `${c}: a .. is never auto-approved`)
  assert.ok(isReadOnlyCommand('ls ./logs', deny), 'a single dot is harmless')
  assert.ok(isReadOnlyCommand('cat /var/log/a..b', deny), '.. inside a name is not a path step')
  for (const c of ['cat /etc/shadow', 'cat /etc/./shadow', 'cat /etc//shadow', 'cat /root/.ssh/id_ed25519', 'cat .ssh/id_rsa', 'head -c 9 /proc/1/environ', 'cat /var/../etc/shadow']) assert.ok(!isReadOnlyCommand(c, deny), c)
  assert.ok(isReadOnlyCommand('cat /etc/os-release', deny))
})

test('control: isDeniedPath makes the path absolute and normalizes it before matching', () => {
  const deny = DEFAULT_DENY_PATHS.map((p) => new RegExp(p))
  const denied = ['/etc/shadow', '/etc/./shadow', '/etc//shadow', '/etc/x/../shadow', '/var/../etc/shadow', '/a/b/../../etc/shadow', '/etc/shadow/', '/root/.ssh/id_ed25519', '/root/./.ssh/../.ssh/id_rsa', '/proc/self/../1/environ',
    // a relative path is taken from /, since the remote working directory is unknown
    '.ssh/id_rsa', './.ssh/id_rsa', 'etc/shadow', '../etc/shadow', '../../../../etc/shadow']
  for (const p of denied) assert.equal(isDeniedPath(p, deny), true, p)
  for (const p of ['/etc/hostname', '/etc/shadowing', '/var/log/ssh/id_x.log', '/home/u/.ssh/known_hosts', 'notes.txt', '/etc/x/../hostname']) assert.equal(isDeniedPath(p, deny), false, p)
})

test('control: ssh_run asks unless the command is read-only, and cwd always asks', () => {
  const t = tools()
  assert.equal(t.ssh_run.approve({ host: 'nix', cmd: 'uptime' }), undefined)
  assert.match(t.ssh_run.approve({ host: 'nix', cmd: 'rm -rf /tmp/x' }), /^nix: rm -rf \/tmp\/x/)
  assert.ok(t.ssh_run.approve({ host: 'nix', cmd: 'ls', cwd: '/etc' }))
  assert.ok(t.ssh_run.approve({ host: 'nix', cmd: 'cat /etc/shadow' }), 'a denied path is never auto-approved')
  assert.doesNotMatch(t.ssh_run.approve({ host: 'nix', cmd: 'echo token=abc123 | tee /x' }), /abc123/, 'secrets are redacted in the prompt')
  assert.ok(t.ssh_write.approve({ host: 'nix', path: '/etc/x', content: 'abc' }))
  assert.ok(t.ssh_put.approve({ host: 'nix', name: 'a', remote: '/x' }))
  assert.equal(t.ssh_get.approve, undefined)
  assert.equal(t.ssh_read.approve, undefined)
})

test('control: ssh_read lists directories, pages files, and refuses credentials', async () => {
  const { exec, calls } = fake(ok('data'))
  const t = tools({ exec, multiplex: false })
  assert.equal(await t.ssh_read.execute({ host: 'nix', path: '/etc/hostname', max_bytes: 10, offset: 5 }), 'data')
  assert.match(remoteOf(calls[0]), /tail -c \+6 -- "\$p" \| head -c 10/)
  await assert.rejects(t.ssh_read.execute({ host: 'nix', path: '/etc/shadow' }), /credentials/)
  await assert.rejects(t.ssh_read.execute({ host: 'nix', path: '/home/x/../../etc/shadow' }), /credentials/)
  await assert.rejects(t.ssh_read.execute({ host: 'nix', path: '/root/.ssh/id_ed25519' }), /credentials/)
  await assert.rejects(t.ssh_read.execute({ host: 'nix', path: '' }), /Give a path/)
  for (const path of ['etc/hostname', './x', '../etc/shadow', '~/notes', 'x']) await assert.rejects(t.ssh_read.execute({ host: 'nix', path }), /must be absolute/, path)
  assert.equal(calls.length, 1, 'a relative path never reaches ssh')
  const extra = tools({ exec, denyPaths: ['^/srv/private'] })
  await assert.rejects(extra.ssh_read.execute({ host: 'nix', path: '/srv/private/a' }), /credentials/)
  assert.match(await tools({ exec: fake(ok('', { code: 1, stderr: 'No such file' })).exec }).ssh_read.execute({ host: 'nix', path: '/nope' }), /^exit 1/)
})

test('control: ssh_read hides private keys that are inside a readable file', async () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'
  const out = await tools({ exec: fake(ok(`before\n${pem}\nafter`)).exec }).ssh_read.execute({ host: 'nix', path: '/srv/notes' })
  assert.doesNotMatch(out, /abc/)
  assert.match(out, /\[private key removed\]/)
})

test('control: ssh_log validates what it puts in the journalctl line', async () => {
  const { exec, calls } = fake()
  const t = tools({ exec })
  await t.ssh_log.execute({ host: 'nix', unit: 'sshd.service', lines: 20, since: '10 min ago' })
  assert.equal(remoteOf(calls[0]), `sh -c ${shq(`journalctl --no-pager -n 20 -u 'sshd.service' --since '10 min ago'`)}`)
  await t.ssh_log.execute({ host: 'nix', path: '/var/log/messages', lines: 9999 })
  assert.equal(scriptOf(calls[1]), "tail -n 500 -- '/var/log/messages'")
  await assert.rejects(t.ssh_log.execute({ host: 'nix', unit: 'x; reboot' }), /Bad unit/)
  await assert.rejects(t.ssh_log.execute({ host: 'nix', since: `x'; reboot; '` }), /Bad since/)
  await assert.rejects(t.ssh_log.execute({ host: 'nix', path: '/etc/shadow' }), /credentials/)
  await assert.rejects(t.ssh_log.execute({ host: 'nix', path: 'var/log/x' }), /must be absolute/)
})

test('control: ssh_hosts lists aliases, and check reports who answers', async () => {
  const t = tools({ exec: fake((argv) => (argv.includes('root@box.example') ? ok('', { code: 255, stderr: 'Connection refused\n' }) : ok())).exec })
  assert.equal(await t.ssh_hosts.execute({}), 'nix: root@host.example\nbox: root@box.example port 2222')
  assert.equal(await t.ssh_hosts.execute({ check: true }), 'nix: root@host.example - reachable\nbox: root@box.example port 2222 - unreachable: Connection refused')
})

test('control: ssh_write sends content on stdin, never in the command line', async () => {
  const { exec, calls } = fake()
  const t = tools({ exec })
  const out = await t.ssh_write.execute({ host: 'nix', path: '/etc/motd', content: 'héllo $(id)' })
  assert.match(out, /^wrote 12 bytes to \/etc\/motd/)
  assert.equal(calls[0].options.stdin, 'héllo $(id)')
  assert.equal(remoteOf(calls[0]), `sh -c ${shq(`cat > '/etc/motd'`)}`)
  await t.ssh_write.execute({ host: 'nix', path: '/etc/motd', content: 'x', append: true })
  assert.match(remoteOf(calls[1]), /cat >> /)
  await assert.rejects(t.ssh_write.execute({ host: 'nix', path: '/etc/shadow', content: 'x' }), /credentials/)
  await assert.rejects(t.ssh_write.execute({ host: 'nix', path: 'motd', content: 'x' }), /must be absolute/)
  assert.equal(calls.length, 2)
  assert.equal(t.ssh_write.describe({ host: 'nix', path: '/p', content: 'SECRET-BODY' }).includes('SECRET-BODY'), false, 'the audit line never carries file contents')
})

test('control: file transfer uses plain names inside the transfer folder and never overwrites', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ctl-xfer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bytes = Buffer.from([0, 1, 2, 255, 254])
  const { exec, calls } = fake((argv) => (remoteOf({ argv }).includes('cat --') ? ok('', { stdoutBytes: bytes }) : ok()))
  const x = tools({ exec, transferDir: dir, maxTransferBytes: 100 })
  assert.match(await x.ssh_get.execute({ host: 'nix', remote: '/var/a.bin', name: 'a.bin' }), /^saved 5 bytes to /)
  assert.deepEqual(await readFile(join(dir, 'a.bin')), bytes, 'binary data survives')
  await assert.rejects(x.ssh_get.execute({ host: 'nix', remote: '/var/a.bin', name: 'a.bin' }), /already exists/)
  for (const name of ['../x', '/etc/passwd', 'a/b', '.hidden', '']) {
    await assert.rejects(x.ssh_get.execute({ host: 'nix', remote: '/a', name }), /Bad file name/, name)
    await assert.rejects(x.ssh_put.execute({ host: 'nix', remote: '/a', name }), /Bad file name/, name)
  }
  await writeFile(join(dir, 'up.txt'), 'payload')
  assert.match(await x.ssh_put.execute({ host: 'nix', name: 'up.txt', remote: '/tmp/up.txt' }), /^uploaded 7 bytes to \/tmp\/up.txt/)
  assert.deepEqual(calls.at(-1).options.stdin, Buffer.from('payload'))
  await assert.rejects(x.ssh_put.execute({ host: 'nix', name: 'missing', remote: '/a' }), /does not exist/)
  await writeFile(join(dir, 'big'), 'x'.repeat(101))
  await assert.rejects(x.ssh_put.execute({ host: 'nix', name: 'big', remote: '/a' }), /larger than 100/)
  const huge = tools({ exec: fake(ok('', { stdoutBytes: Buffer.alloc(101) })).exec, transferDir: dir, maxTransferBytes: 100 })
  await assert.rejects(huge.ssh_get.execute({ host: 'nix', remote: '/a', name: 'huge' }), /larger than 100/)
  await assert.rejects(readFile(join(dir, 'huge')), /ENOENT/, 'nothing is saved past the limit')
})

test('control: redact and capText', () => {
  assert.equal(redact('db_password: "s3cret"'), 'db_password: ***')
  assert.equal(redact('API_KEY=abc DEBUG=1'), 'API_KEY=*** DEBUG=1')
  assert.equal(redact('GITHUB_TOKEN = ghp_x'), 'GITHUB_TOKEN = ***')
  assert.equal(capText('abc', 10), 'abc')
  const cut = capText('a'.repeat(100), 20)
  assert.match(cut, /^a{12}\n\[\.\.\. 80 characters omitted \.\.\.\]\na{8}$/)
})

test('control: localExec runs without a shell, feeds stdin, and enforces limits', async () => {
  const node = process.execPath
  const r = await localExec([node, '-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'a;b $(c)' })
  assert.equal(r.stdout, 'a;b $(c)')
  assert.equal(r.code, 0)
  assert.equal((await localExec([node, '-e', 'process.exit(7)'])).code, 7)
  const big = await localExec([node, '-e', 'process.stdout.write("x".repeat(5000))'], { maxBytes: 100 })
  assert.equal(big.stdout.length, 100)
  assert.ok(big.truncated)
  const slow = await localExec([node, '-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 })
  assert.ok(slow.timedOut)
  const missing = await localExec(['/no/such/binary-xyz'])
  assert.equal(missing.code, null)
  assert.match(missing.stderr, /command not found/)
  const shellLike = await localExec([node, '-e', 'console.log(process.argv[1])', 'a;echo pwned'])
  assert.equal(shellLike.stdout.trim(), 'a;echo pwned', 'arguments are never parsed by a shell')
})

// --- the DSH adapter ---------------------------------------------------------------------

function host(config) {
  const registered = []
  const packs = []
  const hooks = {}
  const ctx = {
    logger: { warn() {} },
    tools: { register: (def) => registered.push(def) },
    effect: (fn) => fn(),
    on: (event, fn) => { hooks[event] = fn; return () => {} },
    inject: (deps, fn) => fn({ effect: (f) => f(), toolCatalog: { registerToolPack: (p) => { packs.push(p); return () => {} } } }),
  }
  apply(ctx, { hosts: HOSTS, auditFile: '', ...config })
  return { registered, packs, hooks }
}

test('control: apply registers tools and one pack per switched-on pack', () => {
  const h = host({})
  assert.deepEqual(h.registered.map((d) => d.name).sort(), ['ssh_hosts', 'ssh_log', 'ssh_read', 'ssh_sys'])
  assert.deepEqual(h.packs.map((p) => p.id), ['ssh'])
  assert.deepEqual(h.packs[0].items().map((i) => [i.id, i.state]), [['nix', 'on'], ['box', 'on']])
  const both = host({ packs: { 'ssh-exec': true } })
  assert.deepEqual(both.packs.map((p) => p.id), ['ssh', 'ssh-exec'])
  assert.deepEqual(both.packs[1].tools.sort(), ['ssh_get', 'ssh_put', 'ssh_run', 'ssh_write'])
  assert.deepEqual(host({ hosts: {} }).packs[0].items().map((i) => [i.id, i.state]), [['hosts', 'waiting']])
})

test('control: the gate asks for risky calls, lets read-only ones through, and honours allow', async () => {
  const h = host({ packs: { 'ssh-exec': true }, allow: { trusted: ['ssh_run'], '*': false } })
  const hook = h.hooks['tools/pre-execute']
  const next = async () => 'went ahead'
  const ask = await hook({ name: 'ssh_run', agent: { id: 's1' }, arguments: { host: 'nix', cmd: 'rm -rf /srv' } }, next)
  assert.equal(ask.kind, 'ask')
  assert.match(ask.reason, /ssh_run: nix: rm -rf \/srv/)
  assert.match(ask.displayReason['zh-CN'], /允许 ssh_run/)
  assert.equal(await hook({ name: 'ssh_run', agent: { id: 's1' }, arguments: { host: 'nix', cmd: 'uptime' } }, next), 'went ahead')
  assert.equal(await hook({ name: 'ssh_read', agent: { id: 's1' }, arguments: { host: 'nix', path: '/etc/hostname' } }, next), 'went ahead')
  assert.equal(await hook({ name: 'bash', agent: { id: 's1' }, arguments: { command: 'rm -rf /' } }, next), 'went ahead', 'other tools are not ours to judge')
  assert.equal(await hook({ name: 'ssh_run', agent: { id: 'trusted' }, arguments: { host: 'nix', cmd: 'reboot' } }, next), 'went ahead', 'a session on the allow list skips the question')
  assert.equal((await hook({ name: 'ssh_write', agent: { id: 'trusted' }, arguments: { host: 'nix', path: '/a', content: '' } }, next)).kind, 'ask', 'allow is per tool')
  const open = gate(createTools({ hosts: HOSTS, packs: { 'ssh-exec': true } }), { '*': true })
  assert.equal(open({ name: 'ssh_run', arguments: { host: 'nix', cmd: 'reboot' } }), undefined)
})

test('control: with only read-only tools on, no gate is installed', () => {
  assert.equal(host({}).hooks['tools/pre-execute'], undefined)
  assert.equal(host({ packs: { 'ssh-exec': true }, readOnly: true }).hooks['tools/pre-execute'], undefined)
})

test('control: the audit log records calls without contents and survives a missing folder', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ctl-audit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'nested', 'audit.jsonl')
  const h = host({ auditFile: file, packs: { 'ssh-exec': true }, exec: fake(ok('x')).exec })
  const write = h.registered.find((d) => d.name === 'ssh_write')
  await write.execute({ host: 'nix', path: '/etc/motd', content: 'TOPSECRET' })
  await assert.rejects(h.registered.find((d) => d.name === 'ssh_read').execute({ host: 'nix', path: '/etc/shadow' }))
  await new Promise((r) => setTimeout(r, 200))
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => [l.tool, l.ok]), [['ssh_write', true], ['ssh_read', false]])
  assert.ok(!JSON.stringify(lines).includes('TOPSECRET'))
})
