# The six Stage-3 plans

These specify the sixteen S3 tasks. They are committed **as written on 2026-08-27**, not
corrected in place, so that what an executor was told stays readable beside what turned out
to be true.

**Read this file before executing any of them.**

## Why they are here

They previously existed in one working directory: no history, no backup, no review. Three of
their stated premises were found wrong on 2026-08-30 while executing against them, and a
fourth was found wrong only under test. A specification that can rot with nothing to show the
rot is the failure this repository keeps paying for, so they are versioned like anything else.

`MASTER-PLAN.md`, `S3-DESIGN-BRIEF.md`, the handoffs and the trackers were already here; only
the stage plans were not.

## Known-wrong statements, measured against the code

Each row was verified by running the command in the last column, not by reading. Every one
fails **closed and silently** if the plan is followed literally, which is why they are listed
rather than left to be rediscovered.

| plan | says | actually | how it was established |
|---|---|---|---|
| S3-B consumed table | `capabilitiesFrom` returns bare names (`{observe, …}`) | returns FULL key strings (`builder.capabilities.observe`), and `{}` for a profile that declares none, because absence is deliberately preserved | `grep -n 'export function capabilitiesFrom' -A10 src/build/capabilities.mjs` |
| S3-B consumed table | `registryProjects` lives in `src/build/registry.mjs` | that name is a local alias at `bin/reeve:138` for `loadRegistry`, which lives in `src/build/registryio.mjs`. `registry.mjs` exports no such symbol | `git grep -n registryProjects -- src bin` |
| S3-B consumed table | `registryIo({ home, fetch }) -> io` | `registryIo(home, project, entry, { fetchRepoId, spawn, connect })` — bound to ONE registry entry, not to the home | `grep -n 'export function registryIo' src/build/registryio.mjs` |
| S3-DESIGN-BRIEF §2.2 T2 | `io` carries **eight** members | it carries **nine**. `lsTree` is omitted from the brief, and `resolveClaims` treats it as a hard precondition — an eight-member `io` refuses every filing | compare `grep -oE 'io\.[a-zA-Z]+' src/build/registry.mjs \| sort -u` against `registryIo`'s returned object |
| S3-B Task 1 | stubbing the grammar turns **three** assertions red | the test file **aborts** at the first one: the id is undefined and binding it throws inside `node:sqlite`, so the run produces 10 assertion lines against the control's 14 and four assertions never run. In the log that is indistinguishable from those four passing | run the file against the stub the task names and compare `grep -c '^PASS\|^FAIL'` against the control run |

**The correct reader for a capability is `capabilityOn(profile, name)`**, which accepts either
key form and **throws** on a name the schema does not declare. `capabilitiesFrom(p)[k]`
returns `undefined` for an unknown key, and every gate in this system reads `!== true`, so a
typo there is refused rather than reported — fail-closed, and therefore invisible.

## Cross-plan contradictions, found in review of this pull request

The table above came from **executing** S3-A and the first tasks of S3-B. These came from
reviewing the plans against **each other**, which is a thing that could not happen while they
lived in one directory. Each was re-measured here before being recorded; the count columns are
the measurement, and every read was taken with a positive control so an unreadable file could
not report as a clean zero.

A plan that consumes a name its predecessor never produces fails at **module linking** — the
first test aborts before reaching an assertion, so the failure arrives as a stack trace in a
task whose own logic was never exercised.

