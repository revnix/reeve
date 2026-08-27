# S3-B: Filing and Artifacts, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A founder can file a task whose territory is declared, checked and durably leased in one transaction that performs no I/O; every phase artifact that later justifies a transition is written durably, hashed, read back and verified before the transition commits; and every phase report is validated against a schema that refuses the empty object before it is allowed to become evidence.

**Architecture:** Three PRs against `revnix/reeve` `main`, in order. PR-B1 adds the `task` route to `bin/reeve` and `src/build/taskfile.mjs`, and extends `src/build/registryio.mjs`. PR-B2 adds `taskPathFor`, `artifactPathFor` and `runPathFor` to `src/paths.mjs` and creates `src/build/artifact.mjs`. PR-B3 creates `src/build/schemas/{build_size,build_research,build_design}.json` and `src/build/report.mjs`. **No task in S3 performs any GitHub effect, opens any PR, or enqueues any outbox row of a `gh.*` or `git.push.branch` kind; the switches for those are off and S3 does not change that and must not.** And S3-B's own: **nothing in S3-B dispatches a worker.** The three modules here are importable and pure of `child_process`; the dispatch seam that would spawn one is S3-C's T6, and no file this plan creates or modifies imports `src/supervisor.mjs` for anything but `isSameProcess` and `readStart`.

**Tech Stack:** Node `~/.nvm/versions/node/v24.17.0/bin/node` (PATH node is v22 and `node:sqlite` warns there), `node:sqlite` `DatabaseSync`, plain-script tests under `test/*.test.mjs` (CI runs every file in that glob on ubuntu-latest under three TZs), no dependencies added.

**Spec:** `docs/2026-08-21-builder-design.md` — §14 S3 (`:826`) is the stage definition and its *Verify:* clause is the definition of done. The sections that bind this plan: §2.1 (`:123`, `source_key`, `--anyway`, `--idempotency-key`), §2.2 (`:121-136`, the command and the territory rule), §3.2 (`:231`, a transition commits only after its artifact is durable), §3.3 (`:240`, the run-file path), §4.1 (`:281-288`, the per-action table and the `outcome`/`reason` contract), §4.6 (`:316-320`, reports, acceptance and `reviewArtifact`), §5 (`:332-333`, `sizing.json` and the floors), §6 (`:357`, the artifacts and the ordered slice list), §10.1/§10.2 (the grammar and the lease), §11.2 (every CLI command that writes hub.db holds a writer lease), §11.6 (`:735`, the standard mutating `--json` shape), §15 item 2 (`:875`, the sibling-function ruling).

