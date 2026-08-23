# S2-B: The Phase Machine and Its Effects, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure and total phase machine that decides every transition, one generation-fenced transaction that applies it, a fenced outbox that cannot double-deliver or act under a stale contract, the admission snapshot, and the crash, corruption and duplicate-delivery drills.

**Architecture:** One PR against `revnix/reeve` `main`, **based on S2-A after it merges** — not before: these tests open a hub, and rebasing across a changed `hub.sql` would silently change what they test. Adds `src/build/phases.mjs` (pure), `src/build/transition.mjs`, `src/build/outbox.mjs`, `src/build/registry.mjs`, `src/build/gatestate.mjs`. **No GitHub call from any code path, and no worker dispatched.**

**Tech Stack:** Node `~/.nvm/versions/node/v24.17.0/bin/node` (PATH node is v22 and `node:sqlite` warns there), `node:sqlite` `DatabaseSync`, plain-script tests under `test/*.test.mjs` (CI runs every file in that glob on ubuntu-latest under three TZs), no dependencies added.

**Spec:** `docs/2026-08-21-builder-design.md` — §14 S2 is the stage definition and its *Verify:* clause is the definition of done. The sections that bind this plan: §1.5 (registry snapshot), §1.6 (determinism as code layout), §3.1–§3.5 (states, transition discipline, resume, held states, CANCELLING), §7.6 (the inbox), §9.1 (`repo_gate_state`), §10.1–§10.2 (territory and leases), §12 (the failure matrix).

**This is one of three plans for S2.** They were split out of a single 5,300-line document after four review rounds found 54 defects, a majority of them caused by the previous round's own fixes: an edit in a document that large cannot see its neighbourhood. Each plan is now self-contained and reviewed on its own.

| plan | scope |
|---|---|
| `2026-08-23-s2a-hub-store.md` | the store: schema, migrations, locks, backup, restore, the cross-check |
| `2026-08-23-s2b-phase-machine.md` | the pure machine, the transition transaction, the fenced outbox, registry, gate state |
| `2026-08-23-s2c-provider-scheduler.md` | the shared scheduler, the guardian claim, the hub allowlist, the `pr_hold` verdict clause |

Their review history — all 54 findings and what each changed — is `2026-08-23-s2-review-history.md`. **Order matters:** A lands before B, B before C. Base this on S2-A's merge commit.

---

## What this plan consumes from S2-A

S2-A must be merged first. These are the exact names this plan builds on; if any has changed, stop and reconcile rather than adapting the code here.

| from | name | shape |
|---|---|---|
| `src/build/hubdb.mjs` | `openHub(path)` | opens, migrates forward, refuses a newer store |
| | `hubTx(db, fn)` | one `BEGIN IMMEDIATE`; rolls back on throw |
| | `hubEvent(db, {kind, task, payload}) -> seq` | appends **in the caller's transaction**; payload is the written ROW IMAGE |
| | `HUB_SCHEMA_VERSION` | integer, currently 1 |
| `src/build/hub.sql` | all 32 tables | `task` (with `slice_cursor`, `resume_seq`, `held_from`, `blocked_reason`, `terminal_reason`), `task_territory`, `task_drain`, `phase_event`, `hold_reason`, `hub_event`, `outbox` (with `task_generation`, `fence`, `cancellable`, and `outbox_live_key`), `territory_lease`, `repo_gate_state` |
| | `outbox.fence INTEGER NOT NULL REFERENCES phase_event(seq)` | **added to S2-A's migration 1 for this plan.** An effect can only name an authorising event that exists, so `applyTransition` must append its `phase_event` **before** it enqueues — which it does — and every fixture that enqueues must mint the events first, which is why `seed` creates a run of them |
| `src/build/locks.mjs` | `assertWritable(db, {isAlive, at, inTx})` | throws while a live restore holds `maintenance_lock`; **every hub writer calls it** |
| `src/build/replay.mjs` | `COMPARISON_SET`, `replayableKinds()` | this plan's new `hub_event` kinds must appear in `HANDLERS` |
| `src/build/tables.mjs` | `TABLE_OWNERS` | every table this plan gives a writer to must have its row updated |

**Two obligations this plan inherits.** Every authority-bearing write appends one `hub_event` in its own transaction, and its payload is the row that was written, not a description of a change — that is what lets `replayHub` be a primary-key upsert. And every path that returns before the CAS must fence itself against `(phase, generation)`; three separate defects in the original review were paths that returned early without doing so.

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

  `escape.test.mjs` writes decoys into the shared `~/.reeve/canary/` tree the live daemon reads. A command that contradicts the warning beside it means the warning loses. **Measured 2026-08-22 on `9dbd3a0`: 59 test files exist; 58 were run and all 58 passed.** `test/escape.test.mjs` was NOT run, because it writes decoy files into the shared `~/.reeve/canary/` directory that the live daemon also reads; run it once on a quiet machine to complete the baseline. That run had `node_modules` absent, and a green file can hide a skip, so skips were counted rather than assumed: exactly two files carry one `SKIP` each (`policy-self-exclusion`, `supervisor-contract`). That 58-file pass is the base every task is measured against, and it is the same base for all three PRs — never a chained comparison against the previous task.
- **Line numbers are measured against `16769e7`** (the `main` this plan was last checked on) and every one is paired with a searchable string. If a number does not match, the file has moved under it — search the string, and do not assume the surrounding reasoning is stale. PR #14 shifted nine of them by one line on 2026-08-23, and one citation (`ctx.reviewIngest`) had been wrong by eighty lines since before that.
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
2. **The guardian fails OPEN when hub.db is unreadable at provider-claim time.** It dispatches exactly as it does today and escalates `builder:provider:hub-unreadable`. The builder fails closed. The scheduler restrains the builder; it must never become a new way to silence the guardian. This matches the `ctx.reviewIngest !== false` opt-out shape §14 asks new ctx keys to follow (search `ctx.reviewIngest !== false`; `src/daemon.mjs:597,1361,1368` on `16769e7`), so existing guardian tests stay green untouched.
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

`allOn` belongs to the shared block too. Three test files in this plan lease
effects and only one of them defined it:

```js
// Every capability switch ON. leaseEffect settles a row `refused` when the
// effect's switch is off (section 1.6), so a file that omits this gets null
// from every lease and every assertion below it fails for the same unrelated
// reason -- which reads as a broken outbox rather than a missing fixture.
// The switch names are the outbox `kind` values.
// The PROFILE's capability switches, from `src/profile/schema.mjs:206-210` --
// not the outbox `kind` values, which are what an earlier version of this
// fixture set. They are different vocabularies: `leaseEffect` asks the profile
// whether the CAPABILITY behind an effect is enabled, and capabilities default
// FALSE, so a fixture keyed by effect kind leaves every real switch absent and a
// correct executor settles every supposedly-good lease `refused`. Every positive
// assertion in this file would have failed against the implementation it
// specifies.
const allOn = {
  "builder.capabilities.observe":        true,
  "builder.capabilities.draftSpec":      true,
  "builder.capabilities.implementLocal": true,
  "builder.capabilities.publishPr":      true,
  "builder.capabilities.mergeBuilderPr": true,
};
```

Where a task writes `/* ... standard harness, plus seed ... */`, it means the
block above, `allOn`, **and** this helper. Several task files use `seed(db, over)` and only
one of them previously said where it came from:

```js
// One task, plus the phase_event run its effects will fence against.
//
// The phase_event rows are not decoration. S2-A declares
// `outbox.fence INTEGER NOT NULL REFERENCES phase_event(seq)`, so an effect can
// only name an authorising event that exists -- which is the point of the
// column, and which means every fixture that enqueues has to mint the events
// first. `events` covers the highest fence any block in the file names.
const seed = (db, over = {}, { events = 10 } = {}) => hubTx(db, () => {
  const t = { id: "bt:1", project: "p", repo_id: 1, nwo: "o/r", title: "t",
              phase: "IMPLEMENTING", generation: 1, ...over };
  db.prepare(
    `INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
                      repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,
                      created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,'founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`)
    .run(t.id, t.project, t.repo_id, t.nwo, t.title, t.phase, t.generation);
  // Sequence numbers CONTINUE from whatever is already there. Restarting at 1
  // meant a second `seed` into the same database collided on phase_event's
  // primary key and aborted setup -- so any block seeding a second task (a
  // territory blocker, a drain owner) failed before reaching its assertions,
  // and reported that as a defect in the code under test. Allocating instead of
  // assuming removes the constraint on every present and future caller rather
  // than on the one that noticed.
  const base = db.prepare("SELECT COALESCE(max(seq),0) s FROM phase_event").get().s;
  for (let i = 1; i <= events; i++)
    db.prepare(`INSERT INTO phase_event(seq,task,at,op,from_phase,to_phase,detail)
                VALUES(?,?,unixepoch(),'seed',NULL,?,'{}')`).run(base + i, t.id, t.phase);
  return t;
});
```

Each task names any imports it needs **beyond** these.

## File structure

| File | Responsibility after this plan |
|---|---|
| `bin/reeve` (PR-A, PR-B) | `build run|status|pause` routes; `build run` takes the singleton lease and refuses a second instance naming the holder. |
| `src/build/phases.mjs` (new, PR-B) | `nextPhase(state, evidence)` → transition or refusal. **Pure and total.** No I/O, no clock, no database. The whole §3.1 matrix. |
| `src/build/transition.mjs` (new, PR-B) | the one `BEGIN IMMEDIATE` transaction of §3.2: generation-fenced CAS, `phase_event`, `hub_event`, artifact sha, effect enqueue, and the §3.2.5 compensations. |
| `src/build/outbox.mjs` (new, PR-B) | hub `enqueue`/`leaseOutbox`/`settleOutbox`/`recoverOutbox`/`voidPending`, fence revalidation, and the live-rows-only key rule. |
| `src/build/registry.mjs` (new, PR-B) | `resolveSnapshot(registry, project, claims, io)`: the §1.5 admission snapshot, network first and transaction second. |
| `src/build/gatestate.mjs` (new, PR-B) | `gateStateFrom(ruleset, installation, now)`: the pure `repo_gate_state` derivation. |
| `test/hub-phases.test.mjs` (new, PR-B) | the transition matrix as a table test, GATE → ESCALATED, the CANCELLING exclusion, both held-state exits, totality. |
| `test/hub-transition.test.mjs` (new, PR-B) | CAS lost-race no-op, generation fence rejects a stale row, hold and cancel compensations, `hub_event` on every authority-bearing write. |
| `test/hub-outbox.test.mjs` (new, PR-B) | fence revalidation, live-rows-only key uniqueness, round-keyed supersede, duplicate delivery of every kind. |

---

# PR-B: The phase machine and its effects

**Branch:** `feat/s2-phase-machine`, based on `feat/s2-hub-store` **after PR-A merges** (not before: PR-B's tests open a hub, and a rebase across a changed `hub.sql` would silently change what they are testing). **Scope:** the pure machine, the one transition transaction, the fenced outbox, the registry snapshot, the `repo_gate_state` derivation, and the crash/corruption/duplicate-delivery drills.

---

### Task 14: `phases.mjs` — pure, total, and the whole §3.1 matrix

**Files:**
- Create: `src/build/phases.mjs`
- Test: `test/hub-phases.test.mjs`

**Interfaces:**
- Consumes: nothing. **This module imports nothing.** No database, no clock, no filesystem, no randomness. That is what makes the transition matrix a table test rather than a fixture ceremony.
- Produces:
  - `PHASES`, `ACTIVE`, `HELD`, `DRAINING`, `TERMINAL`, `NON_TERMINAL` — frozen arrays. `PHASES` must equal the `task.phase` CHECK from `hub.sql` exactly.
  - `nextPhase(state, evidence) -> Transition | Refusal` where
    `state = { phase, generation, heldFrom, sliceCursor, drainRemaining, hasOpenPr, pinnedTerritory }`,
    `Transition = { ok: true, to, generation, bumps, compensations: string[] }`,
    `Refusal = { ok: false, refusal: string, stackable?: true, persistDepth?: Depth, compensations?: string[] }`.
  - **A refusal can carry a durable consequence**, and two do. `persistDepth` and
    `compensations` both ride the refusal shape because a `depth.override` on
    SIZING, RESEARCH or DESIGN refuses the *transition* — the phase genuinely
    does not change — while accepting the *override*, which has to be written and
    has to end the attempt running under the old depth. `applyTransition`'s
    refusal branch applies both before it logs `transition.refused`. Every other
    refusal carries neither, so those two steps are no-ops on the ordinary path.
  - **`stackable` is how the machine tells `applyTransition` that a refusal still
    carries a durable write.** Exactly one refusal sets it: a `hold` arriving on
    an already-held task, which appends a `hold_reason` and updates the open
    `pr_hold` instead of transitioning. `applyTransition` used to re-derive that
    from `(phase is HELD && evidence.kind === "hold")`, which is equally true of
    a hold whose REASON the machine just refused -- so the branch that writes the
    row ran for exactly the cases that must not write one, handing
    `hold_reason`'s closed CHECK a name it throws on.
  - `escalate` (optional) names the §11.7 identity this transition must raise, or is absent. `applyTransition` raises it in the same transaction. The identities are **bare**: no counts, durations, SHAs or paths in the key — those ride in the body. Four transitions carry one: `INFEASIBLE` raises `bt:<id>:infeasible` (a success state, but never a quiet one — it is the one builder escalation retired by the terminal state itself), the post-approval depth override raises `bt:<id>:depth:post-approval`, a gate that exhausts its revision cap raises `bt:<id>:gate:revision-loop`, and a worker phase's exhausted retries raise `bt:<id>:phase:failed:<phase>`. Only the last interpolates: `<id>` is substituted by `applyTransition`, which knows the task, while `<phase>` is substituted in `phases.mjs`, which is the only place that knows which phase ran out of attempts.
  - `compensations` is a list drawn from the closed set `['void-pending','write-pr-hold','close-prs','release-territory','regrant-territory','clear-holds','annotate-resumed','record-hold-reason','adopt-snapshot','release-ledger-claim','terminate-worker','record-research-skip','record-drain','force-drain']` — **fourteen** — so the transaction in Task 15 has nothing to decide.
  - **The list is ORDERED, and `applyCompensation` runs it in that order.** `record-drain` is last because it snapshots the outbox rows that are in flight *at that moment*: run before `close-prs`, it captures only rows that were already inflight and misses the PR-close and comment effects the cancellation itself just enqueued, so `drainRemaining` reads zero and the task can reach CANCELLED with its own compensations still pending. Anything that enqueues must run before the thing that counts what is outstanding.
  - Every name in that set has a branch in `applyCompensation` (Task 15). A compensation the machine can emit and the transaction cannot apply either throws and rolls back the transition, or silently does nothing — and `regrant-territory` was emitted for a round with no branch to run it, which would have made every resume either fail or return without its lease.

- [ ] **Step 1: Write the failing test**

Create `test/hub-phases.test.mjs`:

```js
// The transition matrix, as a table.
//
// This module is pure so that this test can be exhaustive rather than
// representative: every phase crossed with every evidence kind, 21 x N cells,
// each of which must return a transition or a refusal and never throw, never
// return undefined, and never invent a phase that is not in the enumeration.
//
// Totality is the property that matters. A machine with a hole does not fail
// loudly at the hole -- it returns undefined, the caller reads that as "no
// transition", and the task sits in a state forever with nothing reporting it.
import { PHASES, ACTIVE, HELD, DRAINING, TERMINAL, NON_TERMINAL, nextPhase } from "../src/build/phases.mjs";
/* ... standard harness ... */

const EVIDENCE = [
  { kind: "phase.succeeded", phase: "RESEARCH", artifactSha: "a" },
  { kind: "slice.merged" },                                   // no witness: must refuse
  { kind: "slice.merged", mergedSha: "d".repeat(40), mergedAt: 1 },
  { kind: "phase.failed", retriesExhausted: true },
  { kind: "phase.failed", retriesExhausted: false },
  { kind: "gate.approved" }, { kind: "gate.revise" }, { kind: "gate.capReached" },
  { kind: "depth.override" }, { kind: "slice.merged" }, { kind: "claim.lost" },
  { kind: "slice.next", moreSlices: true }, { kind: "slice.next", moreSlices: false },
  { kind: "claim.won" }, { kind: "claim.won", claimEventId: "e1", projectionGeneration: 3 },
  { kind: "phase.succeeded" },                              // no phase identity: must refuse
  { kind: "finalize.settled", outstanding: 0 }, { kind: "finalize.settled", outstanding: 2 },
  { kind: "founder.regenerate" },
  { kind: "hold", reason: "ownership_lost" },
  { kind: "founder.cancel" },
  { kind: "founder.cancelForce", drainEligible: true }, { kind: "founder.cancelForce", drainEligible: false },
  { kind: "founder.infeasible", reason: "r" },
  { kind: "founder.resume", redesign: false }, { kind: "founder.resume", redesign: true },
  { kind: "drain.settled" },
  { kind: "nonsense" },
];

// ── the enumeration is closed and matches the DDL ────────────────────────────
{
  check(PHASES.length === 21, `there are 21 phases (got ${PHASES.length})`, PHASES.join(","));
  const union = [...ACTIVE, ...HELD, ...DRAINING, ...TERMINAL].sort();
  check(JSON.stringify(union) === JSON.stringify([...PHASES].sort()),
    "active + held + draining + terminal partitions PHASES exactly", union.join(","));
  check(new Set(union).size === union.length, "and the four groups do not overlap");
  check(JSON.stringify([...HELD].sort()) === '["BLOCKED","ESCALATED"]', "the held states are exactly BLOCKED and ESCALATED");
  check(JSON.stringify(DRAINING) === '["CANCELLING"]', "CANCELLING is the only draining state");
  check(JSON.stringify([...TERMINAL].sort()) === '["CANCELLED","DONE","INFEASIBLE","LOST"]', "and the four terminals are the four terminals");
  check(!NON_TERMINAL.includes("CANCELLING"),
    "CANCELLING is NOT in NON_TERMINAL: it is excluded as a source from every 'any non-terminal' edge");
}

// ── totality: every cell answers ─────────────────────────────────────────────
{
  let holes = [];
  for (const phase of PHASES) for (const e of EVIDENCE) {
    let r;
    try { r = nextPhase({ phase, generation: 2, heldFrom: "IMPLEMENTING", sliceCursor: 1, drainRemaining: 0, hasOpenPr: true }, e); }
    catch (err) { holes.push(`${phase} x ${e.kind}: threw ${err.message}`); continue; }
    if (!r || typeof r.ok !== "boolean") { holes.push(`${phase} x ${e.kind}: returned ${JSON.stringify(r)}`); continue; }
    if (r.ok && !PHASES.includes(r.to)) holes.push(`${phase} x ${e.kind}: invented phase ${r.to}`);
    if (!r.ok && !(typeof r.refusal === "string" && r.refusal.length)) holes.push(`${phase} x ${e.kind}: refusal with no reason`);
  }
  check(holes.length === 0, `every one of ${PHASES.length * EVIDENCE.length} cells returns a transition or a reasoned refusal`,
    holes.slice(0, 8).join("\n        "));

  // Totality is necessary and nowhere near sufficient: "a transition OR a
  // reasoned refusal" is satisfied by a machine that refuses every cell. The
  // legal edges have to be asserted by NAME, or an implementation can omit the
  // spine entirely and still pass.
  const EXPECTED = [
    ["FILED",        { kind: "phase.succeeded", phase: "FILED" },              "SIZING"],
    ["SIZING",       { kind: "phase.succeeded", phase: "SIZING" },             "RESEARCH"],
    ["SIZING",       { kind: "phase.succeeded", phase: "SIZING", depth: "trivial" }, "DESIGN"],
    ["RESEARCH",     { kind: "phase.succeeded", phase: "RESEARCH" },           "DESIGN"],
    ["DESIGN",       { kind: "phase.succeeded", phase: "DESIGN" },             "SPEC_DRAFT"],
    ["SPEC_DRAFT",   { kind: "phase.succeeded", phase: "SPEC_DRAFT" },         "SPEC_PR_OPEN"],
    ["SPEC_PR_OPEN", { kind: "phase.succeeded", phase: "SPEC_PR_OPEN" },       "GATE"],
    ["GATE",         { kind: "gate.approved" },                               "APPROVED"],
    ["GATE",         { kind: "gate.revise" },                                 "SPEC_DRAFT"],
    ["GATE",         { kind: "gate.capReached" },                             "ESCALATED"],
    ["APPROVED",     { kind: "phase.succeeded", phase: "APPROVED" },           "IMPLEMENTING"],
    ["IMPLEMENTING", { kind: "phase.succeeded", phase: "IMPLEMENTING" },       "IMPL_PR_OPEN"],
    ["IMPL_PR_OPEN", { kind: "phase.succeeded", phase: "IMPL_PR_OPEN" },       "VERDICT_WAIT"],
    ["CLAIMING",     { kind: "claim.lost" },                                  "LOST"],
  ];
  const wrong = EXPECTED.filter(([from, ev, to]) => {
    const r = nextPhase({ phase: from, generation: 1, heldFrom: null }, ev);
    return !(r.ok && r.to === to);
  }).map(([from, ev, to]) => `${from} --${ev.kind}--> expected ${to}`);
  check(wrong.length === 0, "every named edge of the section 3.1 spine goes where 3.1 says", wrong.join("; "));
}

// ── terminals are terminal ───────────────────────────────────────────────────
{
  const escapes = [];
  for (const phase of TERMINAL) for (const e of EVIDENCE) {
    const r = nextPhase({ phase, generation: 1 }, e);
    if (r.ok) escapes.push(`${phase} -> ${r.to} on ${e.kind}`);
  }
  check(escapes.length === 0, "no evidence of any kind moves a terminal state", escapes.join(", "));
}