| plans | the contradiction | measured |
|---|---|---|
| S3-C → S3-D | S3-D imports `AGENT_DEFS`; S3-C produces `AGENTS` and `agentsJson`. Neither name appears in the other document | `AGENTS`: 5 in S3-C, **0** in S3-D · `AGENT_DEFS`: **0** in S3-C, 8 in S3-D · `agentsJson`: 12 in S3-C, **0** in S3-D |
| S3-C → S3-D | S3-D's tests import `specFor` and drive dispatch from a `PHASE_SPECS` table. S3-C defines neither, and its `dispatchPhase` takes a fully constructed dispatch rather than consulting a registry | `PHASE_SPECS`: **0** in S3-C, 32 in S3-D · `specFor`: **0** in S3-C, 17 in S3-D |
| S3-B → S3-C | S3-B produces `writeArtifact({dir, phase, bytes}) -> {path, sha256, bytes}`. S3-C's consumed table writes `writeArtifact(dir, phase, bytes) -> {sha, path}`, and its crash drill calls it positionally and reads `.sha` | S3-B `:1141`; S3-C `:40`, and positional calls at `:2446`, `:2456` |
| S3-C → S3-E | S3-C creates builder provider leases with `runRef` as `<task>:<phase>`; S3-E matches `run_ref` against the task id alone, so a capacity-blocked task is never found and `WAITING_FOR_QUOTA` is never shown | S3-C `:1853` writes `bt:1:SIZING`; S3-E `:608` matches `run_ref='bt:q'` |
| S3-A → S3-E | `NEEDS_SWITCH` stores bare capability names and the lookup reads `capabilities.observe`, but `capabilitiesFrom` returns dotted keys — so every lookup is `undefined` and an enabled task renders as `WAITING_FOR_CAPABILITY` | same root as row 1 of the table above; the reader to use is `capabilityOn` |
| S3-A → S3-E | `reeve task dash` passes the registry loader's result straight to `dashModel`, which calls `projects.map(...)`. `loadRegistry` returns `{projects, registry, error}` — an object — so the call throws `TypeError` every time | `src/build/registryio.mjs:205-212`, verified against the merged code |
| — S3-F | V4's fan-out control runs `sh "$R/probe.sh"`, and nothing in the plan or the repository ever writes that file. `\|\| true` masks the missing-file failure, so the error log is parsed as the unsandboxed control and V4 produces a measurement of nothing | `probe.sh` appears 3 times in S3-F; exactly one is the execution at `:1131`, and none is a write |

**The S3-E `run_ref` row is the one to read twice.** S3-E's own fixture inserts the bare task
id, so its test passes against a lease shaped the way the test wrote it and would fail against
a lease shaped the way S3-C writes it. A fixture that describes a system which does not exist
is this repository's most expensive recurring defect, and it is here in a plan rather than in
code, which is the cheapest place it has ever been caught.

## Findings that are arguments rather than measurements

These came from the same review and are recorded unverified, because checking them requires
code that does not exist yet. They are **not** corroborated, and they are listed so the task
that reaches them starts by testing the claim rather than discovering it.

- **S3-C, P1.** Making `dispatch` fire-and-forget lets the surrounding `finally` release the
  provider lease while the detached worker is still running, so later ticks admit workers past
  the measured concurrency limit. The detached lifecycle would need to heartbeat and release
  only when the worker settles.
- **S3-C.** The adoption stub drops `lease_expires_at > now`, leaving `if (stillOurs)`, which
  adopts every live pid. The only worker present is one that is expected to be adopted, so the
  assertions stay green and the stub cannot exercise the kill-versus-adopt boundary. This is
  the same shape as the S3-B Task 1 row above, and it is the third instance in these documents
  of a mandatory stub loop that cannot fail.
- **S3-D.** The RESEARCH step declares `researchFindings` without calling it from
  `reviewArtifact`, computing the artifact sha, or converting the inherited `{ok, why,
  findings}` into the `{ok, refusal, findings, sha}` the assertions above it require.

## Second review round: what the plans build but never wire, and what they measure but never run

The first round found names that disagree between plans. This round found something different
and worse: **steps that produce a thing nothing calls, and measurements that run a command
nobody writes.** Recorded with the same rule as above -- verified where verification was
possible today, and marked as an argument where it was not.

### Verified

| plan | the defect | measured |
|---|---|---|
| S3-E | The builder announcer is defined and never wired. `builderAnnounce` appears 18 times in S3-E; `loop.mjs` appears **once**, and that mention is about `isAlive`, not about calling it. No task adds it to the builder loop or the `build run` route, so every builder escalation is durable, visible in the hub, and delivered to nobody | `grep -c builderAnnounce` = 18, `grep -c loop.mjs` = 1 in S3-E |
| S3-F | V6 runs `reeve build measure-pool`, and **no task creates that subcommand**. The string appears exactly once across all six plans -- the invocation itself -- and zero times in `src` or `bin` | 1 occurrence in S3-F at `:1456`, 0 in `src`/`bin` |
| S3-E | The `admitTask` fail-open premise that the table above corrects for S3-B **is repeated verbatim in S3-E `:85`**. `assertWritable` throws when the predicate reports the holder ALIVE, so `() => true` refuses rather than admits; it never reaps a dead holder and wedges the hub read-only instead | `assertWritable`, `src/build/locks.mjs:156-165` |