**This is one of six plans for S3.** The split is measured, not stylistic: the three S2 **plan** PRs (#11, #12, #13 — 14 files, all Markdown) produced **561 of 1,282 findings, 43.8% of every finding review has ever produced in this repository**, and the decisive one, **PR#12, was a single file at +3,994 lines: 213 findings over 15 rounds.** A single S3 plan would be 6,000-8,000 lines, which is precisely that artifact.

| plan | scope |
|---|---|
| `2026-08-27-s3a-profile-and-registry.md` | T1 `builder.*` FIELDS and the one reader of the capability switches; T2 the registry entry's `repoPath`/`profilePath` and a real `io` for `resolveSnapshot`. Carries the S3 Verify table. |
| `2026-08-27-s3b-filing-and-artifacts.md` | T3 `reeve task file` and the territory grammar; T4 the durable artifact store and `reviewArtifact`; T5 the phase report schemas and the report contract. **This plan.** |
| `2026-08-27-s3c-dispatch.md` | T6 `phase_run` and revocation; T7 the three action cases in `sandboxFor`/`promptFor`; T8 the tick dispatch and the builder's provider claim; T9 adopt-or-kill and the crash drills. |
| `2026-08-27-s3d-phases.md` | T10 SIZING and the deterministic floors; T11 RESEARCH and `--agents` fan-out; T12 DESIGN and the ordered slice list, stopping at SPEC_DRAFT. |
| `2026-08-27-s3e-operator-surface.md` | T13 `task list\|show\|why`; T14 `dash`; T15 escalations from the builder process and doctor's S3 rows. |
| `2026-08-27-s3f-measurements.md` | T16 the six §14 measurements and the documents that record them; re-walks the S3 Verify table. |

Their review history — every finding and what each changed — is `s3-review-history.md`. **Order matters:** A lands before B, B before C, and inside this plan B1 before B2 before B3. **Base this on S3-A's merge commit.**

---

## What this plan consumes from S3-A

S3-A must be merged first. These are the exact names this plan builds on; **if any has changed, stop and reconcile rather than adapting the code here.**

`2026-08-27-s3a-profile-and-registry.md` did not exist when this plan was written. The two rows below marked **(as specified)** carry the shape from `S3-DESIGN-BRIEF.md` §2.2 T1 and T2 (`:153-184`), not from a written plan or from merged code; verify them against S3-A before Task 1 and reconcile rather than adapt. Every other row was read out of the source at `16cd880` by searching its anchor string.

| from | name | shape |
|---|---|---|
| S3-A T1 **(as specified)** | `src/build/capabilities.mjs` | `capabilitiesFrom(profile) -> { observe, draftSpec, publishPr, mergeBuilderPr, … }` — the single reader of `builder.capabilities.*`, returning exactly the key strings `capabilityFor` emits at `src/build/outbox.mjs:306-323`. This plan reads only `observe`, and only to print it under `--dry-run`. |
| S3-A T2 **(as specified)** | `src/build/registry.mjs` `registryProjects` | `registryProjects(home) -> { projects: [{name, nwo, repoPath, profilePath}], error }` — moved out of `bin/reeve:133`, keeping *"A MALFORMED ENTRY IS AN ERROR, not a row to drop"* (`bin/reeve:137`) |
| S3-A T2 **(as specified)** | `src/build/registryio.mjs` | `registryIo({ home, fetch }) -> io` where `io` carries the nine members `resolveSnapshot` and `resolveClaims` actually call: `lstat(path)`, `lsTree(repoPath, path)`, and async `repoId(nwo)`, `profileHash(profilePath)`, `defaultBranch(nwo)`, `visibility(nwo)`, `specRepoId(nwo)`, `gateDefinitionHash(nwo)`, `founderUserId(nwo)` |
| `src/build/registry.mjs:68` | `normalizeClaim` | `normalizeClaim(raw, { kind = "prefix" }) -> {kind, path} \| {refusal}`; pure; `""`/null/whitespace returns `{kind, path: ""}` — the repository root, never "no claim" |
| `src/build/registry.mjs:183` | `resolveSnapshot` | `async resolveSnapshot(registry, project, claims, io) -> snapshot \| {refusal}`; `registry` is `{version, projects: {<name>: {nwo, repoPath, profilePath}}}` — an object keyed by project name, **not** the array `registryProjects` returns; every network read happens here and none inside a transaction |
| `src/build/registry.mjs:218` | `admitTask` | `admitTask(db, snapshot, filing, { isAlive = () => true }) -> {ok:true, taskId, replayed?} \| {ok:false, refusal}`; one `hubTx`; `filing` is `{id, project, title, body, sourceKind, sourceKey, idempotencyKey, pinTerritory}` |
| `src/build/territory.mjs:102,117,121,140` | `liveLeases`, `firstConflict`, `conflictRefusal`, `grantLease` | `conflictRefusal(claim, lease) -> string`; `grantLease(db, {project, claim, taskId, at, pinned, pinnedUntil, seconds}) -> row`; `LEASE_SECONDS = 3600` at `:56` |
| `src/build/hubdb.mjs:322,619,645` | `openHub`, `hubTx`, `hubEvent` | `openHub(path, {skipIntegrity}) -> DatabaseSync`; `hubTx(db, fn) -> fn's return` (`BEGIN IMMEDIATE`, no nesting); `hubEvent(db, {kind, task, payload}) -> seq`, called **inside** the caller's tx |
| `src/build/locks.mjs:88,156` | `withWriterLease`, `assertWritable` | `withWriterLease(db, {command, pid, lstart, isAlive, at}, fn) -> fn's return`. **It does not hold a transaction across `fn`**: it opens one tx to insert the row, runs `fn` outside any transaction, and opens a second to delete it — so `admitTask`'s own `hubTx` nests nothing. `assertWritable(db, {isAlive, at, inTx})` **throws** while a live restore holds `maintenance_lock` |
| `src/build/transition.mjs:660,674` | `applyTransition` | exported as `applyTransition(db, args)`; the destructured shape is on the private `applyTransitionTx(db, {taskId, expectedPhase, expectedGeneration, evidence, artifactSha = null, op, effects, slice, now, drainMinutes, isAlive = isSameProcess})` at `:674`. Returns `{applied:true, …}` or `{applied:false, reason:"refused", refusal}` |
| `src/build/transition.mjs:775` | the artifact-sha gate | `evidence.kind === "phase.succeeded" && WORKER_PHASES.includes(expectedPhase) && !artifactSha` refuses durably: *"succeeded with no artifact sha; a transition must record what justified it"* |
| `src/build/hub.sql:143` | `phase_event.artifact_sha` | `artifact_sha TEXT` — *"what justified the transition"*. `phase_event` is `STRICT`; `seq INTEGER PRIMARY KEY` |
| `src/build/phases.mjs:639,641,654` | `nextPhase`'s report refusals | unattributed: *"a phase report must name the phase it came from"*; mis-attributed: `a ${evidence.phase} report cannot advance a task in ${phase}`; SIZING without a depth in `DEPTHS` (`:139` = `["trivial","standard","deep"]`) |
| `src/build/phases.mjs:89,107,132` | `HOLD_ESCALATION`, `holdReasonFor`, the `blocked_other` rule | `blocked_other: null` in the map, *"supplied by the caller"*; `String(evidence.escalation ?? "").trim() === ""` is refused — **non-empty, not merely non-null** |
| `src/build/phases.mjs:238,441` | the two terminal evidences | `founder.infeasible` requires a non-blank `reason`; `phase.failed` with `retriesExhausted` escalates `bt:<id>:phase:failed:${phase}`, substituted at `src/build/transition.mjs:1088` |
| `src/supervisor.mjs:40,67` | `readStart`, `isSameProcess` | `readStart(pid) -> string \| null`; `isSameProcess(pid, storedStart) -> boolean`. The only two symbols this plan imports from that module |
| `src/paths.mjs:68` | `hubPathFor` | `hubPathFor(home) -> <home>/state/hub.db`. **`taskPathFor` does not exist**: `git grep -c taskPathFor -- src bin test` returns zero files at `16cd880`; positive control, the same grep for `hubPathFor` returns ten. PR-B2 adds it |
| `bin/reeve:263,430,432` | `FLAGS`, `opt`, `all` | `FLAGS` is `{name: {value: boolean, what: string}}`; `opt(n)` returns the first occurrence, `all(n)` returns **every** occurrence in order. **Repeatable valued flags already work** — the argv walk at `:411` pushes into an array — so `--territory` needs a `FLAGS` entry and `all("territory")`, not new parsing |
| `src/sandbox.mjs:856` | `reviewDiff` | `reviewDiff({files, profile, lane = null, action = null}) -> {ok, why, files}`. It **returns** a refusal and never throws, and `action` is optional today. PR-B2 adds the phase guard and does not otherwise touch the signature — see Decision 4 |

**The obligation this plan exists to discharge.** S2 built a phase machine that refuses a transition with no artifact sha (`transition.mjs:775`) and a `task` table with a territory child table beneath it — and nothing files a task, nothing writes an artifact, and nothing computes a sha. Measured at `16cd880`: `grep -c '"task"' bin/reeve` returns **0**, and `bin/reeve`'s usage text still ends *"not yet built: next · plan · lane"*; `git grep -c reviewArtifact -- src bin test` returns **zero files** (positive control: `reviewDiff` returns four files, six hits in `src/`). So the artifact-sha gate has never been reached by a real caller, `task_territory` has a declared writer that does not exist (`src/build/tables.mjs:20` names `intake.mjs (admission tx)`; `git grep -c intake.mjs -- src bin test` finds four hits in one file, `tables.mjs` itself, and `src/build/intake.mjs` is absent), and `phase_event.artifact_sha` is a column no value has ever been put in. This plan supplies the first caller for all three. Until it lands, S3-C has nothing to dispatch **for** and nothing to record the result **of**.

### Line references in this plan

Every reference to a source file names the **anchor text to search for** first and a line number second, with the commit it was true at. Every number here was found by searching its anchor string at **`16cd880`** and recording what came back, never copied forward. Line numbers in `src/daemon.mjs`, `src/profile/schema.mjs`, `src/prompts.mjs` and `src/doctor.mjs` moved on 2026-08-27 when reeve#49 merged — `tick()` from `:956` to `:975`, `announceable` from `:3217` to `:3236`, `WORKER_ACTIONS` from `:492` to `:527`, `hubFindings` from `:1021` to `:1075` — and `S3-DESIGN-BRIEF.md`'s numbers were measured one merge earlier, at `c500cfe`. `tasks/reeve-tasks/trackers/s3.md` §7 is authoritative over the brief for those four files. **A plan that sends an executor to a line number which has since moved is worse than one that sends them to a string: the string is still there.**

## Global Constraints

- **Node:** always `~/.nvm/versions/node/v24.17.0/bin/node`. Alias it `N` in every shell: `N=~/.nvm/versions/node/v24.17.0/bin/node`. `node` on PATH is v22 and `node:sqlite` emits an ExperimentalWarning there; CI asserts a floor of 24.
- **Tests:** plain scripts, no framework. Use the `check(ok, name, detail)` helper shape every existing test file uses; `console.log("PASS  name")` / `"FAIL  name"`; end with `process.exit(fail ? 1 : 0)`. New files under `test/` are discovered by CI automatically.
- **The four-check stub loop for every fix:** control green, stub verified applied, the RIGHT assertion red, restore verified. Never commit a test that has not been seen red against the broken code. Every task below names the stub explicitly, as a step.
- **Run the full suite before every commit**, with the one exclusion the next sentence explains:

  ```bash
  fail=0
  for f in test/*.test.mjs; do
    case "$f" in */escape.test.mjs) continue;; esac    # see below: not while the daemon is live
    $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
  done
  # NONZERO on red. `|| echo` turns a failing node process into a SUCCESSFUL
  # command, so this loop exited 0 with any number of red files -- and this is
  # the mandatory pre-commit and close-out gate, so an executor checking the
  # command status commits and publishes a broken implementation on a suite that
  # just failed. The flag is set inside the loop because a pipeline's status is
  # its last command's, and the last command here is `done`.
  [ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
  ```

  The glob must not simply be `test/*.test.mjs`: that includes `escape.test.mjs`, which writes decoys into the shared `~/.reeve/canary/` tree the live daemon reads and probes the login keychain. Advertising a command that contradicts the warning beside it means the warning loses.
- **The baseline: 93 test files, 0 failures, 5,131 PASS assertions, excluding `test/escape.test.mjs`, on the content of `16cd880`, under `REEVE_HOME` pointing at a directory literally named `.reeve`.** That is the base every task in this plan is measured against — **never a chained comparison against the previous task.** The prior figure of 91 files / 5,006 PASS was measured at `c500cfe`; reeve#49 added `test/doctor-body-detector.test.mjs` and `test/review-body-findings.test.mjs`. The instrument was controlled before its output was believed: one file (`test/verdict.test.mjs`) reports 72 PASS lines alone, so the counter counts something, and a deliberately red probe exits 1 and the accumulator sees it, so a red file could not have been absorbed silently.
- **"Append to `test/x.test.mjs`" always means "insert before that file's terminator."** Every test file in this repository ends with a cleanup line and `process.exit(fail ? 1 : 0)`. A block pasted after `process.exit` never runs, **and the file still reports green** — the worst available outcome, because it is indistinguishable from a passing test. Each append step below names its terminator explicitly.
- **Conventional Commits**, lowercase, `type(scope): subject`, ≤72 characters. **No attribution trailer of any kind.** Never `--no-verify`.
- Every change carries a what/why comment in the style of the file it lands in. Comments never reference tasks, plans, findings, or this document.
- **No raw SQL outside `src/db/` and `src/build/`.** MEASURED at `16cd880`: **12 paths already violate that rule with 102 `.prepare()` calls** (`bin/reeve` 7, `src/backup.mjs` 27, `src/daemon.mjs` 14, `src/doctor.mjs` 5, `src/github/reconciler.mjs` 8, `src/outbox/drain.mjs` 1, `src/pr.mjs` 1, `src/review/derive.mjs` 19, `src/review/ingest.mjs` 5, `src/review/shadow.mjs` 4, `src/selfaudit.mjs` 5, `src/status.mjs` 6), and the guard that exists checks exactly one file. **Do not add a thirteenth.** Every statement this plan writes lands in `src/build/`; `bin/reeve`'s new route calls into `src/build/taskfile.mjs` and prepares nothing itself. Widening the guard is a separate cleanup and is not this plan's.
- **Every hub-writing call site passes `isSameProcess` explicitly. A default `isAlive` in a production path is a defect, not a shortcut.** `admitTask`'s own default is `() => true` (`src/build/registry.mjs:218`), which fails **open**: it treats a restore holder as dead and admits a filing while the file is being replaced underneath it. `src/build/loop.mjs:11-17` documents exactly this hazard for the sibling function and explains why the caller that can answer the liveness question must answer it. `fileTask` therefore takes `isAlive` with **no default** and throws when it is absent; Task 3 asserts both halves.
- No `as any`, no `@ts-expect-error`, no lint suppression.
- **Escalation keys are identities.** No counts, durations, paths, or SHAs in the key. This plan mints none of its own; it passes `phases.mjs`'s through unchanged, including the `<phase>` that `nextPhase` substitutes at `phases.mjs:441`.
- **Rule 15 (§1.7) still binds, and its premise has changed.** `revnix/reeve` was made **PUBLIC** on 2026-08-27 — a deliberate founder decision, taken with the exposure audited and in front of them, to restore Actions minutes exhausted at the org level. So the old form of this constraint (*"this plan touches only `revnix/reeve`, which is private"*) is **false and must not be restated**. What survives is the rule itself, unchanged: **no effect this stage produces against any OTHER repository may name reeve** — not a branch, a commit message, a PR title or body, a check name, a label, or a comment marker. The spec repos S3 provisions must be **private**, and design `:77` refuses to run against a spec repo whose visibility is anything but exactly `private`. Reeve naming itself, inside its own now-public repository, is not a Rule 15 violation; naming reeve in an artifact it sends elsewhere always is.
- **Every timestamp is `INTEGER` seconds from `unixepoch()`** unless the column name ends `_ms`. Never a TEXT date.
- **S3 is the first stage that dispatches a builder worker. No task in S3 performs any GitHub effect, opens any PR, or enqueues any outbox row of a `gh.*` or `git.push.branch` kind; the switches for those are off and S3 does not change that and must not.** And nothing in S3-B dispatches a worker at all: the dispatch seam is S3-C's T6.

### Isolation while this plan is being written or executed

A guardian daemon is live on the founder's host, running from the **main checkout** rather than from a copy. Therefore, for anyone executing this plan:

- Work in a worktree (`git worktree add -b <branch> ~/Work/Products/reeve-wt/<name> origin/main`), never in `~/Work/Products/reeve`. A `git pull` there swaps code under a running process.
- Do not run `reeve canary`: it costs a real model call and writes one shared state file at `~/.reeve/canary/<owner>/<repo>.json` that the daemon also reads. Last writer wins.
- Do not restart the daemon, run `launchctl`, or stop the service. `reeve doctor` is read-only and is fine.
- **No test in this plan may open the real hub.** Every one creates its own store with `openHub(join(dir, "…db"))` under `mkdtempSync`. `test/lifecycle.test.mjs:6-9` already records a fixed-path collision when the UTC and `TZ=Asia/Karachi` passes ran concurrently, and CI runs the suite under three time zones.
- `tasks/reeve-tasks/trackers/s3.md` conflicts on every branch. Add the tracker row as the **last commit before opening the PR**, so the conflict is one line.

### What S2 measured, which changes how these tests are written

Do not re-derive any of these.

| Measured fact | Consequence for S3-B |
|---|---|
| `admitTask`'s `isAlive` defaults to `() => true` — fail-open — and `src/build/loop.mjs:11-17` records why a daemon path must override it | `fileTask` takes no default and throws without one. Task 3 asserts the throw **and** the literal counter-control: a `fileTask` given `isSameProcess` while a live maintenance lock is held is refused, so the assertion is not passing on the absence of a lock. |
| `withWriterLease` releases in a `finally` and always releases, including on a throw (`src/build/locks.mjs:88-101`) | Every filing test asserts `SELECT count(*) FROM writer_lease` is 0 afterwards, on the refusal path as well as the success path. A wedged lease makes restore refuse forever for a command that is long gone. |
| `normalizeClaim("")` returns the repository **root** prefix, never "no claim" (`src/build/registry.mjs:71-74`) | "No `--territory`" and "an empty `--territory`" are different refusals. The first is the grammar message; the second is a root-prefix claim that conflicts with every live lease in the project. Task 1 asserts both, separately. |
| `hubTx` uses `BEGIN IMMEDIATE` and **node:sqlite throws on a nested BEGIN** | Task 3's network-first assertion is written as a nested-transaction probe: the injected `io.repoId` runs `hubTx(db, () => 1)`, which succeeds only if no transaction is open when the network half runs. |
| `transition.mjs:775` refuses `phase.succeeded` on a worker phase with no `artifactSha`, **durably** — it appends a `transition.refused` `hub_event` (`refuseDurably`, `:761`) | PR-B2 and PR-B3 assert refusals by reading that event's `payload.refusal`, not by trusting the returned object alone. A refusal with no record is indistinguishable from a report that was never sent. |
| `phase_event` and `task` are `STRICT` tables; `task.depth` CHECKs `trivial\|standard\|deep` and `task.priority` CHECKs `p1\|p2` (`src/build/hub.sql:33-34`) | `--depth` and `--priority` are validated in `taskfile.mjs` before the transaction, with the CHECK's own vocabulary, so a bad value is a reasoned refusal rather than a constraint error inside a rollback. |
| A green file can hide a skip | Every new test file prints a `PASS` line for its controls, so a control that stopped running is visible as a missing line rather than as silence. |

### Decisions taken by the founder for this stage, 2026-08-27

Recorded so no executor re-litigates them.

1. **Task numbering restarts at 1 in each plan document** (`../MASTER-PLAN.md` §B.8). S2's continuity across a family was a residue of the retired single document. Cross-references are written `S3-A Task 2`, `S3-C Task 1`.
2. **`specRepo` and `gateDefinitionPaths` are provisioned now** — brief Q1, **Option A**. `SNAPSHOT_FIELDS` (`src/build/phases.mjs:156`) requires all eleven facts at admission, including `specRepoId` and `gateDefinitionHash`, which S3 uses for nothing. Option B splits that list into three, and the comment at `phases.mjs:150-155` records that the list was consolidated *because* it lived inside one branch and admission could not consult it — *"A partial snapshot is the failure that looks like success: the columns it does carry are correct."* Splitting it reopens the shape the list exists to close. Option C, a `-1` sentinel, is refused outright by §11.1's immutable-numeric-id rule. **The spec-repo names are a founder input** and are tracked as F1 in `../trackers/s3.md` §2: S3-A T2 resolves them like any other registry field, and this plan's tests supply them from a fixture registry, never from the live one.
3. **S3 adds no migration, because it adds no column.** `phase_event.artifact_sha` (`hub.sql:143`), `task.depth` and `task.priority` (`:33-34`) already exist. W2's three hand-maintained inventories (`TABLES_AT`, `COLUMNS_AT`, `LOCK_COLUMNS`) are therefore untouched by this plan and issue reeve#43 is not a blocker for it. **If any task here finds it needs a column, stop:** reeve#43 lands first, or this plan owes three new inventory entries.
4. **`reviewDiff`'s existing signature is not changed here.** §4.6 (`:319`) requires two sibling functions each *"asserted at the dispatch seam"*, and §15 item 2 (`:875`) records that the optional `gate` parameter **lost** to the sibling function. `reviewArtifact` is therefore written with no optional parameter anywhere. `reviewDiff` today carries `lane = null, action = null` and is guardian-shared — `src/daemon.mjs:2971` is its live caller — so removing its defaults is a guardian-touching change, and the corpus's two worst-converging PRs both touched the running guardian. PR-B2 adds **one** thing to it: a throw when it is handed an artifact phase name. That is the assertion §4.6 asks for, and it is additive.
5. **`--pin-territory` takes a duration**, as the design writes it (`:127`, `[--pin-territory 48h]`), not as a bare switch. `S3-DESIGN-BRIEF.md` §2.2 T3 lists it in a flag run that reads as switches; the design and `grantLease`'s `pinnedUntil` parameter (`src/build/territory.mjs:141`) both say otherwise, and the design wins.
6. **S3 does not flip `builder.capabilities.observe` on in the live profile.** This plan *reads* it, and only to print it under `--dry-run`. The live flip is a separate founder action after the last S3 PR merges.

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
| `src/build/taskfile.mjs` (new, PR-B1) | `fileTask`, `TERRITORY_GRAMMAR`, `mintTaskId`, `normalizeFiling`, `dryRunPlan`. The whole of `reeve task file` except argv parsing: network first, then one writer lease around one `admitTask`. Importable, and it imports nothing from `node:child_process`. |
| `bin/reeve` (PR-B1) | a `task` route with a `file` subcommand, and eleven new `FLAGS` entries. Prepares no statement of its own. |
| `src/build/registryio.mjs` (S3-A T2, extended PR-B1) | gains `titleHash(title)`, the normalized-title sha256 `source_key` of §2.1 (`:123`). |
| `src/paths.mjs` (PR-B2) | gains `taskPathFor(home, taskId)`, `artifactPathFor(home, taskId, phase)` and `runPathFor(home, taskId, run)` beside `hubPathFor`. |
| `src/build/artifact.mjs` (new, PR-B2) | `ARTIFACT_FILE`, `writeArtifact` (tmp + fsync + rename + fsync of the directory), `readArtifact` (read back and verify the sha), `reviewArtifact`. The durable half of §3.2's *"a transition commits only after its phase artifact is durable"*. |
| `src/sandbox.mjs` (PR-B2) | `reviewDiff` throws when handed an artifact phase name. Nothing else changes. |
| `src/build/schemas/build_size.json`, `build_research.json`, `build_design.json` (new, PR-B3) | one JSON Schema per action, each carrying `outcome`/`reason`, each rejecting `{}`. |
| `src/build/report.mjs` (new, PR-B3) | `schemaFor`, `validateReport`, `evidenceFor`, `badReportPlan`. The dependency-free validator subset, and the map from a report's `outcome` to the evidence `nextPhase` already accepts. |
| `test/task-file.test.mjs` (new, PR-B1) | the grammar refusal, the root-prefix rule, the conflict refusal with an unchanged row count, network-first, the writer lease, liveness, idempotency, `--anyway`, `--dry-run`, `--json`. |
| `test/cli-flags.test.mjs` (PR-B1, append) | every new flag is registered, and every valued one refuses an empty value. |
| `test/cli-routing.test.mjs` (PR-B1, append) | `task` reaches its own body and does not fall through into `build`. |
| `test/artifact.test.mjs` (new, PR-B2) | the interrupted-write drill, the read-back sha, `reviewArtifact`'s minima and its control, and both directions of the phase guard. |
| `test/state-paths.test.mjs` (PR-B2, append) | the three new path shapes, and that a task id cannot escape the tasks directory. |
| `test/phase-report.test.mjs` (new, PR-B3) | each schema rejects `{}`, the mis-attributed and depth-less refusals asserted through `applyTransition`, the `blocked_other` escalation rule, one resumed retry then ESCALATED, and the well-formed control. |

---

# PR-B1: `reeve task file`

**Branch:** `feat/s3-task-file`, based on S3-A T2's merge commit. **Scope:** the `task` route, `src/build/taskfile.mjs`, the eleven new flags, and `titleHash` in `registryio.mjs`. ~900 changed lines. **Nothing in PR-B1 reads or writes GitHub, dispatches a worker, or enqueues an outbox row of any kind.**

---

### Task 1: A filing with no territory is refused with the grammar and an example, and an empty claim is the repository root

**Files:**
- Create: `src/build/taskfile.mjs`, `test/task-file.test.mjs`
- Test: `test/task-file.test.mjs` (new; Tasks 2-4 append to it before its terminator)

**Interfaces:**
- Consumes: `normalizeClaim` (`src/build/registry.mjs:68`), `resolveSnapshot` (`:183`), `admitTask` (`:218`), `openHub` (`src/build/hubdb.mjs:322`), `isSameProcess`/`readStart` (`src/supervisor.mjs:67,40`).
- Produces: `TERRITORY_GRAMMAR: string` — the one refusal text for a territory-less filing, naming the flag, what the grammar refuses, and one worked example. `normalizeFiling({title, territory, depth, priority}) -> {claims} | {refusal}` — grammar only, no I/O, no database. Task 2 files through it; S3-E Task 1 (`task show`) renders the same claim rows it produces.

- [ ] **Step 1: Write the failing test**

Create `test/task-file.test.mjs` with `/* ... standard harness ... */` (slug `taskfile`), plus these imports and this fixture at module scope. **Tasks 2, 3 and 4 append to this file and reuse every binding below**; none of them re-imports or re-declares one, because a second `const registry` in the same module is a duplicate declaration and the file would fail to parse, which is a worse failure than the missing binding it was meant to fix.

```js
import { mkdirSync, lstatSync } from "node:fs";
import { openHub } from "../src/build/hubdb.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { fileTask, TERRITORY_GRAMMAR } from "../src/build/taskfile.mjs";

// A real project on disk, because the claim walk lstats every ancestor of every
// claim and a fixture with no directories cannot exhibit a symlink refusal.
const repo = join(dir, "repo");
mkdirSync(join(repo, "packages", "x"), { recursive: true });
writeFileSync(join(repo, "p.json"), "{}\n");

// `resolveSnapshot` takes the registry as an object keyed by project name, with
// a `version`. That is NOT the array `registryProjects` returns; the route
// converts. Building the object shape here keeps the unit tests honest about
// which of the two this function actually consumes.
const registry = { version: 1, projects: {
  nextly: { nwo: "nextlyhq/nextly", repoPath: repo, profilePath: join(repo, "p.json") } } };

// Every network read the snapshot needs, injectable, none of them real.
const mkIo = (over = {}) => ({
  lstat: (p) => lstatSync(p),
  lsTree: () => null,
  repoId: async () => 42,
  profileHash: async () => "ph-1",
  defaultBranch: async () => "main",
  visibility: async () => "private",
  specRepoId: async () => 77,
  gateDefinitionHash: async () => "gd-1",
  founderUserId: async () => 9,
  ...over,
});

let n = 0;
const store = () => openHub(join(dir, `h${++n}.db`));
const tasks   = (db) => db.prepare("SELECT count(*) c FROM task").get().c;
const evseq   = (db) => db.prepare("SELECT COALESCE(MAX(seq),0) s FROM hub_event").get().s;
const writers = (db) => db.prepare("SELECT count(*) c FROM writer_lease").get().c;

const base = (db, over = {}) => ({
  db, registry, project: "nextly", title: "a scout task",
  territory: ["packages/x"], io: mkIo(), isAlive: isSameProcess,
  pid: process.pid, lstart: readStart(process.pid), ...over,
});

// No --territory at all. The refusal has to teach the grammar, and it has to
// arrive before any network call: a filing that cannot be admitted must not
// cost a round trip to find that out.
{
  const db = store();
  let touched = false;
  const r = await fileTask(base(db, {
    territory: [], io: mkIo({ repoId: async () => { touched = true; return 42; } }) }));
  check(r.ok === false, "a filing with no --territory is refused", JSON.stringify(r));
  check(r.refusal === TERRITORY_GRAMMAR, "with the one grammar refusal, not an ad-hoc string", r.refusal);
  check(/--territory/.test(r.refusal), "which names the flag", r.refusal);
  check(/packages\/x/.test(r.refusal), "and shows a worked example", r.refusal);
  check(/glob/.test(r.refusal) && /traversal/.test(r.refusal),
    "and states what the grammar refuses", r.refusal);
  check(touched === false, "and nothing reached the network to find that out");
  check(tasks(db) === 0 && writers(db) === 0,
    "and no task row and no writer lease exist afterwards", `${tasks(db)}/${writers(db)}`);
  db.close();
}

// An empty claim is the ROOT, never no-claim. The absence of a territory claim
// must never read as the absence of conflict.
{
  const db = store();
  const a = await fileTask(base(db, { title: "the root claimant", territory: ["  "] }));
  check(a.ok === true, "an empty claim is admitted as a claim, not dropped", JSON.stringify(a));
  const row = db.prepare("SELECT kind, path FROM task_territory WHERE task=?").get(a.task);
  check(row?.kind === "prefix" && row?.path === "",
    "and it is stored as the repository root prefix", JSON.stringify(row));

  const b = await fileTask(base(db, { title: "an unrelated package" }));
  check(b.ok === false,
    "and a root-prefix task blocks every concurrent grant in its project", JSON.stringify(b));
  check(String(b.refusal).includes(a.task), "naming the root task as the blocker", b.refusal);
  check(tasks(db) === 1, "and the blocked filing inserted nothing", String(tasks(db)));
  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/task-file.test.mjs`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/build/taskfile.mjs'` — the module does not exist yet, so the file fails at import and reaches no assertion.

**On the broken implementation** — the one that reads a whitespace-only `--territory` as no territory at all, by filtering blanks out of the list before counting it (`territory.filter(t => t.trim()).length`, the shape an implementer reaches for first) — `an empty claim is admitted as a claim, not dropped`, `and it is stored as the repository root prefix` and `and a root-prefix task blocks every concurrent grant in its project` all go red. `a filing with no --territory is refused` and its four message assertions stay **green**: they are the control for the other branch, and they are what proves the refusal path still works while the root-claim path is broken. That is the whole point of asserting the two separately — one implementation collapses them and only one half turns red.

**The stub loop for this task**: run the file and see all eleven assertions green (control); apply the stub by replacing `if (!claims.length)` in `normalizeFiling` with `if (!raw.filter(t => String(t).trim()).length)` and confirm with `grep -n 'String(t).trim' src/build/taskfile.mjs` that it is present; re-run and confirm exactly the three named assertions are red and the grammar assertions are green; restore with `cp src/build/taskfile.mjs.bak src/build/taskfile.mjs` from a copy taken before the edit — **never `git checkout`**, which restores to the last commit and silently discards uncommitted work.

- [ ] **Step 3: Implement the grammar half of `src/build/taskfile.mjs`**

```js
// taskfile -- `reeve task file`, importable.
//
// Split from `bin/reeve` so the command's behaviour can be tested without
// spawning the binary, and so every statement it runs lives under src/build/,
// which is one of the two directories allowed to contain raw SQL.
import { normalizeClaim } from "./registry.mjs";

const DEPTHS = ["trivial", "standard", "deep"];
const PRIORITIES = ["p1", "p2"];

// ONE refusal string, exported, so the test asserts the message the operator
// gets rather than a paraphrase of it. Territory is required at filing and the
// absence of a claim must never read as the absence of conflict, so this is the
// only place that decides how that requirement is explained.
export const TERRITORY_GRAMMAR =
  "a filing must declare its territory: pass --territory <path>, repeatable, " +
  "or --territory-file <file> with one path per line. A claim is a " +
  "repository-relative path -- no glob, no negation, no brace expansion, no " +
  "character class, no absolute path and no parent traversal. " +
  'Example: reeve task file --project nextly --title "..." ' +
  "--territory packages/x --territory packages/y/index.ts";

/**
 * Grammar only: no filesystem, no network, no database.
 *
 * A whitespace-only claim is NOT dropped. `normalizeClaim` returns the
 * repository root for it deliberately, and filtering it out here would turn a
 * claim that conflicts with everything into a filing that conflicts with
 * nothing -- the one reading the grammar exists to refuse.
 */
export function normalizeFiling({ title, territory, depth, priority }) {
  if (typeof title !== "string" || !title.trim())
    return { refusal: "a filing needs a --title; it is what the task is named in every later view" };
  if (depth !== null && !DEPTHS.includes(depth))
    return { refusal: `--depth must be one of ${DEPTHS.join(", ")}; got ${JSON.stringify(depth)}` };
  if (!PRIORITIES.includes(priority))
    return { refusal: `--priority must be one of ${PRIORITIES.join(", ")}; got ${JSON.stringify(priority)}` };
  if (!Array.isArray(territory) || territory.length === 0)
    return { refusal: TERRITORY_GRAMMAR };

  const claims = [];
  for (const raw of territory) {
    const c = normalizeClaim(raw, { kind: "prefix" });
    if (c.refusal) return { refusal: c.refusal };
    claims.push(c);
  }
  return { claims };
}
```

- [ ] **Step 4: Implement the admission half, run it green, and commit**

`fileTask`'s full body arrives in Task 3, which adds the network-first ordering and the writer lease. This task adds the smallest version that satisfies its own assertions: normalize, resolve, admit.

Extend Step 3's `import { normalizeClaim } from "./registry.mjs";` to `import { normalizeClaim, resolveSnapshot, admitTask } from "./registry.mjs";` rather than writing a second import of the same module, and add the two below.

```js
import { randomBytes } from "node:crypto";
import { readStart } from "../supervisor.mjs";

// bt:<ulid>. Crockford base32 over 48 bits of millisecond time and 80 bits of
// randomness, so ids sort by filing order in every listing that has only the id
// to sort by, and two filings in the same millisecond still differ.
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function mintTaskId(at = Date.now(), rnd = randomBytes(10)) {
  let s = "";
  for (let i = 9; i >= 0; i--) { s = C32[at % 32] + s; at = Math.floor(at / 32); }
  let bits = 0n;
  for (const b of rnd) bits = (bits << 8n) | BigInt(b);
  for (let i = 0; i < 16; i++) { s += C32[Number((bits >> BigInt(75 - i * 5)) & 31n)]; }
  return `bt:${s}`;
}

export async function fileTask({ db, registry, project, title, territory,
                                 body = null, depth = null, priority = "p2",
                                 idempotencyKey = null, io, isAlive,
                                 pid = process.pid, lstart = readStart(process.pid) }) {
  // NO DEFAULT, and a throw rather than a fallback. `admitTask` defaults
  // `isAlive` to `() => true`, which treats a live restore's holder as dead and
  // admits a filing while the hub file is being replaced underneath it. The
  // caller that owns a process is the caller that can answer the question.
  if (typeof isAlive !== "function")
    throw new Error("fileTask needs a liveness predicate; pass isSameProcess. A default here fails open.");

  const filing = normalizeFiling({ title, territory, depth, priority });
  if (filing.refusal) return { ok: false, refusal: filing.refusal };

  const snapshot = await resolveSnapshot(registry, project, filing.claims, io);
  if (snapshot.refusal) return { ok: false, refusal: snapshot.refusal };

  const id = mintTaskId();
  const r = admitTask(db, snapshot, { id, project, title, body,
    sourceKind: "founder", idempotencyKey }, { isAlive });
  if (!r.ok) return { ok: false, refusal: r.refusal };
  return { ok: true, task: r.taskId, replayed: r.replayed === true };
}
```

```bash
cp src/build/taskfile.mjs src/build/taskfile.mjs.bak     # the stub loop's restore copy
$N test/task-file.test.mjs                                # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
rm -f src/build/taskfile.mjs.bak
git add src/build/taskfile.mjs test/task-file.test.mjs
git commit -m "feat(build): the territory grammar for reeve task file"
```

---

### Task 2: A conflicting filing names the blocking task, and inserts nothing at all

**Files:**
- Modify: `src/build/taskfile.mjs` (`fileTask`; the block after `const snapshot = await resolveSnapshot`)
- Test: `test/task-file.test.mjs` (append before the terminator — the closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group)

**Interfaces:**
- Consumes: `conflictRefusal` (`src/build/territory.mjs:121`), `liveLeases` (`:102`), `firstConflict` (`:117`), `admitTask` (`src/build/registry.mjs:218`), and Task 1's fixture bindings `store`, `base`, `tasks`, `evseq`.
- Produces: nothing new. This task asserts a property of what Task 1 built, and adds the `--pin-territory` duration parse `fileTask` needs to pass `pinnedUntil` through.

- [ ] **Step 1: Append the failing test**

Append to `test/task-file.test.mjs`, **before** its closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group:

```js
// A conflict is a refusal, not a queue: founder filings are never queued behind
// a lease. What matters as much is that the refused filing leaves NOTHING --
// `admitTask` writes the task row before it grants leases, so a refusal that
// escaped the transaction would leave a task with no territory holding no lease
// and blocking nothing, which reads as a filed task in every later view.
{
  const db = store();
  const a = await fileTask(base(db, { title: "holds packages/x" }));
  check(a.ok === true, "the first filing is admitted", JSON.stringify(a));

  const before = tasks(db), seqBefore = evseq(db);
  const b = await fileTask(base(db, { title: "wants packages/x/deep", territory: ["packages/x/deep"] }));
  check(b.ok === false, "an overlapping filing is refused", JSON.stringify(b));
  check(String(b.refusal).includes(a.task), "and the refusal names the blocking task", b.refusal);
  check(/overlaps/.test(String(b.refusal)), "and says what overlapped what", b.refusal);
  check(tasks(db) === before, "and the task-row COUNT is unchanged", `${tasks(db)} vs ${before}`);
  check(evseq(db) === seqBefore, "and no hub_event was appended", `${evseq(db)} vs ${seqBefore}`);
  check(db.prepare("SELECT count(*) c FROM territory_lease").get().c === 1,
    "and exactly one lease still exists, the first task's");

  // A DISJOINT claim in the same project is not a conflict. Without this the
  // count assertions above would also pass against an implementation that
  // refuses every second filing.
  const c = await fileTask(base(db, { title: "wants packages/y", territory: ["packages/y"] }));
  check(c.ok === true, "control: a disjoint claim in the same project is admitted", JSON.stringify(c));
  check(tasks(db) === before + 1, "and it is the only thing that grew the table", String(tasks(db)));
  db.close();
}

// The successful path's own control: one task, N territory rows, N leases, and
// the four events, all from one call.
{
  const db = store();
  const r = await fileTask(base(db, { title: "two claims", territory: ["packages/x", "packages/y"] }));
  check(r.ok === true, "a filing with two claims is admitted", JSON.stringify(r));
  check(db.prepare("SELECT count(*) c FROM task_territory WHERE task=?").get(r.task).c === 2,
    "and writes one task_territory row per claim");
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task=?").get(r.task).c === 2,
    "and one territory_lease row per claim");
  const kinds = db.prepare("SELECT kind FROM hub_event WHERE task=? ORDER BY seq").all(r.task).map(e => e.kind);
  check(kinds[0] === "task.filed", "with the parent event first, so a replay can rebuild it", kinds.join(","));
  check(kinds.filter(k => k === "task_territory.claimed").length === 2 &&
        kinds.filter(k => k === "territory_lease.granted").length === 2,
    "and a claimed and a granted event for each claim", kinds.join(","));
  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/task-file.test.mjs`
Expected: green on every assertion above **except** the two-claim block's ordering assertion if `fileTask` reorders claims — and red on `and the task-row COUNT is unchanged` for any implementation that inserts before it scans. Record which lines are red before touching anything: if every assertion is green on the first run, the property is untested and Step 3 has nothing to prove.

**On the broken implementation** — the one that catches `admitTask`'s refusal *outside* the transaction and re-inserts a bare task row so the operator "has something to look at" (the shape an implementer reaches for when a refusal loses the title the founder typed) — `and the task-row COUNT is unchanged` and `and no hub_event was appended` go red, while `an overlapping filing is refused` and `and the refusal names the blocking task` stay **green**. A refusal that is *returned* and a refusal that *changed nothing* are two different facts, and only the count assertions can tell them apart.

**The stub loop for this task**: run the file green (control); apply the stub by inserting `if (!r.ok) db.prepare("INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at) VALUES(?,?,?,?,?,'FILED',1,'founder',?,?,?,?,?,?,?,unixepoch(),unixepoch())").run(id, project, snapshot.repoId, snapshot.nwo, title, id, snapshot.repoPath, snapshot.profilePath, snapshot.profileHash, snapshot.defaultBranch, snapshot.visibility, snapshot.registryVersion);` immediately before `fileTask`'s refusal return, and confirm with `grep -c 'INSERT INTO task(' src/build/taskfile.mjs` that it reads 1; re-run and confirm the two count assertions are red and the refusal assertions green; restore by copying back `src/build/taskfile.mjs.bak`, then re-run and confirm green. Remove the stub statement afterwards — it is also the thirteenth raw-SQL site if it is left in a file outside `src/build/`, and it must not survive the loop even inside one.

- [ ] **Step 3: Add the pin duration, and nothing else**

`admitTask` already performs the intersection check inside its transaction and already returns `conflictRefusal`'s text, so this task adds no conflict logic. It adds only what `--pin-territory 48h` needs, in `taskfile.mjs`:

```js
// A pin is a DEADLINE, not a switch: `--pin-territory 48h`. `grantLease` stamps
// the deadline on the claim at the first grant and reads it back at every later
// one, so the value passed here is used exactly once and a wrong unit is a wrong
// promise the founder cannot see. Hours and days only; a bare number is refused
// rather than guessed at.
const PIN = /^(\d+)([hd])$/;
export function pinSeconds(raw) {
  if (raw === null || raw === undefined) return null;
  const m = PIN.exec(String(raw).trim());
  if (!m) return { refusal: `--pin-territory takes a duration like 48h or 3d; got ${JSON.stringify(raw)}` };
  return Number(m[1]) * (m[2] === "h" ? 3600 : 86400);
}
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/task-file.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add src/build/taskfile.mjs test/task-file.test.mjs
git commit -m "feat(build): refuse an overlapping filing without inserting a row"
```

---

### Task 3: The network runs before the transaction opens, the write holds a writer lease, and liveness is never defaulted

**Files:**
- Modify: `src/build/taskfile.mjs` (`fileTask`; the block after `const snapshot = await resolveSnapshot`)
- Test: `test/task-file.test.mjs` (append before the terminator)

**Interfaces:**
- Consumes: `withWriterLease` (`src/build/locks.mjs:88`), `assertWritable` (`:156`), `acquireMaintenanceLock` (`:116`), `hubTx` (`src/build/hubdb.mjs:619`), `isSameProcess`/`readStart` (`src/supervisor.mjs:67,40`), and Task 1's fixture bindings.
- Produces: `fileTask` holding a `writer_lease` for the duration of its write and releasing it on both paths. S3-C Task 1 dispatches under the same rule; S3-E Task 3 (`builder doctor`) reports a lease this function failed to release.

- [ ] **Step 1: Append the failing test**

Append to `test/task-file.test.mjs`, before its closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group. It needs two imports beyond Task 1's; add them to the import block at the top of the file rather than here, because a second `import` of the same module inside the file body is not valid where these assertions sit:

```js
import { acquireMaintenanceLock } from "../src/build/locks.mjs";
import { hubTx } from "../src/build/hubdb.mjs";
```

```js
// NETWORK FIRST, TRANSACTION SECOND, asserted as a property of the database
// rather than as a claim about call order. node:sqlite throws on a nested
// BEGIN, so a hubTx that succeeds from inside the io proves no transaction was
// open while the network half ran. A test that merely recorded the order of two
// callbacks would pass against an implementation that opened the transaction
// first and did its I/O inside it.
{
  const db = store();
  let nested = null;
  const r = await fileTask(base(db, { title: "network first",
    io: mkIo({ repoId: async () => { try { hubTx(db, () => 1); nested = "open"; }
                                     catch (e) { nested = String(e.message); } return 42; } }) }));
  check(r.ok === true, "the filing succeeds", JSON.stringify(r));
  check(nested === "open",
    "and no transaction was open while the network reads ran", String(nested));
}

// The lease exists for the duration and is gone afterwards, on BOTH paths.
{
  const db = store();
  const ok = await fileTask(base(db, { title: "leases and releases" }));
  check(ok.ok === true, "a successful filing returns", JSON.stringify(ok));
  check(writers(db) === 0, "and leaves no writer lease behind", String(writers(db)));

  const bad = await fileTask(base(db, { title: "refused, still releases", territory: ["packages/x"] }));
  check(bad.ok === false, "control: the second filing is refused as a conflict", JSON.stringify(bad));
  check(writers(db) === 0,
    "and a REFUSED filing leaves no writer lease behind either", String(writers(db)));
  db.close();
}

// A live restore makes the hub read-only, and the filing must say so rather
// than write into a file that is being replaced.
{
  const db = store();
  const held = acquireMaintenanceLock(db,
    { pid: process.pid, lstart: readStart(process.pid), isAlive: isSameProcess });
  check(held.ok === true, "control: the maintenance lock was actually taken", JSON.stringify(held));
  const r = await fileTask(base(db, { title: "during a restore" }));
  check(r.ok === false, "a filing during a live restore is refused", JSON.stringify(r));
  check(/restore is in progress/.test(String(r.refusal)),
    "and the refusal names the restore, not a generic failure", r.refusal);
  check(tasks(db) === 0, "and nothing was written", String(tasks(db)));
  check(writers(db) === 0, "and no writer lease was left behind", String(writers(db)));
  db.close();
}

// Liveness is never defaulted. A production path that omits it fails OPEN --
// the filing above would have been admitted during the restore.
{
  const db = store();
  const { isAlive, ...noLiveness } = base(db, { title: "no predicate" });
  let threw = null;
  try { await fileTask(noLiveness); } catch (e) { threw = String(e.message); }
  check(threw !== null && /liveness/.test(threw),
    "fileTask throws rather than defaulting isAlive", String(threw));
  check(tasks(db) === 0, "and wrote nothing on the way to throwing", String(tasks(db)));
  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/task-file.test.mjs`
Expected: `and a REFUSED filing leaves no writer lease behind either`, `a filing during a live restore is refused` and `and the refusal names the restore, not a generic failure` are red — Task 1's `fileTask` takes no lease at all, so nothing calls `assertWritable` on the CLI path and `admitTask`'s own `assertWritable` throws out of the function rather than returning a refusal.

**On the broken implementation** — the one that wraps only the *success* return in `withWriterLease` and returns early on a refusal before ever taking it, or the one that lets `assertWritable`'s throw escape uncaught — `and a REFUSED filing leaves no writer lease behind either` stays green for the wrong reason (no lease was ever taken), while `a filing during a live restore is refused` goes red because the function throws instead of returning `{ok:false}`. `control: the maintenance lock was actually taken` is what stops that red being read as "there was no lock": it fails loudly if the fixture never reached the mechanism.

**The stub loop for this task**: run green (control); apply the stub by changing `if (typeof isAlive !== "function") throw …` to `isAlive = isAlive ?? (() => true);` and confirm with `grep -c '() => true' src/build/taskfile.mjs` that it reads 1; re-run and confirm `fileTask throws rather than defaulting isAlive` is red **and** `a filing during a live restore is refused` is red too — the second is the one that matters, because it shows the default is not merely untidy but admits a filing during a restore; restore from `src/build/taskfile.mjs.bak` and re-run green.

- [ ] **Step 3: Wrap the write, and catch the read-only throw**

Replace `fileTask`'s admission block with this. The ordering is the contract: everything above `withWriterLease` may perform I/O and must not touch the database; everything inside it touches the database and must not perform I/O.

```js
import { withWriterLease } from "./locks.mjs";

  // THE LEASE COVERS THE WRITE, and the write only. `withWriterLease` inserts
  // its row in one transaction, runs the callback outside any transaction, and
  // deletes the row in a second -- so `admitTask`'s own BEGIN IMMEDIATE nests
  // nothing. Restore reads `writer_lease` to decide whether a command is
  // mid-write, and a lease taken across the network calls above would make a
  // slow GitHub read look like an in-progress hub write for its whole duration.
  const id = mintTaskId();
  try {
    const r = withWriterLease(db,
      { command: "reeve task file", pid, lstart, isAlive },
      () => admitTask(db, snapshot, { id, project, title, body,
        sourceKind: "founder", idempotencyKey }, { isAlive }));
    if (!r.ok) return { ok: false, refusal: r.refusal };
    return { ok: true, task: r.taskId, replayed: r.replayed === true };
  } catch (e) {
    // `assertWritable` THROWS while a live restore holds the lock, and it is
    // reached from two places inside this call. A throw here is an operator
    // condition with a useful message, not a defect, so it is returned as the
    // refusal it is; anything else is re-raised unchanged.
    if (/restore is in progress/.test(String(e?.message))) return { ok: false, refusal: e.message };
    throw e;
  }
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/task-file.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add src/build/taskfile.mjs test/task-file.test.mjs
git commit -m "feat(build): hold a writer lease for the filing transaction"
```

---

### Task 4: `--dry-run` writes nothing, `--idempotency-key` replays, `--anyway` salts the source key, and `--json` answers the standard mutating shape

**Files:**
- Modify: `src/build/taskfile.mjs` (`fileTask`; adds `dryRunPlan`), `src/build/registryio.mjs` (adds `titleHash`), `bin/reeve` (`FLAGS` at `:263`; a new `case "task":` inserted immediately **before** `case "build": {` at `:1131`)
- Test: `test/task-file.test.mjs` (append before the terminator), `test/cli-flags.test.mjs` (append before the terminator), `test/cli-routing.test.mjs` (append before the terminator)

**Interfaces:**
- Consumes: `all` and `opt` (`bin/reeve:430,432`), `capabilitiesFrom` (S3-A Task 1), `registryProjects` (S3-A Task 2), Task 1's fixture bindings.
- Produces: `dryRunPlan({registry, project, claims, snapshot, held, switches}) -> {project, nwo, profileHash, territory, conflicts, floors, switches}` — everything §2.2 (`:129`) requires `--dry-run` to print. `titleHash(title) -> string` — the normalized-title sha256 §2.1 (`:123`) makes the founder filing's `source_key`. S3-E Task 1 renders the same `next` shape this task returns.

- [ ] **Step 1: Append the failing tests**

Append to `test/task-file.test.mjs`, before its closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group:

```js
// --dry-run writes NOTHING. Both counters, because a plan that inserted no task
// but appended an event is still a write, and the event log is what restore
// replays.
{
  const db = store();
  await fileTask(base(db, { title: "already here" }));
  const before = tasks(db), seqBefore = evseq(db);
  const r = await fileTask(base(db, { title: "a dry run", territory: ["packages/x"], dryRun: true,
                                      switches: { observe: false, publishPr: false } }));
  check(r.ok === true && r.dryRun === true, "--dry-run returns a plan", JSON.stringify(r));
  check(tasks(db) === before, "and inserts no task row", `${tasks(db)} vs ${before}`);
  check(evseq(db) === seqBefore, "and appends no hub_event", `${evseq(db)} vs ${seqBefore}`);
  check(writers(db) === 0, "and takes no writer lease", String(writers(db)));
  check(r.plan.project === "nextly" && r.plan.nwo === "nextlyhq/nextly",
    "the plan names the resolved project", JSON.stringify(r.plan));
  check(r.plan.profileHash === "ph-1", "and the profile hash it resolved", r.plan.profileHash);
  check(r.plan.territory.length === 1 && r.plan.territory[0].path === "packages/x",
    "and the normalized territory", JSON.stringify(r.plan.territory));
  check(r.plan.conflicts.length === 1 && /overlaps/.test(r.plan.conflicts[0]),
    "and the conflicts it would hit", JSON.stringify(r.plan.conflicts));
  check(Array.isArray(r.plan.floors), "and the depth floors that would fire", JSON.stringify(r.plan.floors));
  check(r.plan.switches.observe === false, "and the switches currently on", JSON.stringify(r.plan.switches));
  db.close();
}

// A retried shell script must not file twice.
{
  const db = store();
  const a = await fileTask(base(db, { title: "retried", idempotencyKey: "k-1" }));
  const before = tasks(db), seqBefore = evseq(db);
  const b = await fileTask(base(db, { title: "retried", idempotencyKey: "k-1" }));
  check(b.ok === true && b.task === a.task, "the same idempotency key returns the same task id", `${a.task} vs ${b.task}`);
  check(b.replayed === true, "and says so", JSON.stringify(b));
  check(tasks(db) === before && evseq(db) === seqBefore,
    "and performs nothing", `${tasks(db)}/${evseq(db)} vs ${before}/${seqBefore}`);
  db.close();
}

// --anyway coexists with UNIQUE(source_kind, source_key) by SALTING, so the
// near-twin admits and the constraint still holds.
{
  const db = store();
  const a = await fileTask(base(db, { title: "near twin", territory: ["packages/x"] }));
  const dup = await fileTask(base(db, { title: "near twin", territory: ["packages/y"] }));
  check(dup.ok === false, "a second filing with the same title is refused by default", JSON.stringify(dup));
  const s = await fileTask(base(db, { title: "near twin", territory: ["packages/y"], anyway: true }));
  check(s.ok === true, "--anyway admits the near twin", JSON.stringify(s));
  const keys = db.prepare("SELECT id, source_key FROM task ORDER BY created_at, id").all();
  check(keys.length === 2, "and there are exactly two tasks", JSON.stringify(keys));
  const salted = keys.find(k => k.id === s.task).source_key;
  check(salted === `${keys.find(k => k.id === a.task).source_key}:${s.task}`,
    "whose source_key is <title-hash>:<its own id>", salted);
  db.close();
}

// The mutating shape is a CONTRACT. Asserted by key set and types, never by a
// snapshot: a snapshot passes as long as the bytes match and says nothing about
// what a consumer may rely on.
{
  const db = store();
  const r = await fileTask(base(db, { title: "the json shape" }));
  check(Object.keys(r).sort().join(",") === "evidence_id,next,next_action,ok,prev,replayed,task",
    "the result carries exactly the standard mutating keys", Object.keys(r).sort().join(","));
  check(r.prev === null, "prev is null for a filing, which has no previous state", JSON.stringify(r.prev));
  check(r.next.phase === "FILED" && r.next.generation === 1, "next is the phase and generation", JSON.stringify(r.next));
  check(Number.isInteger(r.evidence_id) && r.evidence_id > 0,
    "evidence_id is the hub_event seq of the task.filed row", String(r.evidence_id));
  const ev = db.prepare("SELECT kind, task FROM hub_event WHERE seq = ?").get(r.evidence_id);
  check(ev?.kind === "task.filed" && ev?.task === r.task,
    "and it resolves to that row", JSON.stringify(ev));
  check(typeof r.next_action === "string" && r.next_action.length > 0,
    "next_action is a non-empty string", String(r.next_action));
  db.close();
}
```

Append to `test/cli-flags.test.mjs`, before its closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group. It uses that file's existing `run` helper, which spawns the binary:

```js
// Every flag the task route reads is REGISTERED. An unregistered flag is not
// ignored by this CLI, it is refused -- so a route that reads `opt("title")`
// for a flag absent from FLAGS can never be given one, and the failure is a
// did-you-mean suggestion rather than anything that names the route.
{
  const valued = ["project", "title", "territory", "territory-file", "body-file",
                  "depth", "priority", "idempotency-key", "pin-territory"];
  for (const f of valued) {
    const r = run("task", "file", `--${f}`);
    check(/expects a value/.test(r.out) && !/unknown flag/.test(r.out),
      `--${f} is registered and takes a value`, r.out.split("\n")[0]);
  }
  for (const f of ["anyway", "dry-run"]) {
    const r = run("task", "file", `--${f}=yes`);
    check(/is a switch and takes no value/.test(r.out) && !/unknown flag/.test(r.out),
      `--${f} is registered as a switch`, r.out.split("\n")[0]);
  }
  // CONTROL: the refusal machinery still refuses something that really is
  // unknown, so the assertions above are not passing on a widened parser.
  const bad = run("task", "file", "--terrritory", "packages/x");
  check(/unknown flag --terrritory/.test(bad.out),
    "control: a misspelled flag is still refused", bad.out.split("\n")[0]);
  check(/did you mean --territory/.test(bad.out),
    "and the suggestion now reaches the new flag", bad.out.split("\n")[0]);
}
```

Append to `test/cli-routing.test.mjs`, before its closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group. It uses that file's existing `run` helper:

```js
// The CLI's case labels share fall-through blocks. `task` is inserted directly
// above `build`, which is the position that captured status/statusline/dash for
// a full day when `shadow` landed there, so both directions are asserted.
{
  const t = run("task");
  check(/reeve task:/.test(t.out), "task reaches its own body", t.out.slice(0, 160));
  check(!/reeve build/.test(t.out) && !/builder tick/.test(t.out),
    "and does not fall through into build", t.out.slice(0, 160));
  check(t.code === 1, "and exits 1 without a subcommand", `exit=${t.code}`);

  const b = run("build", "status");
  check(!/reeve task:/.test(b.out), "and build still reaches its own body", b.out.slice(0, 160));
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `$N test/task-file.test.mjs; $N test/cli-flags.test.mjs; $N test/cli-routing.test.mjs`
Expected: `--dry-run returns a plan` is red (`fileTask` has no `dryRun` branch and files the task); every `--<flag> is registered` line is red with `unknown flag`; `task reaches its own body` is red because `bin/reeve` has no `task` case and prints its usage.

**On the broken implementation** — the one that implements `--dry-run` by filing the task inside a transaction and rolling it back (the shape that looks equivalent and is not) — `and inserts no task row` stays **green**, because the rollback really does remove it, while `and appends no hub_event` also stays green for the same reason, and `and takes no writer lease` goes **red**: the lease is taken and released in its own committed transactions, outside the rolled-back one, so restore sees a writer that a dry run should never have created. That single red is the whole reason the lease counter is asserted here rather than only in Task 3.

**The stub loop for this task**: run the three files green (control); apply the stub by deleting the `if (dryRun) return { ok: true, dryRun: true, plan };` line from `fileTask` and confirming with `grep -c 'dryRun: true' src/build/taskfile.mjs` that it drops from 1 to 0; re-run and confirm `--dry-run returns a plan`, `and inserts no task row` and `and appends no hub_event` are red while the idempotency and `--anyway` blocks stay green; restore from `src/build/taskfile.mjs.bak` and re-run green.

- [ ] **Step 3: Implement the plan, the salt, and the route**

In `src/build/registryio.mjs`:

```js
import { createHash } from "node:crypto";

// The founder filing's source key. Normalized so two filings differing only in
// spacing or case collide and the near-twin warning fires -- humans legitimately
// re-file near-twins, and the collision is a warning plus --anyway, never a hard
// refusal like the ledger's node id.
export const titleHash = (title) =>
  createHash("sha256").update(String(title).trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
```

In `src/build/taskfile.mjs`, between the snapshot and the lease:

```js
import { liveLeases, firstConflict, conflictRefusal } from "./territory.mjs";
import { titleHash } from "./registryio.mjs";

/**
 * Everything `--dry-run` prints, computed with no write of any kind.
 *
 * It reads the live leases rather than reasoning about them, because the whole
 * value of the flag is telling the founder what the real transaction would hit.
 */
export function dryRunPlan({ project, snapshot, claims, held, switches }) {
  return {
    project, nwo: snapshot.nwo, profileHash: snapshot.profileHash,
    territory: claims.map(c => ({ kind: c.kind, path: c.path })),
    conflicts: claims.map(c => { const l = firstConflict(c, held, null); return l ? conflictRefusal(c, l) : null; })
                     .filter(Boolean),
    // The classifier has not run, so no floor can have fired yet. The list is
    // the floors that WOULD apply to this territory, which is what the founder
    // is asking; an empty array here means none of them can, not that none were
    // considered.
    floors: claims.length > 1 ? ["territory spans more than one claim; sizing floors are evaluated after SIZING"] : [],
    switches,
  };
}
```

and, inside `fileTask`, immediately after the snapshot resolves and before the writer lease:

```js
  const held = liveLeases(db, project);
  if (dryRun) return { ok: true, dryRun: true,
    plan: dryRunPlan({ project, snapshot, claims: filing.claims, held, switches }) };

  // --anyway coexists with UNIQUE(source_kind, source_key) by SALTING with the
  // task's own id, so the near-twin admits, the constraint still holds, and the
  // provenance records that the collision was seen and accepted.
  const id = mintTaskId();
  const sourceKey = anyway ? `${titleHash(title)}:${id}` : titleHash(title);
```

with `sourceKey` passed into `admitTask`'s filing, and the success return replaced by:

```js
    if (!r.ok) return { ok: false, refusal: r.refusal };
    // The evidence id is the seq of the row `admitTask` appended for THIS task,
    // read back rather than guessed: `hubEvent` returns the seq inside the
    // transaction and nothing carries it out, and MAX(seq) over the whole table
    // would name a concurrent writer's row.
    const ev = db.prepare(
      "SELECT MAX(seq) s FROM hub_event WHERE task = ? AND kind = 'task.filed'").get(r.taskId).s;
    return { ok: true, task: r.taskId, prev: null,
             next: { phase: "FILED", generation: 1 }, evidence_id: ev,
             next_action: "none: the builder tick takes FILED to SIZING with no further condition",
             replayed: r.replayed === true };
```

In `bin/reeve`, add to `FLAGS` (the block at `:263`, anchor `const FLAGS = {`), keeping the file's existing two-group layout — valued flags in the first group, switches in the second. `json` is **not** added: it is already registered at `:285`.

```js
  project:            { value: true,  what: "the registry project to file against" },
  title:              { value: true,  what: "what the task is called" },
  territory:          { value: true,  what: "a repository-relative path the task claims (repeatable)" },
  "territory-file":   { value: true,  what: "a file of territory claims, one per line" },
  "body-file":        { value: true,  what: "a file holding the task body, or - for stdin" },
  depth:              { value: true,  what: "trivial, standard or deep" },
  priority:           { value: true,  what: "p1 or p2" },
  "idempotency-key":  { value: true,  what: "a key that makes a re-run of this command inert" },
  "pin-territory":    { value: true,  what: "keep the territory while held, for a duration like 48h" },
```

```js
  anyway:         { value: false, what: "file a near-twin of an existing task anyway" },
  "dry-run":      { value: false, what: "print what would happen and write nothing" },
```

and a self-contained route, inserted immediately **before** `case "build": {` (anchor `case "build": {`, `:1131` at `16cd880`). It must end in `break;`: a `case` label placed above a body it does not own captures every label above it.

```js
  case "task": {
    const sub = positionals[0];
    if (sub !== "file") {
      console.error("reeve task: the only subcommand is `file`");
      console.error('-> reeve task file --project <p> --title "..." --territory <path>');
      process.exit(1);
    }
    const { fileTask, pinSeconds } = await import("../src/build/taskfile.mjs");
    const { registryProjects, registryIo } = await import("../src/build/registryio.mjs");
    const { capabilitiesFrom } = await import("../src/build/capabilities.mjs");
    const { openHub } = await import("../src/build/hubdb.mjs");

    const reg = registryProjects(HOME);
    if (reg.error) { console.error(`reeve task: ${reg.error}`); process.exit(1); }
    // `resolveSnapshot` takes an object keyed by project name; `registryProjects`
    // returns an array, because doctor and the tick both iterate it. The
    // conversion happens here, once, rather than in either of them.
    const registry = { version: reg.version,
      projects: Object.fromEntries(reg.projects.map(p => [p.name, p])) };

    const pin = pinSeconds(opt("pin-territory"));
    if (pin?.refusal) { console.error(`reeve task: ${pin.refusal}`); process.exit(1); }

    // `loadProfile` is keyed on the NWO, not on the home: it looks under
    // `<home>/profiles/<owner>/<repo>.json`. So the project has to resolve in
    // the registry before the switches can be read, and a `--project` that names
    // nothing is refused here rather than reaching `resolveSnapshot` with a
    // profile of `null` already in hand.
    const entry = registry.projects[opt("project")];
    if (!entry) {
      console.error(`reeve task: ${JSON.stringify(opt("project"))} is not a project in the registry`);
      console.error(`-> known projects: ${Object.keys(registry.projects).join(", ") || "(none)"}`);
      process.exit(1);
    }
    const profile = loadProfile(entry.nwo);
    if (!profile) { console.error(`reeve task: no profile for ${entry.nwo}`); process.exit(1); }

    // Repeatable, already: the argv walk pushes every occurrence of a valued
    // flag and `all` returns the list. `--territory-file` appends to the same
    // list rather than replacing it, so the two flags compose.
    const fromFile = opt("territory-file")
      ? readFileSync(opt("territory-file"), "utf8").split("\n").map(s => s.trim()).filter(Boolean) : [];

    const db = openHub(hubPathFor(HOME));
    const r = await fileTask({
      db, registry, project: opt("project"), title: opt("title"),
      territory: [...all("territory"), ...fromFile],
      body: opt("body-file")
        ? readFileSync(opt("body-file") === "-" ? 0 : opt("body-file"), "utf8") : null,
      depth: opt("depth"), priority: opt("priority") ?? "p2",
      idempotencyKey: opt("idempotency-key"), anyway: flag("anyway"),
      pinSeconds: pin, dryRun: flag("dry-run"),
      io: registryIo({ home: HOME }), isAlive: isSameProcess,
      pid: process.pid, lstart: readStart(process.pid),
      switches: capabilitiesFrom(profile),
    });
    db.close();
    if (flag("json")) console.log(JSON.stringify(r, null, 2));
    else if (!r.ok) console.error(`reeve task: ${r.refusal}`);
    else if (r.dryRun) console.log(`would file in ${r.plan.project}: ` +
      `${r.plan.territory.map(t => t.path || "(repository root)").join(", ")}` +
      (r.plan.conflicts.length ? `\nconflicts:\n  ${r.plan.conflicts.join("\n  ")}` : ""));
    else console.log(`${r.task} FILED${r.replayed ? " (already filed; nothing was done)" : ""}`);
    process.exit(r.ok ? 0 : 1);
  }
```

- [ ] **Step 4: Run the three files, then the suite, then commit**

```bash
$N test/task-file.test.mjs && $N test/cli-flags.test.mjs && $N test/cli-routing.test.mjs
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add src/build/taskfile.mjs src/build/registryio.mjs bin/reeve \
        test/task-file.test.mjs test/cli-flags.test.mjs test/cli-routing.test.mjs
git commit -m "feat(cli): reeve task file, with dry-run, idempotency and json"
```

---

### Task 5: PR-B1 close-out — freeze the mutating `--json` shape, tracker, PR

**Files:**
- Create: `test/fixtures/task-file-json-v1.json`
- Modify: `test/task-file.test.mjs` (append before the terminator), `tasks/reeve-tasks/trackers/s3.md` (**last commit only**)

- [ ] **Step 1: Freeze both halves of the mutating shape**

§11.6 (`:735`) says *every* mutating command returns `{task, prev, next, evidence_id, next_action}`, and S3-E's `resume`, `cancel` and `infeasible` are written against whatever this PR ships. The shape has two halves that fail differently: the **key set**, which a consumer destructures, and the **`next` sub-shape**, which a consumer reads for a phase. A freeze that covers only the first passes while `next` silently becomes a bare string.

Append to `test/task-file.test.mjs`, before its closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group:

```js
{
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/task-file-json-v1.json", import.meta.url), "utf8"));
  const db = store();
  const r = await fileTask(base(db, { title: "the frozen shape" }));
  check(Object.keys(r).sort().join(",") === frozen.keys.join(","),
    "the mutating result's key set is frozen",
    `${Object.keys(r).sort().join(",")}\n        expected ${frozen.keys.join(",")}`);
  check(Object.keys(r.next).sort().join(",") === frozen.next_keys.join(","),
    "and so is next's, which is the half a consumer reads a phase out of",
    `${Object.keys(r.next).sort().join(",")}\n        expected ${frozen.next_keys.join(",")}`);
  check(frozen.version === 1, "and the fixture records which shape it froze", String(frozen.version));
  db.close();
}
```

Generate the fixture from the function as it stands at this commit, through the same call the test makes, so the two cannot compute it differently:

```bash
$N -e '
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { openHub } = await import("./src/build/hubdb.mjs");
  const { fileTask } = await import("./src/build/taskfile.mjs");
  const { isSameProcess, readStart } = await import("./src/supervisor.mjs");
  const d = mkdtempSync(join(tmpdir(), "reeve-freeze-"));
  const repo = join(d, "repo"); mkdirSync(join(repo, "packages", "x"), { recursive: true });
  writeFileSync(join(repo, "p.json"), "{}\n");
  const io = { lstat: (await import("node:fs")).lstatSync, lsTree: () => null,
    repoId: async () => 42, profileHash: async () => "ph-1", defaultBranch: async () => "main",
    visibility: async () => "private", specRepoId: async () => 77,
    gateDefinitionHash: async () => "gd-1", founderUserId: async () => 9 };
  const r = await fileTask({ db: openHub(join(d, "h.db")),
    registry: { version: 1, projects: { nextly: { nwo: "nextlyhq/nextly", repoPath: repo,
      profilePath: join(repo, "p.json") } } },
    project: "nextly", title: "freeze", territory: ["packages/x"], io,
    isAlive: isSameProcess, pid: process.pid, lstart: readStart(process.pid) });
  writeFileSync("test/fixtures/task-file-json-v1.json", JSON.stringify({ version: 1,
    keys: Object.keys(r).sort(), next_keys: Object.keys(r.next).sort(),
    frozen_at: "2026-08-27",
    note: "section 11.6 mutating shape; a change here changes every task command" }, null, 2) + "\n");
  console.log(JSON.stringify(r, null, 2));
'
$N test/task-file.test.mjs
```

Verify the freeze actually guards, with the four-check stub loop, **twice — once per half**:

1. Add `extra: 1` to `fileTask`'s success return; re-run and expect **only** `the mutating result's key set is frozen` red; restore by copying back `src/build/taskfile.mjs.bak`; re-run and expect green.
2. Change `next: { phase: "FILED", generation: 1 }` to `next: "FILED"`; re-run and expect `and so is next's, which is the half a consumer reads a phase out of` red; restore from the same copy; re-run green.

The second run is the one that matters: it is the half that a key-set freeze cannot see, and a freeze verified only against the half it already covered proves nothing about the half that was added.

- [ ] **Step 2: Full suite, from a clean checkout**

```bash
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac   # writes into the LIVE daemon's ~/.reeve/canary
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
# NONZERO on red. `|| echo` turns a failing node process into a SUCCESSFUL
# command, so this loop exited 0 with any number of red files -- and it is the
# mandatory pre-commit gate, so an executor checking the command status commits
# on a suite that just failed.
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
```

Expected: no `FAILED` lines. The `16cd880` baseline of 93 files plus whatever S3-A added, plus `task-file`.

- [ ] **Step 3: The tracker row, as the LAST commit**

`tasks/reeve-tasks/trackers/s3.md` conflicts on every branch. One row, edited last, so the conflict is trivial. In §1's task table, set T3's `PR` and `STATE`:

```markdown
| T3 | `reeve task file`, with the territory grammar | S3-B | `feat/s3-task-file` | T2 | reeve#NN | BUILT | | | |
```

STATE is **BUILT**, never MERGED. This commit precedes Step 4, which opens the PR, and Step 5 forbids merging without a founder grant — a MERGED written here claims delivery of an unmerged review branch and would incorrectly unblock T4, T5 and T13, all of which are ordered behind it.

```bash
git add tasks/reeve-tasks/trackers/s3.md
git commit -m "docs(tracker): s3 T3 built"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/s3-task-file
gh pr create --title "S3 T3: reeve task file, with the territory grammar" --body-file - <<'BODY'
## What

The first writer of `task`, `task_territory` and `territory_lease`. `reeve task
file` resolves the registry snapshot over the network, then opens one writer
lease around one `admitTask` transaction that performs no I/O. Territory is
required; an empty claim is the repository root, never no-claim.

No GitHub effect, no outbox row of any kind, and no worker is dispatched.

## Decisions taken in this PR

- **`--pin-territory` takes a duration**, as the design writes it (`:127`), not
  a bare switch. `grantLease` has a `pinnedUntil` parameter and a pin with no
  deadline is a promise nothing ends.
- **`fileTask` has no default for `isAlive`.** `admitTask`'s own default is
  `() => true`, which admits a filing while a restore is replacing the file.
  The function throws rather than defaulting, and the test asserts the throw
  beside a live-maintenance-lock control so the assertion is not passing on the
  absence of a lock.
- **The route converts the registry shape.** `registryProjects` returns an
  array because doctor and the tick iterate it; `resolveSnapshot` takes an
  object keyed by project name. The conversion is in the route, once.

## Review focus

- `--dry-run`'s writer-lease assertion. A dry run implemented as
  file-then-rollback passes the row-count assertions and fails only that one,
  because the lease commits in its own transaction outside the rolled-back one.
- The `task` case is inserted immediately above `case "build"`. That is the
  position that captured status/statusline/dash for a full day when `shadow`
  landed there; `test/cli-routing.test.mjs` asserts both directions.
BODY
gh pr comment --body "@codex review"
```

- [ ] **Step 5: Work the gate**

Comment `@codex review` on **every push**, not only the first. Read **both** endpoints — a clean pass arrives as an issue comment, findings as a review object; a single-shaped reader is one shape short. Reply to **and resolve** every thread via GraphQL; replying alone does not clear it. Apply the taper rule: ten rounds without the findings tapering means stop and bring the shape, not the next fix.

**Do not merge.** Founder grant required.

---

# PR-B2: Artifacts, the durable store and `reviewArtifact`

**Branch:** `feat/s3-artifacts`, based on T3's merge commit. **Scope:** the three path functions, `src/build/artifact.mjs`, and one additive throw in `reviewDiff`. ~700 changed lines. **No GitHub call, no outbox row, no worker.**

---

### Task 1: A write interrupted before its rename leaves no artifact, no sha, and a transition that refuses

**Files:**
- Create: `src/build/artifact.mjs`, `test/artifact.test.mjs`
- Modify: `src/paths.mjs` (the block after `export function hubPathFor(home) {`, `:68`)
- Test: `test/state-paths.test.mjs` (append before the terminator — the closing `console.log` / `process.exit(fail ? 1 : 0)` pair; that file has **no** `rmSync`, because it computes paths and creates nothing)

**Interfaces:**
- Consumes: `applyTransition` (`src/build/transition.mjs:660`), the artifact-sha gate (`:775`), `fileTask` (PR-B1 Task 1), `openHub`, `isSameProcess`.
- Produces: `ARTIFACT_FILE` — `{SIZING: "sizing.json", RESEARCH: "research.md", DESIGN: "design.md"}`, declared **once**, in `src/paths.mjs`, and imported by `artifact.mjs`; a second copy would be a second inventory of the same three facts. `taskPathFor(home, taskId)`, `artifactPathFor(home, taskId, phase)`, `runPathFor(home, taskId, run)` where `run` is `{generation, phase, slice, attempt, stream}`. `writeArtifact({dir, phase, bytes}) -> {path, sha256, bytes}`; `readArtifact({dir, phase, expectSha}) -> {ok:true, text, sha256} | {ok:false, why}`. S3-C Task 1 records `writeArtifact`'s `sha256` as `phase_event.artifact_sha`; S3-D reads `readArtifact` back at every phase boundary.

- [ ] **Step 1: Write the failing test**

Create `test/artifact.test.mjs` with `/* ... standard harness ... */` (slug `artifact`), plus:

```js
import { mkdirSync, lstatSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { openHub } from "../src/build/hubdb.mjs";
import { applyTransition } from "../src/build/transition.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { fileTask } from "../src/build/taskfile.mjs";
import { writeArtifact, readArtifact } from "../src/build/artifact.mjs";

// A filed task, so the transition assertions run against a real row rather than
// against a hand-built one. A hand-built task cannot exhibit the CAS.
const repo = join(dir, "repo");
mkdirSync(join(repo, "packages", "x"), { recursive: true });
writeFileSync(join(repo, "p.json"), "{}\n");
const registry = { version: 1, projects: {
  nextly: { nwo: "nextlyhq/nextly", repoPath: repo, profilePath: join(repo, "p.json") } } };
const io = { lstat: (p) => lstatSync(p), lsTree: () => null,
  repoId: async () => 42, profileHash: async () => "ph-1", defaultBranch: async () => "main",
  visibility: async () => "private", specRepoId: async () => 77,
  gateDefinitionHash: async () => "gd-1", founderUserId: async () => 9 };
const db = openHub(join(dir, "hub.db"));
const filed = await fileTask({ db, registry, project: "nextly", title: "a scout task",
  territory: ["packages/x"], io, isAlive: isSameProcess,
  pid: process.pid, lstart: readStart(process.pid) });
check(filed.ok === true, "fixture: a task is filed", JSON.stringify(filed));
const toSizing = applyTransition(db, { taskId: filed.task, expectedPhase: "FILED",
  expectedGeneration: 1, evidence: { kind: "phase.succeeded", phase: "FILED" },
  op: "phase.advanced", isAlive: isSameProcess });
check(toSizing.applied === true, "fixture: and advanced to SIZING", JSON.stringify(toSizing));

// THE INTERRUPTED WRITE. A child writes a 64 MiB artifact through the real
// function; the parent kills its process GROUP the moment a tmp entry appears.
//
// What this fixture can exhibit: a process that died between the tmp write and
// the rename. What it CANNOT exhibit: a power loss, or a rename that a
// filesystem reordered against the fsync -- those are the platform's guarantee,
// not this function's. And if the child finishes before the parent sees the tmp
// entry the drill never reached its window: that is reported RED below, never
// skipped, because an unreached window and a passing guard look identical.
{
  const adir = join(dir, "interrupted");
  const worker = join(dir, "slow-write.mjs");
  writeFileSync(worker,
    `import { writeArtifact } from "${join(process.cwd(), "src/build/artifact.mjs")}";\n` +
    `writeArtifact({ dir: process.argv[2], phase: "RESEARCH",\n` +
    `                bytes: Buffer.alloc(64 * 1024 * 1024, 0x61) });\n` +
    `console.log("finished");\n`);
  const child = spawn(process.execPath, [worker, adir], { detached: true, stdio: "ignore" });
  let sawTmp = false;
  for (let i = 0; i < 2000 && !sawTmp; i++) {
    try { sawTmp = readdirSync(adir).some(f => f.includes(".tmp-")); } catch { /* not yet created */ }
    if (!sawTmp) await new Promise(r => setTimeout(r, 2));
  }
  check(sawTmp, "control: the drill reached the window between tmp and rename");
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  await new Promise(r => child.on("exit", r));

  const left = (() => { try { return readdirSync(adir); } catch { return []; } })();
  check(!existsSync(join(adir, "research.md")),
    "no artifact exists after a write interrupted before its rename", left.join(","));
  check(left.length > 0 && left.every(f => f.includes(".tmp-")),
    "and the artifacts directory holds only the temporary file", left.join(","));
  const r = readArtifact({ dir: adir, phase: "RESEARCH", expectSha: "0".repeat(64) });
  check(r.ok === false, "reading it back refuses rather than returning empty content", JSON.stringify(r));

  // AND THE TRANSITION REFUSES, which is the property that matters: an artifact
  // that is not durable must not be able to justify a phase advance.
  const t = applyTransition(db, { taskId: filed.task, expectedPhase: "SIZING",
    expectedGeneration: 1, evidence: { kind: "phase.succeeded", phase: "SIZING", depth: "standard" },
    artifactSha: null, op: "phase.advanced", isAlive: isSameProcess });
  check(t.applied === false && t.reason === "refused",
    "and the transition it would have justified is refused", JSON.stringify(t));
  check(/no artifact sha/.test(String(t.refusal)),
    "naming the missing sha as the reason", String(t.refusal));
  const ev = db.prepare(
    "SELECT payload FROM hub_event WHERE task=? AND kind='transition.refused' ORDER BY seq DESC LIMIT 1")
    .get(filed.task);
  check(ev !== undefined && /no artifact sha/.test(ev.payload),
    "and the refusal is durable, not merely returned", JSON.stringify(ev));
}

// THE READ-BACK. The sha recorded is the sha of the bytes on disk, checked by
// mutating the file underneath a known-good sha.
{
  const adir = join(dir, "readback");
  const w = writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from("# design\n\n## Slice 1\n") });
  check(typeof w.sha256 === "string" && w.sha256.length === 64, "a write returns a sha256", w.sha256);
  check(existsSync(w.path) && readdirSync(adir).length === 1,
    "and leaves exactly one file, with no temporary beside it", readdirSync(adir).join(","));
  const good = readArtifact({ dir: adir, phase: "DESIGN", expectSha: w.sha256 });
  check(good.ok === true, "control: reading it back with the recorded sha succeeds", JSON.stringify(good));
  check(good.sha256 === w.sha256, "and re-derives the same sha from the bytes on disk", good.sha256);

  writeFileSync(w.path, "# design\n\n## Slice 1\ntampered\n");
  const bad = readArtifact({ dir: adir, phase: "DESIGN", expectSha: w.sha256 });
  check(bad.ok === false, "and a file mutated after the write is refused on read-back", JSON.stringify(bad));
  check(/sha/.test(String(bad.why)), "with the sha mismatch as the reason", String(bad.why));
}
db.close();
```

Append to `test/state-paths.test.mjs`, before its closing `console.log` / `process.exit(fail ? 1 : 0)` pair, adding `taskPathFor, artifactPathFor, runPathFor` to that file's existing `import … from "../src/paths.mjs"` line rather than writing a second import of the same module:

```js
{
  const id = "bt:01JABCDEFGHJKMNPQRSTVWXYZ0";
  check(taskPathFor(HOME, id).startsWith(join(HOME, "tasks")),
    "a task's tree lives under the reeve home's tasks directory", taskPathFor(HOME, id));
  check(!taskPathFor(HOME, "../../etc").includes(".."),
    "and a task id cannot walk out of it", taskPathFor(HOME, "../../etc"));
  check(artifactPathFor(HOME, id, "RESEARCH").endsWith(join("artifacts", "research.md")),
    "RESEARCH's artifact is research.md", artifactPathFor(HOME, id, "RESEARCH"));
  check(artifactPathFor(HOME, id, "SIZING").endsWith(join("artifacts", "sizing.json")),
    "and SIZING's is sizing.json, because the extension follows the phase",
    artifactPathFor(HOME, id, "SIZING"));
  check(runPathFor(HOME, id, { generation: 2, phase: "RESEARCH", slice: 0, attempt: 1, stream: "out" })
        .endsWith(join("runs", "g2-RESEARCH-s0-a1.out")),
    "and a run's output file names its generation, phase, slice and attempt",
    runPathFor(HOME, id, { generation: 2, phase: "RESEARCH", slice: 0, attempt: 1, stream: "out" }));
  let threw = null;
  try { artifactPathFor(HOME, id, "IMPLEMENTING"); } catch (e) { threw = String(e.message); }
  check(threw !== null, "and a phase with no artifact has no artifact path", String(threw));
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `$N test/artifact.test.mjs; $N test/state-paths.test.mjs`
Expected: `Cannot find module '.../src/build/artifact.mjs'` for the first, and `taskPathFor is not defined` for the second — neither exists at `16cd880` (`git grep -c taskPathFor -- src bin test` returns zero files; positive control, `hubPathFor` returns ten).

**On the broken implementation** — the one that writes with a plain `writeFileSync(path, bytes)` because "the rename is an optimisation" — `no artifact exists after a write interrupted before its rename` and `and the artifacts directory holds only the temporary file` both go red, because a killed plain write leaves a **short `research.md`**, not a tmp file. `control: the drill reached the window` stays green, and that is what stops the red being read as "the child was never killed". The subtler broken implementation is the one that renames but never fsyncs the directory: this test cannot exhibit that, and it is stated rather than implied — the ordering guarantee after a `fsync` of the containing directory is the platform's, and the code is written to ask for it, not to prove it.

**The stub loop for this task**: run `test/artifact.test.mjs` green (control); apply the stub by replacing `writeArtifact`'s tmp-then-rename body with a single `writeFileSync(path, bytes)`, confirmed with `grep -c 'renameSync' src/build/artifact.mjs` dropping from 1 to 0; re-run and confirm the two named assertions are red while the read-back block stays green; restore from `src/build/artifact.mjs.bak`, copied before the edit, and re-run green.

- [ ] **Step 3: Implement the paths, then the store**

In `src/paths.mjs`, after `hubPathFor`:

```js
/**
 * The artifact each report phase produces. ONE declaration, exported, because
 * the phase-to-filename map is a fact about the design's section 4.1 table and a
 * second copy in the artifact store would be a second inventory to drift from.
 */
export const ARTIFACT_FILE = Object.freeze({
  SIZING: "sizing.json", RESEARCH: "research.md", DESIGN: "design.md",
});

/**
 * One task's tree. The id is sanitised for the same reason a repository name is:
 * it arrives from a command line, and `..` in it would walk out of the home.
 * `bt:<ulid>` is [0-9A-Z] apart from the colon, so the substitution is injective
 * over real ids and two tasks can never share a directory.
 */
export function taskPathFor(home, taskId) {
  return join(home, "tasks", safe(taskId));
}

/** Where a report phase's artifact lands, durable before its transition. */
export function artifactPathFor(home, taskId, phase) {
  const name = ARTIFACT_FILE[phase];
  if (!name) throw new Error(`${phase} produces no artifact; its product is a diff, reviewed by reviewDiff`);
  return join(taskPathFor(home, taskId), "artifacts", name);
}

/**
 * A run's durable output. Every field is required: a run file that omits the
 * attempt overwrites the previous attempt's transcript, which is how a measured
 * comparison lost two of its three runs.
 */
export function runPathFor(home, taskId, { generation, phase, slice, attempt, stream }) {
  if (![generation, slice, attempt].every(Number.isInteger) || !phase || !stream)
    throw new Error("a run path needs generation, phase, slice, attempt and stream; none is optional");
  return join(taskPathFor(home, taskId), "runs", `g${generation}-${phase}-s${slice}-a${attempt}.${stream}`);
}
```

Create `src/build/artifact.mjs`:

```js
// artifact -- the durable phase artifact, and the gate that reads it.
//
// A transition commits only after its artifact is durable, so the write has to
// be atomic against a crash and the sha recorded has to be the sha of the bytes
// that are actually on disk. Both halves matter: a sha computed from the buffer
// in memory certifies what was intended, not what survived.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_FILE } from "../paths.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** tmp + fsync + rename + fsync of the directory. Every step, in that order. */
export function writeArtifact({ dir, phase, bytes }) {
  const name = ARTIFACT_FILE[phase];
  if (!name) throw new Error(`${phase} produces no artifact; use reviewDiff's path`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx");
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  // THE DIRECTORY TOO. Without it the rename itself may not survive a crash,
  // and the artifact is durable only in the sense that its bytes were.
  const dfd = openSync(dir, "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  return { path, sha256: sha(bytes), bytes: bytes.length };
}

/**
 * Read it back and check it. `expectSha` is required: a read that returns
 * whatever is there certifies nothing, and this function exists to be the check.
 */
export function readArtifact({ dir, phase, expectSha }) {
  const name = ARTIFACT_FILE[phase];
  if (!name) throw new Error(`${phase} produces no artifact; use reviewDiff's path`);
  if (typeof expectSha !== "string" || expectSha.length !== 64)
    throw new Error("readArtifact needs the sha it expects; a read with nothing to compare is not a check");
  let buf;
  try { buf = readFileSync(join(dir, name)); }
  catch (e) { return { ok: false, why: `${name} is not there: ${e.code ?? e.message}` }; }
  const got = sha(buf);
  if (got !== expectSha)
    return { ok: false, why: `${name}'s sha is ${got}, not the recorded ${expectSha}; the bytes changed after the write` };
  return { ok: true, text: buf.toString("utf8"), sha256: got };
}
```

- [ ] **Step 4: Run them, then commit**

```bash
cp src/build/artifact.mjs src/build/artifact.mjs.bak
$N test/artifact.test.mjs && $N test/state-paths.test.mjs
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
rm -f src/build/artifact.mjs.bak
git add src/paths.mjs src/build/artifact.mjs test/artifact.test.mjs test/state-paths.test.mjs
git commit -m "feat(build): durable phase artifacts, hashed and read back"
```

---

### Task 2: The two gates refuse each other's phases, and `reviewArtifact` refuses an uncited claim while passing the minimum

**Files:**
- Modify: `src/build/artifact.mjs` (adds `reviewArtifact`), `src/sandbox.mjs` (`reviewDiff`; the block after `export function reviewDiff({ files, profile, lane = null, action = null }) {`, `:856`)
- Test: `test/artifact.test.mjs` (append before the terminator — the closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group)

**Interfaces:**
- Consumes: `writeArtifact` (Task 1), `reviewDiff` (`src/sandbox.mjs:856`), `ARTIFACT_FILE` (`src/paths.mjs`).
- Produces: `reviewArtifact({phase, dir, expect}) -> {ok, why, findings}` — **three required properties and no optional parameter anywhere.** S3-C Task 2 asserts it at the dispatch seam; S3-D Tasks 2 and 3 supply the `expect` a real depth produces.

- [ ] **Step 1: Append the failing test**

Append to `test/artifact.test.mjs`, before its closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group, adding `reviewArtifact` to that file's existing `import … from "../src/build/artifact.mjs"` line and one new import for the sibling:

```js
import { reviewDiff } from "../src/sandbox.mjs";
```

```js
// THE MINIMUM, AND THE CONTROL. A checker that refuses everything proves
// nothing about the thing it refuses, so the passing case is asserted first and
// the failing case differs from it by exactly the citation.
{
  const adir = join(dir, "review");
  const cited = "# research\n\n- openHub refuses a hub above the schema version " +
                "(src/build/hubaccess.mjs:170)\n- the guest handle revalidates dev:ino " +
                "(src/build/hubaccess.mjs:42)\n";
  writeArtifact({ dir: adir, phase: "RESEARCH", bytes: Buffer.from(cited) });
  const good = reviewArtifact({ phase: "RESEARCH", dir: adir, expect: { depth: "standard" } });
  check(good.ok === true,
    "control: a research artifact whose every claim carries a file:line citation passes",
    JSON.stringify(good));

  writeArtifact({ dir: adir, phase: "RESEARCH",
    bytes: Buffer.from(cited.replace(" (src/build/hubaccess.mjs:170)", "")) });
  const bad = reviewArtifact({ phase: "RESEARCH", dir: adir, expect: { depth: "standard" } });
  check(bad.ok === false, "a claim with no file:line citation is refused", JSON.stringify(bad));
  check(bad.findings.length === 1,
    "and exactly the one uncited claim is named, not the whole file", JSON.stringify(bad.findings));
}

// THE TWO GATES, ASSERTED IN BOTH DIRECTIONS. Each is mandatory for its own
// dispatch path, so each must refuse the other's -- an artifact phase that fell
// through reviewDiff would be gated on a diff it does not produce, and would
// pass on the empty-diff refusal reading as "nothing was changed".
{
  let a = null, b = null;
  try { reviewDiff({ files: ["packages/x/a.ts"], profile: {}, lane: null, action: "RESEARCH" }); }
  catch (e) { a = String(e.message); }
  check(a !== null, "reviewDiff throws when handed an artifact phase", String(a));
  check(/reviewArtifact/.test(String(a)), "and names the sibling that owns that path", String(a));

  try { reviewArtifact({ phase: "IMPLEMENTING", dir: join(dir, "review"), expect: { depth: "standard" } }); }
  catch (e) { b = String(e.message); }
  check(b !== null, "and reviewArtifact throws when handed a diff phase", String(b));
  check(/reviewDiff/.test(String(b)), "and names its sibling too", String(b));

  // CONTROL: the guardian's own actions still go through unchanged. This asserts
  // that reviewDiff RETURNS rather than that it returns ok, because what the new
  // guard must not do is throw -- its verdict on an ordinary diff is the
  // existing shipped behaviour and is not this task's to change.
  let threw = false, ordinary = null;
  try { ordinary = reviewDiff({ files: ["packages/x/a.ts"], profile: {}, lane: null, action: "FIX_CI" }); }
  catch { threw = true; }
  check(threw === false && ordinary !== null,
    "control: reviewDiff still returns for an ordinary guardian action", JSON.stringify(ordinary));
}

// NO OPTIONAL PARAMETER. The optional `gate` parameter lost to the sibling
// function precisely because an optional safety parameter is omitted by the
// caller that most needs it.
{
  check(reviewArtifact.length === 1,
    "reviewArtifact takes exactly one required argument", String(reviewArtifact.length));
  let missing = null;
  try { reviewArtifact({ phase: "RESEARCH", dir: join(dir, "review") }); }
  catch (e) { missing = String(e.message); }
  check(missing !== null && /expect/.test(missing),
    "and refuses a call that omits `expect` rather than defaulting it", String(missing));
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/artifact.test.mjs`
Expected: `reviewArtifact is not a function` at the first review assertion, and `reviewDiff throws when handed an artifact phase` red — `reviewDiff` accepts `action: null` today and never throws for any value.

**On the broken implementation** — the one that adds `reviewArtifact` but leaves `reviewDiff` alone, on the argument that "nothing calls `reviewDiff` with a phase name" — `reviewDiff throws when handed an artifact phase` and `and names the sibling that owns that path` go red while every `reviewArtifact` assertion stays green. That is the whole point of asserting both directions: the dangerous half is the one where an artifact phase silently reaches the diff gate, gets an empty file list, and is refused with *"the worker produced an empty diff"* — a refusal that reads as the worker's fault and is the gate's.

**The stub loop for this task**: run green (control); apply the stub by weakening `reviewArtifact`'s citation check from a per-claim scan to `if (!/:\d+/.test(text))`, confirmed present with `grep -c 'findings.push' src/build/artifact.mjs` dropping from 1 to 0; re-run and confirm `a claim with no file:line citation is refused` and `and exactly the one uncited claim is named` are red while the control passes — the weakened check accepts the file, because the *other* claim still carries a citation; restore from `src/build/artifact.mjs.bak` and re-run green.

- [ ] **Step 3: Implement both halves**

In `src/build/artifact.mjs`:

```js
// A claim is a list item that asserts something. Section 4.6 names the minimum
// for research: at least one file:line citation per claim. Prose between the
// lists is context, not a claim, and is not asked to cite.
const CLAIM = /^\s*(?:[-*]|\d+\.)\s+\S/;
const CITATION = /[\w./-]+:\d+/;

/**
 * The gate for a report phase's product. The sibling of `reviewDiff`, never a
 * parameter of it: an optional safety parameter is omitted by exactly the caller
 * that needs it, and two functions that refuse each other's phases cannot be.
 */
export function reviewArtifact({ phase, dir, expect }) {
  if (!ARTIFACT_FILE[phase])
    throw new Error(`${phase} produces a diff, not an artifact; reviewDiff is its gate`);
  if (!expect || typeof expect.depth !== "string")
    throw new Error("reviewArtifact needs `expect` with a depth; expectations adjust by depth and a default would pick one");

  let text;
  try { text = readFileSync(join(dir, ARTIFACT_FILE[phase]), "utf8"); }
  catch (e) { return { ok: false, why: `${ARTIFACT_FILE[phase]} is not there: ${e.code ?? e.message}`, findings: [] }; }

  const findings = [];
  if (phase === "SIZING") {
    try { JSON.parse(text); } catch (e) { findings.push(`sizing.json does not parse: ${e.message}`); }
  }
  if (phase === "RESEARCH") {
    if (expect.depth === "trivial")
      return { ok: false, why: "RESEARCH is skipped at trivial depth; there is no research artifact to gate",
               findings: [] };
    for (const line of text.split("\n"))
      if (CLAIM.test(line) && !CITATION.test(line)) findings.push(`no file:line citation: ${line.trim()}`);
  }
  if (phase === "DESIGN") {
    const slices = text.split("\n").filter(l => /^##\s+Slice\b/.test(l));
    if (!slices.length) findings.push("design.md carries no ordered slice list");
    for (const need of ["Files:", "Packages:", "Tests:", "Done when:"])
      if (!text.includes(need)) findings.push(`every slice needs a ${need} line and none was found`);
    if (expect.depth === "trivial" && !/^##\s+Measured context\b/m.test(text))
      findings.push("at trivial depth design.md stands in for the absent research and needs a Measured context section");
  }
  return findings.length
    ? { ok: false, why: `${ARTIFACT_FILE[phase]} does not meet the minimum for ${phase}`, findings }
    : { ok: true, why: null, findings: [] };
}
```

In `src/sandbox.mjs`, as the first statement inside `reviewDiff`:

```js
  // THE SIBLING'S PHASES ARE NOT THIS FUNCTION'S. A report phase produces an
  // artifact and no diff, so it would arrive here with an empty file list and be
  // refused as "the worker produced an empty diff" -- a refusal that reads as
  // the worker's fault and is the gate's. Throwing is deliberate: this is a
  // wiring error at the dispatch seam, not an operator condition.
  if (action === "RESEARCH" || action === "DESIGN" || action === "SIZING")
    throw new Error(`${action} produces an artifact, not a diff; reviewArtifact is its gate`);
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/artifact.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add src/build/artifact.mjs src/sandbox.mjs test/artifact.test.mjs
git commit -m "feat(build): reviewArtifact, and the two gates refuse each other"
```

---

### Task 3: PR-B2 close-out — freeze the artifact path shape, tracker, PR

**Files:**
- Create: `test/fixtures/artifact-paths-v1.json`
- Modify: `test/state-paths.test.mjs` (append before the terminator), `tasks/reeve-tasks/trackers/s3.md` (**last commit only**)

- [ ] **Step 1: Freeze both halves of the path shape**

The path layout has two halves that fail differently: the **artifact** names, which S3-D writes and S3-E renders, and the **run** file name, which S3-C's adopt-or-kill finds a surviving worker's transcript by. A freeze covering only the first passes while a run file silently loses its attempt number — the shape that overwrote two of three runs in a measured comparison and forced a figure to be withdrawn.

Append to `test/state-paths.test.mjs`, before its closing `console.log` / `process.exit(fail ? 1 : 0)` pair:

```js
{
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/artifact-paths-v1.json", import.meta.url), "utf8"));
  const id = "bt:01JABCDEFGHJKMNPQRSTVWXYZ0";
  const rel = (p) => p.slice(HOME.length);
  check(rel(artifactPathFor(HOME, id, "RESEARCH")) === frozen.artifact,
    "the artifact path shape is frozen", `${rel(artifactPathFor(HOME, id, "RESEARCH"))} vs ${frozen.artifact}`);
  check(rel(runPathFor(HOME, id, { generation: 2, phase: "RESEARCH", slice: 0, attempt: 1, stream: "out" }))
        === frozen.run,
    "and so is the run path, which is how a surviving worker's transcript is found",
    `${rel(runPathFor(HOME, id, { generation: 2, phase: "RESEARCH", slice: 0, attempt: 1, stream: "out" }))} vs ${frozen.run}`);
  check(frozen.version === 1, "and the fixture records which shape it froze", String(frozen.version));
}
```

`readFileSync` is not in `test/state-paths.test.mjs`'s imports today — that file imports nothing from `node:fs`, because it computes paths and touches no disk. Add `import { readFileSync } from "node:fs";` to its import block, not to this appended chunk.

Generate the fixture through the same exports the test calls:

```bash
mkdir -p test/fixtures
$N -e '
  const { writeFileSync } = await import("node:fs");
  const { artifactPathFor, runPathFor } = await import("./src/paths.mjs");
  const H = "/home/x/.reeve", id = "bt:01JABCDEFGHJKMNPQRSTVWXYZ0";
  const rel = p => p.slice(H.length);
  writeFileSync("test/fixtures/artifact-paths-v1.json", JSON.stringify({ version: 1,
    artifact: rel(artifactPathFor(H, id, "RESEARCH")),
    run: rel(runPathFor(H, id, { generation: 2, phase: "RESEARCH", slice: 0, attempt: 1, stream: "out" })),
    frozen_at: "2026-08-27",
    note: "S3-C finds a surviving run by this name; a change here breaks adoption" }, null, 2) + "\n");
  console.log((await import("node:fs")).readFileSync("test/fixtures/artifact-paths-v1.json", "utf8"));
'
$N test/state-paths.test.mjs
```

Verify the freeze guards, with the four-check stub loop, **twice — once per half**:

1. Change `ARTIFACT_FILE.RESEARCH` to `"research.markdown"`; re-run and expect **only** `the artifact path shape is frozen` red; restore from `src/paths.mjs.bak`; re-run green.
2. Drop `-a${attempt}` from `runPathFor`'s template; re-run and expect `and so is the run path` red; restore from the same copy; re-run green.

The second is the one that matters: it is the half an artifact-only freeze cannot see, and it is the exact shape that made two runs overwrite a third.

- [ ] **Step 2: Full suite, from a clean checkout**

```bash
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac   # writes into the LIVE daemon's ~/.reeve/canary
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
# NONZERO on red. `|| echo` turns a failing node process into a SUCCESSFUL
# command, so this loop exited 0 with any number of red files -- and it is the
# mandatory pre-commit gate, so an executor checking the command status commits
# on a suite that just failed.
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
```

Expected: no `FAILED` lines. The 93-file baseline plus S3-A's files, plus `task-file` and `artifact`.

- [ ] **Step 3: The tracker row, as the LAST commit**

In `tasks/reeve-tasks/trackers/s3.md` §1, set T4's `PR` and `STATE` to `reeve#NN` and **BUILT** — never MERGED; this commit precedes the PR, and T5, T6, T10, T11 and T12 are all ordered behind T4.

```bash
git add tasks/reeve-tasks/trackers/s3.md
git commit -m "docs(tracker): s3 T4 built"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/s3-artifacts
gh pr create --title "S3 T4: durable phase artifacts, and reviewArtifact" --body-file - <<'BODY'
## What

`taskPathFor`/`artifactPathFor`/`runPathFor`, a tmp+fsync+rename+fsync artifact
write that returns the sha of the bytes on disk, a read-back that requires the
sha it expects, and `reviewArtifact` as a sibling of `reviewDiff`.

No GitHub call, no outbox row, and no worker is dispatched.

## Decisions taken in this PR

- **`ARTIFACT_FILE` is declared once, in `paths.mjs`.** The phase-to-filename
  map is one fact; a copy in the artifact store would be a second inventory.
- **`reviewDiff`'s signature is unchanged.** It gains one throw for artifact
  phase names and nothing else. Removing its `lane = null, action = null`
  defaults is a guardian-touching change and the corpus's two worst-converging
  PRs both touched the running guardian.
- **`readArtifact` requires `expectSha`.** A read that returns whatever is there
  certifies nothing, and this function exists to be the check.

## Review focus

- The interrupted-write drill's window. It reports RED when the child finishes
  before the parent sees the tmp entry, rather than skipping: an unreached
  window and a passing guard look identical otherwise. Please check that
  reading.
- What the drill cannot exhibit is stated in the test's own comment: a power
  loss, and a rename a filesystem reordered against the fsync. Those are the
  platform's guarantee, and the code asks for them rather than proving them.
BODY
gh pr comment --body "@codex review"
```

- [ ] **Step 5: Work the gate**

Comment `@codex review` on **every push**. Read **both** endpoints. Reply to **and resolve** every thread via GraphQL. Apply the taper rule.

**Do not merge.** Founder grant required.

---

# PR-B3: Phase report schemas and the report contract

**Branch:** `feat/s3-report-schema`, based on T4's merge commit. **Scope:** three JSON Schema files, `src/build/report.mjs`, and the tests that assert a report becomes evidence only through `nextPhase`. ~600 changed lines. **No GitHub call, no outbox row, no worker.**

---

### Task 1: Each schema rejects the empty object, and an outcome becomes exactly the evidence the machine already accepts

**Files:**
- Create: `src/build/schemas/build_size.json`, `src/build/schemas/build_research.json`, `src/build/schemas/build_design.json`, `src/build/report.mjs`, `test/phase-report.test.mjs`

**Interfaces:**
- Consumes: `PHASES` (`src/build/phases.mjs:42`, exported), `HOLD_ESCALATION` (`:89`).
- Produces: `ACTIONS`, `PHASE_FOR_ACTION`, `schemaFor(action)`, `validateReport(action, value) -> {ok:true, report} | {ok:false, errors}`, `evidenceFor({action, report}) -> evidence`, `badReportPlan({resumedAlready}) -> {resume:true} | {resume:false, evidence}`. S3-C Task 1 passes `schemaFor(action)` to `workerArgs`'s `jsonSchema`; S3-D Tasks 1-3 call `validateReport` on the structured result and hand `evidenceFor`'s return straight to `applyTransition`.

- [ ] **Step 1: Write the failing test**

Create `test/phase-report.test.mjs` with `/* ... standard harness ... */` (slug `report`), plus:

```js
import { PHASES } from "../src/build/phases.mjs";
import { ACTIONS, PHASE_FOR_ACTION, schemaFor, validateReport, evidenceFor, badReportPlan }
  from "../src/build/report.mjs";

// A SCHEMA THAT VALIDATES {} IS A SCHEMA THAT PROVES NOTHING. Every one of the
// three is asked the same question, by iteration rather than by three copies of
// the assertion, so a fourth action added later cannot quietly skip it.
{
  check(ACTIONS.length === 3, "there are three report actions", ACTIONS.join(","));
  for (const action of ACTIONS) {
    const empty = validateReport(action, {});
    check(empty.ok === false, `${action}'s schema rejects the empty object`, JSON.stringify(empty));
    check(empty.errors.some(e => /outcome/.test(e)) && empty.errors.some(e => /reason/.test(e)),
      `${action} says which required properties were missing`, JSON.stringify(empty.errors));
    const s = schemaFor(action);
    check(s.additionalProperties === false,
      `${action}'s schema refuses properties it does not declare`, JSON.stringify(s.additionalProperties));
    check(PHASES.includes(PHASE_FOR_ACTION[action]),
      `${action} maps to a phase the machine knows`, PHASE_FOR_ACTION[action]);
  }
  let unknown = null;
  try { schemaFor("BUILD_NOPE"); } catch (e) { unknown = String(e.message); }
  check(unknown !== null, "control: an unknown action has no schema and throws", String(unknown));
}

// THE ACCEPTING HALF. Each schema's own minimal valid report, so the rejections
// above are not a validator that refuses everything.
const SIZE_OK = { outcome: "ok", reason: "sized", depth: "standard", est_files: 4,
  est_weighted_files: 6, est_packages: 1, est_slices: 2, risk_paths_touched: [],
  rationale: "two packages, one of them a test tree" };
const RESEARCH_OK = { outcome: "ok", reason: "researched", artifact: "research.md" };
const DESIGN_OK = { outcome: "ok", reason: "designed", artifact: "design.md",
  slices: [{ title: "the store", files: ["src/build/hubdb.mjs"], weighted_files: 1,
             packages: ["src"], tests: "test/hub-schema.test.mjs", done_when: "the suite is green" }] };
{
  for (const [action, doc] of [["BUILD_SIZE", SIZE_OK], ["BUILD_RESEARCH", RESEARCH_OK],
                               ["BUILD_DESIGN", DESIGN_OK]]) {
    const r = validateReport(action, doc);
    check(r.ok === true, `control: ${action} accepts its own minimal valid report`, JSON.stringify(r.errors));
  }
  const extra = validateReport("BUILD_SIZE", { ...SIZE_OK, confidence: 0.9 });
  check(extra.ok === false, "and refuses a property the schema does not declare", JSON.stringify(extra.errors));
  const wrong = validateReport("BUILD_SIZE", { ...SIZE_OK, est_files: "four" });
  check(wrong.ok === false, "and refuses a declared property of the wrong type", JSON.stringify(wrong.errors));
  const noSlices = validateReport("BUILD_DESIGN", { ...DESIGN_OK, slices: [] });
  check(noSlices.ok === false, "and a design with an empty slice list is not a design", JSON.stringify(noSlices.errors));
}

// THE MAPPING. An outcome becomes evidence the machine already accepts, and
// nothing here invents a field the machine would refuse.
{
  const size = evidenceFor({ action: "BUILD_SIZE", report: SIZE_OK });
  check(size.kind === "phase.succeeded" && size.phase === "SIZING" && size.depth === "standard",
    "an ok SIZING report becomes a phase.succeeded naming its phase and depth", JSON.stringify(size));
  const res = evidenceFor({ action: "BUILD_RESEARCH", report: RESEARCH_OK });
  check(res.kind === "phase.succeeded" && res.phase === "RESEARCH" && !("depth" in res),
    "an ok RESEARCH report names its phase and no depth", JSON.stringify(res));

  const blocked = evidenceFor({ action: "BUILD_DESIGN",
    report: { outcome: "blocked", reason: "the lockfile needs a change I cannot make",
              escalation: "bt:x:phase:blocked:DESIGN" } });
  check(blocked.kind === "hold" && blocked.reason === "blocked_other",
    "a blocked outcome becomes a hold", JSON.stringify(blocked));
  check(blocked.escalation === "bt:x:phase:blocked:DESIGN",
    "carrying the escalation identity the report supplied", JSON.stringify(blocked));

  // AND NEVER MANUFACTURES ONE. `holdReasonRefusal` refuses a blocked_other with
  // an empty escalation, and that rule has exactly one home. A default here
  // would be a second copy of it, and the copy that wins is the one that runs.
  const noId = evidenceFor({ action: "BUILD_DESIGN", report: { outcome: "blocked", reason: "stuck" } });
  check(noId.escalation === undefined || String(noId.escalation).trim() === "",
    "and an absent escalation identity stays absent", JSON.stringify(noId));

  const inf = evidenceFor({ action: "BUILD_DESIGN",
    report: { outcome: "infeasible", reason: "the API this needs was removed upstream" } });
  check(inf.kind === "founder.infeasible" && /removed upstream/.test(inf.reason),
    "an infeasible outcome carries its reason, which is required", JSON.stringify(inf));
}

// ONE resumed retry, then the attempt budget is exhausted.
{
  const first = badReportPlan({ resumedAlready: false });
  check(first.resume === true, "a malformed report gets one --resume retry", JSON.stringify(first));
  const second = badReportPlan({ resumedAlready: true });
  check(second.resume === false, "and exactly one", JSON.stringify(second));
  check(second.evidence.kind === "phase.failed" && second.evidence.retriesExhausted === true,
    "after which the evidence is a phase.failed with retries exhausted", JSON.stringify(second.evidence));
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/phase-report.test.mjs`
Expected: `Cannot find module '.../src/build/report.mjs'` — the module does not exist. Measured at `16cd880`: `grep -rn "BUILD_SIZE\|BUILD_RESEARCH\|BUILD_DESIGN" src/` returns **one** hit, `src/sandbox.mjs:348`, the RESEARCH domain allowlist; nothing else in `src/` names any of the three.

**On the broken implementation** — the one whose schemas require only `outcome`, so `{outcome: "ok"}` validates and a report with no reason, no depth and no slices becomes evidence — every `rejects the empty object` assertion stays **green** (an empty object still has no `outcome`), and `${action} says which required properties were missing` goes red on the `reason` half, `and a design with an empty slice list is not a design` goes red, and `and refuses a declared property of the wrong type` stays green. That distribution is the point: rejecting `{}` is the cheapest possible schema assertion and it passes against a schema that is almost entirely absent, which is why the accepting half and the wrong-type half are asserted beside it.

**The stub loop for this task**: run green (control); apply the stub by deleting `"reason"` from `build_size.json`'s `required` array, confirmed with `grep -c '"reason"' src/build/schemas/build_size.json` dropping from 2 to 1; re-run and confirm `BUILD_SIZE says which required properties were missing` is red while `BUILD_SIZE's schema rejects the empty object` stays **green** — the stub is chosen precisely because it leaves the headline assertion passing; restore from `src/build/schemas/build_size.json.bak` and re-run green.

- [ ] **Step 3: Write the three schemas**

`src/build/schemas/build_size.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BUILD_SIZE",
  "type": "object",
  "additionalProperties": false,
  "required": ["outcome", "reason"],
  "properties": {
    "outcome": { "enum": ["ok", "blocked", "infeasible"] },
    "reason": { "type": "string", "minLength": 1 },
    "escalation": { "type": "string", "minLength": 1 },
    "depth": { "enum": ["trivial", "standard", "deep"] },
    "est_files": { "type": "integer", "minimum": 0 },
    "est_weighted_files": { "type": "integer", "minimum": 0 },
    "est_packages": { "type": "integer", "minimum": 0 },
    "est_slices": { "type": "integer", "minimum": 0 },
    "risk_paths_touched": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "rationale": { "type": "string", "minLength": 1 }
  }
}
```

`src/build/schemas/build_research.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BUILD_RESEARCH",
  "type": "object",
  "additionalProperties": false,
  "required": ["outcome", "reason"],
  "properties": {
    "outcome": { "enum": ["ok", "blocked", "infeasible"] },
    "reason": { "type": "string", "minLength": 1 },
    "escalation": { "type": "string", "minLength": 1 },
    "artifact": { "enum": ["research.md"] },
    "open_questions": { "type": "array", "items": { "type": "string", "minLength": 1 } }
  }
}
```

`src/build/schemas/build_design.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BUILD_DESIGN",
  "type": "object",
  "additionalProperties": false,
  "required": ["outcome", "reason"],
  "properties": {
    "outcome": { "enum": ["ok", "blocked", "infeasible"] },
    "reason": { "type": "string", "minLength": 1 },
    "escalation": { "type": "string", "minLength": 1 },
    "artifact": { "enum": ["design.md"] },
    "slices": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "files", "weighted_files", "packages", "tests", "done_when"],
        "properties": {
          "title": { "type": "string", "minLength": 1 },
          "files": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
          "weighted_files": { "type": "integer", "minimum": 1 },
          "packages": { "type": "array", "items": { "type": "string", "minLength": 1 } },
          "tests": { "type": "string", "minLength": 1 },
          "done_when": { "type": "string", "minLength": 1 },
          "atomicity_exception": { "type": "string", "minLength": 1 }
        }
      }
    }
  }
}
```

**Why the sizing shape and the slice list are not in `required`.** A `blocked` or `infeasible` SIZING worker has no depth to name and no slices to list, and forcing it to invent them is how a stop becomes a fabricated success. The conditional belongs where the rule already lives: `nextPhase` (`src/build/phases.mjs:654`) refuses a SIZING success whose evidence names no depth, with the §5 message, and `holdReasonRefusal` (`:132`) refuses a `blocked_other` with no escalation identity. Encoding either as an `if/then` here would be a second copy of a rule the machine owns, and the copy that wins is the one that runs. Task 2 asserts both through `applyTransition`.

- [ ] **Step 4: Implement `src/build/report.mjs`, run it green, and commit**

```js
// report -- the phase report's schema, its validation, and what it becomes.
//
// The CLI's structured result is validated LOCALLY against the same schema that
// was passed to it, because `--json-schema` is a request and not a guarantee.
// Nothing here decides anything the phase machine decides: an outcome becomes
// evidence, and `nextPhase` rules on it.
import { readFileSync } from "node:fs";

export const ACTIONS = Object.freeze(["BUILD_SIZE", "BUILD_RESEARCH", "BUILD_DESIGN"]);
export const PHASE_FOR_ACTION = Object.freeze({
  BUILD_SIZE: "SIZING", BUILD_RESEARCH: "RESEARCH", BUILD_DESIGN: "DESIGN",
});

const CACHE = new Map();
export function schemaFor(action) {
  if (!ACTIONS.includes(action)) throw new Error(`no report schema for ${JSON.stringify(action)}`);
  if (!CACHE.has(action))
    CACHE.set(action, JSON.parse(readFileSync(
      new URL(`./schemas/${action.toLowerCase()}.json`, import.meta.url), "utf8")));
  return CACHE.get(action);
}

// The subset of JSON Schema these three files use, and no more. A dependency is
// not added for it, and a validator that silently ignores a keyword it does not
// implement would make a schema look stricter than it is -- so an unknown
// keyword is an error here rather than a shrug.
const KNOWN = new Set(["$schema", "title", "type", "enum", "required", "properties",
                       "additionalProperties", "items", "minItems", "minLength", "minimum"]);
function walk(schema, value, path, errors) {
  for (const k of Object.keys(schema))
    if (!KNOWN.has(k)) errors.push(`${path}: schema uses unimplemented keyword ${k}`);
  if (schema.enum && !schema.enum.includes(value))
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return errors.push(`${path}: expected an object`);
    for (const r of schema.required ?? [])
      if (!Object.prototype.hasOwnProperty.call(value, r)) errors.push(`${path}${r}: required and missing`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (!sub) { if (schema.additionalProperties === false) errors.push(`${path}${k}: not declared by this schema`); continue; }
      walk(sub, v, `${path}${k}.`, errors);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return errors.push(`${path}: expected an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path}: needs at least ${schema.minItems} item(s), got ${value.length}`);
    value.forEach((v, i) => schema.items && walk(schema.items, v, `${path}${i}.`, errors));
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) return errors.push(`${path}: expected an integer`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
  } else if (schema.type === "string") {
    if (typeof value !== "string") return errors.push(`${path}: expected a string`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: is empty`);
  }
  return errors;
}

export function validateReport(action, value) {
  const errors = walk(schemaFor(action), value, "", []);
  return errors.length ? { ok: false, errors } : { ok: true, report: value };
}

/**
 * An outcome, as the evidence `nextPhase` already accepts.
 *
 * It invents nothing. A `blocked` report with no escalation identity produces
 * evidence with no escalation identity, and the machine refuses it -- because
 * the rule that a blocked_other must reach a founder has one home, and a default
 * supplied here would be a second copy of it that nobody could see.
 */
export function evidenceFor({ action, report }) {
  const phase = PHASE_FOR_ACTION[action];
  if (!phase) throw new Error(`no phase for ${JSON.stringify(action)}`);
  if (report.outcome === "infeasible") return { kind: "founder.infeasible", reason: report.reason };
  if (report.outcome === "blocked")
    return { kind: "hold", reason: "blocked_other", detail: report.reason, escalation: report.escalation };
  return action === "BUILD_SIZE"
    ? { kind: "phase.succeeded", phase, depth: report.depth }
    : { kind: "phase.succeeded", phase };
}

/**
 * Malformed or missing structured output. ONE `--resume` retry with the schema
 * and the parse error quoted, then the attempt budget is exhausted.
 *
 * `resumedAlready` is required rather than a counter, because a counter is what
 * lets "one retry" become "one retry per attempt".
 */
export function badReportPlan({ resumedAlready }) {
  if (typeof resumedAlready !== "boolean")
    throw new Error("badReportPlan needs to be told whether this attempt has already been resumed");
  return resumedAlready
    ? { resume: false, evidence: { kind: "phase.failed", retriesExhausted: true } }
    : { resume: true };
}
```

```bash
cp src/build/report.mjs src/build/report.mjs.bak
cp src/build/schemas/build_size.json src/build/schemas/build_size.json.bak
$N test/phase-report.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
rm -f src/build/report.mjs.bak src/build/schemas/build_size.json.bak
git add src/build/schemas src/build/report.mjs test/phase-report.test.mjs
git commit -m "feat(build): phase report schemas and the outcome-to-evidence map"
```

---

### Task 2: A mis-attributed or depth-less report is refused, the refusal is what gets recorded, and a well-formed one advances the task

**Files:**
- Modify: `test/phase-report.test.mjs` (append before the terminator — the closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group)

**Interfaces:**
- Consumes: `applyTransition` (`src/build/transition.mjs:660`), `refuseDurably`'s `transition.refused` event (`:761`), `nextPhase`'s three refusals (`src/build/phases.mjs:639,641,654`), `holdReasonRefusal`'s escalation rule (`:132`), `writeArtifact` (PR-B2 Task 1), `fileTask` (PR-B1 Task 1), `evidenceFor`/`badReportPlan` (Task 1).
- Produces: nothing new. This task asserts that the module built in Task 1 cannot advance a task the machine would refuse to advance, **through `applyTransition`** rather than through `nextPhase` alone — a pure-function assertion cannot see whether the refusal reached the database, and the database is what `task why` renders.

- [ ] **Step 1: Append the failing test**

Append to `test/phase-report.test.mjs`, before its closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group. It reuses `SIZE_OK`, `RESEARCH_OK`, `evidenceFor`, `validateReport` and `badReportPlan`, all declared at module scope by Task 1 in this same file; none is re-declared here, because a second `const SIZE_OK` makes the file fail to parse. Add these imports to that file's import block, not here:

```js
import { mkdirSync, lstatSync } from "node:fs";
import { openHub } from "../src/build/hubdb.mjs";
import { applyTransition } from "../src/build/transition.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { fileTask } from "../src/build/taskfile.mjs";
import { writeArtifact } from "../src/build/artifact.mjs";
```

```js
// A real task, in a real phase, so every refusal below is asserted where it is
// RECORDED and not only where it is decided. A refusal with no durable record is
// indistinguishable from a report that was never sent.
const repo = join(dir, "repo");
mkdirSync(join(repo, "packages", "x"), { recursive: true });
writeFileSync(join(repo, "p.json"), "{}\n");
const registry = { version: 1, projects: {
  nextly: { nwo: "nextlyhq/nextly", repoPath: repo, profilePath: join(repo, "p.json") } } };
const io = { lstat: (p) => lstatSync(p), lsTree: () => null,
  repoId: async () => 42, profileHash: async () => "ph-1", defaultBranch: async () => "main",
  visibility: async () => "private", specRepoId: async () => 77,
  gateDefinitionHash: async () => "gd-1", founderUserId: async () => 9 };

let dbn = 0;
const inSizing = async (title) => {
  const db = openHub(join(dir, `h${++dbn}.db`));
  const f = await fileTask({ db, registry, project: "nextly", title,
    territory: ["packages/x"], io, isAlive: isSameProcess,
    pid: process.pid, lstart: readStart(process.pid) });
  const t = applyTransition(db, { taskId: f.task, expectedPhase: "FILED", expectedGeneration: 1,
    evidence: { kind: "phase.succeeded", phase: "FILED" }, op: "phase.advanced", isAlive: isSameProcess });
  check(f.ok === true && t.applied === true, `fixture: ${title} is in SIZING`, JSON.stringify(t));
  return { db, id: f.task };
};
const phaseOf = (db, id) => db.prepare("SELECT phase FROM task WHERE id=?").get(id).phase;
const lastRefusal = (db, id) => db.prepare(
  "SELECT payload FROM hub_event WHERE task=? AND kind='transition.refused' ORDER BY seq DESC LIMIT 1")
  .get(id)?.payload ?? "";

// A report that names the wrong phase advances nothing, and the refusal says so.
{
  const { db, id } = await inSizing("mis-attributed");
  const ev = evidenceFor({ action: "BUILD_RESEARCH", report: RESEARCH_OK });
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: ev, artifactSha: "a".repeat(64), op: "phase.advanced", isAlive: isSameProcess });
  check(r.applied === false && r.reason === "refused",
    "a RESEARCH report against a task in SIZING is refused", JSON.stringify(r));
  check(/RESEARCH report cannot advance a task in SIZING/.test(String(r.refusal)),
    "with the machine's own message", String(r.refusal));
  check(lastRefusal(db, id).includes("cannot advance"),
    "and the refusal is the reason recorded, not merely returned", lastRefusal(db, id));
  check(phaseOf(db, id) === "SIZING", "and the task did not move", phaseOf(db, id));
  db.close();
}

// A SIZING report with no depth is refused with the section 5 message.
{
  const { db, id } = await inSizing("no depth");
  const { depth, ...noDepth } = SIZE_OK;
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: evidenceFor({ action: "BUILD_SIZE", report: noDepth }),
    artifactSha: "b".repeat(64), op: "phase.advanced", isAlive: isSameProcess });
  check(r.applied === false, "a SIZING report that names no depth is refused", JSON.stringify(r));
  check(/must name the depth it selected/.test(String(r.refusal)),
    "with the message that says why the depth is load-bearing", String(r.refusal));
  // AND THE VALIDATOR IS NOT WHAT REFUSED IT. The schema deliberately does not
  // require `depth`, so a blocked sizing worker need not invent one -- which
  // means this refusal has to come from the machine, and only asserting it
  // through applyTransition can tell the two apart.
  check(validateReport("BUILD_SIZE", noDepth).ok === true,
    "control: the schema itself accepts a depth-less report", JSON.stringify(validateReport("BUILD_SIZE", noDepth)));
  db.close();
}

// A blocked outcome with no escalation identity reaches no founder, so it is
// refused rather than held silently.
{
  const { db, id } = await inSizing("blocked with no identity");
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: evidenceFor({ action: "BUILD_SIZE", report: { outcome: "blocked", reason: "stuck", escalation: "  " } }),
    op: "hold", isAlive: isSameProcess });
  check(r.applied === false, "a blocked_other hold with an empty escalation is refused", JSON.stringify(r));
  check(/no identity reaches no founder/.test(String(r.refusal)),
    "and says that a hold nobody is told about is not a hold", String(r.refusal));
  check(phaseOf(db, id) === "SIZING", "and the task did not enter BLOCKED", phaseOf(db, id));

  const ok = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: evidenceFor({ action: "BUILD_SIZE",
      report: { outcome: "blocked", reason: "stuck", escalation: "bt:x:phase:blocked:SIZING" } }),
    op: "hold", isAlive: isSameProcess });
  check(ok.applied === true && phaseOf(db, id) === "BLOCKED",
    "control: the same hold WITH an identity is accepted", JSON.stringify(ok));
  db.close();
}

