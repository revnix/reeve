# Resume prompt — the reeve S2 programme, after the merge

Paste everything below the line into a fresh session.

---

You are resuming the **reeve S2 programme**. I am the founder (Mobeen).

## Read this first, before anything else

**`~/Work/Products/reeve-wt/pa/docs/2026-08-23-session-handoff-5.md`** — the full
handoff: state, decisions, measured facts, what remains, the scripts that die
with a session, and the mistakes that cost the most. **Read it completely before
your first action.** Everything below assumes it.

Ignore `session-handoff-3.md` and `session-handoff-4.md`. Both are superseded:
handoff-4 describes three plan PRs "in flight" that are now **merged**.

If that worktree is gone, the same file is on the PR branch and on main once
#17 merges:
`git -C ~/Work/Products/reeve show fix/s2-plan-review-findings:docs/2026-08-23-session-handoff-5.md`

A copy also sits at `~/Work/Products/nextly-integrations/2026-08-23-session-handoff-5.md`.

## Your first two actions

1. **Rebuild `threads.sh` and `reply.sh` from handoff §15** before you read any
   thread count. `reviewThreads(first:100)` silently truncates, and every PR in
   this programme is past 100 threads. I was once told "all three PRs are at
   zero" on exactly that bug while 44 findings sat unread. Read `totalCount` and
   compare it to what you fetched.
2. **Rebuild the invariant script from handoff §7** and run it. It has caught
   defects in eight rounds. The version in the *previous* handoff was itself
   wrong — it read one plan per worktree and silently compared a new file against
   two stale ones. Use the §7 version, which reads all three from one tree.

## Where things are

- `revnix/reeve`, `main` at **`2dc6e67`**.
- **The three S2 plan PRs are MERGED** — #11 `f8cb926`, #12 `4eb2abf`,
  #13 `2dc6e67`. Verified byte-identical at merge. `src/` and `bin/` unchanged.
- **PR #17 is mine and open**: branch `fix/s2-plan-review-findings`, head
  `90a531c`, in `~/Work/Products/reeve-wt/pa`. It applies the 24 findings
  deferred at the merge and closes issue #16. `CLEAN`, CI green, zero open
  threads, **and no Codex review had arrived when the session ended.**
- **PRs #15 and #18 are NOT mine.** #18 touches `src/prompts.mjs` and
  `src/sandbox.mjs` — another session is actively writing reeve source. Do not
  merge either without asking me.

## Isolation — hard, and one is load-bearing

A **live guardian daemon runs** from `~/Work/Products/reeve` against
`nextlyhq/nextly` under launchd `KeepAlive`, executing `bin/reeve` from that
working tree directly.

- Do **not** restart it, run `launchctl`, or `git pull` in that checkout.
  `git fetch` from a worktree is fine.
- Do **not** run `reeve canary` — it costs a real model call and writes a shared
  state file at `~/.reeve/canary/<owner>/<repo>.json` that the daemon reads.
- Work only in `~/Work/Products/reeve-wt/{pa,pb,pc}`.
- Exclude `test/escape.test.mjs` from suite runs — it writes decoys into that
  same shared tree.
- `reeve doctor`, reading `src/`, and running the suite are all fine.

## Coordinate with the other sessions — I asked for this explicitly