**The reviewer's own claim needed narrowing on the first of these**, and the correction matters
more than the finding. It says a repo-wide search finds `announce` only in tests. That is
false: the guardian's announcer is called at `src/daemon.mjs:1608` and `:3244`. What is true is
narrower -- the **builder** announcer S3-E introduces is never wired. A finding recorded as
stated would have sent someone to fix a call site that already exists.

### Verified since: S3-C's unique-violation branch

Moved out of the unverified list below, because it is no longer an argument. The code it needed
exists now, so it was checked rather than carried.

- **S3-C. MEASURED 2026-09-01**, evidence in `docs/measured/2026-09-01-phase-run-constraint-errcodes.md`.
  The unique-violation regex matches `index 'one_live_run'`; SQLite reports the constrained
  columns instead, so the branch never fires. **Read the errcode, not the message**: 787
  no-such-task, 1555 duplicate-attempt, 2067 live-run-exists — three distinct and stable values,
  where the primary-key MESSAGE contains `phase_run.task` and so cannot be told from the index's
  by matching the column. Re-inserting an attempt whose row is still live violates both and
  reports 2067, which is correct but must be asserted on purpose. Closed by `src/build/run.mjs`.

### Arguments, recorded unverified

Each needs code that does not exist yet. They are listed so the task that reaches them starts
by testing the claim.

- **S3-F, P1.** The budget extractor labels contract ceilings as measured usage: `max_turns` is
  the configured cap and `max_budget_usd` the spending cap, so V2 would report the guesses back
  as if they were measurements -- a measurement whose instrument returns its own input.
- **S3-E, P1.** `builderAnnounceable` writes `announced_count = count` *before* `announce`
  attempts delivery, so a channel that declines once marks the escalation announced and it is
  never retried.
- **S3-B (PR-B2).** `writeArtifact` ignores `writeSync`'s return value; a short write is then
  fsynced, renamed, and reported with a sha and a byte count for a file that is incomplete.
- **S3-C.** Canonicalising run evidence with `Object.keys(v)` as a JSON replacer whitelists only
  top-level keys and silently drops every nested one.
- **S3-C.** If `runWorker` rejects rather than returning an outcome, the `finally` clears the
  heartbeat but never settles the run row.
- **S3-D.** The done-condition regex accepts any fenced block, so a slice carrying a
  configuration snippet and no `Done when` reports a machine-checkable done-condition.
- **S3-F.** A `phase_run` fixture inserts rows for a task the database has no parent row for,
  against a declared foreign key.
- **S3-F.** An empty outbox is treated as missing evidence, though a scout run that enqueues no
  effects is exactly what S3 requires.
- **S3-F.** V5 promises three `build_design.json` runs; only the twenty `build_size.json` runs
  are launched.
- **S3-E.** Under `--json` a declined notification prints two JSON documents, so a consumer
  parsing stdout gets a syntax error rather than a refusal.

**What this round says about the plans as a whole.** Two review passes have now produced
twenty-one findings across six documents, and the yield did not fall between them. That is not
a count of mistakes so much as evidence about the documents: they were written in one sitting,
against each other rather than against the code, and never executed. Treat every remaining
plan's consumed-name table and every "produces" clause as unverified until the task that
consumes it runs.

## Third review round: a plan contradicting its own consumed table

| plan | the defect | measured |
|---|---|---|
| S3-F | Reads flags as `flags.json`. `bin/reeve` exposes `flag(name)`, `opt(name)` and `all(name)`; there is **no `flags` binding**, so every such read is a ReferenceError before the route runs | `const flags` count in `bin/reeve` = **0**; `flags.`/`flags[` in S3-F = 7 |
| S3-E | A `task list`/`show`/`why` line reads a capability by its bare name. **S3-E's own consumed table at `:36` documents the dotted form correctly, and even records the measurement proving it** -- so the document contradicts itself rather than merely disagreeing with S3-A | S3-E `:36` vs the cited line |
| S3-F | V1 files against something other than the registry **project name**, which is the key S3-B's route indexes `registry.projects` by | S3-B route, `bin/reeve` |