// ── the named edges from the Verify clause ───────────────────────────────────
{
  // regenerate emits adopt-snapshot, which writes the contract columns from
  // evidence.snapshot. Without the snapshot it bumped the generation and then
  // adopted undefined into every one of them.
  // ALL ELEVEN fields the validation requires. Five made `regenOk` a refusal --
  // the block advertised as the successful control was refused for missing
  // repoId, nwo, repoPath, profilePath, specRepoId and founderUserId, so the
  // "accepted" assertion tested nothing and the per-field loop below had no
  // passing baseline to remove one field from.
  const SNAP = { repoId: 1, nwo: "o/r", repoPath: "/p", profilePath: "/f",
                 profileHash: "h", defaultBranch: "main", visibility: "private",
                 specRepoId: 9, gateDefinitionHash: "g", registryVersion: 3,
                 founderUserId: 4242 };
  const regenOk = nextPhase({ phase: "IMPL_PR_OPEN", generation: 2 },
    { kind: "founder.regenerate", snapshot: SNAP });
  check(regenOk.ok && regenOk.compensations.includes("adopt-snapshot"),
    "a regenerate with a resolved snapshot adopts it", JSON.stringify(regenOk));
  const regenBare = nextPhase({ phase: "IMPL_PR_OPEN", generation: 2 }, { kind: "founder.regenerate" });
  check(!regenBare.ok && /resolved registry snapshot/.test(regenBare.refusal ?? ""),
    "a regenerate with NO snapshot is refused before the generation bumps", JSON.stringify(regenBare));
  // A PARTIAL snapshot is the dangerous one: the fields it does carry are
  // correct, so it looks like it worked.
  for (const drop of Object.keys(SNAP)) {
    const partial = { ...SNAP }; delete partial[drop];
    const r = nextPhase({ phase: "IMPL_PR_OPEN", generation: 2 },
      { kind: "founder.regenerate", snapshot: partial });
    check(!r.ok && (r.refusal ?? "").includes(drop),
      `a regenerate missing ${drop} is refused, naming it`, JSON.stringify(r));
  }

  const gate = nextPhase({ phase: "GATE", generation: 1 }, { kind: "gate.capReached" });
  check(gate.ok && gate.to === "ESCALATED", "GATE -> ESCALATED at the revision cap", JSON.stringify(gate));

  // ESCALATED has exactly two entry edges. Anything else reaching it is a hole.
  const entries = [];
  for (const phase of PHASES) for (const e of EVIDENCE) {
    const r = nextPhase({ phase, generation: 1, heldFrom: "IMPLEMENTING" }, e);
    if (r.ok && r.to === "ESCALATED") entries.push(`${phase}:${e.kind}`);
  }
  check(entries.every(x => x.endsWith(":phase.failed") || x === "GATE:gate.capReached"),
    "ESCALATED is entered only by a worker phase's exhausted retries, or GATE at the cap", entries.join(", "));

  // CANCELLING is excluded as a SOURCE from every 'any non-terminal' edge.
  for (const e of [{ kind: "hold", reason: "x" }, { kind: "founder.infeasible", reason: "r" }, { kind: "founder.cancel" }]) {
    const r = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 3 }, e);
    check(!r.ok, `CANCELLING refuses ${e.kind}: it exits only to CANCELLED`, JSON.stringify(r));
  }
  const draining = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 2 }, { kind: "drain.settled" });
  check(!draining.ok, "CANCELLING with rows still draining does not settle");
  const drained = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 0 }, { kind: "drain.settled" });
  check(drained.ok && drained.to === "CANCELLED", "and settles to CANCELLED only when the drain is empty", JSON.stringify(drained));
  const forced = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 5 }, { kind: "founder.cancelForce", drainEligible: true });
  check(forced.ok && forced.to === "CANCELLED", "--force is the one founder exit from CANCELLING");
  const tooSoon = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 5 }, { kind: "founder.cancelForce", drainEligible: false });
  check(!tooSoon.ok, "and it refuses before drainMinutes has passed, so rows are never recorded forced untried",
    JSON.stringify(tooSoon));

  // There is no IMPLEMENTING -> SPEC_DRAFT edge. A plan that turns out wrong
  // mid-implementation is a founder decision, never an automatic respec.
  // A bare phase report must not merge anything or finish anything.
  {
    const vw = nextPhase({ phase: "VERDICT_WAIT", generation: 1 }, { kind: "phase.succeeded", phase: "VERDICT_WAIT" });
    check(!vw.ok, "VERDICT_WAIT does not advance on phase.succeeded: merging needs the reconciler's witness", JSON.stringify(vw));
    const fz = nextPhase({ phase: "FINALIZING", generation: 1 }, { kind: "phase.succeeded", phase: "FINALIZING" });
    check(!fz.ok, "FINALIZING does not advance on phase.succeeded", JSON.stringify(fz));
    const busy = nextPhase({ phase: "FINALIZING", generation: 1 }, { kind: "finalize.settled", outstanding: 2 });
    check(!busy.ok, "nor while finalization effects are still unsettled", JSON.stringify(busy));
    const done = nextPhase({ phase: "FINALIZING", generation: 1 }, { kind: "finalize.settled", outstanding: 0 });
    check(done.ok && done.to === "DONE", "control: it reaches DONE once everything has settled", JSON.stringify(done));
  }

  const respec = PHASES.filter(p => {
    const r = nextPhase({ phase: "IMPLEMENTING", generation: 1 }, { kind: "phase.failed", retriesExhausted: true });
    return r.ok && r.to === "SPEC_DRAFT";
  });
  check(respec.length === 0, "there is no IMPLEMENTING -> SPEC_DRAFT edge");

  // Both held states exit, and only --redesign bumps.
  for (const held of HELD) {
    const plain = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING" }, { kind: "founder.resume", redesign: false });
    check(plain.ok && plain.to === "IMPLEMENTING" && plain.generation === 3 && plain.bumps === false,
      `${held} + plain resume re-enters held_from at the SAME generation, so the approval survives`, JSON.stringify(plain));
    check(plain.compensations?.includes("clear-holds"), `${held} + resume clears the pr_hold rows`, JSON.stringify(plain));
    check(plain.compensations?.includes("regrant-territory"),
      `${held} + resume re-grants the territory released on entry`, JSON.stringify(plain));
    const conflicted = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING" },
      { kind: "founder.resume", redesign: false, territoryConflict: "bt:9" });
    check(!conflicted.ok && /bt:9/.test(conflicted.refusal ?? ""),
      `${held} + resume is refused when the territory now conflicts, naming the blocker`, JSON.stringify(conflicted));

    // A LEDGER-sourced task needs an affirmative, fresh ownership witness. The
    // guard used to be negative-only, so a caller that never ran the sync
    // omitted `ownerNotReeve` and was read as "reeve owns it" -- restarting work
    // on a claim nobody re-verified. Section 2.5 requires a full sync before
    // every resume, so its absence is a refusal.
    const unverified = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING", sourceKind: "ledger" },
      { kind: "founder.resume", redesign: false });
    check(!unverified.ok && /ledger sync/.test(unverified.refusal ?? ""),
      `${held} + a ledger resume with no ownership witness is refused`, JSON.stringify(unverified));
    const verified = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING", sourceKind: "ledger" },
      { kind: "founder.resume", redesign: false, ownerIsReeve: true, ownershipSyncedAt: 1_800_000_000 });
    check(verified.ok, `${held} + a ledger resume WITH a fresh witness proceeds`, JSON.stringify(verified));
    // CONTROL, both directions: the founder-filed default is unaffected (the
    // plain resume above passed), and an explicit contrary owner still refuses.
    const humanOwned = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING", sourceKind: "ledger" },
      { kind: "founder.resume", redesign: false, ownerIsReeve: true,
        ownershipSyncedAt: 1_800_000_000, ownerNotReeve: "someone" });
    check(!humanOwned.ok && /someone/.test(humanOwned.refusal ?? ""),
      `${held} + a ledger resume is still refused when a human owns the node`, JSON.stringify(humanOwned));

    const redesign = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING", hasOpenPr: true }, { kind: "founder.resume", redesign: true });
    check(redesign.ok && redesign.to === "DESIGN" && redesign.generation === 4 && redesign.bumps === true,
      `${held} + --redesign lands in DESIGN and bumps the generation`, JSON.stringify(redesign));
    check(redesign.compensations?.includes("close-prs"), "and closes the open slice PR");
  }

  // A hold arriving on an ALREADY-held task does not transition it: it stacks a
  // reason and keeps the original held_from. A transition here would rewrite
  // held_from and lose where the task should go back to.
  for (const held of HELD) {
    const r = nextPhase({ phase: held, generation: 1, heldFrom: "IMPLEMENTING" }, { kind: "hold", reason: "ownership_lost" });
    check(!r.ok, `a hold on an already-${held} task does not transition it`, JSON.stringify(r));
    check(/stack|already held/i.test(r.refusal ?? ""), "and says so, so the caller appends a hold_reason instead", String(r.refusal));
    check(r.stackable === true, "and marks the refusal STACKABLE, so applyTransition knows to append a reason");
    // An unknown reason must be refused BEFORE the already-held check, not after
    // it: `hold_reason.reason` is a closed CHECK, so a refusal marked stackable
    // with a bogus reason reaches the constraint and THROWS out of the
    // transaction instead of returning a refusal the caller can render.
    const bogusStack = nextPhase({ phase: held, generation: 1, heldFrom: "IMPLEMENTING" },
      { kind: "hold", reason: "because" });
    check(!bogusStack.ok && !bogusStack.stackable && /unknown hold reason/.test(bogusStack.refusal ?? ""),
      `an unknown reason on an already-${held} task is refused, not stacked`, JSON.stringify(bogusStack));
  }

  // Every hold cause raises ITS OWN identity. A generic BLOCKED with no
  // escalation is a task that stops and waits for a founder who was never told,
  // and BLOCKED has no automatic exit.
  for (const [reason, why] of [
    ["ownership_lost",      "bt:<id>:intake:ownership-lost"],
    ["harness_touched",     "bt:<id>:impl:harness-touched"],
    ["over_budget",         "bt:<id>:impl:over-budget"],
    ["depth_post_approval", "bt:<id>:depth:post-approval"],
    ["reopen",              "bt:<id>:spec:reopened"],
  ]) {
    const h = nextPhase({ phase: "IMPLEMENTING", generation: 1 }, { kind: "hold", reason });
    check(h.ok && h.escalate === why, `a ${reason} hold raises ${why}`, JSON.stringify(h));
  }
  // blocked_other carries the identity the CALLER determined -- the DDL gives
  // pr_hold a `detail` column for exactly this -- and refuses without one.
  const other = nextPhase({ phase: "IMPLEMENTING", generation: 1 },
    { kind: "hold", reason: "blocked_other", escalation: "bt:<id>:lease:conflict" });
  check(other.ok && other.escalate === "bt:<id>:lease:conflict",
    "a blocked_other hold raises the identity its caller supplied", JSON.stringify(other));
  const nameless = nextPhase({ phase: "IMPLEMENTING", generation: 1 }, { kind: "hold", reason: "blocked_other" });
  check(!nameless.ok, "and a blocked_other hold with no identity is REFUSED, not held silently", JSON.stringify(nameless));
  // CONTROL: the map is closed against pr_hold's CHECK set, so a reason outside
  // it is a refusal rather than a hold with no name.
  const bogus = nextPhase({ phase: "IMPLEMENTING", generation: 1 }, { kind: "hold", reason: "because" });
  check(!bogus.ok && /unknown hold reason/.test(bogus.refusal ?? ""),
    "control: a reason outside pr_hold's CHECK set is refused", JSON.stringify(bogus));

  // ESCALATED voids nothing; BLOCKED voids pending rows. Both release territory.
  const blocked = nextPhase({ phase: "IMPLEMENTING", generation: 1, hasOpenPr: true }, { kind: "hold", reason: "over_budget" });
  check(blocked.ok && blocked.to === "BLOCKED" && blocked.compensations.includes("void-pending"),
    "BLOCKED voids pending cancellable rows", JSON.stringify(blocked));
  const esc = nextPhase({ phase: "IMPLEMENTING", generation: 1, hasOpenPr: true }, { kind: "phase.failed", retriesExhausted: true });
  check(esc.ok && esc.to === "ESCALATED" && !esc.compensations.includes("void-pending"),
    "ESCALATED voids NOTHING: the phase merely stopped, and its effects stand", JSON.stringify(esc));
  // A trivial filing skips RESEARCH, and the skip is recorded rather than merely
  // implied by a missing artifact.
  const triv = nextPhase({ phase: "SIZING", generation: 1 },
    { kind: "phase.succeeded", phase: "SIZING", depth: "trivial" });
  check(triv.ok && triv.to === "DESIGN", "a trivial filing goes straight from SIZING to DESIGN", JSON.stringify(triv));
  check(triv.compensations.includes("record-research-skip"),
    "and emits record-research-skip, so the absent research artifact has a durable reason",
    JSON.stringify(triv.compensations));

  check(esc.escalate === "bt:<id>:phase:failed:IMPLEMENTING",
    "and it carries the phase-specific escalation identity the interface promises", String(esc.escalate));
  check(esc.compensations.includes("write-pr-hold") && esc.compensations.includes("release-territory"),
    "but still holds the PR and releases the territory, so a founder who is away does not starve every overlapping task",
    JSON.stringify(esc));
  const pinned = nextPhase({ phase: "IMPLEMENTING", generation: 1, hasOpenPr: true, pinnedTerritory: true }, { kind: "phase.failed", retriesExhausted: true });
  check(!pinned.compensations.includes("release-territory"), "unless a live --pin-territory holds it");

  // A retry that has NOT exhausted its budget is not a transition at all.
  const retry = nextPhase({ phase: "RESEARCH", generation: 1 }, { kind: "phase.failed", retriesExhausted: false });
  check(!retry.ok, "control: a failed attempt with retries left does not transition; it is a new attempt");
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/hub-phases.test.mjs
```

Expected: module not found.

**On the broken implementation** — a `nextPhase` written as a `switch` on phase with a `default: return undefined` — the named-edge assertions mostly pass and the **totality** check reports every uncovered cell by name. That is why totality is asserted over the cross product rather than spot-checked: a hole does not throw, it returns `undefined`, the caller reads it as "no transition available", and the task sits in a state forever with nothing reporting it. The `control:` retry line guards the opposite error, a machine that transitions on every failure and never retries.

- [ ] **Step 3: Implement `src/build/phases.mjs`**

Write it as data plus a small resolver, not as nested conditionals: a table can be read against §3.1 line by line, and a `switch` cannot.

```js
// phases -- the transition matrix, and nothing else.
//
// Pure and total, and it imports nothing. No database, no clock, no
// filesystem, no randomness: the model reasons inside a phase worker, and this
// module decides what a phase change MEANS. Keeping it pure is what makes the
// matrix testable as a table rather than as a fixture ceremony.
//
// Total matters more than it looks. A machine with a hole does not fail at the
// hole -- it returns nothing, the caller reads that as "no transition", and the
// task sits in a state forever with nothing reporting it. Every (phase,
// evidence) pair therefore returns either a transition or a REASONED refusal,
// and `transition.refused` is logged: absence is never success.
export const ACTIVE = Object.freeze([
  "FILED","CLAIMING","SIZING","RESEARCH","DESIGN","SPEC_DRAFT","SPEC_PR_OPEN","GATE",
  "APPROVED","IMPLEMENTING","IMPL_PR_OPEN","VERDICT_WAIT","SLICE_MERGED","FINALIZING"]);
export const HELD     = Object.freeze(["BLOCKED","ESCALATED"]);
export const DRAINING = Object.freeze(["CANCELLING"]);
export const TERMINAL = Object.freeze(["DONE","CANCELLED","LOST","INFEASIBLE"]);
export const PHASES   = Object.freeze([...ACTIVE, ...HELD, ...DRAINING, ...TERMINAL]);

/**
 * "Any non-terminal" in section 3.1 means every state except the four
 * terminals AND except CANCELLING. CANCELLING is a source for nothing: it
 * exits only to CANCELLED. Spelling that out here rather than at each edge is
 * what stops one edge from quietly forgetting it.
 */
export const NON_TERMINAL = Object.freeze(PHASES.filter(p => !TERMINAL.includes(p) && p !== "CANCELLING"));

const WORKER_PHASES = Object.freeze(["SIZING","RESEARCH","DESIGN","SPEC_DRAFT","IMPLEMENTING"]);

// The linear spine. Read this against section 3.1's diagram directly.
const ADVANCE = {
  FILED: "SIZING", SIZING: "RESEARCH", RESEARCH: "DESIGN",
  DESIGN: "SPEC_DRAFT", SPEC_DRAFT: "SPEC_PR_OPEN", SPEC_PR_OPEN: "GATE",
  APPROVED: "IMPLEMENTING", IMPLEMENTING: "IMPL_PR_OPEN", IMPL_PR_OPEN: "VERDICT_WAIT",
};
// CLAIMING is deliberately absent from the spine: it leaves only on claim.won or
// claim.lost, both of which carry evidence a phase report does not have.
//
// It WAS in the map for several revisions while this comment said it was not.
// `phase.succeeded` consults ADVANCE[phase] as its fallback, so a bare
// `{kind:"phase.succeeded", phase:"CLAIMING"}` advanced straight to SIZING and
// never reached the claim.won branch -- defeating the very guard that refuses a
// claim without a ledger event id and a projection generation. A comment
// asserting an absence is not an absence; the matrix test below now asserts it.
// VERDICT_WAIT and FINALIZING are deliberately ABSENT from the spine.
//
// VERDICT_WAIT leaves only on the reconciler's `slice.merged` witness -- a real
// mergedAt read back from GitHub. On the spine, any misrouted phase completion
// would move a task to SLICE_MERGED with nothing merged, and the totality test
// feeds phase.succeeded to every phase, so it would have exercised exactly that.
//
// FINALIZING leaves only when every enqueued effect has settled (section 9.7:
// the ledger write-back, the completion comment, the PR close, the lease
// cleanup). A task that reached DONE with those outstanding would be terminal
// with externally visible work still in flight, and DONE has no edges out.

// A refusal may still carry state the caller must persist: a depth override that
// does not change the phase is still an accepted override, and discarding it
// would leave the promised redispatch with nothing new to dispatch under.
const refuse = (refusal, extra = {}) => ({ ok: false, refusal, ...extra });
// One identity per hold cause, section 11.7. The keys are exactly `pr_hold`'s
// CHECK set minus the two that never arrive as a `hold` (`cancel` is CANCELLING,
// `escalated` is the exhausted-retries edge), so the map is closed against the
// schema rather than against memory. `<id>` is substituted by applyTransition.
const HOLD_ESCALATION = Object.freeze({
  ownership_lost:      "bt:<id>:intake:ownership-lost",
  harness_touched:     "bt:<id>:impl:harness-touched",
  over_budget:         "bt:<id>:impl:over-budget",
  depth_post_approval: "bt:<id>:depth:post-approval",
  reopen:              "bt:<id>:spec:reopened",
  blocked_other:       null,          // supplied by the caller; see the hold branch
});

// The reason check has to run on BOTH hold paths, not only the one that
// transitions. An already-held task took the generic "already held" refusal
// first, and applyTransition's stacking branch then wrote `evidence.reason`
// straight into hold_reason's closed CHECK -- so an unknown reason THREW inside
// the transaction instead of returning a reasoned refusal, and a
// `blocked_other` with no escalation identity stacked a hold that reaches
// nobody. One validator, called from both.
const holdReasonRefusal = (evidence) => {
  if (!HOLD_ESCALATION.hasOwnProperty(evidence?.reason))
    return `unknown hold reason ${JSON.stringify(evidence?.reason)}; ` +
           `it must be one of ${Object.keys(HOLD_ESCALATION).join(", ")}`;
  // `blocked_other` is the catch-all the DDL gives a `detail` column for; the
  // caller that knows the cause supplies the identity.
  if (evidence.reason === "blocked_other" && (evidence.escalation ?? null) === null)
    return "a blocked_other hold must carry the escalation identity for its cause; " +
           "a hold with no identity reaches no founder";
  return null;
};

// The depths section 5 defines. Closed, so an override to a name nobody
// implements is refused rather than persisted and dispatched under.
const DEPTHS = Object.freeze(["trivial", "standard", "deep"]);

const go = (to, { generation, bumps = false, compensations = [], sliceCursor = null,
                  escalate = null, persistDepth = null }) =>
  ({ ok: true, to, generation, bumps, sliceCursor, escalate, persistDepth,
     compensations: Object.freeze(compensations) });