// Malformed structured output: one resumed retry, then ESCALATED, with the
// identity the machine mints from the phase.
{
  const { db, id } = await inSizing("bad report");
  check(badReportPlan({ resumedAlready: false }).resume === true,
    "control: the first malformed report is retried, not escalated");
  const plan = badReportPlan({ resumedAlready: true });
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: plan.evidence, op: "phase.failed", isAlive: isSameProcess });
  check(r.applied === true && phaseOf(db, id) === "ESCALATED",
    "a second malformed report exhausts the budget and escalates", JSON.stringify(r));
  const why = db.prepare("SELECT why FROM escalation").all().map(e => e.why);
  check(why.includes(`${id}:phase:failed:SIZING`),
    "raising bt:<id>:phase:failed:<phase>, with the id substituted once", why.join(","));
  db.close();
}

// THE ADVANCING CONTROL. Without it every assertion above is satisfied by a
// validator that refuses everything.
{
  const { db, id } = await inSizing("a good report");
  const w = writeArtifact({ dir: join(dir, "art", id), phase: "SIZING",
    bytes: Buffer.from(JSON.stringify(SIZE_OK)) });
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: evidenceFor({ action: "BUILD_SIZE", report: SIZE_OK }),
    artifactSha: w.sha256, op: "phase.advanced", isAlive: isSameProcess });
  check(r.applied === true && phaseOf(db, id) === "RESEARCH",
    "a well-formed report advances the task", JSON.stringify(r));
  const pe = db.prepare(
    "SELECT artifact_sha FROM phase_event WHERE task=? ORDER BY seq DESC LIMIT 1").get(id);
  check(pe.artifact_sha === w.sha256,
    "and the sha the artifact store computed is what justified it", JSON.stringify(pe));
  check(db.prepare("SELECT depth FROM task WHERE id=?").get(id).depth === "standard",
    "and the depth the report selected is now durable on the task");
  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/phase-report.test.mjs`
Expected: every assertion in this block is green on the first run **if Task 1 landed correctly**, because the refusals belong to `phases.mjs`, which already ships. That is not a reason to skip Step 3: run it and record which lines pass. If any line is red here, Task 1's `evidenceFor` is inventing or dropping a field, and that is exactly what this task exists to catch.

**On the broken implementation** — the one whose `evidenceFor` supplies `escalation: report.escalation ?? "bt:unknown"` so a blocked report "always reaches someone" — `a blocked_other hold with an empty escalation is refused` and `and the task did not enter BLOCKED` go red, while `control: the same hold WITH an identity is accepted` stays green and every other block in the file stays green. The default reads as defensive and is the opposite: it routes a real stop into an identity nobody watches, and the founder learns nothing while the task sits in BLOCKED looking handled.

**The stub loop for this task**: run `test/phase-report.test.mjs` green (control); apply the stub by changing `evidenceFor`'s hold return to `escalation: report.escalation ?? "bt:unknown"`, confirmed with `grep -c 'bt:unknown' src/build/report.mjs` reading 1; re-run and confirm exactly the two named assertions are red and the accepted-hold control is green; restore from `src/build/report.mjs.bak` and re-run green.

- [ ] **Step 3: Run the suite, then commit**

```bash
$N test/phase-report.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add test/phase-report.test.mjs
git commit -m "test(build): a report becomes evidence only through the machine"
```

---

### Task 3: PR-B3 close-out — freeze the three schemas, tracker, PR

**Files:**
- Create: `test/fixtures/report-schemas-v1.json`
- Modify: `test/phase-report.test.mjs` (append before the terminator), `tasks/reeve-tasks/trackers/s3.md` (**last commit only**)

- [ ] **Step 1: Freeze both halves of the report contract**

A phase schema has two halves that fail differently: the **schema files**, which are handed to the CLI as `--json-schema` and which a worker's output is validated against, and the **outcome-to-evidence map**, which turns a valid report into something `nextPhase` accepts. A freeze over the JSON alone passes while `evidenceFor` starts emitting a phase the machine refuses, and every worker's report then fails at the transition with a message about attribution.

Append to `test/phase-report.test.mjs`, before its closing `rmSync` / `console.log` / `process.exit(fail ? 1 : 0)` group:

```js
{
  const { createHash } = await import("node:crypto");
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/report-schemas-v1.json", import.meta.url), "utf8"));
  for (const action of ACTIONS) {
    const sha = createHash("sha256").update(JSON.stringify(schemaFor(action))).digest("hex");
    check(sha === frozen.schemas[action],
      `${action}'s schema is frozen`,
      `${sha} vs ${frozen.schemas[action]}\n        A change here changes what every dispatched worker is asked for.`);
  }
  const map = createHash("sha256").update(JSON.stringify(
    ACTIONS.map(a => [a, evidenceFor({ action: a, report: { outcome: "ok", reason: "r", depth: "standard" } })])
  )).digest("hex");
  check(map === frozen.evidence_map,
    "and so is the outcome-to-evidence map, which the JSON freeze cannot see", `${map} vs ${frozen.evidence_map}`);
  check(frozen.version === 1, "and the fixture records which contract it froze", String(frozen.version));
}
```

Generate the fixture through the same exports the test calls, so the two cannot compute it differently:

```bash
$N -e '
  const { createHash } = await import("node:crypto");
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { ACTIONS, schemaFor, evidenceFor } = await import("./src/build/report.mjs");
  const sha = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  writeFileSync("test/fixtures/report-schemas-v1.json", JSON.stringify({ version: 1,
    schemas: Object.fromEntries(ACTIONS.map(a => [a, sha(schemaFor(a))])),
    evidence_map: sha(ACTIONS.map(a => [a, evidenceFor({ action: a,
      report: { outcome: "ok", reason: "r", depth: "standard" } })])),
    frozen_at: "2026-08-27",
    note: "a change here changes what every dispatched worker is asked for" }, null, 2) + "\n");
  console.log(readFileSync("test/fixtures/report-schemas-v1.json", "utf8"));
