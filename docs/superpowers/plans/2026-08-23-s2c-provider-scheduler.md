# S2-C: The Provider Scheduler, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One global provider scheduler that both daemons claim transactionally before spending model quota, a guardian that fails open when the hub is unreadable, a statement allowlist proving the guardian's hub surface is exactly what §13 says, and the verdict clause that makes `pr_hold` mean something.

**Architecture:** One PR against `revnix/reeve` `main`, **based on S2-B after it merges**. Adds shared `src/provider.mjs` and `src/build/hubguest.mjs`; wires `claimProvider`/`releaseProvider` and the rate-limit fast-fail into `src/daemon.mjs`; adds the `pr_hold` clause to `src/verdict.mjs`. **This is the only S2 plan that changes the running guardian**, which is why it lands last.

**Tech Stack:** Node `~/.nvm/versions/node/v24.17.0/bin/node` (PATH node is v22 and `node:sqlite` warns there), `node:sqlite` `DatabaseSync`, plain-script tests under `test/*.test.mjs` (CI runs every file in that glob on ubuntu-latest under three TZs), no dependencies added.

**Spec:** `docs/2026-08-21-builder-design.md` — §14 S2 is the stage definition and its *Verify:* clause is the definition of done. The sections that bind this plan: §1.1 (the guardian's hub surface), §9.6 (`pr_hold` and the verdict), §10.3–§10.4 (admission and the scheduler), §13 (what the guardian keeps doing).

**This is one of three plans for S2.** They were split out of a single 5,300-line document after four review rounds found 54 defects, a majority of them caused by the previous round's own fixes: an edit in a document that large cannot see its neighbourhood. Each plan is now self-contained and reviewed on its own.

| plan | scope |
|---|---|
| `2026-08-23-s2a-hub-store.md` | the store: schema, migrations, locks, backup, restore, the cross-check |
| `2026-08-23-s2b-phase-machine.md` | the pure machine, the transition transaction, the fenced outbox, registry, gate state |
| `2026-08-23-s2c-provider-scheduler.md` | the shared scheduler, the guardian claim, the hub allowlist, the `pr_hold` verdict clause |

Their review history — all 54 findings and what each changed — is `2026-08-23-s2-review-history.md`. **Order matters:** A lands before B, B before C. Base this on S2-B's merge commit. After it merges, the daemon begins claiming a provider lease at its next restart — a founder-timed action, never part of executing this plan.

---

## What this plan consumes from S2-A and S2-B

Both must be merged first, in that order.

| from | name | shape |
|---|---|---|
| S2-A `src/build/hubdb.mjs` | `openHub`, `hubTx` | as in S2-A. **`hubEvent` is deliberately NOT consumed here.** The guest allowlist forbids writing `hub_event`, and that is correct rather than an oversight: the scheduler's rows are process-scoped, excluded from the comparison set, and cleared outright by `restoreHub`, so there is nothing about them for a replay to rebuild. A provider mutation that appended a row image would be writing history for state that is deleted on restore by design — and it would need a hole in the very allowlist §13 exists to keep small |
| S2-A `src/build/hub.sql` | `provider_lease`, `provider_state` | including `provider_one_live_request` UNIQUE over `(owner, repo_id, run_ref)` where status is live, plus the `preempt_requested` column this plan writes |
| | `pr_hold` | with `one_open_hold` partial UNIQUE on `(repo_id, pr)` where `cleared_at IS NULL` |
| | `maintenance_lock` | the restore exclusion |
| S2-A `src/build/locks.mjs` | `assertWritable(db, {isAlive, at, inTx})` | **every provider mutation calls it**, inside its own transaction |
| S2-B `src/build/transition.mjs` | the writer of `pr_hold` | this plan adds the only READER |

**The obligation this plan exists to discharge.** S2-A creates `pr_hold` and S2-B writes it. Until the verdict clause in Task 23b reads it, §9.6's chain is inert at its only reading step and a held builder PR stays mergeable. Permission to read is not a reader: the original review shipped an allowlist entry for `pr_hold` for two rounds before anyone noticed nothing queried it.

### Line references in this plan

Every reference to `src/daemon.mjs` names the **anchor text to search for** first and a line number second, with the commit it was true at. Line numbers in that file moved twice during this plan's review (`#7`, `#10`), and a plan that sends an executor to a line number which has since moved is worse than one that sends them to a string: the string is still there.

## Global Constraints

- **Node:** always `~/.nvm/versions/node/v24.17.0/bin/node`. Alias it `N` in every shell: `N=~/.nvm/versions/node/v24.17.0/bin/node`. `node` on PATH is v22 and `node:sqlite` emits an ExperimentalWarning there; CI asserts a floor of 24.
- **Tests:** plain scripts, no framework. Use the `check(ok, name, detail)` helper shape every existing test file uses; `console.log("PASS  name")` / `"FAIL  name"`; end with `process.exit(fail ? 1 : 0)`. New files under `test/` are discovered by CI automatically.
- **The four-check stub loop for every fix:** control green, stub verified applied, the RIGHT assertion red, restore verified. Never commit a test that has not been seen red against the broken code. Every task below names the stub explicitly.
- **Run the full suite before every commit**, skipping the one file the next sentence explains:

  ```bash
  for f in test/*.test.mjs; do
    case "$f" in */escape.test.mjs) continue;; esac
    $N "$f" >/dev/null || echo "FAILED $f"
  done
  ```

  `escape.test.mjs` writes decoys into the shared `~/.reeve/canary/` tree the live daemon reads. **Measured 2026-08-22 on `9dbd3a0`: 59 test files exist; 58 were run and all 58 passed.** `test/escape.test.mjs` was NOT run, because it writes decoy files into the shared `~/.reeve/canary/` directory that the live daemon also reads; run it once on a quiet machine to complete the baseline. That run had `node_modules` absent, and a green file can hide a skip, so skips were counted rather than assumed: exactly two files carry one `SKIP` each (`policy-self-exclusion`, `supervisor-contract`). That 58-file pass is the base every task is measured against, and it is the same base for all three PRs — never a chained comparison against the previous task.
- **Line numbers are measured against `16769e7`** (the `main` this plan was last checked on) and each is paired with a searchable string. If a number does not match, the file moved under it — search the string; the reasoning around it is not thereby stale. PR #14 shifted nine citations by one line on 2026-08-23, and one (`ctx.reviewIngest`) had been wrong by eighty lines since before that, unnoticed by nine review rounds.
- **Conventional Commits**, lowercase, `type(scope): subject`, ≤72 characters. **No attribution trailer of any kind.** Never `--no-verify`.
- Every change carries a what/why comment in the style of the file it lands in. Comments never reference tasks, plans, findings, or this document.
- **No raw SQL outside `src/db/` and `src/build/`.** `hubdb.mjs` owns every hub statement the way `ops.mjs` owns every guardian statement.
- No `as any`, no `@ts-expect-error`, no lint suppression.
- **Escalation keys are identities.** No counts, durations, paths, or SHAs in the key; those ride in the body. §11.7 lists every builder identity; a test asserts no `escalations.set` call interpolates variable detail into a key.
- Nothing in any public or client repository may name reeve. This plan touches only `revnix/reeve`, which is private.
- **Every timestamp is `INTEGER` seconds from `unixepoch()`** unless the column name ends `_ms`. Never a TEXT date.
- **No task in S2 dispatches a builder worker.** `worker.isolation` is `none` and dispatch is refused in code; S2 does not change that and must not.

### Isolation while this plan is being written or executed

A guardian daemon is live on the founder's host (measured 2026-08-22: pid 12574, `bin/reeve run nextlyhq/nextly`, running from the **main checkout**, not a copy). Therefore, for anyone executing this plan:

- Work in a worktree (`git worktree add -b <branch> ~/Work/Products/reeve-wt/<name> origin/main`), never in `~/Work/Products/reeve`. A `git pull` there swaps code under a running process.
- Do not run `reeve canary`: it costs a real model call and writes one shared state file at `~/.reeve/canary/<owner>/<repo>.json` that the daemon also reads. Last writer wins.
- Do not restart the daemon, run `launchctl`, or stop the service. `reeve doctor` is read-only and is fine.
- `docs/TRACKER.md` conflicts on every branch. Add the tracker entry as the **last commit before opening the PR**, so the conflict is one line.

### What S1 measured, which changes how these tests are written

Do not re-derive any of these. Each is recorded under `docs/measured/`.

| Measured fact | Consequence for S2 |
|---|---|
| A permission rule takes an absolute path only with **two** leading slashes; `Read(/Users/x/.ssh/**)` matches nothing, silently (`docs/measured/2026-08-22-the-read-deny-list-was-inert.md`) | Any permission rule this plan writes or asserts uses `//`. A rule that matches nothing looks identical to a rule that is working. |
| The file tools (Read/Edit/Write/Grep/Glob) are **not** covered by the OS sandbox — the CLI's own process runs outside the Seatbelt profile it applies to the shells it spawns | Never argue that a hub file is protected because a worker is sandboxed. Hub file safety in S2 comes from locks and from the fact that no worker runs at all. |
| A deny that **contains** the worker's checkout refuses the worker its own files, because deny beats allow | Never write one. Not applicable inside S2, which spawns nothing, but it constrains any rule added in passing. |
| A scratch HOME closes the keychain **search list**, not the keychain; the file stays reachable by path until `~/Library/Keychains` is denied (`docs/measured/2026-08-22-scratch-home-closes-the-keychain.md`, **read its correction banner**) | Do not treat a scratch HOME as a containment claim anywhere in S2's docs or comments. |
| `pull_request.updated_at` does **not** change when a review thread is resolved (`docs/measured/2026-08-22-the-shadow-compared-two-moments.md`) | The hub inbox must never use `updated_at` as a change signal or as an ordering. It is blind to review state. §7.6's content-hash generation is the mechanism; the DDL must make `updated_at` unusable as an ordering by keeping it named `edited_at`, as the guardian's inbox already does. |

### Decisions taken by the founder for this stage, 2026-08-22

Recorded so no executor re-litigates them.

1. **S2 splits into three PRs**, in the order A → B → C, with the provider scheduler last because it is the only one that changes the running guardian.
2. **The guardian fails OPEN when hub.db is unreadable at provider-claim time.** It dispatches exactly as it does today and escalates **`the provider scheduler is unreadable; dispatching unscheduled`** — the GUARDIAN's identity, not a `builder:` one. The escalation lands in the per-repo guardian store, whose announcer knows guardian subjects; a `builder:`-grammar subject there is announced by nobody, so this fail-open path would escalate silently. The code and the mandatory test already use this string, and the earlier `builder:provider:hub-unreadable` wording here contradicted both. The builder fails closed. The scheduler restrains the builder; it must never become a new way to silence the guardian. This matches the `ctx.reviewIngest !== false` opt-out shape §14 asks new ctx keys to follow (search `ctx.reviewIngest !== false`; `src/daemon.mjs:597,1361,1368` on `16769e7`), so existing guardian tests stay green untouched.
3. **`ci.flakePatterns` is REMOVED**, and the live `nextlyhq/nextly.json` is stripped in the same change. Measured, with a positive control, in `docs/measured/2026-08-22-flakepatterns-has-no-readers.md`. Removing it from `FIELDS` alone would make the live profile invalid and kill every daemon start.
4. **`repo_gate_state` ships in S2 with a real writer**: the table, a pure `gateStateFrom()` derivation with unit tests over drifted/absent/stale inputs, and a `build run` tick that calls it through an injected `ctx.fetchGateState`. No live GitHub call in S2. S8 supplies the fetcher and clause U4, the reader.

---


## The test harness every file in this plan opens with

Where a task writes `/* ... standard harness ... */`, it means exactly this block. It is written once here rather than repeated in each task, but it is **not** optional shorthand: without it `check`, `dir` and the imports are undefined and the file fails before reaching its first assertion.

```js
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-<slug>-"));
```

and closes with:

```js
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

Each task names any imports it needs **beyond** these.

## File structure

| File | Responsibility after this plan |
|---|---|
| `src/provider.mjs` (new, PR-C) | the shared scheduler: `claimProvider`, `releaseProvider`, `reapProviderLeases`, `noteRateLimit`. Written by both daemons; the guardian's only hub write. |
| `src/daemon.mjs` (PR-C) | claims a provider lease before every model dispatch, releases on exit, fails **open** when the hub is unreadable, fast-fails on a rate-limit signature. |
| `test/provider-scheduler.test.mjs` (new, PR-C) | admission rule, guardian reservation, queued-guardian blocking, cooldown, reaping, the two-daemon race. |
| `test/guardian-hub-allowlist.test.mjs` (new, PR-C) | the guardian's hub connection reaches exactly `provider_lease`, `provider_state`, and `SELECT` on `pr_hold`. |

---

# PR-C: The provider scheduler

**Branch:** `feat/s2-provider-scheduler`, based on `feat/s2-phase-machine` after PR-B merges. **Scope:** shared `src/provider.mjs`, the guardian-side claim, the rate-limit fast-fail, and the hub connection allowlist.

**This is the only PR in S2 that changes the running guardian.** It lands last for that reason. After it merges, the daemon's next restart begins claiming a provider lease before every model dispatch.

---

### Task 21: `src/provider.mjs` — the admission rule

**Files:**
- Create: `src/build/providerdb.mjs` (every scheduler statement — the hub owns its own SQL, as `hubdb.mjs` does), `src/provider.mjs` (the shared policy layer that imports them)
- Test: `test/provider-scheduler.test.mjs` — **one file**. An earlier revision
  also named `test/provider-race.test.mjs`, but every step writes the race into
  `provider-scheduler.test.mjs`, so `git add` would fail on an unmatched pathspec
  after the tests had passed: the plan's last step broken by a path nothing
  creates.

`src/provider.mjs` holds **no SQL**. It holds the admission rule, the reservation arithmetic and the cooldown comparison, and calls `providerdb.mjs` for every read and write. That keeps "no raw SQL outside `src/db/` and `src/build/`" true, and means the guardian imports a policy function rather than a query builder.

**Interfaces:**
- Consumes: `openHub`, `hubTx` (PR-A). **Not `hubEvent`** — and this is not a
  tidy-up. `provider_lease` and `provider_state` are process-scoped: `restoreHub`
  clears them and they are not in `COMPARISON_SET`, so there is nothing for a
  replay to restore and no event to write. More concretely, the guest
  authorizer's write set is exactly `{provider_lease, provider_state}`, so an
  `INSERT INTO hub_event` from a provider transaction is **denied** — every real
  guardian claim and release would fail. A dependency list naming `hubEvent`
  invites the one statement that breaks the whole feature.
- Produces:
  - `claimProvider(db, { owner, repoId, runRef, pid, lstart, priority = 0, budgetUsd = null, isAlive, now }) -> { ok: true, id } | { ok: false, reason: 'queued'|'cooldown'|'at-limit'|'maintenance', until }`
  - **Where the SQL lives.** The Global Constraints say no raw SQL outside `src/db/` and `src/build/`, and `src/provider.mjs` is neither — it sits at the top level because both daemons import it. Resolve it by keeping the statements in `src/build/providerdb.mjs` (the hub owns its own SQL, as `hubdb.mjs` does) and making `src/provider.mjs` the shared **policy** layer that imports them: the admission rule, the reservation arithmetic, the cooldown comparison. That also puts the boundary in the right place — the guardian imports a policy function, not a query builder, and the statement allowlist in Task 23 is checking a surface that has exactly one definition.
  - **Every provider mutation calls `assertWritable` inside its own transaction** (`inTx: true`), exactly as `withWriterLease` does. Without it a guardian can take a held lease and launch a worker after `restoreHub` has acquired `maintenance_lock` and finished its holder scan — reopening the writer race the lock exists to close, from the one code path that is allowed to write the hub without holding a writer lease. `assertWritable` throws; `claimProvider` catches and returns `reason: 'maintenance'`, which the guardian treats exactly like `at-limit`: it does not dispatch, and it does not escalate, because a restore in progress is an operator action rather than a fault.
  - `releaseProvider(db, { id, owner, repoId, runRef, force })` — deletes the row. When BOTH an id and an identity are given it requires them to **match** — `WHERE id=? AND owner=? AND repo_id=? AND run_ref=?` — and falls back to the identity alone when no id is supplied. Preferring the id whenever present was unsafe even for the immediate cleanup: if the worker exits and a restore completes before the `finally` runs, the restore clears `provider_lease` and the next claim can inherit that integer key, so the cleanup deletes an unrelated LIVE lease and admits work past the limit. Requiring both keeps the fast path, makes a renumbered id inert rather than dangerous, and fixes every caller instead of the one that noticed. **The retry queue stores the identity, never the id**: a queued release survives a restore that clears `provider_lease` and renumbers it, and an id-keyed retry would then delete whatever inherited that primary key. **A release refused because a restore holds `maintenance_lock` must not be dropped**: `assertWritable` throws, and the caller retries on the next tick with the lease id recorded in memory; the caller keeps the id and retries next tick, and the production snippet must actually do that rather than `catch {}`. There is deliberately **no durable marker**: an earlier draft added `provider_lease.refused_release`, and it cannot be written in the one case it represents — `assertWritable` blocks that write while the lock is held. It is also unnecessary, because `restoreHub` clears every process-scoped row (`provider_lease` included) from the restored file, so a lease held across a restore does not survive it. An abandoned restore is covered by ordinary expiry.
  - `queuedGuardianRequests(db, { repoId }) -> Row[]` — every `queued` guardian request for one repository. It exists because the sweep below runs in `src/daemon.mjs`, and this plan's global rule is that raw SQL lives only under `src/db/` or `src/build/`: a `SELECT ... FROM provider_lease` embedded in the daemon is a second definition of the guest's SQL surface, and it drifts from this one the first time the allowlist or the schema changes.
  - `heartbeatProvider(db, { id, now })`
  - `reapProviderLeases(db, { isAlive, now }) -> { reaped: number }` — an **object**, like every other function here, not a bare count. Two assertions in the suite previously read it both ways (`n === 1` and `.reaped >= 1`), which no single return value can satisfy.
  - `bindProviderLease(db, { id, pid, lstart })` — re-binds a held row from the daemon to the spawned worker.
  - `cancelQueued(db, { owner, repoId, runRef })` — removes a `queued` request whose dispatch is no longer going to happen. **Called on every path out of the dispatch block that did not launch, AND swept at the top of each tick**: a queued request whose PR has since closed, whose head moved, or whose task simply is not in this tick's decisions never re-enters that block at all, so a per-path call alone leaves it queued forever — and a queued guardian request blocks the next builder admission by design. The sweep compares live queued rows against the run refs this tick actually decided on, and cancels the rest.

Both of these run at the **top** of the tick, before the canary and before the
per-PR loop, because both have consumers earlier than the spawn seam:

```js
// Top of the tick, immediately after `decisions` is computed and before the
// containment canary. Two bindings, in this order.

// 1. repoId, hoisted. The queued sweep below and the containment canary both
//    read it, and both run before the per-PR loop -- so a declaration inside
//    that loop is a ReferenceError on the first tick that has any dispatch-worthy
//    decision, which is every tick that matters.
//
//    RE-RESOLVED here when startup could not. A single attempt at boot means one
//    transient outage -- an expired token, a 502 from the installations endpoint
//    -- fails every provider claim closed for the entire life of a long-running
//    daemon, so a five-second GitHub blip disables all guardian model dispatch
//    until an operator happens to notice and restart the service.
//
//    Bounded, so a genuinely broken configuration does not become a per-tick API
//    call: at most one attempt every `builder.provider.repoIdRetryMinutes`
//    (default 10), through the same seam startup uses.
if (ctx.repoId == null && ctx.resolveRepoId) {
  const at = Math.floor(Date.now() / 1000);
  const every = (profile.builder?.provider?.repoIdRetryMinutes ?? 10) * 60;
  if (at - (ctx._repoIdTriedAt ?? 0) >= every) {
    ctx._repoIdTriedAt = at;
    try {
      const got = await ctx.resolveRepoId(nwo);
      if (got != null) {
        ctx.repoId = got;
        log(logPath, `provider: resolved the repository id (${got}) on a retry; claims resume`);
      }
    } catch (err) {
      log(logPath, `provider: repository id still unresolved (${err.message}); claims stay refused`);
    }
  }
}
const repoId = ctx.repoId ?? null;

// 2. Releases a previous tick could not complete. This must not sit in the
//    spawn seam: a tick with no dispatch-worthy PR, a quota-refused canary, or
//    every candidate exiting through an earlier refusal never reaches that
//    point, so a lease refused once during a restore would stay held until
//    expiry -- exactly the leak the retry was added to prevent.
// By IDENTITY, not by row id. A release is queued precisely because a restore
// held `maintenance_lock` -- and that restore then REPLACES the database and
// clears `provider_lease`, so the integer primary key is free to be reused by
// the next claim against the restored file. Retrying a stale `id` would delete
// an unrelated live builder or guardian lease and silently admit excess work,
// which is the opposite of what the retry exists to prevent.
//
// `(owner, repo_id, run_ref)` is the live-request unique key, so it is the
// identity that survives. After a restore the row is simply gone and the
// release is correctly inert.
// PLACEMENT, and it is these two loops that move -- not a comment about them.
// The previous revision put the instruction on the stale-sweep block below,
// which genuinely does need `repoId` and `decisions`, and left the loops
// themselves where they were. Both go at the TOP of `tick`, before the halt
// check and the PR listing: `src/daemon.mjs:554` (halted), `:562` (the PR list
// could not be read) and `:578` (halted mid-tick) on `16769e7` all return
// before `decisions` exists, and a tick taking any of them ran no retries at
// all -- so a GitHub outage unrelated to the builder kept a dead worker's slot
// held until expiry. Neither loop needs `repoId` or `decisions`: every queued
// entry already carries its own owner, repoId and runRef.
for (const ref of (ctx.pendingReleases ?? []).splice(0)) {
  try { (ctx.providerRelease ?? releaseProvider)(ctx.hub, ref); }
  catch { (ctx.pendingReleases ??= []).push(ref); }    // still locked: keep it for next tick
}
// The rate-limit cooldowns a previous tick could not persist, for the same
// reason and with the same retry. Each carries the `now` it was captured at, so
// a cooldown recorded three ticks late still runs from the 429 rather than from
// the moment the lock cleared.
for (const rl of (ctx.pendingRateLimits ?? []).splice(0)) {
  try { (ctx.noteRateLimit ?? noteRateLimit)(ctx.hub, rl); }
  catch { (ctx.pendingRateLimits ??= []).push(rl); }
}
```

```js
// The stale-request sweep. Unlike the drains above, this one DOES belong after
// `decisions`: it decides what is still live FROM the tick's own decisions, and
// it needs `repoId` resolved.
//
// Three things this must get right, each of which was wrong in an earlier draft:
//
//   repoId scoping -- `pr:<number>` is repository-LOCAL, so a global sweep makes
//   one repository's guardian cancel another's queued request for the same PR
//   number. The WHERE clause carries repo_id.
//
//   ordering -- repoId must already be resolved here; when its only declaration
//   was later inside the per-PR loop, this threw on the first stale row, which
//   is exactly the case it exists to clean up.
//
//   what counts as live -- a request is live only while its PR still WANTS a
//   dispatch. A PR that is still open and evaluated but whose CI went green, or
//   whose decision became WAIT or PASS, no longer wants one, and its queued row
//   would otherwise block builder admission indefinitely.
//
//   and what counts as NOT-live, which is narrower than "absent from `wanted`".
//   A PR whose evaluation FAILED transiently produces no decision at all
//   (`if (!e.ok) ... continue`, `src/daemon.mjs:579` on `16769e7`), so a
//   `wanted`-only live set drops it and the sweep cancels a request nobody
//   withdrew. A builder takes the freed slot, and the guardian request becomes
//   dispatchable again on the next successful read -- the queued-guardian
//   priority guarantee inverted by a GitHub blip. So the live set is `wanted`
//   PLUS every listed PR that could not be evaluated; a queued row is cancelled
//   only after a SUCCESSFUL non-dispatch decision or a confirmed closure. The
//   per-PR loop records the unevaluated ones as it goes, beside `waiting`.
if (ctx.hub && repoId != null) {
  // The live set includes the CANARY's run ref while this tick still needs an
  // unmeasured containment check. Without it a queued `canary:<nwo>` is
  // cancelled at the top of every tick and re-requested moments later, and a
  // builder racing that gap takes the freed slot -- which defeats the queued-
  // guardian priority guarantee in exactly the window it exists for.
  // `d.e.pr`, not `d.pr`. `decisions` holds `{ e, decision, cause, fp }`
  // (src/daemon.mjs:732 on 16769e7) and `wanted` is a filter over it, so the wrapper
  // survives -- `e.pr` on the wrapper is undefined, every run ref becomes
  // `pr:undefined`, and the sweep then finds NO live request matching any real
  // queued row and cancels all of them on the next tick. That reopens the
  // builder-admission race the queue exists to close, and does it silently.
  const live = new Set(wanted.map(d => `pr:${d.e.pr}`));     // dispatch-worthy only
  if (execute && wanted.length && !containment) live.add(`canary:${nwo}`);

  // FAIL OPEN. This sweep is a hub read on the guardian's path, and the founder
  // decision is that an unreadable scheduler never silences guardian dispatch.
  // Without this catch a locked, corrupt or mid-restore hub throws here --
  // before the per-PR claim's own catch -- and aborts the whole tick, turning a
  // housekeeping sweep into the one thing the scheduler must never be.
  try {
    for (const q of queuedGuardianRequests(ctx.hub, { repoId }))
      if (!live.has(q.run_ref))
        cancelQueued(ctx.hub, { owner: "guardian", repoId, runRef: q.run_ref });
  } catch (err) {
    escalations.set("the provider scheduler is unreadable; dispatching unscheduled", 1);
    log(logPath, `  queued-request sweep skipped — hub unreadable: ${err.message}`);
  }
}
``` A guardian that queues and then finds the PR closed, the head moved, or the tick abandoned must withdraw: a queued guardian request **blocks the next builder admission by design**, so an abandoned one starves the builder indefinitely and looks exactly like a busy guardian. Called on every path out of the dispatch block that did not launch.
  - **The lease is bound to the WORKER, not the daemon.** `claimProvider` records the daemon's pid+lstart at request time because the worker does not exist yet; the dispatch path then re-binds the row to the spawned process (`pid`, `lstart` from the same fail-closed `onSpawn` that records the run) via `bindProviderLease(db, { id, pid, lstart })`. Without that, liveness is asked about a long-lived daemon that is always alive, so a worker that dies takes its slot with it until expiry, and `reapProviderLeases` — whose whole basis is pid+lstart death — can never fire.
  - **Preemption at a safe boundary** (§10.4, `builder.provider.preemptAtBoundary`, default true): when a guardian request is `queued` and every slot is held by builder leases, the builder marks the youngest builder lease `preempt_requested` rather than revoking it. **The column is `provider_lease.preempt_requested`, added by S2-A's migration 1** (`INTEGER NOT NULL DEFAULT 0 CHECK (preempt_requested IN (0,1))`), and it is listed in this plan's consumed-interfaces table: a flag with nowhere to live is a contract with no storage. The builder loop reads that flag **at phase boundaries only** and releases there; nothing is ever killed mid-phase. S2 ships the **column** (S2-A's migration 1) and the **write** (this plan, with a test asserting the flag is set when a guardian is queued and every slot is builder-held). It does **not** ship a reader: no task here modifies `src/doctor.mjs`, and claiming a doctor read that no task implements is exactly the read-never-written shape this programme keeps finding. The builder loop that acts on the flag at a phase boundary is S4's, and S2-A's H-5 finding is where a doctor read belongs when it arrives. Declared gap, not a silent one.
  - `noteRateLimit(db, { signature, now, cooldownSeconds })` — sets `cooldown_until`, `last_429_at`, `last_signature`.
  - `providerDefaults()` → `{ concurrencyLimit: 2, guardianReserved: 1 }` until S3's `build measure-provider` writes measured values with `measured_at`.

- [ ] **Step 1: Write the failing test**

```js
// The subscription is the real choke point, and observation after the fact
// cannot reserve shared quota: two daemons can both see free capacity and both
// launch before either exit is recorded. So admission is a transaction.
//
// The asymmetry between the two owners is deliberate. The guardian is the
// watchman; the builder is the thing being restrained.
/* ... standard harness, plus: ... */
import { openHub } from "../src/build/hubdb.mjs";
import { claimProvider, releaseProvider, noteRateLimit, reapProviderLeases,
         cancelQueued, bindProviderLease, heartbeatProvider } from "../src/provider.mjs";
import { acquireMaintenanceLock } from "../src/build/locks.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
const SRC = new URL("../src", import.meta.url).pathname;

const ALIVE = () => true, DEAD = () => false;
// fixtureCtx is copied from test/worker-contract.test.mjs, whose context carries
// no lstart -- and this plan makes claimProvider REFUSE with 'no-identity' when
// lstart is null. Every ctx below therefore supplies one, or the dispatch
// assertions fail against a correct implementation for a reason unrelated to
// what they test.
const LSTART = "Sat Aug 23 09:00:00 2026";

// ── the admission rule ───────────────────────────────────────────────────────
{
  const db = openHub(join(dir, "p1.db"));           // defaults: limit 2, reserved 1
  const g = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:1", pid: 1, lstart: "A", isAlive: ALIVE });
  check(g.ok, "a guardian claim is admitted", JSON.stringify(g));

  const b = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 2, lstart: "B", isAlive: ALIVE });
  check(!b.ok && b.reason === "at-limit",
    "a builder claim is refused when held leases reach limit minus guardian_reserved (2-1=1)", JSON.stringify(b));

  releaseProvider(db, { id: g.id });
  const b2 = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 2, lstart: "B", isAlive: ALIVE });
  check(b2.ok, "control: once the guardian releases, the builder is admitted");
}

