# Resume prompt — reeve S2-A built, two PRs open with 10 findings

Paste everything below the line into a fresh session.

---

You are resuming the **reeve S2 programme**. I am the founder (Mobeen).

## Read this first, before anything else

**`~/Work/Products/nextly-integrations/2026-08-24-session-handoff-6.md`** — the full
handoff: state, the 10 open findings with their thread IDs, decisions, measured facts,
the scripts that die with a session, and the mistakes that cost the most. **Read it
completely before your first action.** Everything below assumes it.

It is also on the branch, if that copy is gone:
`git -C ~/Work/Products/reeve show docs/handoff-6:docs/2026-08-24-session-handoff-6.md`

Ignore `session-handoff-5.md` and earlier. Handoff-5 describes three plan PRs and a
follow-up as in flight; **all four are merged**, and its claim that no Codex clean pass has
ever arrived is out of date — one arrived on #17.

## Your first action: rebuild the two GitHub scripts from handoff §10

`reviewThreads(first:100)` **silently truncates** and the PRs here go past 100 threads.
I was once told "all three PRs are at zero" on exactly that bug while 44 findings sat
unread. Rebuild `threads.sh` and `reply.sh` verbatim from §10 before you read any thread
count, and compare `totalCount` to what you fetched.

Two things from §10 that will bite you if you skip them:
- **Do not loop over thread IDs in zsh.** I misrouted every reply twice — zsh arrays are
  1-indexed and unquoted `$VAR` is not word-split. Write the calls out one per line, then
  verify routing by re-fetching each thread and checking the reply cites its finding.
- **Never `| head` or `| tail` a findings listing.** I truncated my own output three times
  and twice concluded the wrong thing.

## Where things are

- `revnix/reeve`, `main` at **`bc17a06`**.
- **PR #20 — S2-A: the hub store.** `feat/s2-hub-store` @ `294cdb8`, 13 commits, base
  `main`, worktree `~/Work/Products/reeve-wt/hub`. CLEAN, CI green, **5 unresolved**.
