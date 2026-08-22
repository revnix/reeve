# Measured: a standalone clone keeps the founder's files out of the checkout, not out of reach

Date: 2026-08-22. Host: macOS (Darwin 25.6), founder's account.
Instrument: `test/escape.test.mjs`, under the runtime's own Seatbelt profile
driven by `srt`, no model in the loop.

## The claim that was too strong

A run checkout is a `git clone` of the founder's checkout, so it carries only
**committed** content. That was written up as "the founder's uncommitted work and
every ignored file (a `.env` among them) never reach a worker".

The first half is true and is asserted directly (`test/checkout.test.mjs`: the
files are not present in the clone). The second half does not follow. The
originals are still on the same disk, and **the OS sandbox denies writes outside
the checkout, not reads.**

## The measurement

The founder's checkout was given an uncommitted `WIP.txt` and an ignored `.env`.
A sandboxed probe ran in the standalone clone under the generated policy and
tried to `cat` both.

| probe | before | after |
|---|---|---|
| `cat <founder-checkout>/WIP.txt` | **0 (read)** | 1 (denied) |
| `cat <founder-checkout>/.env` | **0 (read)** | 1 (denied) |

Before is not a hypothesis: the assertion was written as HELD, ran red, and the
failure is what established the hole.

## What closed it

`sourceCheckoutOf(profile)` puts `identity.checkout` in the worker's policy as a
denied read, in both the OS list (`sandbox.filesystem.denyRead`) and the Read
tool's rules (`Read(<p>)` and `Read(<p>/**)`, because the `/**` form matches only
descendants). `validateSettings` requires it, so a policy missing it cannot reach
a worker. It also joins the overlap guard: a `worktreeRoot` inside the clone
would deny the worker its own code, and that is refused by name rather than
silently dropped.

## Why this costs the worker nothing

The worker never needs the founder's checkout: it has its own clone, and its
dependencies are copied in **by the daemon** before it starts.

The one way that could break is a dependency tree whose symlinks point back at
the source. Measured on nextlyhq/nextly (2026-08-22): of 714 symlinks in the
root `node_modules` at depth ≤ 3, **zero** are absolute, and walking to depth 4,
**zero** resolve outside the repository. pnpm writes relative links into
`.pnpm/`, so a copied tree resolves within the run checkout.

That is one project and one package manager. If another layout does link out,
the failure is loud (the worker's own tests fail) rather than silent, which is
the direction this should fail in.

## What is still open

The worker holds a working Claude token in its environment, because it needs one
to run, and its own checkout's contents are readable to it by definition. Both
are bounded the same way: no network, and reeve reviews every diff before
publishing.