// ── a QUEUED guardian request blocks the next builder admission ──────────────
{
  const db = openHub(join(dir, "p2.db"));
  // INSERT, not UPDATE: a fresh hub has no provider_state row at all (doctor's
  // H-5 finding exists precisely for that state), so an UPDATE changes zero rows
  // and every claim below silently runs on the 2/1 fallback instead of 3/0 --
  // which would make "three builders fit" fail for a reason that has nothing to
  // do with the admission rule.
  db.exec(`INSERT INTO provider_state(provider,concurrency_limit,guardian_reserved)
           VALUES('claude',3,0)
           ON CONFLICT(provider) DO UPDATE SET concurrency_limit=3, guardian_reserved=0`);
  check(db.prepare("SELECT concurrency_limit c, guardian_reserved g FROM provider_state WHERE provider='claude'").get().c === 3,
    "control: the limit really is 3/0 before the claims below run");
  // ALL THREE in the same synthetic epoch, bt:1 oldest. Leaving bt:1 on the wall
  // clock made it the largest requested_at by nine orders of magnitude, so a
  // CORRECT youngest-first implementation flagged bt:1 -- and bt:1's row is
  // released below, taking the flag with it, leaving `flagged.length === 1` to
  // fail against exactly the implementation it is written to accept.
  const a = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE, now: 1000 });
  // DISTINCT timestamps. requested_at is integer seconds, so three claims in
  // the same tick ordinarily share one value and "the youngest builder" has no
  // defined answer -- an implementation ordering by requested_at alone could
  // legitimately flag bt:2, and the assertion below would fail or pass by luck.
  const c = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:2", pid: 2, lstart: "B", isAlive: ALIVE, now: 1001 });
  const d = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:3", pid: 3, lstart: "C", isAlive: ALIVE, now: 1002 });
  check(a.ok && c.ok && d.ok, "three builders fit under a limit of 3 with nothing reserved");
  const g = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 4, lstart: "D", isAlive: ALIVE });
  check(!g.ok && g.reason === "queued", "a guardian that cannot be admitted is QUEUED, not simply refused", JSON.stringify(g));
  // A blocked guardian re-asks on every tick. That must not deepen the queue.
  claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 4, lstart: "D", isAlive: ALIVE });
  claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 4, lstart: "D", isAlive: ALIVE });
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE owner='guardian' AND status='queued'").get().c === 1,
    "re-asking for the SAME run does not add a second queued row");

  releaseProvider(db, { id: a.id });
  const e = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:4", pid: 5, lstart: "E", isAlive: ALIVE });
  check(!e.ok && e.reason === "queued",
    "and the freed slot is not taken by the next builder while a guardian is queued", JSON.stringify(e));
  // The preemption WRITE, asserted in the one fixture that can produce it: a
  // queued guardian with every slot builder-held. Without this an implementation
  // that never sets the flag passes the entire scheduler suite, and S4's
  // phase-boundary reader has no signal to release capacity for the guardian --
  // a contract with storage, a writer named in the interface, and nothing
  // proving the writer runs.
  const flagged = db.prepare(
    "SELECT run_ref FROM provider_lease WHERE owner='builder' AND preempt_requested=1").all();
  check(flagged.length === 1, "exactly one builder lease is marked for preemption", JSON.stringify(flagged));
  // The YOUNGEST, per section 10.4: bt:2 and bt:3 were claimed after bt:1, and
  // bt:1's slot was released above, so bt:3 is the newest live builder.
  check(flagged[0]?.run_ref === "bt:3",
    "and it is the YOUNGEST builder, not whichever row the query happened to reach first",
    JSON.stringify(flagged));
  // Marked, NOT revoked. Preemption happens at a phase boundary; killing here
  // is the behaviour this flag exists to avoid.
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE owner='builder' AND status='held'").get().c === 2,
    "and nothing is revoked: both builder leases are still held");

  const g2 = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 4, lstart: "D", isAlive: ALIVE });
  check(g2.ok, "the queued guardian takes it");
}

// ── a 429 stops builder admission entirely ───────────────────────────────────
{
  const db = openHub(join(dir, "p3.db"));
  noteRateLimit(db, { signature: "rate_limit_exceeded", now: 1000, cooldownSeconds: 300 });
  const b = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE, now: 1100 });
  check(!b.ok && b.reason === "cooldown", "the builder admits nothing while a cooldown is live", JSON.stringify(b));
  check(b.until === 1300, "and is told when it lifts", String(b.until));
  // A guardian under cooldown is QUEUED, not dropped: admission records it so
  // the next builder admission is still blocked behind it. Testing only the
  // builder lets an implementation drop guardian requests during a cooldown,
  // inverting the priority the reservation exists to give them.
  const gq = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:1", pid: 9, lstart: "G", isAlive: ALIVE, now: 1100 });
  check(!gq.ok && gq.reason === "queued", "a guardian request during a cooldown is QUEUED, not dropped", JSON.stringify(gq));
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE owner='guardian' AND status='queued'").get().c === 1,
    "and the queued row exists, so it still blocks the next builder admission");

  const after = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE, now: 1400 });
  check(!after.ok && after.reason === "queued",
    "so after the cooldown the QUEUED GUARDIAN is served first, not the builder", JSON.stringify(after));
  check(db.prepare("SELECT last_signature FROM provider_state WHERE provider='claude'").get().last_signature === "rate_limit_exceeded",
    "and the signature that caused it is recorded");
}

// ── every mutation refuses while a restore holds the lock ────────────────────
// The restore-safety invariant is "assertWritable inside each mutation's own
// transaction", and nothing tested it: a scheduler that omitted the check
// entirely passed every assertion above.
{
  const db = openHub(join(dir, "p5.db"));
  // Seed the rows the three previously-uncovered mutators need, BEFORE the lock
  // is taken -- a mutator that no-ops because it found nothing to change is
  // indistinguishable from one that refused, and would satisfy the assertion
  // below without ever calling assertWritable.
  // Room for TWO builders first. The documented defaults are limit 2 with
  // guardian_reserved 1, so exactly one builder lease fits and the second claim
  // below is refused at the builder limit -- leaving no dead row, and the
  // reaper's deleting path unreachable by the very test that claims to cover it.
  db.exec(`INSERT INTO provider_state(provider,concurrency_limit,guardian_reserved)
           VALUES('claude',2,0)
           ON CONFLICT(provider) DO UPDATE SET concurrency_limit=2, guardian_reserved=0`);
  const held = claimProvider(db, { owner: "builder", repoId: 1, runRef: "seed", pid: 1, lstart: "A", isAlive: ALIVE });
  const dead = claimProvider(db, { owner: "builder", repoId: 1, runRef: "dead", pid: 999, lstart: "GONE", isAlive: ALIVE });
  check(held.ok && dead.ok, "fixture: two live rows exist for the mutators to act on",
    JSON.stringify({ held, dead }));
  // And the dead one must be EXPIRED. Reaping requires expiry AND failed
  // liveness -- the p4 control below asserts exactly that -- so `isAlive: () =>
  // false` alone leaves the reaper's delete unreached and its refusal below
  // would be "nothing to reap" wearing the costume of "the lock stopped me".
  db.exec(`UPDATE provider_lease SET expires_at = unixepoch() - 1 WHERE id = ${dead.id}`);

  acquireMaintenanceLock(db, { pid: 4242, lstart: "L4242", isAlive: ALIVE });
  // ALL SEVEN mutators. The first version of this block covered four, and the
  // three it skipped -- bindProviderLease, heartbeatProvider, and the deleting
  // path in reapProviderLeases -- are the ones that mutate or DELETE rows, so
  // an implementation could reap a live worker's lease mid-restore and still
  // pass a suite advertised as proving "every mutation calls assertWritable".
  for (const [name, run] of [
    ["claimProvider",     () => claimProvider(db, { owner: "builder", repoId: 1, runRef: "r", pid: 1, lstart: "A", isAlive: ALIVE })],
    ["releaseProvider",   () => releaseProvider(db, { id: held.id })],
    ["noteRateLimit",     () => noteRateLimit(db, { signature: "x", cooldownSeconds: 1 })],
    ["cancelQueued",      () => cancelQueued(db, { owner: "builder", repoId: 1, runRef: "r" })],
    ["bindProviderLease", () => bindProviderLease(db, { id: held.id, pid: 4321, lstart: "W" })],
    ["heartbeatProvider", () => heartbeatProvider(db, { id: held.id })],
    // A reaper with a DEAD holder to find: `isAlive: () => false` makes the
    // delete reachable, so this exercises the mutating path rather than the
    // early return that a live-holder fixture would take.
    ["reapProviderLeases", () => reapProviderLeases(db, { isAlive: () => false })],
  ]) {
    // The refusal must be the MAINTENANCE one. A bare `catch { refused = true }`
    // counts every throw as success -- including the `ReferenceError` from a
    // mutator that was never imported, which is exactly how `heartbeatProvider`
    // sat in this list unimported and green. An unexpected error now fails the
    // assertion and prints itself.
    let refused = false, unexpected = null;
    try {
      const r = run();
      refused = r?.ok === false && r.reason === "maintenance";
      if (!refused) unexpected = `returned ${JSON.stringify(r)}`;
    } catch (e) {
      if (/restore|maintenance/i.test(e.message)) refused = true;
      else unexpected = `${e.constructor.name}: ${e.message}`;
    }
    check(refused, `${name} refuses while a live restore holds maintenance_lock`, String(unexpected));
  }
  // Control: with the lock gone the same call succeeds -- otherwise "refuses
  // everything" satisfies all four above.
  db.exec("DELETE FROM maintenance_lock");
  // Reap FIRST. `held` and the expired `dead` row occupy both configured slots,
  // and a claim with `isAlive: ALIVE` cannot reap either -- so the control below
  // would return `at-limit` against a perfectly correct implementation, and read
  // as "the lock is still refusing". Order matters here, and it did not before.
  //
  // This doubles as the reaper's own control: its refusal under the lock could
  // equally have been "there was nothing to reap", and this proves there was.
  const { reaped } = reapProviderLeases(db, { isAlive: (pid) => pid !== 999 });
  check(reaped >= 1,
    "control: with the lock released the reaper really does delete the dead holder's lease",
    String(reaped));
  check(claimProvider(db, { owner: "builder", repoId: 1, runRef: "r2", pid: 1, lstart: "A", isAlive: ALIVE }).ok,
    "control: and the slot the reaper freed is claimable, so the refusals above were the lock");
  db.close();
}

