# @lvy-jsd/dsh-tool-ultra-pack-control

SSH and Android control for [Tool Ultra](https://github.com/lvy-jsd/dsh-tool-ultra), written for small models: few tools, short schemas, host names instead of addresses. No npm dependencies; it runs the system `ssh` and `adb`.

| Pack | Tools | Risk |
| --- | --- | --- |
| `ssh` (on by default) | `ssh_hosts`, `ssh_sys`, `ssh_read`, `ssh_log` | low |
| `ssh-exec` (off by default) | `ssh_run`, `ssh_write`, `ssh_put` (high), `ssh_get` (medium) | asks first |
| `adb` (off by default) | `adb_devices`, `adb_info`, `adb_screen`, `adb_ui`, `adb_logcat`; `adb_tap`, `adb_input`, `adb_app` | low / medium |
| `adb-root` (off by default) | `adb_shell`, `adb_push`, `adb_pull`, `adb_install` | high |

Load one with `tools_load(["pack:ssh"])` or `tools_load(["pack:ssh-exec"])`.

```
ssh_hosts()                                  nix: root@host.example
ssh_sys(host)                                kernel, uptime, memory, disk, failed services
ssh_read(host, path, max_bytes?, offset?)    a file, or a directory listing
ssh_log(host, unit? | path?, lines?, since?) journal or log tail
ssh_run(host, cmd, cwd?, timeout_s?)         exit code, stdout, stderr
ssh_write(host, path, content, append?)      replaces or appends
ssh_get(host, remote, name)                  into the transfer folder
ssh_put(host, name, remote)                  from the transfer folder
```

## Safety

Several layers, each of which can be tightened on its own.

- **Packs are opt-in.** `ssh-exec` is off until the config turns it on. `readOnly: true` removes every tool that is not low risk, whatever `packs` says.
- **Hosts are aliases.** A model passes `nix`; the config says what that means. An unknown name is an error, a target that could be read as an ssh option (`-oProxyCommand=...`) is refused when the config loads, and no password is ever asked for (`BatchMode`).
- **Changing calls ask.** `ssh_run`, `ssh_write` and `ssh_put` go through a `tools/pre-execute` gate that returns `{ kind: 'ask' }`, which DSH routes to the user. A session with nobody to ask is refused, so an unattended bot cannot use them unless you list its session id under `allow`. A command that is plainly read-only (`uptime`, `ls`, `systemctl status`, `journalctl -u x`, ...) runs without asking; anything with `;`, `|`, `>`, `$(...)`, a glob, an unknown program or a write option is not, and neither is any run with `cwd`.
- **No shell on this side.** The ssh client is started with an argument vector. On the remote side every script runs as `sh -c '<script>'` with quoted arguments, and file contents travel on stdin, not in the command line.
- **Credentials stay out of view.** The read tools refuse `/etc/shadow`, SSH private keys, host keys and `/proc/*/environ` (path segments such as `..` are collapsed first; add more with `denyPaths`), and private keys or `password=...` style values in any output are masked. This is a guard against reading them by accident, not a boundary: a command someone approved can still do anything, and a symlink gets around a path check.
- **Files move through one folder.** `ssh_get` saves and `ssh_put` reads only inside `transferDir` (default `~/dsh-transfers`), by plain file name, never overwriting, up to `maxTransferBytes`.
- **A record.** Every call that ran is appended to `<DSH_HOME>/tool-manager/control-audit.jsonl` (host, a redacted one-line summary, result, time; never file contents). Refused calls never ran and are not in it.

Pair this pack with `@lvy-jsd/dsh-tool-ultra-risk-gate`: it asks before a high-risk tool is loaded, this pack asks before it is used.

## Config

See [`cordis.patch.yml`](cordis.patch.yml): `packs`, `readOnly`, `disable`, `hosts`, `allow`, `auditFile`, `transferDir`, `denyPaths`, plus `sshBin`, `multiplex`, `connectTimeoutS`, `timeoutMs`, `maxBytes`, `maxChars`, `maxTransferBytes`.

`target` can be `user@host` or a Host alias from `~/.ssh/config`, so keys, jump hosts and ports can live there.

## Desktop and browser (planned)

The desktop and browser packs will reach a machine over this same transport, and will work with every host in `hosts`, not just one: their tools take the same `host` alias, so a screenshot or a click is aimed at whichever configured machine the model names.

## For other front ends

`createTools(options)` returns plain objects (`name`, `pack`, `risk`, `description`, `parameters`, `approve`, `describe`, `execute`) with no DSH types in them, and `gate(specs, allow)` is the approval decision. Anything that can call a function can host them. `options.exec` replaces the process runner, which is how the tests run without a network.

## License

Apache-2.0.

## Android: `adb` and `adb-root`

Both Android packs are off by default. Enable them separately; `adb-root` is
just the pack name. It does **not** start a root adbd, reboot, pair a device,
or grant KernelSU authorization. Install a current system `adb` (Android platform
tools; NixOS: `android-tools`), complete wireless pairing yourself if required,
and authorize shell in KernelSU before using root calls.

```yaml
packs:
  ssh: true
  adb: true
  adb-root: false
serials:
  example-phone: 'phone.example:5555'
  example-secondary: 'example-serial'
adbConnect: true
adbAskInput: false
adbUiTtlMs: 30000
transferDir: /path/to/transfers
outputDir: /path/to/screenshots
```

`serials` maps aliases to an adb serial or a wireless `host:port` (including
`[IPv6]:port`). Use the actual port from Android's wireless debugging screen.
Every targeted tool requires `device`, the **alias**; there is no implicit first
device and a raw address/serial is rejected. Endpoints that resemble options or
contain whitespace/control characters are rejected when either Android pack is enabled.
When both packs are off, Android tools are not built and `serials` is not validated,
so unused Android configuration cannot prevent SSH tools from starting. Each target
has one alias. `adbConnect: true` reconnects configured wireless endpoints before
use; set it false for connections maintained externally. `adb_devices` attempts
those connections and reports only configured devices, including offline or
unauthorized states. It never operates on other devices attached to the server.
Panel entries show configuration, not a claim that a device is reachable.

| Tool | Arguments after required `device` | Result / risk |
| --- | --- | --- |
| `adb_devices` | no arguments, including no `device` | configured aliases, serials, models and states / low |
| `adb_info` | — | model, Android version, battery, foreground app, lock indicators / low |
| `adb_screen` | — | private PNG in `outputDir`; open with `read_image` / low |
| `adb_ui` | — | numbered visible elements and center coordinates / low |
| `adb_tap` | `target` | recent element number, `text:LABEL`, or `x,y` / medium |
| `adb_input` | `kind`, `value` | `text`, `key`, `swipe` / medium |
| `adb_app` | `action`, `pkg?` | `current`, `list`, `start`, `stop` / medium |
| `adb_logcat` | `lines?`, `tag?`, `level?` | finite snapshot, 1–500 lines, priority V/D/I/W/E/F / low |
| `adb_shell` | `cmd`, `root?`, `timeout_s?` | exit status, bounded/redacted output / high |
| `adb_push` | `local`, `remote` | ordinary adb upload / high |
| `adb_pull` | `remote`, `local`, `root?` | one binary file, optional KernelSU read / high |
| `adb_install` | `apk` | ordinary adb APK install / high |

Examples (these are tool arguments, not shell commands):

```json
{"device":"example-phone"}
{"device":"example-phone","target":"3"}
{"device":"example-phone","target":"text:Settings"}
{"device":"example-phone","target":"120,340"}
{"device":"example-phone","kind":"swipe","value":"100,800,100,200,300"}
{"device":"example-phone","kind":"key","value":"KEYCODE_HOME"}
{"device":"example-phone","kind":"text","value":"example search"}
{"device":"example-phone","action":"start","pkg":"org.example.app"}
{"device":"example-phone","cmd":"id","root":true}
{"device":"example-phone","remote":"/sdcard/example.bin","local":"example.bin"}
```

The first object is for `adb_info`, `adb_screen` or `adb_ui`; the following
objects demonstrate tap, input, app, shell and pull arguments respectively.
Call `adb_ui` before tapping by number/text. Snapshots are separate per device,
expire after `adbUiTtlMs`, and are invalidated by input, app changes, shell,
upload and install (even if execution fails). Ambiguous labels require a fresh
snapshot or explicit coordinates. External UI changes can still make a reference
stale before its timeout; refresh whenever the phone changes. UI dumps require
uiautomator and expose only the accessibility hierarchy; custom canvas surfaces
may need screenshot plus coordinates. XML parsing rejects DTDs/external entities,
malformed/truncated dumps and snapshots too large to return in full.

`adb_input` uses Android's native `input`: text is limited to printable ASCII
and rejects literal `%s` (Android treats it as a space). No clipboard service or
keyboard is installed to support Unicode. Keys accept `KEYCODE_*` or a numeric
keycode; swipes use `x1,y1,x2,y2[,milliseconds]`. App start launches the package's
launcher via `monkey`, and stop uses `am force-stop`; packages without a launcher
may not start. Device overview includes raw lock indicators because Android
versions expose different fields.

### Approval and transport

The same loading approval and `tools/pre-execute` gate as the SSH packs apply. Root shell and root
pull always request call approval, even for `id`/`cat`. Non-root shell uses the SSH packs'
conservative read-only check; unknown commands and shell metacharacters ask.
Push and install always ask. `adb_pull` is statically high risk because its
`root` option can read protected files, so it requires individual loading via
the risk gate; ordinary non-root pulls need no additional call approval.
`adbAskInput: true` also asks for taps/input and app start/stop. The shared per-session
`allow` configuration can explicitly waive any of these questions.
`readOnly: true` removes all medium/high tools, including app current/list because
they share one medium-risk tool. The packs work independently of each other.

The process runner uses argv without a local shell. Because adb joins remote
command arguments, generated remote argv contain only fixed `shell -T sh` or
`shell -T su -c sh`; the command script is supplied on stdin. Built-in shell
arguments are individually POSIX-quoted. Arbitrary `adb_shell` scripts are
intentional code execution behind the gate. `-T` disables the PTY so screenshots
and pulls preserve binary bytes using modern adb shell transport. KernelSU is
used per command; `adb root` is never invoked. No physical device or host bridge
approval behavior was verified by the fake-runner tests.

### Files and limits

Local `local`/`apk` arguments are plain file names inside the shared `transferDir`
(default `~/dsh-transfers`), just like SSH transfers. No arbitrary paths,
traversal, leading dash, symlink source, directory or overwrite are accepted.
Push/install read through a bounded file descriptor and pass a private temporary
copy to adb, removing it afterward even on runner failure. Push uses standard
adb sync destination semantics: an existing remote directory receives the source
file. Use a full remote file destination for predictable naming. Both push and
install run with ordinary adb permissions; writing a protected root location
requires a separately approved `adb_shell` command after staging a file.
Install does not add replacement/downgrade flags.

Pull checks for a regular remote file (no recursive directory pulls),
using a bounded `head -c`, including with `su` when requested, and saves with exclusive creation. Remote
paths must be absolute without `.`/`..` segments, control characters or a trailing
slash, and inherit `denyPaths` and the SSH packs' credential-path guard. Remote symlinks
and a privileged shell can bypass path guards; this is not a filesystem sandbox.
Screenshots use unique names in `outputDir` (default `<transferDir>/screens`).
New local files have mode 0600, newly created directories 0700 on POSIX systems;
Windows access is governed by the directory's ACLs instead of these POSIX mode bits.
Local sources are checked with `lstat` before and after opening and matched to the
opened file's identity before reading. `O_NOFOLLOW` additionally rejects links
atomically where available; the `lstat` checks also apply when it is unavailable.

`maxTransferBytes` (default 50 MB) bounds files and screenshots; truncated binary
output is never saved. `maxBytes` (default 2 MB) bounds each text stream/UI dump,
`maxChars` (default 20000) bounds returned text, and `timeoutMs` (default 60000)
bounds commands. Connection attempts use 15 seconds; transfers/install use five
minutes. Shell `timeout_s` is clamped to 1–600 seconds. These limits stop the local
adb client; a disconnected/timed-out remote command may still continue on Android.
Outputs are redacted; audit summaries omit text input, UI contents and file
bodies. PNGs/transferred files retain their original bytes and may contain private
data; manage them in the configured directories.

There are no legacy `phone_*` aliases or duplicate adb executors in this repo.
Remove any separately installed legacy phone/adb provider from the host config
before enabling these tools; this package does not unregister external plugins.
The catalog declares observation/input under `adb` and shell/transfers under
`adb-root`, both in `device`; capability examples use `pack:adb`.

### Offline checks

```sh
npm run check
node --test test/unit/*.test.mjs
```

`test/unit/pack-control-adb.test.mjs` injects a fake adb runner and uses
`test/fixtures/pack-control/ui.xml`. It covers aliases, multiple devices,
wireless connection failures, argument injection, KernelSU argv/stdin, approval,
UI references, binary limits, file confinement and adapter registration, including
invalid Android configuration while both packs are disabled.

The full e2e tier (`TM_E2E_TIER=full node test/e2e.mjs /path/to/dsh`) also uses a
fake adb client. It checks disabled-pack visibility, `pack:adb` loading and UI
parsing through DSH, and verifies that an unapproved root shell call never
reaches the client. Loading approval is explicitly waived in that test profile
so the root call's own approval is tested separately.