export function nextPhase(state, evidence) {
  const { phase, generation = 1, heldFrom = null, drainRemaining = 0,
          hasOpenPr = false, pinnedTerritory = false, sourceKind = "founder",
          hasLiveRun = false } = state ?? {};
  const kind = evidence?.kind;

  if (!PHASES.includes(phase)) return refuse(`unknown phase ${JSON.stringify(phase)}`);
  if (TERMINAL.includes(phase)) return refuse(`${phase} is terminal; no evidence moves it`);

  // CANCELLING first, because it is the one state whose answer to almost
  // everything is no, and reading that as a special case at each edge below is
  // how the exclusion gets forgotten.
  if (phase === "CANCELLING") {
    if (kind === "drain.settled")
      return drainRemaining > 0
        ? refuse(`${drainRemaining} row(s) still draining; CANCELLED is not legitimate until every one reconciles`)
        : go("CANCELLED", { generation, compensations: ["release-territory"] });
    if (kind === "founder.cancelForce") {
      // drainEligible is the caller's read; applyTransition re-derives it from
      // the CANCELLING entry timestamp inside the transaction before committing,
      // for the same reason FINALIZING re-counts its effects: this is a terminal
      // transition and the machine cannot see a clock.
      // `builder.cancel.drainMinutes` MUST be declared in `FIELDS`, in this task.
      // `src/profile/schema.mjs` is fail-closed on unknown keys (`unknown key:
      // ${p}` at src/profile/schema.mjs:352 on 16769e7), so an operator who sets
      // the one control this branch documents kills every `reeve run` at profile
      // load instead of tuning the drain window. Add:
      //
      //   "builder.cancel.drainMinutes": [false, v => (Number.isInteger(v) && v > 0
      //                                    ? null : "must be a positive integer")],
      //
      // with a DEFAULTS entry of 30 and "builder.cancel" added to the container
      // list at src/profile/schema.mjs:338 -- that list is separate from the
      // derived container set, and without the entry a profile carrying
      // `builder: { cancel: "oops" }` takes the defaults as named properties and
      // validates. Found by sweeping all three plans' `builder.*` reads against
      // the declared set; S2-C declares the three `builder.provider.*` keys the
      // same sweep found, so neither plan assumes the other did it.
      //
      // Section 3.5 permits --force only after builder.cancel.drainMinutes has
      // passed. Without that guard a founder can force a cancel one second in,
      // recording rows as `forced` whose reconcilers had not been tried even
      // once -- which is the one terminal transition whose external truth was
      // never confirmed, made available before anything was attempted.
      if (!evidence.drainEligible)
        return refuse("cancel --force is available only after builder.cancel.drainMinutes has passed; " +
                      "the drain has not yet had its window");
      // force-drain records what was NOT confirmed, rather than leaving the
      // projection claiming the effects are still unresolved while the task is
      // terminal. It sets task_drain.forced with the last reconciler attempt in
      // last_known, and moves the matching outbox rows to the hub-only status
      // `forced` so the executor stops recovering them under a CANCELLED task.
      // Section 3.5 requires exactly this: a forced cancel is the one terminal
      // transition whose external truth was never confirmed, so what was unknown
      // has to be written down.
      return go("CANCELLED", { generation, compensations: ["force-drain","release-territory"] });
    }
    return refuse(`CANCELLING exits only to CANCELLED; it is not a source for ${kind}`);
  }

  // Founder verbs available from every non-terminal state.
  if (kind === "founder.cancel")
    return go("CANCELLING", { generation,
      // record-drain LAST, as the compensation table requires: it snapshots what
      // is outstanding, so anything that ENQUEUES must run before it. Ahead of
      // close-prs it missed the close and comment effects the cancellation
      // itself had just created -- which is the whole set it exists to capture.
      compensations: ["void-pending","close-prs","release-territory",
                      // A ledger claim that already LANDED is not undone by
                      // draining: another actor must be able to take the node.
                      // Section 3.5 requires the compensating `ledger.release`,
                      // or the orphan sweep later finds a reeve-owned claim for
                      // a CANCELLED task. `--if-owner` makes it inert when a
                      // human already owns it, so it is safe whenever the claim
                      // may have landed or is still in flight.
                      ...(evidence.ledgerClaimLanded ? ["release-ledger-claim"] : []),
                      // A live phase worker keeps consuming provider capacity and
                      // writing to its worktree after the cancel commits.
                      // Section 4.5 terminates through the lease; this schedules
                      // it as a compensation so it is part of the same tx's
                      // effects rather than something the loop might forget.
                      "terminate-worker",
                      ...(hasOpenPr ? ["write-pr-hold"] : []), "record-drain"] });
  if (kind === "founder.infeasible") {
    // INFEASIBLE from IMPL_PR_OPEN or VERDICT_WAIT leaves an open builder PR
    // behind. Without a hold the guardian's verdict has nothing to read, the
    // required check stays green at the head, and a PR belonging to a task that
    // was declared infeasible remains mergeable until its close effect settles.
    // The hold is the part that does not depend on an effect settling.
    // INFEASIBLE is a success state, but never a quiet one: its entry raises
    // bt:<id>:infeasible so the founder reads WHY work stopped. A terminal state
    // with no durable explanation cannot be explained afterwards -- there are no
    // edges out and no later phase to record it.
    if (!evidence.reason || !String(evidence.reason).trim())
      return refuse("infeasible requires a reason; a terminal state with no explanation cannot be explained later");
    // A live worker keeps spending its budget and writing artifacts for a task
    // the founder has just declared infeasible. `--redesign` and `regenerate`
    // both terminate; this is the third path that abandons work in flight and it
    // was the only one that left the process running.
    return go("INFEASIBLE", { generation, escalate: `bt:<id>:infeasible`,
      compensations: [...(hasLiveRun ? ["terminate-worker"] : []),
                      "void-pending","close-prs","release-territory",
                      ...(hasOpenPr ? ["write-pr-hold"] : [])] });
  }

  // Held states: exactly one exit verb each, and a hold that arrives while
  // already held STACKS rather than transitioning -- a transition here would
  // rewrite held_from and lose where the task goes back to.
  if (HELD.includes(phase)) {
    if (kind === "hold") {
      // Validate FIRST. The refusal below is the one applyTransition turns into
      // a durable stacked write, so reaching it with an unvalidated reason hands
      // the closed CHECK a name it will throw on.
      const bad = holdReasonRefusal(evidence);
      if (bad) return refuse(bad);
      // `stackable` is what applyTransition keys the stacking branch on. It used
      // to re-derive that from (phase is HELD && kind === "hold"), which is true
      // of a REFUSED reason too -- so the branch that writes the hold row ran for
      // exactly the refusals that must not write one.
      return refuse(`${phase} is already held; stack a hold_reason and keep the original held_from`,
                    { stackable: true });
    }
    if (kind === "founder.resume") {
      // Entering a held state RELEASED the territory (section 3.4), so another
      // task may legitimately hold an overlapping path by now. Resume must
      // re-run the identical intersection check and take a fresh lease before
      // the task can work again -- otherwise two tasks edit the same paths
      // concurrently, which is the single thing territory exists to prevent.
      // The caller supplies the answer; the machine stays pure.
      // The machine stays pure, so the caller supplies the answer -- but
      // applyTransition RE-RUNS the intersection check inside its transaction
      // before granting the lease (see `regrant-territory`). Trusting a value
      // computed before BEGIN IMMEDIATE would let a filing that landed in
      // between hold both claims.
      if (evidence.territoryConflict)
        return refuse(`territory now conflicts with ${evidence.territoryConflict}; ` +
                      `resume is refused until the founder settles who owns it`);
      // Section 3.4 requires TWO preconditions on resume, not one. A task held
      // because ownership was lost is precisely the case where the second
      // matters: territory can be free while a human still owns the ledger node,
      // and resuming then puts reeve back to work on someone else's task.
      // AFFIRMATIVE, not negative-only. `if (evidence.ownerNotReeve)` refuses a
      // caller that checked and found a human, and admits a caller that never
      // checked at all -- and the second is the likelier bug, because omitting
      // an optional field is what a forgetful caller does. Section 2.5 requires
      // a FULL ledger sync before every `reeve task resume`, so the witness has
      // to be present, positive and fresh, and its absence is a refusal.
      //
      // Scoped by source kind: founder-filed tasks have no ledger owner, and
      // section 2.5 puts them out of scope explicitly rather than by omission.
      if (sourceKind === "ledger") {
        if (evidence.ownerNotReeve)
          return refuse(`the ledger still projects ${evidence.ownerNotReeve} as owner; ` +
                        `resume is refused until reeve's claim is re-established`);
        if (evidence.ownerIsReeve !== true || evidence.ownershipSyncedAt == null)
          return refuse("a ledger-sourced resume needs a full ledger sync showing reeve as owner; " +
                        "pass ownerIsReeve and ownershipSyncedAt from that sync, or the resume is " +
                        "restarting work on a claim nobody re-verified");
      } else if (evidence.ownerNotReeve) {
        // A founder-filed task carrying an owner is a caller error, not a
        // silently ignored field.
        return refuse(`a founder-filed task has no ledger owner; ` +
                      `${evidence.ownerNotReeve} cannot be projected for it`);
      }
      if (evidence.redesign)
        return go("DESIGN", { generation: generation + 1, bumps: true,
          compensations: ["clear-holds","annotate-resumed","regrant-territory", ...(hasOpenPr ? ["close-prs"] : [])] });
      if (!heldFrom) return refuse(`${phase} has no held_from recorded; resume cannot know where to re-enter`);
      return go(heldFrom, { generation, compensations: ["clear-holds","annotate-resumed","regrant-territory"] });
    }
    return refuse(`${phase} is held; its only exit is reeve task resume`);
  }

  // A hold from any active state. record-hold-reason is here because ONLY the
  // already-held branch in applyTransition inserted one: the first hold on a
  // task recorded no reason at all, so `task resume` listed the stacked reasons
  // and silently dropped the original.
  // A live --pin-territory survives BLOCKED exactly as it survives ESCALATED:
  // section 10.2 makes the exception apply to BOTH held states. Releasing a
  // pinned lease here lets an overlapping filing take territory the founder
  // explicitly reserved, and `resume` then refuses naming a blocker the founder
  // created by pinning.
  if (kind === "hold") {
    // Every hold cause has a founder-visible identity in section 11.7, and this
    // branch raised none of them: a worker-reported block, an over-budget slice,
    // a touched harness and a lost ledger claim all entered BLOCKED silently.
    // BLOCKED has no automatic exit, so an unannounced hold is a task that stops
    // and waits for a founder who was never told.
    //
    // The reasons are pr_hold's closed CHECK set (S2-A migration 1), so this map
    // is closed too, and a reason outside it is a refusal rather than a hold
    // with no name.
    // The same validator the already-held path calls, so the two cannot drift.
    const badReason = holdReasonRefusal(evidence);
    if (badReason) return refuse(badReason);
    const escalate = evidence.reason === "blocked_other"
      ? evidence.escalation
      : HOLD_ESCALATION[evidence.reason];
    return go("BLOCKED", { generation, escalate,
      // A live worker keeps spending its budget and writing its worktree under
      // a task that has just stopped. Cancel, regenerate and infeasible all
      // terminate for exactly this; entering a held state was the remaining
      // path that abandoned work in flight and left the process running.
      compensations: [...(hasLiveRun ? ["terminate-worker"] : []),
                      "record-hold-reason","void-pending",
                      ...(pinnedTerritory ? [] : ["release-territory"]),
                      ...(hasOpenPr ? ["write-pr-hold"] : [])] });
  }

  // A worker phase whose bounded retries are exhausted. ESCALATED voids
  // NOTHING -- the phase merely stopped and its effects stand -- but it does
  // release the territory, because a provider failure waiting on a founder
  // must not starve every overlapping task for as long as the founder is away.
  if (kind === "phase.failed") {
    if (!evidence.retriesExhausted) return refuse("retries remain; this is a new attempt, not a transition");
    if (!WORKER_PHASES.includes(phase)) return refuse(`${phase} is not a worker phase; it has no attempt budget`);
    // The escalation identity is minted HERE, where the phase is known. The
    // interface promises `bt:<id>:phase:failed:<phase>` for this transition, and
    // without it the task stops with no durable founder notification -- a worker
    // that ran out of attempts and a worker that is still trying look identical
    // from outside. `<id>` stays a placeholder because applyTransition
    // substitutes the task id; `<phase>` cannot, because only the machine knows it.
    return go("ESCALATED", { generation, escalate: `bt:<id>:phase:failed:${phase}`,
      compensations: [...(hasOpenPr ? ["write-pr-hold"] : []), ...(pinnedTerritory ? [] : ["release-territory"])] });
  }

  // LOST voids like every other terminal path. A task that lost the claim race
  // has pending effects enqueued during CLAIMING; leaving them pending means the
  // executor performs them for a task that never owned the work -- the ledger
  // claim being the one that matters, since another actor now holds it.
  // CLAIMING leaves on a claim-specific witness, never the generic spine. The
  // claim's proof is durable provenance -- the ledger event id and the
  // projection generation the claim was made against (section 2.1) -- and a
  // generic phase.succeeded carries neither, so a misrouted report would move a
  // task into SIZING with no record of what it claimed or against which
  // projection. applyTransition persists both from this evidence.
  if (phase === "CLAIMING" && kind === "claim.won") {
    if (!evidence.claimEventId || evidence.projectionGeneration == null)
      return refuse("claim.won without a ledger event id and projection generation is not a claim witness");
    return go("SIZING", { generation });
  }
  if (phase === "CLAIMING" && kind === "claim.lost")
    return go("LOST", { generation, compensations: ["void-pending","release-territory"] });

  if (phase === "GATE") {
    if (kind === "gate.approved")    return go("APPROVED", { generation });
    if (kind === "gate.revise")      return go("SPEC_DRAFT", { generation });
    // A task at the revision cap necessarily has an open SPEC PR -- that is what
    // the rounds were spent on -- so this edge holds it like every other path
    // into a held state. Omitting it made GATE the one escalation that left its
    // PR unheld.
    // The cap is a founder-held stop, and section 11.7 names the identity for it.
    // Without the escalation the task simply goes quiet in ESCALATED: fail-closed
    // must never mean fail-quiet.
    if (kind === "gate.capReached")  return go("ESCALATED", { generation,
      escalate: `bt:<id>:gate:revision-loop`,
      compensations: ["write-pr-hold", ...(pinnedTerritory ? [] : ["release-territory"])] });
    // depth.override from GATE is handled by the shared block below, so the two
    // cannot drift apart.
  }

  // A depth override before APPROVED re-dispatches; after APPROVED it holds, and
  // the founder's choice of resume or resume --redesign decides.
  //
  // "Re-dispatches" means the phase runs AGAIN under the new depth, not that the
  // task jumps forward. Section 5: before APPROVED nothing is bound yet, and the
  // override changes that phase's budget and fan-out. Sending SIZING straight to
  // DESIGN would skip sizing that never finished under the new depth; sending
  // RESEARCH there would discard the research the new depth just asked for.
  // Only the phases whose OUTPUT is already written go back to DESIGN, which is
  // exactly the three edges section 3.1 draws (SPEC_DRAFT, SPEC_PR_OPEN, GATE).
  // Every accepted override PERSISTS: applyTransition writes task.depth and
  // appends `sizing.overridden` from evidence.depth, including on the refusal
  // paths below -- a refusal here means "the phase does not change", not "the
  // override is discarded". Without that the SIZING/RESEARCH/DESIGN branch
  // promises a redispatch under a new depth and records no new depth to
  // dispatch under.
  if (kind === "depth.override") {
    // `persistDepth` travels on BOTH shapes. The prose above promised every
    // accepted override writes task.depth, and only the refusal shape carried
    // the field -- which applyTransition's refusal branch then ignored, and the
    // DESIGN branch never carried at all. So no accepted override persisted
    // anything, and the SIZING/RESEARCH/DESIGN branch promised a redispatch
    // under a depth nothing had recorded.
    if (!DEPTHS.includes(evidence.depth))
      return refuse(`unknown depth ${JSON.stringify(evidence.depth)}; it must be one of ${DEPTHS.join(", ")}`);
    if (WORKER_PHASES.includes(phase) && ["SIZING","RESEARCH","DESIGN"].includes(phase))
      return refuse(`${phase} re-dispatches under the new depth as a new attempt; the phase does not change`,
                    { persistDepth: evidence.depth,
                      // The re-dispatch is a NEW attempt, so the old one has to
                      // end. This branch is the awkward one: it refuses the
                      // transition, so it cannot use `go`'s compensations -- and
                      // without them the previous worker kept running under the
                      // old depth's budget and fan-out while the new attempt was
                      // dispatched beside it, which is the one outcome an
                      // override must not produce. `compensations` therefore
                      // travels on the refusal shape, exactly as `persistDepth`
                      // already does and for the same reason: a refusal can
                      // carry a durable consequence.
                      compensations: hasLiveRun ? ["terminate-worker"] : [] });
    if (["SPEC_DRAFT","SPEC_PR_OPEN","GATE"].includes(phase))
      return go("DESIGN", { generation, persistDepth: evidence.depth,
        // The running worker is mid-flight under the OLD depth's budget and
        // fan-out, and the new depth is the whole point of the override. Left
        // alone it keeps spending and keeps writing its artifact, and the
        // re-dispatch that follows either races it or never happens.
        compensations: hasLiveRun ? ["terminate-worker"] : [] });
    // Post-approval: holds, and records WHY like every other hold. Without
    // record-hold-reason this was the one BLOCKED entry with no reason, so
    // `task resume` would list nothing and the founder would see a held task
    // with no explanation.
    //
    // The pin exception applies HERE too. This branch had an unconditional
    // `release-territory` while the generic hold path honours `pinnedTerritory`,
    // so a post-approval override handed away territory the founder had
    // explicitly pinned -- and the resume that follows then conflicts with
    // whatever took it.
    return go("BLOCKED", { generation, escalate: `bt:<id>:depth:post-approval`,
      persistDepth: evidence.depth,
      // A live worker keeps spending its budget and writing its worktree under
      // a task that has just stopped. Cancel, regenerate and infeasible all
      // terminate for exactly this; entering a held state was the remaining
      // path that abandoned work in flight and left the process running.
      compensations: [...(hasLiveRun ? ["terminate-worker"] : []),
                      "record-hold-reason","void-pending",
                      ...(pinnedTerritory ? [] : ["release-territory"]),
                      ...(hasOpenPr ? ["write-pr-hold"] : [])] });
  }

  // SLICE_MERGED must exit, or a task that merged its first slice sits there
  // forever and the totality test cannot see it: "refused" is a legal answer, so
  // a state whose every edge refuses looks total and is a dead end.
  // Which way it goes is not the machine's guess -- the loop supplies
  // `moreSlices` from the durable slice cursor and DESIGN's slice list.
  if (phase === "SLICE_MERGED") {
    if (kind === "slice.next")
      return evidence.moreSlices
        // The cursor is durable and nothing else writes it (a repo-wide search
        // finds no other writer), so a transition back to IMPLEMENTING that
        // leaves it alone re-runs the slice that just merged -- reopening or
        // reconciling a PR that is already in.
        ? go("IMPLEMENTING", { generation, sliceCursor: sliceCursor + 1 })
        : go("FINALIZING", { generation });
    if (kind === "slice.merged")
      return refuse("SLICE_MERGED is entered BY slice.merged; advancing needs slice.next");
  }

  // `reeve task regenerate` (§4.7): the founder deliberately adopts a changed
  // contract. It bumps the generation, and re-enters at SPEC_DRAFT if the task
  // is past GATE (the spec is re-rendered under the new contract and goes
  // through the full gate again as a new head) or at the current phase
  // otherwise. Absent from the machine entirely until now, so the CLI verb
  // §11.6 lists had no transition to make.
  if (kind === "founder.regenerate") {
    if (TERMINAL.includes(phase)) return refuse(`${phase} is terminal; regenerate cannot re-open it`);
    const PAST_GATE = ["APPROVED","IMPLEMENTING","IMPL_PR_OPEN","VERDICT_WAIT","SLICE_MERGED","FINALIZING"];
    // regenerate exists to ADOPT a changed contract, so the new snapshot has to
    // be written; bumping the generation without it re-runs the phase under the
    // contract the founder just replaced, which is the opposite of the command's
    // purpose. applyTransition writes the resolved snapshot columns in the same
    // transaction (`adopt-snapshot`) from the values the caller resolved before
    // the transaction opened -- network first, transaction second, as at filing.
    // An open implementation PR from the OLD generation is now bound to a
    // contract nobody approved: the spec it was built from is about to be
    // re-rendered and re-gated. It has to be held and closed like every other
    // path that abandons work, or it stays mergeable against a superseded plan.
    // `adopt-snapshot` writes the contract columns onto the task from
    // evidence.snapshot. A bare {kind:"founder.regenerate"} bumped the
    // generation and then either threw inside applyCompensation or adopted
    // undefined into profile_hash, registry_version, gate_definition_hash,
    // default_branch and visibility -- a task whose contract is null, at a
    // generation that says it was deliberately re-resolved.
    //
    // Every field is required, and named, because a partial snapshot is the
    // failure that looks like success: the columns it does carry are correct.
    // The COMPLETE section 1.5 admission snapshot, not the five columns
    // `adopt-snapshot` happened to write. A regenerate that re-resolves the
    // registry and adopts only half of it leaves ONE task carrying a hybrid
    // contract -- new profile hash, old repository path -- at a generation that
    // asserts the whole thing was deliberately re-resolved. `founder_user_id` is
    // in the list because comment-based depth overrides are authorised against
    // that immutable identity (section 5), so a task without it cannot
    // authenticate the very evidence this branch exists to handle.
    const SNAPSHOT_FIELDS = ["repoId", "nwo", "repoPath", "profilePath", "profileHash",
                             "defaultBranch", "visibility", "specRepoId",
                             "gateDefinitionHash", "registryVersion", "founderUserId"];
    const missing = SNAPSHOT_FIELDS.filter(f => evidence.snapshot?.[f] == null);
    if (missing.length)
      return refuse(`regenerate needs a resolved registry snapshot; missing ${missing.join(", ")}. ` +
                    `Resolve it before the transaction, as section 2.2 requires`);
    // A live worker is still writing under the OLD contract. Regenerate adopts a
    // new snapshot and bumps the generation, so a process left running produces
    // artifacts attributed to a contract that no longer exists -- and its report,
    // when it lands, is fenced and discarded, which looks like the worker
    // failed. `--redesign` already terminates for exactly this reason; regenerate
    // had the same exposure and none of the handling.
    return go(PAST_GATE.includes(phase) ? "SPEC_DRAFT" : phase,
      { generation: generation + 1, bumps: true,
        compensations: [...(hasLiveRun ? ["terminate-worker"] : []),
                        "adopt-snapshot","annotate-resumed",
                        ...(hasOpenPr ? ["write-pr-hold","close-prs"] : [])] });
  }

  if (kind === "phase.succeeded") {
    // The report must be FOR this phase. Without the check a delayed or
    // misrouted RESEARCH report advances a task that has already moved to
    // DESIGN, and the generation fence does not catch it: a stale report from
    // the same generation is exactly what an adopted worker produces after a
    // restart.
    // The report must NAME its phase, and it must be this one. Guarding only the
    // mismatch lets a malformed or misrouted bare {kind:"phase.succeeded"}
    // advance whatever the task currently occupies -- bypassing the
    // report-to-source binding exactly as effectively as naming the wrong phase.
    if (!evidence.phase)
      return refuse("a phase report must name the phase it came from; an unattributed success advances nothing");
    if (evidence.phase !== phase)
      return refuse(`a ${evidence.phase} report cannot advance a task in ${phase}`);
    if (phase === "SIZING" && evidence.depth === "trivial")
      // The skip has to be EMITTED, not described. A plain transition to DESIGN
      // leaves no durable explanation for the absent research artifact, and the
      // gap is indistinguishable from a research phase that was lost -- which is
      // the reading that matters months later, when someone asks why this task
      // has no research to show.
      return go("DESIGN", { generation, compensations: ["record-research-skip"] });
    if (phase === "VERDICT_WAIT")
      return refuse("VERDICT_WAIT advances only on the reconciler's slice.merged witness, never on a phase report");
    if (phase === "FINALIZING")
      return refuse("FINALIZING advances only on finalize.settled, once every enqueued effect has reconciled");
    const to = ADVANCE[phase];
    return to ? go(to, { generation }) : refuse(`${phase} has no successor on phase.succeeded`);
  }

  // The witness must be the RECONCILER's, not any caller's say-so. section 8.6
  // makes mergedAt the evidence, so the edge requires it: without the check this
  // branch accepts a bare slice.merged and the refusal added to the
  // phase.succeeded path above is trivially routed around.
  if (phase === "VERDICT_WAIT" && kind === "slice.merged") {
    if (!evidence.mergedSha || !evidence.mergedAt)
      return refuse("slice.merged without the reconciler's mergedAt and merged sha is not a merge witness");
    return go("SLICE_MERGED", { generation });
  }

  // FINALIZING is reeve code, not a worker phase: no claude session runs. It
  // exits when the loop reports every effect settled, and not before.
  if (phase === "FINALIZING" && kind === "finalize.settled")
    return evidence.outstanding === 0
      ? go("DONE", { generation, compensations: ["release-territory"] })
      : refuse(`${evidence.outstanding} finalization effect(s) still unsettled; DONE is terminal and has no way back`);

  return refuse(`no edge from ${phase} on ${kind ?? "no evidence"}`);
}
```

- [ ] **Step 4: Assert the machine and the DDL share one enumeration**

Append to `test/hub-crosscheck.test.mjs`:

```js
// The DDL's CHECK and the machine's domain must be the same set. A state the
// machine emits and the database refuses is a transition that throws at commit
// time, in production, on the one path that must not throw.
{
  const { PHASES } = await import("../src/build/phases.mjs");
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../src/build/hub.sql", import.meta.url), "utf8");
  const block = sql.slice(sql.indexOf("phase          TEXT    NOT NULL CHECK"));
  const fromDdl = (block.slice(0, block.indexOf("))")).match(/'([A-Z_]+)'/g) ?? []).map(s => s.slice(1, -1));
  check(JSON.stringify([...fromDdl].sort()) === JSON.stringify([...PHASES].sort()),
    "the task.phase CHECK and phases.mjs PHASES are the same set",
    `ddl-only: ${fromDdl.filter(p => !PHASES.includes(p))}\n        machine-only: ${PHASES.filter(p => !fromDdl.includes(p))}`);
}
```

- [ ] **Step 5: Run and commit**

```bash
$N test/hub-phases.test.mjs && $N test/hub-crosscheck.test.mjs
git add src/build/phases.mjs test/hub-phases.test.mjs test/hub-crosscheck.test.mjs
git commit -m "feat(hub): the pure, total phase machine"
```

---
### Task 15: The one transition transaction — generation-fenced CAS and its compensations

**Files:**
- Create: `src/build/transition.mjs`
- **Modify: `src/build/replay.mjs`** — every `hub_event` kind this plan introduces needs a `HANDLERS` entry and, where it belongs in the projection, a `COMPARISON_SET` line. The kinds this task adds, and where each one goes:

| kind | destination |
|---|---|
| `task.transitioned` | `HANDLERS` → `task` |
| `phase_event.appended` | `HANDLERS` → `phase_event` |
| `hold_reason.appended` | `HANDLERS` → `hold_reason` |
| `pr_hold.created`, `pr_hold.cleared` | `HANDLERS` → `pr_hold` |
| `task_drain.recorded`, `task_drain.settled` | `HANDLERS` → `task_drain` |
| `task_territory.claimed` | `HANDLERS` → `task_territory` |
| `sizing.overridden` | `HANDLERS` → `task` (a partial row image; the upsert sets `depth`) |
| `transition.refused` | **`NON_REPLAYED_KINDS`** — a record that nothing happened, with no row to project |
| `escalation.raised` | **`NON_REPLAYED_KINDS`** — re-derived by the next evaluation of the same condition |
| `research.skipped` | **`NON_REPLAYED_KINDS`** — history for an artifact that was never produced |

The last three were the gap: `applyTransition` emits `transition.refused` and
`escalation.raised`, and the compensation table emits `research.skipped`, and all
three previously appeared in neither map — so replay would have skipped them in
silence, indistinguishable from a misspelled kind. S2-A now carries
`NON_REPLAYED_KINDS` and a cross-check that scans these modules for emitted kinds
and requires every one to be in exactly one of the two sets. It fails loudly on a
kind that is in neither, which is the intended feedback — but the plan has to
name the file, or an executor writes the emitters and never opens the reader.
- Test: `test/hub-transition.test.mjs`

**Interfaces:**
- Consumes: `nextPhase`, `PHASES` (Task 14); `hubTx`, `hubEvent` (Tasks 1, 6).
- Produces: `applyTransition(db, { taskId, expectedPhase, expectedGeneration, evidence, artifactSha, op, effects = [], now }) -> { applied, to, generation, seq, reason }`.
  - `applied: false, reason: 'lost-race'` when the CAS changes zero rows. **A no-op, never an error.**
  - `applied: false, reason: 'refused', refusal` when `nextPhase` refuses.
  - `applied: false, reason: 'stacked'` when a hold arrives on an already-held task, after appending `hold_reason` and updating the open `pr_hold`'s reason.
  - On success: `phase_event.seq` is returned, and it is the **fence** every effect enqueued in this transaction carries.

- [ ] **Step 1: Write the failing test**

```js
// Every transition is exactly one BEGIN IMMEDIATE that CAS-updates the
// projection, appends its phase_event and hub_event, records the artifact sha
// that justified it, and enqueues side effects rather than performing them.
//
// The CAS predicate includes the GENERATION, not just the phase. Without it a
// stale attempt from generation 3 can act on a task that a --redesign moved
// into generation 4: the phase would still match, the update would succeed, and
// the task would be advanced by work done under a contract nobody approved.
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { applyTransition } from "../src/build/transition.mjs";
/* ... standard harness, plus seed ... */

// ── the ordinary case ────────────────────────────────────────────────────────
{
  const db = openHub(join(dir, "t1.db")); seed(db, { id: "bt:1", phase: "RESEARCH", generation: 2 });
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "RESEARCH", expectedGeneration: 2,
    evidence: { kind: "phase.succeeded", phase: "RESEARCH" }, artifactSha: "sha-research", op: "phase.advanced" });
  check(r.applied === true && r.to === "DESIGN", "a legal transition advances the task", JSON.stringify(r));
  check(db.prepare("SELECT phase FROM task WHERE id='bt:1'").get().phase === "DESIGN", "and the projection moved");
  const ev = db.prepare("SELECT * FROM phase_event WHERE task='bt:1' ORDER BY seq DESC LIMIT 1").get();
  check(ev.from_phase === "RESEARCH" && ev.to_phase === "DESIGN" && ev.from_generation === 2 && ev.to_generation === 2,
    "the phase_event records both phases and both generations", JSON.stringify(ev));
  check(ev.artifact_sha === "sha-research", "and the artifact sha that justified it", String(ev.artifact_sha));
  check(r.seq === ev.seq, "and its seq is returned as the fence for this transition's effects");
  // TWO row images now: task.transitioned and phase_event.appended. The
  // assertion said one and the implementation emits both, so it contradicted the
  // plan it appears in.
  const kinds = db.prepare("SELECT kind FROM hub_event WHERE task='bt:1' ORDER BY seq").all().map(r => r.kind);
  // Order matches the implementation: phase_event.appended is emitted at the
  // insert, task.transitioned after the projection is read back. The reversed
  // expectation would have failed against correct code -- the worst kind of
  // failing test, because it argues for changing the implementation.
  check(JSON.stringify(kinds) === '["phase_event.appended","task.transitioned"]',
    "the transition appends BOTH row images in the same transaction, in emit order", kinds.join(","));
  db.close();
}