// ── a dead holder's lease is reaped ──────────────────────────────────────────
{
  const db = openHub(join(dir, "p4.db"));
  const a = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 999, lstart: "GONE", isAlive: ALIVE });
  db.exec(`UPDATE provider_lease SET expires_at = unixepoch() - 1 WHERE id = ${a.id}`);
  const blockedWhileAlive = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:2", pid: 2, lstart: "B", isAlive: ALIVE });
  check(!blockedWhileAlive.ok, "an expired lease whose holder is still ALIVE is not reaped: a busy process may miss a heartbeat");
  const { reaped } = reapProviderLeases(db, { isAlive: DEAD });
  check(reaped === 1, `a crashed worker's slot is freed (reaped ${reaped})`);
  check(claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:2", pid: 2, lstart: "B", isAlive: DEAD }).ok,
    "and the next claim is admitted");
}

// ── two daemons racing for the last slot: real processes ─────────────────────
{
  // Needs beyond the standard harness: `spawn` from node:child_process,
  // `mkdirSync`/`readdirSync` from node:fs, and SRC — the absolute path to
  // src/, which the child's generated imports interpolate:
  //   import { spawn } from "node:child_process";
  //   import { mkdirSync, readdirSync } from "node:fs";
  //   const SRC = new URL("../src", import.meta.url).pathname;
  //
  // Written out, not referred to. A comment pointing at another file's pattern
  // is not a test, and this is the ONLY check that admission is transactional:
  // every single-process assertion above passes against a read-then-write
  // implementation with no transaction at all.
  const p = join(dir, "race.db");
  {
    // ONE free slot, explicitly. On the documented defaults (limit 2, reserved 1)
    // the alternating owners can admit two guardians, or a builder plus a
    // guardian, so "exactly one winner" is not a property of the code — it is a
    // property of the numbers, and the assertion would be flaky rather than
    // wrong. limit 1 / reserved 0 makes one winner the only correct outcome.
    const seed = openHub(p);
    seed.exec(`INSERT INTO provider_state(provider,concurrency_limit,guardian_reserved)
               VALUES('claude',1,0)
               ON CONFLICT(provider) DO UPDATE SET concurrency_limit=1, guardian_reserved=0`);
    seed.close();
  }
  const worker = join(dir, "provider-race-worker.mjs");
  writeFileSync(worker, `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHub } from "${SRC}/build/hubdb.mjs";
import { claimProvider } from "${SRC}/provider.mjs";
const db = openHub(process.argv[2]);
const [, , , id, go, ready] = process.argv;
writeFileSync(join(ready, id), "");
while (!existsSync(go)) {}
const r = claimProvider(db, { owner: Number(id) % 2 ? "guardian" : "builder", repoId: 1,
  runRef: "r:" + id, pid: 1000 + Number(id), lstart: "L" + id, isAlive: () => true });
console.log(r.ok ? "HELD" : "no");
`);
  const go = join(dir, "go"), ready = join(dir, "ready");
  mkdirSync(ready, { recursive: true });
  // Capture stderr and the exit code, not just stdout. A child that throws
  // prints nothing to stdout and exits non-zero; collecting only stdout turns
  // that into the empty string, which the old filter counted as "not HELD" --
  // indistinguishable from an orderly refusal.
  const kids = Array.from({ length: 20 }, (_, i) => new Promise((res) => {
    const c = spawn(process.execPath, [worker, p, String(i), go, ready], { encoding: "utf8" });
    let out = "", err = "";
    c.stdout.on("data", d => out += d);
    c.stderr.on("data", d => err += d);
    c.on("exit", (code) => res({ out: out.trim(), err: err.trim(), code }));
  }));
  for (let i = 0; i < 400 && readdirSync(ready).length < 20; i++) await new Promise(r => setTimeout(r, 25));
  check(readdirSync(ready).length === 20, "control: all 20 children reached the barrier before the start");
  writeFileSync(go, "");
  // Every contender must COMPLETE, with a recognised answer. Counting only
  // "HELD" treats a crash -- a lock error, a constraint violation, a throw from
  // a read-then-insert implementation -- as if it were a legitimate refusal, so
  // a broken non-transactional admission where one child wins and nineteen die
  // still reports "exactly one holder". The failure mode this test exists to
  // catch is invisible to it.
  const results = await Promise.all(kids);
  const unrecognised = results.filter(r => r.out !== "HELD" && r.out !== "no");
  check(unrecognised.length === 0,
    "control: all 20 contenders completed with a recognised answer, so a crash cannot read as a refusal",
    JSON.stringify(unrecognised.slice(0, 3)));
  const crashed = results.filter(r => r.code !== 0);
  check(crashed.length === 0,
    "control: and none of them exited non-zero",
    JSON.stringify(crashed.slice(0, 3).map(r => ({ code: r.code, err: String(r.err).slice(0, 120) }))));
  const held = results.filter(r => r.out === "HELD").length;
  check(held === 1, `exactly one of 20 racing processes holds the last slot (got ${held})`);
}
```

- [ ] **Step 2: Run it red, implement, run green, commit**

**On the broken implementation** — an admission written as read-then-write without `BEGIN IMMEDIATE` — every single-threaded assertion passes and only the 20-process race goes red, reporting more than one holder. That is why the race uses real child processes: a same-process loop over one connection is serial by construction and would pass against an implementation with no transaction at all.

```bash
$N test/provider-scheduler.test.mjs
git add src/build/providerdb.mjs src/provider.mjs test/provider-scheduler.test.mjs
git commit -m "feat(provider): transactional admission for the shared subscription"
```

---
### Task 22: The guardian claims a provider lease before dispatch, and fails OPEN

**Files:**
- Modify: `src/daemon.mjs` (at the dispatch site, at **two** places, because the tick spends model quota in two shapes. Re-derived on `16769e7`:

1. **The containment canary**, `measuredContainment(...)` at `src/daemon.mjs:764` on `16769e7` (search that name). It is itself a model dispatch and runs **once per tick**, before the per-PR loop, so it takes its own claim and releases it on return:

```js
   // Declared beside `containment`, ABOVE the canary block, because the per-PR
   // loop below reads it. A `let` inside the block would not be in scope there.
   let skipDispatch = false;
   if (execute && wanted.length && !containment) {
     let canaryLease = null;
     // A hub with no resolvable repository id is FAIL CLOSED here, exactly as it
     // is on the worker path. Treating it like a missing hub would run the
     // canary -- a real model call, real quota -- under no lease at all, which
     // is the single thing the scheduler exists to make impossible.
     if (ctx.hub && repoId == null) {
       escalations.set("the repository numeric id is unknown; provider leases cannot be scoped", 1);
       log(logPath, "execute: NOT running the containment canary — the repository id is unknown");
       // Same shape as the quota refusal below: suppress the DISPATCH, finish
       // the TICK. This one escalates, and an early return would leave that
       // escalation sitting in the map unsent, because notification happens in
       // the epilogue -- a fail-closed path that silences its own alarm.
       skipDispatch = true;
     } else if (ctx.hub) {
       let got;
       // FAIL OPEN on an unreadable hub, the same shape as the per-PR claim.
       // claimProvider is called on a handle that can throw; outside a catch,
       // an unreadable hub aborts the tick instead of letting the guardian
       // proceed unscheduled -- the founder decision inverted at the one site
       // the throwing-hub fixture does not reach, because that fixture stubs
       // ctx.containment.
       try {
         got = (ctx.providerClaim ?? claimProvider)(ctx.hub, {
           owner: "guardian", repoId, runRef: `canary:${nwo}`,
           pid: process.pid, lstart: ctx.lstart, isAlive: isSameProcess });
       } catch (err) {
         escalations.set("the provider scheduler is unreadable; dispatching unscheduled", 1);
         log(logPath, `execute: provider unreadable, running the containment canary unscheduled: ${err.message}`);
         got = { ok: true, id: null };          // unscheduled, not blocked
       }
       if (!got.ok) {
         log(logPath, `execute: NOT running the containment canary — provider ${got.reason}`);
         // NO RETURN. An earlier revision returned a complete result object
         // here, which fixed `reeve tick`'s r.halted crash and still left the
         // real problem: `queued`, `cooldown` and `at-limit` are ORDINARY
         // outcomes, and returning early skips the tick's whole epilogue --
         // self-audit, escalation reconciliation and notification, supply
         // derivation, and noteTick. A quota refusal would leave already-computed
         // escalations unsent and the health bookkeeping unwritten, on the ticks
         // most likely to need both.
         //
         // Suppress the dispatch, not the tick. The per-PR loop is guarded on
         // this flag and the function falls through to its normal return at
         // src/daemon.mjs:1397 (on 16769e7).
         skipDispatch = true;
       }
       canaryLease = got.id;
     }
     // GUARDED. Setting skipDispatch and then calling the canary anyway spends
     // the model request the flag was raised to prevent -- a healthy hub
     // answering `queued`/`at-limit`, or a healthy hub with no repository id,
     // paid real quota under no lease. The flag suppresses the canary AND the
     // per-PR loop; the tick still finishes through its normal epilogue.
     //
     // The INJECTED seam, not the lexical function: every other daemon
     // collaborator is reached as `(ctx.x ?? x)`, and without it the canary
     // test's `ctx.measuredContainment` override is inert -- CI would run the
     // real, host-dependent containment path and the assertion would never see
     // it fire.
     if (!skipDispatch) try {
       containment = await (ctx.measuredContainment ?? measuredContainment)(ctx, profile, nwo, logPath);
     }
     finally {
       // The SAME retry the worker-dispatch cleanup uses. `catch {}` here drops
       // the lease id on the floor: a release refused because a restore holds
       // maintenance_lock would leave the canary holding a provider slot until
       // the lease expires, blocking guardian and builder work alike -- and
       // silently, because the tick otherwise looks like it completed.
       if (canaryLease != null) {
         const ref = { owner: "guardian", repoId, runRef: `canary:${nwo}` };
         try { (ctx.providerRelease ?? releaseProvider)(ctx.hub, { id: canaryLease, ...ref }); }
         catch { (ctx.pendingReleases ??= []).push(ref); }   // identity, not id: see the drain
       }
     }
   }
```

   And a test, because the guardian fixture stubs `ctx.containment` and would
   otherwise let an executor complete every visible step with the canary
   unclaimed: assert that a tick which runs the canary holds exactly one
   `provider_lease` row with `run_ref = canary:<nwo>` **during**
   `measuredContainment`, and none after. An earlier draft of this plan said "before the containment canary" while anchoring at the halt check, which sits at `src/daemon.mjs:793` on `16769e7` — *after* it. The anchor was wrong, not the intent.

2. **Each worker dispatch**, immediately before the spawn and **after every refusal path in the loop**. The halt check is too early: `cannot dispatch FIX_CI — no resolvable root cause` (801), `demonstrated flake` (810) and the other `continue`s all sit between it and the spawn, so a claim taken there is held and abandoned on each — leaking a slot per skipped PR until expiry, starving the builder for reasons unrelated to quota. Claim last: the only thing between the claim and the spawn should be the spawn, which is the same shape: a precondition consulted before dispatch, never after)
- Test: `test/provider-guardian.test.mjs` (new)

**Interfaces:**
- Consumes: `claimProvider`, `releaseProvider`, `noteRateLimit` (Task 21); `hubPathFor`, `openHub` (PR-A).
- Produces: `ctx.hub` — an opened hub handle, or `null`. Defaults to opening `hubPathFor(reeveHome())` **if the file exists**, and to `null` otherwise. `ctx.providerClaim` / `ctx.providerRelease` override the seam in tests. `ctx.hub === null` is a normal, supported state.

**Founder decision 2026-08-22: the guardian fails OPEN.** When the hub is missing, locked, or corrupt, the guardian dispatches exactly as it does today and escalates **`the provider scheduler is unreadable; dispatching unscheduled`** — the guardian's identity, because this escalation lands in the guardian's own store and a `builder:`-grammar subject there reaches nobody. The builder fails closed. The scheduler exists to restrain the builder, and must never become a new way to silence the watchman: a watchman that has stopped looking is indistinguishable from one reporting nothing wrong. This also keeps the existing guardian test files green untouched, which is what §14 asks of every new ctx key, and it matches the shipped `ctx.reviewIngest !== false` shape (search `ctx.reviewIngest !== false`; `src/daemon.mjs:597,1361,1368` on `16769e7`).

- [ ] **Step 1: Write the failing test**

```js
// Two fable/high workers can exhaust the shared subscription's rate window, and
// the guardian's serial tick then blocks inside its inline await on a
// rate-limited FIX_CI, freezing verdicts for every PR on that repo. So the
// dispatch path claims a lease first.
//
// It fails OPEN. If the hub is missing or corrupt the guardian dispatches
// anyway and escalates. The scheduler restrains the BUILDER; a hub outage must
// not become a new way to stop CI from being fixed on every watched repo.
import { tick } from "../src/daemon.mjs";
import { OUTCOMES } from "../src/supervisor.mjs";   // the normalised rate-limit outcome
import { openHub } from "../src/build/hubdb.mjs";
import { claimProvider } from "../src/provider.mjs";
/* ... standard harness, plus: ... */
import { OUTCOMES } from "../src/supervisor.mjs";

// The fixture ctx from test/worker-contract.test.mjs, and the three helpers this
// file needs that neither the harness nor that file supplies. Named here because
// "the fixture from X" does not carry them, and an executor discovers that only
// when the test throws ReferenceError.
const logLines = [];
// This file's own identity constant. The only other `const LSTART` in the plan
// belongs to test/provider-scheduler.test.mjs, and a binding in another file is
// not a binding here -- every healthy-hub fixture below uses it, so the first
// block would stop at ReferenceError before reaching tick().
const LSTART = "Sat Aug 23 09:00:00 2026";
// `repoId` is part of the SHARED fixture, not something each block remembers.
// The plan's own fail-closed check refuses a claim when ctx.repoId is null, so
// a fixture without it makes the ordinary claim/release, exception-release,
// quota-wait and rate-limit blocks all refuse before dispatch -- every one of
// them passing or failing for a reason that has nothing to do with what it
// tests. Only the dedicated missing-id block overrides it back to null.
const fixtureCtx = (dir) => ({ /* ...as in test/worker-contract.test.mjs... */
  repoId: 1,
  log: (_p, line) => logLines.push(String(line)) });
const loggedAny  = (_ctx, re) => logLines.some(l => re.test(l));
const throwingHub = () => ({ prepare: () => { throw new Error("hub unreadable"); },
                             exec:    () => { throw new Error("hub unreadable"); } });
// tick() builds its escalations in a LOCAL Map (src/daemon.mjs:551 on 16769e7) and returns
// it as result.escalations (:554, :562, :578, :1396). It is never attached to
// the ctx it was given, so a helper reading ctx.escalations answers false for
// every case -- including the ones production gets right. Take the RESULT.
const escalatedWith = (result, why) =>
  [...(result?.escalations?.keys?.() ?? [])].some(k => k === why || k.includes(why));

// ── the ordinary path: claim, dispatch, release ──────────────────────────────
{
  const db = openHub(join(dir, "h.db"));
  let dispatched = 0, heldDuringDispatch = -1, ownerDuringDispatch = null,
      boundPidDuringDispatch = null, boundLstartDuringDispatch = null;
  const SPAWNED = { pid: 31337, lstart: "Sat Aug 23 09:30:00 2026" };
  const ctx = { ...fixtureCtx(dir), hub: db, lstart: LSTART,
    spawnWorker: async (opts) => {
      dispatched++;
      // Invoke onSpawn the way the real supervisor does, so the rebinding is
      // exercised. A fixture that ignores its arguments passes while
      // bindProviderLease is never called, and the lease stays bound to the
      // long-lived daemon -- whose liveness is always true, so the reaper can
      // never free the slot.
      opts?.onSpawn?.(SPAWNED);
      heldDuringDispatch = db.prepare("SELECT count(*) c FROM provider_lease WHERE status='held'").get().c;
      const held = db.prepare("SELECT owner, pid, lstart FROM provider_lease WHERE status='held'").get();
      ownerDuringDispatch = held?.owner ?? null;
      boundPidDuringDispatch = held?.pid ?? null;
      boundLstartDuringDispatch = held?.lstart ?? null;
      return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s", model: "m" };
    } };
  await tick(ctx);
  check(dispatched === 1, "the guardian dispatched", String(dispatched));
  check(heldDuringDispatch === 1, "and held exactly one provider lease WHILE the worker ran", String(heldDuringDispatch));
  // Release DELETES the row. Asserting the row survives while also asserting no
  // row is 'held' cannot both be satisfied -- the schema allows only 'queued'
  // and 'held', so the only way to keep the row is to leave the finished request
  // queued, which blocks the next builder admission forever.
  check(db.prepare("SELECT count(*) c FROM provider_lease").get().c === 0,
    "the lease row is gone after release, so the slot is genuinely free",
    JSON.stringify(db.prepare("SELECT * FROM provider_lease").all()));
  check(ownerDuringDispatch === "guardian",
    "and while it was held it recorded the guardian as owner", String(ownerDuringDispatch));
  check(boundPidDuringDispatch === SPAWNED.pid,
    "and was re-bound to the SPAWNED worker's pid, not the daemon's, so a dead worker frees its slot",
    String(boundPidDuringDispatch));
  // The PAIR, not the pid. Liveness everywhere in reeve is `(pid, lstart)`, so a
  // bindProviderLease that writes the pid and leaves the DAEMON's lstart passes
  // the line above and is wrong in the worst direction: the pair never matches,
  // the reaper judges a running worker dead, frees its slot, and admits work
  // beyond the concurrency limit the scheduler exists to enforce.
  check(boundLstartDuringDispatch === SPAWNED.lstart,
    "and to the worker's START TIME too, so the (pid, lstart) pair identifies the worker and not the daemon",
    String(boundLstartDuringDispatch));
  db.close();
}

