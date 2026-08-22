# Measured: a scratch HOME closes the keychain SEARCH LIST, and a token replaces `~/.claude`

> **CORRECTED 2026-08-22, same day.** The original title and finding said a
> scratch HOME closed the keychain. It does not. It empties the keychain SEARCH
> LIST, which is a smaller claim, and the difference is a credential:
>
> ```
> # scratch HOME, no path denied
> security find-internet-password -s github.com                                   -> 44
> security find-internet-password -s github.com ~/Library/Keychains/login.keychain-db -> 0   ← FOUND
> ```
>
> The keychain file does not move, is not locked (`no-timeout`), and the worker
> runs as the same OS user, so naming it works. Every probe in the table below
> asks the search list, so none of them could see this — including the canary's,
> which certified containment on that basis.
>
> Found by Codex on PR #5, verified by measurement, and closed by denying
> `~/Library/Keychains` in the worker's policy: the same probe returns 44 under
> the deny and 0 without it, and the canary now runs both shapes
> (`kc_path_github=44`, `kc_path_claude=44` in canary `163837cb9d095182`).
>
> What survives below is true and still load-bearing — the search list IS emptied,
> and `~/.claude` IS replaced by a token. It is simply not sufficient on its own.


Date: 2026-08-22. Host: macOS (Darwin 25.6), founder's account, CLI 2.1.237.

## The problem this answers

The OS sandbox denies files. It cannot deny the **keychain**: the runtime's
Seatbelt profile hard-allows `com.apple.securityd.xpc` and
`com.apple.SecurityServer`, and no setting removes them
(`macos-sandbox-utils.js`, `generateSandboxProfile`). Measured 2026-08-22: a
sandboxed worker running as the founder retrieves the founder's GitHub token
with `git -c credential.helper=osxkeychain credential fill`.

Two closures were considered and both cost the founder something: a dedicated OS
user (refused — "I'm not going to make another user"), or removing the GitHub
credential from the keychain (leaves the CLAUDE credentials readable, and
"the keychain is clean" can only be probed for the item shapes reeve knows).

## The finding (as originally written, and too strong)

**The keychain SEARCH LIST is reached through `HOME`.** The list lives in the
home directory, so a process with a scratch home has no login keychain in its
search path. Every row below probes that list. None of them names the keychain
file, which is the reach that was still open.

| probe | real `HOME` | scratch `HOME` |
|---|---|---|
| `security find-internet-password -s github.com` | found | **44 (errSecItemNotFound)** |
| `security find-generic-password -s "Claude Code-credentials"` | found | **44** |
| `git -c credential.helper=osxkeychain credential fill` | password returned | **no password** |
| `security list-keychains` | login + system | **`/Library/Keychains/System.keychain` only** |

The one thing a scratch home breaks is the CLI's own authentication, which reads
`~/.claude`:

```
$ env -i HOME=<scratch> … claude -p 'reply ok' --output-format json
{"is_error":true, …, "result":"Not logged in · Please run /login"}
```

`claude setup-token` issues a long-lived token, and the CLI accepts it in
`CLAUDE_CODE_OAUTH_TOKEN` (string present in the installed binary alongside
`ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`).

## The proof, end to end

One real worker, scratch `HOME`, token in the environment, running a probe
script through its own Bash tool:

```
is_error: false   result: "ok"   exit 0        <- it authenticated
keychain_github=44                             <- not found
keychain_claude=44                             <- not found
git_credential=1                               <- no password
list-keychains -> /Library/Keychains/System.keychain
```

The script RUNNING is itself the authentication proof: with the same scratch
home and no token the CLI refuses before executing anything.

## What this changes

- The founder's keychain is **untouched**, and both credentials in it — GitHub
  and Claude — are out of the worker's SEARCH LIST. Reaching them by path stayed
  open until `~/Library/Keychains` joined the deny list; see the correction at
  the top.
- `~/.gitconfig`, `~/.ssh`, `~/.aws`, `~/.npmrc` and the rest become unreachable
  **by construction** rather than by deny rule; the deny list becomes a second
  layer instead of the only one.
- Containment stops resting on "the host's keychain holds no credential we
  recognise" — a proxy that could only ever be probed for known item shapes —
  and rests instead on **"a worker demonstrably cannot read the keychain"**,
  which the canary measures directly, per CLI build and per policy.

## What it does not change

The worker holds a working Claude token in its environment, because it needs one
to run. That is not new — it previously reached the same credentials through the
keychain — and it is bounded by the worker having no network and by reeve
reviewing every change before publishing. A worker cannot read the token from
another process: measured 2026-08-22, a sandboxed process reading another
process's environment via `ps eww` returns nothing, while an unsandboxed one
succeeds (the profile allows `process-info*` only for `(target same-sandbox)`).

The token file itself lives at `~/.reeve/claude-token`, mode 0600, inside the
already deny-read `~/.reeve` tree.
