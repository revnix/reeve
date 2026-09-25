# The worker sandbox on Linux and WSL2: what gets out, and what closes it

**Measured 2026-09-25** on WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2,
Ubuntu 26.04.1, x86-64), Node 24.21.0, `@anthropic-ai/sandbox-runtime` 0.0.73
(`srt`), bubblewrap 0.11.1 and socat 1.8.1.1, against the policy `sandboxFor`
generates on branch `feat/linux-sandbox` (#156).

## Why it was measured

The sandbox was measured on macOS only, and dispatch is refused on any host that
hasn't been. #156 found, from inside bubblewrap on WSL2, that `/mnt/c/Users` was
readable and that a Windows `cmd.exe` ran. This measures every way out it names,
under the runtime's own sandbox, before the containment gate may accept Linux.

## The probe

One shell script, run three ways from a worktree under `~/.cache`:

- **control:** unsandboxed, so each shape is shown to work here at all;
- **main:** under `srt`, with the policy minus the host denies this branch adds;
- **branch:** under `srt`, with the policy as generated.

The two sandboxed runs are repeated with `allowAllUnixSockets: true`, which turns
off the runtime's seccomp filter, as on a host where it can't be applied. Only
exit codes are recorded. No credential file is read: a decoy file stands in for
gh's config. A Windows binary is copied into the worktree first, as a repository
could commit one.

## Results

`0` means the shape worked.

| Shape | control | main | branch | main, no seccomp | branch, no seccomp |
|---|---|---|---|---|---|
| `test -d /mnt/c/Windows` | 0 | **0** | 1 | **0** | 1 |
| `test -d /mnt/c/Users/Public` | 0 | **0** | 1 | **0** | 1 |
| read `/mnt/c/Windows/System32/drivers/etc/hosts` | 0 | **0** | 1 | **0** | 1 |
| run `/mnt/c/Windows/System32/cmd.exe` | 0 | 1 | 127 | **0** | 127 |
| run a `.exe` committed to the worktree | 0 | 1 | 1 | **0** | 1 |
| `/run/WSL`, WSL's interop sockets, has entries | 0 | **0** | 1 | **0** | 1 |
| the session bus socket is visible | 0 | **0** | 1 | **0** | 1 |
| connect to the session bus | 0 | 1 | 1 | **0** | 1 |
| connect to the system bus | 0 | 1 | 1 | **0** | 1 |
| `systemd-run --user` starts a command outside | 0 | 1 | 1 | 1 | 1 |
| create a Unix socket | 0 | 1 | 1 | **0** | **0** |
| read a decoy in `~/.config/gh` | 0 | 1 | 1 | 1 | 1 |
| write outside the worktree | 0 | 1 | 1 | 1 | 1 |
| the network (`curl https://example.com`) | 0 | 7 | 7 | 7 | 7 |

## What it shows

- **Without the host denies, a sandboxed shell reads the Windows drive:** its
  system folder and every user's folder under `/mnt/c/Users`. The seccomp filter
  doesn't touch file reads; only denying `/mnt` closes this.
- **The seccomp filter is what stops Windows interop and D-Bus today.** It
  blocks creating a Unix socket, and both need one. With it off, a Windows binary
  runs, from `/mnt` or committed to the worktree, and both buses answer. Denying
  `/run/WSL`, `/run/user/<uid>` and `/run/dbus` closes them without it.
- **A deny path reached through a symlink stops the sandbox from starting.**
  On this host `~/.aws` and `~/.azure` link to `/mnt/c/Users/<you>/`, as WSL
  setups commonly do. With either in the deny list, bubblewrap refused:
  `Can't mount tmpfs on /newroot/home/<you>/.aws: No such file or directory`, and
  nothing ran. Denying the link's target works, and covers every path that
  reaches it. `osCredentialPaths` now gives a linked credential path to the
  sandbox at its target, on Linux only.
- **A deny path that isn't there yet is passed over** by the runtime, so
  `~/.local/share/keyrings`, absent on this host, was not measured.
- **`systemd-run --user` failed under the sandbox even with Unix sockets
  allowed.** Why wasn't established; denying `/run/user/<uid>` closes it anyway.

## A probe mistake worth keeping

The first runs used `ls <dir>` and its exit status. `ls` exits 0 on an empty
directory and on a dangling symlink, so a hidden `/mnt/c` read as open. The
runtime also creates the mount point of a deny nested under another deny, so a
nested one can make an otherwise empty tree show folder names. The probe now
tests for content that only the real tree has.

## Not measured here

- The real CLI under these settings: the canary does that, per CLI build.
- A GitHub-hosted runner, whose Ubuntu restricts unprivileged user namespaces
  by default. Its first run found one more dependency: srt also needs ripgrep,
  to find the files it must protect under a writable path, and refuses to start
  without it (`Sandbox dependencies not available: ripgrep (rg) not found`).
