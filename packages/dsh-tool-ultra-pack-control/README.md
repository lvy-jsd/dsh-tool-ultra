# @lvy-jsd/dsh-tool-ultra-pack-control

SSH control for [Tool Ultra](https://github.com/lvy-jsd/dsh-tool-ultra), written for small models: few tools, short schemas, host names instead of addresses. No npm dependencies; it runs the system `ssh`.

| Pack | Tools | Risk |
| --- | --- | --- |
| `ssh` (on by default) | `ssh_hosts`, `ssh_sys`, `ssh_read`, `ssh_log` | low |
| `ssh-exec` (off by default) | `ssh_run`, `ssh_write`, `ssh_put` (high), `ssh_get` (medium) | asks first |

Load one with `tools_load(["pack:ssh"])` or `tools_load(["pack:ssh-exec"])`.

```
ssh_hosts()                                  nix: root@nixos.lan
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