**The S3-E row is the one that changes how these documents should be read.** Until now every
finding was a plan disagreeing with the code or with another plan. This is a plan disagreeing
with **itself**: the consumed table states the dotted form, gives the measurement behind it,
and then a task in the same document reads the bare name. A reader who checks the table before
writing the code would still be sent wrong by the code beside it. Checking a plan's table is
therefore not sufficient; the snippets have to be checked against the table too.

Recorded unverified, needing code that does not exist: a reservation equal to the measured
limit is accepted though admission would refuse it; escalation keys outside the declared
identity set are accepted; a `JSON.parse` result is inspected without being guarded against
null; and an acceptance check's failing exit status is lost through a shell pipeline.

## S3-B and S3-D disagree about the artifact gate, found by executing S3-B

Recorded here because the next executor of S3-D's phase tasks will hit it, and
because it is the first divergence found by running a gate against the artifact
its own producer is SPECIFIED to write rather than against a fixture.

| what | S3-B (this gate) | S3-D (the producer) |
|---|---|---|
| slice heading | `## Slice 1` | `## Slices` holding `### Slice 1: ...` (`2026-08-27-s3d-phases.md:1374-1380`) |
| test label | `Tests:` | `- Test plan:` |
| done condition | a value on the same line | `Done when:` alone, with a fenced command beneath it |
| the `expect` argument | `{depth}` | `researchExpectations(depth) -> {minCitationsPerClaim, minClaims}`, carrying **no** depth (`:986`) |

`reviewArtifact` now accepts **both** forms rather than a third one invented to
reconcile them. It was shipped accepting only S3-B's, which meant it found **zero
slices** in the artifact S3-D emits and refused it for "carrying no ordered slice
list" — correct work rejected — and threw on the documented callers before
reading anything.

**Every test passed while that was true**, and the reason is the finding rather
than the fix: every design fixture in the suite had been written to match the
checker. The checker and its tests agreed with each other and disagreed with the
artifact. The fixture that exposed it is copied from S3-D's plan verbatim.

**The rule this gives the next executor:** when a task builds a gate, take its
fixture from the plan that PRODUCES the thing being gated, not from the plan
being executed. A fixture written beside the checker tests that the checker
matches itself.

## What T4 left for S3-D's phase tasks, and why

S3-D `:195` says `reviewArtifact` **gains** the RESEARCH citation minimum in PR-D2 and the
DESIGN slice-list, done-condition and measured-context minima in PR-D3. T4 built the durable
store and shipped a working version of those minima alongside it, so whoever executes those
tasks will find their work partly done. This says which parts and what is still owed, so it is
neither duplicated nor assumed complete.

**Done in T4, and tested:** the artifact store (atomic write, hashed read-back, stale-temporary
reaping), the two gates refusing each other's phases, claims scoped to `## Findings`, the
citation shape, the sizing contract's field presence, per-slice design minima, and honouring
`requireMeasuredContext`, `minSlices`, `minClaims` and `requireDoneCondition` when the caller
supplies them.

**Fixed in the follow-up, not left for S3-D.** An earlier revision of this file said
these were deferred to the task that owns the contract; that was a misrecording of the
founder's decision, which was to fix everything after T4 merged. All of them are done:

| what | now |
|---|---|
| `sizing.json` field TYPES | each field has a declared kind, so `est_files: "lots"` is refused and the finding names the field |
| claims restricted to TOP-LEVEL Findings bullets | a nested bullet elaborating a cited claim is no longer a claim of its own |
| a CLOSING fence on the done condition | the fence must open AND close; half a block put the rest of the document inside it |
| the trivial-depth RESEARCH refusal | reads the caller's `skipped` flag, with depth as the fallback, so the path is reachable from the documented caller |
| `minCitationsPerClaim` applied | it was accepted and ignored, so a claim with one citation satisfied a caller asking for two |