'
$N test/phase-report.test.mjs
```

Verify the freeze guards, with the four-check stub loop, **twice — once per half**:

1. Add `"confidence": { "type": "integer" }` to `build_size.json`'s `properties`; re-run and expect **only** `BUILD_SIZE's schema is frozen` red; restore from `src/build/schemas/build_size.json.bak`; re-run green.
2. Change `evidenceFor`'s non-SIZING return to `{ kind: "phase.succeeded", phase, depth: null }`; re-run and expect `and so is the outcome-to-evidence map, which the JSON freeze cannot see` red **while all three schema hashes stay green**; restore from `src/build/report.mjs.bak`; re-run green.

The second run is the one that matters: it is the half the JSON freeze cannot see, and a freeze verified only against the half it already covered proves nothing about the half that was added.

- [ ] **Step 2: Full suite, from a clean checkout**

```bash
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac   # writes into the LIVE daemon's ~/.reeve/canary
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
# NONZERO on red. `|| echo` turns a failing node process into a SUCCESSFUL
# command, so this loop exited 0 with any number of red files -- and it is the
# mandatory pre-commit gate, so an executor checking the command status commits
# on a suite that just failed.
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
```

Expected: no `FAILED` lines. The 93-file baseline plus S3-A's files, plus `task-file`, `artifact` and `phase-report`.