// ── the lost race is a NO-OP, not an error ───────────────────────────────────
{
  const db = openHub(join(dir, "t2.db")); seed(db, { id: "bt:1", phase: "DESIGN", generation: 2 });
  // Captured HERE, from THIS database, immediately before the stale call. `seed`
  // mints a run of phase_event rows, so the count is not zero, and reading a
  // baseline declared in another block would be both out of scope and about a
  // different file.
  const eventsBefore = db.prepare("SELECT count(*) c FROM phase_event").get().c;
  let threw = null;
  let r; try {
    r = applyTransition(db, { taskId: "bt:1", expectedPhase: "RESEARCH", expectedGeneration: 2,
      evidence: { kind: "phase.succeeded", phase: "RESEARCH" }, artifactSha: "x", op: "phase.advanced" });
  } catch (e) { threw = e.message; }
  check(threw === null, "a concurrent actor winning the race does not throw", String(threw));
  check(r?.applied === false && r.reason === "lost-race", "it is reported as a lost race", JSON.stringify(r));
  // The baseline belongs to THIS block and THIS database. It was previously read
  // from a `const` declared inside the preceding block -- out of scope here, and
  // counting a different file besides -- so the assertion below reached a
  // ReferenceError instead of checking anything.
  check(db.prepare("SELECT phase FROM task WHERE id='bt:1'").get().phase === "DESIGN", "the projection is untouched");
  // A DELTA, not an absolute count: `seed` mints a run of phase_event rows so
  // that outbox fences have events to reference, and an assertion written as
  // `=== 0` reads those and fails against a correct implementation. Measuring
  // the change is also the right shape regardless of what the fixture seeds --
  // the claim is "this call appended nothing", not "the table is empty".
  check(db.prepare("SELECT count(*) c FROM phase_event").get().c === eventsBefore,
    "and no event is appended for work that did not happen",
    `${eventsBefore} -> ${db.prepare("SELECT count(*) c FROM phase_event").get().c}`);
  db.close();
}

// ── the generation fence ─────────────────────────────────────────────────────
// THE assertion of this task. A phase-only CAS passes every test above.
{
  const db = openHub(join(dir, "t3.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 4 });
  const stale = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 3,
    evidence: { kind: "phase.succeeded", phase: "IMPLEMENTING" }, artifactSha: "x", op: "phase.advanced" });
  check(stale.applied === false && stale.reason === "lost-race",
    "an attempt from generation 3 cannot act on a task now in generation 4", JSON.stringify(stale));
  check(db.prepare("SELECT phase FROM task WHERE id='bt:1'").get().phase === "IMPLEMENTING", "the redesigned task did not move");

  const current = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 4,
    evidence: { kind: "phase.succeeded", phase: "IMPLEMENTING" }, artifactSha: "x", op: "phase.advanced" });
  check(current.applied === true, "control: the SAME call at generation 4 succeeds, so the predicate is the generation and not a blanket refusal");
  db.close();
}

// ── compensations on the way into a hold ─────────────────────────────────────
{
  const db = openHub(join(dir, "t4.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,created_at) VALUES('bt:1',1,0,1,7,unixepoch())`);
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at) VALUES('p','prefix','packages/x','bt:1',unixepoch()+120)`);
  db.exec(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,cancellable,args,created_at,updated_at)
           VALUES('k1','gh.pr.comment','bt:1',1,1,1,'{}',unixepoch(),unixepoch())`);
  db.exec(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,cancellable,args,created_at,updated_at)
           VALUES('k2','git.push.branch','bt:1',1,1,0,'{}',unixepoch(),unixepoch())`);

  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
    evidence: { kind: "hold", reason: "over_budget" }, op: "task.blocked" });
  check(r.applied && r.to === "BLOCKED", "an over-budget slice blocks", JSON.stringify(r));
  check(db.prepare("SELECT status FROM outbox WHERE idempotency_key='k1'").get().status === "voided",
    "the pending CANCELLABLE row is voided");
  check(db.prepare("SELECT status FROM outbox WHERE idempotency_key='k2'").get().status === "pending",
    "and a NON-cancellable row is left alone: voiding a push mid-transport is not a compensation");
  check(db.prepare("SELECT count(*) c FROM pr_hold WHERE task='bt:1' AND cleared_at IS NULL").get().c === 1,
    "one pr_hold row is written for the open builder PR");
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task='bt:1'").get().c === 0,
    "and the territory lease is released in the same transaction");
  check(db.prepare("SELECT held_from FROM task WHERE id='bt:1'").get().held_from === "IMPLEMENTING",
    "held_from records where resume goes back to");

  // A second hold must STACK, not transition and not write a second open hold.
  const again = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "hold", reason: "ownership_lost" }, op: "task.blocked" });
  check(again.applied === false && again.reason === "stacked", "a hold on an already-held task stacks", JSON.stringify(again));
  check(db.prepare("SELECT count(*) c FROM pr_hold WHERE repo_id=1 AND pr=7 AND cleared_at IS NULL").get().c === 1,
    "and there is still exactly ONE open hold, so one_open_hold stays satisfiable");
  check(db.prepare("SELECT reason FROM pr_hold WHERE repo_id=1 AND pr=7 AND cleared_at IS NULL").get().reason === "ownership_lost",
    "the existing hold's reason is updated to the newest one");
  check(db.prepare("SELECT count(*) c FROM hold_reason WHERE task='bt:1' AND cleared_at IS NULL").get().c === 2,
    "and both reasons are listed, so resume can clear them all");
  check(db.prepare("SELECT held_from FROM task WHERE id='bt:1'").get().held_from === "IMPLEMENTING",
    "held_from is NOT rewritten by the second hold");
  db.close();
}

// ── resume clears every hold in one transaction ──────────────────────────────
{
  // Executable setup, not a prose comment. The block previously opened with
  // `/* seed a BLOCKED task ... */` and then used `db`, which the standard
  // harness does not supply -- so the file stopped at `ReferenceError: db is not
  // defined` before exercising any resume compensation.
  const db = openHub(join(dir, "t7.db"));
  seed(db, { id: "bt:1", phase: "BLOCKED", generation: 1 });
  db.exec(`UPDATE task SET held_from='IMPLEMENTING' WHERE id='bt:1'`);
  for (const reason of ["over_budget", "ownership_lost"])
    db.prepare(`INSERT INTO hold_reason(task,reason,at) VALUES('bt:1',?,unixepoch())`).run(reason);
  db.prepare(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at)
              VALUES('bt:1',1,7,?,'blocked_other',unixepoch())`).run("a".repeat(40));
  // The lease's task must EXIST -- territory_lease references task(id) and
  // openHub enables foreign keys, so a lease owned by an unseeded `bt:0` fails
  // at setup and the block never reaches regrant-territory at all.
  seed(db, { id: "bt:0", phase: "CANCELLED", generation: 1 });
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at)
           VALUES('p','prefix','packages/x','bt:0',unixepoch()-1)`);   // expired: regrant must succeed
  check(db.prepare("SELECT count(*) c FROM hold_reason WHERE cleared_at IS NULL").get().c === 2,
    "fixture: the task is BLOCKED with two open hold reasons and one open pr_hold");

  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "founder.resume", redesign: false }, op: "task.resumed" });
  check(r.applied && r.to === "IMPLEMENTING" && r.generation === 1,
    "a plain resume re-enters held_from with the generation unchanged", JSON.stringify(r));
  check(db.prepare("SELECT count(*) c FROM pr_hold WHERE cleared_at IS NULL").get().c === 0, "and clears the pr_hold");
  check(db.prepare("SELECT count(*) c FROM hold_reason WHERE cleared_at IS NULL").get().c === 0, "and every stacked reason");
  check(db.prepare("SELECT resume_seq FROM task WHERE id='bt:1'").get().resume_seq === 1,
    "and increments resume_seq, so a re-minted spec round gets a distinct idempotency key");
  db.close();
}

// ── the force-cancel drain window, either side of the boundary ───────────────
// The clock and the threshold arrive through the interface: this module has no
// clock, and the hub does not store the profile. Both boundaries are exercised,
// because a comparison written `>` instead of `>=` passes any test that only
// probes one side of it.
{
  const db = openHub(join(dir, "t5.db"));
  seed(db, { id: "bt:1", phase: "CANCELLING", generation: 1 });
  const ENTERED = 1_800_000_000, MINUTES = 30;
  db.prepare(`INSERT INTO phase_event(seq,task,at,op,from_phase,to_phase,detail)
              VALUES(100,'bt:1',?,'task.cancelling','IMPLEMENTING','CANCELLING','{}')`).run(ENTERED);
  const force = (now) => applyTransition(db, { taskId: "bt:1", expectedPhase: "CANCELLING", expectedGeneration: 1,
    evidence: { kind: "founder.cancelForce", drainEligible: true }, op: "task.cancelled",
    now, drainMinutes: MINUTES });

  const early = force(ENTERED + MINUTES * 60 - 1);
  check(early.applied === false && /29m of its 30m/.test(early.refusal ?? ""),
    "one second short of the window, --force is refused and says how far in it is", JSON.stringify(early));
  const onTime = force(ENTERED + MINUTES * 60);
  check(onTime.applied === true && onTime.to === "CANCELLED",
    "and exactly at the window it is allowed: the boundary is inclusive", JSON.stringify(onTime));

  // A caller that supplies no threshold is refused rather than defaulted. An
  // invented window is the one thing this guard exists to prevent.
  const db2 = openHub(join(dir, "t6.db"));
  seed(db2, { id: "bt:1", phase: "CANCELLING", generation: 1 });
  db2.prepare(`INSERT INTO phase_event(seq,task,at,op,from_phase,to_phase,detail)
               VALUES(100,'bt:1',?,'task.cancelling','IMPLEMENTING','CANCELLING','{}')`).run(ENTERED);
  const noThreshold = applyTransition(db2, { taskId: "bt:1", expectedPhase: "CANCELLING", expectedGeneration: 1,
    evidence: { kind: "founder.cancelForce", drainEligible: true }, op: "task.cancelled",
    now: ENTERED + 86400 });
  check(noThreshold.applied === false && /drainMinutes/.test(noThreshold.refusal ?? ""),
    "a --force with no configured threshold is refused, not defaulted", JSON.stringify(noThreshold));
  db.close(); db2.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

**On the broken implementation** — a CAS written `WHERE id=:task AND phase=:expected`, dropping the generation — every assertion in this file passes except one: `an attempt from generation 3 cannot act on a task now in generation 4`. Its paired `control:` line is what proves the fix is a fence and not a blanket refusal. This pair is the reason the generation block exists as its own section rather than being folded into the lost-race case.

- [ ] **Step 3: Implement `src/build/transition.mjs`**

```js
// transition -- the one shape every phase change takes.
//
// Exactly one BEGIN IMMEDIATE that: CAS-updates the projection, appends the
// phase_event and the hub_event, records the artifact sha that justified it,
// and ENQUEUES side effects rather than performing them. Nothing here talks to
// the network; an effect that reaches the outside world does so from the outbox
// executor, after its fence revalidates.
//
// The CAS predicate carries the generation as well as the phase. A phase-only
// predicate lets a stale attempt from generation 3 act on a task that a
// --redesign moved into generation 4 -- same phase, successful update, task
// advanced by work done under a contract nobody approved.
//
// Zero rows changed means a concurrent actor won. That is a no-op and not an
// error: the loop is allowed to race with itself and with a founder command,
// and turning every race into a thrown exception makes the caller invent a
// recovery for something that needs none.
// Every binding this module reaches for. `isSameProcess` is evaluated as a
// DEFAULT ARGUMENT, so an undeclared one throws on the very first ordinary call
// -- before hubTx, before anything -- and `assertWritable` is called on the
// first line inside the transaction.
import { hubTx, hubEvent } from "./hubdb.mjs";
import { nextPhase, HELD } from "./phases.mjs";   // HELD is still read by the
                                                  // CAS below, at held_from and
                                                  // blocked_reason
import { assertWritable } from "./locks.mjs";
import { isSameProcess } from "../supervisor.mjs";       // build/ is one level down
import { enqueueEffect } from "./outbox.mjs";

export function applyTransition(db, { taskId, expectedPhase, expectedGeneration, evidence,
                                      artifactSha = null, op, effects = [], slice = null,
                                      now = null, drainMinutes = null,
                                      isAlive = isSameProcess }) {
  // One writer for both shapes, so the refusal path and the success path cannot
  // drift. `sizing.overridden` is the durable record of WHO changed the depth and
  // to what -- without it `task why` shows a task dispatched under a depth
  // nothing explains.
  //
  // Declared at MODULE scope, above the transaction. As a `const` inside hubTx
  // it sat in the temporal dead zone when the refusal branch called it, so an
  // accepted SIZING/RESEARCH/DESIGN override threw
  // `Cannot access 'persistDepth' before initialization` -- the one path that
  // needed it most.
  const persistDepth = (db, taskId, depth) => {
    db.prepare("UPDATE task SET depth=?, updated_at=unixepoch() WHERE id=?").run(depth, taskId);
    hubEvent(db, { kind: "sizing.overridden", task: taskId,
      payload: db.prepare("SELECT id, depth, generation, updated_at FROM task WHERE id = ?").get(taskId) });
  };

  return hubTx(db, () => {
    // Every hub writer checks the restore exclusion first, inside its own
    // transaction. This is the busiest writer in the system; omitting it here
    // would leave the largest hole in the lock S2-A added.
    assertWritable(db, { isAlive, inTx: true });
    const task = db.prepare("SELECT * FROM task WHERE id=?").get(taskId);
    if (!task) return { applied: false, reason: "no-such-task" };

    const decision = nextPhase({
      // From the TASK ROW, not defaulted. `nextPhase` defaults sourceKind to
      // "founder" and the ledger-ownership guard applies only to ledger tasks --
      // so a caller that omits it lets a bare `founder.resume` reactivate a
      // ledger-sourced task with no sync witness, which is exactly the case the
      // guard exists for.
      sourceKind: task.source_kind,
      // Also from the database: regenerate terminates a live worker, and only
      // the phase_run rows know whether one is live.
      hasLiveRun: db.prepare(
        "SELECT count(*) c FROM phase_run WHERE task=? AND status IN ('live','adopted')").get(taskId).c > 0,
      phase: expectedPhase, generation: expectedGeneration, heldFrom: task.held_from,
      sliceCursor: task.slice_cursor, hasOpenPr: hasOpenBuilderPr(db, taskId),
      pinnedTerritory: hasLivePin(db, taskId),
      drainRemaining: db.prepare("SELECT count(*) c FROM task_drain WHERE task=? AND settled_at IS NULL").get(taskId).c,
    }, evidence);

    // A hold arriving on an already-held task appends a reason and updates the
    // open hold; it does NOT transition, because a transition would rewrite
    // held_from and lose where resume should send the task back to.
    // A transition justified by a phase report must name the artifact that
    // justified it: section 3.2 requires the sha in the event, and a null one
    // records a transition whose evidence cannot be re-checked afterwards.
    const WORKER_PHASES = ["SIZING","RESEARCH","DESIGN","SPEC_DRAFT","IMPLEMENTING"];
    // ONE durable-refusal exit, shared with the generic refusal branch below.
    // Two sites that must both append `transition.refused` is two sites that can
    // diverge, and they had: this one returned `refused` with no event at all, so
    // a malformed phase report left NO trace in the history `task why` renders --
    // which is indistinguishable from a report that was never sent.
    const refuseDurably = (refusal) => {
      hubEvent(db, { kind: "transition.refused", task: taskId,
        payload: { from: expectedPhase, evidence: evidence?.kind ?? null, refusal } });
      return { applied: false, reason: "refused", refusal };
    };
    if (evidence?.kind === "phase.succeeded" && WORKER_PHASES.includes(expectedPhase) && !artifactSha) {
      // Fence first. This is another path that returns before the CAS, so
      // without the check a stale report writes a durable refusal claiming the
      // CURRENT task refused evidence in a phase it has already left. Third
      // instance of that class in this plan's life; the rule is stated at the
      // top of applyTransition and every early return must honour it.
      if (task.phase !== expectedPhase || task.generation !== expectedGeneration)
        return { applied: false, reason: "lost-race" };
      return refuseDurably(
        `${expectedPhase} succeeded with no artifact sha; a transition must record what justified it`);
    }

    // Keyed on the MACHINE's `stackable`, not on re-derived state. The old
    // predicate -- refused && the phase is held && the evidence is a hold -- is
    // also true of a hold whose reason the machine just REFUSED, so the branch
    // that writes the row ran for exactly the cases that must not write one.
    if (!decision.ok && decision.stackable) {
      // This branch returns before the CAS, so it must do the CAS's job itself.
      // Without it a stale caller -- one that read BLOCKED before another
      // transaction resumed the task -- attaches an open hold reason to a task
      // that is now active, and `resume` has already cleared the holds it knew
      // about. Same predicate as the CAS: phase AND generation.
      if (task.phase !== expectedPhase || task.generation !== expectedGeneration)
        return { applied: false, reason: "lost-race" };
      db.prepare("INSERT INTO hold_reason(task,reason,detail,at) VALUES(?,?,?,unixepoch())")
        .run(taskId, evidence.reason, evidence.detail ?? null);
      db.prepare("UPDATE pr_hold SET reason=?, detail=? WHERE task=? AND cleared_at IS NULL")
        .run(holdReasonFor(evidence.reason), evidence.detail ?? null, taskId);
      // BOTH writes need row images. The hold_reason payload was hand-built (so
      // it lacked the row's id, which replay keys on) and the pr_hold update had
      // no event at all -- so a replay restored the stacked reason and left the
      // open hold's reason at whatever the snapshot held.
      hubEvent(db, { kind: "hold_reason.appended", task: taskId,
        payload: db.prepare(`SELECT id, task, reason, detail, at, cleared_at FROM hold_reason
                             WHERE task=? ORDER BY id DESC LIMIT 1`).get(taskId) });
      const held = db.prepare(`SELECT id, task, repo_id, pr, head_sha, reason, detail, created_at, cleared_at
                               FROM pr_hold WHERE task=? AND cleared_at IS NULL`).all(taskId);
      for (const h of held) hubEvent(db, { kind: "pr_hold.created", task: taskId, payload: h });
      return { applied: false, reason: "stacked" };
    }
    if (!decision.ok) {
      // The lost-race check comes FIRST. This branch returns before the CAS, so
      // without it a stale caller -- one holding a phase the task has since left
      // -- writes a durable `transition.refused` claiming the CURRENT task
      // refused evidence in an old phase. That is a false entry in the log
      // `task why` renders, and repeated stale reports can append to the hub
      // indefinitely. Same predicate as the CAS, for the same reason the stacked
      // -hold branch needed it: any path that returns early must fence itself.
      if (task.phase !== expectedPhase || task.generation !== expectedGeneration)
        return { applied: false, reason: "lost-race" };
      // A refusal can still carry a durable consequence. `depth.override` on
      // SIZING/RESEARCH/DESIGN refuses the TRANSITION -- the phase does not
      // change -- while accepting the OVERRIDE, and the redispatch that follows
      // has to run under the new depth. Ignoring `persistDepth` here made every
      // accepted override on those three phases a no-op that reported success.
      if (decision.persistDepth) persistDepth(db, taskId, decision.persistDepth);
      // And its compensations, in the same transaction, for the same reason:
      // the depth override that refuses a transition still has to end the
      // attempt running under the old depth. Ordinary refusals carry none, so
      // this loop is empty for every other path and cannot change them.
      for (const c of decision.compensations ?? [])
        applyCompensation(db, { c, taskId, generation: expectedGeneration, seq: null, evidence,
                                snapshot: evidence?.snapshot });
      // Absence is never success: a genuine refusal at the current state IS logged.
      // EVERY refusal, including the early ones. `task why` renders this history,
      // so a malformed report that returns before this point disappears entirely
      // -- and "no record" is what a report that was never sent looks like. The
      // missing-artifact refusal is the one that used to take that exit.
      return refuseDurably(decision.refusal);
    }

    // `blocked_reason` comes from the hold's cause, and a depth override carries
    // `{kind:"depth.override", depth}` with no `reason` field -- so the task
    // entered BLOCKED with a null reason and `record-hold-reason` had nothing to
    // insert against a NOT NULL column. The machine already knows the cause: it
    // is the same closed set `HOLD_ESCALATION` is keyed by.
    const holdReason = evidence?.kind === "depth.override" ? "depth_post_approval"
                     : evidence?.reason ?? null;

    const TERMINAL_WITH_REASON = ["INFEASIBLE", "CANCELLED", "LOST"];
    // Re-check the outstanding count from the DATABASE before committing a
    // terminal transition. nextPhase is pure and can only use what it was told;
    // between the caller counting and this transaction opening, a reconciler can
    // have settled a row -- or an effect can have been enqueued. DONE has no
    // edges out, so a wrong count here is unrecoverable.
    // --force is time-gated, and the machine has no clock. Re-derive eligibility
    // from the durable CANCELLING entry rather than trusting the flag: a founder
    // who ran the command a second after cancelling would otherwise force a
    // drain that had had no window at all.
    if (evidence?.kind === "founder.cancelForce") {
      // FENCE FIRST. Every one of the refusals below happens BEFORE the
      // generation-fenced CAS, and the rule this module keeps relearning is
      // that any path returning early must fence itself: without it a stale
      // caller whose task was already settled or force-cancelled by someone
      // else gets "the drain has had 4m of its 30m window" instead of the
      // required lost-race no-op -- a refusal that describes a task that no
      // longer exists in that state, and that a retry loop will keep retrying.
      if (task.phase !== expectedPhase || task.generation !== expectedGeneration)
        return { applied: false, reason: "lost-race" };
      // The clock and the threshold are the CALLER's. This module has no clock
      // by design, and the hub does not store the profile, so
      // `builder.cancel.drainMinutes` can only arrive through the interface --
      // which is why it is a named parameter and not a constant.
      //
      // A missing threshold REFUSES rather than defaulting. A default here is an
      // invented window, and the one thing this guard exists to prevent is a
      // force that had no window at all.
      if (drainMinutes == null)
        return { applied: false, reason: "refused",
                 refusal: "cancel --force needs builder.cancel.drainMinutes; the hub does not store the profile" };
      const at = now ?? db.prepare("SELECT unixepoch() n").get().n;
      const enteredAt = db.prepare(
        `SELECT at FROM phase_event WHERE task=? AND to_phase='CANCELLING' ORDER BY seq DESC LIMIT 1`).get(taskId)?.at;
      // No CANCELLING entry means the drain never started. Treating that as
      // "zero minutes elapsed" happens to refuse, but for the wrong reason and
      // with a message that says the window is still running.
      if (enteredAt == null)
        return { applied: false, reason: "refused",
                 refusal: "there is no CANCELLING entry to measure the drain window from" };
      const mins = (at - enteredAt) / 60;
      if (mins < drainMinutes)
        return { applied: false, reason: "refused",
                 refusal: `the drain has had ${Math.floor(mins)}m of its ${drainMinutes}m window` };
    }

    if (decision.to === "DONE") {
      // FENCE FIRST, like the force-cancel branch above and for the same reason:
      // both of these returns happen BEFORE the generation-fenced CAS. A stale
      // caller still expecting FINALIZING after another command moved the task
      // -- into CANCELLING, say -- would get "finalization is not complete"
      // instead of the required lost-race no-op, and a retry loop reads that as
      // "not yet" rather than "not yours".
      if (task.phase !== expectedPhase || task.generation !== expectedGeneration)
        return { applied: false, reason: "lost-race" };
      // Unsettled AND unsuccessful. Section 9.7 requires every finalization effect
      // to have SETTLED THROUGH ITS RECONCILER -- a ledger write-back that
      // reached `failed`, `dead_letter` or `refused` never happened, and DONE is
      // terminal with no edges out, so the task can never come back to do it.
      // Scoped to THIS generation, and to rows enqueued since FINALIZING was
      // entered. An unqualified query reads the task's whole history, so a
      // `failed` row from an earlier phase -- one the task already recovered
      // from through a fresh row -- blocks FINALIZING -> DONE forever, and DONE
      // is terminal with no edges out. The task would be permanently
      // unfinishable because of a failure that was already handled.
      // Scoped by the authorising FENCE, not by a clock. `created_at >= at` is
      // seconds-resolution, so an effect from an earlier phase that reached
      // `failed` during the same second FINALIZING was entered is still selected
      // -- and DONE is terminal with no edges out, so that task can never finish.
      // Every outbox row already carries `fence`, the seq of the phase_event that
      // enqueued it, and seq is monotonic and exact. There is no tie to break.
      const finalizingSeq = db.prepare(
        `SELECT seq FROM phase_event WHERE task=? AND to_phase='FINALIZING'
           AND to_generation=? ORDER BY seq DESC LIMIT 1`).get(taskId, expectedGeneration)?.seq;
      if (finalizingSeq == null)
        return { applied: false, reason: "refused",
                 refusal: "there is no FINALIZING entry for this generation to scope the completion check to" };
      const bad = db.prepare(
        `SELECT status, count(*) c FROM outbox
         WHERE task_id=? AND task_generation=? AND fence >= ?
           AND status IN ('pending','inflight','failed','dead_letter','refused')
         GROUP BY status`).all(taskId, expectedGeneration, finalizingSeq);
      if (bad.length)
        return { applied: false, reason: "refused",
                 refusal: `finalization is not complete: ` + bad.map(r => `${r.c} ${r.status}`).join(", ") +
                          `; DONE is terminal and cannot be revisited` };
    }

    const upd = db.prepare(
      `UPDATE task SET phase=?, generation=?, updated_at=unixepoch(),
                       held_from=?, blocked_reason=?, terminal_reason=?,
                       slice_cursor=COALESCE(?, slice_cursor)
       WHERE id=? AND phase=? AND generation=?`)
      .run(decision.to, decision.generation,
           HELD.includes(decision.to) ? expectedPhase : (decision.to === "CANCELLING" ? task.held_from : null),
           // `holdReason`, not `evidence.reason`. A post-approval `depth.override`
           // carries no `reason` field, so reading the evidence directly wrote a
           // NULL `blocked_reason` for exactly the hold the derivation above
           // exists to name -- and then handed `record-hold-reason` nothing to
           // insert against a NOT NULL column. Deriving a value and then not
           // using it is the same as not deriving it.
           HELD.includes(decision.to) ? holdReason : null,
           // The founder's words, stored where `task why` and dash read them.
           TERMINAL_WITH_REASON.includes(decision.to) ? (evidence.reason ?? null) : task.terminal_reason,
           decision.sliceCursor,          // null leaves it alone; slice.next advances it
           taskId, expectedPhase, expectedGeneration);
    if (upd.changes === 0) return { applied: false, reason: "lost-race" };

    const { seq } = db.prepare(
      `INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,slice,artifact_sha,detail)
       VALUES(?,unixepoch(),?,?,?,?,?,?,?,?) RETURNING seq`)
      .get(taskId, op, expectedPhase, decision.to, expectedGeneration, decision.generation,
           slice, artifactSha, JSON.stringify({
             evidence: evidence?.kind ?? null,
             // The CLAIMING witness, durable. `nextPhase` refuses a claim.won
             // without these two precisely so the provenance exists -- and then
             // nothing wrote them, so a task could reach SIZING with no record of
             // which ledger event won it or which projection it was checked
             // against. `task` carries `claim_event_id` and
             // `projection_generation` columns for the same reason.
             ...(evidence?.kind === "claim.won"
               ? { claimEventId: evidence.claimEventId,
                   projectionGeneration: evidence.projectionGeneration }
               : {}) }));

    // ...and onto the task row, which is what `task why` and the merge
    // pre-flight read. The event is the log; the columns are the projection.
    if (evidence?.kind === "claim.won")
      db.prepare("UPDATE task SET claim_event_id=?, projection_generation=? WHERE id=?")
        .run(evidence.claimEventId, evidence.projectionGeneration, taskId);

    // The transition LOG needs its own row image, or replay restores the task
    // projection and loses every transition after the snapshot -- and restored
    // outbox rows keep fence values pointing at phase_event seqs that no longer
    // exist, so fence revalidation compares against nothing. replay.mjs has a
    // phase_event.appended handler; this is what feeds it.
    hubEvent(db, { kind: "phase_event.appended", task: taskId,
      payload: db.prepare(`SELECT seq, task, at, op, from_phase, to_phase, from_generation,
                                  to_generation, slice, artifact_sha, detail
                           FROM phase_event WHERE seq = ?`).get(seq) });

    // `evidence` is passed through: record-hold-reason needs the reason and detail
    // the hold carried, and without them it can only write a row saying a hold
    // happened -- which is what `task resume` lists to the founder.
    // Caller-supplied effects are enqueued BEFORE the compensations run, so
    // that `record-drain` -- which is ordered last precisely because it
    // snapshots what is outstanding -- actually sees them. Enqueueing them
    // afterwards meant any cancellation effect passed through the documented
    // `effects` parameter was absent from `task_drain`, so `drainRemaining`
    // could reach zero and the task reach CANCELLED with that effect still
    // pending. Each carries the fence: the seq of the event that decided it.
    for (const e of effects) enqueueEffect(db, { ...e, taskId, generation: decision.generation, fence: seq });

    // Same helper as the refusal path above, so an accepted override persists
    // whether or not the phase moved.
    if (decision.persistDepth) persistDepth(db, taskId, decision.persistDepth);

    for (const c of decision.compensations)
      applyCompensation(db, { c, taskId, generation: decision.generation, seq, evidence, snapshot: evidence?.snapshot });

    // (Effects were enqueued above, before the compensations, so record-drain
    // can count them. They are never performed here: the executor revalidates
    // the fence inside its lease transaction, and an effect decided under a
    // contract that has since been replaced settles 'fenced' with nothing done.)

    // resume_seq is bumped BEFORE the event is built, and travels IN it. Bumping
    // it afterwards means the replayed payload carries the old counter: the
    // comparison set diverges, and worse, a re-minted SPEC_DRAFT round reuses an
    // earlier resume's idempotency key (section 3.2 keys spec pushes by
    // `r<resume_seq>` precisely to keep those distinct).
    const resumeSeq = task.resume_seq + (evidence?.kind === "founder.resume" ? 1 : 0);
    if (resumeSeq !== task.resume_seq)
      db.prepare("UPDATE task SET resume_seq=? WHERE id=?").run(resumeSeq, taskId);
    // recordDrainSet is NOT called here: `record-drain` is already one of the
    // compensations nextPhase returns for founder.cancel, and applyCompensation
    // ran it in the loop above. Calling it again inserts the same
    // (task, outbox_id) rows a second time, which the primary key aborts --
    // rolling back every cancellation that caught an inflight effect.
    // The payload is a ROW IMAGE, so it must carry every column the UPDATE above
    // wrote -- replay upserts exactly the columns listed and leaves the rest at
    // whatever the snapshot held. blocked_reason was missing, so a replayed
    // BLOCKED task came back with the old reason (usually null); and held_from
    // was hardcoded null, which erases the phase a CANCELLING task must return
    // to. Both are read back out of the row that was just written rather than
    // recomputed here, so the image cannot drift from the update again.
    // `claim_event_id` and `projection_generation` are in the image because the
    // CLAIMING witness above WRITES them onto this same row. Replay upserts only
    // the columns the image lists, so a claim.won that landed after the snapshot
    // restored the task into SIZING with both columns back at their snapshot
    // values -- and merge pre-flight reads the task projection, so the task
    // looked like it had never claimed the node it is holding.
    const wrote = db.prepare(`SELECT id, phase, generation, resume_seq, slice_cursor,
                                     held_from, blocked_reason, terminal_reason,
                                     claim_event_id, projection_generation, updated_at
                              FROM task WHERE id=?`).get(taskId);
    hubEvent(db, { kind: "task.transitioned", task: taskId, payload: wrote });

    // The identity the machine named, raised in the SAME transaction. Declared
    // on the contract and dropped on the floor for a round: `go` did not carry
    // it, so INFEASIBLE, the gate cap and the post-approval depth override each
    // documented an escalation that no code path could ever raise.
    if (decision.escalate) {
      const why = decision.escalate.replace("<id>", taskId);
      db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
                  VALUES(?,1,unixepoch(),unixepoch(),0)
                  ON CONFLICT(why) DO UPDATE SET count=count+1, last_seen_at=unixepoch()`).run(why);
      // The ROW, not the key. Every authority-bearing write in this system logs
      // the row it wrote -- that is the contract replay is built on, and it is
      // the audit trail besides. `{ why }` alone loses the counters and the
      // timestamps this statement just changed, so the log records that an
      // escalation happened and not what the escalation now says.
      //
      // `escalation.raised` is in NON_REPLAYED_KINDS (S2-A): the row is
      // re-derived by the next evaluation of the same condition, which is also
      // what a founder wants after a restore. The row image is written for the
      // record, not for the replay.
      hubEvent(db, { kind: "escalation.raised", task: taskId,
        payload: db.prepare("SELECT why, count, first_seen_at, last_seen_at, announced_count FROM escalation WHERE why = ?").get(why) });
    }
    return { applied: true, to: decision.to, generation: decision.generation, seq };
  });
}
```

Write `applyCompensation` as a switch over the closed set `phases.mjs` produces, each appending its own `hub_event`. A `default:` branch **throws**, naming the compensation: an unknown name must not be a silent no-op, or a machine that emits one the transaction cannot apply looks like it worked.

| compensation | what it does |
|---|---|
| `void-pending` | voids rows with `cancellable=1 AND status='pending'` only; a non-cancellable push mid-transport is not a compensation |
| `write-pr-hold` | one `pr_hold` row per open builder PR, reason from the closed set |
| `close-prs` | enqueues `gh.pr.close` plus the explanatory comment |
| `release-territory` | deletes the task's `territory_lease` rows, and appends one `territory_lease.released` `hub_event` per row with the row image. `territory_lease` is a REPLAYED projection separate from `task_territory` (the claims are the task's, the lease is the grant), so without the event a post-snapshot release is undone by replay and the task's territory is held by a ghost |
| `regrant-territory` | appends `territory_lease.granted` per row, and **re-runs the §10.2 intersection check inside this transaction**, and throws if it now conflicts, rolling the whole resume back. The machine's `territoryConflict` evidence is the caller's earlier read; this is the authoritative one, because only a check under `BEGIN IMMEDIATE` excludes a filing that landed in between |
| `clear-holds` | sets `cleared_at` on every open `pr_hold` **and** `hold_reason` for the task |
| `annotate-resumed` | enqueues the compensating "resumed" comment for any hold comment left behind |
| `record-hold-reason` | inserts the `hold_reason` row for **this** hold — the first one, not only the stacked ones |
| `record-research-skip` | appends a `research.skipped` `hub_event` for the task, carrying the depth that justified it. The only compensation that writes nothing but history: RESEARCH produced no artifact, and the absence needs a reason attached to it or it reads as a lost phase |
| `record-drain` | inserts one `task_drain` row per outbox row for this task in `status IN ('pending','inflight')`. **Runs last**, so it captures the close and comment effects the compensations above just enqueued — those are `pending`, not `inflight`, so an inflight-only select would have missed exactly the rows ordering it last was meant to catch |
| `adopt-snapshot` | writes **every** field `nextPhase` validated — `repo_id`, `nwo_snapshot`, `repo_path`, `profile_path`, `profile_hash`, `default_branch`, `visibility`, `spec_repo_id`, `gate_definition_hash`, `registry_version`, `founder_user_id` — onto the task, from values the caller resolved BEFORE the transaction. Writing a subset is worse than writing none: the generation bump asserts the whole contract was re-resolved, and a task with a new profile hash and an old repository path is a hybrid nothing later can detect. Only `regenerate` emits it |
| `release-ledger-claim` | enqueues `ledger.release` (`release <id> --if-owner reeve:bt:<ulid>`) through the typed CLI in the dedicated clone. `--if-owner` makes it inert when a human already owns the node |
| `terminate-worker` | ends the task's live `phase_run` through the §4.5 lease path — revoke, SIGTERM, then SIGKILL the process **group**, and mark the run `killed`. Emitted by cancel and by `--redesign`; a no-op when no run is live |
| `force-drain` | sets `forced=1` and `last_known` on every unsettled `task_drain` row, and moves their outbox rows to `forced`, so a `--force` cancel records what was never confirmed instead of leaving the projection claiming it is still in flight |

- [ ] **Step 4: Run and commit**

```bash
$N test/hub-transition.test.mjs
# replay.mjs too: this task adds the handlers for the event kinds it introduces,
# and leaving them uncommitted fails the event-kind cross-check -- or worse,
# passes it and loses those projections at the next restore.
git add src/build/transition.mjs src/build/replay.mjs test/hub-transition.test.mjs
git commit -m "feat(hub): generation-fenced transition with compensations"
```

---

### Task 16: The fenced outbox — live-key uniqueness, supersede, and duplicate delivery

**Files:**
- Create: `src/build/outbox.mjs`
- Test: `test/hub-outbox.test.mjs`

**Interfaces:**
- Consumes: `hubTx`, `hubEvent`, **`assertWritable`** (S2-A); the `outbox` DDL. Every function here mutates hub state, so **each calls `assertWritable(db, { isAlive, inTx: true })` inside its own transaction** — `leaseEffect`, `settleEffect`, `recoverEffects` and `voidPending` alike. The executor runs on a loop, so without the check it can lease and settle rows — performing real external effects — while a restore replaces the file underneath it. It is the one writer that never stops on its own.
- Produces:
  - `enqueueEffect(db, { idempotencyKey, kind, taskId, generation, fence, cancellable = true, args, notBefore = 0 }) -> { id, status }` — **must be called inside the caller's transaction**. Returns `status: 'superseded'` with no row performed when the key is round- or sha-keyed and a `done` row already carries it.
  - `leaseEffect(db, { worker, leaseSeconds = 300, capabilities }) -> Row | null` — revalidates the fence **inside the lease transaction** and settles `fenced` (returning null and trying the next row) when the task has moved generation or the row was voided; settles `refused` when the effect's capability switch is off.
  - `settleEffect(db, { id, ok, result, error, retryable })`, `recoverEffects(db, { reconcile })`, `voidPending(db, taskId)`.
  - `settleDrainFor(db, outboxId)` — the shared helper that clears a `task_drain` row when its outbox row reaches a terminal status and appends `task_drain.settled`. **Called by `settleEffect` AND by `leaseEffect`**, because `leaseEffect` settles `fenced` and `refused` itself without going through `settleEffect`. A hook installed in only one of the two leaves exactly the cancellations that were fenced at lease time stuck in CANCELLING.
  - **Settling an effect settles its drain row.** In the same transaction, `settleEffect` (and `recoverEffects` through it) sets `task_drain.settled_at` for any row matching `(task_id, id)` and appends a `task_drain.settled` `hub_event`. Without this nothing ever clears the drain: `nextPhase` refuses `drain.settled` while any row has `settled_at IS NULL`, so every cancellation that caught an inflight effect would sit in CANCELLING until `builder.cancel.drainMinutes` expired and the founder ran `--force` — turning the ordinary path into the exceptional one, and recording rows as `forced` whose reconcilers had in fact completed.

```js
// inside settleEffect's transaction, after the outbox row is updated.
// ONLY when the row reached a terminal status: a failed-but-retryable settle
// returns it to `pending`, and marking its drain row settled would let the task
// reach CANCELLED while the effect is still queued to run again.
// leaseEffect settles rows as `fenced` or `refused` directly, without going
// through settleEffect -- so the drain hook has to live in a helper BOTH call,
// or a cancellation whose in-flight effect is fenced at lease time never clears
// its drain row and the task waits out drainMinutes for nothing.
const TERMINAL_OUTBOX = ["done","failed","dead_letter","voided","fenced","refused","superseded","forced"];
const nowStatus = db.prepare("SELECT status FROM outbox WHERE id=?").get(id).status;
const drained = TERMINAL_OUTBOX.includes(nowStatus) ? db.prepare(
  `UPDATE task_drain SET settled_at = unixepoch()
   WHERE task = (SELECT task_id FROM outbox WHERE id = ?) AND outbox_id = ? AND settled_at IS NULL`).run(id, id)
  : { changes: 0 };
