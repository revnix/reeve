# S2 plans: review history

The three S2 plans (`s2a-hub-store`, `s2b-phase-machine`, `s2c-provider-scheduler`) were split out of a
single 5,300-line document, `2026-08-22-s2-hub-core.md`, after four Codex review rounds on revnix/reeve#8
found **54 defects**. This file is that document's self-review and its four revision rounds, kept because
the reasoning behind many decisions in the three plans lives here, and because the split itself was a
conclusion drawn from the pattern in these rounds rather than a preference.

Findings per round: **15, 10, 13, 16** — not converging. A majority of each round after the first was
caused by the previous round's own fixes, because each edit landed in a document whose parts referenced
each other and the local change could not see its neighbourhood. That is evidence about plan size, not
about review quality, and it is why the plans are now three.

---

## Self-review

Run against `docs/2026-08-21-builder-design.md` §14 S2 and the sections its paragraph names.

### 1. Spec coverage

Every clause of the S2 paragraph, and where it lands:

| S2 clause | Task |
|---|---|
| STRICT schema with migrations (§11.1, §11.2) | 1–5 |
| including `pr_hold` | 4 (DDL), 15 (writer), 23 (guardian reader) |
| `harness_acceptance` | 3; sole writer stated in 11's checklist |
| `project_authority` | 4; sole writer `reeve build authority` |
| `repo_gate_state` | 4 (DDL), 18 (writer), 10 (reporter) |
| generations and fences | 15 (CAS predicate), 16 (fence revalidation) |
| the generation-aware inbox | 5 |
| the fenced outbox with the non-voided key index | 5 (`outbox_live_key`), 16 (behaviour) |
| registry snapshot | 17 |
| singleton lease | 7 |
| the provider scheduler | 21 |
| with the guardian-side claim in this same stage | 22 |
| backup, restore and self-audit (§11.4) | 8, 9, 10 |
| the pure phase machine with CANCELLING and both held states | 14 |
| *Verify:* every item | the table in Task 20, completed in Task 24 |
| `ci.flakePatterns` decided | 12, with `docs/measured/2026-08-22-flakepatterns-has-no-readers.md` |

**Gaps deliberately left, and why.** The tick that *calls* `refreshGateState` against live GitHub is S8's (founder decision 4); S2 ships the table, the pure derivation, and the seam. `reeve build pause --drain`, `authority`, `task file` and the rest of §11.6's CLI are S4 onward; S2 ships only `build run`'s lease and `build status`, because the Verify clause names exactly one CLI behaviour ("a second `build run` refuses naming the holder"). `intake_event` and `ownership_check` have tables and stated owners but no writers until S5; the cross-check records that, and Task 11's checklist names the S5 module for each rather than leaving the writer column blank.

### 2. Placeholder scan

No "TBD", "implement later", "add error handling", or "similar to Task N". Two places name work outside S2 explicitly rather than vaguely: Task 18's fetcher (S8) and Task 11's S5 writers. Task 11 additionally ships a test that **fails** if `TABLE_OWNERS` contains `TBD`/`TODO`/`unknown`/`N/A`, since auto-filling that file is the most likely way an executor makes the cross-check green without doing it.

Three code blocks are given as shape plus a stated rule rather than line-for-line: `applyCompensation` (Task 15), `openHubAsGuest`'s parser (Task 23), and `normalizeClaim`/`overlaps` (Task 17). Each names its closed input set and the property its test asserts, so the test defines the contract completely. Every other step carries the real code.

### 3. Type consistency

- `hubPathFor(home)` — Task 1, used in 8, 9, 22.
- `openHub(path)` / `hubTx(db, fn)` / `hubEvent(db, {kind, task, payload}) -> seq` — Tasks 1 and 6, used throughout. `hubEvent` never opens its own transaction, asserted in Task 6 and relied on in 15, 16, 18.
- `nextPhase(state, evidence) -> {ok, to, generation, bumps, compensations} | {ok, refusal}` — Task 14; `applyTransition` in Task 15 consumes exactly those field names, and `compensations` is the same closed seven-member set in both.
- `enqueueEffect(db, {...}) -> {id, status}` where `status ∈ {pending, duplicate, superseded}` — Task 16; called from `applyTransition` (Task 15) with `{...e, taskId, generation, fence: seq}`.
- `claimProvider(db, {...}) -> {ok, id} | {ok:false, reason, until}` where `reason ∈ {queued, cooldown, at-limit}` — Task 21; consumed in Task 22, which reads `got.reason` and `got.until`.
- `COMPARISON_SET` — Task 9, imported by Task 9's drill and Task 10's doctor; one definition, never two lists.
- `PHASES` appears in three places and all three are asserted equal: the `task.phase` CHECK (Task 2), `phases.mjs` (Task 14), and the cross-check that compares them (Task 14 Step 4).
- `lstart` is a required string everywhere it appears (`locks.mjs`, `provider.mjs`, `phase_run`, `directory_lease`) and is never defaulted, because it is the only thing distinguishing a reused pid.