// ── released even when the worker throws ─────────────────────────────────────
{
  const db = openHub(join(dir, "h2.db"));
  const ctx = { ...fixtureCtx(dir), hub: db, lstart: LSTART, spawnWorker: async () => { throw new Error("boom"); } };
  await tick(ctx).catch(() => {});
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE status='held'").get().c === 0,
    "a worker that throws still releases its lease, so one crash does not consume a slot forever");
}

// ── the builder holding the limit makes the guardian WAIT, not vanish ────────
{
  const db = openHub(join(dir, "h3.db"));
  // INSERT, not UPDATE -- a fresh hub has no provider_state row, so an UPDATE
  // changes nothing and the block silently runs on the 2/1 fallback. This is the
  // sibling of the same defect fixed earlier in the scheduler tests; the class
  // was swept there and not here.
  db.exec(`INSERT INTO provider_state(provider,concurrency_limit,guardian_reserved)
           VALUES('claude',1,0)
           ON CONFLICT(provider) DO UPDATE SET concurrency_limit=1, guardian_reserved=0`);
  claimProvider(db, { owner: "builder", repoId: 9, runRef: "bt:x", pid: 1, lstart: "A", isAlive: () => true });
  let dispatched = 0;
  const ctx = { ...fixtureCtx(dir), hub: db, lstart: LSTART, spawnWorker: async () => { dispatched++; return { outcome: "ok" }; } };
  await tick(ctx);
  check(dispatched === 0, "with no slot free the guardian does not dispatch");
  const q = db.prepare("SELECT count(*) c FROM provider_lease WHERE owner='guardian' AND status='queued'").get().c;
  check(q === 1, "it is QUEUED, which is what blocks the next builder admission", String(q));
  check(loggedAny(ctx, /quota|provider/i), "and it says so in the log rather than looking like a quiet tick");
}

// ── THE decision: an unreadable hub does not silence the guardian ────────────
{
  for (const [label, hub] of [["no hub at all", null], ["a hub that throws", throwingHub()]]) {
    let dispatched = 0;
    const ctx = { ...fixtureCtx(dir), hub, repoId: 1,
      spawnWorker: async () => { dispatched++; return { outcome: "ok" }; } };
    const result = await tick(ctx);
    check(dispatched === 1, `with ${label}, the guardian dispatches exactly as it does today`, String(dispatched));
    // The GUARDIAN-owned identity, matching the production snippet. A `builder:`
    // subject in a per-repo guardian store is announced by nobody (section 11.7),
    // so when the identity changed this assertion had to change with it --
    // otherwise the test enforces the very bug it was written to prevent.
    check(escalatedWith(result, "the provider scheduler is unreadable; dispatching unscheduled"),
      "and escalates under a guardian-grammar identity, so failing open is never failing quiet");
  }

  // The CANARY's claim is a second, separate hub contact, and the fixture above
  // cannot reach it: fixtureCtx stubs ctx.containment, so `!containment` is
  // false and the canary block never runs. A site that is never executed is a
  // site whose fail-open behaviour is asserted by nothing -- which is how it
  // came to be written outside a catch in the first place.
  {
    let canaryRan = 0, dispatched = 0;
    const ctx = { ...fixtureCtx(dir), hub: throwingHub(), repoId: 1, containment: null,
      // A PRODUCTION-SHAPED verdict. `{ ok: true }` is not one: the daemon
      // enters the dispatch loop on `containment.credentialRead === "closed"`,
      // so an `ok` stub leaves containment open and `dispatched === 1` below
      // fails against the very implementation this block is written for.
      measuredContainment: async () => { canaryRan++; return { credentialRead: "closed", why: "test" }; },
      spawnWorker: async () => { dispatched++; return { outcome: "ok" }; } };
    const result = await tick(ctx);
    check(canaryRan === 1, "an unreadable hub does not stop the containment canary either", String(canaryRan));
    check(dispatched === 1, "and the tick still dispatches", String(dispatched));
    check(escalatedWith(result, "the provider scheduler is unreadable; dispatching unscheduled"),
      "and the canary's unreadable-hub path escalates under the same identity");
    check(result && result.halted === false,
      "control: the tick returns a complete result rather than undefined, so `reeve tick` can read r.halted",
      JSON.stringify(result && Object.keys(result)));
  }

  // A quota refusal at the canary is the ordinary case, and it must also finish
  // the tick properly: `bin/reeve tick` reads r.halted at bin/reeve:356.
  {
    const db = openHub(join(dir, "canary-refused.db"));
    let refusedDispatch = 0;
    const ctx = { ...fixtureCtx(dir), hub: db, repoId: 1, containment: null,
      providerClaim: () => ({ ok: false, reason: "at-limit" }),
      measuredContainment: async () => { throw new Error("the canary must not run without a lease"); },
      spawnWorker: async () => { refusedDispatch++; return { outcome: "ok" }; } };
    const result = await tick(ctx);
    check(result && typeof result.halted === "boolean",
      "a canary refused for quota returns a complete tick result, not undefined",
      JSON.stringify(result));
    // BOTH halves. The result assertion alone is satisfied by any tick that
    // returns, including one that dispatched anyway -- and it is also satisfied
    // by nothing at all if the tick THROWS, because the throw takes the whole
    // file down and this line never runs to report which assertion failed.
    check(refusedDispatch === 0,
      "and dispatches nothing: the flag suppresses the work, not merely the canary",
      String(refusedDispatch));
    // CONTROL for the null dereference specifically. `containment` stays null
    // when the canary is skipped, so a dispatch gate that reads it unguarded
    // throws here rather than refusing -- and a thrown tick is indistinguishable
    // from a suite that was never run.
    check(db.prepare("SELECT count(*) c FROM provider_lease").get().c === 0,
      "control: and holds no lease afterwards, so the refusal left nothing behind");
    db.close();
  }
}

// ── existing guardian tests must not have to know this exists ────────────────
{
  // fixtureCtx() carries NO hub key at all -- the shape every pre-existing
  // guardian test file uses. If a missing ctx.hub threw, or refused to
  // dispatch, every one of them would have to be edited.
  const bare = fixtureCtx(dir);
  check(!("hub" in bare), "control: the fixture ctx has no hub key");
  let dispatched = 0;
  await tick({ ...bare, spawnWorker: async () => { dispatched++; return { outcome: "ok" }; } });
  check(dispatched === 1, "a ctx with no hub key at all still dispatches");
}