**And T4's own three**, also fixed: the directory-sync chain now walks to the filesystem
root rather than stopping at eight levels, the citation pattern no longer caps a file
extension at six characters (so `src/x.markdown:12` is a citation), and a temporary is
removed when `closeSync` itself throws — the third leak in that family, after the write
and the rename.

**One more, found by the T13 lane and inherited here:** `bin/reeve`'s `task file` route gates on
`completedVersion(hub) === HUB_SCHEMA_VERSION`, and `completedVersion` returns `max(version)`.
A hub recording 1 and 3 with **2 missing** answers 3, passes the equality, and then fails on a
table migration 2 creates. **A maximum is not a history.** The `at !== 0` escape beside it is a
second hole: an empty `schema_version` table answers 0 and is waved through as "nothing to
check", when nothing has been migrated at all.

## What this file does NOT establish

Only S3-A and the first task of S3-B have been executed. The rows above are what executing
those found. **S3-C, S3-D, S3-E and S3-F have never been run against the code**, and they
consume the same three interfaces that were wrong in S3-B's table. Their consumed-name tables
should be assumed stale in the same way and verified the same way, one row at a time, before
their first task. Absence from this list means not yet checked, never checked and correct.

The review that produced the second table read the plans against each other; it did **not**
execute them. A contradiction between two documents is cheap to see and was found. A plan
that is self-consistent and wrong about the CODE is not visible that way, and only S3-A and
the first tasks of S3-B have been checked that way so far.

## Fourth round: what executing S3-E's first pull request found

The rounds above reviewed the plans against the code and against each other. This
round comes from **running PR-E1**, and it is the first evidence about S3-E of the
kind the section above says did not exist yet. Each row was established by
executing the plan's own step and reading what came back.

| the plan says | actually | how it was established |
|---|---|---|
| `WAITING_FOR_GUARDIAN` is `guardianQueued > 0 \|\| preempt > 0` | §11.6 defines it as *"VERDICT_WAIT without a verdict at H"*. The plan's version is a fact about the MACHINE, not about the task: any guardian queued anywhere marks every task in the listing as waiting for a guardian, which is not an answer to "why is this task not moving" | `docs/2026-08-21-builder-design.md` §11.6, the substate list |
| `WAITING_FOR_NOTICE` is `some(kind='delivered') && !some(kind='founder_ack')` | `notice_receipt`'s key is `(task, head_sha, clean_source_id)` and a task REVISES. A task-wide check reports a head delivered-and-unanswered as acknowledged, because an older head was acknowledged. The pairing has to be per `head_sha` | `src/build/hub.sql`, `notice_receipt`; and the stub that makes the check task-wide turns exactly one assertion red |
| `WAITING_FOR_CODEX` is an open `gate_request` with no `notice_receipt` at that head | a notice receipt is a DELIVERY to the founder, not a review. The row that means "Codex answered" is `approval` with `kind = 'codex_clean'`, which the plan's consumed table never mentions | `src/build/hub.sql:242-264`; `approval.kind` includes `codex_clean` |
| `taskShow(db, id, { capabilities })`, one map for a whole `task list` | switches live in each project's **own** profile and a listing spans projects, so one map reports one project's switches under another project's name — for the one value whose entire job is to say why a particular task is not moving. The reader has to resolve per project | two projects with different `observe` settings in one listing; with one map the second project's row is wrong |
| S3-E Task 1 and Task 2's snippets read `r.stdout` from `test/cli-flags.test.mjs`'s `run()` | that helper returns `{ status, out }` and **no `stdout` at all**. `JSON.parse(undefined)` throws into the `catch` and reads as "did not parse"; `prose.stdout.slice(0, 120)` throws and ABORTS the file. Both are indistinguishable in the log from assertions that ran | `grep -n 'const run = ' -A6 test/cli-flags.test.mjs` |
| `APPLIES.json` includes `build` | the `build` route contains **zero** occurrences of the token `json` across all 447 of its lines, so the flag is accepted and inert on every one of its subcommands. Listing it there asserts a capability that does not exist | count of `json` per route line-range: doctor 2, builder 8, task 8, **build 0** |

