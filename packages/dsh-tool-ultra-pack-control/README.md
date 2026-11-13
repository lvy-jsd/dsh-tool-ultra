# @lvy-jsd/dsh-tool-ultra-pack-control

SSH, Android, remote desktop and browser control for [Tool Ultra](https://github.com/lvy-jsd/dsh-tool-ultra), written for small models: few tools, short schemas, host aliases instead of addresses. No npm dependencies; it runs system clients and remote desktop utilities.

| Pack | Tools | Risk |
| --- | --- | --- |
| `ssh` (on by default) | `ssh_hosts`, `ssh_sys`, `ssh_read`, `ssh_log` | low |
| `ssh-exec` (off by default) | `ssh_run`, `ssh_write`, `ssh_put`, `ssh_get` (high) | asks first |
| `adb` (off by default) | `adb_devices`, `adb_info`, `adb_screen`, `adb_ui`, `adb_logcat`; `adb_tap`, `adb_input`, `adb_app` | low / medium |
| `adb-root` (off by default) | `adb_shell`, `adb_push`, `adb_pull`, `adb_install` | high |
| `browser` (off by default) | tabs, page text/refs, screenshots; open, click, type, key; eval | low / medium / high; mutations ask, eval always asks |
| `desktop` (off by default) | screenshots, windows, clipboard read; focus, click, type, key, clipboard write | low / medium; mutations ask |

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
- **Changing calls ask.** The `tools/pre-execute` gate resolves requests through DSH's approval service and retains a one-use permit bound to the execution token, session, tool, exact arguments and approval target. The registered executor checks this permit again. Missing/renamed hooks, changed arguments, unavailable approval and replay fail closed. Plain known reads (`uptime`, `ls`, `systemctl status`, `journalctl -u x`, ...) may run without approval; unknown options, option=value, systemctl value-taking flags, follow modes, shell syntax and `cwd` require approval. `allow` can waive ordinary shell/browser/ADB-input questions, but cannot waive SSH write/upload, ADB push/install/root, desktop mutations or browser eval. Arguments over 4096 JSON characters and commands over 300 characters require approval even with `allow`.
- **Approval shows the action.** Localized prompts contain complete raw command/JS/text/file bodies, URLs, paths, keys, refs and window IDs. They are never redacted or shortened by this package. Browser ref prompts also show the bound tab and snapshot element. The durable approval reason and control audit use separate body-free summaries. Treat approval displays as sensitive.
- **No shell on this side.** The ssh client is started with an argument vector. On the remote side every script runs as `sh -c '<script>'` with quoted arguments, and file contents travel on stdin, not in the command line.
- **Credentials stay out of view.** The read tools refuse `/etc/shadow`, SSH private keys, host keys and `/proc/*/environ` / `/proc/*/task/*/environ` (path segments such as `..` are collapsed first; add more with `denyPaths`), and private keys or `password=...` style values in any output are masked. This is a guard against reading them by accident, not a boundary: a command someone approved can still do anything, and a symlink gets around a path check.
- **Files move through one folder.** `ssh_get` saves and `ssh_put` reads only inside `transferDir` (default `~/dsh-transfers`), by plain file name, never overwriting, up to `maxTransferBytes`. Upload sources are bounded regular-file descriptors with before/after identity and no-follow checks shared with ADB. New files use 0600 and directories 0700 on POSIX. SSH connection reuse uses an unpredictable private temporary directory whose ownership/mode are checked.
- **A record.** Approval/rejection and execution results are appended to `<DSH_HOME>/tool-manager/control-audit.jsonl` as separate `event` values (`approved`, `denied`, `result`). Paths and requested URLs are recorded; command/JS source, input/clipboard text, UI labels and file bodies are omitted. A nonzero transport exit or timeout fails the registered DSH tool and records `ok: false`, even when a plain spec formats it as text. New audit files use 0600. This control audit is separate from DSH's own session/approval logs.
- **Read-only means no intended mutation.** It does not mean non-sensitive: root file reads, logged-in page text, clipboard reads and screenshots can expose secrets. `readOnly` preserves low-risk observation tools; it is not a confidentiality sandbox. Use `disable` and host capability whitelists to narrow access.

Pair this pack with `@lvy-jsd/dsh-tool-ultra-risk-gate`: it asks before a high-risk tool is loaded, this pack asks before it is used.

## Config

See [`cordis.patch.yml`](cordis.patch.yml): `packs`, `readOnly`, `disable`, `hosts`, `allow`, `auditFile`, `transferDir`, `denyPaths`, plus `sshBin`, `multiplex`, `connectTimeoutS`, `timeoutMs`, `maxBytes`, `maxChars`, `maxTransferBytes`.

`target` can be `user@host` or a Host alias from `~/.ssh/config`, so keys, jump hosts and ports can live there.

Legacy flat settings remain valid. Optional `packConfig.ssh`, `.adb`, `.desktop`
and `.browser` objects override the corresponding package's inherited settings
(`ssh` also configures `ssh-exec`; `adb` also configures `adb-root`). An override
such as `hosts` replaces that map. Browser inherits legacy numeric limits clamped
to its own supported range, so a shared 50 MB transfer cap or 600 s timeout does
not prevent any pack from starting. Explicit browser overrides are validated
strictly. Disabled packs do not construct or validate their transport.

```yaml
maxTransferBytes: 50000000  # old flat setting still works with browser enabled
packConfig:
  browser: { maxTransferBytes: 10000000, timeoutMs: 30000 }
hosts:
  workstation:
    target: user@desktop.example
    packs: [desktop, browser]  # exact whitelist, including exclusion from SSH reads
  server:
    target: root@server.example
    packs: [ssh, ssh-exec]
```

Omitting `hosts.<alias>.packs` preserves legacy access from every enabled host
pack; an empty list grants none. Pack-local host tables can also separate hosts.
`allow` matches `agent.session.id`, with the agent ID and `*` as fallbacks.


## Remote desktop: `desktop`

Every desktop tool requires `host`, an alias from the **same `hosts` table as SSH**.
It always operates on that remote Linux machine through SSH, including when DSH
runs on a different OS. It never detects or controls the DSH server's own desktop.
SSH keys/agent, port, identity, `~/.ssh/config` jump hosts, `sshBin`, multiplexing
and time/output limits are shared with the SSH packs. `desktop` also works with
both `ssh` and `ssh-exec` disabled; list configured aliases in the panel/config
or enable `ssh_hosts` if needed.

```yaml
packs: { ssh: true, desktop: true }
hosts:
  example-desktop:
    target: 'root@desktop.example'
  example-wayland:
    target: 'user@wayland.example'
    port: 2222
    # Optional overrides. Omit desktop entirely for automatic discovery.
    desktop:
      # Select an account when several users have active graphical sessions.
      user: example-user
      backend: sway
      env:
        WAYLAND_DISPLAY: wayland-1
        XDG_RUNTIME_DIR: /run/user/1000
        SWAYSOCK: /run/user/1000/sway-ipc.example.sock
        # Optional override of inherited / automatically found ydotoold socket.
        # It must serve this graphical seat. The pack never starts a daemon.
        YDOTOOL_SOCKET: /run/user/1000/example-ydotool.sock
outputDir: /path/to/screenshots
desktopCacheMs: 3000  # successful sessions per alias; 0 disables caching
```

Load with `tools_load(["pack:desktop"])`.

| Tool | Arguments after required `host` | Result / risk |
| --- | --- | --- |
| `desktop_screen` | — | image attachment when available + local private PNG path / low |
| `desktop_windows` | — | native IDs, titles, apps, focus, available geometry / low |
| `desktop_clipboard_get` | — | bounded, redacted clipboard text / low |
| `desktop_focus` | `window` | focus exact native window ID / medium, asks |
| `desktop_click` | `x`, `y`, `button?` | one left (default), middle or right click / medium, asks |
| `desktop_type` | `text` | type literal UTF-8 into the currently focused window / medium, asks |
| `desktop_key` | `combo` | one key or combination / medium, asks |
| `desktop_clipboard_set` | `text` | replace clipboard text; empty string allowed / medium, asks |

Example tool arguments:

```json
{"host":"example-desktop"}
{"host":"example-desktop","window":"0x0000002a"}
{"host":"example-wayland","window":"42"}
{"host":"example-desktop","x":120,"y":340,"button":"left"}
{"host":"example-desktop","text":"Example's 中文 text"}
{"host":"example-desktop","combo":"ctrl+l"}
{"host":"example-wayland","combo":"super+shift+F12"}
```

Inspect windows/screenshots before input. Focus takes IDs, never window names,
regular expressions or compositor command syntax. Sway and niri use decimal
IDs; Hyprland uses a hexadecimal address; X11 accepts its native hexadecimal or
decimal ID. Window listings use JSON lines so quotes/newlines in titles are
escaped. Keys accept `ctrl`, `alt`, `shift`, `super` (`win`/`meta`), plus a letter,
digit, F1–F24, Return/Enter, Escape/Esc, Tab, Space, BackSpace, Delete, Insert,
Home, End, PageUp/PageDown, arrow keys, `plus` or `minus`. Multiple key sequences,
raw options, and shell fragments are refused. Coordinates are integers 0–100000.
Wayland clicks pass these coordinates unchanged to `ydotool mousemove --absolute`.
This is **not a guaranteed screenshot-pixel coordinate API**: upstream ydotool
resets toward the top-left using large negative relative motion, then applies
relative x/y motion. Acceleration, sensitivity, output arrangement, gaps, negative
origins, mixed/fractional scaling and rotation can all break alignment. Even a
single output needs its virtual pointer's acceleration/sensitivity calibrated.
There is no automatic per-output transform. Start on a single output at scale 1
with flat acceleration, verify a harmless click with a new screenshot, and
calibrate before using other layouts. The pack never changes input settings.
Do not equate niri's workspace-view geometry with global screenshot coordinates.

### Graphical sessions and prerequisites

Discovery uses POSIX shell syntax, Linux coreutils (`id`, `stat`, `base64`, `tr`,
`cut`) and GNU `grep -z`. **Python and jq are not required.** `loginctl` and
`getent` are used when available; passwd, live `/run/user/<uid>` Wayland sockets,
X sockets and process environments provide the fallback. Missing required
commands produce a clear error; no files are installed remotely. The probe
filters NUL-delimited `/proc/*/environ` entries before base64 transport. Only
whitelisted graphical variables and session IDs leave the host. Values are
decoded and selected locally, never sourced or evaluated as shell code.

With **root SSH login**, discovery chooses the unique active non-root graphical
user session. logind's active X11/Wayland user sessions take precedence; inactive,
closing and greeter sessions are excluded. Without logind information, the
fallback requires a unique live graphical session from sockets/processes.
Xauthority and compositor IPC environment are recovered from that user's
processes, including when SSH has no DISPLAY/WAYLAND_DISPLAY/runtime variables.
An Xwayland DISPLAY inside the selected Wayland session does not select X11.
Multiple candidates refuse to run: set `hosts.<alias>.desktop.user` to the
graphical account name or UID. If that user has multiple sessions, also select
the display in `desktop.env`; ambiguous associations still refuse.

Root desktop commands always drop to that account before checking/starting any
graphical utility. `setpriv` (util-linux) is preferred: real/effective UID and GID
are changed, supplementary groups initialized, capabilities dropped and
`no_new_privs` set. If absent, `runuser -u USER -- ...` is the fallback. If neither
exists the action fails; it never runs the GUI command as root. The child gets a
clean environment with the selected HOME/USER/LOGNAME, UTF-8 locale, standard
system executable paths and that user's Nix profile paths. User profiles are
not sourced and root's HOME/PATH/secrets are not passed through. See upstream
[setpriv](https://github.com/util-linux/util-linux/blob/master/sys-utils/setpriv.1.adoc)
and [runuser](https://github.com/util-linux/util-linux/blob/master/login-utils/runuser.1.adoc).

Non-root SSH logins still discover and execute only their own UID's desktop.
Specifying another account is rejected; no sudo, su or privilege elevation is
attempted. For either login type, explicit `desktop.env` may supply missing
session variables but cannot authorize switching a non-root login's UID.

`desktopCacheMs` defaults to **3000 ms** per host alias (0 disables it; maximum
30000). Only successful discovery followed by successful execution is cached;
successful actions do not extend its original expiry. Failures, timeouts,
truncation and invalid tool output clear that host's entry. Every action,
including a cache hit, checks the effective UID, socket owner/inode and selected
logind session's active state when available. Cache expiry triggers new discovery
of other/new sessions. Failed actions are never automatically replayed; the
next explicit call probes again. Hosts and factory instances never share cache.

`hosts.<alias>.desktop.backend` can be `x11`, `sway`, `hyprland`, `niri` or generic
`wayland`. `desktop.env` overrides are applied per host to discovery and commands.

### NixOS + niri

Install the prerequisites in your NixOS configuration, for example:

```nix
programs.ydotool.enable = true;
users.users.example.extraGroups = [ "ydotool" ];
environment.systemPackages = with pkgs; [ grim ];
# Optional clipboard tools: wl-clipboard
```

Apply the configuration and re-login so group membership takes effect. The pack
uses the already running `ydotoold` and the graphical user's permissions; it does
not start services, install packages or run sudo. A minimal host entry is enough:

```yaml
hosts:
  laptop: { target: 'example@laptop.example' }
packs: { ssh: false, desktop: true }
```

Discovery uses remote `/proc` environments, logind and live sockets, including
`XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, `WAYLAND_DISPLAY` and `NIRI_SOCKET`.
niri with an Xwayland-satellite `DISPLAY=:0` still selects Wayland; partial
Wayland environments are associated with an unambiguous live Wayland socket.
Pure X11 keeps the existing tools. Explicit `desktop.backend` remains an override.

niri uses `grim -t png -` (wlr-screencopy) and ydotool for **both mouse and keyboard**.
For each input command, after switching to the graphical user, socket selection
uses `desktop.env.YDOTOOL_SOCKET`, then the discovered session's `YDOTOOL_SOCKET`,
then the first socket that exists and is writable in this order:

1. `/run/ydotoold/socket` (NixOS)
2. `$XDG_RUNTIME_DIR/ydotoold/socket`
3. `$XDG_RUNTIME_DIR/ydotool.sock`
4. `$XDG_RUNTIME_DIR/.ydotool_socket`
5. `/tmp/.ydotool_socket`

A selected explicit/inherited socket that is missing or inaccessible is an error;
it does not silently fall through to another daemon. ydotool injects into a seat,
not a window or user session. On multi-seat systems configure the socket serving
the intended seat explicitly; session selection cannot prove the daemon's seat.

`desktop.keyboard: ydotool | wtype` selects the Wayland keyboard backend per host.
The default is ydotool on niri, wtype on other Wayland compositors. ydotool typing
supports printable ASCII, tab and newline using US key positions; other text is
rejected before input instead of silently losing Unicode bytes. Its key combos
use Linux evdev codes with modifiers released in reverse order. The compositor's
active layout and held physical modifiers still affect input. `wtype` remains
available for UTF-8 when the compositor exposes virtual-keyboard; there is no
automatic retry or clipboard-paste fallback that could duplicate input.

`desktop_windows` queries `niri msg --json windows` and `focused-window`, then
uses the returned native id for `niri msg action focus-window --id <id>`. A null
focused window means no application window has focus (e.g. a layer surface).
The two reads are consecutive snapshots, not atomic. Newer niri releases provide
`layout`, retained in the result; `rect` is derived from tile position + window
offset and window size, in **workspace-view logical pixels**, with `workspace_id`.
Missing geometry on older versions stays absent. It is not global output geometry
and must not be fed directly to ydotool as screenshot pixels.
Supported keys are `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`,
`XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, `SWAYSOCK`,
`HYPRLAND_INSTANCE_SIGNATURE`, `NIRI_SOCKET`, and `YDOTOOL_SOCKET`. No PATH,
loader, shell, or arbitrary environment overrides are accepted. For X11, use
`backend: x11` with `DISPLAY` and optionally `XAUTHORITY`; absent `XAUTHORITY`
uses Xlib's normal `~/.Xauthority` behavior. Compositor IPC sockets can be
recovered from inherited environment or unique matching runtime sockets; if
multiple compositors/displays cannot be associated safely, supply the overrides.
Socket paths change after login/restart; update explicit values accordingly.

| Operation | X11 | Wayland |
| --- | --- | --- |
| Screenshot | `scrot -F -` | `grim -t png -` |
| Windows / focus | `wmctrl`, `xdotool` / `xdotool` | `swaymsg`, `hyprctl` or `niri msg` |
| Type / keys | `xdotool` | niri: `ydotool`; others: `wtype`; configurable with `desktop.keyboard` |
| Click | `xdotool` | `ydotool` and an accessible existing daemon socket |
| Clipboard | `xclip` | `wl-paste` / `wl-copy` (`wl-clipboard`) |

Missing commands name the exact utility and NixOS package; nothing is
automatically installed. Wayland also needs the relevant compositor protocols:
`grim` needs wlr-screencopy or compatible ext-image-copy-capture support in the
installed versions; `wtype` needs virtual-keyboard support; wl-clipboard needs
compatible clipboard protocols. Unknown Wayland compositors (including setups
that do not expose these protocols) report unsupported operations/command errors;
there is no Xwayland, portal, privileged input, or clipboard-paste fallback.
Generic `wayland` does not enumerate/focus native windows. The niri native
screenshot action is deliberately unused because it also modifies the clipboard.
See the upstream [niri action definitions](https://github.com/niri-wm/niri/blob/main/niri-ipc/src/lib.rs),
[wtype](https://github.com/atx/wtype), [grim](https://sr.ht/~emersion/grim/),
and [ydotool](https://github.com/ReimuNotMoe/ydotool) for protocol/version requirements.

### Approval, files and boundaries

All focus/input/clipboard-write calls ask through the existing `tools/pre-execute`
gate **before even the SSH probe runs**. Desktop mutation questions cannot be waived by `allow`. A session without an approval channel is
refused. `readOnly: true` keeps screenshot, window list and clipboard read only;
clipboard read/write are separate tools to preserve this distinction.

Literal typing and clipboard text (up to 20000 UTF-8 bytes, no NUL) travel on SSH
stdin, never in a remote command. Keys and IDs are strictly validated; remote
argv/environment values are individually POSIX-quoted. Audit summaries omit
typed text, clipboard contents and window titles. Output is bounded/redacted;
PNGs retain original bytes and may contain private information.
Typing newlines/tabs and pressing Return can submit or activate UI. Input can
do anything the remote user's foreground application allows; these medium-risk
tools are not an application-level sandbox. Focus can change externally between
inspection and input. Clipboard writes retain a background owner using the
existing clipboard utility; they do not create a desktop-control service.

Screenshots are currently full-desktop only: no region/window capture, double
click, or application launch API. Launching applications remains available only
through separately approved `ssh_run`, if enabled. Screenshots are saved in
`outputDir` (default `<transferDir>/screens`) with generated unique names,
exclusive creation and mode 0600 (new folders 0700 on POSIX). Binary timeout,
failure, truncation, byte-limit overflow or a non-PNG signature never saves an
image. `maxTransferBytes` defaults to 50 MB; `maxBytes`, `maxChars`, `timeoutMs`
and SSH connection limits match the other packs. An SSH timeout stops the local
client; it cannot guarantee an already-started remote action was cancelled.

`test/unit/pack-control-desktop.test.mjs` uses a fake SSH runner, including both
destinations, all backends, command/data injection boundaries, call approval,
binary files, root/non-root session snapshots, active/inactive/greeter sessions,
user selection, privilege-drop wrappers and cache expiry/failure invalidation.
No Python is needed by these tests. The full e2e tier has `control-desktop` and
disabled-pack scenarios with fake X11/Wayland SSH hosts. It checks pack loading,
native lists, PNG bytes, clipboard read, unknown aliases and that every refused
mutation leaves the SSH log untouched. Its root SSH host must use a privilege-drop
wrapper; caching is disabled there for deterministic invocation counts.
No physical desktop/host bridge behavior
is proven by these fake-host tests.

### Screenshot images sent to the model (desktop and browser)

`desktop_screen` and `browser_shot` share the DSH adapter's image result path.
Both first save the original bounded PNG privately. With a mounted DSH
`attachments` service, the adapter calls `attachments.saveImage` with the actual
PNG bytes; DSH validates/normalizes and stores the image. The canonical result
contains the text path and durable image reference. `defineTool.output.render`
returns **two model-facing content blocks**: text and `{ type: 'image', attachment }`,
matching the host's built-in `read_image`. `presentResult`/`presentation.d.ts`
describe UI presentation only and are not used to deliver the image.

The installed DSH `dsh-llm-pi-ai` adapter resolves that attachment's request bytes
and emits an image content block to its provider; OpenAI-compatible routes send
an `image_url` data URI. This is image content, not a path/base64 string inside
text. Configure your vision route to declare `input: [text, image]` (or the
provider's `defaultInput`); a text-only model/adapter cannot consume these images.
DSH can downscale images during storage or request projection. The result reports
stored dimensions and original dimensions when normalized; DSH's request-image
handle supplies further request scaling information. Account for both before
measuring positions, and for the separate ydotool calibration limits above.

Without an attachment service, or if its decode/limits/storage rejects the image,
the result explicitly says **Image not attached**, explains why and retains the
path for `read_image` or another front end. Plain `createTools().execute` callers
still receive `screenshot: <path>`; image attachment is performed by the DSH
adapter, not by the SSH/CDP transport. No additional capture or clipboard write
is used for the image result.

Fake-runner unit tests cover actual captured bytes reaching `saveImage`, the
separate model image block for both tools, normalization metadata and fallback.
The full e2e tier additionally checks actual image blocks/decoded raster bytes
in the fake model's HTTP request. `control-desktop-niri` adds an Xwayland-enabled
fake niri host with explicitly allowlisted focus/click/type/key calls and checks
socket discovery and evdev command construction. These are mock-host tests;
real NixOS/niri pointer alignment and a real vision model still need a live run.

```sh
npm run check
node --test test/unit/pack-control-{desktop,browser}.test.mjs
TM_E2E_TIER=full node test/e2e.mjs
```

## For other front ends

`createTools(options)` returns plain objects (`name`, `pack`, `risk`, `description`, `parameters`, `approve`, `describe`, `execute`) with no DSH types in them, and `gate(specs, allow)` is the approval decision. The enforced adapter requires DSH to provide an execution token and approval service; hosts without them refuse calls requiring approval. These are low-level implementations, not an approval-enforcing endpoint. An adapter must enforce approval and provide trusted per-session scope; use the DSH `apply` adapter for the enforced boundary. Do not expose raw specs as an MCP server or bridge endpoint. `options.exec` replaces the process runner, which is how the tests run without a network.

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
adbAskInput: true
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
Call `adb_ui` before tapping by number/text. Snapshots are separate per session and device,
expire after `adbUiTtlMs`, and are invalidated by physical-device input, app changes, shell,
upload and install (even if execution fails). Ambiguous labels require a fresh
snapshot or explicit coordinates. External UI changes can still make a reference
stale before its timeout; refresh whenever the phone changes. UI dumps require
uiautomator and return the accessibility hierarchy in a JSON `untrusted_android_content` envelope; custom canvas surfaces
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
the risk gate; ordinary non-root pulls need no additional call approval. SSH downloads are also high risk, since the configured SSH user may be root.
`adbAskInput` defaults to true for taps/input and app start/stop; false is an explicit administrator opt-out. `allow` can waive those input questions and non-root shell questions, but never push/install or root shell/pull approval.
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

## Remote browser: `browser`

This opt-in pack controls Chrome/Chromium **on each configured remote host** via
CDP over SSH. It never connects to a browser on the DSH computer. Node **22 or
newer**, its built-in `WebSocket`, and OpenSSH are required; no npm dependencies
are added. Browser tools work with the SSH/desktop packs disabled.

```yaml
packs: { ssh: false, browser: true }
hosts:
  example-browser: { target: 'user@browser.example' }
  example-secondary:
    target: 'root@secondary.example'
    port: 2222
    identity: '/example/ssh-key'
    browser: { port: 9333 }  # default CDP port: 9222
browserAllowPrivate: false
# outputDir: /example/browser-screens
# maxChars: 20000
# maxBytes: 16000000
# maxTransferBytes: 10000000
# timeoutMs: 30000
```

On the **remote machine**, manually run this in the graphical user's session
(adjust the executable/port for that host):

```sh
chromium --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.local/share/dsh-browser-profile"
```

Keep debugging bound to remote loopback; never expose the CDP port to a network.
Verify the listener using `ss -ltnp` on that machine. Recent Chrome requires a
**non-default user data directory** for remote debugging; see the
[Chrome 136 change](https://developer.chrome.com/blog/remote-debugging-port).
Use an existing dedicated debugging profile or log in to the sites in this
profile once. This pack cannot attach retroactively to an ordinary Chrome
process started without debugging. Missing/unreachable CDP produces this startup
hint; nothing starts, restarts or installs a browser automatically.

Root SSH works without DISPLAY, Wayland variables or graphical user discovery:
SSH only forwards TCP and runs `getent` for URL validation. CDP controls the
browser already running as its graphical user. The desktop pack's session
selection/drop-UID machinery remains for desktop commands; browser tools launch
no GUI program and need no root browser or `--no-sandbox` workaround.

### Tools and workflow

Every call requires `host`. `tab` is the **stable tab ID** from `browser_tabs`,
not its display row number. With exactly one page tab it is selected
implicitly; with several tabs, explicitly select one. Subsequent calls reuse
the selected tab per session and host. If it closes, refresh the list and select again.

| Tool | Additional arguments | Result / risk |
| --- | --- | --- |
| `browser_tabs` | — | Up to 200 page tabs, numbered rows plus stable IDs; low |
| `browser_page` | `tab?`, `mode: text\|refs` (default text) | Plain visible body text; refs adds up to 100 visible interactive elements; low |
| `browser_shot` | `tab?` | Viewport PNG saved locally, path for `read_image`; low |
| `browser_open` | `url`, `tab?`, `new_tab?` (default true) | Navigation requested and stable tab ID; medium, asks |
| `browser_click` | `ref` | Click the exact numbered element; medium, asks |
| `browser_type` | `ref`, `text`, `submit?` | Focus editable element and insert literal text; optional Enter; medium, asks |
| `browser_key` | `tab?`, `key` | One key/combo; medium, asks |
| `browser_eval` | `tab?`, `js` | Arbitrary JavaScript in the page main world; high, **always asks** |

Load with `tools_load(["pack:browser"])`. Pair with risk-gate for high-risk load
approval. The call gate applies after loading: `allow` may waive the medium-risk
questions as with desktop, but **cannot waive `browser_eval` approval**. With no
approval channel, eval is refused even for an allowlisted unattended session.
`readOnly` removes every browser mutation/eval tool; `disable` works normally.
Audit descriptions include requested URLs and tab/ref IDs, but omit typed text and JavaScript source. Approval displays include their complete raw content.

Start with `browser_tabs`, then `browser_page(host, tab, mode="refs")`. Copy a
ref exactly, such as `a1b2c3d4:3`: the suffix is the element number and the prefix
identifies that snapshot. `browser_click`/`browser_type` select the tab bound to
that host's snapshot, so a ref cannot silently switch to another host/tab.
Refresh refs after every input or navigation. A new snapshot, attempted
mutation, error or failed refresh invalidates the old refs. Navigation/reload,
removed nodes, disabled/covered elements and lost focus refuse input rather
than re-finding another matching element. A page can still change between the
last geometry check and dispatch; inspect again after consequential input.

Snapshot references are stored **locally**, keyed by session, host, tab and generation. Calls without an identified session cannot use the registered reference tools.
Snapshot code runs in an isolated CDP world and uses `DOM.describeNode` to save
only the elements' `backendNodeId` values, plus the main frame/loader identity.
Each click/type creates its own isolated context and uses `DOM.resolveNode` with
that context to obtain a fresh object handle, then `Runtime.callFunctionOn` to
check connectivity, owner document, visibility/occlusion and editability before
input. Navigation to a different frame/loader or a missing/detached node reports
a stale ref. Neither context IDs nor runtime object handles survive a call;
temporary object groups are released on success and failure. No page globals,
attributes or instruction text hold the refs. Snapshot/click/type inspect the
main frame's light DOM only: cross-origin frames and shadow-root traversal are
not supported. Text is plain body text rather than Markdown; hidden fields and
input values are not included intentionally. Typing inserts at the current
caret/selection; it does not automatically erase existing text. Keys use the
same bounded vocabulary as desktop (`Enter`, arrows, `ctrl+a`, etc.).
`browser_open` returns as soon as navigation is requested; call `browser_page`
for the resulting title/URL/content instead of assuming the page has loaded.

### Tunnels, limits and trust

Each call owns one **foreground** SSH process. On POSIX it forwards
`-L PRIVATE_SOCKET:127.0.0.1:REMOTE_PORT`: the local Unix socket lives in a
fresh 0700 temporary directory, with `StreamLocalBindMask=0177`. HTTP discovery
and bounded WebSocket frames use that socket directly, without a local TCP CDP
listener. Cleanup removes the directory after the owned SSH process exits.
On Windows calls fail closed unless `browserAllowLocalTcp: true` explicitly
opts in to `-L 127.0.0.1:PORT:127.0.0.1:REMOTE_PORT`. This unauthenticated
loopback fallback requires all local users to be trusted. The remote
Chrome loopback endpoint likewise requires a trusted remote host.
The existing SSH transport supplies alias validation, authentication, identity,
SSH port, jump-host configuration and timeouts. Forwarding is deliberately
**not multiplexed**, even if ordinary SSH commands use ControlMaster: a shared
master could retain a forward after its requesting session ends. There is no
idle tunnel/cache to dispose: success, callback errors, CDP errors, timeouts and
abort all close the WebSocket, close stdin and kill/await the owned SSH process
in `finally`. DSH exit closes the stdin pipe so the remote keeper and SSH session
also end. SSH configs must permit a noninteractive remote POSIX shell, `cat`
and local forwarding; interactive login banners must not block the session.

`ExitOnForwardFailure` confirms SSH owns the bind before CDP connects. The
Windows fallback reserves an OS-selected port before SSH binds it. Bind collisions retry up to three times **before** running any CDP
operation; page actions are never automatically replayed. Calls serialize per
host to preserve snapshot/input order; different aliases can run independently.
CDP discovery never follows redirects or an advertised external WebSocket host:
only the remote loopback browser endpoint is accepted and its path is connected
through the owned local forward. CDP follows the upstream
[Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/) and
[Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) domains.

`browser_open` accepts only HTTP(S), rejects embedded credentials, and defaults
to refusing private/reserved IPs, localhost/local names and private DNS answers
(including mapped IPv6). Hostname checks use **remote** `getent ahosts`, not DSH's
DNS. Missing getent, failed DNS, empty/mixed private answers or truncated
validation output fail closed. `browserAllowPrivate: true` is an administrator
opt-in for initial private destinations; it never enables file/javascript/data
URLs. This is an initial-URL guard, **not a network sandbox**: DNS can change
between check/use, Chrome may use different DNS/proxy settings, and redirects,
subresources, page scripts, clicks, key input and approved eval can contact
other destinations. Existing private tabs remain readable. Use actual browser/
network isolation if destination restrictions must be enforced.

Page titles, URLs, snapshots, eval values and CDP page errors are untrusted data.
Model-facing page output is one JSON envelope marked
`trust: "untrusted_browser_content"`, with an escaped `content` string and a
`truncated` flag. Page strings never enter tool schemas, descriptions or
audit summaries. Approval displays may show the snapshot label as target data, never as policy. This separates data from instructions; it cannot
make arbitrary page text safe to obey.

Output is capped by `maxChars` (default 20000, allowed 128–200000), including the
JSON envelope. CDP requests/replies are checked against `maxBytes` (default 16 MB,
range 1 KB–64 MB); discovery is limited to 64 KB. The POSIX Unix client rejects oversized advertised frames and bounds fragmented
messages before assembling them; the Windows built-in WebSocket assembles a
message before the application checks its size. `timeoutMs`
(default CDP 30 s; allowed 100 ms–120 s) bounds CDP requests and the SSH tunnel's
whole lifetime (SSH default 60 s when unset). Screenshots default to at most
10 MB (`maxTransferBytes`, range 1–40 MB) and must have a PNG signature. They use
exclusive UUID filenames, mode 0600, under `outputDir` or
`<transferDir or ~/dsh-transfers>/browser`. No remote screenshot file is written.
The DSH adapter attaches the captured image as described in “Screenshot images
sent to the model” above; the private PNG path is retained as well.
Text/eval truncation keeps valid outer JSON; the nested content string may
contain an incomplete representation of page data. Refs precede body text to
keep the actionable list visible under the output cap.

### Tests

```sh
npm run check
node --test test/unit/pack-control-{ssh,adb,desktop,browser}.test.mjs
TM_E2E_TIER=full node test/e2e.mjs /example/path/to/dsh
```

The browser unit suite uses a fake SSH runner and a local CDP HTTP/WebSocket
server built only from Node modules. It covers aliases/ports, readOnly/disable,
call gates, remote DNS/private URLs, untrusted/truncated content, literal input,
ref invalidation, screenshots, protocol failures/timeouts and tunnel cleanup.
The fake CDP assigns new sessions, contexts and object handles for each connection
and a fresh world for every createIsolatedWorld call. Regression tests verify
click/type across these boundaries using backend IDs, plus stale-node/navigation
failures and temporary-handle cleanup.
It skips listener/child-process cases when sandbox permissions prohibit them;
an in-memory CDP test still executes the actual isolated-world snapshot/input
scripts. For hosts that cannot fork the Node test runner, use
`node --test --test-isolation=none ...` on Node versions supporting that option.
The full-tier e2e profile uses two fake SSH hosts and the actual Unix/built-in WebSocket
client, checks local screenshots and proves refused calls never reach SSH. It
requires a complete DSH installation and does not touch a real browser.
