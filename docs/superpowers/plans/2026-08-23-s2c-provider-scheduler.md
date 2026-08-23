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
2. **The guardian fails OPEN when hub.db is unreadable at provider-claim time.** It dispatches exactly as it does today and escalates `builder:provider:hub-unreadable`. The builder fails closed. The scheduler restrains the builder; it must never become a new way to silence the guardian. This matches the `ctx.reviewIngest !== false` opt-out shape §14 asks new ctx keys to follow (search `ctx.reviewIngest !== false`; `src/daemon.mjs:596,1360,1367` on `e41cd28`), so existing guardian tests stay green untouched.
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
- Test: `test/provider-scheduler.test.mjs`, `test/provider-race.test.mjs`

`src/provider.mjs` holds **no SQL**. It holds the admission rule, the reservation arithmetic and the cooldown comparison, and calls `providerdb.mjs` for every read and write. That keeps "no raw SQL outside `src/db/` and `src/build/`" true, and means the guardian imports a policy function rather than a query builder.

**Interfaces:**
- Consumes: `openHub`, `hubTx`, `hubEvent` (PR-A).
- Produces:
  - `claimProvider(db, { owner, repoId, runRef, pid, lstart, priority = 0, budgetUsd = null, isAlive, now }) -> { ok: true, id } | { ok: false, reason: 'queued'|'cooldown'|'at-limit'|'maintenance', until }`
  - **Where the SQL lives.** The Global Constraints say no raw SQL outside `src/db/` and `src/build/`, and `src/provider.mjs` is neither — it sits at the top level because both daemons import it. Resolve it by keeping the statements in `src/build/providerdb.mjs` (the hub owns its own SQL, as `hubdb.mjs` does) and making `src/provider.mjs` the shared **policy** layer that imports them: the admission rule, the reservation arithmetic, the cooldown comparison. That also puts the boundary in the right place — the guardian imports a policy function, not a query builder, and the statement allowlist in Task 23 is checking a surface that has exactly one definition.
  - **Every provider mutation calls `assertWritable` inside its own transaction** (`inTx: true`), exactly as `withWriterLease` does. Without it a guardian can take a held lease and launch a worker after `restoreHub` has acquired `maintenance_lock` and finished its holder scan — reopening the writer race the lock exists to close, from the one code path that is allowed to write the hub without holding a writer lease. `assertWritable` throws; `claimProvider` catches and returns `reason: 'maintenance'`, which the guardian treats exactly like `at-limit`: it does not dispatch, and it does not escalate, because a restore in progress is an operator action rather than a fault.
  - `releaseProvider(db, { id, force })` — deletes the row. **A release refused because a restore holds `maintenance_lock` must not be dropped**: `assertWritable` throws, and the caller retries on the next tick with the lease id recorded in memory; the caller keeps the id and retries next tick, and the production snippet must actually do that rather than `catch {}`. There is deliberately **no durable marker**: an earlier draft added `provider_lease.refused_release`, and it cannot be written in the one case it represents — `assertWritable` blocks that write while the lock is held. It is also unnecessary, because `restoreHub` clears every process-scoped row (`provider_lease` included) from the restored file, so a lease held across a restore does not survive it. An abandoned restore is covered by ordinary expiry.
  - `heartbeatProvider(db, { id, now })`, `reapProviderLeases(db, { isAlive, now })`
  - `bindProviderLease(db, { id, pid, lstart })` — re-binds a held row from the daemon to the spawned worker.
  - `cancelQueued(db, { owner, repoId, runRef })` — removes a `queued` request whose dispatch is no longer going to happen. **Called on every path out of the dispatch block that did not launch, AND swept at the top of each tick**: a queued request whose PR has since closed, whose head moved, or whose task simply is not in this tick's decisions never re-enters that block at all, so a per-path call alone leaves it queued forever — and a queued guardian request blocks the next builder admission by design. The sweep compares live queued rows against the run refs this tick actually decided on, and cancels the rest.