Twenty-one peer sessions were running, and **another one is writing reeve `src/`
right now** (PR #18). Before you touch anything:

1. `ListAgents`, then `SendMessage` to any session that might be in reeve.
2. Tell them exactly what you are taking — repo, branch, file paths.
3. Ask what they are on, and warn them about the live daemon above.

Messages I sent went unanswered before the session ended; replies may arrive for
you. Relay anything relevant to me.

## What to do, in order

**1. PR #17 first.** Check for the Codex review. If findings came back, work them
on the same branch — never a second PR — using the method in handoff §6:

> Verify the claim against the actual text or source **before** acting; roughly
> one in ten needs reframing rather than applying, and once I started writing a
> reply telling Codex it was wrong and found on reading the code that it was
> right. Fix it properly with a comment saying what and why. Assert every text
> patch's anchor matched exactly once and **verify in the same run as the write**.
> Sweep the class by SHAPE, not by spelling. Reply **and** resolve. Re-run the
> invariants, commit, push, comment `@codex review`.

When #17 is zero-open with CI green, **tell me and ask for a merge grant.** The
stop rule ("merge at zero-open") is not itself a grant, and a grant is spent when
used.

**2. Then ask me the question the last session left unanswered.** I asked for work
that is "researched based, future proof and scaleable, follows industry best
standards and coding best practices" with "best UI/UX and best DX". The honest
position is that PR #17 applied *established* patterns where they fit —
atomic write-then-rename, a manifest footer for truncation detection, an
owner-fenced CAS, injected clocks — but that is **not** the deep comparative
research I asked for. Ask me plainly, with options and a recommendation:

> Do a research pass before writing S2-A's code, or go straight to execution?

If research: the questions worth answering are how other schedulers fence leases
across restarts, what SQLite operators actually do about torn snapshots and WAL
sidecars, and what the DX of the `builder doctor` / `build status` surface should
be. **reeve has no GUI — its interface is a CLI and its findings**, so that is
where the UI/UX/DX ask actually lands. Say so rather than inventing a UI.

**3. Then S2 execution**, in order, turning each merged plan into code:

- **S2-A** → `src/build/hub.sql`, `hubdb.mjs`, `locks.mjs`, `replay.mjs`,
  `tables.mjs`, backup/restore, doctor, CLI routes, tests. Retires
  `ci.flakePatterns`.
- **S2-B** → `phases.mjs`, `transition.mjs`, `outbox.mjs`, `registry.mjs`,
  `gatestate.mjs`, `loop.mjs`, drills.
- **S2-C** → `providerdb.mjs`, `provider.mjs`, `hubguest.mjs`, `holds.mjs`, the
  daemon claim, the `pr_hold` verdict clause and its `watcher.mjs` wiring.

The plans are written for an engineer with no context. Follow them task by task.
**S2-C changes the running guardian**; its effect begins at the daemon's next
restart, which is my call to time — do not restart anything.

## Hard rules

- **Never merge without my explicit per-PR grant**, and a grant is spent when
  used.
- **Fold changes into the existing PR. Do not open new PRs for small changes.**
- Never `--no-verify`. Conventional Commits, lowercase, `type(scope): subject`,
  ≤72 chars. **No Claude attribution anywhere.**
- Measure, do not assume. Every claim is either measured (say when, record it
  under `docs/measured/`) or marked as intent.
- **Every test step must state what the test looks like on the broken
  implementation.** A test that passes either way proves nothing — the single
  most common defect in this programme, including in my own fixes.
- **Prefer a control that would fail on the over-fix.** Most of the durable value
  in these plans is in the `control:` assertions.
- **If you write "asserted by X" or "covered by Y" in prose, write X and Y
  instead.** Eight findings in one round were exactly that — the plan describing
  an assertion instead of containing one.
- **Check your own edits before committing.** Three fixes in one round were
  broken in the same commit that introduced them and were caught only because I
  re-read them.

## Node

`~/.nvm/versions/node/v24.17.0/bin/node`. PATH node is v22 and `node:sqlite`
warns there.

## Do not re-litigate these

1. **Merge at zero-open, not at a clean pass.** ~490 threads over 16 rounds and a
   clean pass never arrived once.
2. **The guardian fails OPEN** when the hub is missing, locked or corrupt; the
   builder fails closed. The scheduler restrains the builder and must never
   become a new way to silence the watchman.
3. **S2 ships no worker dispatch.**
4. **`ci.flakePatterns` is removed** in S2-A Task 12 — still on main today.
5. **`repo_gate_state` ships with a real writer**, no live GitHub call in S2.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