if (drained.changes) {
  const row = db.prepare(`SELECT task, outbox_id, recorded_at, settled_at, forced, last_known
                          FROM task_drain WHERE outbox_id=?`).get(id);
  hubEvent(db, { kind: "task_drain.settled", task: row.task, payload: row });
}
```
  - `KEY_KINDS` — which kinds are round-keyed or sha-keyed, i.e. which ones consult `done` rows at enqueue.

- [ ] **Step 1: Write the failing test**

```js
// The outbox is what stops one crash from becoming two pull requests, and what
// stops a stale attempt from acting under a contract nobody approved.
//
// Three rules, and each has its own way of being wrong:
//   1. Keys are unique over LIVE rows only, so a re-enqueue after a hold is
//      ADMITTED and settled inert by its reconciler against external truth. A
//      blanket UNIQUE either swallows it or refuses the enqueue.
//   2. Round-keyed and sha-keyed kinds ALSO consult done rows, because for
//      those the key itself is proof the effect happened -- a rerun re-derives
//      different bytes and would otherwise push a second time for one round.
//   3. Every row carries a fence, revalidated inside the lease transaction.
/* ... standard harness, plus seed ... */
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { enqueueEffect, leaseEffect, settleEffect, recoverEffects,
         voidPending, KEY_KINDS } from "../src/build/outbox.mjs";


// ── fence revalidation ───────────────────────────────────────────────────────
{
  const db = openHub(join(dir, "o1.db")); seed(db, { id: "bt:1", phase: "SPEC_DRAFT", generation: 3 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g3:SPEC_DRAFT:comment:0", kind: "gh.pr.comment",
    taskId: "bt:1", generation: 3, fence: 1, args: {} }));

  const good = leaseEffect(db, { worker: "w", capabilities: allOn });
  check(good?.kind === "gh.pr.comment", "an effect whose fence still validates is leased", JSON.stringify(good));
  settleEffect(db, { id: good.id, ok: true, result: {} });

  // now the task is redesigned out from under a second effect
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g3:SPEC_DRAFT:comment:1", kind: "gh.pr.comment",
    taskId: "bt:1", generation: 3, fence: 2, args: {} }));
  db.exec("UPDATE task SET generation=4 WHERE id='bt:1'");
  const stale = leaseEffect(db, { worker: "w", capabilities: allOn });
  check(stale === null, "an effect enqueued under generation 3 is not leased once the task is in generation 4");
  check(db.prepare("SELECT status FROM outbox WHERE idempotency_key='bt:1:g3:SPEC_DRAFT:comment:1'").get().status === "fenced",
    "it settles 'fenced', with nothing performed");

  // control: an effect at the CURRENT generation is still leasable, so the
  // fence is a comparison and not a switch that turned everything off.
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g4:SPEC_DRAFT:comment:0", kind: "gh.pr.comment",
    taskId: "bt:1", generation: 4, fence: 3, args: {} }));
  check(leaseEffect(db, { worker: "w", capabilities: allOn })?.task_generation === 4,
    "control: an effect at the current generation is leased normally");
  db.close();
}

// ── live-rows-only uniqueness, which is what makes resume work ───────────────
{
  const db = openHub(join(dir, "o2.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  const K = "bt:1:g1:IMPLEMENTING:comment:0";
  const a = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  check(a.status === "pending", "the first enqueue is live");
  const b = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  check(b.status === "duplicate" && b.id === a.id, "a second enqueue while the first is live is inert", JSON.stringify(b));

  voidPending(db, "bt:1");
  const c = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 9, args: {} }));
  check(c.status === "pending" && c.id !== a.id,
    "after a hold voided it, the SAME key is admitted as a new row beside the voided one", JSON.stringify(c));
  db.close();
}

// ── round-keyed kinds consult done rows too ──────────────────────────────────
{
  const db = openHub(join(dir, "o3.db")); seed(db, { id: "bt:1", phase: "SPEC_DRAFT", generation: 1 });
  const K = "bt:1:g1:r0:SPEC_DRAFT:push:2";                       // round-keyed
  const a = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "git.push.branch", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  settleEffect(db, { id: a.id, ok: true, result: { sha: "deadbeef" } });

  const b = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "git.push.branch", taskId: "bt:1", generation: 1, fence: 5, args: {} }));
  check(b.status === "superseded",
    "re-enqueuing a round-keyed push whose row is already done is settled superseded, not performed", JSON.stringify(b));
  check(db.prepare("SELECT count(*) c FROM outbox WHERE idempotency_key=? AND status='pending'").get(K).c === 0,
    "so a crash-rerun that re-derived different bytes does not become a SECOND push for the same round");

  // control: a COMMENT with a done row IS re-enqueued, because for that kind
  // the reconciler decides against external truth rather than the key.
  const C = "bt:1:g1:SPEC_DRAFT:comment:0";
  const c1 = hubTx(db, () => enqueueEffect(db, { idempotencyKey: C, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  settleEffect(db, { id: c1.id, ok: true, result: {} });
  const c2 = hubTx(db, () => enqueueEffect(db, { idempotencyKey: C, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 6, args: {} }));
  check(c2.status === "pending",
    "control: a non-round-keyed kind with a done row IS re-enqueued and left to its reconciler", JSON.stringify(c2));
  db.close();
}

// ── a capability switch that is off refuses, and does not retry ──────────────
{
  const db = openHub(join(dir, "o4.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "k", kind: "git.push.branch", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  // Two switches, two surfaces: publishPr governs project-repo effects and
  // draftSpec governs spec-repo ones (section 1.4). Testing one kind against one
  // switch cannot tell a correct gate from one that consults the same switch for
  // everything, which would leave the spec repo ungated the moment publishPr
  // turned on.
  const off = { ...allOn, "builder.capabilities.publishPr": false };
  check(leaseEffect(db, { worker: "w", capabilities: off }) === null, "a project-repo push is not leased with publishPr off");
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "spec", kind: "gh.pr.comment", taskId: "bt:1",
    generation: 1, fence: 1, args: { repo: "spec" } }));
  check(leaseEffect(db, { worker: "w", capabilities: { ...allOn, "builder.capabilities.draftSpec": false } }) === null,
    "a SPEC-repo comment is not leased with draftSpec off");
  // A refused settle is TERMINAL, so the row above is gone; enqueue a fresh one
  // under a new key or this control has nothing to lease and fails against a
  // correct implementation.
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "spec2", kind: "gh.pr.comment", taskId: "bt:1",
    generation: 1, fence: 1, args: { repo: "spec" } }));
  check(leaseEffect(db, { worker: "w", capabilities: off })?.kind === "gh.pr.comment",
    "control: a spec effect IS leased when only publishPr is off, so the two switches are distinct");
  const row = db.prepare("SELECT * FROM outbox WHERE idempotency_key='k'").get();
  check(row.status === "refused", "it settles 'refused'", row.status);
  check(row.attempts === 0, "and burns no attempt: a switch the founder set is configuration, not a fault", String(row.attempts));
  check(db.prepare("SELECT count(*) c FROM escalation").get().c === 0, "and raises no escalation");
  db.close();
}