// ── a rate-limit signature sets the cooldown and fast-fails ─────────────────
{
  const db = openHub(join(dir, "h4.db"));
  const ctx = { ...fixtureCtx(dir), hub: db, lstart: LSTART,
    // OUTCOMES.RATE_LIMITED, not "failed": the implementation branches on the
    // normalised outcome, so a fixture returning the raw string exercises the
    // else-branch and the cooldown assertions below would fail against correct
    // code.
    spawnWorker: async () => ({ outcome: OUTCOMES.RATE_LIMITED, why: "Claude AI usage limit reached", ms: 900 }) };
  await tick(ctx);
  const st = db.prepare("SELECT * FROM provider_state WHERE provider='claude'").get();
  check(st.cooldown_until > Math.floor(Date.now() / 1000), "a rate-limit exit sets a cooldown", JSON.stringify(st));
  check(typeof st.last_signature === "string" && st.last_signature.length > 0, "and records the signature", String(st.last_signature));
}
```

- [ ] **Step 2: Run it and watch it fail**

**On the broken implementation** — a claim written fail-closed, `if (!ctx.hub) return;` — the first three blocks pass and the whole "unreadable hub" block goes red, plus `a ctx with no hub key at all still dispatches`. That last one is the assertion that protects all 59 pre-existing test files, none of which sets `ctx.hub`; without it, a fail-closed claim would be caught only by running the full suite and reading which of the 59 broke.

- [ ] **Step 3: Implement at the dispatch site**

First the two conditions that gate dispatch on containment — `src/daemon.mjs:765`
and `:770` on `16769e7` (search `containment.credentialRead`). **Both dereference
`containment`, and `containment` is now null whenever the canary was skipped**:
every quota refusal and every unknown-repository-id tick. Left as they are, a
refused tick throws `TypeError: Cannot read properties of null (reading
'credentialRead')` on the line immediately after the guard — the exact failure
`skipDispatch` was raised to avoid, moved four lines later. Derive the predicate
once and consult it twice:

```js
  // `!skipDispatch` folded into ONE derivation rather than bolted onto each
  // condition. Both of these read `containment.credentialRead`, and the canary
  // that fills it is skipped on a refusal -- so gating them individually is two
  // chances to forget, and a third reader added later inherits neither. This is
  // also what makes the per-PR loop unreachable on a refusal, which is what the
  // flag was for.
  const mayDispatch = execute && wanted.length > 0 && !skipDispatch;
  if (mayDispatch && containment.credentialRead !== "closed") {
    log(logPath, `execute: NOT dispatching ${wanted.length} worker task(s) — worker containment is open: ${containment.why}`);
    escalations.set("guardian:containment:open", 1);
  }
  if (mayDispatch && containment.credentialRead === "closed") {
```

Note what `mayDispatch` makes unnecessary: an earlier revision of this plan put
an `if (skipDispatch) break;` inside the per-PR loop. That is dead code once the
enclosing block never runs, and it sat *after* both dereferences, so it could
never have prevented the throw. It also cited "the halt check at line 712", which
is wrong — the halt check is `src/daemon.mjs:793` on `16769e7` (search `HALTED
before dispatch`). **This task does not move or duplicate the halt check:**

```js
      if (halted(ctx.haltMarker)) { log(logPath, "HALTED before dispatch"); break; }

      // Claim shared model quota before spending any.
      //
      // Two fable/high workers can exhaust the subscription's rate window, and
      // this tick awaits its worker inline -- so a rate-limited FIX_CI freezes
      // verdict publishing for every other PR on this repo. Observation after
      // the fact cannot reserve quota: two daemons can both see free capacity
      // and both launch before either exit is recorded.
      //
      // FAIL OPEN. If the hub is missing, locked or corrupt, dispatch anyway
      // and escalate. This scheduler exists to restrain the BUILDER; it must
      // never become a new way to stop CI being fixed on every watched repo,
      // because a watchman that has stopped looking reports exactly what a
      // healthy one does.
      // THE CLAIM GOES HERE -- at the spawn seam, after every `continue`.
      // Re-derived on 16769e7: between the halt check (793) and the spawn sit the
      // no-root-cause branch (801), the demonstrated-flake branch (810), and the
      // prompt/worktree preparation branches, each of which can `continue`. A
      // claim taken before them is held and abandoned once per skipped PR, until
      // expiry -- starving the builder for reasons unrelated to quota. The only
      // thing between this block and the spawn must be the spawn.
      let lease = null;
      // Resolved once per tick, not per PR. A missing numeric id is a
      // configuration error, not a reason to write a colliding lease row.
      // `profile.identity.repoId` is not a field the profile schema defines, so
      // that fallback was always null. The numeric id reeve already holds is the
      // one the inbox recorded when it observed this repository; read it from
      // the store and fail closed if absent, rather than inventing a profile key
      // this plan does not add to FIELDS.
      // (The pending-release drain and the repoId binding are BOTH at the top
      // of the tick now, above the queued-request sweep -- see the block that
      // precedes it. Neither may live here: this is the per-PR spawn seam, and
      // a tick with no dispatch-worthy PR, a quota-refused canary, or every
      // candidate exiting through an earlier refusal never reaches this line.
      // A release that failed once would then stay unretried and hold a slot
      // until expiry, and `repoId` -- which the sweep and the canary both read
      // earlier in the tick -- would be a ReferenceError.)

      // Resolved ONCE at daemon start and carried on ctx -- not queried here.
      //
      // Re-measured on 16769e7: the numeric repository id is stored NOWHERE reeve
      // already has. `src/db/schema.sql` has no repo_id column on inbox or any
      // other table, and no live profile carries one. An earlier draft of this
      // plan queried `inbox.repo_id`, which does not exist and would throw.
      //
      // So `bin/reeve` resolves it during startup, where the App credentials
      // already are, and stores it on ctx. `bin/reeve` has no `gh` helper, and
      // the App client it does have returns `{ ok, out }` with `out` as the raw
      // JSON string from `gh api` -- not a parsed object -- so the concrete code
      // is written out here rather than gestured at:
      //
      //     import { authenticate, apiAsInstallation } from "../src/github/app.mjs";
      //     // ...where ctx is built, BEFORE `const ctx = {`:
      //     let repoId = null;
      //     {
      //       // authenticate() can throw; doctor.mjs:267 already guards it the
      //       // same way. A failure here is not fatal to the daemon -- the
      //       // guardian still runs -- it only means provider claims refuse.
      //       const auth = await authenticate(nwo).catch(e => ({ ok: false, why: e.message }));
      //       if (auth.ok) {
      //         const r = apiAsInstallation(auth.token, [`repos/${nwo}`]);
      //         if (r.ok) { try { repoId = JSON.parse(r.out).id ?? null; } catch { repoId = null; } }
      //       }
      //       if (repoId == null)
      //         console.error(`reeve run: could not resolve the numeric id for ${nwo}; ` +
      //                       `provider leases will be refused until it can be read`);
      //     }
      //     // ...then inside the ctx literal, BOTH the value and the seam that
      //     // produced it -- the tick retries through the same function when
      //     // startup could not resolve it (see the top-of-tick block):
      //     repoId,
      //     resolveRepoId: async (n) => {
      //       const a = await authenticate(n).catch(() => ({ ok: false }));
      //       if (!a.ok) return null;
      //       const r = apiAsInstallation(a.token, [`repos/${n}`]);
      //       if (!r.ok) return null;
      //       try { return JSON.parse(r.out).id ?? null; } catch { return null; }
      //     },
      //
      // **`statSync` joins the `node:fs` import too**, for the hub getter's
      // identity check below: `bin/reeve` currently imports
      // `{ existsSync, mkdirSync, renameSync, readFileSync }`.
      //
      // Both outcomes are tested: a stubbed client returning `{ok:true,
      // out:'{"id":4242}'}` puts 4242 on ctx, and one returning `{ok:false}`
      // leaves it null and makes the first provider claim refuse rather than
      // write a row scoped to nothing.
      //
      // A tick never makes that call. If startup could not resolve it, ctx.repoId
      // is null and every provider claim below is refused -- fail closed, because
      // a lease that cannot be scoped to a repository is worse than no lease.
      const repoId = ctx.repoId ?? null;
      if (ctx.hub && repoId == null) {
        // REFUSE, do not merely note it. Falling through spends model quota
        // under no lease at all -- the one thing the scheduler exists to make
        // impossible -- and does it silently, because the escalation reads like
        // the work was stopped.
        escalations.set("the repository numeric id is unknown; provider leases cannot be scoped", 1);
        log(logPath, `  #${e.pr}: NOT dispatching — cannot scope a provider lease without the repository id`);
        continue;
      }
      // WHERE this block goes, exactly: immediately BEFORE `startRun`
      // (search `startRun(db, { nwo, pr: e.pr` -- `src/daemon.mjs:853` on `16769e7`) and the `recordFixAttempt` beside it at `:857`.
      //
      // Both boundaries are load-bearing and they pull in opposite directions.
      // It must be AFTER every earlier refusal (no root cause, demonstrated
      // flake, prompt build, worktree acquisition) or a claimed lease leaks when
      // one of them `continue`s. And it must be BEFORE the attempt is charged:
      // `recordFixAttempt`'s own comment says the attempt is spent "past every
      // refusal, before any work" -- and a provider refusal IS a refusal.
      // Placed after it, a quota wait burns a FIX_CI attempt and marks the
      // durable run failed, so a repository merely at its concurrency limit
      // exhausts its retry budget without a worker ever running.
      if (ctx.hub) {
        try {
          const got = (ctx.providerClaim ?? claimProvider)(ctx.hub, {
            // repo_id is IN the live-request unique key, so a null makes every
            // repository share one key and the second guardian can never queue.
            // `evaluatePr` does not currently return it; resolve it once per tick
            // from the profile's numeric id and fail closed if it is absent,
            // rather than writing a row that collides by construction.
            // isSameProcess(pid, storedStart) is the shipped predicate
            // (src/supervisor.mjs:67). An earlier draft of these plans used the
            // name `pid` + `Alive` joined, which nothing exports, so the claim
            // argument would have thrown at every dispatch.
            owner: "guardian", repoId, runRef: `pr:${e.pr}`,
            pid: process.pid, lstart: ctx.lstart, isAlive: isSameProcess,
          });
          if (!got.ok) {
            log(logPath, `  #${e.pr}: NOT dispatching — provider ${got.reason}` +
                         (got.until ? ` until ${new Date(got.until * 1000).toISOString()}` : ""));
            // Truly no attempt spent, now that this block sits above startRun.
            // The queued row STAYS: this PR still wants a dispatch, so the
            // top-of-tick sweep keeps it live and it is admitted when a slot
            // frees. Cancelling here would surrender the queue position the
            // request exists to hold.
            continue;
          }
          lease = got.id;
        } catch (err) {
          // A GUARDIAN identity, in the guardian's own store. Section 11.7 is
          // explicit that escalation ownership is by process: the guardian never
          // writes a `bt:` or `builder:` identity, and the builder never writes a
          // guardian one, because `announceable` runs in the process that owns
          // the store it reads. Writing `builder:provider:hub-unreadable` here
          // would have put a builder-grammar subject into a per-repo guardian
          // store, where the builder's announcer can never see it and the
          // guardian's grammar does not recognise it -- an escalation that
          // exists and is announced by nobody.
          escalations.set("the provider scheduler is unreadable; dispatching unscheduled", 1);
          log(logPath, `  #${e.pr}: provider scheduler unreadable (${err.message}) — dispatching unscheduled`);
        }
      } else {
        escalations.set("the provider scheduler is unreadable; dispatching unscheduled", 1);
      }

      // Every path from here to the spawn that does NOT launch must give the
      // lease back AND withdraw any queued request for this run ref. The
      // top-of-tick sweep only cancels requests whose PR stopped being
      // dispatch-worthy; a PR that STAYS dispatch-worthy and is refused here on
      // every tick -- a prompt that will not build, a worktree that cannot be
      // acquired, a run that cannot be recorded -- stays in the live set forever
      // and blocks builder admission indefinitely. That is precisely the case
      // the sweep structurally cannot see, and `cancelQueued` was advertised as
      // "called on every path out of the dispatch block that did not launch"
      // while having exactly one caller: the sweep.
      //
      // Insert `abandonClaim(...)` before the `continue` on each of those paths.
      const abandonClaim = (why) => {
        if (lease != null) {
          const ref = { owner: "guardian", repoId, runRef: `pr:${e.pr}` };
          try { (ctx.providerRelease ?? releaseProvider)(ctx.hub, { id: lease, ...ref }); }
          catch { (ctx.pendingReleases ??= []).push(ref); }  // identity, not id: see the drain
          lease = null;
        }
        if (ctx.hub && repoId != null)
          try { cancelQueued(ctx.hub, { owner: "guardian", repoId, runRef: `pr:${e.pr}` }); } catch {}
        log(logPath, `  #${e.pr}: provider claim withdrawn — ${why}`);
      };
```

**And the lease must be RENEWED while the worker runs.** Task 21 defines
`heartbeatProvider` and, before this, no production path called it — the suite
exercised it only as one more mutator that must be refused while
`maintenance_lock` is held, which proves it is guarded and not that it runs. A
normal worker outlives the lease window comfortably; once the row is expired, any
transient failure of the `pid+lstart` probe lets the reaper class a running
worker dead and admit replacement work past the provider limit. That is the exact
over-admission this scheduler exists to prevent, reached through its own
bookkeeping.

The daemon already runs a per-run heartbeat interval (search `ctx.heartbeat ??
heartbeat`; `src/daemon.mjs:873` on `16769e7`). Extend that same interval rather
than adding a second timer, so the two cannot drift:

```js
        // Wrapped separately and swallowed on purpose. A hub made unwritable by
        // a restore must not kill the guardian's RUN heartbeat -- that is the
        // founder decision this whole plan rests on. A missed renewal costs a
        // slot at worst; a thrown interval costs the run.
        if (lease != null && ctx.hub) {
          try { (ctx.providerHeartbeat ?? heartbeatProvider)(ctx.hub, { id: lease }); } catch {}
        }
```

Task 22's test asserts the wiring, not just the function — but **not by
requiring a strictly larger `expires_at`**. Every timestamp here is integer Unix
seconds, so a heartbeat firing in the same second as the claim rewrites the same
value, and a "must ADVANCE" assertion fails against *correct* wiring most of the
time. That was the previous revision: a flaky test wearing a strict one's
clothes.

The seam carries the clock instead, as every other time-dependent assertion in
this plan does. `heartbeatProvider(db, { id, now })` already takes `now`, so the
test injects `ctx.providerHeartbeat` with a `now` a minute ahead and asserts the
exact value that implies:

```js
  let beats = 0;
  const ctx = { ...fixtureCtx(dir), hub: db, lstart: LSTART, heartbeatMs: 5,
    providerHeartbeat: (h, { id }) => { beats++; return heartbeatProvider(h, { id, now: BASE + 60 }); },
    spawnWorker: async (opts) => { opts?.onSpawn?.(SPAWNED); await new Promise(r => setTimeout(r, 40)); /* ... */ } };
  // ...
  check(beats > 0, "the run heartbeat renews the provider lease while the worker runs", String(beats));
  check(heldAfter.expires_at === BASE + 60 + LEASE_SECONDS,
    "and the lease expires from the heartbeat's clock, not the claim's",
    `${heldAfter.expires_at} vs ${BASE + 60 + LEASE_SECONDS}`);
```

Deterministic, and it still fails on the implementation that matters: with
`heartbeatProvider` defined and uncalled — which is what ships today — `beats`
is 0 and both lines go red. `beats > 0` alone would not be enough, because it
passes for a heartbeat that is called and writes nothing.

**The paths that must call it**, each identified by the `continue` it already
takes in `src/daemon.mjs`: the `!run.ok` branch after `startRun`, the prompt-build
refusal, the worktree-acquisition refusal, and the demonstrated-flake refusal if
it is reached after the claim. The rule is mechanical — **if a `continue` sits
below the claim block, it calls `abandonClaim` first** — and Task 22's test
asserts it with a fixture whose `startRun` is stubbed to fail:

```js
// a previously QUEUED request that is refused before spawn is withdrawn
{
  const db = openHub(join(dir, "h6.db"));
  // `pr:42`, not `pr:7`. The fixture copied from test/worker-contract.test.mjs
  // lists and evaluates PR **42** (`openPrs: () => [42]`, `evaluation.pr = 42`),
  // so a row for pr:7 is not dispatch-worthy -- the new top-of-tick sweep cancels
  // it as stale before the refusal path is ever reached, and the assertion
  // passes without `abandonClaim` existing at all.
  db.exec(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,priority,status,requested_at,expires_at)
           VALUES('guardian',1,'pr:42',1,'L1',0,'queued',unixepoch(),unixepoch()+120)`);
  // `ctx.startRun` is INERT unless production is changed to read the seam: the
  // daemon calls the lexical `startRun` at `src/daemon.mjs:853` on `16769e7`
  // (search `const run = startRun(db,`). Without the change the real run
  // succeeds, `spawnWorker` throws into the daemon's preparation catch, the
  // provider cleanup removes the row on THAT path, and both assertions below
  // pass while the `!run.ok` branch and its `abandonClaim` call are never
  // reached -- a test that is green whether or not the feature exists.
  //
  // So this task's `src/daemon.mjs` change includes making that call
  // `(ctx.startRun ?? startRun)(db, { ... })`, the same shape every other
  // collaborator in the tick already uses.
  const ctx = { ...fixtureCtx(dir), hub: db, repoId: 1, lstart: LSTART,
    startRun: () => ({ ok: false, why: "the run could not be recorded" }),
    spawnWorker: async () => { throw new Error("must not dispatch"); } };
  // CONTROL: the row is there when the tick begins, so its absence afterwards is
  // a withdrawal rather than a fixture that never seeded it.
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE run_ref='pr:42'").get().c === 1,
    "fixture: the queued request exists before the tick");
  await tick(ctx);
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE run_ref='pr:42' AND status='queued'").get().c === 0,
    "a queued request whose dispatch is refused before spawn is withdrawn, not left blocking admission");
  // CONTROL: a request whose dispatch SUCCEEDS keeps nothing queued either, so
  // the assertion above is about withdrawal and not about the row never existing.
  check(db.prepare("SELECT count(*) c FROM provider_lease").get().c === 0,
    "control: no provider rows survive the tick at all", 
    JSON.stringify(db.prepare("SELECT * FROM provider_lease").all()));
  db.close();
}

      try {
        /* ... the existing dispatch ... */
      } finally {
        // Released here rather than at each exit path: a slot held by a worker
        // that is already gone starves everything for a full lease window.
        // A refused release is REMEMBERED, not discarded: swallowing it leaks the
        // slot for a full lease window. ctx.pendingReleases drains at the top of
        // the next tick, and a restore clears provider_lease outright, so the
        // worst case is one tick of delay rather than a lost slot.
        if (lease != null) {
          // IDENTITY, not id -- the same reason as the drain at the top of the
          // tick: a restore clears and renumbers provider_lease, so a queued
          // integer key can come back pointing at somebody else's lease.
          const ref = { owner: "guardian", repoId, runRef: `pr:${e.pr}` };
          try { (ctx.providerRelease ?? releaseProvider)(ctx.hub, { id: lease, ...ref }); }
          catch { (ctx.pendingReleases ??= []).push(ref); }
        }
      }
```

And on a rate-limit exit, before the `finally` releases:

```js
        // Rate limits are ALREADY normalised by the supervisor -- `--print` exits
        // with api_error_status 429 and the runner maps it to OUTCOMES.RATE_LIMITED
        // (src/supervisor.mjs:220). Re-matching a regex against the reason text
        // would be a second, weaker classifier for a question already answered,
        // and it would drift the first time the wording changed. The variable at
        // this dispatch site is `r`, the same one the rate-limit branch already reads (search `OUTCOMES.RATE_LIMITED`; `src/daemon.mjs:1272` on `16769e7`).
        // OUTCOMES is already imported in daemon.mjs (search `OUTCOMES.RATE_LIMITED`);
        // no new import is needed here.
        // The fast-fail of §10.4 is about not WAITING on the window: the attempt
        // ends in seconds instead of blocking the serial tick for hours. This
        // branch runs after the worker has already exited, so it records the
        // cooldown; the termination half belongs at the dispatch seam, where the
        // supervisor already maps api_error_status 429 to this outcome and ends
        // the run. Noted here because "fast-fail" reads as one mechanism and is
        // two, and only one of them is in this file.
        if (r.outcome === OUTCOMES.RATE_LIMITED) {
          try { noteRateLimit(ctx.hub, { signature: (r.why ?? "").slice(0, 200),
                  cooldownSeconds: profile.builder?.provider?.cooldownSeconds ?? 300 }); }
          catch {
            // QUEUED, not dropped. Every provider mutation throws while a restore
            // holds `maintenance_lock`, and this one is the fast-fail itself:
            // discarding it means that the moment the restore finishes, the
            // scheduler admits another worker into the same exhausted rate
            // window and pays for the 429 again. Same shape as `pendingReleases`.
            //
            // `now` is captured HERE, not at drain time: the cooldown runs from
            // the 429, and stamping it a tick later silently extends the window
            // by however long the restore took.
            (ctx.pendingRateLimits ??= []).push({
              signature: r.signature ?? "rate_limit_exceeded",
              now: Math.floor(Date.now() / 1000),
              cooldownSeconds: profile.builder?.provider?.cooldownSeconds ?? 300 });
          }
        }
```

`ctx.hub` is constructed in **`bin/reeve`**, where the rest of `ctx` is built — not in `daemon.mjs`, which only consumes it. Without that, every real `reeve run` has `ctx.hub === undefined`, takes the fail-open branch on every tick, and the scheduler is dark in production while every test that injects a hub passes:

```js
    // in bin/reeve, case "run": beside `db: open(dbPath)`
    // A GETTER, not a value computed once. A destructive restore replaces the
    // file underneath this connection, and a long-lived handle then points at a
    // deleted inode for the rest of the process's life -- failing open forever
    // while the hub is in fact healthy, which is the worst version of fail-open
    // because nothing ever reports it. Each access cheaply probes the handle and
    // reopens if it has gone stale.
    get hub() {
      const hp = hubPathFor(HOME);
      let st = null;
      try { st = statSync(hp); } catch { this._closeHub(); return null; }

      // IDENTITY first, liveness second -- and identity is the half that
      // matters, because a query cannot detect a restore.
      //
      // Measured 2026-08-23 (docs/measured/2026-08-23-guest-connection-and-
      // restore.md): after `restoreHub` renames its staged file over this path,
      // `SELECT count(*) FROM provider_state` on the ALREADY-OPEN handle keeps
      // SUCCEEDING and keeps returning rows from the replaced inode, while a
      // fresh connection sees the restored database. POSIX rename unlinks the
      // directory entry, not the inode, and SQLite holds the descriptor -- so
      // there is no error for a catch to catch, and an earlier version of this
      // getter (which reasoned that "reading a real table is what detects the
      // swap") would have left the daemon attached to pre-restore scheduler and
      // hold state indefinitely, silently.
      if (this._hub && this._hubIno === st.ino) {
        // The handle is the right file; ask whether it still works. A permitted
        // statement, and one that actually touches the file: the authorizer
        // denies a bare `SELECT 1` (no table, so no READ to allow), and a probe
        // the guest rejects would make the getter reopen on every access.
        try { this._hub.prepare("SELECT count(*) c FROM provider_state").get(); return this._hub; }
        catch { /* corrupt, locked, or closed: fall through and reopen */ }
      }
      // Stat BEFORE and AFTER the open, and accept the handle only when the
      // path did not move under it. Recording the POST-open stat alone
      // reintroduces this getter's own bug one level up: a restore landing
      // between `openHubAsGuest` and the stat leaves a handle on the OLD inode
      // with the NEW inode recorded beside it, after which every later check
      // matches, the probe succeeds, and the stale database is served forever.
      //
      // Bounded retries, then null. Null fails OPEN for the guardian, which is
      // the founder decision: a scheduler it cannot read never stops dispatch.
      this._closeHub();
      for (let attempt = 0; attempt < 3; attempt++) {
        let before, h, after;
        try { before = statSync(hp).ino; } catch { break; }
        try { h = openHubAsGuest(hp); } catch { break; }
        try { after = statSync(hp).ino; } catch { try { h.close(); } catch {} break; }
        if (before === after) { this._hub = h; this._hubIno = after; return this._hub; }
        try { h.close(); } catch {}      // a restore landed mid-open; try again
      }
      return this._hub;
    },
    // Closing matters: a replaced handle that is merely dropped keeps the old
    // inode's file descriptor open until GC, which on a long-running daemon
    // means the restored-away database is never actually released.
    _closeHub() { try { this._hub?.close(); } catch {} this._hub = null; this._hubIno = null; },
    lstart: readStart(process.pid),
```

Opened **as a guest**, never with `openHub`: the daemon must not be able to reach a table the allowlist forbids, and `openHub` would also apply migrations — the guardian is not the hub's migrator.

**`ctx.lstart` must be populated in the same place, and must not default to `""`.** Liveness is deliberately pid AND lstart everywhere in this plan, because a recycled pid inheriting a lease is a second holder with the first one's authority. A lease row written with an empty lstart can never match a live probe, so the reaper and `restoreHub` would treat every guardian claim as dead and reap slots out from under running workers. `supervisor.mjs` already exports the reader:

```js
import { readStart } from "../src/supervisor.mjs";   // bin/reeve is one level down
// ...where ctx is built:
lstart: readStart(process.pid),
```

`readStart` returns null when `ps` cannot answer. Null is not a usable identity, so `claimProvider` refuses the claim rather than writing a row that can never be matched — the same fail-closed shape as the `onSpawn` binding (§4.5): an identity that cannot be recorded means the work does not start.

- [ ] **Step 4: Run the FULL guardian suite; this is the PR that could break it**

```bash
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac   # writes into the live daemon's ~/.reeve/canary
  $N "$f" >/dev/null || echo "FAILED $f"
done
```

Expected: no `FAILED` lines. Any pre-existing guardian file that goes red here means the claim is not defaulting correctly, not that the file needs editing.

- [ ] **Step 5: Commit**

```bash
# bin/reeve carries the production ctx.hub getter and the lstart identity; without
# it the scheduler is dark in production while every injected-hub test passes.
git add src/daemon.mjs bin/reeve test/provider-guardian.test.mjs
git commit -m "feat(daemon): claim provider quota before dispatch, fail open"
```

---

### Task 23: The guardian's hub connection reaches exactly three things

**Files:**
- Create: `src/build/hubguest.mjs`, `test/guardian-hub-allowlist.test.mjs`
- Modify: `src/daemon.mjs` (open the hub through the guest)

**Interfaces:**
- Consumes: `hubPathFor` (PR-A).
- **This task splits in two, because Tasks 22 and 23 would otherwise depend on each other.** Task 22's `bin/reeve` wiring imports `openHubAsGuest`, so the module must exist first; but Task 23's structural control asserts `bin/reeve` already calls it, so the wiring must exist first. Neither can be done second. The split:
  - **23a — the module.** Create `src/build/hubguest.mjs` with the authorizer and the sealed method surface, plus `test/guardian-hub-allowlist.test.mjs`'s statement and API assertions, which build their own guest handle and need no `bin/reeve` change. **Do this before Task 22.**
  - **23b — the structural control.** After Task 22 has wired `bin/reeve`, add the assertion that no privileged `openHub(` remains in `bin/reeve` or `src/daemon.mjs`, with its positive control that a guest call is present.

  - **23b needs its own commit, after Task 22.** The split as written left the
    structural control with nowhere to land: 23a is committed before Task 22, so
    Task 23's single commit has already happened by the time the assertion
    exists, and Task 22's `git add` does not stage
    `test/guardian-hub-allowlist.test.mjs`. Deferring 23a's commit instead is
    worse — Task 22 would then commit an import of an untracked module. So the
    order is: **23a implement and commit → Task 22 → 23b add the control and
    commit it**, with 23b's own step:

    ```bash
    git add test/guardian-hub-allowlist.test.mjs
    git commit -m "test(guardian): no privileged hub open remains in the daemon"
    ```

  Stated as an explicit order rather than left for an executor to discover by deadlock.
**The profile keys this plan advertises must be declared in `FIELDS`, in this
task.** `src/profile/schema.mjs` is fail-closed on unknown keys — `unknown key:
${p}` at `src/profile/schema.mjs:352` on `16769e7` — so an operator who sets any
control this plan documents kills **every** `reeve run` at profile load rather
than tuning the scheduler. That is the same failure mode measured for
`ci.flakePatterns`, in the opposite direction.

Sweeping the three plans for `builder.*` reads against the 8 declared keys found
three undeclared, not the two that were reported. Two belong here:

```js
  "builder.provider.cooldownSeconds":     [false, v => (Number.isInteger(v) && v > 0 ? null : "must be a positive integer")],
  "builder.provider.repoIdRetryMinutes":  [false, v => (Number.isInteger(v) && v > 0 ? null : "must be a positive integer")],
  "builder.provider.preemptAtBoundary":   [false, isBool],
```

with matching entries in `DEFAULTS` (`300`, `10`, `true`) and
**`"builder.provider"` added to the container list** at `src/profile/schema.mjs:338`
— that list is separate from the derived container set, and without the entry a
profile with `builder: { provider: "oops" }` takes the defaults as named
properties and validates.

The third, `builder.cancel.drainMinutes`, is read by S2-B's `applyTransition` and
belongs to that plan; it is recorded in B's consumed-interfaces table so neither
plan assumes the other declared it.

- Produces: `openHubAsGuest(path) -> DatabaseSync` — a connection whose `prepare`/`exec` refuse any statement outside the allowlist: `INSERT`/`UPDATE`/`DELETE`/`SELECT` on `provider_lease` and `provider_state`, `SELECT` on `pr_hold`, `SELECT`/`DELETE` on `maintenance_lock`, and the three transaction-control statements `BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`.

**On §13's "exactly two touches".** §13 says the guardian *writes* the provider scheduler and *reads* `pr_hold`, and nothing else. `maintenance_lock` is a third table, so the wording and this allowlist have to be reconciled rather than quietly diverged. They are reconciled this way: the lock is not a third **surface**, it is the precondition on the two it already has. Every hub writer checks it before writing — that is the property S2-A established for the singleton, the writer lease and every provider mutation alike — and a guardian that could write `provider_lease` while a restore is replacing the file would reopen the race the lock exists to close. The `DELETE` is the ordinary reap of a lock whose holder is provably dead, identical to what every other writer does; it grants no new reach. The design's sentence describes surfaces the guardian acts *on*; this is the check it acts *under*. Worth a line in §13 when the design is next amended, so the two do not read as contradictory to someone checking. Everything else throws, naming the statement.
  **Transaction control is not an oversight in the §13 wording**: `claimProvider` and `releaseProvider` do their writes through `hubTx`, which issues those three via `db.exec`. An allowlist of tables only would refuse the guardian its own admission transaction, and §10.4 requires that admission be evaluated under `BEGIN IMMEDIATE` — so excluding them does not narrow the surface, it breaks it.

**Why a wrapper and not a convention.** §13 states the guardian's hub surface is exactly two touches, and a test asserts it. A comment saying "do not touch other tables" is checked by whoever remembers; a connection that refuses is checked by the connection. It also makes the §13 claim provable rather than argued — which matters because a boundary is only worth what its enforcement is worth.

- [ ] **Step 1: Write the failing test**

```js
// Section 13: the guardian's hub surface is exactly two touches -- it WRITES
// the provider scheduler and it READS pr_hold. Nothing else.
//
// Asserted at the connection, not by review. A guardian that grew a third touch
// would still pass every functional test it has; this is the only thing that
// would notice.
import { openHubAsGuest } from "../src/build/hubguest.mjs";
import { openHub } from "../src/build/hubdb.mjs";
import { claimProvider } from "../src/provider.mjs";   // the end-to-end guest assertion
/* ... standard harness ... */

const p = join(dir, "g.db");
openHub(p).close();
const g = openHubAsGuest(p);

const allowed = [
  // Transaction control: claimProvider and releaseProvider write through hubTx,
  // and section 10.4 requires the admission rule to be evaluated under
  // BEGIN IMMEDIATE. A table-only allowlist refuses the guardian its own
  // transaction, which is not a narrower surface -- it is a broken one.
  // Ordered so each is legal where it runs: a standalone ROLLBACK after a COMMIT
  // fails with "cannot rollback - no transaction is active", which would report
  // an allowlist refusal that never happened.
  ["BEGIN IMMEDIATE", "begin a transaction"],
  ["ROLLBACK", "roll back"],
  ["BEGIN IMMEDIATE", "begin again"],
  ["COMMIT", "commit"],
  ["SELECT * FROM provider_lease", "read provider_lease"],
  ["SELECT * FROM provider_state", "read provider_state"],
  ["INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,priority,status,requested_at,expires_at) VALUES('guardian',1,'r',1,'x',0,'held',1,2)", "insert a provider lease"],
  ["UPDATE provider_lease SET status='held' WHERE id=1", "update a provider lease"],
  ["DELETE FROM provider_lease WHERE id=1", "delete a provider lease"],
  ["UPDATE provider_state SET cooldown_until=1 WHERE provider='claude'", "update provider state"],
  ["SELECT * FROM pr_hold WHERE repo_id=1 AND pr=2 AND cleared_at IS NULL", "read pr_hold"],
  // maintenance_lock: every provider mutation calls assertWritable, which READS
  // the lock and DELETES it when its holder is dead. Round 2 added that
  // requirement and did not widen this allowlist, so every ordinary guardian
  // claim would have failed at the maintenance check before reaching
  // provider_lease at all -- one fix breaking another.
  ["SELECT * FROM maintenance_lock WHERE name='restore'", "read the maintenance lock"],
  ["DELETE FROM maintenance_lock WHERE name='restore'", "reap a dead restore's lock"],
];
for (const [sql, name] of allowed) {
  let ok = true; try { g.prepare(sql); } catch { ok = false; }
  check(ok, `allowed via prepare: ${name}`);
  // exec too: production admission runs through hubTx, which issues BEGIN
  // IMMEDIATE / COMMIT / ROLLBACK via exec(). A wrapper that permits a shape on
  // prepare and refuses it on exec passes every assertion here and then refuses
  // the guardian its own transaction in production.
  let okExec = true; try { g.exec(sql); } catch { okExec = false; }
  check(okExec, `allowed via exec: ${name}`);
}
// And the real thing, end to end: a claim through hubTx must complete.
{
  let why = null;
  try { claimProvider(g, { owner: "guardian", repoId: 1, runRef: "pr:1", pid: 1, lstart: "L", isAlive: () => true }); }
  catch (e) { why = e.message; }
  check(why === null, "a real claimProvider call completes through the guest connection", String(why));
}

const refused = [
  ["SELECT * FROM task", "read task"],
  ["SELECT * FROM approval", "read approval"],
  ["SELECT * FROM merge_decision", "read merge decisions"],
  ["UPDATE pr_hold SET cleared_at=1", "WRITE pr_hold"],
  ["INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at) VALUES('t',1,2,'s','cancel',1)", "insert a pr_hold"],
  ["INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count) VALUES('bt:1:x',1,1,1,0)", "write a builder escalation"],
  ["INSERT INTO outbox(idempotency_key,kind,task_generation,fence,args,created_at,updated_at) VALUES('k','notify',1,1,'{}',1,1)", "enqueue an effect"],
  ["DROP TABLE task", "drop anything"],
  ["ATTACH DATABASE 'other.db' AS o", "attach another database"],
  ["PRAGMA writable_schema=ON", "reach the schema sideways"],
  // A verb-and-table extraction does not enforce a table boundary: the FROM
  // clause names only the FIRST table. Each of these reaches a forbidden table
  // through a permitted one.
  ["SELECT * FROM provider_lease JOIN task ON 1=1", "join a forbidden table onto a permitted one"],
  ["SELECT (SELECT count(*) FROM approval) FROM provider_lease", "read a forbidden table in a subquery"],
  ["SELECT * FROM provider_lease UNION SELECT * FROM merge_decision", "union a forbidden table"],
  ["INSERT INTO provider_lease SELECT * FROM merge_decision", "insert FROM a forbidden table"],
  // Multi-statement: an exec wrapper that validates only the FIRST statement
  // lets everything after the semicolon through. The authorizer sees each
  // accessed object regardless of how many statements the string carries.
  ["SELECT * FROM provider_lease; SELECT * FROM task", "reach a forbidden table after a semicolon"],
  ["BEGIN IMMEDIATE; DELETE FROM approval", "reach a forbidden table after a permitted statement"],
];
// The non-statement APIs are the other half of the surface. Measured on node
// v24.17.0, DatabaseSync exposes seventeen methods; gating prepare and exec
// leaves the mutation-capable ones open.
for (const m of ["setAuthorizer", "applyChangeset", "deserialize", "loadExtension", "enableLoadExtension",
                 "createSession", "serialize"]) {
  let refused = false;
  try { g[m](); } catch { refused = true; }
  check(refused, `refused: the non-statement API ${m}() is not reachable on the guest`);
}

// Transaction SHAPE, which the authorizer cannot see: it reports arg1 as
// "BEGIN" for every flavour (measured 2026-08-23). An exclusive lock taken by
// the guardian blocks the builder and every restore.
for (const [sql, name] of [
  ["BEGIN EXCLUSIVE", "an exclusive transaction"],
  ["BEGIN DEFERRED", "a deferred transaction"],
  ["BEGIN", "a bare BEGIN, which is DEFERRED"],
  ["SELECT count(*) FROM provider_state; BEGIN EXCLUSIVE", "an exclusive BEGIN hidden behind a permitted statement"],
  ["/* guest */ BEGIN EXCLUSIVE", "an exclusive BEGIN behind a block comment"],
  ["-- guest\nBEGIN EXCLUSIVE", "an exclusive BEGIN behind a line comment"],
  ["\t/*x*/BEGIN EXCLUSIVE", "an exclusive BEGIN behind leading whitespace and a comment"],
  // The two that defeated the regex version. A comment marker inside a string
  // literal is not a comment, and treating it as one hid the semicolon too.
  ["SELECT '--'; BEGIN EXCLUSIVE", "an exclusive BEGIN behind a line-comment marker in a LITERAL"],
  ["SELECT '/*'; BEGIN EXCLUSIVE", "an exclusive BEGIN behind a block-comment marker in a LITERAL"],
  ["SAVEPOINT sp", "a savepoint"],
]) {
  for (const via of ["prepare", "exec"]) {
    let why = null; try { g[via](sql); } catch (e) { why = e.message; }
    check(why !== null, `refused via ${via}: ${name}`, String(why));
  }
}
// CONTROL: the one permitted form still works through both doors, or "refuses
// every BEGIN" satisfies all ten assertions above and breaks hubTx in production.
for (const via of ["prepare", "exec"]) {
  let ok = true; try { g[via]("BEGIN IMMEDIATE"); } catch { ok = false; }
  check(ok, `control: BEGIN IMMEDIATE is still permitted via ${via}`);
  try { g.exec("ROLLBACK"); } catch {}
}
// CONTROLS for the scanner itself. A gate that refuses ordinary SQL containing
// a semicolon, a `--`, or an escaped quote inside a literal would pass every
// refusal above and then break providerdb.mjs in production -- the over-fix.
for (const [sql, name] of [
  ["SELECT * FROM provider_lease WHERE run_ref = 'a;b'", "a semicolon inside a literal"],
  ["UPDATE provider_state SET last_signature = 'x--y' WHERE provider='claude'", "a comment marker inside a literal"],
  ["SELECT * FROM provider_lease WHERE run_ref = 'it''s'", "a doubled-quote escape"],
  ["SELECT count(*) c FROM provider_state -- trailing comment", "a genuine trailing comment"],
]) {
  let ok = true; try { g.prepare(sql); } catch { ok = false; }
  check(ok, `control: ordinary SQL with ${name} is still permitted`, sql);
}
for (const [sql, name] of refused) {
  let why = null; try { g.prepare(sql); } catch (e) { why = e.message; }
  check(why !== null, `refused via prepare: ${name}`);
  // exec() is the other door, and it is the one a multi-statement string walks
  // through. A wrapper that gates prepare and leaves exec open is not an
  // allowlist; the boundary promises BOTH.
  let execWhy = null; try { g.exec(sql); } catch (e) { execWhy = e.message; }
  check(execWhy !== null, `refused via exec: ${name}`);
  // THREE shapes, because a refusal has one shape per REASON, not one per
  // boundary. Measured 2026-08-23: a denied SELECT or INSERT says
  // `not authorized`; a denied SQLITE_READ says
  // `access to provider_state.owner is prohibited`; and the facade's own
  // transaction-shape and method gates say `not permitted`. The original
  // `/allowlist|not permitted/` matched none of the two SQLite produces, so
  // this assertion FAILED against a correct implementation -- and the natural
  // response to that is to loosen the authorizer until the text changes.
  check(/not authorized|is prohibited|not permitted/i.test(why ?? ""),
    `  and says why: ${name}`, String(why));
}

// Control: the SAME statements succeed on an ordinary hub connection, so the
// refusals above are the guest wrapper and not a broken database.
{
  const owner = openHub(p);
  let ok = true; try { owner.prepare("SELECT * FROM task"); } catch { ok = false; }
  check(ok, "control: an ordinary hub connection reads task normally");
  owner.close();
}

// Control: the allowlist is on the STATEMENT, not on a flag someone can forget.
// A guardian that opened the hub with openHub() instead would pass every
// functional test; this is the assertion that would catch it.
{
  // bin/reeve is where the production connection is opened, so that is the file
  // to inspect. Reading daemon.mjs asserts a property of a file that never
  // opens the hub at all, which is true and meaningless.
  const src = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8")
            + readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  // Strip the guest calls, THEN look for a privileged one. The earlier form
  // passed whenever the file mentioned openHubAsGuest anywhere, which is exactly
  // the mixed usage it claimed to catch -- and every statement-level test would
  // still pass, because those build their own guest handle and never touch the
  // daemon's real connection.
  const withoutGuest = src.replace(/openHubAsGuest\s*\(/g, "");
  check(!/\bopenHub\s*\(/.test(withoutGuest),
    "daemon.mjs never opens a PRIVILEGED hub connection; every open goes through the guest",
    (withoutGuest.match(/.*\bopenHub\s*\(.*/g) ?? []).slice(0, 3).join("\n        "));
  check(/openHubAsGuest\s*\(/.test(src),
    "control: it does open one through the guest, so the assertion above is not vacuous");
}
```

- [ ] **Step 2–4: Run it red, implement, run green, commit**

Implement `openHubAsGuest` with **SQLite's own authorizer**, not string parsing.

Measured on node v24.17.0: `DatabaseSync` exposes `setAuthorizer`, and gating text was never going to hold. The same measurement shows the connection also exposes `aggregate, applyChangeset, createSession, createTagStore, deserialize, enableDefensive, enableLoadExtension, exec, function, loadExtension, location, open, prepare, serialize, setAuthorizer` — so a wrapper that gates `prepare` and `exec` leaves `applyChangeset` (arbitrary mutation), `deserialize` (replace the entire database), and `loadExtension` (arbitrary native code) untouched. Gating two methods on a seventeen-method object is not a boundary.

**The constants live under `constants`, not the module root** — measured on node
v24.17.0: `require("node:sqlite").SQLITE_READ` is `undefined`, while
`require("node:sqlite").constants.SQLITE_READ` is `20`. The callback receives
`(action, arg1, arg2, …)`; a `SELECT count(*) FROM provider_state` was observed
to fire `21 SQLITE_SELECT`, then `31 SQLITE_FUNCTION` with `arg2 = "count"`,
then `20 SQLITE_READ` with `arg1 = "provider_state"`.

```js
import { DatabaseSync, constants as C } from "node:sqlite";

export function openHubAsGuest(path) {
  const db = new DatabaseSync(path, { timeout: 10000 });
  const READ  = new Set(["provider_lease", "provider_state", "pr_hold", "maintenance_lock"]);
  // maintenance_lock is NOT here. The guest may DELETE a dead holder's lock and
  // nothing else: authorising INSERT and UPDATE on it would let guardian code
  // create, replace or prolong the restore lock, which is the opposite of the
  // property that lock exists to provide.
  const WRITE = new Set(["provider_lease", "provider_state"]);
  // A closed list of built-ins the permitted statements actually use. Denying
  // SQLITE_FUNCTION by default would reject the production getter's own probe.
  const FUNCS = new Set(["count", "unixepoch", "max", "coalesce"]);

  // The authorizer runs inside SQLite, per accessed object, AFTER parsing. A
  // join, a subquery, a UNION, an INSERT ... SELECT and a multi-statement string
  // all decompose into the same per-table actions, so none of them can smuggle a
  // table past it -- which is exactly what a text matcher cannot promise.
  db.setAuthorizer((action, arg1, arg2) => {
    switch (action) {
      case C.SQLITE_READ:   return READ.has(arg1)  ? C.SQLITE_OK : C.SQLITE_DENY;
      case C.SQLITE_INSERT:
      case C.SQLITE_UPDATE: return WRITE.has(arg1) ? C.SQLITE_OK : C.SQLITE_DENY;
      // DELETE additionally permits maintenance_lock: reaping a provably dead
      // restore's lock is the one write the guest needs on that table.
      case C.SQLITE_DELETE: return (WRITE.has(arg1) || arg1 === "maintenance_lock")
                                     ? C.SQLITE_OK : C.SQLITE_DENY;
      case C.SQLITE_TRANSACTION: return C.SQLITE_OK;  // hubTx needs BEGIN/COMMIT/ROLLBACK
      case C.SQLITE_SELECT:      return C.SQLITE_OK;  // per-table READs are still checked
      case C.SQLITE_FUNCTION:    return FUNCS.has(arg2) ? C.SQLITE_OK : C.SQLITE_DENY;
      default: return C.SQLITE_DENY;                  // ATTACH, PRAGMA, DDL, function creation
    }
  });

  // The authorizer CANNOT gate transaction SHAPE, so the facade must.
  // Measured 2026-08-23: SQLITE_TRANSACTION (action 22) reports only the
  // keyword -- arg1 is `BEGIN` for BEGIN, BEGIN DEFERRED, BEGIN IMMEDIATE and
  // BEGIN EXCLUSIVE alike -- so `case SQLITE_TRANSACTION: return OK` admits
  // BEGIN EXCLUSIVE, and a guest holding an exclusive lock blocks the builder
  // and every restore for as long as it likes. The shape has to be checked on
  // the TEXT, before SQLite sees it.
  //
  // Split on `;` because exec() accepts multi-statement strings, so gating only
  // the leading keyword lets `SELECT 1; BEGIN EXCLUSIVE` through. The split is
  // naive about semicolons inside string literals, and deliberately so: the
  // only way it can be wrong is to refuse a statement it should have allowed.
  // SAVEPOINT needs no clause here -- it arrives as its own action (32) and the
  // authorizer's `default: DENY` already refuses it.
  // A SCANNER, not regexes over the raw text. Measured 2026-08-23: the previous
  // stripper treated `--` inside a STRING LITERAL as a comment, so
  // `SELECT '--'; BEGIN EXCLUSIVE` had its semicolon and its BEGIN swallowed
  // into the "comment", passed the gate, and ran -- taking the exclusive lock.
  // The reasoning attached to that version ("stripping can only make more text
  // look like a BEGIN, so its mistakes are refusals") was wrong in exactly the
  // direction that matters: a comment marker inside a literal makes LESS text
  // visible, not more.
  //
  // `statements` walks the string once, tracking quoted literals ('', "" and
  // backticks, with doubled-quote escapes), bracketed identifiers, and both
  // comment forms, and splits on the semicolons that are actually separators.
  const statements = (sql) => {
    const out = []; let cur = "", i = 0; const s = String(sql);
    while (i < s.length) {
      const c = s[i], d = s[i + 1];
      if (c === "'" || c === '"' || c === "`") {          // literal or quoted identifier
        const q = c; let j = i + 1;
        while (j < s.length) { if (s[j] === q) { if (s[j + 1] === q) { j += 2; continue; } break; } j++; }
        cur += s.slice(i, j + 1); i = j + 1; continue;
      }
      if (c === "[") { const j = s.indexOf("]", i); cur += s.slice(i, j < 0 ? s.length : j + 1); i = (j < 0 ? s.length : j + 1); continue; }
      if (c === "-" && d === "-") { const j = s.indexOf("\n", i); i = j < 0 ? s.length : j + 1; cur += " "; continue; }
      if (c === "/" && d === "*") { const j = s.indexOf("*/", i + 2); i = j < 0 ? s.length : j + 2; cur += " "; continue; }
      if (c === ";") { out.push(cur); cur = ""; i++; continue; }
      cur += c; i++;
    }
    if (cur.trim()) out.push(cur);
    return out.filter(t => t.trim());
  };

  const gate = (sql) => {
    const parts = statements(sql);
    // A guest never needs a multi-statement string: providerdb.mjs issues one
    // statement per call, plus BEGIN IMMEDIATE / COMMIT / ROLLBACK. Refusing the
    // whole class removes every "hidden second statement" variant at once,
    // instead of trying to out-parse them one at a time.
    if (parts.length > 1)
      throw new Error(`multi-statement SQL is not permitted on the guest hub connection: ${String(sql).trim()}`);
    const one = parts[0] ?? "";
    if (/^\s*BEGIN\b/i.test(one) && !/^\s*BEGIN\s+IMMEDIATE\s*$/i.test(one))
      throw new Error(`only BEGIN IMMEDIATE is permitted on the guest hub connection: ${one.trim()}`);
    return sql;                       // the ORIGINAL text runs, comments and all
  };

  const rawExec = db.exec.bind(db), rawPrepare = db.prepare.bind(db);

  // And remove every other route to the engine. `enableDefensive` blocks the
  // writable_schema class; the rest are deleted from this handle so a caller
  // cannot reach them at all.
  // The method list that used to be shadowed here is gone with the shadowing:
  // `setAuthorizer`, `applyChangeset`, `createSession`, `createTagStore`,
  // `deserialize`, `enableLoadExtension`, `loadExtension`, `function`,
  // `aggregate`, `open` and `serialize` are simply ABSENT from the facade, which
  // is the property the list was trying to approximate. Enumerating them was
  // always the weaker form: a method added by a future node release would not
  // have been on it.
  // A FACADE, not the handle with properties written over it. This is the
  // correction to the previous design, and the previous design did not hold:
  // `Object.defineProperty(db, "setAuthorizer", ...)` installs an OWN property
  // that SHADOWS the prototype method. It does not remove it. Any caller can
  // write
  //
  //     Object.getPrototypeOf(g).setAuthorizer.call(g, null)
  //
  // and take the authorizer straight off -- after which the retained `prepare`
  // and `exec` reach the whole hub and every gate in this module is decorative.
  // The same reach undoes `exec`, so `BEGIN EXCLUSIVE` is available too. The
  // tests could not see it: they called `g[m]()`, which finds the shadow.
  //
  // So nothing is returned that HAS that prototype. The real handle stays in
  // this closure. The caller gets an object created with a null prototype,
  // carrying exactly the three operations the guardian needs, each already
  // gated, and no chain leading anywhere else. `Object.freeze` stops the surface
  // being extended back.
  //
  // `enableDefensive` still runs on the real handle, and the authorizer is
  // still the primary boundary: the facade removes the route to REMOVING them.
  db.enableDefensive?.(true);
  return Object.freeze(Object.assign(Object.create(null), {
    prepare: (sql) => rawPrepare(gate(sql)),
    exec:    (sql) => rawExec(gate(sql)),
    close:   () => db.close(),
  }));
}
``` Refuse `ATTACH`, `PRAGMA` writes, and multi-statement strings outright — a permissive parser is a hole, so the wrapper allows a **closed list of statement shapes** rather than trying to spot forbidden ones.

The API assertions change with it, because `g[m]()` throwing was exactly what
made the old design look sound:

```js
  // ABSENT, not shadowed. The previous assertions called `g[m]()` and found the
  // throwing own-property, which is equally true of a handle whose prototype
  // still carries the real method one `.call` away.
  check(Object.getPrototypeOf(g) === null,
    "the guest has no prototype, so there is no inherited method to reach through");
  for (const m of ["setAuthorizer","applyChangeset","createSession","createTagStore","deserialize",
                   "enableLoadExtension","loadExtension","function","aggregate","open","serialize"])
    check(!(m in g), `${m} is absent from the guest surface, not merely shadowed on it`);
  check(Object.isFrozen(g), "and the surface cannot be extended back");
  check(typeof g.prepare === "function" && typeof g.exec === "function" && typeof g.close === "function",
    "control: the three operations the guardian actually needs are present");

  // CONTROL, and the one that proves the assertions above are about the FACADE:
  // the same reach really does work on a raw handle, so `Object.getPrototypeOf`
  // is a live escape route and not a theoretical one.
  const raw = new DatabaseSync(":memory:");
  check(typeof Object.getPrototypeOf(raw).setAuthorizer === "function",
    "control: a raw DatabaseSync DOES expose setAuthorizer through its prototype, which is what the facade removes");
  raw.close();
