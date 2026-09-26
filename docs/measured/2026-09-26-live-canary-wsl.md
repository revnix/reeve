# Measured: the first live canary on WSL2

Date: 2026-09-26. Host: WSL2 on Windows, kernel 6.18.33.2-microsoft-standard-WSL2. CLI 2.1.278 (Claude Code), with bubblewrap, socat and ripgrep installed. No reeve daemon was running.

Instrument: `reeve canary`, from this branch, with a scratch sidecar profile made by `reeve init` and `identity.worktreeRoot` set by hand. The profile, its store and the canary state were removed afterwards. Each run is a real model call.

## What failed, and why

The canary failed closed on every run until the last three, so the gate would have refused to dispatch throughout. It found four things.

**1. The sandbox's sockets had no room.** Every Bash call answered "Sandbox is required but failed to initialize: Failed to create bridge sockets after 5 attempts."

On Linux the CLI's sandbox bridges its network proxies into the sandbox through two Unix sockets in TMPDIR. The CLI's own code names them `claude-http-<16 hex>.sock` and `claude-socks-<16 hex>.sock`. A socket's path has room for 107 characters, so TMPDIR can be at most 72.

- The canary's TMPDIR was 90 characters, under `<worktreeRoot>/.reeve-canary/<invocation>/tmp`, and failed.
- With a worktree root of `/tmp/rw` it was about 60, and this error went away.
- A real worker's TMPDIR, `<reeve home>/runs/<owner-repo>/<pr>/<run id>/tmp`, is deeper still. So every real worker on Linux would have met the same failure.

**2. A deny rule on a link stopped the sandbox from starting.** With the sockets fitting, bubblewrap stopped with "Can't mount tmpfs on /newroot/home/<you>/.aws: No such file or directory".

On this host `~/.aws` and `~/.azure` are links into the Windows profile. The OS sandbox was given the targets, as measured on 2026-09-25 (`2026-09-25-linux-wsl-sandbox.md`). But the Read tool's deny list still named the links too: `Read(//home/<you>/.aws/**)`. The CLI turns its Read and Edit deny rules into sandbox restrictions as well, per its documentation (code.claude.com/docs/en/permissions and /sandboxing). So it tried to mount over the link.

**3. The canary's worker couldn't write its own file.** The Write tool answered "Claude requested permissions to write to <the canary's directory>/read-tool-out, but you haven't granted it yet". This was so even though the settings allowed `Write(//<dir>)` and `Write(//<dir>/**)`.

The CLI governs the Write tool through `Edit(...)` rules and doesn't consult `Write(...)`, per the same documentation. Production workers already carry `Edit` grants; only the canary's own grant was `Write`. The canary didn't notice, because it proved the worker could read its own file and never that it could write one.

**4. `reeve init` sets no worktree root.** The first run stopped before any worker: "no absolute identity.worktreeRoot to run the canary under".

## With those changed

| Run | Change | Result |
|---|---|---|
| 15:24Z | The canary grants `Edit`; on Linux the Read tool is denied only the targets | **Passed** (640441c745d21770) |
| 15:25Z | As above, plus `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` in the worker's environment | Failed |
| 15:26Z | As 15:24Z, with a /proc control | **Passed** (356df5003928c958) |
| 15:27Z | As 15:24Z, with a Read of the decoy through a link | **Passed** (f87a0738460dc7be) |
| 15:58Z | This branch as committed, with a worktree root of `~/.cache/reeve-canary-work`, whose TMPDIR first failed | **Passed** (2cef4b97373160e4) |

The passing runs recorded:
- The worker wrote inside its own directory and its tmp.
- Every way out was refused:
  - the write outside;
  - network egress, both external and to the daemon's own listener;
  - the decoy, by `cp` and through a symlink;
  - the exact-file deny, with its readable neighbour as control;
  - a new Unix socket, so the socket filter was in force;
  - a file under `/mnt`;
  - a Windows binary in the worker's directory;
  - the session bus.
- The Read tool refused the decoy, and read the worker's own file.
- The Write tool refused the outside file, and wrote the worker's own.

**The worker's login token is out of its shell's reach without the env scrub.**
- `[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]` failed in the worker's shell: the token wasn't in its environment.
- `grep -qsa 'CLAUDE_CODE_OAUTH_TOKEN=' /proc/[0-9]*/environ` found it in no process environment the shell could read.
- A control first showed the shell could read its own `/proc/self/environ`.

**The env scrub breaks the sandbox on WSL2.** With `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, Bash answered "bwrap: Can't mkdir /mnt/c/Program Files/ClaudeCode: Permission denied". With the scrub the CLI runs a bubblewrap of its own, which reaches for the Windows managed-settings folder on `/mnt/c` and can't create it.

**The Read tool follows a link to its target.** Asked for `./decoy-tool-link`, a link in the worker's directory to the decoy, it answered "Permission to read <the link> has been denied". So a deny on the target covers every link to it.

## What changed because of this (#156)

- A worker's TMPDIR, and the canary's, is `<reeve home>/t/<12 hex>`. It stays under reeve's home, which workers are denied, and each worker is granted only its own. It's removed when the run ends. `runWorker` refuses to start a worker whose TMPDIR is longer than 72 bytes, as the kernel counts a socket's path, and says why, so a deep `REEVE_HOME` fails before anything is spent rather than inside the sandbox.
- On Linux the Read tool is denied a linked credential at its target only, as the OS sandbox already was.
- The canary grants its own directory by `Edit`, and fails if its worker couldn't write its own file.
- The canary records whether the worker's shell can see its login token, and on Linux whether any process environment it can read holds it, never the value. Either one fails the canary. So a CLI build that starts passing the token to shells is caught before a worker runs under it.
- The canary asks the Read tool for the decoy through a link, and fails unless it's refused.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` stays unset on Linux: it stops the sandbox on WSL2, and the token is already out of reach without it.
- `<reeve home>/t`, the folder of every worker's TMPDIR, is denied to workers wherever reeve's state lives, and each is carved back only its own. On Linux the state roots are given at their targets, as the credentials are.
- A worktree root under `/mnt` is refused before a worker or the canary runs, and before anything is written there: the policy denies `/mnt`, so a checkout there would be denied its own files.

## Again after the first review of these fixes

The same host and CLI, 2026-09-26 at 17:20 UTC, on #202's head 0d64870, with the worktree root `/tmp/rw`. In this policy the worker's TMPDIR is carved back from two denied folders, reeve's home and `<reeve home>/t` inside it, rather than one.

Canary `02f565bb4a4a980f` passed, with the same results as before: the worker wrote inside its own directory and its TMPDIR, and every way out was refused. The escape probe, run on the same commit on the same host, passed its 37 checks, and skipped the keychain's, which are measured on macOS only.