- **PR #21 — CLI flag discipline.** `fix/cli-flag-discipline` @ `3e1e32c`, 1 commit, base
  **`feat/s2-hub-store`** (stacked on #20), worktree `~/Work/Products/reeve-wt/cli`. CLEAN,
  CI green, **5 unresolved**.
- **PRs #15, #18 and #19 are NOT mine.** Different sessions, different worktrees. Do not
  touch or merge them.
- Suite: **65 files, 0 failures**. `escape.test.mjs` always excluded.

## Isolation — hard, and two are load-bearing today

A **live guardian daemon runs** from `~/Work/Products/reeve` against `nextlyhq/nextly`
under launchd `KeepAlive`, executing `bin/reeve` from that working tree directly.

- Do **not** restart it, run `launchctl`, run `reeve canary`, or `git pull` in that
  checkout. `git fetch` from a worktree is fine.
- Work only in `~/Work/Products/reeve-wt/{hub,cli}`.
- Exclude `test/escape.test.mjs` from suite runs.
- **Scope every test and manual run with `REEVE_HOME=<dir>`, never a flag.** `--home` is
  only half-wired (it is finding #2 on #21), and before #21 an unknown flag was silently
  ignored — which is how I created a `hub.db` in the real `~/.reeve`. It was backed up and
  removed; `~/.reeve/state/hub.db` should stay **absent**.
- **`build run` is a heartbeat loop.** Never foreground it without a timeout, and if you
  background it kill it **by pid** — `kill %1` does not reach a subshell job. I leaked four
  daemons that way and they ran for 1h45m.

## What to do, in order

**1. Work PR #21's five findings first**, even though #20 is the bigger PR. Two of them are
worse than anything open on #20:

- `reeve restore --hub --help` **performs a restore** — I added `help` to the flag registry
  and no route checks it.
- `--home` does not reach `credentialPaths()` (`src/sandbox.mjs:192`) or the canary decoy
  (`src/daemon.mjs:362`), which read `process.env.REEVE_HOME` directly — so the sandbox can
  omit the custom root and **the canary can report containment closed**.

The other three: a missing `--home` value falls back silently; `init` ignores `--home` for
sidecar profiles; single-dash flags like `-w` are still ignored. Thread IDs are in handoff
§3.

**2. Then PR #20's five.** One is the **fourth site** of a class I fixed three times
(`builder doctor` still accepts a version-0 hub). One would destroy the last usable event
tail (`export-events --hub` truncates before writing). Thread IDs in §3.

**3. Then ask me for the merge grant on #20.** I already decided to wait for this review
round rather than grant at zero-open; that round has arrived, so once #20 is back at
zero-open with CI green, ask. **A grant is per-PR and is spent when used.** #21 is stacked
and merges after #20; GitHub retargets it to `main` automatically.

**4. Then the remaining research**, before S2-B: what SQLite operators do about torn
snapshots and WAL sidecars, and the DX of the `builder doctor` / `build status` surface —
exit codes, machine-readable output beside human output, and the wording of every refusal.
**reeve has no GUI; its interface is the CLI and its findings**, so that is where the UX
work lands. Say that rather than inventing a UI.

**5. Then S2-B, then S2-C**, from their merged plans. S2-C changes the running guardian and
its effect begins at the daemon's next restart, which is **my** call to time.

## How to work a finding

1. **Verify the claim against the actual source first.** Roughly one in ten needs
   reframing. Twice this programme I started writing a reply saying a bot was wrong and
   found on reading the code that it was right.
2. **Fix it properly**, with a comment saying what and why in the style around it.
3. **Run the four-check stub loop:** control green → stub applied **and verified to
   parse** → the RIGHT assertion red → restore verified byte-identical. A stub that does
   not parse proves nothing; mine once left a dangling `return` and produced zero failures,
   which reads exactly like "the test cannot detect it".
4. **Sweep the class by INVARIANT, not by memory.** Version-0 has four sites and I fixed
   three in three separate commits, each time believing I had swept it.
5. **Ask what the fix made newly reachable**, and what unnamed property it may have traded
   away. Half of each late round's findings were defects in the previous round's repairs.
6. **Reply AND resolve.** Replying alone does not clear a thread.
7. Re-run the suite (>2 min; background it), commit, push, comment `@codex review`.

## Hard rules

- **Never merge without my explicit per-PR grant.**
- **Fold changes into the existing PR.** Do not open new PRs for small changes.
- Never `--no-verify`. Conventional Commits, lowercase, `type(scope): subject`, ≤72 chars.
  **No Claude attribution anywhere.**
- Measure, do not assume. Every claim is measured (say when) or marked as intent.
- **Every test must state what it looks like on the broken implementation.** A test that
  passes either way proves nothing — and executing S2-A found one in a plan that had
  already absorbed ~490 review findings.
- **If you write "asserted by X" or "covered by Y" in prose, write X and Y instead.**
- **Say what is NOT tested.** One finding on #20 has no deterministic seam; I said so on
  the thread rather than add an assertion that passes for a different reason.
- **Check your own edits before committing**, and check whose claim it is before correcting
  it — I once blamed the plan for an omission the plan had instructed correctly.

## Do not re-litigate these

1. **Merge at zero-open, not at a clean pass.**
2. **#20 waits for the round that has now arrived**, then I grant.
3. **The CLI flag fix is its own PR before S2-B** — that is #21.
4. **Treat the CLI as the product.** No GUI exists.
5. **The guardian fails OPEN** on a missing, locked or corrupt hub; the builder fails
   closed.
6. **S2 ships no worker dispatch.**
7. **`ci.flakePatterns` is removed** — in code and in the live profile, with a backup.
8. **The outbox lease fence went into migration 1** while it was still editable. Do not
   move it to migration 2.

## Node

`~/.nvm/versions/node/v24.17.0/bin/node`. PATH node is v22 and `node:sqlite` warns there.

Work autonomously, tell me when you need something, and do not claim anything is verified
that you have not run.