```

**On the broken implementation** — an allowlist checked by table name with a naive `sql.includes("provider_lease")` — the allowed list passes and `refused: enqueue an effect` goes red, because `INSERT INTO outbox ... VALUES('k','notify',...)` contains no table from the allowlist and yet a substring check that looks for *forbidden* names rather than matching *permitted shapes* lets it through. That inversion is the most likely wrong implementation here.

```bash
$N test/guardian-hub-allowlist.test.mjs
# `src/profile/schema.mjs` too: this task adds the three `builder.provider.*`
# entries, their defaults and the container declaration. Left unstaged, the
# committed daemon still rejects the keys this plan documents as unknown -- and
# the suite passes against the working tree either way, so nothing before the
# push notices.
git add src/build/hubguest.mjs src/daemon.mjs src/profile/schema.mjs \
        test/guardian-hub-allowlist.test.mjs
git commit -m "feat(daemon): open the hub through a statement allowlist"
```

---

### Task 23b: The guardian's verdict actually reads `pr_hold`

**`src/watcher.mjs` is in this task's file list, and that is not optional.**
`nextAction` inspects exactly seven clause ids — `clause(v, "…")` for `base`,
`ci`, `findings`, `mergeable`, `review`, `rounds`, `threads` — and anything it
does not recognise falls through to `src/watcher.mjs:207`:

```js
return act(ACTIONS.ESCALATE, `unclassified verdict ${v.state}: ${v.summary}`, { gap: true });
```

So adding a BLOCK-valued `hold` clause without touching the watcher makes **every
ordinary held builder PR** escalate every tick as an *implementation gap* —
`gap: true` is the flag reserved for "reeve met a verdict it does not understand".
The merge is correctly blocked and the reason reported is a lie, on a loop.

The intended action is **PARK**: a hold is a deliberate, recorded decision with a
founder exit (`reeve task resume`), not a repair the guardian can perform and not
a gap in reeve. Insert it beside the other clause branches, before the
**FIRST, immediately after the `state !== "open"` park** (`src/daemon.mjs`'s
consumer reads `nextAction` in `src/watcher.mjs`; search `PR is ${e.state}`) —
**not** before the unclassified fallback, which is where an earlier revision of
this plan put it. `nextAction` decides `ci` at `src/watcher.mjs:118-136` and the
generic UNKNOWN sweep at `:146` on `16769e7`, both long before any fallback. Late
placement therefore loses in two directions at once:

- a held PR that ALSO has red CI returns `FIX_CI` from the ci branch and the
  guardian dispatches a fixer for a task the builder deliberately parked — the
  precise outcome `pr_hold` exists to prevent;
- a `hold` clause in UNKNOWN is swallowed by the generic not-checkable
  escalation, which reports it as an unscopeable clause rather than as the
  configuration fault it is.

A hold is not a defect to repair or a gap to report; it is a decision already
taken, so it is read before anything that might act. `test/watcher.test.mjs`
gains mixed-clause precedence cases for exactly these two — a hold BLOCK with a
red ci clause, and a hold UNKNOWN alongside another UNKNOWN — because a matrix
that varies one clause at a time cannot see a precedence bug at all.

The clause, placed there rather than at the unclassified fallback:

```js
  // A builder hold is not a defect and not a gap: the builder wrote this row on
  // purpose and a founder clears it. PARK, so the PR is left alone rather than
  // repaired, escalated, or reported as something reeve failed to classify.
  const hold = clause(v, "hold");
  if (hold?.state === "BLOCK") return act(ACTIONS.PARK, `held by the builder: ${hold.detail}`);
  if (hold?.state === "UNKNOWN") return act(ACTIONS.ESCALATE, `builder hold state unknown: ${hold.detail}`);