**And one that is not S3-E's fault but will bite the next person in that file.**
`bin/reeve`'s `case "task":` block does `const { openHub } = await import(...)` for
its `file` subcommand, which shadows the top-level `openHub` import for the
**whole case block**. A branch added above it that touches `openHub` dies with
`Cannot access 'openHub' before initialization`. It surfaced here as a stub whose
twelve red assertions had nothing to do with the property being measured — a
reading that was thrown away rather than recorded, which is the only correct
response to a run that failed for the wrong reason.

**What this round says about the remaining plans.** Every finding above is of the
same kind as the ones already recorded: a "produces" clause nobody ran. Three of
them are the plan disagreeing with the SPEC it cites, which no amount of reading
the plans against each other could have found. S3-C, S3-D and S3-F have still
never been executed.

## Fifth round: what executing S3-B's PR-B3 found

Task 1 of the report contract, executed 2026-09-01. Three of these are defects in
the plan's own code snippet, which is a category the earlier rounds did not
produce, because the earlier rounds read plans rather than running them.

| what the plan says | what is true | how |
|---|---|---|
| `export const ACTIONS = Object.freeze(["BUILD_SIZE", "BUILD_RESEARCH", "BUILD_DESIGN"])` and a literal `PHASE_FOR_ACTION` | `phases.mjs` already exports `BUILD_ACTIONS` and `BUILD_ACTION_FOR`, under a comment stating that **a second inventory of three names that agree today is the defect this codebase keeps finding**. The plan specifies writing exactly that second inventory | `src/build/phases.mjs:41-46`; the comment above it runs to sixteen lines and names this failure |
| `export function validateReport(action, value) { const errors = walk(...); return errors.length ? ... }` | every early return in `walk` is `return errors.push(...)`, which is a **number**. `errors.length` is then `undefined`, which is falsy, so `validateReport("BUILD_SIZE", "not an object")` answers `{ok: true}`. Only the ROOT call reads that return value, so the one input that reaches it is a non-object — which is what a worker answering in prose instead of JSON produces | run the plan's own `report.mjs` against a string; the plan's own tests pass only objects, so they cannot exhibit it |
| `evidenceFor` maps `infeasible`, then `blocked`, then returns `phase.succeeded` | anything that is not one of those two becomes a SUCCESS. A report that skipped validation, or one validated against a different action, therefore **advances the task**. Failing open in the one function whose output moves a task forward | `evidenceFor({action:"BUILD_SIZE", report:{outcome:"nonsense"}})` returns `kind: "phase.succeeded"` |
| S3-B: `validateReport(action, value) -> {ok:true, report} \| {ok:false, errors}` | S3-D's consumed table names `{ok:false, kind:"BAD_REPORT", errors}` and dispatches on `kind`. The producer's clause omits the field the consumer branches on | S3-B `:1703`; S3-D `:50` |

**And one that belongs to S3-C, found by executing S3-B.** PR-B3's produces
clause says S3-C Task 1 passes `schemaFor(action)` to `workerArgs`'s
`jsonSchema`. `workerArgs` pushes that value straight into the argv array
(`src/supervisor.mjs:149`) and its tested contract is serialized JSON text
(`test/worker-args.test.mjs`, `'{"type":"object"}'`), while `schemaFor` returns a
parsed OBJECT. Following the handoff as written, all three phase dispatches would
spawn a worker whose `--json-schema` argument is the literal string
`[object Object]` — an argument that is syntactically fine and semantically
nothing, and which fails no check anywhere. **S3-C must use `schemaTextFor`,
which T5 now exports**; it returns the file's text rather than a
re-serialization, so what the worker is asked for is byte-identical to what the
freeze hashes.

**Stale anchors in PR-B3's consumed list**, all in `src/build/phases.mjs`:
`PHASES` is cited at `:42` and is at `:66`; `HOLD_ESCALATION` at `:89` and is at
`:113`; `holdReasonRefusal` at `:132` and is at `:144`. The fourth, `nextPhase`
at `:654`, is right in substance — `:654` is its `phase.succeeded` branch rather
than its declaration, and that branch is what the sentence is about.

