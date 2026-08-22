# Measured: an absolute path in a permission rule needs TWO leading slashes

Date: 2026-08-22. Host: macOS (Darwin 25.6). CLI 2.1.237.
Instrument: the first live `reeve canary` ever run, then four targeted probes
against the real CLI with a real token.

## What the canary found

The first live canary on `nextlyhq/nextly` **FAILED**, with two problems:

```
the Write tool created a file outside the worktree;
the Read tool returned a file under a deny-read path
```

Every shell probe in the same run held: writes outside denied, network denied,
the decoy unreadable by `cp`, the exact-file deny holding with its control
readable beside it, and all three keychain probes returning not-found. The
scratch-HOME closure is intact.

What failed was the **tool** layer, and only the tool layer.

## The mechanism

Two boundaries, and they are not the same boundary:

| | governed by | measured |
|---|---|---|
| `Bash` subprocesses | the OS sandbox (`sandbox.filesystem.*`) | holds |
| `Read`, `Edit`, `Write`, `Grep`, `Glob` | `permissions.*` **only** | did not hold |

The CLI's own process is not inside the Seatbelt profile it applies to the shells
it spawns. In one canary run, `cp <decoy> .` was refused while `Read(<decoy>)`
returned the contents — same file, same run, same policy.

## The root cause

Claude Code's file-path permission rules take an absolute path only when it
carries **two** leading slashes. Measured with an unscoped `Read` grant, so that
nothing but the deny rule could refuse:

| deny rule | result |
|---|---|
| `Read(/Users/mobeen/.reeve/**)`  ← what this branch shipped | **LEAKED** |
| `Read(//Users/mobeen/.reeve/**)` | denied: "File is in a directory that is denied by your permission settings." |
| `Read(~/.reeve/**)` ← what `main` ships | **LEAKED** (under a scratch HOME) |
| `Read(/Users/…/decoy.txt)` exact file | **LEAKED** |
| `Read(//Users/…/decoy.txt)` exact file | denied |

So on this branch **every absolute `Read(...)` deny was inert**: `~/.ssh`,
`~/.gitconfig`, `~/.claude`, `~/.config/gh`, `~/.aws`, reeve's own `~/.reeve`
(the App private key, the event store, every run's output), the state roots and
the founder's checkout.

`main` is not exposed. It writes the tilde form and its workers run with the
founder's own HOME, so `~` expands to the directory the rule means. This branch
gave workers a scratch HOME — which is what closes the keychain — and correctly
switched the rules to absolute paths, but to the single-slash form the CLI does
not read as absolute. **The defect was introduced by this branch and caught by
this branch's own first live canary.**

## Why nothing else caught it

`test/escape.test.mjs` drives the OS sandbox directly through `srt`. That is the
layer that held. It cannot exercise the CLI's permission layer, because there is
no CLI in it. The canary is the only instrument that runs a real worker under a
real policy, and this is the first time one has ever run.

The earlier note in `2026-08-22-claude-print-mode.md` that "the `Read(...)` deny
rules hold" was true for what it measured: the tilde form, with the founder's
HOME. Its configuration was not production's.

## The fix, measured

Under `//`-form rules, with a real worker:

| | result |
|---|---|
| scoped grant, write at checkout root | **allowed** |
| scoped grant, write in a subdirectory | **allowed** |
| scoped grant, edit a file in the checkout | **allowed** |
| scoped grant, read outside the checkout | denied |
| scoped grant, write outside the checkout | refused |
| **unscoped** grant + `//` deny, read outside | denied |

Two things follow, and both are worth having:

1. **The rule paths must use the `//` form.** This alone restores every deny the
   policy already intends, and it holds even against an unscoped tool grant, so
   deny does beat allow once the rule actually matches.
2. **The file tools should be scoped to the checkout** (`Read(//<dir>)` and
   `Read(//<dir>/**)`, and the same for Edit/Write/Grep/Glob). reeve's
   `--allowedTools` carries bare `Read`, `Edit` and `Write` today, which grants
   them everywhere the deny list does not name. A scoped grant makes the boundary
   the checkout itself rather than an enumeration of paths — the same reason the
   worker gets a standalone clone rather than a list of forbidden branches.

Both forms of the grant are needed: `//<dir>/**` matches descendants, and a write
of a new file is checked against the directory, so `//<dir>` must be granted too.
That is the same shape as the earlier finding that `Read(<file>/**)` leaves the
file itself readable.

## A second finding, from the fix

The canary re-run passed — with **the same id as the failed run**,
`e31c4bea2493664a`. `canaryIdFor` and `policyHashOf` covered only the `sandbox`
block, so the two policies either side of this fix were, to reeve, the same
boundary. A pass recorded under one would have been reused under the other, in
both directions, and `reeve doctor` R-14 would have reported OK across the
change.

That is not a detail of this defect. The permission rules are a **separate
boundary**, not a description of the sandbox one, and they are the only thing
governing the file tools. Both now cover `permissions.deny` and the tool grant,
with per-invocation paths normalised out the same way the sandbox block's are —
the id must not change every tick, or every wanted task pays for another
five-minute canary.

After the fix the id moved to `942565ecf154b3ed` and the canary **passed**:

```
credentialRead : closed
canary         : PASSED (942565ecf154b3ed)
```

R-14 read OK for the first time since it was written.