```

UNKNOWN escalates rather than parking, because "the hold cannot be scoped" is a
configuration fault the founder must fix, not a decision to respect.

**The totality matrix in `test/watcher.test.mjs` iterates the seven clause ids
too**, so it gains `hold` in the same change — otherwise the suite still claims
totality over a set that is now one short, which is the shape that let this
through.

**A declared gap.** `evaluatePr` cannot be exercised end to end from a test
today: it shells out to GitHub five times and takes no injectable seam. Task 23b
therefore proves the clause (unit), proves the fold (`computeVerdict`, the real
function), and checks the one link between them structurally. Giving
`src/pr.mjs` an io seam is the follow-up; it is a refactor of the guardian's
hottest read path and does not belong in a PR about the provider scheduler.

**Files:**
- Create: `src/build/holds.mjs` (the scoped `pr_hold` reader — see Produces below)
- Modify: `src/verdict.mjs` (one additive clause **and its entry in the clause list**), `src/daemon.mjs` (pass the guest handle into evaluation), `src/pr.mjs` (`evaluatePr` threads `ctx.hub` and the builder-PR classification through to the verdict), **`src/watcher.mjs`** (route the new clause id, per the paragraph that opens this task), **`test/watcher.test.mjs`** (its totality matrix iterates the clause ids and fails on an unrouted one)

**Routing, not just definition.** `holdClause` computing the right answer is worth nothing if the production verdict never calls it. `evaluatePr` is what builds the clause set the daemon publishes, so it must pass `ctx.hub` and the structural builder-PR classification (head branch `mp/*`, or author is the App — the same detection as §9.2) into the verdict, and the verdict must include the clause's result in its worst-wins fold. The test below asserts membership in `VERDICT_CLAUSES` for that reason; add a second assertion that a fixture `evaluatePr` over a builder PR with an uncleared hold returns a verdict of `BLOCK`, because membership alone does not prove the value reaches the fold.
- Test: `test/guardian-pr-hold-clause.test.mjs` (new)

**Interfaces:**
- Consumes: `openHubAsGuest` (Task 23).
- Produces: `openHolds(db, { repoId, pr }) -> Row[]` in **`src/build/holds.mjs`** — the scoped `pr_hold` reader. It lives under `src/build/` because this plan's global rule is that raw SQL exists only under `src/db/` or `src/build/`: a `SELECT ... FROM pr_hold` embedded in `src/verdict.mjs` would be a third definition of the guest SQL surface, drifting from the allowlist the moment either changes.
- **`holdClause` is fail-closed on a missing repository id.** `ctx.repoId` is permitted to be null (startup resolves it and a failure is not fatal), and a plain `WHERE repo_id = ? AND pr = ?` with a null id matches nothing and returns PASS — so a builder PR would go **green exactly when its hold cannot be scoped**, which is the one case that must never pass. A builder PR with `repoId == null` returns `UNKNOWN` with `detail: 'the repository id is unknown; a hold cannot be scoped'`. Ordinary PRs still short-circuit to PASS without opening the hub.
- Produces: `holdClause(hub, { repoId, pr, isBuilderPr }) -> { id: 'hold', state: 'PASS'|'BLOCK'|'UNKNOWN', detail }`, and **`computeVerdict` gains one input, `i.hold`**, which it appends to its clause list through the same `add(...)` call every other clause uses. That is the whole routing change, and it has to be an input: `computeVerdict` builds its clauses from inputs and accepts no clause array, so a caller cannot inject one. Ordinary PRs are **not evaluated**: the clause returns `PASS` with `detail: 'not a builder PR'` and never opens the hub.

**Why this task exists.** Task 23 proves the guest connection is *permitted* to `SELECT` on `pr_hold`. Permission is not wiring. Without a reader, §9.6's entire mechanism is inert: cancellation, escalation and blocking write `pr_hold` rows that nothing consults, the required `ops/merge-policy` check stays green at the head, and a held builder PR remains mergeable — which is the exact failure the hold was invented to prevent. A capability nobody calls is indistinguishable from one that was never added.

- [ ] **Step 1: Write the failing test**

```js
// pr_hold exists so that cancelling, blocking or escalating a task makes the
// SERVER refuse its PR: the guardian's verdict goes BLOCK, its ops/merge-policy
// run at the head goes failure, and the ruleset requires that check. Every link
// in that chain is somewhere else; this is the one that reads the row.
import { holdClause } from "../src/verdict.mjs";
import { openHub } from "../src/build/hubdb.mjs";
import { openHubAsGuest } from "../src/build/hubguest.mjs";
/* ... standard harness ... */