```js
// top of the tick, after evaluations are computed:
const live = new Set(evaluations.map(e => `pr:${e.pr}`));
for (const q of hub.prepare(
  "SELECT id, run_ref FROM provider_lease WHERE owner='guardian' AND status='queued'").all())
  if (!live.has(q.run_ref)) cancelQueued(hub, { owner: "guardian", repoId, runRef: q.run_ref });
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
         cancelQueued, bindProviderLease } from "../src/provider.mjs";
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
  const a = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE });
  const c = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:2", pid: 2, lstart: "B", isAlive: ALIVE });
  const d = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:3", pid: 3, lstart: "C", isAlive: ALIVE });
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
  acquireMaintenanceLock(db, { pid: 4242, lstart: "L4242", isAlive: ALIVE });
  for (const [name, run] of [
    ["claimProvider",   () => claimProvider(db, { owner: "builder", repoId: 1, runRef: "r", pid: 1, lstart: "A", isAlive: ALIVE })],
    ["releaseProvider", () => releaseProvider(db, { id: 1 })],
    ["noteRateLimit",   () => noteRateLimit(db, { signature: "x", cooldownSeconds: 1 })],
    ["cancelQueued",    () => cancelQueued(db, { owner: "builder", repoId: 1, runRef: "r" })],
  ]) {
    let refused = false;
    try { const r = run(); refused = r?.ok === false && r.reason === "maintenance"; } catch { refused = true; }
    check(refused, `${name} refuses while a live restore holds maintenance_lock`);
  }
  // Control: with the lock gone the same call succeeds -- otherwise "refuses
  // everything" satisfies all four above.
  db.exec("DELETE FROM maintenance_lock");
  check(claimProvider(db, { owner: "builder", repoId: 1, runRef: "r", pid: 1, lstart: "A", isAlive: ALIVE }).ok,
    "control: the same claim succeeds once the lock is released");
  db.close();
}

// ── a dead holder's lease is reaped ──────────────────────────────────────────
{
  const db = openHub(join(dir, "p4.db"));
  const a = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 999, lstart: "GONE", isAlive: ALIVE });
  db.exec(`UPDATE provider_lease SET expires_at = unixepoch() - 1 WHERE id = ${a.id}`);
  const blockedWhileAlive = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:2", pid: 2, lstart: "B", isAlive: ALIVE });
  check(!blockedWhileAlive.ok, "an expired lease whose holder is still ALIVE is not reaped: a busy process may miss a heartbeat");
  const n = reapProviderLeases(db, { isAlive: DEAD });
  check(n === 1, `a crashed worker's slot is freed (reaped ${n})`);
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
  const kids = Array.from({ length: 20 }, (_, i) => new Promise((res) => {
    const c = spawn(process.execPath, [worker, p, String(i), go, ready], { encoding: "utf8" });
    let out = ""; c.stdout.on("data", d => out += d);
    c.on("exit", () => res(out.trim()));
  }));
  for (let i = 0; i < 400 && readdirSync(ready).length < 20; i++) await new Promise(r => setTimeout(r, 25));
  check(readdirSync(ready).length === 20, "control: all 20 children reached the barrier before the start");
  writeFileSync(go, "");
  const held = (await Promise.all(kids)).filter(r => r === "HELD").length;
  check(held === 1, `exactly one of 20 racing processes holds the last slot (got ${held})`);
}
```

- [ ] **Step 2: Run it red, implement, run green, commit**

**On the broken implementation** — an admission written as read-then-write without `BEGIN IMMEDIATE` — every single-threaded assertion passes and only the 20-process race goes red, reporting more than one holder. That is why the race uses real child processes: a same-process loop over one connection is serial by construction and would pass against an implementation with no transaction at all.

```bash
$N test/provider-scheduler.test.mjs
git add src/build/providerdb.mjs src/provider.mjs test/provider-scheduler.test.mjs test/provider-race.test.mjs
git commit -m "feat(provider): transactional admission for the shared subscription"
```

---
### Task 22: The guardian claims a provider lease before dispatch, and fails OPEN

**Files:**
- Modify: `src/daemon.mjs` (at the dispatch site, at **two** places, because the tick spends model quota in two shapes. Measured on `e41cd28`:

1. **The containment canary**, `measuredContainment(...)` at `src/daemon.mjs:763` (search that name). It is itself a model dispatch and runs **once per tick**, before the per-PR loop, so it takes its own claim and releases it on return. An earlier draft of this plan said "before the containment canary" while anchoring at the halt check, which sits at line 792 — *after* it. The anchor was wrong, not the intent.

2. **Each worker dispatch**, immediately before the spawn and **after every refusal path in the loop**. The halt check is too early: `cannot dispatch FIX_CI — no resolvable root cause` (800), `demonstrated flake` (810) and the other `continue`s all sit between it and the spawn, so a claim taken there is held and abandoned on each — leaking a slot per skipped PR until expiry, starving the builder for reasons unrelated to quota. Claim last: the only thing between the claim and the spawn should be the spawn, which is the same shape: a precondition consulted before dispatch, never after)
- Test: `test/provider-guardian.test.mjs` (new)

**Interfaces:**
- Consumes: `claimProvider`, `releaseProvider`, `noteRateLimit` (Task 21); `hubPathFor`, `openHub` (PR-A).
- Produces: `ctx.hub` — an opened hub handle, or `null`. Defaults to opening `hubPathFor(reeveHome())` **if the file exists**, and to `null` otherwise. `ctx.providerClaim` / `ctx.providerRelease` override the seam in tests. `ctx.hub === null` is a normal, supported state.

**Founder decision 2026-08-22: the guardian fails OPEN.** When the hub is missing, locked, or corrupt, the guardian dispatches exactly as it does today and escalates `builder:provider:hub-unreadable`. The builder fails closed. The scheduler exists to restrain the builder, and must never become a new way to silence the watchman: a watchman that has stopped looking is indistinguishable from one reporting nothing wrong. This also keeps the existing guardian test files green untouched, which is what §14 asks of every new ctx key, and it matches the shipped `ctx.reviewIngest !== false` shape (search `ctx.reviewIngest !== false`; `src/daemon.mjs:596,1360,1367` on `e41cd28`).

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
const fixtureCtx = (dir) => ({ /* ...as in test/worker-contract.test.mjs... */
  log: (_p, line) => logLines.push(String(line)) });
const loggedAny  = (_ctx, re) => logLines.some(l => re.test(l));
const throwingHub = () => ({ prepare: () => { throw new Error("hub unreadable"); },
                             exec:    () => { throw new Error("hub unreadable"); } });
const escalatedWith = (ctx, why) =>
  [...(ctx.escalations?.keys?.() ?? [])].some(k => k === why || k.includes(why));

// ── the ordinary path: claim, dispatch, release ──────────────────────────────
{
  const db = openHub(join(dir, "h.db"));
  let dispatched = 0, heldDuringDispatch = -1, ownerDuringDispatch = null, boundPidDuringDispatch = null;
  const ctx = { ...fixtureCtx(dir), hub: db, lstart: LSTART,
    spawnWorker: async (opts) => {
      dispatched++;
      // Invoke onSpawn the way the real supervisor does, so the rebinding is
      // exercised. A fixture that ignores its arguments passes while
      // bindProviderLease is never called, and the lease stays bound to the
      // long-lived daemon -- whose liveness is always true, so the reaper can
      // never free the slot.
      opts?.onSpawn?.({ pid: 31337, lstart: "Sat Aug 23 09:30:00 2026" });
      heldDuringDispatch = db.prepare("SELECT count(*) c FROM provider_lease WHERE status='held'").get().c;
      const held = db.prepare("SELECT owner, pid, lstart FROM provider_lease WHERE status='held'").get();
      ownerDuringDispatch = held?.owner ?? null;
      boundPidDuringDispatch = held?.pid ?? null;
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
  check(boundPidDuringDispatch === 31337,
    "and was re-bound to the SPAWNED worker's pid, not the daemon's, so a dead worker frees its slot",
    String(boundPidDuringDispatch));
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
    const ctx = { ...fixtureCtx(dir), hub, spawnWorker: async () => { dispatched++; return { outcome: "ok" }; } };
    await tick(ctx);
    check(dispatched === 1, `with ${label}, the guardian dispatches exactly as it does today`, String(dispatched));
    // The GUARDIAN-owned identity, matching the production snippet. A `builder:`
    // subject in a per-repo guardian store is announced by nobody (section 11.7),
    // so when the identity changed this assertion had to change with it --
    // otherwise the test enforces the very bug it was written to prevent.
    check(escalatedWith(ctx, "the provider scheduler is unreadable; dispatching unscheduled"),
      "and escalates under a guardian-grammar identity, so failing open is never failing quiet");
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

In `src/daemon.mjs`, immediately after the halt check at line 712:

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
      let lease = null;
      // Resolved once per tick, not per PR. A missing numeric id is a
      // configuration error, not a reason to write a colliding lease row.
      // `profile.identity.repoId` is not a field the profile schema defines, so
      // that fallback was always null. The numeric id reeve already holds is the
      // one the inbox recorded when it observed this repository; read it from
      // the store and fail closed if absent, rather than inventing a profile key
      // this plan does not add to FIELDS.
      // Defined here, not merely referenced: the numeric id reeve already holds
      // is the one its own inbox recorded when it observed this repository.
      const repoIdFor = (db) =>
        db.prepare("SELECT repo_id FROM inbox WHERE repo_id IS NOT NULL ORDER BY id DESC LIMIT 1").get()?.repo_id ?? null;
      const repoId = ctx.repoId ?? repoIdFor(ctx.db);
      if (ctx.hub && repoId == null) {
        // REFUSE, do not merely note it. Falling through spends model quota
        // under no lease at all -- the one thing the scheduler exists to make
        // impossible -- and does it silently, because the escalation reads like
        // the work was stopped.
        escalations.set("the repository numeric id is unknown; provider leases cannot be scoped", 1);
        log(logPath, `  #${e.pr}: NOT dispatching — cannot scope a provider lease without the repository id`);
        continue;
      }
      if (ctx.hub) {
        try {
          const got = (ctx.providerClaim ?? claimProvider)(ctx.hub, {
            // repo_id is IN the live-request unique key, so a null makes every
            // repository share one key and the second guardian can never queue.
            // `evaluatePr` does not currently return it; resolve it once per tick
            // from the profile's numeric id and fail closed if it is absent,
            // rather than writing a row that collides by construction.
            // isSameProcess(pid, storedStart) is the shipped predicate
            // (src/supervisor.mjs:67). `pidAlive` was a name this plan invented
            // and nothing exports it, so the claim argument would have thrown.
            owner: "guardian", repoId, runRef: `pr:${e.pr}`,
            pid: process.pid, lstart: ctx.lstart, isAlive: isSameProcess,
          });
          if (!got.ok) {
            log(logPath, `  #${e.pr}: NOT dispatching — provider ${got.reason}` +
                         (got.until ? ` until ${new Date(got.until * 1000).toISOString()}` : ""));
            continue;                       // no attempt spent: this is quota, not a failure
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
          try { (ctx.providerRelease ?? releaseProvider)(ctx.hub, { id: lease }); }
          catch { (ctx.pendingReleases ??= []).push(lease); }
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
        // this dispatch site is `r`, the same one the rate-limit branch already reads (search `OUTCOMES.RATE_LIMITED`; `src/daemon.mjs:1271` on `e41cd28`).
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
                  cooldownSeconds: profile.builder?.provider?.cooldownSeconds ?? 300 }); } catch {}
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
      if (!existsSync(hp)) { this._hub = null; return null; }
      // The probe must not SHORT-CIRCUIT. `this._hub?.prepare(...)` on an unset
      // handle evaluates to undefined without throwing, so the catch never runs
      // and the getter returns undefined forever -- the hub permanently absent
      // on a machine where it exists, failing open in silence.
      try {
        if (!this._hub) throw new Error("not opened yet");
        // A permitted statement, and one that actually touches the file: the
        // authorizer denies bare `SELECT 1` (no table, so no READ to allow), and
        // a probe the guest rejects makes the getter reopen on every access. It
        // must also READ, because a handle to a deleted inode answers a
        // no-op successfully -- reading a real table is what detects the swap.
        this._hub.prepare("SELECT count(*) c FROM provider_state").get();
        return this._hub;
      } catch {
        try { this._hub = openHubAsGuest(hp); } catch { this._hub = null; }
      }
      return this._hub;
    },
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
- **Implement this task's `src/build/hubguest.mjs` FIRST.** Task 22 appears earlier in this document and its production initialisation imports `openHubAsGuest`; an executor working in document order needs the module to exist before that wiring resolves.
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
for (const m of ["applyChangeset", "deserialize", "loadExtension", "enableLoadExtension", "createSession"]) {
  let refused = false;
  try { g[m](); } catch { refused = true; }
  check(refused, `refused: the non-statement API ${m}() is not reachable on the guest`);
}
for (const [sql, name] of refused) {
  let why = null; try { g.prepare(sql); } catch (e) { why = e.message; }
  check(why !== null, `refused via prepare: ${name}`);
  // exec() is the other door, and it is the one a multi-statement string walks
  // through. A wrapper that gates prepare and leaves exec open is not an
  // allowlist; the boundary promises BOTH.
  let execWhy = null; try { g.exec(sql); } catch (e) { execWhy = e.message; }
  check(execWhy !== null, `refused via exec: ${name}`);
  check(/allowlist|not permitted/i.test(why ?? ""), `  and says why: ${name}`, String(why));
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

```js
export function openHubAsGuest(path) {
  const db = new DatabaseSync(path, { timeout: 10000 });
  const READ  = new Set(["provider_lease", "provider_state", "pr_hold", "maintenance_lock"]);
  const WRITE = new Set(["provider_lease", "provider_state", "maintenance_lock"]);

  // The authorizer runs inside SQLite, per accessed object, AFTER parsing. A
  // join, a subquery, a UNION, an INSERT ... SELECT and a multi-statement string
  // all decompose into the same per-table actions, so none of them can smuggle a
  // table past it -- which is exactly what a text matcher cannot promise.
  db.setAuthorizer((action, arg1) => {
    switch (action) {
      case SQLITE_READ:   return READ.has(arg1)  ? SQLITE_OK : SQLITE_DENY;
      case SQLITE_INSERT:
      case SQLITE_UPDATE:
      case SQLITE_DELETE: return WRITE.has(arg1) ? SQLITE_OK : SQLITE_DENY;
      case SQLITE_TRANSACTION: return SQLITE_OK;      // hubTx needs BEGIN/COMMIT/ROLLBACK
      case SQLITE_SELECT:      return SQLITE_OK;      // per-table READs are still checked
      default: return SQLITE_DENY;                    // ATTACH, PRAGMA, DDL, function creation
    }
  });

  // And remove every other route to the engine. `enableDefensive` blocks the
  // writable_schema class; the rest are deleted from this handle so a caller
  // cannot reach them at all.
  db.enableDefensive?.(true);
  for (const m of ["applyChangeset","createSession","createTagStore","deserialize",
                   "enableLoadExtension","loadExtension","function","aggregate","open"])
    Object.defineProperty(db, m, { value: () => { throw new Error(`${m} is not permitted on the guest hub connection`); } });
  return db;
}
``` Refuse `ATTACH`, `PRAGMA` writes, and multi-statement strings outright — a permissive parser is a hole, so the wrapper allows a **closed list of statement shapes** rather than trying to spot forbidden ones.

**On the broken implementation** — an allowlist checked by table name with a naive `sql.includes("provider_lease")` — the allowed list passes and `refused: enqueue an effect` goes red, because `INSERT INTO outbox ... VALUES('k','notify',...)` contains no table from the allowlist and yet a substring check that looks for *forbidden* names rather than matching *permitted shapes* lets it through. That inversion is the most likely wrong implementation here.

```bash
$N test/guardian-hub-allowlist.test.mjs
git add src/build/hubguest.mjs src/daemon.mjs test/guardian-hub-allowlist.test.mjs
git commit -m "feat(daemon): open the hub through a statement allowlist"
```

---

### Task 23b: The guardian's verdict actually reads `pr_hold`

**Files:**
- Modify: `src/verdict.mjs` (one additive clause **and its entry in the clause list**), `src/daemon.mjs` (pass the guest handle into evaluation), `src/pr.mjs` (`evaluatePr` threads `ctx.hub` and the builder-PR classification through to the verdict)

**Routing, not just definition.** `holdClause` computing the right answer is worth nothing if the production verdict never calls it. `evaluatePr` is what builds the clause set the daemon publishes, so it must pass `ctx.hub` and the structural builder-PR classification (head branch `mp/*`, or author is the App — the same detection as §9.2) into the verdict, and the verdict must include the clause's result in its worst-wins fold. The test below asserts membership in `VERDICT_CLAUSES` for that reason; add a second assertion that a fixture `evaluatePr` over a builder PR with an uncleared hold returns a verdict of `BLOCK`, because membership alone does not prove the value reaches the fold.
- Test: `test/guardian-pr-hold-clause.test.mjs` (new)

**Interfaces:**
- Consumes: `openHubAsGuest` (Task 23).
- Produces: `holdClause(hub, { repoId, pr, isBuilderPr }) -> { id: 'hold', state: 'PASS'|'BLOCK'|'UNKNOWN', detail }`, added to the verdict's clause list. Ordinary PRs are **not evaluated**: the clause returns `PASS` with `detail: 'not a builder PR'` and never opens the hub.

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
import { VERDICT_CLAUSES } from "../src/verdict.mjs";
check(VERDICT_CLAUSES.includes("hold"),
  "and the clause is IN the worst-wins list, not merely defined beside it", VERDICT_CLAUSES.join(","));
```

- [ ] **Step 3: Commit**

```bash
# src/pr.mjs is where evaluatePr threads the hub and the builder classification
# into the verdict. Omitting it leaves holdClause defined and never called.
git add src/verdict.mjs src/pr.mjs src/daemon.mjs test/guardian-pr-hold-clause.test.mjs
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
import { tick } from "./src/daemon.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "reeve-accept-"));
const db = openHub(join(dir, "hub.db"));
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
console.log("guardian held during:", during?.filter(r => r.status === "held" && r.owner === "guardian").length);
console.log("rows remaining after:", after.length);
EOF
$N ./acceptance-tmp.mjs | tee /tmp/acceptance.txt
rm ./acceptance-tmp.mjs        # scratch, never committed
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
`builder:provider:hub-unreadable`. The builder fails closed. The scheduler
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