### 4. The house rule this plan is most likely to be judged on

Every task's test step states what the test looks like **on the broken implementation**, and names which assertions carry the task versus which are scaffolding. Where a set of refusals could be satisfied by an implementation that refuses everything, a `control:` assertion is written beside them and called out — Task 9's `with nothing live, restore proceeds`, Task 15's `the SAME call at generation 4 succeeds`, Task 16's four controls, Task 22's `a ctx with no hub key at all still dispatches`, Task 23's `an ordinary hub connection reads task normally`. Those controls are the difference between a green suite and a green suite that means something.

### 5. Checks actually run while writing this plan

Stated so nothing here reads as verified that was not.

| Check | Command | Result |
|---|---|---|
| Test baseline | `for f in test/*.test.mjs; do $N "$f"; done` on `9dbd3a0`, **excluding `test/escape.test.mjs`** | 58 files run, 58 passed, 0 failed. `escape.test.mjs` was not run: it writes decoys into the shared `~/.reeve/canary/` that the live daemon reads. **The run was made with `node_modules` absent**, and a green file can hide a skip, so skips were counted separately rather than assumed to be zero: exactly two files report one `SKIP` each (`policy-self-exclusion`, `supervisor-contract`). `canary.test.mjs` does not skip — it drives `sandboxCanary` through an injected runner and needs no binary. |
| Table count | count of distinct `CREATE TABLE IF NOT EXISTS` in this plan | 32, matching the assertion in Task 11. |
| `PROSE_TABLES` vs the plan's DDL | set difference, both directions | The only difference is `task_drain`, which is exactly the declared deviation from §11.2's `drain_set` column. Nothing else diverges in either direction. |
| Phase enumeration | the `task.phase` CHECK vs `phases.mjs` `ACTIVE ∪ HELD ∪ DRAINING ∪ TERMINAL` | Identical, 21 states (14 + 2 + 1 + 4). Against §3.1's own sentence the naive extraction reports 24, because the surrounding prose names `REVISING`, `BUILD_SPEC` and `PHASE_FAILED` — each of which §3.1 explicitly says is **not** a state. 21 is right and the three extras are a regex artifact, not a disagreement. |
| Placeholder scan | case-insensitive counts for `TBD`, `FIXME`, `implement later`, `fill in`, `add appropriate`, `handle edge cases`, `Similar to Task`, `write tests for the above` | Every hit is a mention, not a use: the guard test in Task 11 that forbids them, its explanation, and this self-review's own sentence. Zero placeholders. |
| `ci.flakePatterns` | `git grep -n` over `src/`, plus a validator run against the live profile with a positive control | Recorded in full in `docs/measured/2026-08-22-flakepatterns-has-no-readers.md`. |
| `everyStore` cannot see the hub | read of `src/backup.mjs:73` (`if (!o.isDirectory()) continue`) | Confirmed by reading the code, not by running it. Task 8's first assertion is what turns it into evidence. |

**Not run, and therefore not claimed:** none of the code in this plan exists yet, so no test in it has been executed. Every "Expected:" line is a prediction the executor must confirm. The isolation rules for this plan forbade running `reeve canary`, restarting the daemon, and editing `src/` or `test/`, and none of those was done.

---

## Revision round 1 (Codex, 2026-08-22)

Fifteen findings at `888bb7fa6d`, all accepted, none disputed. What changed and why:

**Two were this plan's own rule turned back on it.** The Global Constraints say every test step must state what the test looks like on the broken implementation, and a test that passes either way proves nothing. Two tests in the first draft passed either way:

- **The 20-way lease race did not race.** `execFileSync` blocks until each child exits, so twenty of them start sequentially and the first commits before the second opens the database — a read-then-insert implementation with no transaction passes. Now `spawn()` plus a barrier file: every child opens the store, spins until `go` appears, and all twenty contend for the same write. Task 21 reused the pattern, so the same hole existed twice.
- **The crash drill could not crash.** The child `SIGSTOP`ped *before* `applyTransition`, so the transaction never began and the parent always observed the untouched branch. Now the child transitions 500 tasks in a loop and the parent kills it only after observing real progress in the database, with a control asserting the interruption happened. The assertion became the invariant over every task — a projection and a log that disagree — rather than one task's two possible states.

**Nine were correctness defects in code the plan asserts.** The guest allowlist excluded `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, which `hubTx` needs, so it would have refused the guardian its own admission transaction. `pr_hold`'s replay upsert named a key with no matching UNIQUE constraint and would have thrown on the first hold. `RATE_LIMIT` and `result` do not exist at that dispatch site; rate limits are already normalised to `OUTCOMES.RATE_LIMITED` (`src/daemon.mjs:1222`), so re-matching a regex would have been a second, weaker classifier for a settled question. `ctx.lstart` was never populated, and an empty lstart can never match a live probe, so every guardian claim would have looked dead to the reaper. `UPDATE provider_state` on a fresh hub changes zero rows, so that test silently ran on the 2/1 fallback. `999999.db` is 1970, older than every real snapshot, so the corrupt-snapshot assertion passed without anything being deleted. `SLICE_MERGED` had no exit — invisible to the totality test, because refusal is a legal answer and a state whose every edge refuses looks total. `cancel --force` ignored the `drainMinutes` precondition. `task_territory` was written by a filing and never replayed.

**Two were incompleteness.** `withWriterLease` checked and inserted in separate transactions, leaving a window for a restore to take the maintenance lock between them; both halves are now one `BEGIN IMMEDIATE`. The duplicate-delivery drill leased and performed the second copy without consulting a reconciler, which is the mechanism that makes re-delivery inert — so it would have reported duplicate delivery as working when it was not.

**Two were declared-but-absent.** `hubFindings` promised H-1 through H-6 and emitted three; H-2, H-3, H-6 and the stale-lease branch of H-5 are now implemented. `provider_lease` had no uniqueness over live requests, so a capacity-blocked guardian re-queued on every tick and "no guardian is queued" could never come true again.

**One thing this round confirms about the plan's own structure.** The three-PR split was chosen because S2 is ~20 files against a 10-file budget. The review argues for it on different grounds: fifteen findings landed on the *document*, and nine of them were defects in code that no test had yet run. A single PR carrying all of S2 would have put them behind an implementation that was already underway.

**Checks re-run after the revision:** 32 tables; the `task.phase` CHECK and `phases.mjs` identical at 21 states; comparison set 15 entries, all present in the DDL; prose-versus-DDL difference is `task_drain` alone, as declared; placeholder scan clean (every hit is the guard test that forbids them, or this document describing the scan).

## Revision round 2 (Codex, 2026-08-22)

Ten findings at `c3c5b10`, all accepted. Round 1's fifteen stayed resolved; nothing regressed.

**Two would have destroyed data.** `validateSnapshot` queried `schema_version` unconditionally, but a guardian per-repo store has no such table — so every repository snapshot would have thrown, been classified unusable, and been **deleted by `snapshotAll`**, leaving the hub as the only backed-up store on the machine while reporting success for it. Each store is now validated against its own marker. And `restore --hub` copied the snapshot and returned without replaying the post-snapshot `hub_event` tail: an operator running it would have silently lost every approval, transition and settled effect since the snapshot. The command now captures the tail before replacing the file and replays it after.

That second one is worth naming precisely, because the drill *passed*. It passed because the test held the events in memory and called `replayHub` itself — proving the harness worked and saying nothing about the command. A drill whose green depends on a step only the test performs is a fixture that cannot exhibit the defect.

**One was a class half-swept.** Round 1 added a replay handler for `task_territory` after Codex found it missing. `task_drain` is its exact sibling — also a child table, also written in the same transaction as its parent, also introduced by this plan — and it was not added at the same time. Without it a task restored as CANCELLING reads `drainRemaining = 0`, so `drain.settled` moves it to CANCELLED while the pre-crash effects are still unresolved, which is the one thing §3.5 says CANCELLED must never mean. When a finding names one instance, sweep the class.

**Three were logic the design already specified and this plan restated wrongly.** Depth override before APPROVED must re-dispatch the *current* phase under the new budget (§5), not jump SIZING to DESIGN or fall RESEARCH through to BLOCKED. The stacked-hold branch returned before the CAS and so never fenced, letting a stale caller attach an open hold to a task another transaction had already resumed. `resume_seq` was incremented after the event was emitted, so replay restored the phase and kept the old counter — and §3.2 keys spec pushes by `r<resume_seq>` precisely to keep re-minted rounds distinct.

**Two were contradictions inside the plan's own assertions.** The released-lease test required the row to survive *and* no row to be `held`, which the two-value status CHECK makes unsatisfiable; release deletes the row. `hubFindings` iterated only `repo_gate_state` rows that exist, so a registry project that had never refreshed produced no finding at all — absence read as success on the clause whose entire job is refusing absence.

**Two were advertised behaviour that did not exist.** Provider mutations wrote through `hubTx` without `assertWritable`, so a guardian could take a lease and launch a worker after `restoreHub` had taken the maintenance lock — reopening the race from the one path allowed to write without a writer lease. And `--takeover` was printed as the single recovery command and never parsed, so an operator following the instruction was refused exactly as before. It now waives the expiry half of the check and only that half; liveness is never waived.

**Checks re-run:** 32 tables; DDL and `phases.mjs` identical at 21 states; comparison set 16 entries, all present in the DDL, all with replay handlers.

## Revision round 3 (Codex, 2026-08-23)

Thirteen findings at `a94242b`, all accepted. Rounds 1 and 2 stayed resolved.

**Seven of the thirteen were caused by round 2's own fixes.** That is the finding about this document, and it is worth stating before the individual items:

- Round 2 required every provider mutation to call `assertWritable`. `assertWritable` reads and may delete `maintenance_lock` — which round 1's guest allowlist does not permit. **One fix broke another**, and every ordinary guardian claim would have failed at the maintenance check before reaching `provider_lease` at all.
- Round 2 applied the maintenance-lock rule to the provider path and stopped there. `acquireSingleton` writes the hub too. **A class half-swept**, for the second round running: round 2's own `task_drain` finding was the same shape, after round 1 fixed `task_territory` and left its sibling.
- Round 2 made `restore --hub` replay its tail. It set `locked = false` immediately after the copy, so the exclusion ended before the replay began; and the drill deletes the database file first, so the command it now tests could capture nothing and **the new assertions could not pass at all**.
- Round 2 moved `recordDrainSet` next to the event and left the `record-drain` compensation in place, so it ran twice — and the `(task, outbox_id)` primary key would abort every cancellation that caught an inflight effect.

The common cause is patching at the point of the finding without re-reading its neighbourhood. Each fix was locally right and globally wrong, which is exactly what a reviewer catches and a self-check does not: the plan's own consistency script checks table counts and enumerations, and none of these are visible at that level.

**Three were witnesses the machine did not require.** `VERDICT_WAIT` and `FINALIZING` sat in the generic `phase.succeeded` spine, so a misrouted phase report could move a task to `SLICE_MERGED` with nothing merged, or to `DONE` — terminal, no edges out — with the ledger write-back, the completion comment and the PR close still in flight. Both now leave only on real evidence: the reconciler's `slice.merged`, and `finalize.settled` with a zero outstanding count. And resume returned to `held_from` without re-running the territory intersection check, although entering a held state releases the lease precisely so another task can claim it — so a resume could put two tasks on the same paths at once.

**Three were correctness at the edges.** The `task.transitioned` payload is a row image, so omitting `blocked_reason` meant a replayed BLOCKED task came back with the snapshot's old reason, and a hardcoded `held_from: null` erased where a CANCELLING task must return to; the image is now read back out of the row that was just written, so it cannot drift from the update again. Nothing ever set `task_drain.settled_at`, so every cancellation that caught an inflight effect would have sat in CANCELLING until the drain timeout and required `--force` — the exceptional path becoming the ordinary one. And `provider_one_live_request` omitted `repo_id`, while guardian run refs are `pr:<number>`: PR #9 on two watched repositories is one key.

**Two were operator-facing promises.** H-3 required the snapshot's schema version to *equal* the binary's, though `validateSnapshot` accepts anything lower and `openHub` migrates forward after the copy — so it told an operator to hunt for an old binary in the one case restore already handles. And `build run` claimed the singleton and returned, so the process exited immediately: under `KeepAlive` the job would flap, each relaunch finding a lease held by a pid that had just died, while `build status` named a holder who was never there. It now heartbeats for the life of the process, stops when the heartbeat says the row is no longer ours, and releases on `SIGINT`/`SIGTERM`.

**Checks re-run:** 32 tables; DDL and `phases.mjs` identical at 21 states; comparison set 16 entries, all in the DDL; `ADVANCE` no longer contains `VERDICT_WAIT` or `FINALIZING`.

## Revision round 4 (Codex, 2026-08-23)

Sixteen findings at `ec38ff6`, all accepted. Rounds 1-3 stayed resolved.

**One was a mechanism that was never wired.** Task 23 proved the guardian's guest connection is *permitted* to `SELECT` on `pr_hold`. Nothing read it. §9.6's whole chain — cancel or escalate writes a hold, the guardian's verdict renders BLOCK, its `ops/merge-policy` run at the head goes `failure`, the ruleset refuses the merge — was inert at its only reading step, so every hold row would have been written and consulted by nobody, and a held builder PR would have stayed mergeable. That is now Task 23b, with the clause added to the worst-wins list and a test that asserts membership, because a clause defined beside the list and not in it passes every test written about the clause itself.

**Eleven were caused by earlier rounds' fixes.** Round 3 emitted a `regrant-territory` compensation and never added it to `applyCompensation`'s closed set, so every resume would have thrown or silently skipped its lease. Round 3 gave `restoreHub` a `tail` argument reachable from no CLI route, with no `export-events` for `hub_event` anywhere. Round 3 fenced the stacked-hold branch and left the general refusal branch unfenced, so a stale caller still wrote `transition.refused` claiming the current task refused evidence in a phase it had already left — **the same half-swept class, a third time**. Round 2's `SLICE_MERGED` exit never advanced `slice_cursor`, so the next attempt re-ran the slice that had just merged. Round 2's `--takeover` test asserted the flagless call succeeds, contradicting the rule the same round specified. Round 2's snapshot regression test built an empty SQLite file rather than a guardian store, so the validator it was written to protect would reject it.

**Four were tests that could not fail.** The crash drill waited for committed `phase_event` rows before killing — but a committed row proves a transaction *finished*, so the kill could land between iterations and the drill would pass against code that writes the projection outside its transaction. It now detects the write lock directly: `BEGIN IMMEDIATE` with `busy_timeout=0` fails with SQLITE_BUSY precisely while the child holds an open transaction, which is positive evidence rather than an inference. The privileged-open assertion passed whenever `daemon.mjs` merely *mentioned* `openHubAsGuest`, which is the mixed usage it claimed to catch; it now strips the guest calls and looks for what remains.

### What four rounds say about this document

Findings per round: **15, 10, 13, 16.** Not converging, and the reason is visible in the breakdown: a majority of each round after the first is caused by the previous round's fixes. Each fix is locally correct and globally wrong, because a change here lands in a 4,900-line document whose parts reference each other, and the local edit cannot see its neighbourhood. The plan's own consistency script checks table counts, enumerations, and now compensation coverage — none of which can see any of it.

This is evidence about **plan size**, not about review quality. The three-PR split was chosen for the implementation; the same argument applies to the document, and applies harder. A plan that needs four review rounds and is still finding sixteen defects at the fourth is one document doing three documents' work. **Recommended: split the plan along the PR boundaries it already declares** — one document per PR, each self-contained, each reviewed once — rather than continuing to spend rounds against the cap on a single artefact whose interconnection is itself the defect generator.

**Checks re-run:** 32 tables; DDL and `phases.mjs` identical at 21 states; comparison set 17 entries, all in the DDL; all 10 compensations the machine can emit have an `applyCompensation` branch (the check that would have caught `regrant-territory` before Codex did).