**What the mapping got right, verified rather than assumed.** Every evidence
shape the plan produces is one `nextPhase` accepts, and the four requirements it
relies on are real: `phase.succeeded` needs `evidence.phase` and, in SIZING,
`evidence.depth` from `DEPTHS` (`:662` and `:676`); `founder.infeasible` needs a
non-blank `reason` (`:267`); `phase.failed` needs `retriesExhausted` (`:449`);
and `evidence.detail` is read by `transition.mjs` (`:202`, `:519`), so the hold
branch is not inventing a field. The plan's refusal to default a `blocked_other`
escalation identity is also correct and load-bearing: `holdReasonRefusal`
(`:144`) refuses a blank one, and a default here would be a second copy of that
rule.

**The shape this round adds to the list.** The earlier rounds found plans
disagreeing with the code, with each other, and with themselves. This one found a
plan whose *code* is wrong in ways its *own tests cannot see* — the non-object
case is invisible to a test suite that only ever passes objects. A plan that
ships both the implementation and the assertions can be internally consistent and
still wrong, and reading it against itself will never say so.

## Two decisions PR-B3 took that the plan did not anticipate

**The escalation identity is MINTED, not forwarded.** The plan's `evidenceFor`
passes the worker's `escalation` string through, and PR-B3's own comment argued
that supplying a default here would put the machine's "a `blocked_other` must
reach a founder" rule in a second place. That argument is about ABSENCE and it
still holds. It says nothing about the value when the worker supplies one --
and `nextPhase` checks only that the string is non-blank, while
`applyTransition` (`src/build/transition.mjs:803`) persists it as the hub's
escalation KEY, which notification and retirement are routed by. A report could
therefore file its hold under another task's cause. `evidenceFor` now mints
`bt:<id>:phase:blocked:<phase>` from the phase it already knows and the task id
`applyTransition` substitutes, and **`escalation` is removed from all three
schemas** so a worker that supplies one is refused rather than ignored. Its
explanation still travels, as `detail`, which is what the DDL's column is for.

**An `ok` report must carry what its phase produces, conditionally.** The plan
argues at length that the sizing shape and the slice list are not `required`,
because a blocked or infeasible worker has none to give and forcing them is how
a stop becomes a fabricated success. That is right, and it left the other half
open: `required: ["outcome", "reason"]` also admits an `ok` SIZING report with
no estimates at all, which advances the task while the deterministic floors read
`est_packages` and `est_weighted_files` as absent and compare against nothing.
The requirement is now conditional on `outcome`, so both halves hold. The
validator gained `if`/`then`/`const` and `pattern` for it, and `pattern: "\\S"`
on every non-empty string, because `minLength` counts CHARACTERS -- a reason of
`" "` validated and was then refused by `nextPhase`, so validation and the
transition disagreed and the BAD_REPORT retry path was never reached.
## What the artifact gate cannot decide, and which plan can

`reviewArtifact` is given a phase, a directory and a set of expectations. It has
no repository root, and one of its rules needs one.

**A bare `api.internal:3000` is the same TOKEN as `package.json:3000`** — a
dotted name, a colon, digits — so no regular expression separates a host and
port from a citation of a file at the repository root. Every syntactic
discriminator tried and rejected: a length cap on the extension refuses
`src/x.markdown:12` (and was removed for exactly that reason); an
extension whitelist is an inventory that is wrong the first time someone cites a
file type nobody listed; a TLD list is the same problem inverted, and `.md`,
`.ts`, `.sh` and `.py` are all real top-level domains.

The gate resolves it towards ACCEPTING, and the test records that as an
assertion rather than a comment, so reversing it fails a named line. The reason
is that the two errors are not symmetric: accepting the endpoint lets one claim
through uncited, while refusing the dotted-name form refuses every citation of a
root-level file and fails the whole report — and this file has already been
corrected once for refusing correct work over a bound nobody chose deliberately.

**The durable answer is not syntactic, and it belongs to S3-D.** A phase task
holds the project checkout, so it can ask whether the cited path EXISTS, which is
the only thing that actually tells `api.internal` from `package.json`. Any
S3-D task that gates a research artifact should resolve citations against the
task's territory rather than re-deriving a better regular expression here.

The endpoint shapes that ARE separable — a protocol-relative `//host:port`, a
userinfo `user@host:22`, and a `host:port/path` — are removed before the check,
because each carries a marker no file reference has.
