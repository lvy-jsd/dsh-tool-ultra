# Control pack: PR0 probe results

What was checked before writing `dsh-tool-ultra-pack-control`, and what could not be checked from the inference host. Dates are 2026-11-12; DSH is 0.2.2-rc.1.

## Verified

| Question | Result |
| --- | --- |
| Does `{ kind: 'ask' }` from a `tools/pre-execute` hook stop an **ordinary** tool call, not only `tools_load`? | Yes. In the `control` e2e profile a changing `ssh_run` and `ssh_write` come back as `Error: tool "ssh_run" requires approval, but no approval channel is available` and the fake ssh client is never started. A read-only `ssh_run` goes through. (`test/e2e.mjs`, `control-main`; also runs in the CI `core` tier.) |
| Does `pack:<id>` load high-risk tools when a risk gate exists? | Yes (the gate had `allow: {'*': true}` in the test). So loading a pack does not by itself ask; the call-time gate is what protects `ssh-exec`. |
| Is the audit log written for refused calls? | No: a refused call never executes. Only calls that ran are recorded. |

## Facts about the inference host

- Node 24 is only in the Nix store, not on `PATH`; `npm run check` and the tests were run with it added to `PATH` and `DSH_APP` pointing at a directory holding `@deepseek-ai/dsh-tools@0.2.1-rc.5`, as CI does.
- `ssh` is OpenSSH 10.5. `adb` is not installed here (PR2 needs it on this host: wireless adb runs from the DSH host).
- The host's `~/.ssh/config` already defines Host aliases. `target` accepts such an alias, so an entry in `hosts` can reuse the keys and options configured there. No connection was made while probing.

## Not checkable from here (still open)

- The name the `dsh-oh-my-claude` bridge gives these tools for Claude Code, and whether an `ask` from this gate reaches the user there. Decide before PR3.
- Whether a tool result can carry an image inline (screenshots, PR2 onwards). Until then, screenshots are saved to a folder and read with `read_image`.
- The remote machine's display server (Wayland or X11) and compositor, needed to pick the desktop backend (PR4). Desktop and browser control reach a machine through the same `ssh` transport, and will support every host in the `hosts` config rather than a single one: their tools take the same `host` alias, and each host's display session is detected separately.
- KernelSU's `su` behaviour on the OnePlus 12 over wireless adb (PR2).