- [ ] **Step 3: The tracker row, as the LAST commit**

In `tasks/reeve-tasks/trackers/s3.md` §1, set T5's `PR` and `STATE` to `reeve#NN` and **BUILT** — never MERGED; T6 and T10 are ordered behind it, and a MERGED written here would unblock the highest-risk PR in S3 on the strength of an unmerged review branch.

```bash
git add tasks/reeve-tasks/trackers/s3.md
git commit -m "docs(tracker): s3 T5 built"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/s3-report-schema
gh pr create --title "S3 T5: phase report schemas and the report contract" --body-file - <<'BODY'
## What

One JSON Schema per report action, a dependency-free validator for the subset
those three files use, the map from a report's outcome to the evidence
`nextPhase` already accepts, and the one-resume BAD_REPORT rule.

No GitHub call, no outbox row, and no worker is dispatched.

## Decisions taken in this PR

- **The sizing shape and the slice list are not in `required`.** A blocked or
  infeasible worker has no depth to name and no slices to list, and forcing it
  to invent them is how a stop becomes a fabricated success. The conditional
  lives where the rule already lives: `phases.mjs` refuses a SIZING success with
  no depth, and refuses a `blocked_other` with no escalation identity.
- **`evidenceFor` never manufactures an escalation identity.** A default there
  would be a second copy of `holdReasonRefusal`'s rule, and the copy that wins
  is the one that runs.
- **The validator errors on a keyword it does not implement.** A validator that
  ignores an unknown keyword makes a schema look stricter than it is.

## Review focus

- Every refusal is asserted through `applyTransition`, not through `nextPhase`
  alone: a pure-function assertion cannot see whether the refusal reached the
  database, and the database is what `task why` renders.
- The depth-less SIZING block carries a control asserting the *schema* accepts
  it, so the refusal is demonstrably the machine's and not the validator's.
BODY
gh pr comment --body "@codex review"
```