// ── duplicate delivery of every kind produces one effect ─────────────────────
// The rule this drill has to obey, and got wrong once: **the test may not do the
// deduplicating.** An earlier version expired every lease, then handed
// recoverEffects a `reconcile` callback that both performed the action and
// suppressed the repeat out of a Set the test owned. The suppression was
// therefore the test's, not the outbox's, and a hub that handed the same effect
// out twice still passed.
//
// So the consumer here has NO memory. `drain` performs whatever leaseEffect
// gives it, exactly as an executor would, and `world` is external truth --
// append-only, written only by the act of performing. Every assertion is about
// what the hub chose to hand out.
{
  const db = openHub(join(dir, "o5.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  // Every kind the DDL's CHECK admits, derived from it rather than retyped --
  // `gate.clean_notice` was missing, and it is the one whose double delivery
  // matters most: its settle writes the notice_receipt row that STARTS the
  // founder silence window, so delivering it twice restarts the clock.
  const KINDS = ["git.push.branch","gh.pr.create","gh.pr.comment","gh.pr.close","gh.pr.body",
                 "gh.review.request","gh.pr.merge","notify","gate.clean_notice",
                 "ledger.claim","ledger.release"];
  // The list must be the DDL's whole enumeration, read from the schema rather
  // than counted by hand -- a drill claiming to cover "every kind" while quietly
  // covering ten of eleven is the shape that let gate.clean_notice slip.
  const declared = [...db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='outbox'").get().sql
      .match(/kind\s+TEXT\s+NOT NULL CHECK \(kind IN\s*\(([^)]*)\)/s)[1]
      .matchAll(/'([a-z._]+)'/g)].map(m => m[1]);
  check(declared.length === KINDS.length && declared.every(k => KINDS.includes(k)),
    "control: KINDS is the outbox DDL's whole kind enumeration, not a subset",
    JSON.stringify(declared.filter(k => !KINDS.includes(k))));
  const world = [];                       // what really happened out there
  const drain = () => {
    for (let row; (row = leaseEffect(db, { worker: "w", capabilities: allOn })); ) {
      world.push(row.idempotency_key);    // the external action
      settleEffect(db, { id: row.id, ok: true, result: {} });
    }
  };

  // The two mechanisms are DIFFERENT, and a single loop expecting `superseded`
  // for all ten contradicted this file's own control forty lines above, which
  // requires a completed `gh.pr.comment` with the same key to be re-enqueued as
  // `pending` for its reconciler. No implementation can satisfy both.
  //
  //   KEYED kinds (round- and sha-keyed): the key itself is proof the effect
  //   happened, so a re-enqueue against a `done` row is SUPERSEDED at enqueue.
  //   Everything else: the re-enqueue is ADMITTED and made inert by the
  //   reconciler against external truth.
  //
  // Partitioned from the module's own KEY_KINDS rather than a list retyped
  // here, so the test cannot disagree with the implementation about which is
  // which.
  // Assert the EXACT set first, from section 3.2, before using it to partition.
  // Deriving the expectation from KEY_KINDS makes the test adapt to whatever the
  // module exports: swap `gh.pr.merge` out and an unrelated kind in, and both
  // partitions stay non-empty and every loop below follows the mistake. The
  // design says push and merge kinds are sha-keyed and spec pushes are
  // round-keyed; that is the claim, so that is what is checked.
  check(JSON.stringify([...KEY_KINDS].sort()) === JSON.stringify(["gh.pr.merge", "git.push.branch"]),
    "KEY_KINDS is exactly the sha-/round-keyed kinds section 3.2 names",
    JSON.stringify([...KEY_KINDS].sort()));

  const keyed = KINDS.filter(k => KEY_KINDS.includes(k));
  const plain = KINDS.filter(k => !KEY_KINDS.includes(k));
  check(keyed.length > 0 && plain.length > 0,
    "control: the fixture covers both partitions, so neither branch below is vacuous",
    `keyed=${JSON.stringify(keyed)} plain=${JSON.stringify(plain)}`);

  // (a) KEYED: re-enqueue after completion is superseded, never handed out again.
  for (const k of keyed) {
    const key = `bt:1:g1:IMPLEMENTING:${k}:deadbeef`;      // sha-keyed form
    const first = hubTx(db, () => enqueueEffect(db, {
      idempotencyKey: key, kind: k, taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    check(first.status === "pending", `${k}: the first enqueue is admitted`, String(first.status));
    drain();
    const repeat = hubTx(db, () => enqueueEffect(db, {
      idempotencyKey: key, kind: k, taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    check(repeat.status === "superseded",
      `${k}: re-enqueueing a completed keyed effect is superseded, not admitted`, String(repeat.status));
    drain();                              // must find nothing to hand out
  }

  // (b) NON-KEYED: the re-enqueue is admitted, and the RECONCILER is what makes
  //     it inert. `drain` performs whatever it is handed, so if the second
  //     delivery reaches a worker it happens twice and `world` says so.
  for (const k of plain) {
    const key = `bt:1:g1:IMPLEMENTING:${k}:0`;
    hubTx(db, () => enqueueEffect(db, {
      idempotencyKey: key, kind: k, taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    drain();                              // performs it once
    const repeat = hubTx(db, () => enqueueEffect(db, {
      idempotencyKey: key, kind: k, taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    check(repeat.status === "pending",
      `${k}: a non-keyed re-enqueue is ADMITTED, for its reconciler to settle`, String(repeat.status));
    // Recovery, not dispatch: the reconciler may only OBSERVE external truth.
    // It never appends to `world`, so if the outbox needs a second external
    // action to make progress, this drill cannot supply one.
    db.exec(`UPDATE outbox SET status='inflight', lease_expires_at = unixepoch() - 1
             WHERE idempotency_key = '${key}' AND status = 'pending'`);
    recoverEffects(db, { reconcile: (row) =>
      world.includes(row.idempotency_key)
        ? { settled: true, ok: true, result: { reconciled: true } }
        : { settled: false } });
    check(db.prepare("SELECT status FROM outbox WHERE idempotency_key=? ORDER BY id DESC LIMIT 1").get(key).status === "done",
      `${k}: and is settled from external truth without performing it again`);
  }

  const counts = {};
  for (const key of world) counts[key] = (counts[key] ?? 0) + 1;
  const repeated = Object.entries(counts).filter(([, n]) => n !== 1);
  check(world.length === KINDS.length && repeated.length === 0,
    `delivering all ${KINDS.length} kinds twice performs each exactly once`,
    `world=${world.length} repeated=${JSON.stringify(repeated)}`);

  // (b) The other half of re-delivery: a worker that performed the effect and
  //     died BEFORE settling. The row is inflight, the action has happened, and
  //     the hub does not know. Recovery must reconcile it against external truth
  //     rather than returning it to pending -- returning it to pending is what
  //     turns one crash into two pull requests.
  const crashKey = "bt:1:g1:IMPLEMENTING:crash:0";
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: crashKey, kind: "gh.pr.create",
    taskId: "bt:1", generation: 1, fence: 2, args: {} }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn });
  world.push(leased.idempotency_key);                      // the effect lands...
  // ...and the worker dies here: no settleEffect call at all.
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${leased.id}`);

  // The reconciler may only OBSERVE. It never appends to `world`; if the outbox
  // needs a second external action to make progress, this drill cannot supply one.
  let observed = 0;
  recoverEffects(db, { reconcile: (row) => {
    observed++;
    return world.includes(row.idempotency_key)
      ? { settled: true, ok: true, result: { reconciled: true } }
      : { settled: false };
  }});
  check(observed === 1, "the crashed delivery is handed to its reconciler exactly once", String(observed));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(leased.id).status === "done",
    "and is settled from external truth, not retried");
  drain();
  check(world.filter(k => k === crashKey).length === 1,
    "so the crashed effect happened exactly once, with no second delivery",
    `${world.filter(k => k === crashKey).length}`);
  db.close();
}

// ── settling an effect settles its drain row, through BOTH call paths ─────────
// `settleDrainFor` is the helper settleEffect AND leaseEffect must both call,
// because leaseEffect settles `fenced` and `refused` itself without going
// through settleEffect. A hook installed in only one of them leaves exactly the
// cancellations whose effect was fenced at lease time stuck in CANCELLING until
// `builder.cancel.drainMinutes` expires and the founder runs --force: the
// ordinary path becomes the exceptional one, and rows whose reconcilers did in
// fact complete are recorded as `forced`.
//
// Nothing else in this suite creates a task_drain row, so an implementation that
// omits either hook -- or both -- passed every outbox assertion above.
{
  // o6, not o5: the duplicate-delivery block above already opened o5 and seeded
  // `bt:1`, so reopening it aborted on the task primary key before either
  // settleDrainFor path ran.
  const db = openHub(join(dir, "o6.db"));
  seed(db, { id: "bt:1", phase: "CANCELLING", generation: 1 });
  const drain = (id) => db.prepare(
    "INSERT INTO task_drain(task,outbox_id,recorded_at) VALUES('bt:1',?,unixepoch())").run(id);
  const settledAt = (id) => db.prepare(
    "SELECT settled_at FROM task_drain WHERE outbox_id=?").get(id).settled_at;
  const events = () => db.prepare(
    "SELECT count(*) c FROM hub_event WHERE kind='task_drain.settled'").get().c;

  // PATH 1 -- settleEffect.
  const a = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:CANCELLING:comment:0",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  drain(a.id);
  // CONTROL, and it has to come before the settle: a recorded-but-unsettled row
  // reads null. Without it an implementation that stamps settled_at at INSERT
  // satisfies both assertions below without ever calling the helper.
  check(settledAt(a.id) === null,
    "control: a recorded drain row starts unsettled", String(settledAt(a.id)));
  const before = events();
  leaseEffect(db, { worker: "w", capabilities: allOn });
  settleEffect(db, { id: a.id, ok: true, result: {} });
  check(settledAt(a.id) !== null,
    "settleEffect settles the drain row for the effect it just completed", String(settledAt(a.id)));
  check(events() === before + 1,
    "and appends exactly one task_drain.settled for it, so replay can restore the settlement",
    `${before} -> ${events()}`);

  // PATH 2 -- leaseEffect, which settles `fenced` without going through
  // settleEffect at all. This is the assertion that goes red on the
  // one-hook implementation, and it is the whole reason the helper exists.
  const b = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:CANCELLING:comment:1",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 2, args: {} }));
  drain(b.id);
  db.exec("UPDATE task SET generation=2 WHERE id='bt:1'");     // the fence no longer validates
  const mid = events();
  check(leaseEffect(db, { worker: "w", capabilities: allOn }) === null,
    "fixture: the stale effect is not leased", "");
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(b.id).status === "fenced",
    "fixture: leaseEffect settled it 'fenced' without settleEffect");
  check(settledAt(b.id) !== null,
    "leaseEffect settles the drain row for an effect it fences", String(settledAt(b.id)));
  check(events() === mid + 1,
    "and appends its task_drain.settled too", `${mid} -> ${events()}`);

  // CONTROL: a drain row whose outbox row is still PENDING must stay unsettled,
  // or an implementation that settles every row on any call passes both paths
  // above and lets a task reach CANCELLED with an effect still queued to run.
  const c = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g2:CANCELLING:comment:0",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 2, fence: 3, args: {} }));
  drain(c.id);
  check(settledAt(c.id) === null,
    "control: a drain row whose effect is still pending is NOT settled", String(settledAt(c.id)));
  check(db.prepare(
    "SELECT count(*) c FROM task_drain WHERE task='bt:1' AND settled_at IS NULL").get().c === 1,
    "control: so drainRemaining still counts exactly the one outstanding effect");
  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

**On the broken implementation** — an `enqueueEffect` copied from `ops.mjs`'s `ON CONFLICT(idem_key) DO NOTHING` — the fence and capability blocks pass, and two lines go red: `after a hold voided it, the SAME key is admitted as a new row` (the conflict clause swallows it) and `re-enqueuing a round-keyed push whose row is already done is settled superseded` (there is no done-row consult at all). The `control:` line beneath each is what keeps the fix from over-correcting into "always admit" or "never admit".

The drain block has its own broken implementation, and it is the likelier one: `settleDrainFor` hooked into `settleEffect` only. Every outbox assertion passes, the first drain path passes, and one line goes red — `leaseEffect settles the drain row for an effect it fences`. That is the whole reason the helper exists rather than the hook living inside `settleEffect`, and it is invisible to a suite that never creates a `task_drain` row. Hooked into neither, both paths go red together. The two `control:` lines are the other direction: a row that starts already-settled, and an implementation that settles every drain row on any call, both of which would satisfy the two positive assertions while leaving a task free to reach CANCELLED with an effect still queued.

- [ ] **Step 3: Implement, run, commit**

```bash
$N test/hub-outbox.test.mjs
git add src/build/outbox.mjs test/hub-outbox.test.mjs
git commit -m "feat(hub): fenced outbox with live-key uniqueness"
```

---
### Task 17: The registry snapshot — network first, transaction second

**Files:**
- Create: `src/build/registry.mjs`
- Test: `test/hub-registry.test.mjs`

**Interfaces:**
- Consumes: `hubTx`, `hubEvent`, **`assertWritable`** (S2-A), `applyTransition` (Tasks 1, 6, 15).
- Produces:
  - `resolveSnapshot(registry, project, claims, io) -> Snapshot` — takes the filing's normalised claims, because it is the only place with both the repository path and an I/O capability, and it returns them resolved. Without the parameter `resolveClaims` had no caller and the symlink refusal was unreachable from the filing path. where `io = { repoId, visibility, specRepoId, profileHash, defaultBranch, gateDefinitionHash, founderUserId, lstat, lsTree }`, each a function. **Async, and it is where every network call lives.** `lstat` and `lsTree` are in that list because `resolveSnapshot` calls `resolveClaims`, which needs both — the symlink refusal and the gitlink (submodule) refusal are its entire purpose. An `io` carrying only the lookup functions makes the composition throw when snapshot resolution reaches the filesystem-aware stage, or silently skip both refusals; the tests call `resolveClaims` directly, so they exercise the half that works and not the seam that does not.
  - **The territory grant appends its event.** `admitTask` writes `territory_lease` rows and must append one `territory_lease.granted` `hub_event` each, with the row image — S2-A has the handler and the table is in `COMPARISON_SET`, so an ungranted event means a post-snapshot admission loses its lease at replay and the task runs with territory nothing records it holding.
  - **`filing.idempotencyKey` is carried into the transaction and enforced.** `task.idempotency_key` and its partial unique index `task_idem` already exist in S2-A's migration 1, and the command contract says a repeated `--idempotency-key` request returns the ORIGINAL task and performs nothing. Without the lookup a retried script — a shell loop, a re-run CI step — mints a second task for the same work, which then competes with the first for its own territory and is refused, so the retry looks like a conflict with a stranger. `admitTask` returns `{ ok: true, taskId, replayed: true }` when the key already exists, and inserts nothing.
  - `admitTask(db, snapshot, filing) -> { ok, taskId, refusal, replayed }` — **synchronous, one `BEGIN IMMEDIATE`, and it performs no I/O of its own.** Inserts the task row at generation 1, its `task_territory` children, the `task.filed` event, and grants the territory lease **with the full intersection check**, refusing the whole filing and naming the blocker on a conflict. It calls **`assertWritable(db, { isAlive, inTx: true })` first, inside that transaction**: it writes four authority-bearing rows, so admitting a filing while a restore holds `maintenance_lock` races the snapshot replacement and can be lost by the replay that follows it. "Every hub writer calls it" is a rule with no exceptions, and admission was one.
  - `normalizeClaim(raw, { kind = "prefix" } = {}) -> { kind, path } | { refusal }` — **pure**, and grammar only. The second argument is how a caller declares a FILE claim: `--territory-file` and a bare `--territory` are different flags, and the shape is declared rather than inferred (an extension heuristic gets `packages/x.js` and `packages/Makefile` wrong in opposite directions). The single-argument signature made the test's `normalizeClaim(path, { kind: "file" })` assert behaviour the interface did not offer. shape, normalisation, and the refused constructs (`*`, `**`, `!`, braces, character classes, absolute paths, `..`). It cannot and does not check symlinks.
  - `resolveClaims(claims, repoPath, io) -> { ok, claims } | { refusal }` — the **filesystem-aware** half, run by `resolveSnapshot` in the network-first phase (§2.2). It walks each normalised claim **and every ancestor** and refuses:
    - any component that is a **symlink** (`io.lstat`), naming it; and
    - any component that is a **submodule root**, naming it. §10.1 lists submodule paths among the refused shapes, and `lstat` cannot see one — a submodule root is an ordinary directory. The tell is git's own: the superproject records a **gitlink** (mode `160000`) there, so `io.lsTree(repoPath, path)` returning that mode is the check. Claiming inside one puts a territory lease on a path whose content belongs to a different repository, where §10.1's diff comparison cannot see changes at all.
  - `overlaps(a, b) -> boolean` — prefix overlap by path segment.

**Why the split.** §10.1 requires symlinked paths to be refused at claim time, and §2.2 requires `admitTask` to perform **no I/O**. Both cannot hold in one function: a `normalizeClaim` given only a string can either skip the check or resolve against whatever the process's current directory happens to be — which is not the repository, and would let two textually different claims resolve through a symlink to the same tree while overlap says they are disjoint. So the check moves to where the I/O already legitimately happens, before the transaction opens.

- [ ] **Step 1: Write the failing test**

```js
// The hub write lock is never held across a GitHub call. Network first,
// transaction second: resolveSnapshot reads repo id, visibility, spec repo id,
// default branch and profile hash as plain values, and admitTask receives those
// values and does no I/O at all.
//
// That is asserted rather than described: admitTask is handed an `io` whose
// every method throws, and it must still succeed.
/* ... standard harness ... */
import { openHub } from "../src/build/hubdb.mjs";
import { resolveSnapshot, admitTask, resolveClaims, normalizeClaim, overlaps } from "../src/build/registry.mjs";
import { readFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

// The snapshot every block below is admitted against, declared as CODE at file
// scope. An earlier revision left it in a comment, which is the same as not
// declaring it: the standard harness contains no snapshot, so `snap.repoPath`
// raised a ReferenceError before the first assertion ran.
// `founderUserId` is part of the snapshot, not an afterthought: section 5
// authorises comment-based depth overrides against the founder's IMMUTABLE
// numeric id, and a task admitted without it cannot authenticate the very
// `/reeve depth` comments the depth-override edges exist to handle. It is
// snapshotted at admission for the same reason as the profile hash -- a later
// change to who the founder is must not retroactively authorise old comments.
const snap = { repoId: 1, nwo: "o/r", repoPath: "/p", profilePath: "/f",
               profileHash: "h", defaultBranch: "main", visibility: "private",
               specRepoId: 9, gateDefinitionHash: "g", registryVersion: 3,
               founderUserId: 4242 };

// ── admitTask CANNOT perform I/O ─────────────────────────────────────────────
// This is a negative property, and the only sound way to establish a negative is
// to remove the capability and check it is gone -- not to watch for its use.
//
// Watching was tried twice and failed twice, in opposite ways. Passing an `io`
// whose methods throw tests nothing: a conforming implementation ignores the
// field, and a broken one that imports node:fs directly ignores it too. An
// async_hooks `init` hook is worse, because it looks like it works: `init` fires
// for ASYNCHRONOUS resources, so `lstatSync` -- the exact call this is meant to
// catch -- creates no event at all, and a filter of /FSREQ|STATWATCHER/ would
// not have named TCPWRAP or GETADDRINFOREQWRAP either. Both instruments report
// "no I/O" for a function doing synchronous filesystem or network work.
//
// So the guarantee is structural: every capability admitTask might want arrives
// as an injected `io` from resolveSnapshot, which runs BEFORE the transaction
// opens, and nothing in its module's import graph can reach the filesystem or
// the network. That is checkable, transitively.
{
  // `module` is in this list because `createRequire` is a door to every other
  // one, and `vm` because it can evaluate a specifier the walk never sees.
  const IO_MODULE = /^node:(fs|net|http|https|dns|tls|dgram|child_process|worker_threads|http2|cluster|inspector|module|vm)(\/|$)/;
  // Every module EDGE, not just static `import ... from`. A static-import scan
  // reports a clean graph for a module that does
  // `createRequire(import.meta.url)("node:fs")`, or reaches an I/O module
  // through `export ... from`, or `await import("node:fs")` -- three ways to the
  // same capability that the check was blind to, which makes "cannot reach the
  // filesystem" a claim about syntax rather than about capability.
  //
  // `node:module` is itself in IO_MODULE below, so createRequire cannot be
  // reached without tripping the walk regardless of what it is later used for.
  // That is deliberate: the boundary is easier to defend at the door.
  const EDGE = /(?:^\s*(?:import|export)\s(?:[^;]*?from\s+)?|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/gm;
  const importsOf = (f) => [...readFileSync(f, "utf8").matchAll(EDGE)].map(m => m[1]);
  const walk = (file, seen = new Set()) => {
    if (seen.has(file)) return [];
    seen.add(file);
    const bad = [];
    for (const spec of importsOf(file)) {
      if (IO_MODULE.test(spec)) { bad.push(`${basename(file)} imports ${spec}`); continue; }
      if (spec.startsWith(".")) bad.push(...walk(resolve(dirname(file), spec), seen));
    }
    return bad;
  };
  const srcFile = (rel) => fileURLToPath(new URL(rel, import.meta.url));

  const reach = walk(srcFile("../src/build/registry.mjs"));
  check(reach.length === 0,
    "admitTask's module cannot reach the filesystem or the network, transitively",
    reach.join("; "));

  // CONTROL, and the half that carries the weight: run the same walk over a
  // module that demonstrably DOES perform I/O. Without it, a walker with a
  // broken regex -- or one that silently fails to read a file -- reports a clean
  // graph for everything, and the assertion above passes for every possible
  // implementation, including one that lstats on every claim.
  const capable = walk(srcFile("../src/backup.mjs"));
  check(capable.length > 0,
    "control: the same walk finds the I/O in a module that really does it",
    JSON.stringify(capable));

  // CONTROLS for the three edge forms the static-import scan missed. Each is a
  // synthetic source string, not a file, because the point is the SCANNER --
  // whether it can see the edge at all -- and writing three decoy modules into
  // src/ to prove it would be worse than the bug.
  const scan = (text) => [...text.matchAll(EDGE)].map(m => m[1]).filter(s => IO_MODULE.test(s));
  for (const [form, text] of [
    ["createRequire",  'import { createRequire } from "node:module";'],
    ["require call",   'const fs = require("node:fs");'],
    ["dynamic import", 'const fs = await import("node:fs");'],
    ["re-export",      'export { readFileSync } from "node:fs";'],
  ]) {
    check(scan(text).length > 0, `control: the walk sees an I/O edge reached by ${form}`, text);
  }
  check(scan('import { join } from "node:path";').length === 0,
    "control: and does NOT flag a module that is not I/O, so the check is not just 'contains node:'");
}

// ── the transaction is synchronous, and admits the filing ────────────────────
{
  const db = openHub(join(dir, "r1.db"));
  // admitTask takes the RESOLVED claims, not raw strings: resolveClaims is where
  // the symlink refusal lives, so passing filing.territory straight through lets
  // an implementation satisfy the root and no-territory cases while never
  // consulting the resolver at all.
  const resolved = resolveClaims([normalizeClaim("packages/x")], snap.repoPath,
    { lstat: () => ({ isSymbolicLink: () => false }), lsTree: () => ({ mode: "040000" }) });
  let threw = null, r;
  try {
    r = admitTask(db, snap, { id: "bt:1", project: "nextly", title: "t", claims: resolved.claims });
  } catch (e) { threw = e.message; }
  check(threw === null, "admitTask admits a resolved filing without throwing", String(threw));
  // Synchronous, asserted rather than assumed. An implementation that became
  // async returns a Promise here, and every field read below is undefined --
  // which surfaces as a pile of unrelated failures rather than as this one.
  check(!(r instanceof Promise), "and it is synchronous: one BEGIN IMMEDIATE, with no await inside the transaction");
  check(r.ok === true, "and admits the filing", JSON.stringify(r));
  const t = db.prepare("SELECT * FROM task WHERE id='bt:1'").get();
  check(t.generation === 1 && t.phase === "FILED", "at generation 1, in FILED");
  // The WHOLE snapshot, column by column, not three of it. A task carrying a
  // hybrid contract -- new profile hash, old repository path -- is the failure
  // this assertion exists to catch, and checking three columns cannot see it.
  for (const [col, want] of [["repo_id", 1], ["nwo_snapshot", "o/r"], ["repo_path", "/p"],
                             ["profile_path", "/f"], ["profile_hash", "h"],
                             ["default_branch", "main"], ["visibility", "private"],
                             ["spec_repo_id", 9], ["gate_definition_hash", "g"],
                             ["registry_version", 3], ["founder_user_id", 4242]])
    check(t[col] === want, `the snapshot's ${col} is persisted`, `${col}=${JSON.stringify(t[col])}`);
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task='bt:1'").get().c === 1,
    "and the territory lease is granted in the same transaction");
  db.close();
}

// ── territory grammar: two shapes, and nothing else ──────────────────────────
{
  check(normalizeClaim("packages/x").kind === "prefix", "a bare path is a recursive prefix claim");
  // Kind comes from the CLAIM SHAPE the founder typed, not from guessing at the
  // path: `--territory-file` and a bare `--territory` are different flags, and
  // an extension heuristic gets `packages/x.js` (a directory some projects
  // really do have) and `packages/Makefile` (a file with no extension) both
  // wrong -- silently, and in opposite directions.
  check(normalizeClaim("packages/x/index.ts", { kind: "file" }).kind === "file",
    "an explicit file claim is a file claim");
  check(normalizeClaim("packages/x/index.ts").kind === "prefix",
    "and the same string with no kind given is a prefix: the shape is declared, never inferred");
  check(normalizeClaim("./packages/x/").path === "packages/x", "leading ./ and trailing / are normalized away");
  // Parent traversal is refused SEGMENT-WISE, not by prefix. A check for a
  // leading "../" accepts `packages/../secret`, which resolves outside the
  // claimed subtree while looking disjoint to the textual overlap comparison --
  // so two tasks can be granted what is really the same path.
  for (const bad of ["packages/*", "packages/**", "!packages/x", "packages/{a,b}", "/abs/path", "packages/[ab]",
                     "../up", "..", "packages/..", "packages/../secret", "packages/x/../../etc", "a/../../b"])
    check(!!normalizeClaim(bad).refusal, `${bad} is refused`, JSON.stringify(normalizeClaim(bad)));
  // CONTROL: the refusal is about the SEGMENT `..`, not about the two
  // characters. `..foo` and `foo..bar` are legal directory names, and a fix
  // written as a substring ban refuses real claims while still passing every
  // line above.
  for (const good of ["packages/..foo", "packages/foo..bar", "packages/a..b/c"])
    check(!normalizeClaim(good).refusal,
      `control: ${good} is accepted, so the refusal is segment-wise and not a substring ban`,
      JSON.stringify(normalizeClaim(good)));

  // The symlink refusal lives in the filesystem-aware half, with an injected io
  // so the test needs no real symlink and admitTask still performs no I/O.
  // The input has to be DECOMPOSED. An earlier revision passed an already
  // composed "é", which an implementation that returns its argument unchanged
  // satisfies while normalising nothing.
  const decomposed = "packages/cafe\u0301";              // e + COMBINING ACUTE ACCENT
  check(decomposed !== "packages/caf\u00e9",
    "control: the fixture really is the decomposed spelling, so the assertion below is not vacuous");
  check(normalizeClaim(decomposed).path === "packages/caf\u00e9",
    "claims are normalised to NFC, so one composition cannot hide beside another",
    JSON.stringify(normalizeClaim(decomposed).path));
  // `lsTree` too. resolveClaims checks EVERY component with both predicates, so
  // an io carrying only `lstat` makes a correct implementation throw on
  // `io.lsTree is not a function` the moment it reaches a non-symlink component
  // -- which is every ancestor in the control cases below. The fixture must
  // answer both questions, not just the interesting one.
  const io = { lstat: (p) => ({ isSymbolicLink: () => p.endsWith("/linked") }),
               lsTree: () => ({ mode: "040000" }) };
  const viaLink = resolveClaims([{ kind: "prefix", path: "packages/linked" }], "/repo", io);
  check(!!viaLink.refusal && /linked/.test(viaLink.refusal),
    "a claim ENDING at a symlink is refused, naming the path", JSON.stringify(viaLink));
  // The leaf case alone is passed by an implementation that lstats only the
  // final component -- which then admits a claim whose ANCESTOR is the symlink,
  // and that is the shape that actually escapes the repository.
  const belowLink = resolveClaims([{ kind: "file", path: "packages/linked/child.ts" }], "/repo", io);
  check(!!belowLink.refusal && /linked/.test(belowLink.refusal),
    "and so is a claim whose ANCESTOR is a symlink, naming the ancestor", JSON.stringify(belowLink));

  // A submodule root is an ordinary directory to lstat, so the symlink check
  // cannot see it. git's gitlink mode is what distinguishes it.
  const subIo = { lstat: () => ({ isSymbolicLink: () => false }),
                  lsTree: (_r, p) => (p === "vendor/lib" ? { mode: "160000" } : { mode: "040000" }) };
  const inSub = resolveClaims([{ kind: "prefix", path: "vendor/lib/src" }], "/repo", subIo);
  check(!!inSub.refusal && /vendor\/lib/.test(inSub.refusal),
    "a claim inside a SUBMODULE is refused, naming the submodule root", JSON.stringify(inSub));
  check(resolveClaims([{ kind: "prefix", path: "packages/x" }], "/repo", subIo).ok === true,
    "control: an ordinary directory still resolves");
  const plain = resolveClaims([{ kind: "prefix", path: "packages/x" }], "/repo", io);
  check(plain.ok === true, "control: an ordinary path resolves", JSON.stringify(plain));
  check(/packages\/x/.test(normalizeClaim("packages/*").refusal ?? ""),
    "and the refusal shows an example of the accepted grammar", String(normalizeClaim("packages/*").refusal));

  check(overlaps({kind:"prefix",path:"packages/x"}, {kind:"file",path:"packages/x/y.ts"}), "a prefix contains a file beneath it");
  // kind is part of the answer: an exact FILE claim has no descendants, so it
  // cannot contain anything. Treating it as a prefix refuses concurrent filings
  // that do not actually conflict -- a false conflict is as costly here as a
  // missed one, because it blocks work with a message naming the wrong reason.
  check(!overlaps({kind:"file",path:"packages/x"}, {kind:"prefix",path:"packages/x/y"}),
    "an exact file claim does not contain a prefix beneath its own path");
  check(overlaps({kind:"file",path:"packages/x/y.ts"}, {kind:"file",path:"packages/x/y.ts"}),
    "control: two identical file claims still overlap");
  check(!overlaps({kind:"prefix",path:"packages/x"}, {kind:"prefix",path:"packages/xy"}),
    "packages/x and packages/xy do NOT overlap: prefix comparison is by path segment, not by string");
  check(overlaps({kind:"prefix",path:"packages/x"}, {kind:"prefix",path:"packages/x"}), "control: equal claims overlap");
}

// ── resolveSnapshot COMPOSES with resolveClaims ──────────────────────────────
// Calling resolveClaims standalone tests the resolver and says nothing about
// whether the filing path reaches it. An implementation can accept the declared
// `lstat`/`lsTree` and never call resolveClaims at all, leaving the real path
// with no symlink and no gitlink refusal while every assertion above passes.
{
  const lookups = { repoId: async () => 1, visibility: async () => "private",
                    specRepoId: async () => 9, profileHash: async () => "h",
                    defaultBranch: async () => "main", gateDefinitionHash: async () => "g",
                    founderUserId: async () => 4242 };
  // The registry supplies the four snapshot fields `io` does not: the NWO, the
  // repository path, the profile path, and the registry's own version. A fixture
  // carrying only `repoPath` cannot tell a complete resolveSnapshot from one that
  // returns four undefineds, because there is nothing for it to have read.
  const registry = { version: 3, projects: { nextly: {
    nwo: "o/r", repoPath: "/repo", profilePath: "/f" } } };

  const viaLink = await resolveSnapshot(registry, "nextly", [normalizeClaim("packages/linked/x")],
    { ...lookups, lstat: (p) => ({ isSymbolicLink: () => p.endsWith("/linked") }),
      lsTree: () => ({ mode: "040000" }) });
  check(!!viaLink.refusal && /linked/.test(viaLink.refusal),
    "resolveSnapshot refuses a symlinked claim, so the filing path really reaches resolveClaims",
    JSON.stringify(viaLink));

  const inSub = await resolveSnapshot(registry, "nextly", [normalizeClaim("vendor/lib/src")],
    { ...lookups, lstat: () => ({ isSymbolicLink: () => false }),
      lsTree: (_r, p) => (p === "vendor/lib" ? { mode: "160000" } : { mode: "040000" }) });
  check(!!inSub.refusal && /vendor\/lib/.test(inSub.refusal),
    "and refuses a claim inside a submodule, naming the submodule root", JSON.stringify(inSub));

  // CONTROL: an ordinary claim resolves and comes back RESOLVED, or the two
  // refusals above are satisfied by a resolveSnapshot that refuses everything.
  const ok = await resolveSnapshot(registry, "nextly", [normalizeClaim("packages/x")],
    { ...lookups, lstat: () => ({ isSymbolicLink: () => false }), lsTree: () => ({ mode: "040000" }) });
  check(!ok.refusal && ok.claims?.length === 1,
    "control: an ordinary claim resolves", JSON.stringify(ok));
  // EVERY field, not two. This is the only end-to-end successful resolveSnapshot
  // in the suite, so an implementation that omits the repository id, the NWO, the
  // paths, the spec repository id, the gate-definition hash or the registry
  // version passes a two-field control and then admits an incomplete contract on
  // the real filing path. The hand-built `snap` fixture above cannot catch it:
  // that asserts what admitTask does WITH a snapshot, not what resolveSnapshot
  // composes INTO one.
  for (const [field, want] of [["repoId", 1], ["nwo", "o/r"], ["repoPath", "/repo"],
                               ["profilePath", "/f"], ["profileHash", "h"],
                               ["defaultBranch", "main"], ["visibility", "private"],
                               ["specRepoId", 9], ["gateDefinitionHash", "g"],
                               ["registryVersion", 3], ["founderUserId", 4242]])
    check(ok[field] === want, `control: the resolved snapshot carries ${field}`,
          `${field}=${JSON.stringify(ok[field])}`);
}

// ── an empty or unparseable claim is the ROOT, never no-claim ────────────────
// The absence of a territory claim must never read as the absence of conflict.
{
  for (const empty of ["", "   ", null, undefined]) {
    const c = normalizeClaim(empty);
    check(c.kind === "prefix" && c.path === "", `an empty claim (${JSON.stringify(empty)}) becomes the repository root`, JSON.stringify(c));
  }
  const db = openHub(join(dir, "r2.db"));
  // `claims`, not `territory`: the filing admitTask receives carries RESOLVED
  // claims (see its interface above), and a fixture that passes raw strings
  // tests a signature the implementation does not have.
  const claim = (s) => [normalizeClaim(s)];
  admitTask(db, snap, { id: "bt:root", project: "p", title: "t", claims: claim("") });
  const blocked = admitTask(db, snap, { id: "bt:2", project: "p", title: "t", claims: claim("packages/anything") });
  check(blocked.ok === false, "a root-prefix task blocks every concurrent grant in its project");
  check(String(blocked.refusal).includes("bt:root"), "and the refusal names the blocking task", String(blocked.refusal));

  // CONTROL: the identical claim in a DIFFERENT project must still be granted.
  // Without this, a lease-conflict query that forgot its project predicate
  // passes every assertion above while serialising unrelated repositories that
  // both happen to contain `packages/x` -- a deadlock between projects that
  // share nothing, reported as a territory conflict.
  const elsewhere = admitTask(db, { ...snap, repoId: 2, nwo: "o/other" },
    { id: "bt:other", project: "q", title: "t", claims: claim("packages/anything") });
  check(elsewhere.ok === true,
    "control: the same path in another project is granted, so conflicts are scoped by project",
    JSON.stringify(elsewhere));
  // and the reverse direction, so the predicate cannot be satisfied by luck:
  // a root claim in project q blocks q, and still does not touch p.
  const alsoBlocked = admitTask(db, snap, { id: "bt:3", project: "p", title: "t", claims: claim("packages/other") });
  check(alsoBlocked.ok === false, "control: project p is still blocked by its own root claim");
  db.close();
}

// ── the same filing key twice admits ONE task ────────────────────────────────
// The retry is the ordinary case, not the exotic one: a script that times out
// mid-request re-runs the whole command. Two tasks for one filing then compete
// for the same territory, and the second is refused as a conflict -- naming the
// first, which is itself.
{
  const db = openHub(join(dir, "r4.db"));
  const filing = { id: "bt:idem", project: "p", title: "t",
                   idempotencyKey: "founder:2026-08-23:001", claims: [normalizeClaim("packages/x")] };
  const first = admitTask(db, snap, filing);
  check(first.ok === true && first.replayed !== true, "the first filing is admitted", JSON.stringify(first));
  const again = admitTask(db, snap, { ...filing, id: "bt:different" });
  check(again.ok === true && again.replayed === true,
    "and the same key again returns the ORIGINAL task rather than minting a second",
    JSON.stringify(again));
  check(again.taskId === "bt:idem", "naming the first task's id, not the retry's", String(again.taskId));
  check(db.prepare("SELECT count(*) c FROM task").get().c === 1,
    "exactly one task exists", String(db.prepare("SELECT count(*) c FROM task").get().c));
  check(db.prepare("SELECT count(*) c FROM territory_lease").get().c === 1,
    "and exactly one territory lease, so the retry did not conflict with itself");
  // CONTROL: a DIFFERENT key still admits, or "idempotent" has become "admits once".
  const other = admitTask(db, snap, { id: "bt:other", project: "p", title: "t",
    idempotencyKey: "founder:2026-08-23:002", claims: [normalizeClaim("packages/y")] });
  check(other.ok === true && other.replayed !== true,
    "control: a different key admits a new task", JSON.stringify(other));
  db.close();
}

// ── a filing with no --territory at all is refused ───────────────────────────
{
  const db = openHub(join(dir, "r3.db"));
  const r = admitTask(db, snap, { id: "bt:4", project: "p", title: "t", claims: [] });
  check(r.ok === false, "a filing with no territory is refused");
  check(db.prepare("SELECT count(*) c FROM task WHERE id='bt:4'").get().c === 0,
    "and nothing is inserted, so a refused filing leaves no half-task behind");
  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

**On the broken implementation** — `overlaps` written as `a.path.startsWith(b.path) || b.path.startsWith(a.path)` — every grammar assertion passes and one line goes red: `packages/x and packages/xy do NOT overlap`. That is a string-prefix bug that would refuse legitimate concurrent filings forever, and nothing else in the file catches it.

- [ ] **Step 3: Implement, run, commit**

`overlaps` compares normalized **path segments**, not strings: `a === b`, or one is the other plus a `/` boundary. Normalisation is **NFC**, as §10.1 requires and as git itself compares: on macOS a path typed in one composition and read back in another are different byte strings for the same file, so two claims can look disjoint and address the same tree. Case is preserved and compared exactly, also as git does. `normalizeClaim` refuses `*`, `**`, `!`, `{}`, `[]`, absolute paths, `..`, and any path traversing a symlink at claim time; an empty or unparseable claim returns `{kind:"prefix", path:""}`, the repository root.

```bash
$N test/hub-registry.test.mjs
git add src/build/registry.mjs test/hub-registry.test.mjs
git commit -m "feat(hub): registry snapshot and territory admission"
```

---

### Task 18: `repo_gate_state` — a pure derivation behind an injected fetcher

**Files:**
- Create: `src/build/gatestate.mjs`, **`src/build/loop.mjs`**
- Modify: `bin/reeve` (the `build run` loop calls `buildTick`)

`src/build/loop.mjs` exports **`buildTick(ctx)`** — the tick body, importable and
testable without spawning the CLI. S2's tick does exactly one thing: refresh
`repo_gate_state` for every registry project through `ctx.fetchGateState`.
`bin/reeve`'s `build run` loop calls it between heartbeats; the phase work that
fills it out is S4's. The wiring test calls `buildTick` directly, and until this
file exists it has nothing to import.
- Test: `test/hub-gatestate.test.mjs`

**Interfaces:**
- Consumes: `hubTx`, `hubEvent` (Tasks 1, 6), **`assertWritable`** (S2-A).
- Produces:
  - `gateStateFrom({ ruleset, installation, expectedAppId, repoId, nwo, now }) -> Row` — **pure**. Returns the exact `repo_gate_state` row shape. Any absent or unreadable input yields `app_installed: 'unknown'` and `ruleset_requires_check: 0` with `error` set; **never a pass.**
  - `refreshGateState(db, project, fetch) -> Row` — **async.** Calls `fetch(project)` (the injected seam; **S8 supplies the real rulesets API client**) and *then* opens the transaction that upserts. Writes `hub_event` kind `repo_gate_state.refreshed`. Calls **`assertWritable(db, { isAlive, inTx: true })` inside that transaction**: this runs on every tick, so without the check a loop that never stops on its own keeps upserting rows and appending events while a restore is replacing the file underneath it.
  - **The fetch completes BEFORE the transaction opens.** Not a style preference: the hub has one writer, and an implementation that opens `BEGIN IMMEDIATE` and then awaits an API call holds that writer for as long as GitHub takes to answer — a 30-second timeout stalls every transition and every outbox settlement on the machine. The test below proves the ordering rather than describing it.
- **S2 ships no live GitHub call.** The tick's `ctx.fetchGateState` defaults to a function that returns `null`, which `gateStateFrom` turns into an `unknown` row — the correct reading of "reeve has not looked".

- [ ] **Step 1: Write the failing test**

```js
// Clause U4 reads this row at merge time. The whole value of a derivation this
// small is that every way of not knowing lands on UNKNOWN rather than on a
// default that happens to look like a pass.
/* ... standard harness, plus seed ... */
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { gateStateFrom, refreshGateState } from "../src/build/gatestate.mjs";
import { buildTick } from "../src/build/loop.mjs";
import { DatabaseSync } from "node:sqlite";
// `plus seed`, not the bare harness: the writer-exclusion block at the end of
// this file calls seed(), and the commented import list further down declares
// nothing -- a comment is not a binding.

const EXPECTED = 42;
// The COMPLETE section 1.8 contract, defined ONCE at file scope and shared by
// the positive fixture and the per-permission negative loop below. When `FULL`
// was widened to eight and `ok` was left at three, a correct gateStateFrom
// returned `app_installed: "fail"` on the first assertion that claims to be a
// pass: two fixtures for one contract, disagreeing.
//
// Administration is READ deliberately -- administration write is refused in
// code, so requiring write would be wrong in the other direction.
const FULL = { actions: "read", administration: "read", checks: "write",
               contents: "write", issues: "write", metadata: "read",
               pull_requests: "write", statuses: "write" };
const ok = { ruleset: { required_status_checks: [{ context: "ops/merge-policy", integration_id: EXPECTED }] },
             installation: { permissions: { ...FULL } } };

{
  let r = gateStateFrom({ ...ok, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(r.ruleset_requires_check === 1 && r.bound_app_id === EXPECTED && r.app_installed === "pass",
    "a ruleset requiring the check from the expected app, with the app installed, is a pass", JSON.stringify(r));
  check(r.verified_at === 100 && r.error === null, "and records when it was verified");

  // bound to a DIFFERENT app: the check would be satisfiable by another source
  r = gateStateFrom({ ruleset: { required_status_checks: [{ context: "ops/merge-policy", integration_id: 99 }] },
                      installation: ok.installation, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(r.bound_app_id === 99 && r.bound_app_id !== r.expected_app_id,
    "a check bound to another app is recorded as drift, not as a pass", JSON.stringify(r));

  // required but bound to NOTHING: any source could satisfy it
  r = gateStateFrom({ ruleset: { required_status_checks: [{ context: "ops/merge-policy" }] },
                      installation: ok.installation, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(r.bound_app_id === null, "a check required from ANY source records a null bound app", JSON.stringify(r));

  // the check is not required at all
  r = gateStateFrom({ ruleset: { required_status_checks: [{ context: "CI Gate", integration_id: 7 }] },
                      installation: ok.installation, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(r.ruleset_requires_check === 0, "a ruleset that does not require ops/merge-policy is recorded as such");

  // every shape of not-knowing
  for (const [label, input] of [
    ["no ruleset",        { ruleset: null, installation: ok.installation }],
    ["no installation",   { ruleset: ok.ruleset, installation: null }],
    ["neither",           { ruleset: null, installation: null }],
    ["a fetch error",     { ruleset: null, installation: null, error: "403" }],
  ]) {
    const u = gateStateFrom({ ...input, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
    // BOTH, not either. The interface says any absent or unreadable input yields
    // app_installed 'unknown' AND ruleset_requires_check 0; an `||` is satisfied
    // by a row that claims the ruleset requires the check while the app state is
    // unknown, which is a half-pass the clause would read as evidence.
    check(u.app_installed === "unknown" && u.ruleset_requires_check === 0,
      `${label} yields unknown AND not-required, never a half-pass`, JSON.stringify(u));
    check(typeof u.error === "string" && u.error.length > 0, `${label} records WHY it is unknown`, String(u.error));
  }

  // missing a permission is a fail, distinct from unknown: reeve looked and the
  // answer was no, which is a different thing to report and to act on.
  // One permission at a time. A fixture missing several at once is satisfied by
  // an implementation that checks only the first, which then passes an
  // installation with read-only contents or no pull_requests write.
  // FULL is the file-scope constant the positive `ok` fixture is built from, so
  // the two cannot drift: this loop removes one permission at a time from the
  // SAME contract the pass case asserts.
  for (const missing of Object.keys(FULL)) {
    const perms = { ...FULL }; delete perms[missing];
    const p = gateStateFrom({ ruleset: ok.ruleset, installation: { permissions: perms },
                              expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
    check(p.app_installed === "fail", `a missing ${missing} permission is a fail, not an unknown`, JSON.stringify(p));
    check((p.permission_diff ?? "").includes(missing), `and the diff names ${missing}`, String(p.permission_diff));
  }
  const downgraded = gateStateFrom({ ruleset: ok.ruleset, installation: { permissions: { ...FULL, contents: "read" } },
                                     expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(downgraded.app_installed === "fail",
    "and a permission present but downgraded to read is also a fail", JSON.stringify(downgraded));
  // The other direction: administration must NOT be write. The design refuses
  // administration write in code, so an installation carrying it is a finding.
  const over = gateStateFrom({ ruleset: ok.ruleset, installation: { permissions: { ...FULL, administration: "write" } },
                               expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(over.app_installed === "fail",
    "and administration WRITE is a fail: the contract is read, and more is not better", JSON.stringify(over));
}

// ── the tick writes it; S2 makes no network call ─────────────────────────────
{
  const db = openHub(join(dir, "g.db"));
  // A fetcher that THROWS is the live case: a 403, a network drop, a rate limit.
  // If refreshGateState lets it propagate, the row is never written, U4 finds
  // nothing, and doctor reports the project as having never refreshed -- which
  // is indistinguishable from a fresh hub and hides an outage. It must catch,
  // record the error on the row, and leave the state unknown.
  // Both failure shapes: a synchronous throw and a REJECTED promise. The live
  // fetcher is async, so the rejected case is the one that will actually happen,
  // and a try/catch around a call that returns a promise catches neither.
  const threw = await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED },
    () => { throw new Error("403 from the rulesets API"); });
  const rejected = await refreshGateState(db, { name: "nextly", repoId: 2, nwo: "o/other", expectedAppId: EXPECTED },
    () => Promise.reject(new Error("ECONNRESET")));
  check(rejected.app_installed === "unknown" && /ECONNRESET/.test(rejected.error ?? ""),
    "a fetcher whose promise REJECTS also writes an unknown row carrying why", JSON.stringify(rejected));
  check(threw.app_installed === "unknown" && /403/.test(threw.error ?? ""),
    "a fetcher that throws still writes an unknown row, carrying WHY", JSON.stringify(threw));

  // Awaited: refreshGateState must be async to catch a rejected fetcher, so an
  // unawaited call yields a Promise and every field read off it is undefined.
  const row = await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED },
    () => null);                                   // the S2 default: reeve has not looked
  check(row.app_installed === "unknown", "with no fetcher wired, the row reads unknown rather than absent");
  check(db.prepare("SELECT count(*) c FROM repo_gate_state WHERE repo_id=1").get().c === 1, "and the row is written");
  // Count the events for THIS repo: the caught-error and rejected refreshes
  // above already wrote rows, so an unqualified count of 1 is wrong by exactly
  // the number of failure cases the block just exercised.
  // A DELTA, not a floor. Repository 1 already has an event from the
  // caught-error refresh above, so `>= 1` stays green even if the unknown and
  // successful upserts append nothing at all -- and replay would then restore an
  // older gate-state row while the live projection had moved on.
  const eventsFor1 = () => db.prepare(
    `SELECT count(*) c FROM hub_event WHERE kind='repo_gate_state.refreshed'
     AND json_extract(payload,'$.repo_id') = 1`).get().c;
  const beforeRefresh = eventsFor1();
  await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }, () => ok);
  check(eventsFor1() === beforeRefresh + 1,
    "every refresh appends exactly one hub_event, so the restore drill can replay it",
    `${beforeRefresh} -> ${eventsFor1()}`);
  await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }, () => ok);
  check(db.prepare("SELECT count(*) c FROM repo_gate_state WHERE repo_id=1").get().c === 1,
    "control: a second refresh upserts rather than inserting a second row for the same repo");

  // The block is labelled "the tick writes it", so it has to run the TICK.
  // Calling refreshGateState directly proves the function works and says nothing
  // about whether `build run` ever reaches it -- which is the wiring that would
  // actually be missing.
  db.exec("DELETE FROM repo_gate_state");
  await buildTick({ hub: db, projects: [{ name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }],
                    fetchGateState: () => ok, once: true });
  check(db.prepare("SELECT count(*) c FROM repo_gate_state WHERE repo_id=1").get().c === 1,
    "one pass of the builder tick writes the gate-state row");

  // And with NO fetcher at all, which is the S2 default and therefore the only
  // configuration that actually ships in this stage. An implementation that
  // calls ctx.fetchGateState blindly passes the assertion above and throws on
  // every real tick, where no live GitHub client is wired.
  db.exec("DELETE FROM repo_gate_state");
  await buildTick({ hub: db, projects: [{ name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }],
                    once: true });
  const dflt = db.prepare("SELECT * FROM repo_gate_state WHERE repo_id=1").get();
  check(dflt?.app_installed === "unknown",
    "a tick with no fetchGateState wired writes an UNKNOWN row rather than throwing",
    JSON.stringify(dflt));
  check(typeof dflt?.error === "string" && dflt.error.length > 0,
    "and records why it is unknown: reeve has not looked", String(dflt?.error));

  // WIRING, which neither assertion above can reach. Both call `buildTick`
  // directly, so an implementation with a correct loop.mjs and no CLI import
  // leaves production `build run` with no `repo_gate_state` writer at all while
  // every behavioural assertion here passes. The route is read as TEXT because
  // `build run` is a heartbeat loop -- invoking it from a test starts a daemon.
  const cli = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8");
  check(/\bbuildTick\b/.test(cli) && /build\/loop\.mjs/.test(cli),
    "bin/reeve imports buildTick from build/loop.mjs");
  // Scoped to the ROUTE, not the file: an import with no call site is the exact
  // half-wiring this assertion exists to catch, and a whole-file search cannot
  // tell the two apart.
  const at = cli.indexOf("build run");
  check(at !== -1, "fixture: the `build run` route exists to scan", String(at));
  check(/\bbuildTick\s*\(/.test(cli.slice(at)),
    "and the `build run` route CALLS it, so the tick runs in production and not only here");
  // CONTROL: the same pattern over text that only NAMES buildTick must fail. A
  // regex that matches a mention reports every implementation as wired,
  // including one that imports the symbol and never calls it.
  check(!/\bbuildTick\s*\(/.test('import { buildTick } from "../src/build/loop.mjs";'),
    "control: the scan does not match an import that never calls it");
  db.close();
}

// ── the fetch finishes before the write transaction opens ────────────────────
{
  const p = join(dir, "order.db");
  const db = openHub(p);
  // A fetcher that is still PENDING while we look. Inspecting the returned row
  // cannot distinguish the two orderings -- both produce the same row -- so the
  // observation has to happen while the call is in flight.
  let release;
  const pending = new Promise(res => { release = res; });
  const inflight = refreshGateState(db, { name: "nextly", repoId: 3, nwo: "o/slow", expectedAppId: EXPECTED },
    () => pending.then(() => ok));

  // A SECOND connection with no patience at all: busy_timeout 0 turns "another
  // writer holds the lock" into an immediate SQLITE_BUSY instead of a wait, so
  // this reads the lock state rather than queueing behind it.
  const probe = new DatabaseSync(p);
  probe.exec("PRAGMA busy_timeout = 0");
  let acquired = false;
  try { probe.exec("BEGIN IMMEDIATE"); acquired = true; probe.exec("ROLLBACK"); } catch { /* SQLITE_BUSY */ }
  probe.close();
  check(acquired,
    "the hub write lock is NOT held while the gate-state fetch is in flight: network first, transaction second");

  release();
  const row = await inflight;
  check(row.repo_id === 3 && row.app_installed === "pass",
    "and the row is written once the fetch resolves", JSON.stringify(row));
  db.close();
}

// ── every hub writer refuses while a restore holds the maintenance lock ──────
// S2-A's rule is "every hub writer calls assertWritable", and a rule stated once
// in prose is honoured by whichever writers the author remembered. Two were
// missed -- admitTask and refreshGateState -- so this asserts the rule over the
// whole set instead of trusting each site.
//
// The list is the obligation: a writer added later that is not in it is not
// covered, so extending this list is part of adding a writer.
// This block reaches across every writer in the plan, so it names them all, and
// the imports are EXECUTABLE. Left as a comment they are the same as absent: the
// file's own import block declares only the hub, gate-state, loop and SQLite
// APIs, so the first `applyTransition` here raised a ReferenceError and the
// block stopped before checking a single writer -- reporting itself as a green
// suite with one broken file rather than as an unenforced rule.
// These belong at the TOP of the file with the rest of its imports; they are
// written here only so the block reads as one unit.
import { applyTransition } from "../src/build/transition.mjs";
import { enqueueEffect, leaseEffect, settleEffect, recoverEffects,
         voidPending } from "../src/build/outbox.mjs";
import { admitTask, normalizeClaim } from "../src/build/registry.mjs";
import { acquireMaintenanceLock } from "../src/build/locks.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { spawn } from "node:child_process";
{
  const p = join(dir, "excl.db");
  const db = openHub(p);
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  // ALL ELEVEN fields, like every other snapshot fixture in this plan. Ten made
  // the admitTask call below a refusal for the missing `founderUserId`, so the
  // writer-exclusion assertion it feeds would have been satisfied by a refusal
  // that never reached assertWritable at all.
  const snap = { repoId: 1, nwo: "o/r", repoPath: "/p", profilePath: "/f", profileHash: "h",
                 defaultBranch: "main", visibility: "private", specRepoId: 9,
                 gateDefinitionHash: "g", registryVersion: 3, founderUserId: 4242 };

  // Someone else's live restore, held by a pid that is REALLY ALIVE. A
  // fabricated pid+lstart pair cannot match the writers' default
  // `isSameProcess`, so every one of them reaps the lock as stale and proceeds --
  // and the assertions below then report that no writer honours the restore
  // lock, against an implementation that honours it perfectly.
  //
  // A DIFFERENT process, because a lock held by this one is exactly the case
  // assertWritable is allowed to permit. A sleeping child is the cheapest real
  // one, and `readStart` gives the same lstart token the writers compare against.
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  for (let i = 0; i < 200 && readStart(holder.pid) == null; i++) await new Promise(r => setTimeout(r, 10));
  const holderStart = readStart(holder.pid);
  check(holderStart != null, "fixture: the lock holder is a real live process", String(holder.pid));
  acquireMaintenanceLock(db, { pid: holder.pid, lstart: holderStart, isAlive: isSameProcess });

  // Every writer below is synchronous. refreshGateState is the one async writer
  // and is awaited separately, so this helper deliberately does not accept a
  // promise: a rejected promise arriving here would be swallowed and read as a
  // writer that did not throw.
  const refused = (name, fn) => {
    let threw = null, returned;
    try { returned = fn(); } catch (e) { threw = e.message; }
    check(!(returned instanceof Promise),
      `control: ${name} is synchronous, so a throw is observable here`, String(returned));
    check(threw !== null && /restore|maintenance/i.test(threw),
      `${name} refuses while a restore holds the lock`, String(threw));
  };

  refused("applyTransition", () => applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING",
    expectedGeneration: 1, evidence: { kind: "hold", reason: "over_budget" }, op: "task.blocked" }));
  refused("enqueueEffect", () => hubTx(db, () => enqueueEffect(db, { idempotencyKey: "x", kind: "notify",
    taskId: "bt:1", generation: 1, fence: 1, args: {} })));
  refused("leaseEffect", () => leaseEffect(db, { worker: "w", capabilities: allOn }));
  refused("settleEffect", () => settleEffect(db, { id: 1, ok: true, result: {} }));
  refused("recoverEffects", () => recoverEffects(db, { reconcile: () => ({ settled: false }) }));
  refused("voidPending", () => voidPending(db, "bt:1"));
  refused("admitTask", () => admitTask(db, snap, { id: "bt:9", project: "p", title: "t",
    claims: [normalizeClaim("packages/z")] }));

  // The async one is awaited, because a rejected promise from an unawaited call
  // is an unhandled rejection rather than a failing assertion.
  let asyncThrew = null;
  try { await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }, () => ok); }
  catch (e) { asyncThrew = e.message; }
  check(asyncThrew !== null && /restore|maintenance/i.test(asyncThrew),
    "refreshGateState refuses while a restore holds the lock", String(asyncThrew));

  // CONTROL: release the lock and one of them must succeed. Without it, a
  // writer that throws for an unrelated reason -- a missing table, a bad
  // fixture -- satisfies every assertion above.
  db.exec("DELETE FROM maintenance_lock");
  const after = await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }, () => ok);
  check(after.app_installed === "pass",
    "control: with the lock released the same call succeeds, so the refusals above were the lock",
    JSON.stringify(after));
  holder.kill("SIGKILL");
  db.close();
}
```

- [ ] **Step 2–4: Run it red, implement, run green, commit**

**On the broken implementation** — `app_installed` defaulting to `'pass'` when `installation` is present but has no `permissions` key — the four not-knowing cases go red as a group, which is exactly the signal wanted: the failure is "unknown became a pass", not one edge case.

The wiring assertions have a second broken implementation, and it is the one this task is most likely to ship: a complete, correct `src/build/loop.mjs` that `bin/reeve` never imports. Every behavioural assertion in this file passes — they all call `buildTick` directly — and two lines go red: `bin/reeve imports buildTick from build/loop.mjs` and `the build run route CALLS it`. Production `build run` would then have no `repo_gate_state` writer at all, which is the failure §9.1 exists to prevent, and no behavioural test can see it. The `control:` line below them is what stops the scan from degrading into a search for the word: an import with no call site matches a bare name search and is exactly the half-wiring being ruled out.

```bash
$N test/hub-gatestate.test.mjs
# loop.mjs too: this task CREATES it (the buildTick seam), and both the CLI
# import and the wiring test refer to it. Omitted, the PR carries a test that
# imports a module the PR does not contain.
git add src/build/gatestate.mjs src/build/loop.mjs bin/reeve test/hub-gatestate.test.mjs
git commit -m "feat(hub): pure repo gate state derivation behind a seam"
```

---

### Task 19: The crash and corruption drills

**Files:**
- Test: `test/hub-drills.test.mjs` (new); `src/build/hubdb.mjs` (the corruption refusal)

**Interfaces:**
- Consumes: everything above.
- Produces: `openHub` gains an `integrity_check` on open failure that names the newest snapshot in its error. `recoverEffects(db, { reconcile })` from Task 16 is exercised end to end.
- The **duplicate-delivery** drill is Task 16's last block; the **destructive restore** drill is Task 9's. This task covers the remaining two of §14 S2's four.

- [ ] **Step 1: Write the failing test**

```js
// Crash and corruption, as drills rather than as unit tests.
//
// The crash drill kills a real child process mid-transition. That matters:
// SQLite's atomicity is the thing being relied on, and a same-process test with
// a mocked failure proves that the MOCK rolled back.
/* ... standard harness, plus seed ... */
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { applyTransition } from "../src/build/transition.mjs";
import { enqueueEffect, leaseEffect, settleEffect, recoverEffects } from "../src/build/outbox.mjs";
import { snapshotAll, latestSnapshot } from "../src/backup.mjs";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";

// The child the crash drill spawns imports from the checkout, so the paths in
// its generated source must be ABSOLUTE -- a relative specifier resolves from
// the temp directory the worker is written into, where there is no src/.
const SRC = join(process.cwd(), "src");
// `home` and `root` are this file's own, not the harness's `dir`: the corruption
// drill takes a snapshot, and snapshotAll wants a machine root and a backup root.
const home = mkdtempSync(join(tmpdir(), "reeve-drills-"));
const root = join(home, "backups");
mkdirSync(join(home, "state"), { recursive: true });

// ── a transition interrupted by SIGKILL is all or nothing ────────────────────
{
  const p = join(dir, "crash.db");
  const db0 = openHub(p);
  // 500 tasks, all identical, so the kill can land inside any one of their
  // transactions and the invariant is checked over every one of them.
  const seedTasks = (db, count, phase) => hubTx(db, () => {
    const ins = db.prepare(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,
                              source_kind,source_key,repo_path,profile_path,profile_hash,
                              default_branch,visibility,registry_version,created_at,updated_at)
                            VALUES(?,'p',1,'o/r','t',?,1,'founder',?,'/p','/f','h','main','private',1,
                                   unixepoch(),unixepoch())`);
    for (let i = 0; i < count; i++) ins.run(`bt:${i}`, phase, `k:${i}`);
  });

  // The child must be killed WHILE a transaction is open, which a SIGSTOP before
  // the call cannot arrange: stopping the process before applyTransition runs
  // means the transaction never begins, the parent always observes the untouched
  // branch, and the drill passes even against an applyTransition that writes its
  // event outside the transaction entirely.
  //
  // So the child transitions many tasks in a tight loop and the parent kills it
  // only after it has watched real progress in the database. The kill therefore
  // lands inside SOME transaction, and the assertion is the invariant that must
  // hold for EVERY task whichever one it landed in: the projection and the log
  // agree. A torn write shows up as a task whose phase moved with no event, or
  // an event with no phase change.
  const worker = join(dir, "crash-worker.mjs");
  writeFileSync(worker, `
import { openHub } from "${SRC}/build/hubdb.mjs";
import { applyTransition } from "${SRC}/build/transition.mjs";
const db = openHub(process.argv[2]);
for (let i = 0; i < 500; i++) {
  applyTransition(db, { taskId: "bt:" + i, expectedPhase: "RESEARCH", expectedGeneration: 1,
    evidence: { kind: "phase.succeeded", phase: "RESEARCH" }, artifactSha: "s" + i, op: "phase.advanced" });
}
`);
  seedTasks(db0, 500, "RESEARCH");             // bt:0 .. bt:499, all at generation 1
  db0.close();
  const kid = spawn(process.execPath, [worker, p], { stdio: "ignore" });
  // IMMEDIATELY after spawn, before the probe is opened. 500 fast transactions
  // can finish while the setup below runs, and EventEmitter does not replay a
  // missed event -- so a listener attached later never fires: the race falls
  // through to `timeout`, `kid.kill` targets an exited process, and `await exit`
  // hangs the suite forever. A hanging test is worse than a failing one.
  const exit = new Promise((res) => kid.on("exit", () => res("exited")));
  // Wait for OBSERVED progress rather than a fixed delay: a sleep long enough to
  // be safe on a fast machine is long enough to miss the window on a slow one,
  // and a sleep that lands after the loop finished is the SIGSTOP bug again.
  // Committed rows prove the child finished a transaction, NOT that it is inside
  // one -- so killing after seeing them can land between iterations, and the
  // drill would still pass against an implementation that writes the projection
  // outside the transaction.
  //
  // SQLite answers the real question directly. While the child holds an open
  // write transaction the database is write-locked, so a BEGIN IMMEDIATE from
  // here fails with SQLITE_BUSY. busy_timeout is set to 0 so it fails instantly
  // instead of waiting the child out. A refusal is positive evidence that a
  // transaction is open RIGHT NOW; that is the moment to kill.
  const probe = new DatabaseSync(p);
  probe.exec("PRAGMA busy_timeout = 0");
  const insideTx = async () => {
    for (let i = 0; i < 500; i++) {
      try { probe.exec("BEGIN IMMEDIATE"); probe.exec("ROLLBACK"); }
      catch { return true; }                   // locked out: the child is mid-transaction
      await new Promise(r => setTimeout(r, 2));
    }
    return false;
  };
  // Watch for the child EXITING as well: 500 fast transactions can complete
  // before the first probe, and then the loop spins to its limit and reports a
  // missed window as a failure of the code rather than of the timing. A child
  // that finished cleanly means the drill has to be re-run with more work, not
  // that atomicity is broken.
  // RACE the probe against the child's exit rather than polling a flag. A
  // boolean checked after insideTx() returns does not stop insideTx() from
  // spinning its full 500 iterations when the child finished early, and the
  // kill then targets a dead pid. Whichever settles first decides.
  const caught = await Promise.race([insideTx().then(v => v ? "locked" : "timeout"), exit]);
  check(caught === "locked",
    "control: the child was observed INSIDE an open write transaction",
    caught === "exited"
      ? "the worker finished before the probe saw a lock: raise the loop count and re-run"
      : "never saw the write lock held; the kill would have proved nothing");
  // (A second, duplicate `check(caught, ...)` used to sit here. It was vacuous:
  // every outcome of the race is a non-empty string, so it passed on "exited"
  // and "timeout" as readily as on "locked".)

  // Kill only if the child is STILL RUNNING, and reuse the one exit promise.
  // `once(kid, "exit")` installs a fresh listener, and EventEmitter does not
  // replay past events -- so when the race was won by `exit`, the child is
  // already gone, the new listener never fires, and the whole suite HANGS
  // rather than reporting red. A hanging test is worse than a failing one: CI
  // reports a timeout with no assertion to read.
  if (caught !== "exited") {
    kid.kill("SIGKILL");
    await exit;                       // already resolved if it has since exited
  }
  probe.close();

  const back = openHub(p);
  const torn = back.prepare(`
    SELECT t.id, t.phase, (SELECT count(*) FROM phase_event e WHERE e.task = t.id) AS events
    FROM task t
    WHERE (t.phase = 'DESIGN'   AND events = 0)      -- moved with no record
       OR (t.phase = 'RESEARCH' AND events > 0)`).all();
  check(torn.length === 0,
    "after SIGKILL every task's projection and log agree: each either moved with its event, or neither",
    torn.slice(0, 5).map(r => `${r.id} phase=${r.phase} events=${r.events}`).join("; "));
  const pe = back.prepare("SELECT count(*) c FROM phase_event").get().c;
  const he = back.prepare("SELECT count(*) c FROM hub_event WHERE kind='task.transitioned'").get().c;
  check(pe === he, "and hub_event agrees with phase_event, because they are written in one transaction",
    `phase_event=${pe} hub_event=${he}`);
  check(pe > 0 && pe < 500,
    "control: the kill really did interrupt the run, so this is a torn-write test and not a no-op",
    `${pe} of 500 transitions committed`);
  back.close();
}

// ── an inflight effect whose drainer died is recovered, not silently retried ──
{
  const db = openHub(join(dir, "rec.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "k", kind: "gh.pr.create", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn });
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${leased.id}`);

  // The important part: an expired inflight row goes to its RECONCILER, not
  // straight back to pending. Returning it to pending would perform the effect
  // a second time whenever the first one had actually landed.
  let asked = null;
  recoverEffects(db, { reconcile: (row) => { asked = row.kind; return { settled: true, ok: true, result: { pr: 7 } }; } });
  check(asked === "gh.pr.create", "an expired inflight row is handed to its reconciler", String(asked));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(leased.id).status === "done",
    "and settled from external truth");

  const db2 = openHub(join(dir, "rec2.db")); seed(db2, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db2, () => enqueueEffect(db2, { idempotencyKey: "k", kind: "gh.pr.create", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const l2 = leaseEffect(db2, { worker: "w", capabilities: allOn });
  db2.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${l2.id}`);
  recoverEffects(db2, { reconcile: () => ({ settled: false }) });
  check(db2.prepare("SELECT status FROM outbox WHERE id=?").get(l2.id).status === "pending",
    "control: a reconciler that cannot decide returns the row to pending, so it is retried rather than lost");
}

// ── a corrupt hub refuses to open and points at the last good snapshot ───────
{
  // The DISCOVERABLE hub path, not the harness's `dir`. snapshotAll finds stores
  // through `everyStore(home)`, which looks for the hub under home/state; the
  // injected `open` only changed HOW a discovered path was opened and could not
  // add an unrelated file to the discovery set. So nothing was snapshotted,
  // `latestSnapshot` stayed null, and the fixture assertion failed while
  // reporting itself as a corruption-handling defect. Dropping the injection
  // also removes a seam that made the drill look wired when it was not.
  const p = join(home, "state", "hub.db");
  openHub(p).close();
  // A known-good snapshot FIRST. The refusal is required to name the newest
  // usable snapshot by path, and in an isolated test directory there is none --
  // so `latestSnapshot` returns null and the final assertion fails on fixture
  // setup while reporting itself as a corruption-handling defect.
  snapshotAll(home, root, { at: Math.floor(Date.now() / 1000) - 60 });
  check(latestSnapshot(root, "hub") !== null,
    "fixture: a usable snapshot exists for the refusal to name", String(latestSnapshot(root, "hub")));
  // Corrupt a page the database ACTUALLY USES, derived from the file rather than
  // hardcoded. Offset 8192 is page 3; it is a live page here only because
  // openHub creates 32 tables and their indexes (67 pages, measured 2026-08-23
  // in docs/measured/2026-08-23-sqlite-page-corruption.md). A fixture of two
  // pages or fewer takes that write past the end of the file, integrity_check
  // still answers `ok`, and every assertion below passes having corrupted
  // nothing -- which is the exact failure this drill exists to rule out.
  const geom = new DatabaseSync(p, { readOnly: true });
  const pageSize  = geom.prepare("PRAGMA page_size").get().page_size;
  const pageCount = geom.prepare("PRAGMA page_count").get().page_count;
  geom.close();
  const fd = openSync(p, "r+");
  writeSync(fd, Buffer.alloc(pageSize, 0x41), 0, pageSize, (pageCount - 1) * pageSize);
  closeSync(fd);

  // CONTROL, and the durable half: prove the file is really broken before
  // asserting that openHub says so. If the technique ever stops corrupting
  // anything, this goes red instead of letting the assertions below pass
  // vacuously.
  const probe = new DatabaseSync(p, { readOnly: true });
  let integrity = null;
  try { integrity = Object.values(probe.prepare("PRAGMA integrity_check").get())[0]; }
  catch (e) { integrity = `threw: ${e.message}`; }
  finally { probe.close(); }
  check(integrity !== "ok", "control: the fixture really is corrupt now", String(integrity));

  let why = null;
  try { const d = openHub(p); d.prepare("SELECT count(*) FROM task").get(); } catch (e) { why = e.message; }
  check(why !== null, "a corrupt hub does not open silently");
  // Name the actual newest snapshot, not the word "snapshot". The interface
  // promises the path an operator should restore, and `/snapshot/i` passes on a
  // generic "the snapshot is unreadable" that tells them nothing.
  const newest = latestSnapshot(root, "hub");
  check(newest && (why ?? "").includes(newest),
    "and the refusal names the newest usable snapshot by path", `${why}\n        newest=${newest}`);
}
```

- [ ] **Step 2–4: Run it red, implement, run green, commit**

**On the broken implementation** — a `recoverOutbox` copied from `ops.mjs`, which sets expired inflight rows straight back to `pending` — the crash and corruption blocks pass and one line goes red: `an expired inflight row is handed to its reconciler`. That copied behaviour is safe for the guardian, whose effects are re-pollable, and it is a double-merge for the hub. The `control:` beneath it stops the fix from becoming "never retry anything".

```bash
$N test/hub-drills.test.mjs
git add test/hub-drills.test.mjs src/build/hubdb.mjs src/build/outbox.mjs
git commit -m "test(hub): crash, recovery and corruption drills"
```

---

### Task 20: PR-B close-out

- [ ] **Step 1: Full suite**

```bash
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac   # writes into the live daemon's ~/.reeve/canary
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
exit $fail
```

The accumulator is not decoration: `|| echo` turns a failure into a successful
`echo`, so the loop exits with the status of whichever test ran last, and an
automated executor proceeds to the tracker commit and the PR on a green signal
over a red suite.

Expected: no `FAILED` lines. Base is PR-A's merge commit, not `9dbd3a0` — measure this pass against the one base PR-B started from.

- [ ] **Step 2: Verify the §14 S2 Verify clause, item by item**

| Verify item | Where it is proven |
|---|---|
| transition-matrix table test | Task 14, `test/hub-phases.test.mjs` totality block |
| including the GATE → ESCALATED edge | Task 14, named-edges block |
| and the CANCELLING exclusion | Task 14, `NON_TERMINAL` assertion + the three CANCELLING refusals |
| CAS lost-race no-op | Task 15, lost-race block |
| generation fence rejects a stale row | Task 15, generation block; Task 16, fence block |
| 20-way lease race with one winner | Task 7, 20 real child processes |
| second `build run` refuses naming the holder | Task 7, refusal block + `bin/reeve` |
| guardian FIX_CI claims and releases a provider lease | **PR-C**, Task 22 |
| guardian hub connection allowlist test | **PR-C**, Task 23 |
| the guardian's verdict actually reads `pr_hold` | **PR-C**, Task 23b |
| crash drill | Task 19 |
| corruption drill | Task 19 |
| duplicate-delivery drill | Task 16, all ten kinds delivered twice |
| destructive restore drill over the comparison set | Task 9 |
| restore refuses while a writer is live | Task 9 |
| `ci.flakePatterns` decided | Task 12 + `docs/measured/2026-08-22-flakepatterns-has-no-readers.md` |

- [ ] **Step 3: Tracker line last, then push and open the PR**

```bash
git add docs/TRACKER.md && git commit -m "docs: tracker — S2 PR-B"
git push -u origin feat/s2-phase-machine
gh pr create --title "S2 PR-B: the phase machine and its effects" --body-file - <<'BODY'
The pure, total transition matrix; the one generation-fenced transition
transaction; the fenced outbox with live-rows-only key uniqueness; the registry
snapshot; the repo_gate_state derivation behind an injected fetcher; and the
crash, recovery, corruption and duplicate-delivery drills.

Still no builder worker is dispatched, and no GitHub call is made from any code
path in this PR.

## Review focus

- `phases.mjs` imports nothing. Please check the matrix against section 3.1 line
  by line; the totality test proves every cell answers, not that each answer is
  the right one.
- The generation in the CAS predicate (`transition.mjs`) and the fence
  revalidation inside the lease transaction (`outbox.mjs`) are the two places a
  stale attempt could act under a contract nobody approved.
- `recoverEffects` deliberately does NOT copy `ops.mjs`'s behaviour of returning
  expired inflight rows to pending. For the guardian that is safe; for the hub
  it is a second merge.
BODY
gh pr comment --body "@codex review"
```

**Do not merge.** Founder grant required.

---

---

## Self-review

**Spec coverage.** §3.1 the full 21-state enumeration and every edge (Task 14); §3.2 transition discipline, generation fences, the outbox key rules (Tasks 15-16); §3.4 both held states and their exits, including territory re-grant (Tasks 14-15); §3.5 CANCELLING, the drain set, and `--force` (Tasks 14-15); §1.5 the registry snapshot, network first and transaction second (Task 17); §9.1 `repo_gate_state`'s pure derivation (Task 18); §12's crash, corruption and duplicate-delivery rows (Tasks 16, 19).

**Placeholder scan.** Clean.

**Type consistency.** `nextPhase(state, evidence) -> {ok, to, generation, bumps, sliceCursor, escalate, persistDepth, compensations} | {ok:false, refusal, stackable?}`; the compensation set is closed at **fourteen** names and every one has an `applyCompensation` branch, asserted by a consistency check — the defect that check exists for (`regrant-territory` emitted with no implementation) was found by review, not by me. `enqueueEffect -> {id, status}` with `status ∈ {pending, duplicate, superseded}`.

**The obligation this plan owes S2-A.** Every new `hub_event` kind here must be added to `replay.mjs`'s `HANDLERS` and, where it belongs in the projection, to `COMPARISON_SET`. Three separate review findings were events written and never replayed (`task_territory`, `task_drain`, `phase_event`). A new kind without a handler is a fact the hub cannot get back.
