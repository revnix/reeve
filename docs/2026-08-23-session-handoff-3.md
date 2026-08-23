# Session handoff: the S2 plan programme (2026-08-23)

Written at the end of a long session, for a fresh session with no memory of it.
Everything here is either measured (with the command) or labelled as intent.
The companion resume prompt is `docs/2026-08-23-resume-prompt-3.md`.

---

## 1. Where things stand, in one table

| | |
|---|---|
| Repository | `revnix/reeve` (private) |
| `origin/main` | `e41cd28` — "Judge every path a push would carry…" (#10) |
| Live daemon | **RUNNING** from `~/Work/Products/reeve` against `nextlyhq/nextly` under launchd `KeepAlive` |
| Work in flight | three **plan** PRs (documents only, no `src/` changes) |
| Merged this session | **#9** (reviewer refusal patterns) |
| Closed this session | **#8** (the combined S2 plan, superseded by the split) |
| Watcher | session cron `b6f5c1bd`, `7-59/15 * * * *` — **dies with the session, must be re-armed** |

### The three open PRs

| PR | Branch | Worktree | Head | Threads | Open |
|---|---|---|---|---|---|
| **#11** S2-A: the hub store | `plan/s2a-hub-store` | `~/Work/Products/reeve-wt/pa` | `69cccdf` | 46 | **0** |
| **#12** S2-B: the phase machine | `plan/s2b-phase-machine` | `~/Work/Products/reeve-wt/pb` | `73086e7` | 72 | **12** |
| **#13** S2-C: the provider scheduler | `plan/s2c-provider-scheduler` | `~/Work/Products/reeve-wt/pc` | `6209dda` | 75 | **13** |

**193 review threads total. 25 open. No Codex clean pass on any PR yet.**
**Nothing may be merged without Mobeen's explicit per-PR grant.**

---

## 2. What this programme is

reeve is an agent-ops control plane. Today it is a **guardian**: per-repo daemons
that watch PRs, publish an `ops/merge-policy` check, and dispatch CI-fixing
workers. The **builder programme** makes reeve also run a task end to end —
research → design → spec → implement → PR → gate → merge.

The design is `docs/2026-08-21-builder-design.md` (997 lines, founder-approved).
Its §14 defines rollout stages S0–S10. **S1 is complete** (PRs #3–#6). This
session was about **S2: hub core** — the store, the phase machine, and the
provider scheduler.

S2's authority is §14's S2 paragraph; its *Verify:* clause is the definition of
done. The binding sections are §1.2, §1.3, §1.4, §1.5, §1.6, §3.1–§3.5, §7.6,
§9.1, §9.3, §9.6, §10.1–§10.4, §11.1, §11.2, §11.4, §11.7, §12, §13.

**S2 ships no worker dispatch.** `worker.isolation` is `none` and dispatch is
refused in code. S2 does not change that.

---

## 3. What happened this session, in order

1. **Wrote the S2 plan** as one 5,300-line document (`2026-08-22-s2-hub-core.md`),
   opened as **PR #8**.
2. **Found and fixed a live defect** in reviewer refusal patterns → **PR #9,
   merged**, and the live profile updated (see §5).
3. **PR #8 went four Codex rounds: 15, 10, 13, 16 findings = 54.** Not
   converging. A majority of each round after the first was caused by the
   *previous round's own fixes*.
4. **Split the plan into three** along the PR boundaries it already declared,
   founder-approved. #8 closed as superseded; **#11, #12, #13** opened.
5. **Armed a 15-minute watcher** and worked review rounds continuously: 54 more
   findings in round 1 of the split, then 36, then 33, then 32.

### Cumulative findings per plan

| | r1 | r2 | r3 | r4 | r5 |
|---|---|---|---|---|---|
| **A** (#11) | 16 | 13 | 4 | 6→0 | 7→0 |
| **B** (#12) | 21 | 14 | 18 | 7→0 | 12 open |
| **C** (#13) | 17 | 9 | 22 | 14→0 | 13 open |

All three have reached zero at least once. Re-openings are **new rounds against
newly-added text**, not regressions — every fix adds surface.

---

## 4. Founder decisions — do not re-litigate

1. **S2 splits into three PRs**, A → B → C, scheduler last because it is the only
   one that changes the running guardian.
2. **The guardian fails OPEN** when `hub.db` is missing, locked or corrupt: it
   dispatches exactly as today and escalates. The builder fails closed. *The
   scheduler restrains the builder; it must never become a new way to silence the
   watchman.* A `ctx` with no `hub` key at all still dispatches — asserted
   directly, which is what keeps all 59 pre-existing guardian tests green.
3. **`ci.flakePatterns` is REMOVED**, live profile stripped in the same change.
   Evidence: `docs/measured/2026-08-22-flakepatterns-has-no-readers.md`.
4. **`repo_gate_state` ships with a real writer** — the table, a pure
   `gateStateFrom()` derivation, and a tick calling it through an injected
   fetcher. No live GitHub call in S2; S8 supplies the client and clause U4.
5. **The three-way split**, approved 2026-08-23 after round 4 of #8.
6. **Fewer PRs.** Fold changes into existing PRs. Do not open new ones for small
   changes. (Founder, 2026-08-23.)

---

## 5. PR #9 — merged and LIVE (the one shipped change)

**Three defects in the seeded reviewer roster**, measured on real bodies from
`nextlyhq/nextly` #1137 and committed as fixtures:

- Codex's `Something went wrong / Unknown error` classified as `null` — chatter,
  indistinguishable from "never spoke".
- CodeRabbit's `Review limit reached` did the same (its `refusal` pattern covered
  only `Review rate limited`).
- `commitPattern` appeared **zero** times in `src/init.mjs`, so a fresh profile
  gave Codex no way to bind a clean pass — every clean degraded to
  `unbound_clean`, never coverage.

**The durable generalisation:** *refusal is one shape per **reason**, not one per
reviewer.* Quota, transient error, rate limit, already-reviewed — each bot spells
each differently, so a single-string pattern is one-shape-short by construction.

**Live profile applied** (`~/.reeve/profiles/nextlyhq/nextly.json`, backup at
`nextly.json.bak-1787420782`). Verified: all four real bodies now classify
correctly. `bin/reeve` loads the profile **once at process start**, so it takes
effect at the daemon's next `KeepAlive` relaunch — no restart was performed.

**Left deliberately unfixed:** `greptile-apps` has no `clean` pattern, so a
greptile pass cannot classify. No greptile body exists on #1135–#1137 to write
one against, and inventing a regex for an unseen body is the mistake the PR is
about.

---

## 6. The three plans

All under `docs/superpowers/plans/`. Each is self-contained: header, global
constraints, the S1 measured facts, founder decisions, a test-harness block, a
file-structure table, its tasks, and its own self-review. B and C additionally
open with a **consumed-interfaces table** naming every symbol they build on.

### `2026-08-23-s2a-hub-store.md` — 13 tasks (#11)
32 STRICT tables with real types/CHECKs/indexes; forward-only migrations applied
under the lock; the three locks (singleton, writer, maintenance); hub-aware
backup with per-store validation; a restore that refuses live writers, stages and
atomically renames, clears process-scoped rows, and replays its own tail; the
destructive drill; the prose-versus-DDL cross-check §11.1 mandates; retires
`ci.flakePatterns`.

### `2026-08-23-s2b-phase-machine.md` — 7 tasks (#12)
`phases.mjs` — pure, total, imports nothing; the full §3.1 matrix (21 states)
tested over the cross product **plus** named-edge assertions; the one
generation-fenced transition transaction with twelve ordered compensations; the
fenced outbox (live-rows-only key uniqueness, round-keyed supersede, fence
revalidation inside the lease tx); the registry snapshot (network first,
transaction second); `repo_gate_state`'s pure derivation; crash, corruption and
duplicate-delivery drills.

### `2026-08-23-s2c-provider-scheduler.md` — 5 tasks (#13)
`src/build/providerdb.mjs` (SQL) + `src/provider.mjs` (policy); transactional
admission, guardian reservation, queued-guardian blocking, cooldown, reaping,
preemption flag; the guardian-side claim failing **open**; `openHubAsGuest` built
on **SQLite's `setAuthorizer`**; and **Task 23b** — the verdict clause that
actually reads `pr_hold`.

### `2026-08-23-s2-review-history.md`
#8's self-review and its four revision rounds. Kept because much of the plans'
reasoning lives there, and because the split was a conclusion drawn from the
pattern in those rounds.

---

## 7. Cross-document invariants — check these after any edit

- **32 tables** in A's `hub.sql`.
- **The `task.phase` CHECK in A must equal `phases.mjs`'s
  `ACTIVE ∪ HELD ∪ DRAINING ∪ TERMINAL` in B**, at 21 states. The assertion
  comparing them lives in **B** (A cannot import a module that does not exist
  until B).
- **Every `COMPARISON_SET` table exists in A's DDL and has a replay handler**,
  and every table marked `replayed: false` has *no* handler (both directions).
- **Every compensation `phases.mjs` can emit has an `applyCompensation` branch**
  (12 today). A `default:` branch throws.
- **Columns B or C need go into A's migration 1** while it is still editable, and
  are recorded in the consuming plan's consumed-interfaces table. Already done:
  `preempt_requested`. Already **removed** after review: `refused_release` (it
  could not be written in the only scenario it represented — `assertWritable`
  blocks that write while the lock is held — and `restoreHub` clears
  `provider_lease` anyway).

---

## 8. What remains — the 25 open findings

### #12 (S2-B) — 12 open

| Thread | Finding |
|---|---|
| `PRRT_kwDOT-hWms6beCgr` | `CLAIMING` needs a durable claim-success witness; a generic `phase.succeeded` advances it |
| `PRRT_kwDOT-hWms6beCgs` | `regenerate` from `IMPL_PR_OPEN`/`VERDICT_WAIT` must close or hold stale slice PRs |
| `PRRT_kwDOT-hWms6beCgu` | §10.1's **submodule** path refusal is missing from the claim grammar |
| `PRRT_kwDOT-hWms6beCgv` | the App permission `FULL` set is incomplete (only checks/contents/pull_requests) |
| `PRRT_kwDOT-hWms6beCgx` | a bare `{kind:"phase.succeeded"}` with no `phase` still advances |
| `PRRT_kwDOT-hWms6beCgz` | `task.depth` is never persisted by an accepted depth override |
| `PRRT_kwDOT-hWms6beCg0` | a live `--pin-territory` must survive BLOCKED entry |
| `PRRT_kwDOT-hWms6beCg1` | outbox writers (`leaseEffect`/`settleEffect`/`recoverEffects`/`voidPending`) must call `assertWritable` |
| `PRRT_kwDOT-hWms6beCg2` | the close-out suite loop must return a failing exit status |
| `PRRT_kwDOT-hWms6beCg4` | cancellation must terminate the live worker (§4.5) |
| `PRRT_kwDOT-hWms6beCg7` | `DONE` must refuse when finalization effects **failed**, not only when pending |
| `PRRT_kwDOT-hWms6beCg9` | `buildTick` is called by a test and defined by no task |

### #13 (S2-C) — 13 open

| Thread | Finding |
|---|---|
| `PRRT_kwDOT-hWms6beGsU` | move the lease claim to the final spawn seam, after every refusal path |
| `PRRT_kwDOT-hWms6beGsV` | supply concrete claim/release wiring around the containment canary |
| `PRRT_kwDOT-hWms6beGsX` | actually drain `ctx.pendingReleases` at the start of a tick |
| `PRRT_kwDOT-hWms6beGsY` | restrict `maintenance_lock` guest writes to `DELETE` only |
| `PRRT_kwDOT-hWms6beGsc` | prevent callers from replacing the SQLite authorizer |
| `PRRT_kwDOT-hWms6beGsh` | handle `SQLITE_FUNCTION` for a closed list of SQL functions guest queries use |
| `PRRT_kwDOT-hWms6beGsk` | read the repo id from a source that actually carries it |
| `PRRT_kwDOT-hWms6beGsl` | scope queued reconciliation to the current repository |
| `PRRT_kwDOT-hWms6beGsm` | define `repoId` before the top-of-tick sweep uses it |
| `PRRT_kwDOT-hWms6beGsn` | add the promised `evaluatePr` routing assertion |
| `PRRT_kwDOT-hWms6beGsp` | break the circular dependency between Tasks 22 and 23 |
| `PRRT_kwDOT-hWms6beGsq` | import `DatabaseSync` and the authorizer constants |
| `PRRT_kwDOT-hWms6beGss` | build `live` from dispatch-worthy requests only |

**#11 has 0 open** and is awaiting its next round.

---

## 9. After the plans: what S2 actually needs next

The three PRs are **plans**, not code. Once each is approved and merged:

1. Execute S2-A → real `src/build/hub.sql`, `hubdb.mjs`, `locks.mjs`,
   `replay.mjs`, `tables.mjs`, backup/restore, doctor, tests.
2. Execute S2-B → `phases.mjs`, `transition.mjs`, `outbox.mjs`, `registry.mjs`,
   `gatestate.mjs`, drills.
3. Execute S2-C → `providerdb.mjs`, `provider.mjs`, `hubguest.mjs`, the daemon
   claim, the `pr_hold` verdict clause. **This one changes the running guardian**;
   its effect begins at the daemon's next restart, which is a founder-timed act.

Then S3 onward per §14. Also standing from the tracker: PR-3 (S1 close-out,
`feat/s1-standalone-clones`) is another session's and still in flight.

---

## 10. Hard rules

- **Never merge.** Every PR needs Mobeen's explicit, per-PR grant. A grant is
  spent when used.
- **Never `--no-verify`.** Conventional Commits, lowercase, `type(scope): subject`,
  ≤72 chars. **No Claude attribution anywhere.**
- **Do not** restart the reeve daemon, run `launchctl`, run `reeve canary`, or
  `git pull` in `~/Work/Products/reeve`. A live guardian runs from that checkout
  and `reeve canary` writes a shared state file the daemon reads.
- **Work in worktrees only** (`~/Work/Products/reeve-wt/{pa,pb,pc}`).
- **`docs/TRACKER.md` conflicts on every branch.** One line, added as the last
  commit before opening a PR. B and C deliberately do not touch it.
- **Fold changes into existing PRs.** Do not open new PRs for small changes.
- **`test/escape.test.mjs` must be excluded** from routine suite runs: it writes
  decoys into the shared `~/.reeve/canary/` tree the live daemon reads.
  Baseline: 59 test files, 58 run, 58 pass (measured on `9dbd3a0`); two files
  carry one `SKIP` each.

---

## 11. Measured facts that constrain the work

Recorded under `docs/measured/`. Do not re-derive.

| Fact | Consequence |
|---|---|
| A permission rule takes an absolute path only with **two** leading slashes | `Read(/Users/x/**)` matches nothing, silently |
| The file tools are **not** covered by the OS sandbox | Never argue a file is safe because a worker is sandboxed |
| A deny containing the worker's checkout refuses it its own files | Never write one |
| A scratch HOME closes the keychain **search list**, not the keychain | Read the correction banner on that doc |
| `pull_request.updated_at` does **not** change on thread resolution | Measured by toggling a thread on a merged PR (revnix/reeve #4) — byte-identical across unresolve **and** re-resolve. Any polling guard built on it is blind |
| Codex splits its verdict across **two** endpoints | Findings = a review object; a clean pass = an **issue comment**; "Something went wrong" = a third, also an issue comment |
| `ci.flakePatterns` had zero readers; the validator refuses unknown keys **including empty arrays** | Removing it from `FIELDS` alone would kill every daemon start |
| `DatabaseSync` on node v24.17.0 exposes **17** methods | `applyChangeset`, `deserialize`, `loadExtension` — gating `prepare`/`exec` is not a boundary; `setAuthorizer` is |
| `isSameProcess(pid, storedStart)` is the liveness predicate (`supervisor.mjs:67`) | `pidAlive` does not exist |
| `measuredContainment` at `daemon.mjs:763`, halt check at `792` | The halt check is **after** the canary |
| The OPS HEALTH "ledger render failed" banner is a false alarm | cwd-dependence plus `session-health.sh:22` discarding the diagnostic |

---

## 12. Mistakes made this session, and what they cost

These are the durable value. Each was caught by review or by a control, not by
intuition.

1. **A test that passes either way proves nothing — violated twice in my own
   plan.** The 20-way lease race used `execFileSync`, which blocks, so twenty
   children ran *sequentially* and a non-transactional implementation passed. The
   crash drill `SIGSTOP`ped *before* the transaction began, so it always observed
   the untouched branch. Both now use real barriers and a SQLITE_BUSY probe.
2. **Fixing an instance instead of the class — four times.** `task_territory`
   replayed but not `task_drain`; the stacked-hold branch fenced but not the
   general refusal branch, then not the artifact refusal; `provider_state`
   seeded in one test file and not its sibling; `pidAlive` fixed in C and left in
   A and B. **When a finding names one instance, sweep the class.**
3. **A script that aborts before its write saves nothing.** Several batched
   patches printed `ok:` for changes that were never written, because a later
   anchor missed and the exception preceded the `open(P,"w")`. This silently lost
   a `reeveHome()` → `HOME` fix and a `pidAlive` sweep. **Verify counts in the
   same run as the write.**
4. **`head`-ing an absence search.** `grep -n pidAlive … | head -6` reported
   absence that was truncation. My own documented rule.
5. **A blind global replace inverted an explanatory comment** into a false
   statement. Sweeps need their prose checked.
6. **Adding a mechanism whose need was already covered** — `refused_release`
   could not be written in the only case it existed for, and `restoreHub` already
   cleared the rows. Twice this session.
7. **Claiming a capability nobody calls.** `pr_hold` had a permitted reader for
   two rounds and no reader. Permission is not wiring.

---

## 13. Working method that has been effective

- **Verify every bot claim against the actual text or source before acting.**
  Several were subtly mis-stated; several were sharper than they first read.
  Roughly one in ten needed the finding reframed rather than applied.
- **Patch with asserted anchors.** Every text edit asserts its anchor matched
  exactly once. A bad anchor means nothing was written — and the whole script
  writes nothing, so re-verify after any abort.
- **Reply *and* resolve** every thread via GraphQL. Replying alone does not clear
  it.
- **Re-run the §7 invariants** after each batch, then commit, push, and comment
  `@codex review` — on **every** push, not only the first.
- **Read both endpoints.** A clean pass will not appear in `pulls/N/reviews`.

---

## 14. Environment

```
Node          ~/.nvm/versions/node/v24.17.0/bin/node    (PATH node is v22; node:sqlite warns there)
Repo          ~/Work/Products/reeve                      (LIVE daemon — read-only for us)
Worktrees     ~/Work/Products/reeve-wt/{pa,pb,pc}        (#11, #12, #13)
              ~/Work/Products/reeve-wt/s2                (the closed #8 branch — still holds recoverable history)
Profiles      ~/.reeve/profiles/<owner>/<repo>.json
Hub (future)  ~/.reeve/state/hub.db                      (does NOT exist yet; S2 creates it)
Suite         for f in test/*.test.mjs; do case "$f" in */escape.test.mjs) continue;; esac; $N "$f"; done
```

**Peer sessions:** several other Claude sessions run concurrently on this
machine, mostly in `~/Work/Products/nextly-workspace/nextly`. Coordinate via
`ListAgents` + `SendMessage` before claiming territory. As of this handoff none
were working reeve's source.

---

## 15. Open questions for the founder

1. **What does "good enough to merge" look like for a plan?** 193 threads, 25
   open, no clean pass. The findings are real and getting narrower, but each fix
   adds text and each text addition is new surface. There is no natural stopping
   point. A cap ("merge at zero-open regardless of whether a further round would
   find more") would end it; so would a Codex clean pass, if one ever arrives.
2. **Merge order and grants.** Intended A → B → C. Each needs its own grant.
3. **Does `greptile-apps` need a `clean` pattern?** It cannot classify a pass
   today. Deliberately unfixed: no observed greptile body exists to write one
   against.
4. **The off-device backup destination** (§16.2) is still undecided; doctor
   reports it missing.