- [ ] **Step 5: Work the gate**

Comment `@codex review` on **every push**. Read **both** endpoints. Reply to **and resolve** every thread via GraphQL. Apply the taper rule.

**Do not merge.** Founder grant required.

---

---

## Self-review

**Spec coverage.** §2.2's command in full, including the two named admission tests — a territory-less insert refused (PR-B1 Task 1) and a root-prefix task blocking every concurrent grant in its project (PR-B1 Task 1) — and *"nothing is inserted"* asserted as an unchanged row **count** rather than as a returned refusal (Task 2). §2.1's `--idempotency-key` replay and `--anyway` salt (Task 4). §11.2's writer lease, on both the success and the refusal path (Task 3). §11.6's mutating `--json` shape, frozen (Task 5). §3.2's *"a transition commits only after its phase artifact is durable"* (PR-B2 Task 1, asserted at the transition and not only at the file). §3.3's run-file path with its attempt number (PR-B2 Tasks 1 and 3). §4.6's `reviewArtifact` as a sibling, each function refusing the other's phases, and the research minimum with its control (PR-B2 Task 2). §4.1's `outcome`/`reason`, §5's sizing shape, §6's slice list, and the one-resume BAD_REPORT rule (PR-B3 Tasks 1 and 2). **The S3 Verify table is not reproduced here.** It lives in `2026-08-27-s3a-profile-and-registry.md`, the family's first document, and is re-walked by `-s3f-`; a second copy would be a second inventory, which is the defect this family is trying not to add to.