const p = join(dir, "h.db");
const own = openHub(p);
own.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
            repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
          VALUES('bt:1','p',1,'o/r','t','CANCELLING','founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);
own.exec(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at)
          VALUES('bt:1',1,7,'${"a".repeat(40)}','cancel',unixepoch())`);
own.close();
const hub = openHubAsGuest(p);

check(holdClause(hub, { repoId: 1, pr: 7, isBuilderPr: true }).state === "BLOCK",
  "an uncleared hold on a builder PR renders BLOCK");
check(holdClause(hub, { repoId: 1, pr: 8, isBuilderPr: true }).state === "PASS",
  "control: a builder PR with no hold is not blocked by this clause");

// Cleared means cleared: resume must actually unblock the PR, or a resumed task
// can never merge again and the hold becomes permanent.
const own2 = openHub(p);
own2.exec("UPDATE pr_hold SET cleared_at=unixepoch() WHERE repo_id=1 AND pr=7");
own2.close();
check(holdClause(hub, { repoId: 1, pr: 7, isBuilderPr: true }).state === "PASS",
  "a CLEARED hold no longer blocks, so resume genuinely releases the PR");

// An unreadable hub is UNKNOWN, never PASS: a builder PR must not go green
// because the hub is down.
const broken = { prepare: () => { throw new Error("hub unreadable"); } };
check(holdClause(broken, { repoId: 1, pr: 7, isBuilderPr: true }).state === "UNKNOWN",
  "a hub whose queries throw yields UNKNOWN, which is never PASS");
// null is how production represents a missing or unopenable hub -- the ctx.hub
// getter returns exactly that. An implementation guarding only the throwing
// case dereferences null here and either crashes the verdict or falls through
// to PASS on a builder PR while the hub is down.
check(holdClause(null, { repoId: 1, pr: 7, isBuilderPr: true }).state === "UNKNOWN",
  "and so does a NULL hub, which is what a missing or unopenable hub actually is");

// Ordinary PRs never evaluate the clause at all -- and must not even open the
// hub, or a hub outage would change ordinary-PR verdicts on every watched repo.
let touched = false;
const spy = { prepare: () => { touched = true; return { get: () => null }; } };
const ordinary = holdClause(spy, { repoId: 1, pr: 99, isBuilderPr: false });
check(ordinary.state === "PASS" && touched === false,
  "an ordinary PR passes without the hub being read at all", JSON.stringify({ ordinary, touched }));
```

- [ ] **Step 2: Run it red, implement, run green**

**On the broken implementation** — the clause added but never inserted into the verdict's worst-wins list — every assertion here passes and nothing blocks in production. So the test also asserts membership:

```js
import { VERDICT_CLAUSES, computeVerdict } from "../src/verdict.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The INPUTS computeVerdict consumes -- not a clause list, which it does not
// accept. Deliberately sparse: the other clauses land on UNKNOWN, the correct
// reading of "not supplied", and that is enough for the control below, which
// asserts `!== BLOCK` rather than PASS.
const baseInputs = { checks: { settled: true, verdict: "GREEN" } };
check(VERDICT_CLAUSES.includes("hold"),
  "and the clause is IN the worst-wins list, not merely defined beside it", VERDICT_CLAUSES.join(","));

// Membership is still not routing. This is the assertion that fails when
// evaluatePr never passes ctx.hub, or misclassifies every PR as ordinary, or
// drops the clause result before the fold -- none of which the unit tests above
// can see.
// Routing has two halves, and only one of them can be exercised end to end
// today. Both are covered, and the gap between them is named rather than
// papered over.
//
// `evaluatePr({ nwo, pr, profile, db })` (src/pr.mjs:132) is SYNCHRONOUS and
// shells out to GitHub on its first line -- `ghJson([repos/${nwo}/pulls/${pr}
// ...])` -- then again through pinHead, readChecks, suitesComplete and
// inheritedOrCaused. It takes no ctx, ignores any headRef passed to it, and
// would throw on `profile.ci` before reaching any clause. Calling it here would
// test nothing and fail for unrelated reasons.
//
// Making it injectable means threading an io seam through five GitHub reads in
// the guardian's hottest path -- a real refactor of src/pr.mjs, in a PR whose
// subject is the provider scheduler. That is deliberately NOT done here. It is
// named as the follow-up in the self-review, and what CAN be proven is proven:

// (a) THE FOLD, with the real production function. computeVerdict is pure and
//     exported (src/verdict.mjs:52), so the question "does the hold clause's
//     value actually reach the verdict" is answerable without any network.
{
  // computeVerdict takes INPUTS and builds its own clause list from them
  // (src/verdict.mjs:52 -- `const clauses = []`, then one `add(...)` per
  // clause). It accepts no clause array, so passing one tests an API that does
  // not exist. The hold arrives as its own input, and Task 23b's additive
  // change is the `add("hold", ...)` that consumes it -- which is the routing
  // under test.
  // A hold this block OWNS. PR 7's row was cleared by the earlier
  // clear-on-resume assertion (`UPDATE pr_hold SET cleared_at=... WHERE pr=7`),
  // so reading it here returns PASS and every BLOCK assertion below fails
  // against a correct implementation -- a fixture invalidated by a test that ran
  // before it. PR 11 is untouched by anything above.
  // Through an OWNER connection. `hub` is the openHubAsGuest handle, whose
  // authorizer denies every INSERT into pr_hold by design -- the guest may read
  // that table and nothing more -- so seeding through it throws before
  // computeVerdict is reached, and the block fails on its own fixture.
  //
  // The guest handle is kept for the production READ below, which is the thing
  // under test: `holdClause` runs on the guardian's connection.
  { const owner = openHub(p);
    owner.exec(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at)
                VALUES('bt:1',1,11,'${"c".repeat(40)}','cancel',unixepoch())`);
    owner.close(); }
  check(holdClause(hub, { repoId: 1, pr: 7, isBuilderPr: true }).state === "PASS",
    "control: PR 7's hold really was cleared above, so this block needs its own",
    JSON.stringify(holdClause(hub, { repoId: 1, pr: 7, isBuilderPr: true })));
  const blocking = holdClause(hub, { repoId: 1, pr: 11, isBuilderPr: true });
  check(blocking.state === "BLOCK", "fixture: the hold clause blocks", JSON.stringify(blocking));

  const withHold    = computeVerdict({ ...baseInputs, hold: blocking });
  const withoutHold = computeVerdict({ ...baseInputs });
  check(withHold.state === "BLOCK",
    "the hold clause's BLOCK reaches the verdict's worst-wins fold", JSON.stringify(withHold.state));
  check(withHold.clauses.some(c => c.id === "hold" && c.state === "BLOCK"),
    "and appears in the rendered clause list, so `task why` can name it",
    JSON.stringify(withHold.clauses.map(c => `${c.id}:${c.state}`)));

  // CONTROL: `!== "BLOCK"`, not `=== "PASS"`. With sparse inputs the other six
  // clauses are UNKNOWN, and demanding PASS would mean building complete
  // production fixtures for six unrelated clauses in order to test one. The
  // claim that matters is that the BLOCK came from the hold, and this is it.
  check(withoutHold.state !== "BLOCK",
    "control: the same inputs without the hold do NOT produce BLOCK",
    JSON.stringify(withoutHold.state));
  check(!withoutHold.clauses.some(c => c.id === "hold" && c.state === "BLOCK"),
    "control: and no hold clause is rendered when none was supplied",
    JSON.stringify(withoutHold.clauses.map(c => `${c.id}:${c.state}`)));
}

// (b) THE WIRING, at BOTH ends. Asserting only that `src/pr.mjs` contains a
//     `holdClause(` and the word `hub` is satisfied by an implementation that
//     adds `evaluatePr({ hub })` and calls the clause perfectly while the
//     DAEMON's invocation still passes no hub -- so every builder PR evaluates
//     the hold as UNKNOWN and stays unmergeable, with this whole mandatory
//     suite green. The call SITE is the half that was unchecked.
{
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const prSrc = read("../src/pr.mjs"), daemonSrc = read("../src/daemon.mjs");

  check(/holdClause\s*\(/.test(prSrc),
    "evaluatePr's module calls holdClause: membership in VERDICT_CLAUSES is not routing");

  // The daemon's evaluatePr call must SUPPLY the hub and the builder
  // classification. Matched on the call itself, not on the file containing the
  // words somewhere.
  const call = daemonSrc.match(/\(ctx\.evaluate \?\? evaluatePr\)\(\{[^}]*\}/s)?.[0] ?? "";
  check(/\bhub\b/.test(call),
    "and the DAEMON passes ctx.hub into it, or every builder PR reads UNKNOWN", call);
  check(/isBuilderPr|builderPr/.test(call),
    "and passes the builder classification the clause branches on", call);
  // `headRef` is NOT accepted as evidence of the classification any more. It is
  // already in that call for unrelated reasons, so the old alternation passed
  // against an implementation that had no classifier at all.

  // BEHAVIOURAL, both classifiers, because a text match over the call site
  // cannot tell which of the two branches exists. §9.2 classifies a builder PR
  // by head branch `mp/*` OR by the PR's author being the App, and an
  // implementation that recognises only the branch passes every static check
  // here while treating an App-authored PR on an ordinary branch as a normal
  // one -- skipping `pr_hold` entirely, so a cancelled or blocked task's PR
  // stays green and mergeable. That is the whole failure this clause exists to
  // prevent, and it was the likelier half to be missed.
  //
  // This requires `evaluatePr`'s metadata read to INCLUDE the author, which it
  // does not today: add the author login and its `__typename`/app id to the
  // fields it already requests, and pass the classification through. Without
  // that read there is nothing for the second branch to test.
  // The classifier DIRECTLY, as a pure exported function. The previous revision
  // spread a `...evalFixture` that was never defined anywhere -- and even with
  // one, `evaluatePr` has no injected I/O seam and would have gone to GitHub for
  // the metadata rather than reading the fixture's, so the block either threw a
  // ReferenceError or tested the network. Driving the composition was the wrong
  // shape for the claim anyway: what has to be right is WHICH PRs count as
  // builder PRs, and that is a decision over two fields.
  //
  // `isBuilderPr({ headRef, authorIsApp })` is exported from `src/pr.mjs`, and
  // `evaluatePr` calls it with the metadata it already reads plus the author it
  // must now also read. The structural assertion below is what ties the two
  // together; this table is what says the decision is right.
  for (const [label, meta, want] of [
    ["a builder branch",      { headRef: "mp/bt-1-s0",       authorIsApp: false }, true],
    ["an App author",         { headRef: "feature/ordinary", authorIsApp: true  }, true],
    ["both at once",          { headRef: "mp/bt-2-s0",       authorIsApp: true  }, true],
    ["neither",               { headRef: "feature/ordinary", authorIsApp: false }, false],
    // The control that keeps `mp/*` a SEGMENT prefix rather than a string one --
    // the same defect `overlaps` had, and the reason it is written out here.
    ["a lookalike branch",    { headRef: "mpx/not-ours",     authorIsApp: false }, false],
  ]) check(isBuilderPr(meta) === want,
      `${label}: isBuilderPr is ${want}`, JSON.stringify(meta));

  // And the clause consumes the classification rather than re-deriving it, which
  // is the half a pure-function test cannot see.
  check(holdClause(hub, { repoId: 1, pr: 7, isBuilderPr: isBuilderPr({ headRef: "mp/bt-1-s0", authorIsApp: false }) }).state === "BLOCK",
    "and a PR the classifier accepts reaches the hold clause as a builder PR");

  // CONTROLS, both directions. The first proves the extractor found a real call
  // rather than matching nothing and testing the empty string; the second proves
  // the searches can fail at all.
  check(call.length > 0 && /evaluatePr/.test(call),
    "control: the daemon's evaluatePr call site was actually located", JSON.stringify(call.slice(0, 120)));
  check(!/thisClauseDoesNotExist\s*\(/.test(prSrc) && !/thisFieldDoesNotExist/.test(call),
    "control: the same searches find nothing for names that were never added");
}
```

- [ ] **Step 3: Commit**

```bash
# src/pr.mjs is where evaluatePr threads the hub and the builder classification
# into the verdict. Omitting it leaves holdClause defined and never called.
# EVERY file this task touches. Three were missing: `src/build/holds.mjs` is
# created by this task and would be left untracked, so the pushed commit imports
# a module that is not in it; and `src/watcher.mjs` plus `test/watcher.test.mjs`
# carry the clause routing this task's own opening paragraph calls not optional.
# Task 24's suite passes against the WORKING TREE either way, so nothing
# downstream catches an unstaged file -- only the push does, and by then the
# branch is broken.
git add src/verdict.mjs src/pr.mjs src/daemon.mjs src/build/holds.mjs \
        src/watcher.mjs test/watcher.test.mjs test/guardian-pr-hold-clause.test.mjs
git commit -m "feat(verdict): builder prs block on an uncleared hub hold"
```

---

### Task 24: PR-C close-out, and the S2 acceptance run

- [ ] **Step 1: The acceptance observation §14 S2 names**

"A guardian FIX_CI dispatch claims a provider lease before launch and releases it on exit, **observed as rows in `provider_lease`**." Task 22's first block is that observation under a fixture. Record it as measured evidence, on the real daemon path, without dispatching a real worker:

Write it as a real script, not a placeholder — a `tee` of a comment produces an empty evidence file and observes nothing:

```bash
# Written INTO the repository, not /tmp: relative imports resolve from the
# file's own location, so a script at /tmp/acceptance.mjs looks for /tmp/src/.
cat > ./acceptance-tmp.mjs <<'EOF'
import { openHub } from "./src/build/hubdb.mjs";
import { open as openStore } from "./src/db/ops.mjs";
import { tick } from "./src/daemon.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "reeve-accept-"));
const db = openHub(join(dir, "hub.db"));

// This script is STANDALONE -- it is not a test file and imports no harness --
// so the fixture is written out here. `fixtureCtx` lives in
// test/worker-contract.test.mjs and is not exported; referencing it from here
// is a ReferenceError before tick() runs, and the script then records no rows
// while looking like it ran.
//
// `repoId` is required, not optional: without it the claim is refused
// fail-closed (a lease that cannot be scoped to a repository is worse than no
// lease), and the acceptance run would observe an empty provider_lease and
// report the opposite of what it is meant to prove.
//
// Every seam below is copied from `test/worker-contract.test.mjs`'s `ctxFor`,
// which is the fixture that demonstrably reaches `spawnWorker`. Three of them
// were missing and each one refuses the dispatch on its own, BEFORE any provider
// claim -- so the script printed ACCEPTANCE FAILED for a reason that has nothing
// to do with provider admission, which is the one thing it exists to observe:
//
//   * no `containment`  -> the production measurement runs and returns
//     `credentialRead: "open"` for want of an absolute identity.worktreeRoot
//     (`src/daemon.mjs:327-328` on `16769e7`), so the dispatch block is skipped.
//   * no `identity`     -> `src/daemon.mjs:841` refuses with "no
//     identity.worktreeRoot in the profile", before startRun and the claim.
//   * a failing check with no `id` -> `resolveFailureCause` filters on `f?.id`
//     (`src/ci-rootcause.mjs:259`), so `resolveCause` is never called, `cause`
//     stays null, and FIX_CI exits at "no resolvable root cause".
const fixtureCtx = (d) => ({
  nwo: "o/r", repoId: 1, running: 0,
  // Known-closed, injected. The real measurement is host-dependent and would
  // make this artefact report on the machine rather than on the code.
  containment: { credentialRead: "closed", why: "acceptance fixture" },
  keychain: { measured: true, items: [], why: null },
  claudeBin: "/bin/sh", cliVersion: "2.1.237",
  // Deterministic: the real capacity() backs off on the host load average.
  capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
  // worktreeRoot and checkout must be SEPARATE directories, as a real
  // deployment has them: the worker policy denies reads of the clone, so a
  // checkout inside it is refused.
  profile: { ci: {}, worker: { isolation: "none" },
             identity: { key: "o/r", defaultBranch: "main",
                         worktreeRoot: d, checkout: mkdtempSync(join(tmpdir(), "reeve-accept-clone-")) },
             authority: { policy: "propose_and_merge" },
             rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
             watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 } },
  prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(d, "wt-")), why: null,
                            deps: { ok: true, cow: false } }),
  publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
  // Injected, never read from disk: the real reader looks at
  // ~/.reeve/claude-token, so a default passes on a machine that has one and
  // fails everywhere else.
  oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
  // A REAL guardian store, not null. After an evaluation succeeds, `tick` hands
  // ctx.db to reconcilePr, unknownSince and record -- so a null one throws
  // before spawnWorker runs and the script observes no provider lease at all,
  // recording the opposite of what it is meant to prove. The guardian store and
  // the hub are two different databases and both are needed here.
  db: openStore(join(d, "state.db")), dbPath: join(d, "state.db"),
  logPath: join(d, "reeve.log"), haltMarker: join(d, "HALT"),
  execute: true, shadow: false, selfAudit: false,
  log: () => {},
  // BOTH network seams. `tick` calls `(ctx.openPrs ?? openPrs)` at
  // src/daemon.mjs:558 BEFORE it evaluates anything, so injecting `evaluate`
  // alone still reaches the real GitHub-backed listing: offline it exits without
  // dispatching, and configured it inspects real repository state. An acceptance
  // artefact that quietly consults production is worse than none.
  openPrs: () => [7],

  // And the evaluation has to produce a FIX_CI through the inputs `tick`
  // actually reads. It IGNORES `evaluate`'s `decision` and recomputes with
  // `nextAction(e, profile, ...)` (src/daemon.mjs:716), so a BLOCK verdict with
  // no clauses falls through to the unclassified escalation -- no dispatch, no
  // lease, `during` null, and the run records the opposite of what it exists to
  // show. The clause set below is what nextAction reads to reach FIX_CI: a
  // settled RED ci clause with a named failing check, and a mergeable/base pair
  // that does not divert it first.
  evaluate: () => ({
    ok: true, pr: 7, headRef: "mp/bt-1-s0", baseRef: "main", state: "open",
    head: "a".repeat(40), title: "t",
    // `id` is REQUIRED on the failing check. resolveFailureCause keeps only
    // rows with one (a commit status has no job behind it, so there is nothing
    // to read), and with none it returns { cause: null } without ever calling
    // the resolveCause seam below.
    checks: { settled: true, verdict: "RED", failing: [{ name: "build", id: 1 }], inherited: [], caused: [{ name: "build" }] },
    verdict: { state: "BLOCK", summary: "failing: build", clauses: [
      { id: "mergeable", state: "PASS", detail: "clean" },
      { id: "base",      state: "PASS", detail: "green" },
      { id: "ci",        state: "BLOCK", detail: "failing: build" },
      { id: "review",    state: "PASS", detail: "n/a" },
      { id: "threads",   state: "PASS", detail: "none" },
      { id: "rounds",    state: "PASS", detail: "0" },
      { id: "findings",  state: "PASS", detail: "none" },
    ] },
  }),
  // The root-cause seam too: FIX_CI is refused when no cause can be resolved,
  // and resolving one shells out to GitHub like everything else here.
  // The shape `rootCause` really returns, matching test/worker-contract.test.mjs.
  // `resolveFailureCause` sorts on `job` and builds a fingerprint from the
  // result, so an ad-hoc object is not interchangeable with it.
  resolveCause: () => ({ ok: true, job: "CI Gate", step: "Test", runId: 11,
                         cause: [{ where: "src/x.ts:1", message: "boom" }] }),
});

let during = null;
const ctx = { ...fixtureCtx(dir), hub: db, lstart: "acceptance",
  spawnWorker: async () => {
    during = db.prepare("SELECT owner, status, run_ref FROM provider_lease").all();
    return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s", model: "m" };
  } };
await tick(ctx);
const after = db.prepare("SELECT * FROM provider_lease").all();
console.log("DURING dispatch:", JSON.stringify(during));
console.log("AFTER  dispatch:", JSON.stringify(after));
// A guard, not just a log line: `during` stays null if the tick never reached
// spawnWorker, and printing `undefined` into a measured document records a
// non-observation as an observation.
if (!during || !during.some(r => r.status === "held" && r.owner === "guardian")) {
  console.error("ACCEPTANCE FAILED: no guardian lease was held during dispatch");
  console.error("  during:", JSON.stringify(during));
  process.exit(1);
}
// The OTHER half of the §14 clause: "claims a provider lease before launch AND
// releases it on exit". Only acquisition was guarded, so a broken cleanup that
// left the row behind still exited 0 and could be written up as passing
// evidence -- with the nonzero row count printed directly above the claim that
// the lease was released.
if (after.length !== 0) {
  console.error("ACCEPTANCE FAILED: provider_lease rows survived the tick");
  console.error("  after:", JSON.stringify(after));
  process.exit(1);
}
console.log("guardian held during:", during.filter(r => r.status === "held" && r.owner === "guardian").length);
console.log("rows remaining after:", after.length);
EOF
# pipefail, or the pipeline reports TEE's exit status and a run that printed
# ACCEPTANCE FAILED is indistinguishable from a passing one -- after which the
# measured document gets written and committed as evidence of the opposite.
set -o pipefail
$N ./acceptance-tmp.mjs | tee /tmp/acceptance.txt
status=$?
rm ./acceptance-tmp.mjs        # scratch, never committed
# Stop HERE on a failure. The next step writes docs/measured/ from this output;
# reaching it with status != 0 records a non-observation as an observation.
[ "$status" -eq 0 ] || { echo "acceptance failed ($status): do not write the measured document"; exit 1; }
```

Then write `docs/measured/2026-08-23-guardian-claims-provider.md` around that raw output and **`git add` and commit it** — a `tee` alone leaves the evidence untracked and it never reaches the PR. State plainly that it was observed under a fixture `spawnWorker`, not against a live model call: no task in S2 may dispatch a real worker.

`git add` and commit it in the same step — a `tee` into `docs/measured/` leaves the file untracked, so the acceptance evidence for this stage exists only on the machine that ran it and never reaches the PR. Write it up with the command, the raw output, and the date — the row contents during dispatch and after exit. **State plainly that it was observed under a fixture `spawnWorker`, not against a live model call**, since no task in S2 may run `reeve canary` or dispatch a real worker.

- [ ] **Step 2: Full suite, and the S2 Verify clause re-checked end to end**

```bash
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac   # mutates the live daemon's ~/.reeve/canary
  $N "$f" >/dev/null || echo "FAILED $f"
done
```

Then walk Task 20's Verify table again with PR-C's two rows now filled: *guardian FIX_CI claims and releases a provider lease* → Task 22; *guardian hub connection allowlist test* → Task 23. Every row must name a test file that exists and is green.

- [ ] **Step 3: Confirm S2 changed nothing about dispatch**

```bash
git grep -n "isolation" -- src/profile/schema.mjs src/supervisor.mjs | head
git log --oneline origin/main..HEAD -- src/supervisor.mjs src/sandbox.mjs src/workerenv.mjs
```

Expected: `worker.isolation` still defaults to `none`, dispatch is still refused in code, and the second command prints nothing. **S2 does not change that and must not.** If either expectation fails, stop and report it rather than adjusting the expectation.

- [ ] **Step 4: Tracker last, push, open the PR, work the gate**

```bash
git add docs/TRACKER.md && git commit -m "docs: tracker — S2 PR-C, hub core complete"
git push -u origin feat/s2-provider-scheduler
gh pr create --title "S2 PR-C: the provider scheduler" --body-file - <<'BODY'
Shared `src/provider.mjs`, the guardian-side claim, the rate-limit fast-fail,
and the statement allowlist on the guardian's hub connection.

**This is the only PR in S2 that changes the running guardian.** After it
merges, the daemon's next restart begins claiming a provider lease before every
model dispatch.

## The decision that most needs review

The guardian **fails OPEN**: a missing, locked or corrupt hub means it
dispatches exactly as it does today and escalates
`the provider scheduler is unreadable; dispatching unscheduled` (the guardian's identity, since the escalation lands in the guardian's own store). The builder fails closed. The scheduler
exists to restrain the builder; it must not become a new way to stop CI being
fixed on every watched repo. The cost is real and is stated rather than hidden:
during a hub outage both daemons could dispatch and exhaust the subscription
window, which is the problem the scheduler exists to solve.

`test/provider-guardian.test.mjs` asserts a ctx with no `hub` key at all still
dispatches, which is what keeps all 59 pre-existing guardian test files green
without edits.
BODY
gh pr comment --body "@codex review"
```

**Do not merge.** Founder grant required, and the last one is spent.

- [ ] **Step 5: After the founder's grant and the merge — restart is a founder action**

Do **not** restart the daemon or run `launchctl` as part of executing this plan. The claim takes effect at the next restart; when to take that is the founder's call, because a restart kills an in-flight run against a watched repo.

---

---

## Self-review

**Spec coverage.** §10.4 the scheduler, its admission rule under `BEGIN IMMEDIATE`, guardian reservation, queued-guardian blocking, cooldown and reaping (Task 21); §10.4's guardian-side claim and the rate-limit fast-fail (Task 22); §13's assertion that the guardian's hub surface is exactly the scheduler plus a `pr_hold` read (Task 23); §9.6's verdict clause, which is the reader that makes a hold mean anything (Task 23b).

**Placeholder scan.** Clean.

**Type consistency.** `claimProvider -> {ok, id} | {ok:false, reason, until}` with `reason ∈ {queued, cooldown, at-limit, maintenance, no-identity}` (`no-identity` is the fail-closed result when `readStart` returns null: a distinct reason rather than a throw or a silent admit, because "quota says no" and "this process cannot be identified" need different responses — the first retries next tick, the second must not start the work at all); `holdClause(hub, {repoId, pr, isBuilderPr}) -> {id, state, detail}` with `state ∈ {PASS, BLOCK, UNKNOWN}`; `openHubAsGuest(path)`.

**The two things this plan must not get wrong.** The guardian **fails open** when the hub is unreadable (founder decision, 2026-08-22): the scheduler restrains the builder and must never become a new way to silence the watchman, and a `ctx` with no `hub` key at all still dispatches — asserted directly, because that is what keeps every pre-existing guardian test green. And the allowlist must permit what `assertWritable` needs (`SELECT`/`DELETE` on `maintenance_lock`) and the transaction-control statements `hubTx` issues; an allowlist scoped to tables alone refuses the guardian its own admission transaction, which review caught only after a round in which one fix broke another.