**Placeholder scan.** Clean. No `TBD`, no `TODO`, no "add appropriate error handling", no "similar to Task N" in place of code. Every symbol referenced is either defined by a task in this plan, named with its `file:line` in the consumed-interfaces table above, or — for the three rows marked **(as specified)** — flagged as a shape taken from `S3-DESIGN-BRIEF.md` §2.2 rather than from merged code, with the instruction to reconcile rather than adapt. That is the plan's one known deficit and it is stated rather than smoothed: S3-A had not been written when this document was, so `capabilitiesFrom`, `registryProjects`'s four-field return and `registryIo`'s nine members are the only names here that were not read out of the source.

**Type consistency.** `TERRITORY_GRAMMAR: string`; `normalizeFiling({title, territory, depth, priority}) -> {claims} | {refusal}`; `mintTaskId() -> "bt:<26 Crockford chars>"`; `pinSeconds(raw) -> number | null | {refusal}`; `fileTask({...}) -> {ok:false, refusal} | {ok:true, dryRun:true, plan} | {ok:true, task, prev:null, next:{phase,generation}, evidence_id, next_action, replayed}`; `dryRunPlan({...}) -> {project, nwo, profileHash, territory, conflicts, floors, switches}`; `titleHash(title) -> string`; `ARTIFACT_FILE: {SIZING,RESEARCH,DESIGN} -> string`; `taskPathFor/artifactPathFor/runPathFor -> string` (the last two throw rather than returning a wrong path); `writeArtifact({dir,phase,bytes}) -> {path, sha256, bytes}`; `readArtifact({dir,phase,expectSha}) -> {ok:true,text,sha256} | {ok:false,why}`; `reviewArtifact({phase,dir,expect}) -> {ok, why, findings}`; `schemaFor(action) -> object`; `validateReport(action,value) -> {ok:true,report} | {ok:false,errors}`; `evidenceFor({action,report}) -> evidence`; `badReportPlan({resumedAlready}) -> {resume:true} | {resume:false,evidence}`. Three of these carry a deliberate asymmetry worth naming: `pinSeconds` returns a refusal **object** rather than throwing, because a bad duration is an operator typo; `reviewArtifact` and `readArtifact` **throw** on a wrong phase, because that is a wiring error at the dispatch seam and not something an operator typed.

**What this plan does not carry, and where it went.** The Verify table (S3-A). The risks, the open questions, the defect log and the PR states (`../trackers/s3.md`; F1, the spec-repo names, is still unanswered and blocks S3-A T2, not this plan). And the one thing an executor should check before Task 1: three names in the consumed-interfaces table are specified, not measured. Stop and reconcile if S3-A shipped them differently.
