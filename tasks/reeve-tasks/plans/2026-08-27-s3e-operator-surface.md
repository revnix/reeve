# S3-E: The Operator Surface, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every fact the builder holds about a task is answerable from the command line in one machine-readable shape and one human shape rendered from the same value, every UNKNOWN says UNKNOWN, every absence says absence, and the nine escalation identities S3 can produce all become durable rows while exactly three of them interrupt a human.

**Architecture:** Three PRs against `revnix/reeve` `main`, in the order E1 → E2 → E3. PR-E1 adds `src/build/show.mjs` and `src/build/why.mjs` (the read model and its two renderers), a per-command flag applicability map and a typed failure surface in `bin/reeve`, and `test/task-show.test.mjs`. PR-E2 adds `src/build/dash.mjs` (a second renderer over PR-E1's value, and deliberately **not** `src/dash.mjs`) and `test/build-dash.test.mjs`. PR-E3 adds `src/build/announce.mjs`, one additive field to each channel result in `src/notify.mjs`, six new hub findings in `src/doctor.mjs`, and `test/build-escalations.test.mjs`. **No task in S3 performs any GitHub effect, opens any PR, or enqueues any outbox row of a `gh.*` or `git.push.branch` kind; the switches for those are off and S3 does not change that and must not.** And S3-E's own, narrower: **every command in this plan is a READER; the only write any of them performs is an escalation announcement's own bookkeeping** — the `escalation` row's `count`, `last_seen_at` and `announced_count`, and nothing else in the hub.

**Tech Stack:** Node `~/.nvm/versions/node/v24.17.0/bin/node` (PATH node is v22 and `node:sqlite` warns there), `node:sqlite` `DatabaseSync`, plain-script tests under `test/*.test.mjs` (CI runs every file in that glob on ubuntu-latest under three TZs), no dependencies added.

**Spec:** `docs/2026-08-21-builder-design.md` — §14 S3 is the stage definition and its *Verify:* clause is the definition of done. The sections that bind this plan: §11.6 `:733-738` (`task list`, `task show`, the six waiting substates, `task why`, `dash`), §11.7 `:749` (escalation ownership is by process), §11.5 `:731` (`notify.mjs` reused with one additive change), §11.2 (the hub tables this plan reads), §2.2 `:136` (territory pins and their expiry), §3.5 `:272` (a CANCELLING task renders what is still draining), §4.1 (`{ok, blocked, infeasible}`, which R12's four failure types extend).

**This is one of six plans for S3.** S3 decomposes into sixteen task-PRs, and the measured reason the plan family is six documents rather than one is that plan documents are reviewed as code at roughly five times the density: the three S2 *plan* PRs were 14 files, all Markdown, and produced **561 of 1,282 findings — 43.8% of every finding review has ever produced in this repository**, with PR#12 alone at one file, +3,994 lines, 213 findings and 15 rounds.

| plan | scope |
|---|---|
| `2026-08-27-s3a-profile-and-registry.md` | `builder.*` FIELDS, the capability-switch reader, the registry's `repoPath`/`profilePath`, the S3 Verify table |
| `2026-08-27-s3b-filing-and-artifacts.md` | `reeve task file` with the territory grammar, the artifact store, `reviewArtifact`, the phase report schemas |
| `2026-08-27-s3c-dispatch.md` | `phase_run`, revocation, the sandbox and prompt action cases, the tick's dispatch and provider claim, adopt-or-kill |
| `2026-08-27-s3d-phases.md` | SIZING, RESEARCH, DESIGN, and stopping at SPEC_DRAFT |
| `2026-08-27-s3e-operator-surface.md` | this plan: `task list\|show\|why`, `dash`, escalations from the builder process, `builder doctor`'s S3 rows |
| `2026-08-27-s3f-measurements.md` | the six §14 measurements and the documents that record them, and the re-walk of S3-A's Verify table |

Their review history — every finding and what each changed — is `s3-review-history.md`. **Order matters:** A lands before B, B before C. **This plan is the one branch point in an otherwise linear stage: base it on S3-B's merge commit, and run it in parallel with S3-C and S3-D.** All three of its tasks depend on T3 (`reeve task file`, S3-B) and on nothing in the dispatcher, so E1, E2 and E3 may be executed while C and D are in flight. Within this plan the order is strict: E2 and E3 both base on E1.

---

## What this plan consumes from S3-A and S3-B

S3-A and S3-B must be merged first, in that order. These are the exact names this plan builds on; **if any has changed, stop and reconcile rather than adapting the code here.**

**Read this warning before the table.** MEASURED 2026-08-27: `tasks/reeve-tasks/plans/` is **empty** — `ls tasks/reeve-tasks/plans/` returns nothing, against a positive control that `ls tasks/reeve-tasks/` returns seven entries. Neither S3-A nor S3-B exists yet. Every row below marked **(derived)** is taken from `S3-DESIGN-BRIEF.md` §2.2's specification of T1–T5, not from a merged document, so it is a *claim about what S3-A and S3-B will produce*, not a measurement of what they did. Rows marked **(measured)** were re-derived in this worktree at `16cd880` by searching the anchor string. Reconcile every **(derived)** row against the real S3-A and S3-B before writing a line of code.

| from | name | shape |
|---|---|---|
| S3-A T1 `src/profile/schema.mjs` **(derived)** | the `builder.capabilities.*` reader | `capabilities(profile) -> { observe, draftSpec, implementLocal, publishPr, mergeBuilderPr }`, every value a boolean, read from the profile at call time. `WAITING_FOR_CAPABILITY` is derived from this **live** — Task 3 asserts the derivation flips with no write. MEASURED at `16cd880`: `git grep "capabilities" -- src bin` returns 23 hits and **none reads `observe`**; positive control, the same grep finds `mergeBuilderPr` read at `src/build/outbox.mjs:317`. So the reader genuinely does not exist yet. |
| S3-A T2 `bin/reeve` **(derived)** | the registry read | `[{ name, nwo, repoPath, profilePath }]`. MEASURED at `16cd880`: `bin/reeve:199` returns `Object.entries(reg).map(([name, p]) => ({ name, nwo: p.nwo }))` — **exactly two fields**. Task 9's dash names projects and needs no more than `name` and `nwo`, so if S3-A's shape differs in its extra fields this plan still holds; if `name` or `nwo` is renamed, stop. |
| S3-B T3 `bin/reeve` **(derived)** | `case "task":` and its `file` subcommand | This plan **adds** `list`, `show` and `why` as subcommands of the route T3 creates. It does not create the route. MEASURED at `16cd880`: `grep -c '"task"' bin/reeve` → **0**, and `bin/reeve:1765` still reads `not yet built: next · plan · lane`. |
| S3-B T3 `src/build/registry.mjs:218` **(measured)** | `admitTask(db, snapshot, filing, { isAlive }) -> {ok, taskId, replayed?} \| {ok:false, refusal}` | the writer of every `task`, `task_territory` and `territory_lease` row this plan reads. This plan calls it in **fixtures only**, and Task 3's fixture inserts rows directly instead, for the reason stated there. |
| S3-B T4 `src/paths.mjs` **(derived)** | `taskPathFor(home, taskId) -> string` | the artifact root `why` names beside each `phase_event.artifact_sha`. MEASURED: `src/paths.mjs:69` has `hubPathFor(home)` and **no `taskPathFor`**; `grep -n "taskPathFor" src/paths.mjs` → 0 hits, positive control `hubPathFor` → 1. If S3-B names it differently, `why` renders the sha and omits the path rather than guessing. |
| S2-A `src/build/hubdb.mjs:322` **(measured)** | `openHub(path, { skipIntegrity = false } = {}) -> DatabaseSync` | the privileged opener. Every module in this plan lives under `src/build/`, so it may use it; `src/daemon.mjs` may not, and this plan does not modify `src/daemon.mjs`. |
| S2-A `src/build/hubaccess.mjs:42` **(measured)** | `hubAccess(hubPath) -> handle` | the guardian's dev:ino-revalidating guest handle. Task 12 uses it as the *proof* that the guardian cannot read the builder's escalations, not as a reader. |
| S2-A `src/build/hub.sql` **(measured)** | `task:26`, `task_territory:96`, `task_drain:110`, `phase_event:133`, `hold_reason:148`, `hub_event:161`, `phase_run:175`, `gate_request`, `notice_receipt`, `territory_lease:631`, `provider_lease:643`, `escalation:712` | read-only here. `escalation` is exactly `(why TEXT PRIMARY KEY, count INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, announced_count INTEGER NOT NULL) STRICT`, verified by reading `src/build/hub.sql:712-718`. |
| S2-B `src/build/prs.mjs:37` **(measured)** | `openPrs(db, taskId, { kind = null } = {}) -> rows` | `SELECT ... FROM task_pr WHERE task = ? AND merged_sha IS NULL`. **Returns `[]` in S3, because nothing writes `task_pr` before S7.** Task 4 asserts that emptiness *and* proves the query is live by inserting a row and seeing it come back. |
| S2 `src/daemon.mjs:3236` **(measured)** | `announceable(db, escalations, { covered, waiting, finished, complete, at }) -> { fresh, cleared }` | **the SHAPE to copy, not to import.** The guardian's copy reads the guardian store's own `escalation` table. Task 12 builds the builder's own and asserts neither can read the other's store. |
| S2 `src/doctor.mjs:1075` **(measured)** | `hubFindings(db, { root, now, snapshotFor, newestCandidate, freshMinutes, snapshotMaxHours, offDevice, projects, projectsKnown }) -> Finding[]` | `Finding = { id, severity, classification, title, detail, action }`. Existing ids, measured by `grep -o '"H-[0-9]*[^"]*"'`: `H-1`, `H-2`, `H-2:newest`, `H-3`, `H-5`, `H-6` in `src/doctor.mjs`, plus `H-4:<nwo>` built per project; `H-0` and `H-7` in `bin/reeve`. Task 16 adds `H-8` through `H-13` and adds **no second `H-5`**. |
| S2 `src/notify.mjs:127` **(measured)** | `notify({ profile, alert, post, desktop, readCredential }) -> { ok, why?, channels }` where `channels = [{ name, ok, why? }]` | Task 14 adds `ref` to each channel result and to nothing else. |
| S2 `src/build/tables.mjs:22,25,46` **(measured)** | the DECLARED readers | `phase_event: { reader: "why, dash age-in-state, fences" }`, `phase_run: { reader: "why, adopt-or-kill, retry budget" }`, `escalation: { reader: "notify.mjs, dash, task resolve" }`. |

**The obligation this plan exists to discharge.** `src/build/tables.mjs` already names `why`, `dash` and `notify.mjs` as the readers of `phase_event`, `phase_run` and `escalation`. **None of the three exists.** `test/hub-crosscheck.test.mjs:66` asserts only that the `reader` field is a non-empty string, so the declaration has been green for the whole of S2 while nothing read those tables — the same shape S2-C's own consumed-interfaces table records about `pr_hold`, which shipped with a guest-allowlist entry for two rounds before anyone noticed nothing queried it: *permission to read is not a reader, and a declaration that names a reader is not one either.* Until this plan lands, every row `applyTransition` writes into `phase_event` is a fact the hub holds and no human can retrieve, and every `escalation` row the builder will write in S3-C is a durable record that reaches nobody. This plan is the reader.

### Line references in this plan

Every reference to `bin/reeve`, `src/daemon.mjs`, `src/doctor.mjs`, `src/notify.mjs` and `src/build/hub.sql` names the **anchor text to search for** first and a line number second, with the commit it was true at. Line numbers in `src/daemon.mjs` moved twice during S2-C's own review and moved again on 2026-08-27 when reeve#49 merged; `announceable` went from `:3217` to `:3236` and `hubFindings` from `:1021` to `:1075` between the design brief's measurement and this plan's. **A plan that sends an executor to a line number which has since moved is worse than one that sends them to a string: the string is still there.** Every number below was re-derived at `16cd880` by searching the string beside it, and where the string was not found the row says so.

## Global Constraints

- **Node:** always `~/.nvm/versions/node/v24.17.0/bin/node`. Alias it `N` in every shell: `N=~/.nvm/versions/node/v24.17.0/bin/node`. `node` on PATH is v22 and `node:sqlite` emits an ExperimentalWarning there; CI asserts a floor of 24.
- **Tests:** plain scripts, no framework. Use the `check(ok, name, detail)` helper shape every existing test file uses; `console.log("PASS  name")` / `"FAIL  name"`; end with `process.exit(fail ? 1 : 0)`. New files under `test/` are discovered by CI automatically.
- **The four-check stub loop for every fix:** control green, stub verified applied, the RIGHT assertion red, restore verified. Never commit a test that has not been seen red against the broken code. Every task below names the stub explicitly, **as a step**, because S2-B promised "every task names the stub explicitly" in its preamble and then contained the word `stub` exactly once — in that very bullet.
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

  The glob must not simply be `test/*.test.mjs`: that includes `escape.test.mjs`, which writes decoys into the shared `~/.reeve/canary/` tree the live daemon reads and probes the login keychain. **The baseline: 93 test files, 0 failures, 5,131 PASS assertions**, excluding `test/escape.test.mjs`, on the content of `16cd880`, under `REEVE_HOME` pointing at a directory **literally named `.reeve`**, with `~/.nvm/versions/node/v24.17.0/bin/node`. **That is the ONE base every task in this plan is measured against — never a chained comparison against the previous task**, because chained comparisons cancel and a regression introduced in Task 3 and measured only against Task 3 is invisible. The instrument behind that number was itself controlled: one file (`test/verdict.test.mjs`) reports 72 PASS lines alone, so the counter is not counting nothing, and a deliberately red probe exits 1 and the accumulator sees it, so a red file could not have been silently absorbed. Both controls were necessary — a previous session's watchdog reported *"91 of 91 files FAILED"* with `rc=0` on the same line, because `timeout` does not exist on macOS and every invocation was `command not found`.
- **"Append to `test/x.test.mjs`" always means "insert before that file's terminator."** Every test file in this repository ends with a cleanup line and `process.exit(fail ? 1 : 0)`. A block pasted after `process.exit` never runs, **and the file still reports green** — the worst available outcome, because it is indistinguishable from a passing test. Each append step below names its terminator explicitly. MEASURED at `16cd880`, the three this plan appends to: `test/cli-flags.test.mjs` and `test/hub-doctor.test.mjs` both end `rmSync(dir, ...)` / `console.log(...)` / `process.exit(fail ? 1 : 0)`; `test/escalation-dedup.test.mjs` ends `db.close()` / `rmSync(dir, ...)` / blank line / `console.log(...)` / `process.exit(fail ? 1 : 0)`.
- **Conventional Commits**, lowercase, `type(scope): subject`, ≤72 characters. **No attribution trailer of any kind.** Never `--no-verify`.
- Every change carries a what/why comment in the style of the file it lands in. Comments never reference tasks, plans, findings, or this document.
- **No raw SQL outside `src/db/` and `src/build/`.** Every statement this plan adds goes in `src/build/show.mjs`, `src/build/why.mjs`, `src/build/dash.mjs` or `src/build/announce.mjs`. MEASURED: **12 paths already violate this rule with 98 `.prepare()` calls**, and the guard that exists (`test/provider-scheduler.test.mjs:854-874`, with a proper positive control) checks **exactly one file**. **Do not add a thirteenth** — in particular, the new `bin/reeve` routes call into `src/build/` and prepare nothing themselves, and `src/doctor.mjs` (already one of the twelve, with 5 calls) gains no new statement: Task 16's findings read values passed in, exactly as `hubFindings` already does for `projects`.
- **Escalation keys are IDENTITIES.** No counts, durations, paths or SHAs in the key; those ride in the body. §11.7 lists every builder identity; Task 11 asserts, at source level and at runtime, that no builder key is minted any other way.
- **`BEGIN IMMEDIATE` or nothing.** Every module here is a reader and opens no transaction at all, except `builderAnnounceable`, which writes its bookkeeping through `hubTx`. Never `BEGIN` (DEFERRED) where a write may follow a read: `SQLITE_BUSY_SNAPSHOT` is not fixable with a longer `busy_timeout`.
- **Every hub-writing call site passes `isAlive` explicitly.** `admitTask`'s `isAlive` defaults to `() => true` — fail-open — and `src/build/loop.mjs:11-18` documents exactly this hazard for the sibling function. Only Task 15 writes, and it passes `isSameProcess` through `assertWritable`; a default `isAlive` in a production path is a defect, not a shortcut.
- No `as any`, no `@ts-expect-error`, no lint suppression.
- **Every timestamp is `INTEGER` seconds from `unixepoch()`** unless the column name ends `_ms`. Never a TEXT date. `phase_run.lstart` is TEXT and is a process-start string, not a time; do not format it as one.
- Nothing in any public or client repository may name reeve. This plan touches only `revnix/reeve`, which is private.

### Isolation while this plan is being written or executed

A guardian daemon is live on the founder's host, running from the **main checkout**, not a copy. Therefore, for anyone executing this plan:

- Work in a worktree (`git worktree add -b <branch> ~/Work/Products/reeve-wt/<name> origin/main`), never in `~/Work/Products/reeve`. A `git pull` there swaps code under a running process.
- **Never run any command in this plan without `--home` or `REEVE_HOME` pointed at a scratch directory.** MEASURED while this plan was written: `reeve build status` and `reeve builder doctor` were exercised against a temporary home under the scratchpad, and `bin/reeve:1136-1145` records that an earlier run of another task's CLI test created a real hub and a singleton lease in `~/.reeve` because it did not. The scratch directory must be **literally named `.reeve`** or `test/init.test.mjs` fails spuriously.
- Do not run `reeve canary`: it costs a real model call and writes one shared state file at `~/.reeve/canary/<owner>/<repo>.json` that the daemon also reads. Last writer wins. Task 16 reads the canary's recorded result; it never produces one.
- Do not restart the daemon, run `launchctl`, or stop the service. `reeve doctor` and `reeve builder doctor` are read-only and are fine.
- `tasks/reeve-tasks/trackers/s3.md` conflicts on every branch. Add the tracker row as the **last commit before opening the PR**, so the conflict is one line.

### What S1 and S2 measured, which changes how these tests are written

Do not re-derive any of these. Each is recorded under `docs/measured/` or in `tasks/reeve-tasks/trackers/s3.md` §7.

| Measured fact | Consequence for S3-E |
|---|---|
| `pull_request.updated_at` does **not** change when a review thread is resolved (`docs/measured/2026-08-22-the-shadow-compared-two-moments.md`) | Age-in-state comes from `phase_event`, never from `task.updated_at`. Task 8 sets `updated_at` to *now* while the newest `phase_event` is ten minutes old and asserts the age reads ten minutes. A column that is touched by writes unrelated to the change being measured is not a change signal. |
| **74 of 3,205 assertions (2.3%) are regexes over source text**, and the two headline assertions in `test/guardian-provider-lease.test.mjs` (`:182`, `:1878`) are *negative* regexes — `!/resolveRepoId\s*\(\s*(ctx\.)?hub/`, `!/\bopenHub\b/`. A rename disables the guard and it still prints PASS | Task 11's source-level assertion that no builder escalation key is interpolated is paired with a **literal counter-control**: the same extraction is run over a string that contains a violating call, and must find it. A negative regex with no counter-control is a guard nobody has tested. |
| A skipped CI job and a CI job that never ran both report zero steps; **absent and unreadable are different facts, and treating them as one is this repository's dominant defect class** | `why` distinguishes three answers, never two: a section with rows, a section with **no rows** (`absent`), and a field whose value is genuinely not known yet (`unknown`). Task 4 asserts all three appear for one task in one call. |
| The `.git` write block that stopped three real dispatches is the CLI's own sandbox layer, **beneath** reeve's declarations, and a paid worker spent thirteen consecutive tool calls diagnosing it (`docs/measured/2026-08-23-three-real-dispatches.md`) | Task 16's `H-8` reports the canary's recorded result **per contract**, including which probes the canary did not run. A doctor row that says "sandbox: pass" over a probe set that never touched `.git` is the instrument reporting a smaller question as success. |
| A scratch HOME closes the keychain **search list**, not the keychain (`docs/measured/2026-08-22-scratch-home-closes-the-keychain.md`, **read its correction banner**) | Task 16's `H-13` reports the subscription-auth probe **result**, and never restates containment. No finding in this plan claims a worker is contained. |
| **13 of 18** SHAs recorded on `docs/TRACKER.md` are unreachable from HEAD, because the repository squash-merges | The only SHA any close-out here writes is the squash SHA on `main`, and it is written after the merge, never at BUILT time. |

### Decisions taken by the founder for this stage, 2026-08-27

Recorded so no executor re-litigates them.

1. **S3-E's three tasks base on T3, not on the dispatcher.** T13, T14 and T15 depend on a filed task and on nothing S3-C or S3-D builds, so they run in parallel with T6–T12 from T3 onward. This is the one branch point in an otherwise linear stage, and it is the reason this plan can be executed while `feat/s3-phase-run` is still in review.

2. **S3 stays headless, and `--json` becomes a contract rather than a courtesy.** Every read surface is `compute → data → render`, and Task 5 installs a test that enumerates the read commands and asserts each emits parseable JSON. The reason is recorded here because it is **a scar, not an oversight**: `src/dash.mjs:1-10` documents that the telemetry stack this replaced *"spent weeks serving unauthenticated admin to the LAN, and the cheapest way not to repeat that is to have no server at all."* **A future GUI is a second renderer over the same read model and must argue against that decision explicitly, not forget it.**

3. **A flag that cannot apply is refused, not ignored** (research R7). MEASURED at `16cd880` and reproduced in Task 1's own test: `--json` is a global flag declared once at `bin/reeve:263-297`, and of the **nine read commands, all nine accept it and only three honour it**. `reeve why 123 --json` exits 0 and prints prose. *A silently inapplicable flag is indistinguishable from an absent one* — the exact defect class `test/cli-flags.test.mjs` exists to close, still open one layer up. S3 adds roughly twelve subcommands; doing this after them is twelve times the work.

4. **Errors get a stable snake_case `kind`, an exit code, and a `retryable` bit** (research R8). `die()` at `bin/reeve:60` is `console.error + exit(1)` for roughly twenty-five unrelated conditions, and exit `3` means degraded, halted or stale in three different routes with no statement anywhere that they are the same kind of thing. Task 2 gives `3` one declaration and requires every route this plan adds to name a kind. It does **not** convert the existing `die()` sites; that is stated as a deficit in the Self-review rather than smuggled in.

5. **Escalation and page are two different facts, and the design conflates them** (brief Q9, Option A, defaulted). Realised danger-through is **U-shaped in escalation rate**: at reviewer capacity C=25 the optimum was a **64% escalation rate yielding 42% danger-through, versus 57% under FULL escalation** — escalating everything is strictly worse than the optimum. A paranoid policy is also attackable: 88% escalation gave 40% attack success at 50 filler actions, while a load-aware policy at 26% held **0% until about 100**. Medicine agrees independently: 72–99% of clinical alarms are false, one unit acknowledged **18.8%**, and acceptance dropped **30% for each repeat reminder**. This is in tension with §11.7's 23 escalation identities and the standing invariant *"fail-closed is never fail-quiet"*, and the two are reconcilable but not identical, because **an escalation is a durable row that stops work and a page is an interruption**. The decision: **keep every identity as a durable escalation, and add a CLOSED PAGE LIST of three for S3** — `builder:sandbox:canary-failed` (nothing may dispatch), `builder:backup:failed` (the store is at risk), `bt:<id>:phase:blocked:<phase>` (a worker stopped and named a reason only the founder can settle). Everything else reaches `dash` and a digest. Note that `src/notify.mjs:6-11` is already independently correct on policy — *"an over-pushing channel gets muted within days and is then worse than nothing. Completions go to the store; only escalations reach a phone."* **The gap is that the policy is a comment, not a closed list**, and Task 13 makes it one.

6. **No daily page budget number is chosen in S3.** Q9's Option A names a budget beside the page list; this plan implements the list and not the number, because `docs/2026-08-21-builder-design.md:572` states *"Limits are measured before they are chosen"* and the page rate has not been observed once. Q9's own closing sentence sets the review point: revisit after S3's first week with the measured rate in hand. **An inherited workaround constant hides a real defect behind a green run**; a budget picked now would be exactly that.

7. **`src/build/dash.mjs` is a new file and is deliberately NOT `src/dash.mjs`.** The guardian's dash renders the guardian's three bands from the guardian's store; the builder's renders tasks from the hub. They share no row. And `src/dash.mjs` is one of the two live-but-untested modules: MEASURED at `16cd880`, `git grep -l -e 'dash\.mjs' -e 'renderHtml' -e 'writeDash' -- test/ | wc -l` → **0**, positive control `git grep -l 'schema\.mjs' -- test/ | wc -l` → **4**. Extending an untested 170-line module from a builder task would put the builder's only operator surface behind a file nothing covers.

8. **The dash is a digest, not a dashboard** (research R11). Separate the glanceable **status** surface from the **detail** surface, and answer five questions only: is it alive; what is it doing; **what is waiting on me and for how long**; what did it do since I last looked; what did it decline, fail or refuse. And CLI-first, not a browser tab — which is decision 2 again, from the other direction.

9. **Failure messages are typed** (research R12): `FAILED` / `UNCERTAIN` / `REFUSED` / `BLOCKED`, each with a distinct shape, never collapsed to "something went wrong". A refusal carrying a rationale let an agent self-resolve **in over half of cases** in OpenAI's measured deployment. This maps onto §4.1's `{ok, blocked, infeasible}` plus `phase.failed`, and `BLOCKED` — external, meaning quota or cooldown — is what `WAITING_FOR_QUOTA` already is. The type rides in the escalation **body**; it is never part of the key.

10. **Task numbering restarts at 1 in this document** (`../MASTER-PLAN.md` §B.8) and runs continuously across its three PRs. Cross-references from other S3 plans are written `S3-E Task 7`.

11. **S3-E adds no column and therefore no migration.** Every table it reads exists in migration 1. If any task here finds it needs a column, issue reeve#43 lands first, or this plan owes three new entries to `TABLES_AT`, `COLUMNS_AT` and the scheduler/hold/lock column lists — the second-inventory shape that gates every guardian tick's hub open.

12. **Two design-versus-code contradictions this plan reads across, carried from `../MASTER-PLAN.md` §B.11 so no executor quotes the design at them.** **C3:** the design says at `:599` that *"the territory pin lives on `territory_lease.pinned_until` only; task carries no copy"*, and `src/build/hub.sql:96-106` has `task_territory.pinned` as well, while `territory_lease.pinned_until`'s own comment at `:636` still reads *"the ONLY home of the pin"* — now false. Task 9 renders the pin from `territory_lease` and says in a comment that a second copy exists. **C4:** the design says the guardian's hub surface is *"exactly two touches"* (`:40`, `:718`, `:807`) and `src/build/hubguest.mjs:29-37` has **three** — `maintenance_lock: ["read","delete"]`, deliberately. Task 12 depends on that allowlist and must not "fix" the count.

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
| `src/build/show.mjs` (new, PR-E1) | the read model. `READ_FORMAT_VERSION`, `envelope`, `WAITING`, `NEEDS_SWITCH`, `waitingFor` (pure), `evidenceFor`, `taskShow`, `taskList`, `renderShow`, `renderList`. Every hub statement `show` and `list` need. |
| `src/build/why.mjs` (new, PR-E1) | the evidence lineage. `whyModel`, `renderWhy`. Reads `phase_event`, `phase_run`, `hold_reason`, `provider_lease`, `escalation`, `task_drain` and `openPrs`; renders absence as absence. |
| `src/build/dash.mjs` (new, PR-E2) | the digest. `dashModel`, `renderDash`. A second renderer over `taskShow`'s value; computes nothing `show --json` cannot see. **Not `src/dash.mjs`.** |
| `src/build/announce.mjs` (new, PR-E3) | `FAILURE_TYPES`, `escalationKey`, `IDENTITY_SHAPES`, `PAGES`, `pages`, `assertHub`, `builderAnnounceable`, `announce`. The builder's own copy of `announceable`'s shape, reading the hub. |
| `bin/reeve` (PR-E1, PR-E2, PR-E3) | `APPLIES` (per-command flag applicability), `EXITS`, `ERROR_KINDS`, `fail()`; `task list\|show\|why` under the route T3 creates; `task dash`; `notify --test`. |
| `src/notify.mjs` (PR-E3) | each channel result additionally carries `ref` — a delivery reference, or a named reason there is none. Nothing else changes. |
| `src/doctor.mjs` (PR-E3) | `hubFindings` gains `H-8` sandbox canary per contract, `H-9` capability switches in force, `H-10` the platform matrix row, `H-11` node v24 pinned, `H-12` artifacts dir writable, `H-13` subscription-auth probe. `H-5` is untouched. |
| `src/build/tables.mjs` (PR-E2) | `territory_lease`'s declared reader gains the dash, which is the only declaration this plan changes. |
| `test/task-show.test.mjs` (new, PR-E1) | the six waiting substates, the capability derivation, UNKNOWN, absence in `why`, the JSON envelope, and the human text's explicit non-stability. |
| `test/build-dash.test.mjs` (new, PR-E2) | one value two renderers, age-in-state from `phase_event`, switches read live, the five questions, the draining count, territory pins and expiry. |
| `test/build-escalations.test.mjs` (new, PR-E3) | bare identities with a literal counter-control, the two-store refusal, the closed page list, `notify`'s reference-or-reason, arrival-and-change announcement. |
| `test/cli-flags.test.mjs` (PR-E1, PR-E3; append) | the applicability map, the typed failure surface, and `notify --test`. |
| `test/hub-doctor.test.mjs` (PR-E3; append) | `H-8` through `H-13`, and that `builder doctor` still writes nothing. |
| `test/escalation-dedup.test.mjs` (PR-E3; append) | the builder's arrival-and-change property, beside the guardian's, and that neither store answers the other's reader. |

---
# PR-E1: The task read model

**Branch:** `feat/s3-task-read`. **Scope:** the per-command flag applicability map and the typed failure surface in `bin/reeve`; `src/build/show.mjs` and `src/build/why.mjs`; the `list`, `show` and `why` subcommands under the `task` route S3-B creates. **Budget:** ~900 changed lines. **Nothing in PR-E1 writes a single row to the hub, and Task 5 asserts that with a `hub_event` count.**

**Base this on S3-B's merge commit.** It needs the `task` route and the `task`, `task_territory` and `territory_lease` rows `task file` writes. It needs nothing from S3-C or S3-D, and it must not wait for them.

---

### Task 1: A flag that cannot apply is refused, not silently ignored

**Files:**
- Modify: `bin/reeve` (the block after `const FLAGS = {`, and the block after `if (ARGS.errors.length) {`)
- Test: `test/cli-flags.test.mjs` (append before the closing `rmSync(dir, { recursive: true, force: true });` / `console.log(...)` / `process.exit(fail ? 1 : 0)` group)

**Interfaces:**
- Consumes: `FLAGS` (`bin/reeve:263` at `16cd880`), the single-walk parser's `ARGS.flags` / `ARGS.errors` (`bin/reeve:429-435`).
- Produces: `APPLIES` — `{ [flagName]: string[] }`, a map from a flag to the closed list of commands it can change the behaviour of. A flag **absent from the map** is unconstrained, which is today's behaviour; a flag **present** in it is refused on any command not listed. Task 5 reads `APPLIES.json` to decide which routes must emit JSON, and Task 14 adds `test` to it.

**Why this is first.** MEASURED at `16cd880`, in this worktree, under a scratch `REEVE_HOME`:

```
command             accepts --json    stdout parses as JSON
doctor o/r          yes (rc=3)        JSON
status o/r          yes (rc=0)        JSON
builder doctor      yes (rc=1)        JSON
statusline o/r      yes (rc=0)        NOT-JSON
why 1 o/r           yes (rc=0)        NOT-JSON
shadow o/r          yes (rc=3)        NOT-JSON
build status        yes (rc=0)        NOT-JSON
init                yes (rc=1)        NOT-JSON
dash o/r            yes (rc=0)        NOT-JSON
```

**Nine read commands accept `--json`; three honour it; six accept it and change nothing.** The acceptance is real, not a parse accident: `reeve why 1 o/r --nonsense` exits 1 with `reeve: unknown flag --nonsense` and then lists every accepted flag, `--json` among them. And the ignoring is total: for each of the six, the output with `--json` and without it hash-compares **byte-identical**, while for each of the three it differs. That pair is the whole finding — the flag is advertised, accepted, and inert.

- [ ] **Step 1: Write the failing test**

Append to `test/cli-flags.test.mjs`, **before** its closing `rmSync` / `console.log` / `process.exit` group. The file already defines `run(...)` and a scratch home; this block adds only `readFileSync`, which the file already imports at `:13`.

```js
// A flag a command accepts and cannot act on is indistinguishable from a flag
// that does not exist. Measured before this change: nine read commands accepted
// --json, three honoured it, and for the other six the output was byte-identical
// with the flag and without it. The parser already refuses UNKNOWN flags; this
// is the missing second layer -- known, but not applicable here.
{
  const BIN = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8");

  // The denominator is DERIVED from the route table, not written out by hand: a
  // hand-built list returns the commands the author thought of and nothing in
  // the output says it is partial.
  const ROUTES = [...BIN.matchAll(/^  case "([a-z-]+)":/gm)].map(m => m[1]);
  check(ROUTES.length >= 12, `control: the route table yields ${ROUTES.length} cases`, ROUTES.join(","));
  check(ROUTES.includes("doctor") && ROUTES.includes("why"),
    "control: the extraction finds two routes known by name to exist", ROUTES.join(","));

  const { APPLIES } = await import("../bin/reeve.flags.mjs");
  check(Array.isArray(APPLIES.json) && APPLIES.json.length > 0,
    "APPLIES declares which commands --json can change", JSON.stringify(APPLIES.json));
  const unknown = APPLIES.json.filter(c => !ROUTES.includes(c));
  check(unknown.length === 0,
    "every command APPLIES.json names is a real route", `not routes: ${unknown.join(",")}`);

  // The refusal, on a command that provably ignored the flag before.
  const r = run("why", "1", "o/r", "--json");
  check(r.status === 2, "reeve why --json is refused rather than silently ignored", `rc=${r.status} ${r.out.slice(0, 160)}`);
  check(/flag_not_applicable/.test(r.out), "and the refusal names a stable kind", r.out.slice(0, 200));
  check(/--json/.test(r.out) && /why/.test(r.out),
    "and says which flag and which command", r.out.slice(0, 200));

  // CONTROL: a command that DOES honour it is untouched, or the change is a ban
  // rather than a contract.
  const ok = run("doctor", "revnix/reeve", "--json");
  let parsed = null; try { parsed = JSON.parse(ok.stdout); } catch { /* stays null */ }
  check(parsed !== null, "control: doctor --json still parses", ok.stdout.slice(0, 160));

  // CONTROL: an unknown flag is still refused by the FIRST layer, with its own
  // message. If this goes quiet, the new layer has swallowed the old one.
  const bad = run("why", "1", "o/r", "--nonsense");
  check(/unknown flag --nonsense/.test(bad.out),
    "control: an unknown flag is still refused by the parser, not by APPLIES", bad.out.slice(0, 160));
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/cli-flags.test.mjs 2>&1 | grep -E "^FAIL"`
Expected: `FAIL  APPLIES declares which commands --json can change` and the two refusal assertions, because `bin/reeve.flags.mjs` does not exist and `reeve why --json` exits 0. The two controls and the route-extraction controls are green from the first run.

**On the broken implementation** — the tempting shortcut is to hard-code the refusal inside the `why` route (`if (flag("json")) die("--json not supported here")`) rather than declaring applicability once. Under that implementation the three refusal assertions pass and **`every command APPLIES.json names is a real route` goes red**, because there is no map; and the next twelve subcommands S3 adds each need their own hand-written line, which is the shape this task exists to prevent. The `control: doctor --json still parses` line exists because a refusal wired into the parser rather than the route bans the flag everywhere and satisfies every negative assertion above.

**The stub loop for this task**: run the file green after Step 3 (**control green**); then in `bin/reeve.flags.mjs` change `json: [...]` to `json: ["doctor", "status", "builder", "build", "task", "why"]` and confirm with `grep -n '"why"' bin/reeve.flags.mjs` that the edit is on disk (**stub verified applied**); re-run and confirm the **two refusal assertions** go red while `control: doctor --json still parses` and `control: an unknown flag is still refused` stay green (**the RIGHT assertion red** — if the doctor control also goes red, the stub broke the parser rather than the map, and the reading is worthless); then restore with `cp` from a copy taken before the edit, never `git checkout`, which restores to the last *commit* and silently discards uncommitted work, and re-run to green (**restore verified by file copy**).

- [ ] **Step 3: Implement the map and the refusal**

Create `bin/reeve.flags.mjs`. It is a sibling module rather than a block inside `bin/reeve` for one measured reason: a test cannot import from `bin/reeve`, which is a script that runs its route table on import, so a map declared there can only ever be asserted by regex over source text — and 74 assertions in this repository are already that shape, two of them negative regexes that a rename disables silently.

```js
// Which commands each flag can change the behaviour of.
//
// The parser already refuses UNKNOWN flags. This is the second layer: a flag
// that is known, accepted, and inert on the command it was typed at. Measured
// before this file existed: nine read commands accepted --json, three honoured
// it, and for the other six the output was byte-identical with the flag and
// without it. An operator scripting against `reeve why --json` got prose and an
// exit code of zero, which is the one combination that cannot be detected.
//
// ABSENT means unconstrained. A flag with no entry here behaves as it always
// has, so this file can be widened one flag at a time without a flag day; what
// it must never do is claim completeness it does not have.
export const APPLIES = Object.freeze({
  // The read surfaces that emit a data shape. `builder` and `build` are the
  // route names; their subcommands are checked by the routes themselves,
  // because `positionals[0]` is not visible to the parser.
  json: Object.freeze(["doctor", "status", "builder", "build", "task"]),
});

/**
 * The refusal for a known flag typed at a command it cannot change.
 *
 * Returns null when the flag applies, so the caller reads as a guard rather
 * than as a branch. `cmd` may be undefined (`reeve --json` with no command);
 * that is a usage error the caller already handles, so it is not this one.
 */
export function inapplicable(cmd, flags) {
  if (!cmd) return null;
  for (const name of flags) {
    const allowed = APPLIES[name];
    if (!allowed || allowed.includes(cmd)) continue;
    return { flag: name, cmd, allowed: [...allowed] };
  }
  return null;
}
```

In `bin/reeve`, import it beside the other local imports and apply it immediately after the parser's own error block — the block that begins `if (ARGS.errors.length) {` (`bin/reeve:422` at `16cd880`), so an unknown flag is still reported by the first layer and this one never sees it:

```js
import { inapplicable } from "./reeve.flags.mjs";

// ... after the ARGS.errors block, before `switch (cmd)`:

// A known flag typed at a command that cannot act on it. Refused rather than
// ignored: an accepted-and-inert flag is indistinguishable from an absent one,
// and it exits 0, so nothing downstream can tell.
const inert = inapplicable(cmd, ARGS.flags);
if (inert)
  fail("flag_not_applicable",
       `reeve ${inert.cmd}: --${inert.flag} does not apply here.\n` +
       `-> --${inert.flag} applies to: ${inert.allowed.map(c => "reeve " + c).join(", ")}`,
       { exit: EXITS.misuse });
```

`fail` and `EXITS` arrive in Task 2. **Order the two commits so that Task 2's commit lands first**, or this edit references an undefined binding; the task order in this document is the review order, and the commit order is the reverse for these two alone. Say so in the commit body.

- [ ] **Step 4: Run it, then commit**

```bash
$N test/cli-flags.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add bin/reeve bin/reeve.flags.mjs test/cli-flags.test.mjs
git commit -m "feat(cli): refuse a known flag the command cannot act on"
```

Commit body: record the measured nine-accept/three-honour split and that the map is deliberately partial, with `ABSENT means unconstrained` as the stated contract.

---

### Task 2: Every failure this plan's routes emit names a kind, an exit code, and whether retrying can help

**Files:**
- Modify: `bin/reeve` (the block after `const die = (msg) =>`; and the `process.exit(findings.some(f => f.severity === "fail") ? 1` block in the `builder` route)
- Test: `test/cli-flags.test.mjs` (append before the closing `rmSync` / `console.log` / `process.exit` group)

**Interfaces:**
- Consumes: `flag` (`bin/reeve:429`), `die` (`bin/reeve:60`).
- Produces: `EXITS = { ok: 0, refused: 1, misuse: 2, degraded: 3 }`, `ERROR_KINDS` (a frozen array), and `fail(kind, message, { exit = EXITS.refused, retryable = false })` — prints a one-line message on stderr, or a JSON object on stdout when `--json` applies, and exits. Tasks 1, 5, 14 and 16 call it.

**Why the exit codes need one declaration.** MEASURED at `16cd880`: exit `3` is produced by `doctor`, by `shadow`, and by `builder doctor`, and the only place its meaning is written down is the usage text at `bin/reeve:1723` — *"0 ok · 1 broken · 3 degraded"*. `bin/reeve:1116` says *"The CLI's existing doctor convention, documented at `bin/reeve:364`"*, and `bin/reeve:364` is the unknown-flag branch of the argv parser. **The cross-reference is stale and the convention has no home**, which is the same defect as a second inventory: two statements of one fact, one of them wrong. Giving `3` a name makes the three routes provably the same kind of thing.

- [ ] **Step 1: Write the failing test**

Append to `test/cli-flags.test.mjs`, **before** its closing `rmSync` / `console.log` / `process.exit` group:

```js
// An exit code with no declaration is three routes agreeing by accident. `3`
// meant degraded in `doctor`, halted in `tick` and stale in `builder doctor`,
// and the only statement of what it meant was the usage text -- while the
// comment that cited a line number for it cited the argv parser.
{
  const { EXITS, ERROR_KINDS } = await import("../bin/reeve.flags.mjs");
  check(EXITS.ok === 0 && EXITS.refused === 1 && EXITS.misuse === 2 && EXITS.degraded === 3,
    "the four exit codes have one declaration", JSON.stringify(EXITS));
  check(new Set(Object.values(EXITS)).size === Object.keys(EXITS).length,
    "and no two names share a code", JSON.stringify(EXITS));
  check(ERROR_KINDS.length > 0 && ERROR_KINDS.every(k => /^[a-z][a-z0-9_]*$/.test(k)),
    "every error kind is snake_case", ERROR_KINDS.join(","));
  check(new Set(ERROR_KINDS).size === ERROR_KINDS.length,
    "and the list has no duplicate", ERROR_KINDS.join(","));

  // Every kind the source passes to fail() is in the closed list. Paired with a
  // literal counter-control, because a regex over source text that stops
  // matching after a rename reports PASS while guarding nothing.
  const BIN = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8");
  const CALL = /\bfail\(\s*"([a-z0-9_]+)"/g;
  const used = [...BIN.matchAll(CALL)].map(m => m[1]);
  check(used.length > 0, `control: the extraction finds ${used.length} fail() call sites`, used.join(","));
  const FIXTURE = 'fail("some_new_kind", "x");\nfail("flag_not_applicable", "y");';
  const fromFixture = [...FIXTURE.matchAll(new RegExp(CALL.source, "g"))].map(m => m[1]);
  check(fromFixture.length === 2 && fromFixture.includes("some_new_kind"),
    "counter-control: the extraction still finds a kind in a literal it has never seen",
    fromFixture.join(","));
  const undeclared = [...new Set(used)].filter(k => !ERROR_KINDS.includes(k));
  check(undeclared.length === 0, "every kind passed to fail() is declared", undeclared.join(","));

  // The JSON shape an operator scripts against.
  const r = run("why", "1", "o/r", "--json");
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* stays null */ }
  check(j !== null, "a refusal under --json is itself JSON on stdout", r.stdout.slice(0, 200));
  check(j?.ok === false && typeof j?.kind === "string" && typeof j?.retryable === "boolean",
    "carrying ok, a kind and a retryable bit", JSON.stringify(j));
  check(j?.format_version === 1, "and the envelope's format_version", JSON.stringify(j));
  check(r.status === 2, "and the exit code is the misuse one", `rc=${r.status}`);

  // Without --json the message is prose on stderr and stdout stays empty, so a
  // pipeline reading stdout gets nothing rather than half a document.
  const p = run("why", "1", "o/r", "--nonsense");
  check(p.stdout.trim() === "", "a refusal without --json writes nothing to stdout", p.stdout.slice(0, 120));
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/cli-flags.test.mjs 2>&1 | grep -E "^FAIL"`
Expected: every assertion in the block goes red at `Cannot find module` for `bin/reeve.flags.mjs` if Task 1 has not landed, or at `EXITS` being undefined if it has. The two counter-controls are the ones to watch after Step 3: `control: the extraction finds N fail() call sites` must report a non-zero N, and `counter-control: the extraction still finds a kind in a literal it has never seen` must be green **whatever the source says** — it reads a string literal, not the file.

**On the broken implementation** — the failure this guards is a `fail()` that formats a message and exits without a kind, or with a kind invented at the call site. Under that implementation `the four exit codes have one declaration` stays green and **`every kind passed to fail() is declared` goes red**, naming the invented kind. If instead the *extraction* is broken — the regex renamed out of matching — `control: the extraction finds N fail() call sites` goes red and the counter-control stays green, which distinguishes "the source has no violations" from "the check can no longer see one". Those are different facts and this repository's dominant defect class is treating them as one.

**The stub loop for this task**: green after Step 3 (**control green**); then add `fail("not_declared", "x");` to an unreachable branch of the `task` route and confirm with `grep -n 'not_declared' bin/reeve` (**stub verified applied**); re-run and confirm **`every kind passed to fail() is declared`** goes red naming `not_declared`, while both extraction controls stay green (**the RIGHT assertion red**); restore by `cp` from a pre-edit copy and re-run green (**restore verified by file copy**).

- [ ] **Step 3: Implement the failure surface**

Add to `bin/reeve.flags.mjs`:

```js
// The exit codes, in one place.
//
// `3` was produced by three routes and its meaning was written down once, in
// the usage text -- while the comment that cited a line number for it pointed at
// the argv parser. Three routes agreeing by accident is not a convention.
//
// 0  the answer is yes / nothing is wrong
// 1  a refusal, or a state the operator must act on
// 2  the command was typed wrongly and nothing was attempted
// 3  DEGRADED: the command ran, the answer is partial or the system is unwell
export const EXITS = Object.freeze({ ok: 0, refused: 1, misuse: 2, degraded: 3 });

// Closed. A kind not here cannot be emitted, so a script matching on `kind`
// never meets one it has no branch for. Adding a kind is a deliberate act with
// a test that names it.
export const ERROR_KINDS = Object.freeze([
  "flag_not_applicable",
  "usage",
  "task_not_found",
  "hub_absent",
  "hub_unreadable",
  "notify_declined",
]);
```

And in `bin/reeve`, immediately after `const die = (msg) => { ... };` (`bin/reeve:60` at `16cd880`):

```js
/**
 * Refuse, and say what kind of refusal it is.
 *
 * `die` answers roughly twenty-five unrelated conditions with the same shape:
 * one line on stderr and exit 1. Nothing downstream can tell a mistyped command
 * from an unreadable store from a task that does not exist, so nothing
 * downstream can retry the one that is worth retrying. This is additive -- the
 * existing `die` sites are untouched -- and every route added from here on uses
 * it.
 *
 * `retryable` is about the CONDITION, not about the operator: a rate limit is
 * retryable and a mistyped flag is not, whoever types it again.
 */
const fail = (kind, message, { exit = EXITS.refused, retryable = false } = {}) => {
  if (!ERROR_KINDS.includes(kind))
    throw new Error(`fail() called with an undeclared kind ${JSON.stringify(kind)}`);
  // stdout carries the machine shape and stderr the human one, never both: a
  // pipeline reading stdout must get a whole document or nothing at all.
  if (flag("json"))
    console.log(JSON.stringify({ format_version: 1, ok: false, kind, message, retryable }, null, 2));
  else console.error(message);
  process.exit(exit);
};
```

Then give `3` its name at the one site that already produces it in this file — the `builder` route's exit, whose comment already explains the reasoning; replace the literal `3` with `EXITS.degraded` and leave the comment as it stands.

- [ ] **Step 4: Run it, then commit**

```bash
$N test/cli-flags.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add bin/reeve bin/reeve.flags.mjs test/cli-flags.test.mjs
git commit -m "feat(cli): name the exit codes and type every new refusal"
```

Commit body: record that the twenty-five existing `die()` sites are deliberately untouched, that `bin/reeve:1116`'s cross-reference to `:364` was stale, and that `EXITS.degraded` now has one home.

---
### Task 3: `task show` derives every waiting substate from rows, and stores none of them

**Files:**
- Create: `src/build/show.mjs`
- Test: `test/task-show.test.mjs` (new)

**Interfaces:**
- Consumes: `openHub` (S2-A `src/build/hubdb.mjs:322`); the `task`, `hold_reason`, `provider_lease`, `escalation`, `gate_request`, `notice_receipt`, `phase_run`, `task_territory` and `territory_lease` tables; `capabilities(profile)` (S3-A T1).
- Produces: `READ_FORMAT_VERSION = 1`; `envelope(kind, data) -> { format_version, kind, data }`; `WAITING` (frozen, six strings); `NEEDS_SWITCH` (phase → capability name); `UNKNOWN = "UNKNOWN"`; `waitingFor(row, ev) -> { first, all }` — **pure, no I/O**; `evidenceFor(db, taskId, { now }) -> ev`; `taskShow(db, taskId, { now, capabilities }) -> model | null`; `taskList(db, { now, capabilities, project }) -> model[]`; `renderShow`, `renderList`. Task 4's `why` reuses `evidenceFor`; Task 7's dash reuses `taskShow` unchanged.

**The property, stated so it can be false.** §11.6 `:733-737` requires the six substates *"derived from rows, never stored as phases"*. The test of "derived" is not that the code has no `UPDATE`; it is that **changing an input that lives outside the hub changes the answer, and the hub is byte-identical afterwards.** `builder.capabilities.observe` is exactly such an input, and it is the one the founder can flip while a task sits in FILED.

- [ ] **Step 1: Write the failing test**

Create `test/task-show.test.mjs`. Beyond the standard harness it imports `openHub` and the module under test; `dir` is used for the hub file.

```js
// The six waiting substates are DERIVED, and the test of derived is not that
// nothing writes -- it is that an input living outside the hub changes the
// answer while the hub stays byte-identical. A stored substate would survive a
// switch being turned off, and the operator would be told a worker is coming.
import { openHub } from "../src/build/hubdb.mjs";
import {
  READ_FORMAT_VERSION, WAITING, NEEDS_SWITCH, UNKNOWN,
  waitingFor, evidenceFor, taskShow, taskList, renderShow,
} from "../src/build/show.mjs";
/* ... standard harness ... */

const NOW = 1_800_000_000;
const ALL_ON = { observe: true, draftSpec: true, implementLocal: true, publishPr: true, mergeBuilderPr: true };
const OBSERVE_OFF = { ...ALL_ON, observe: false };

// Rows are inserted directly rather than through admitTask: admission requires
// all eleven registry-snapshot fields and a resolvable project, and a fixture
// that has to satisfy admission tests admission, not this. The columns below are
// exactly the NOT NULL set of `task` in src/build/hub.sql:26.
const insertTask = (db, t) => db.prepare(
  `INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
                    repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,
                    created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  t.id, t.project ?? "nextly", t.repoId ?? 1, t.nwo ?? "o/r", t.title ?? "a scout task",
  t.phase ?? "FILED", t.generation ?? 1, "founder", t.sourceKey ?? t.id,
  "/repo", "/prof.json", "h0", "main", "private", 1, t.at ?? NOW, t.at ?? NOW);

const db = openHub(join(dir, "h.db"));

// ── the closed set, and the map that decides CAPABILITY ──────────────────────
{
  check(WAITING.length === 6, `there are exactly six waiting substates, not ${WAITING.length}`, WAITING.join(","));
  check(WAITING.every(w => /^WAITING_FOR_[A-Z]+$/.test(w)), "each is a bare identity", WAITING.join(","));
  check(Object.isFrozen(WAITING) && Object.isFrozen(NEEDS_SWITCH), "and neither set can be widened at runtime");
  check(NEEDS_SWITCH.FILED === "observe" && NEEDS_SWITCH.SPEC_DRAFT === "draftSpec",
    "S3's phases need observe and SPEC_DRAFT needs draftSpec", JSON.stringify(NEEDS_SWITCH));
  check(NEEDS_SWITCH.DONE === undefined && NEEDS_SWITCH.BLOCKED === undefined,
    "a terminal or held phase needs no switch: nothing is going to dispatch it",
    JSON.stringify(Object.keys(NEEDS_SWITCH)));
}

// ── WAITING_FOR_CAPABILITY is derived: the switch moves, the hub does not ────
{
  insertTask(db, { id: "bt:cap", phase: "FILED" });
  const before = db.prepare("SELECT count(*) c FROM hub_event").get().c;

  const on = taskShow(db, "bt:cap", { now: NOW, capabilities: ALL_ON });
  check(!on.waiting.all.includes("WAITING_FOR_CAPABILITY"),
    "control: with observe on, a FILED task is not waiting for a capability", JSON.stringify(on.waiting));

  const off = taskShow(db, "bt:cap", { now: NOW, capabilities: OBSERVE_OFF });
  check(off.waiting.first === "WAITING_FOR_CAPABILITY",
    "turning observe off makes the same row read WAITING_FOR_CAPABILITY", JSON.stringify(off.waiting));
  check(off.waiting.capability === "observe",
    "and it names WHICH switch, because five of them exist", JSON.stringify(off.waiting));

  const after = db.prepare("SELECT count(*) c FROM hub_event").get().c;
  check(before === after, "and neither call appended a hub_event", `${before} -> ${after}`);
  check(db.prepare("SELECT phase FROM task WHERE id='bt:cap'").get().phase === "FILED",
    "and the phase column is untouched: a substate is never stored as a phase");
}

// ── WAITING_FOR_QUOTA reads a real provider_lease row ────────────────────────
{
  insertTask(db, { id: "bt:q", phase: "SIZING" });
  const dry = taskShow(db, "bt:q", { now: NOW, capabilities: ALL_ON });
  check(!dry.waiting.all.includes("WAITING_FOR_QUOTA"),
    "control: with no lease row the task is not waiting for quota", JSON.stringify(dry.waiting));

  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,'bt:q',999,'L','queued',?,?)`).run(NOW - 90, NOW + 300);
  const wet = taskShow(db, "bt:q", { now: NOW, capabilities: ALL_ON });
  check(wet.waiting.all.includes("WAITING_FOR_QUOTA"),
    "a queued builder lease for this run_ref is WAITING_FOR_QUOTA", JSON.stringify(wet.waiting));
  check(wet.waiting.since === NOW - 90,
    "and it carries when the wait started, from requested_at", JSON.stringify(wet.waiting));

  // `held` is not `queued`. A lease that HAS the slot is not waiting for it.
  db.prepare("UPDATE provider_lease SET status='held' WHERE run_ref='bt:q'").run();
  const held = taskShow(db, "bt:q", { now: NOW, capabilities: ALL_ON });
  check(!held.waiting.all.includes("WAITING_FOR_QUOTA"),
    "control: a HELD lease is not a wait", JSON.stringify(held.waiting));
}

// ── the two substates S3 cannot reach are DERIVED, not hard-coded false ──────
{
  insertTask(db, { id: "bt:g", phase: "SIZING" });
  const none = taskShow(db, "bt:g", { now: NOW, capabilities: ALL_ON });
  check(!none.waiting.all.includes("WAITING_FOR_CODEX"),
    "with no gate_request row, WAITING_FOR_CODEX is not claimed", JSON.stringify(none.waiting));

  // The control that separates "S3 writes no gate_request" from "the derivation
  // is a hard-coded false". Without this the assertion above passes on a
  // function that returns the empty set for everything.
  db.prepare(`INSERT INTO gate_request(task,spec_repo_id,spec_pr,head_sha,round,task_generation,requested_at)
              VALUES(?,2,7,'abc',0,1,?)`).run("bt:g", NOW - 300);
  const gated = taskShow(db, "bt:g", { now: NOW, capabilities: ALL_ON });
  check(gated.waiting.all.includes("WAITING_FOR_CODEX"),
    "control: an open gate_request DOES produce WAITING_FOR_CODEX, so the derivation is live",
    JSON.stringify(gated.waiting));
  db.prepare("DELETE FROM gate_request WHERE task='bt:g'").run();
}

// ── precedence is declared, and every match is reported ──────────────────────
{
  insertTask(db, { id: "bt:both", phase: "SIZING" });
  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,'bt:both',998,'L','queued',?,?)`).run(NOW - 30, NOW + 300);
  db.prepare("INSERT INTO hold_reason(task,reason,at) VALUES(?,?,?)").run("bt:both", "blocked_founder", NOW - 600);

  const m = taskShow(db, "bt:both", { now: NOW, capabilities: ALL_ON });
  check(m.waiting.first === "WAITING_FOR_FOUNDER",
    "a founder hold outranks a queued lease in the headline", JSON.stringify(m.waiting));
  check(m.waiting.all.includes("WAITING_FOR_QUOTA") && m.waiting.all.length === 2,
    "and the quota wait is still reported, because a headline that hides a fact is a smaller answer",
    JSON.stringify(m.waiting));
}

// ── purity: waitingFor takes rows, not a database ────────────────────────────
{
  const ev = evidenceFor(db, "bt:cap", { now: NOW });
  const row = db.prepare("SELECT * FROM task WHERE id='bt:cap'").get();
  const a = waitingFor(row, { ...ev, capabilities: OBSERVE_OFF });
  const b = waitingFor(row, { ...ev, capabilities: OBSERVE_OFF });
  check(JSON.stringify(a) === JSON.stringify(b), "waitingFor is pure: the same inputs give the same answer");
  check(waitingFor(row, { ...ev, capabilities: ALL_ON }).first !== a.first,
    "and it is the CAPABILITIES argument that moved the answer, not the row");
}

// ── UNKNOWN renders as UNKNOWN ───────────────────────────────────────────────
{
  const m = taskShow(db, "bt:cap", { now: NOW, capabilities: ALL_ON });
  check(m.depth === UNKNOWN, "a task with no depth yet renders UNKNOWN, not null and not empty", String(m.depth));
  check(m.model === UNKNOWN, "and so does the model, which no run has resolved", String(m.model));
  check(m.unknown.includes("depth") && m.unknown.includes("model"),
    "and every UNKNOWN field is listed, so a reader need not scan for the string",
    JSON.stringify(m.unknown));
  const text = renderShow(m);
  check(text.includes("UNKNOWN"), "the human text says UNKNOWN out loud", text.slice(0, 200));
  check(!/\bnull\b|\bundefined\b/.test(text),
    "and never prints null or undefined, which read as a value", text.slice(0, 400));
}

// ── list ─────────────────────────────────────────────────────────────────────
{
  const rows = taskList(db, { now: NOW, capabilities: ALL_ON });
  check(rows.length === 4, `list returns every task (got ${rows.length})`, rows.map(r => r.id).join(","));
  check(rows.every(r => typeof r.waiting?.first !== "undefined"),
    "and every row carries the waiting field, present or null", JSON.stringify(rows.map(r => r.waiting?.first)));
  check(taskList(db, { now: NOW, capabilities: ALL_ON, project: "nothing" }).length === 0,
    "control: a project filter that matches nothing returns nothing, not everything");
  check(READ_FORMAT_VERSION === 1, "the read model declares its format version", String(READ_FORMAT_VERSION));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/task-show.test.mjs 2>&1 | head -3`
Expected: `Cannot find module '.../src/build/show.mjs'` — the file does not exist. After Step 3, expect all green.

**On the broken implementation** — the implementation this guards against is the natural one: compute the substate once at filing and keep it, or cache it on the model. Under it, **`turning observe off makes the same row read WAITING_FOR_CAPABILITY` goes red** and every other assertion in the block stays green, including `and neither call appended a hub_event` — because a cached value written at filing appends nothing at read time. That is the point: the write happens somewhere else, so a no-write assertion alone cannot see it. A second broken shape is a `waitingFor` that returns the first match and drops the rest; under it `and the quota wait is still reported` goes red alone. A third is hard-coding `WAITING_FOR_CODEX` to false because S3 writes no `gate_request`; under it `control: an open gate_request DOES produce WAITING_FOR_CODEX` goes red and the assertion above it stays green — which is exactly why that control exists.

**The stub loop for this task**: run green (**control green**); then in `src/build/show.mjs` change `waitingFor`'s capability branch to read a constant `true` instead of `ev.capabilities[need]`, and confirm with `grep -n "capabilities\[need\]" src/build/show.mjs` that the read is gone (**stub verified applied**); re-run and confirm **`turning observe off makes the same row read WAITING_FOR_CAPABILITY`** and **`and it names WHICH switch`** go red while `control: with observe on...` stays green (**the RIGHT assertion red** — if the control also goes red the stub broke the whole function and the reading proves nothing); restore by `cp` from a pre-edit copy, re-run green (**restore verified by file copy**).

- [ ] **Step 3: Implement `src/build/show.mjs`**

```js
// show -- what is true about one task, as data.
//
// One value, two renderers. `--json` is the contract and the human text is not:
// the text is free to change shape in any release and the envelope is not, which
// is why the version rides on the data and not on the prose.
//
// The six waiting substates are DERIVED on every read and stored nowhere. A
// stored substate outlives the condition that produced it -- a task filed while
// `observe` was on would keep reading "a worker is coming" after the switch went
// off, and the operator would be waiting for a dispatch that cannot happen.

import { openPrs } from "./prs.mjs";

/** The envelope every read surface in this family emits. One version, not three. */
export const READ_FORMAT_VERSION = 1;
export const envelope = (kind, data) => ({ format_version: READ_FORMAT_VERSION, kind, data });

/** Rendered wherever a value is not known YET. Never null, never blank. */
export const UNKNOWN = "UNKNOWN";

export const WAITING = Object.freeze([
  "WAITING_FOR_FOUNDER",
  "WAITING_FOR_QUOTA",
  "WAITING_FOR_GUARDIAN",
  "WAITING_FOR_CODEX",
  "WAITING_FOR_NOTICE",
  "WAITING_FOR_CAPABILITY",
]);

// Which capability the NEXT move out of each phase would need. A phase whose
// next move is nobody's -- terminal, held, or waiting on a human -- is absent,
// and absent means "no switch is stopping this", not "the switch is on".
export const NEEDS_SWITCH = Object.freeze({
  FILED: "observe", CLAIMING: "observe", SIZING: "observe",
  RESEARCH: "observe", DESIGN: "observe",
  SPEC_DRAFT: "draftSpec", SPEC_PR_OPEN: "draftSpec", GATE: "draftSpec",
  APPROVED: "implementLocal", IMPLEMENTING: "implementLocal",
  IMPL_PR_OPEN: "publishPr", VERDICT_WAIT: "publishPr",
  SLICE_MERGED: "mergeBuilderPr", FINALIZING: "mergeBuilderPr",
});

/**
 * Every row-shaped fact the substates are derived from, read once.
 *
 * Taken in one function so `why` and `dash` cannot each grow their own slightly
 * different set of reads: two lists built from one source agree with each other
 * and prove nothing, and this repository has measured that shape twice.
 */
export function evidenceFor(db, taskId, { now }) {
  return {
    now,
    holds: db.prepare(
      "SELECT reason, detail, at FROM hold_reason WHERE task = ? AND cleared_at IS NULL ORDER BY at").all(taskId),
    // run_ref is the task id for builder leases; the guardian's are `pr:<n>`.
    queued: db.prepare(
      `SELECT requested_at, priority FROM provider_lease
        WHERE owner = 'builder' AND run_ref = ? AND status = 'queued'
        ORDER BY requested_at LIMIT 1`).get(taskId) ?? null,
    guardianQueued: db.prepare(
      `SELECT count(*) c FROM provider_lease WHERE owner = 'guardian' AND status = 'queued'`).get().c,
    preempt: db.prepare(
      `SELECT count(*) c FROM provider_lease WHERE owner = 'builder' AND preempt_requested = 1`).get().c,
    escalations: db.prepare(
      "SELECT why, count, first_seen_at, last_seen_at FROM escalation WHERE why LIKE ? ORDER BY first_seen_at")
      .all(`${taskId}:%`),
    gateRequests: db.prepare(
      "SELECT head_sha, round, requested_at FROM gate_request WHERE task = ? ORDER BY requested_at").all(taskId),
    notices: db.prepare(
      "SELECT head_sha, kind, delivered_at FROM notice_receipt WHERE task = ?").all(taskId),
    liveRun: db.prepare(
      `SELECT phase, attempt, status, model_id, cli_version, started_at, heartbeat_at
         FROM phase_run WHERE task = ? AND status IN ('live','adopted') LIMIT 1`).get(taskId) ?? null,
    lastRun: db.prepare(
      `SELECT phase, attempt, status, model_id, cli_version, started_at
         FROM phase_run WHERE task = ? ORDER BY started_at DESC LIMIT 1`).get(taskId) ?? null,
    draining: db.prepare(
      "SELECT count(*) c FROM task_drain WHERE task = ? AND settled_at IS NULL").get(taskId).c,
    territory: db.prepare(
      `SELECT kind, path, expires_at, pinned_until FROM territory_lease
        WHERE task = ? ORDER BY kind, path`).all(taskId),
    openPrs: openPrs(db, taskId),
  };
}

/**
 * Which of the six, from rows and switches alone.
 *
 * Returns the headline AND the whole set. A headline that hides the other
 * matches answers a smaller question than the operator asked: a task can be
 * held by a human AND queued behind a guardian, and being told only the first
 * makes the second invisible until the first clears.
 *
 * Precedence, and it is a decision rather than an accident: a human hold first,
 * because nothing else moves until it clears; then the task's own queued lease,
 * which is a row about THIS task; then the global guardian pressure, which is a
 * condition about the machine; then the two gate waits; then the capability,
 * which is last because it is the least specific -- every phase has one.
 */
export function waitingFor(row, ev) {
  const all = [];
  let since = null, capability = null;

  if (ev.holds.length) { all.push("WAITING_FOR_FOUNDER"); since = ev.holds[0].at; }
  if (ev.queued) { all.push("WAITING_FOR_QUOTA"); since ??= ev.queued.requested_at; }
  if (ev.guardianQueued > 0 || ev.preempt > 0) all.push("WAITING_FOR_GUARDIAN");
  // Open means requested with no notice receipt at that head yet. S3 writes
  // neither table, so both are empty -- but the query is real, so a row written
  // by S4 is seen the day it appears rather than the day someone remembers.
  if (ev.gateRequests.some(g => !ev.notices.some(n => n.head_sha === g.head_sha)))
    all.push("WAITING_FOR_CODEX");
  if (ev.notices.some(n => n.kind === "delivered") &&
      !ev.notices.some(n => n.kind === "founder_ack"))
    all.push("WAITING_FOR_NOTICE");

  const need = NEEDS_SWITCH[row.phase];
  if (need && ev.capabilities?.[need] !== true) { all.push("WAITING_FOR_CAPABILITY"); capability = need; }

  const first = WAITING.find(w => all.includes(w)) ?? null;
  return { first, all, since, capability };
}

const orUnknown = v => (v === null || v === undefined || v === "" ? UNKNOWN : v);

/** One task, as data. `null` when there is no such task -- the caller decides what that means. */
export function taskShow(db, taskId, { now, capabilities }) {
  const row = db.prepare("SELECT * FROM task WHERE id = ?").get(taskId);
  if (!row) return null;
  const ev = { ...evidenceFor(db, taskId, { now }), capabilities };
  const model = {
    id: row.id, project: row.project, nwo: row.nwo_snapshot, title: row.title,
    phase: row.phase, generation: row.generation, priority: row.priority,
    depth: orUnknown(row.depth),
    model: orUnknown(ev.liveRun?.model_id ?? ev.lastRun?.model_id),
    cli_version: orUnknown(ev.liveRun?.cli_version ?? ev.lastRun?.cli_version),
    waiting: waitingFor(row, ev),
    running: ev.liveRun ? { phase: ev.liveRun.phase, attempt: ev.liveRun.attempt, since: ev.liveRun.started_at } : null,
    draining: row.phase === "CANCELLING" ? ev.draining : null,
    territory: ev.territory,
    escalations: ev.escalations,
    prs: ev.openPrs,
    unknown: [],
  };
  // Named rather than searched for: a reader scanning values for the literal
  // string finds it inside a title too.
  for (const k of ["depth", "model", "cli_version"]) if (model[k] === UNKNOWN) model.unknown.push(k);
  return model;
}

export function taskList(db, { now, capabilities, project = null }) {
  const ids = (project === null
    ? db.prepare("SELECT id FROM task ORDER BY created_at, id").all()
    : db.prepare("SELECT id FROM task WHERE project = ? ORDER BY created_at, id").all(project)
  ).map(r => r.id);
  return ids.map(id => taskShow(db, id, { now, capabilities }));
}

// ── renderers ────────────────────────────────────────────────────────────────
//
// THE HUMAN TEXT IS NOT A STABLE INTERFACE. It is free to change shape in any
// release. Anything that parses it is broken by design; `--json` is what a
// script reads, and its envelope carries the version that says so.

export function renderShow(m) {
  const w = m.waiting.first
    ? `${m.waiting.first}${m.waiting.capability ? ` (${m.waiting.capability} is off)` : ""}`
    : "nothing";
  const lines = [
    `${m.id}  ${m.phase}  gen ${m.generation}`,
    `  ${m.title}`,
    `  project      ${m.project} (${m.nwo})`,
    `  depth        ${m.depth}`,
    `  model        ${m.model}`,
    `  waiting on   ${w}`,
  ];
  if (m.waiting.all.length > 1) lines.push(`  also waiting ${m.waiting.all.filter(x => x !== m.waiting.first).join(", ")}`);
  if (m.draining !== null) lines.push(`  draining     ${m.draining} row(s) still to settle`);
  for (const t of m.territory)
    lines.push(`  territory    ${t.kind} ${t.path}` +
               (t.pinned_until ? `  pinned until ${t.pinned_until}` : "") +
               `  expires ${t.expires_at}`);
  for (const e of m.escalations) lines.push(`  escalation   ${e.why}  x${e.count}`);
  return lines.join("\n");
}

export function renderList(models) {
  if (!models.length) return "no tasks";
  return models.map(m =>
    `${m.id}  ${m.phase.padEnd(13)} ${(m.waiting.first ?? "-").padEnd(23)} ${m.title}`).join("\n");
}
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/task-show.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add src/build/show.mjs test/task-show.test.mjs
git commit -m "feat(build): derive the six waiting substates from rows"
```

Commit body: record that the precedence order is a decision, that `waiting.all` exists because a headline that hides a match answers a smaller question, and that `gate_request` and `notice_receipt` are queried live even though S3 writes neither.

---

### Task 4: `why` renders a task that never dispatched without throwing, and absence renders as absence

**Files:**
- Create: `src/build/why.mjs`
- Test: `test/task-show.test.mjs` (append before the closing `db.close()` / `rmSync` / `console.log` / `process.exit` group)

**Interfaces:**
- Consumes: `evidenceFor`, `UNKNOWN`, `READ_FORMAT_VERSION` (Task 3); `openPrs` (S2-B `src/build/prs.mjs:37`); the `phase_event`, `phase_run`, `hub_event` and `task_drain` tables.
- Produces: `whyModel(db, taskId, { now }) -> { format_version, task, generation, depth, floors, events, runs, lease, escalations, holds, prs, drain, unknown, absent }`; `renderWhy(model) -> string`. Task 7's dash does not call it; `reeve task why` does.

**The property.** §11.6 requires `task why` to render the evidence lineage, and for S3 that is: task generation → depth and which floors fired → the `phase_event` chain with artifact shas → `phase_run` rows with contract snapshot and drift → provider lease → escalations. **A task filed one minute ago has none of the middle four**, and the failure that matters is not a crash — a crash is loud. It is an empty render that reads as "nothing went wrong". `absent` is the field that makes the difference visible, and it is the third answer this repository's dominant defect class collapses into two.

- [ ] **Step 1: Append the failing test**

Append to `test/task-show.test.mjs`, **before** its closing `db.close()` / `rmSync` / `console.log` / `process.exit` group. It needs one more import, added at the top of the file beside the others:

```js
import { whyModel, renderWhy } from "../src/build/why.mjs";
```

```js
// A task that never dispatched has no phase_run, no lease and no PR. The failure
// that matters is not a throw -- a throw is loud. It is an empty render that
// reads as "nothing went wrong", which is the same output a healthy task with
// nothing to report would produce.
{
  insertTask(db, { id: "bt:fresh", phase: "FILED", at: NOW - 60 });

  let model = null, threw = null;
  try { model = whyModel(db, "bt:fresh", { now: NOW }); } catch (e) { threw = e; }
  check(threw === null, "why on a task that never dispatched does not throw", String(threw?.message));
  check(model !== null, "and it returns a model", JSON.stringify(model)?.slice(0, 120));

  check(Array.isArray(model.absent), "the model carries an `absent` list", JSON.stringify(model.absent));
  for (const section of ["runs", "lease", "prs", "events"])
    check(model.absent.includes(section),
      `${section} is reported ABSENT, not as an empty success`, JSON.stringify(model.absent));

  const text = renderWhy(model);
  check(/no phase_run rows/.test(text),
    "and the human text says the rows are not there, in words", text.slice(0, 400));
  check(!/^\s*$/.test(text), "the render is never blank", JSON.stringify(text.slice(0, 80)));
  check(model.depth === UNKNOWN && model.unknown.includes("depth"),
    "a depth nothing has decided renders UNKNOWN and is listed", JSON.stringify(model.unknown));

  // CONTROL: `absent` is derived, not a constant for new tasks. Give the task
  // one event and the section must leave the list.
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,artifact_sha,detail)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run("bt:fresh", NOW - 30, "dispatch.sizing", "FILED", "SIZING", 1, 1, "sha-a", "{}");
  const grown = whyModel(db, "bt:fresh", { now: NOW });
  check(!grown.absent.includes("events") && grown.events.length === 1,
    "control: one phase_event and `events` is no longer absent", JSON.stringify(grown.absent));
  check(grown.events[0].artifact_sha === "sha-a",
    "and the chain carries the artifact sha that justified the transition", JSON.stringify(grown.events[0]));
  check(grown.absent.includes("runs"),
    "while runs, which still has no rows, stays absent", JSON.stringify(grown.absent));
}

// ── the lineage, when there IS one ───────────────────────────────────────────
{
  insertTask(db, { id: "bt:full", phase: "RESEARCH" });
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,model_id,cli_version,
                                    snapshot_hash,contract_drift)
              VALUES(?,1,'SIZING',0,1,'succeeded',321,'L',?,?,?,'/o','/e','claude-x','2.0.0','snap1',?)`)
    .run("bt:full", NOW - 900, NOW - 880, NOW - 600, JSON.stringify({ model_id: "asked for y" }));
  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,'bt:full',321,'L','held',?,?)`).run(NOW - 910, NOW + 600);

  const m = whyModel(db, "bt:full", { now: NOW });
  check(m.runs.length === 1 && m.runs[0].phase === "SIZING",
    "the run is in the lineage", JSON.stringify(m.runs));
  check(m.runs[0].snapshot_hash === "snap1",
    "with the contract snapshot it ran under", JSON.stringify(m.runs[0]));
  check(m.runs[0].contract_drift !== null,
    "and the drift, when the live environment did not match", JSON.stringify(m.runs[0].contract_drift));
  check(m.lease && m.lease.status === "held", "and the provider lease", JSON.stringify(m.lease));
  check(!m.absent.includes("runs") && !m.absent.includes("lease"),
    "and neither section is absent", JSON.stringify(m.absent));

  // openPrs is real and returns nothing in S3, because nothing writes task_pr
  // before S7. Assert BOTH halves: the emptiness, and that the query can see a
  // row -- otherwise a broken query and an empty table read identically.
  check(m.prs.length === 0 && m.absent.includes("prs"),
    "S3 has no pull requests, and `prs` says absent", JSON.stringify(m.prs));
  db.prepare(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at)
              VALUES(?, 'spec', 1, 0, 1, 5, 'headsha', ?)`).run("bt:full", NOW);
  const withPr = whyModel(db, "bt:full", { now: NOW });
  check(withPr.prs.length === 1 && !withPr.absent.includes("prs"),
    "control: openPrs does return a row when one exists, so the emptiness above is the table's",
    JSON.stringify(withPr.prs));
  db.prepare("DELETE FROM task_pr WHERE task='bt:full'").run();

  check(m.format_version === READ_FORMAT_VERSION,
    "why shares the read model's format version rather than declaring a second one",
    String(m.format_version));
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/task-show.test.mjs 2>&1 | head -3`
Expected: `Cannot find module '.../src/build/why.mjs'`.

**On the broken implementation** — the shape this guards against is a `whyModel` that returns `{ events: [], runs: [], lease: null, prs: [] }` and lets the renderer print nothing for an empty array. Under it every assertion about *content* stays green and **the four `absent` assertions go red together**, along with `the human text says the rows are not there, in words`. A second shape is an `absent` list hard-coded for a task with no `phase_event`; under it `control: one phase_event and 'events' is no longer absent` goes red alone. A third is a `why` that guards the whole body with `if (!runs.length) return {}` — under it `why on a task that never dispatched does not throw` stays green, which is why it is not the only assertion.

**The stub loop for this task**: green after Step 3 (**control green**); then delete the line that pushes `"runs"` into `absent` in `src/build/why.mjs` and confirm with `grep -n 'absent.push' src/build/why.mjs` that one push is gone (**stub verified applied**); re-run and confirm **`runs is reported ABSENT, not as an empty success`** and **`while runs, which still has no rows, stays absent`** go red while `control: one phase_event and 'events' is no longer absent` stays green (**the RIGHT assertion red**); restore by `cp` from a pre-edit copy and re-run green (**restore verified by file copy**).

- [ ] **Step 3: Implement `src/build/why.mjs`**

```js
// why -- the evidence lineage behind one task, in the order it accumulated.
//
// Three answers, never two: a section with rows, a section with NO rows, and a
// field whose value is not known yet. An empty array rendered as blank space is
// indistinguishable from a healthy task with nothing to report, and that
// confusion is this repository's most-measured defect: absent and unreadable are
// different facts, and the instrument that cannot tell them apart answers a
// smaller question and reports success.

import { evidenceFor, UNKNOWN, READ_FORMAT_VERSION } from "./show.mjs";

const orUnknown = v => (v === null || v === undefined || v === "" ? UNKNOWN : v);

export function whyModel(db, taskId, { now }) {
  const row = db.prepare("SELECT * FROM task WHERE id = ?").get(taskId);
  if (!row) return null;
  const ev = evidenceFor(db, taskId, { now });

  const events = db.prepare(
    `SELECT seq, at, op, from_phase, to_phase, from_generation, to_generation, slice, artifact_sha, detail
       FROM phase_event WHERE task = ? ORDER BY seq`).all(taskId);
  const runs = db.prepare(
    `SELECT phase, slice, attempt, status, started_at, outcome, model_id, cli_version, effort,
            max_turns, max_budget_usd, snapshot_hash, contract_drift
       FROM phase_run WHERE task = ? ORDER BY started_at, attempt`).all(taskId);
  const lease = db.prepare(
    `SELECT owner, status, priority, requested_at, started_at, expires_at, preempt_requested
       FROM provider_lease WHERE run_ref = ? ORDER BY requested_at DESC LIMIT 1`).get(taskId) ?? null;
  const drain = db.prepare(
    "SELECT outbox_id, recorded_at, settled_at, forced, last_known FROM task_drain WHERE task = ? ORDER BY outbox_id")
    .all(taskId);

  // The floors that fired at SIZING, from the transition that recorded them.
  // Model-proposed depth, code-disposed floors: the design is explicit that the
  // model proposes and code disposes, so `why` shows which floor fired rather
  // than what the model said it wanted.
  const sizing = events.find(e => e.op === "sizing.decided");
  let floors = [];
  try { floors = JSON.parse(sizing?.detail ?? "{}").floors ?? []; } catch { floors = []; }

  const model = {
    format_version: READ_FORMAT_VERSION,
    task: row.id, phase: row.phase, generation: row.generation,
    depth: orUnknown(row.depth),
    floors, events, runs, lease, drain,
    holds: ev.holds, escalations: ev.escalations, prs: ev.openPrs,
    unknown: [], absent: [],
  };
  if (model.depth === UNKNOWN) model.unknown.push("depth");

  // ABSENT is per section, computed from the rows, never assumed from the
  // phase: a task can reach RESEARCH by adoption and still carry no run of its
  // own, and a phase-based guess would say the rows are there.
  if (!events.length) model.absent.push("events");
  if (!runs.length) model.absent.push("runs");
  if (!lease) model.absent.push("lease");
  if (!drain.length) model.absent.push("drain");
  if (!ev.openPrs.length) model.absent.push("prs");
  if (!ev.escalations.length) model.absent.push("escalations");
  return model;
}

/** THE HUMAN TEXT IS NOT A STABLE INTERFACE. Parse `--json`, never this. */
export function renderWhy(m) {
  const out = [`${m.task}  ${m.phase}  gen ${m.generation}  depth ${m.depth}`];
  out.push(m.floors.length ? `  floors fired: ${m.floors.join(", ")}` : "  floors fired: none recorded");

  out.push("", "  transitions");
  if (m.absent.includes("events")) out.push("    no phase_event rows: this task has never transitioned");
  else for (const e of m.events)
    out.push(`    ${e.seq}  ${e.op}  ${e.from_phase ?? "-"} -> ${e.to_phase ?? "-"}` +
             `  artifact ${e.artifact_sha ?? "none"}`);

  out.push("", "  runs");
  if (m.absent.includes("runs")) out.push("    no phase_run rows: nothing has been dispatched for this task");
  else for (const r of m.runs)
    out.push(`    ${r.phase}/${r.slice} attempt ${r.attempt}  ${r.status}` +
             `  model ${r.model_id ?? UNKNOWN}  cli ${r.cli_version ?? UNKNOWN}` +
             `  snapshot ${r.snapshot_hash ?? UNKNOWN}` +
             (r.contract_drift ? `  DRIFT ${r.contract_drift}` : ""));

  out.push("", "  provider lease");
  out.push(m.absent.includes("lease")
    ? "    no provider_lease row: this task has never asked for a slot"
    : `    ${m.lease.owner} ${m.lease.status}  requested ${m.lease.requested_at}` +
      (m.lease.preempt_requested ? "  PREEMPT REQUESTED" : ""));

  out.push("", "  escalations");
  if (m.absent.includes("escalations")) out.push("    none standing");
  else for (const e of m.escalations) out.push(`    ${e.why}  x${e.count}  since ${e.first_seen_at}`);

  out.push("", "  pull requests");
  out.push(m.absent.includes("prs")
    ? "    none open (S3 opens none: no task in S3 performs any GitHub effect)"
    : m.prs.map(p => `    ${p.kind} #${p.pr} ${p.head_sha}`).join("\n"));

  if (!m.absent.includes("drain"))
    out.push("", "  draining", ...m.drain.map(d =>
      `    outbox ${d.outbox_id}  ${d.settled_at ? "settled" : "OPEN"}${d.forced ? " (forced)" : ""}`));
  return out.join("\n");
}
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/task-show.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add src/build/why.mjs test/task-show.test.mjs
git commit -m "feat(build): render a task's evidence lineage, absence included"
```

Commit body: record that `absent` is per section and computed from rows rather than guessed from the phase, and that `openPrs` is asserted both empty and live.

---
### Task 5: `reeve task list|show|why` emit versioned JSON, and every read command is enumerated rather than remembered

**Files:**
- Modify: `bin/reeve` (the `case "task":` block S3-B creates, after its `file` subcommand), `bin/reeve.flags.mjs` (`APPLIES.json`)
- Test: `test/task-show.test.mjs` (append before its closing group), `test/cli-flags.test.mjs` (append before its closing group)

**Interfaces:**
- Consumes: `taskShow`, `taskList`, `renderShow`, `renderList`, `envelope`, `READ_FORMAT_VERSION` (Task 3); `whyModel`, `renderWhy` (Task 4); `fail`, `EXITS` (Task 2); `APPLIES` (Task 1); `hubPathFor` (`src/paths.mjs:69`); `capabilities(profile)` (S3-A T1).
- Produces: three subcommands. Nothing importable — this task is the wiring, and every fact it prints comes from Tasks 3 and 4.

**The contract, and why it is a test rather than a convention.** Founder decision 2: every read surface is `compute → data → render`, and **a test enumerates the read commands and asserts each emits parseable JSON.** The enumeration must be derived, not written out: a hand-built list returns the commands the author thought of and nothing in the output says it is partial. `APPLIES.json` is that list, and Task 1 already asserts every name in it is a real route.

- [ ] **Step 1: Append the failing tests**

Append to `test/task-show.test.mjs`, **before** its closing `db.close()` / `rmSync` / `console.log` / `process.exit` group. It needs `spawnSync` and `fileURLToPath`, added at the top of the file:

```js
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
```

```js
// compute -> data -> render. The JSON is the interface; the text is not, and it
// says so in its own output rather than only in a document nobody reads at 2am.
{
  const BIN = fileURLToPath(new URL("../bin/reeve", import.meta.url));
  const HOME = join(dir, ".reeve");           // literally `.reeve`, or init's tests fail spuriously
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--home", HOME],
                        { encoding: "utf8", timeout: 30_000 });
    return { ...r, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };

  const j = cli("task", "show", "bt:full", "--json");
  let parsed = null; try { parsed = JSON.parse(j.stdout); } catch { /* stays null */ }
  check(parsed !== null, "task show --json emits parseable JSON on stdout", j.out.slice(0, 200));
  check(parsed?.format_version === READ_FORMAT_VERSION,
    "carrying the read model's format_version", JSON.stringify(parsed)?.slice(0, 120));
  check(parsed?.kind === "task.show", "and a kind naming which surface produced it", String(parsed?.kind));
  check(parsed?.data?.waiting !== undefined, "and the waiting substate", JSON.stringify(parsed?.data?.waiting));

  const human = cli("task", "show", "bt:full");
  check(human.stdout.includes("bt:full") && human.stdout.includes("RESEARCH"),
    "the human render prints the same task", human.stdout.slice(0, 200));
  let asJson = null; try { asJson = JSON.parse(human.stdout); } catch { /* expected */ }
  check(asJson === null, "and it is NOT json, so nothing can parse it by accident", human.stdout.slice(0, 120));

  // A missing task is a typed refusal, not a stack trace and not an empty
  // success -- the two shapes an operator cannot tell apart from a real answer.
  const missing = cli("task", "show", "bt:nope", "--json");
  let mj = null; try { mj = JSON.parse(missing.stdout); } catch { /* stays null */ }
  check(mj?.ok === false && mj?.kind === "task_not_found",
    "a task that does not exist is a typed refusal", missing.out.slice(0, 200));
  check(missing.status === 1, "exiting refused, not misuse and not zero", `rc=${missing.status}`);

  const w = cli("task", "why", "bt:fresh", "--json");
  let wj = null; try { wj = JSON.parse(w.stdout); } catch { /* stays null */ }
  check(Array.isArray(wj?.data?.absent) && wj.data.absent.includes("runs"),
    "task why --json carries the absent list", w.out.slice(0, 200));

  const l = cli("task", "list", "--json");
  let lj = null; try { lj = JSON.parse(l.stdout); } catch { /* stays null */ }
  check(Array.isArray(lj?.data) && lj.data.length > 0, "task list --json is an array of models", l.out.slice(0, 200));

  // The hub is READ, and reading it must not migrate it. `build status` already
  // documents why: openHub applies forward migrations, and a migration is a
  // write, so a read command that opened privileged would upgrade the store
  // under a live builder while holding no lease.
  const events = db.prepare("SELECT count(*) c FROM hub_event").get().c;
  cli("task", "list"); cli("task", "show", "bt:full"); cli("task", "why", "bt:full");
  check(db.prepare("SELECT count(*) c FROM hub_event").get().c === events,
    "three read commands appended no hub_event between them", `${events}`);
}
```

And append to `test/cli-flags.test.mjs`, **before** its closing group — the enumeration itself:

```js
// The enumeration is DERIVED from APPLIES.json, which Task 1 already proves is a
// subset of the real route table. A hand-written list here would return the
// commands whoever wrote it thought of, and nothing in the output would say so.
{
  const { APPLIES } = await import("../bin/reeve.flags.mjs");

  // `run`, `tick`, `canary`, `backup`, `restore`, `init` and `build run` are
  // deliberately NOT invoked: they dispatch, spend, or write. Every command
  // below is a reader, and the list is filtered from APPLIES rather than
  // retyped, so a route added to APPLIES is covered the day it is added.
  const INVOCATION = {
    doctor: ["doctor", "revnix/reeve"],
    status: ["status", "revnix/reeve"],
    builder: ["builder", "doctor"],
    build: ["build", "status"],
    task: ["task", "list"],
  };
  const covered = APPLIES.json.filter(c => INVOCATION[c]);
  check(covered.length === APPLIES.json.length,
    `every command APPLIES.json names has an invocation here (${covered.length}/${APPLIES.json.length})`,
    APPLIES.json.filter(c => !INVOCATION[c]).join(","));

  let checked = 0;
  for (const c of covered) {
    const r = run(...INVOCATION[c], "--json");
    let ok = false; try { JSON.parse(r.stdout); ok = true; } catch { /* stays false */ }
    check(ok, `reeve ${INVOCATION[c].join(" ")} --json emits parseable JSON`, r.stdout.slice(0, 160));
    checked++;
  }
  check(checked === covered.length, `all ${checked} read commands were exercised, not a subset`, String(checked));

  // CONTROL: the loop can fail. A command known to emit prose, run through the
  // same parse, must NOT parse -- otherwise the checks above pass on any output.
  const prose = run("statusline", "revnix/reeve");
  let proseParsed = false; try { JSON.parse(prose.stdout); proseParsed = true; } catch { /* expected */ }
  check(!proseParsed, "control: the same parse rejects a command that emits prose", prose.stdout.slice(0, 120));
}
```

- [ ] **Step 2: Run both and watch them fail**

Run: `$N test/task-show.test.mjs 2>&1 | grep -E "^FAIL"` then `$N test/cli-flags.test.mjs 2>&1 | grep -E "^FAIL"`
Expected: every `task ...` assertion red because the subcommands do not exist; in `cli-flags`, `every command APPLIES.json names has an invocation here` is red because `task` is not yet in `APPLIES.json`, and the `reeve task list --json` line is red. `control: the same parse rejects a command that emits prose` is green from the first run.

**On the broken implementation** — the shape this guards against is a route that renders straight to a string and JSON-encodes the *string*: `console.log(JSON.stringify(renderShow(m)))`. Under it `task show --json emits parseable JSON on stdout` **passes** — a JSON string is valid JSON — and `carrying the read model's format_version` and `and the waiting substate` go red. That pair is the task: parseable is not the property, *structured from the model* is. A second shape is a route that opens the hub with `openHub` and migrates it; under it every content assertion stays green and **`three read commands appended no hub_event between them`** is the only one that moves.

**The stub loop for this task**: both files green after Step 3 (**control green**); then change the `task show` route to `console.log(JSON.stringify(renderShow(model)))` and confirm with `grep -n 'JSON.stringify(renderShow' bin/reeve` (**stub verified applied**); re-run and confirm **`carrying the read model's format_version`** and **`and the waiting substate`** go red while `task show --json emits parseable JSON on stdout` stays **green** — that combination is the finding, and if the parseable assertion also went red the stub broke output rather than shape (**the RIGHT assertion red**); restore by `cp` from a pre-edit copy, re-run both green (**restore verified by file copy**).

- [ ] **Step 3: Wire the subcommands**

Add `"task"` to `APPLIES.json` in `bin/reeve.flags.mjs`, then extend the `case "task":` block S3-B created. **If S3-B named the route or its subcommand dispatch differently, stop and reconcile rather than adding a second route.**

```js
// task list | show | why -- three renderings of one read model.
//
// READ-ONLY and READ-ONLY at the connection: `DatabaseSync` with readOnly, never
// openHub. openHub applies forward migrations, and a migration is a write, so a
// read command opened privileged would upgrade the store under a live builder,
// or during a restore, holding neither a writer lease nor assertWritable. `build
// status` records the same reasoning for the same reason.
//
// A hub that is not there is an ANSWER, not a crash: a machine with no builder
// has no hub, and `DatabaseSync` on a missing path raises an open error whose
// text is not an answer to "what are my tasks".
case "task": {
  const sub = positionals[0];
  if (sub === "list" || sub === "show" || sub === "why") {
    const hub = hubPathFor(HOME);
    if (!existsSync(hub))
      fail("hub_absent", `reeve task ${sub}: no builder hub at ${hub}. Nothing has been filed on this machine.`,
           { exit: EXITS.refused });
    let db;
    try { db = new DatabaseSync(hub, { readOnly: true, timeout: HUB_BUSY_TIMEOUT_MS }); }
    catch (e) { fail("hub_unreadable", `reeve task ${sub}: the hub at ${hub} could not be read — ${e.message}`,
                     { exit: EXITS.refused, retryable: true }); }
    try {
      const now = Math.floor(Date.now() / 1000);
      const caps = capabilities(loadProfileFor(HOME));
      if (sub === "list") {
        const models = taskList(db, { now, capabilities: caps, project: opt("project") });
        console.log(flag("json") ? JSON.stringify(envelope("task.list", models), null, 2) : renderList(models));
        process.exit(EXITS.ok);
      }
      const id = positionals[1];
      if (!id) fail("usage", `usage: reeve task ${sub} <task-id>`, { exit: EXITS.misuse });
      const model = sub === "show"
        ? taskShow(db, id, { now, capabilities: caps })
        : whyModel(db, id, { now });
      if (!model) fail("task_not_found", `reeve task ${sub}: no task ${id}`, { exit: EXITS.refused });
      console.log(flag("json")
        ? JSON.stringify(envelope(`task.${sub}`, model), null, 2)
        : (sub === "show" ? renderShow(model) : renderWhy(model)));
      process.exit(EXITS.ok);
    } finally { try { db.close(); } catch { /* already closed on the fail() paths */ } }
  }
  // ... S3-B's `file` subcommand and its usage line continue here, unchanged.
}
```

`capabilities` and `loadProfileFor` are S3-A T1's; `DatabaseSync` and `HUB_BUSY_TIMEOUT_MS` are already imported by the `build` route (`bin/reeve:1131` at `16cd880`); `existsSync` and `hubPathFor` are already imported at the top of the file. Add only the imports of `taskList`, `taskShow`, `whyModel`, `renderList`, `renderShow`, `renderWhy` and `envelope`.

- [ ] **Step 4: Run it, then commit**

```bash
$N test/task-show.test.mjs      # expect all green
$N test/cli-flags.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add bin/reeve bin/reeve.flags.mjs test/task-show.test.mjs test/cli-flags.test.mjs
git commit -m "feat(cli): task list, show and why, over one read model"
```

Commit body: record that the routes open the hub read-only and why, that the enumeration is derived from `APPLIES.json`, and that seven routes are deliberately not invoked by the enumeration because they dispatch, spend or write.

---

### Task 6: PR-E1 close-out — freeze the read model's envelope, tracker, PR

**Files:**
- Create: `test/fixtures/read-model-v1.json`
- Modify: `test/task-show.test.mjs` (append before its closing group), `tasks/reeve-tasks/trackers/s3.md` (**last commit only**)

- [ ] **Step 1: Freeze the envelope, both halves**

`READ_FORMAT_VERSION` is a promise to a script that will be written against it. A version that stays `1` while the shape underneath changes is worse than no version, because the consumer's check passes. Freeze **both** the version and the **set of keys** at each level: a freeze verified only against the half it already covered proves nothing about the half that was added.

Append to `test/task-show.test.mjs`, **before** its closing `db.close()` / `rmSync` / `console.log` / `process.exit` group:

```js
// The envelope is frozen at version 1. New fields are additive and go in a
// version bump; a key REMOVED or RENAMED breaks a consumer silently, because a
// missing key reads as undefined and undefined reads as "not set yet".
{
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/read-model-v1.json", import.meta.url), "utf8"));
  check(frozen.format_version === READ_FORMAT_VERSION,
    "the fixture froze the version this build emits", `${frozen.format_version} vs ${READ_FORMAT_VERSION}`);

  const show = taskShow(db, "bt:full", { now: NOW, capabilities: ALL_ON });
  const showKeys = Object.keys(show).sort();
  check(JSON.stringify(showKeys) === JSON.stringify(frozen.show_keys),
    "task.show's key set is unchanged since the freeze",
    `now ${showKeys.join(",")}\n        was ${frozen.show_keys.join(",")}\n        ` +
    "If this change is intentional it is a NEW format_version, not an edit here.");

  const w = whyModel(db, "bt:full", { now: NOW });
  const whyKeys = Object.keys(w).sort();
  check(JSON.stringify(whyKeys) === JSON.stringify(frozen.why_keys),
    "task.why's key set is unchanged since the freeze",
    `now ${whyKeys.join(",")}\n        was ${frozen.why_keys.join(",")}`);

  check(JSON.stringify([...WAITING]) === JSON.stringify(frozen.waiting),
    "and the six waiting substates are the six that were frozen",
    `now ${WAITING.join(",")}\n        was ${frozen.waiting.join(",")}`);
}
```

Generate the fixture from the modules as they stand at this commit:

```bash
$N -e '
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openHub } = await import("./src/build/hubdb.mjs");
  const { taskShow, WAITING, READ_FORMAT_VERSION } = await import("./src/build/show.mjs");
  const { whyModel } = await import("./src/build/why.mjs");
  const d = mkdtempSync(join(tmpdir(), "reeve-freeze-"));
  const db = openHub(join(d, "h.db"));
  db.prepare(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
                               repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,
                               created_at,updated_at)
              VALUES("bt:f","p",1,"o/r","t","FILED",1,"founder","k","/r","/p","h","main","private",1,1,1)`).run();
  const caps = { observe: true, draftSpec: true, implementLocal: true, publishPr: true, mergeBuilderPr: true };
  writeFileSync("test/fixtures/read-model-v1.json", JSON.stringify({
    format_version: READ_FORMAT_VERSION,
    show_keys: Object.keys(taskShow(db, "bt:f", { now: 1, capabilities: caps })).sort(),
    why_keys:  Object.keys(whyModel(db, "bt:f", { now: 1 })).sort(),
    waiting:   [...WAITING],
    frozen_at: "2026-08-27",
    note: "additive fields need a new format_version; a removed or renamed key breaks a consumer silently",
  }, null, 2) + "\n");
  db.close(); rmSync(d, { recursive: true, force: true });
  console.log(readFileSync("test/fixtures/read-model-v1.json", "utf8"));
'
$N test/task-show.test.mjs
```

Verify the guard guards, with the four-check stub loop, **twice — once per half**:

1. Add `spare: null,` to `taskShow`'s returned object in `src/build/show.mjs`; re-run and expect **`task.show's key set is unchanged since the freeze`** red and nothing else; restore by `cp` from a pre-edit copy; re-run green.
2. Add `spare: null,` to `whyModel`'s returned object in `src/build/why.mjs`; re-run and expect **`task.why's key set is unchanged since the freeze`** red and nothing else; restore by `cp`; re-run green.

The second run is the one that matters: it is the half that was added, and a guard that has never been seen red is a guard nobody has tested. **Restore by file copy, never `git checkout`** — `git checkout` restores to the last *commit*, silently discarding uncommitted work, and that has cost real lines in this repository.

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

Expected: no `FAILED` lines. 93 pre-existing files plus `test/task-show.test.mjs`.

- [ ] **Step 3: The tracker row, as the LAST commit**

`tasks/reeve-tasks/trackers/s3.md` conflicts on every branch. One row, edited last, so the conflict is trivial. In §1's task table, set T13's `PR` to the number and `STATE` to **BUILT** — never MERGED. This commit precedes Step 4, which opens the PR, and Step 5 forbids merging without a founder grant, so a MERGED written here claims delivery of an unmerged review branch and would incorrectly unblock T14 and T15, which base on it.

```markdown
| T13 | `reeve task list\|show\|why` and the derived waiting substates | S3-E | `feat/s3-task-read` | T3 | reeve#NN | BUILT | | | |
```

```bash
git add tasks/reeve-tasks/trackers/s3.md
git commit -m "docs(tracker): s3 T13 built"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/s3-task-read
gh pr create --title "S3 PR-E1: the task read model" --body-file - <<'BODY'
## What

`reeve task list | show | why`, over one read model with two renderers. The six
waiting substates are derived from rows on every read and stored nowhere, so
turning a capability switch off changes the answer with no write to the hub.
`why` renders a task that never dispatched without throwing, and reports each
missing section as ABSENT rather than as an empty success.

Also: a per-command flag applicability map, so a known flag typed at a command
that cannot act on it is refused rather than ignored; and one declaration for
the four exit codes, with every new refusal carrying a snake_case kind and a
retryable bit.

Nothing here writes to the hub. All three routes open it read-only, and a test
asserts three consecutive read commands append no `hub_event`.

## Decisions taken in this PR

- **`--json` is a contract, not a courtesy.** Measured at `16cd880`: nine read
  commands accepted `--json`, three honoured it, and for the other six the
  output was byte-identical with the flag and without it. A test now enumerates
  the read commands from `APPLIES.json` and asserts each emits parseable JSON.
- **The human text is explicitly not a stable interface**, and the renderers say
  so in a comment. The envelope carries `format_version`, and
  `test/fixtures/read-model-v1.json` freezes the key set at each level.
- **`waitingFor` returns the headline AND the whole set.** A task can be held by
  a human and queued behind a guardian at once, and a headline that hides the
  second answers a smaller question than the operator asked.
- **`bin/reeve.flags.mjs` is a sibling module, not a block inside `bin/reeve`.**
  A map declared in the script can only be asserted by regex over source text,
  and 74 assertions in this repository are already that shape.
- The existing ~25 `die()` sites are deliberately untouched; converting them is
  a separate cleanup.

## Review focus

- The precedence order in `waitingFor`, by eye against section 11.6. It is a
  decision, and the test asserts it, but the test cannot tell you it is the
  right order.
- `gate_request` and `notice_receipt` are queried live even though S3 writes
  neither. The control that inserts a `gate_request` and expects
  `WAITING_FOR_CODEX` is what separates "S3 writes none" from "the derivation is
  hard-coded false"; please check it reaches the real branch.
- The `task` route's `finally { db.close() }` runs after `fail()` has already
  called `process.exit` on three paths. Confirm the `try` around `close` is
  right rather than hiding something.
BODY
gh pr comment --body "@codex review"
```

- [ ] **Step 5: Work the gate**

Comment `@codex review` on **every push**, not only the first. Read **both** endpoints — a clean pass arrives as an issue comment and findings as a review object, so reading one is one shape short. Reply to **and resolve** every thread via GraphQL; replying alone does not clear it. Apply the taper rule: ten rounds without the findings tapering means stop and bring the shape, not the next fix.

**Do not merge.** Founder grant required.

---
# PR-E2: The builder dash, as a digest

**Branch:** `feat/s3-dash`. **Scope:** `src/build/dash.mjs`, the `task dash` subcommand, and one declaration change in `src/build/tables.mjs`. **Budget:** ~700 changed lines. **PR-E2 computes nothing `task show --json` cannot already see, and Task 7 asserts that by rendering both from one object.**

**Base this on PR-E1's merge commit.** It consumes `taskShow` and adds no read of its own that `evidenceFor` does not already perform.

---

### Task 7: The dash and `show --json` are two renderings of one value

**Files:**
- Create: `src/build/dash.mjs`
- Test: `test/build-dash.test.mjs` (new)

**Interfaces:**
- Consumes: `taskShow`, `taskList`, `envelope`, `READ_FORMAT_VERSION`, `UNKNOWN` (PR-E1 Task 3); `openHub`.
- Produces: `dashModel(db, { now, capabilities, projects, since }) -> model`; `renderDash(model) -> string`. Task 9 fills the five question keys; this task establishes that both outputs come from one object.

**The property, stated so it can be false.** The brief's T14 asks that "the HTML and the JSON derive from one value". **There is no HTML** — founder decision 2 makes S3 headless and R11 makes the surface a CLI digest rather than a browser tab, so the two renderings are *text* and *JSON*. The property is unchanged and the test is the same: build one model, render both from it, and compare the facts. A dash that re-queries for its text is two implementations of one question that can disagree, and the disagreement is silent because each is individually correct.

- [ ] **Step 1: Write the failing test**

Create `test/build-dash.test.mjs`.

```js
// One value, two renderers. A dash that re-queries for its text is a second
// implementation of the same question: each is individually correct, they
// disagree under exactly the conditions nobody tested, and neither reports that
// it disagreed.
import { openHub } from "../src/build/hubdb.mjs";
import { taskShow, UNKNOWN, READ_FORMAT_VERSION } from "../src/build/show.mjs";
import { dashModel, renderDash } from "../src/build/dash.mjs";
/* ... standard harness ... */

const NOW = 1_800_000_000;
const ALL_ON = { observe: true, draftSpec: true, implementLocal: true, publishPr: true, mergeBuilderPr: true };
const PROJECTS = [{ name: "nextly", nwo: "o/r" }];

const insertTask = (db, t) => db.prepare(
  `INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
                    repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,
                    created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  t.id, t.project ?? "nextly", t.repoId ?? 1, t.nwo ?? "o/r", t.title ?? "a scout task",
  t.phase ?? "FILED", t.generation ?? 1, "founder", t.sourceKey ?? t.id,
  "/repo", "/prof.json", "h0", "main", "private", 1, t.at ?? NOW, t.at ?? NOW);

const db = openHub(join(dir, "h.db"));
insertTask(db, { id: "bt:a", phase: "SIZING" });
insertTask(db, { id: "bt:b", phase: "FILED", title: "second task" });

// ── one object, two renderings ───────────────────────────────────────────────
{
  const m = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  const text = renderDash(m);
  const json = JSON.parse(JSON.stringify(m));

  for (const t of json.tasks) {
    check(text.includes(t.id), `the text names ${t.id}, and so does the JSON`, text.slice(0, 300));
    check(text.includes(t.phase), `and its phase ${t.phase}`, text.slice(0, 300));
  }
  check(json.tasks.length === 2, `both tasks are in the model (got ${json.tasks.length})`,
    json.tasks.map(t => t.id).join(","));

  // THE assertion: mutate the ONE object and BOTH outputs move. A dash that
  // re-queries produces the same text from a changed model, and every assertion
  // above still passes.
  m.tasks[0].phase = "ZZZTEST";
  const text2 = renderDash(m);
  check(text2.includes("ZZZTEST"),
    "the text renders from the model it is handed, not from a second read of the database",
    text2.slice(0, 300));
  check(!text2.includes("SIZING") || m.tasks.some(t => t.phase === "SIZING"),
    "and the old value is gone from the text unless another task still carries it", text2.slice(0, 300));
  m.tasks[0].phase = "SIZING";
}

// ── the model is taskShow's, not a parallel one ──────────────────────────────
{
  const m = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  const direct = taskShow(db, "bt:a", { now: NOW, capabilities: ALL_ON });
  const inDash = m.tasks.find(t => t.id === "bt:a");
  const shared = ["id", "phase", "generation", "depth", "model", "waiting", "territory", "escalations"];
  for (const k of shared)
    check(JSON.stringify(inDash[k]) === JSON.stringify(direct[k]),
      `the dash's ${k} is byte-identical to task show's`,
      `dash ${JSON.stringify(inDash[k])} vs show ${JSON.stringify(direct[k])}`);
  check(Object.keys(direct).every(k => k in inDash),
    "the dash's task carries every field show does, so the dash computes nothing show cannot see",
    Object.keys(direct).filter(k => !(k in inDash)).join(","));
}

// ── the envelope is shared, not a second one ─────────────────────────────────
{
  const m = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  check(m.format_version === READ_FORMAT_VERSION,
    "the dash shares the read model's format version rather than declaring a second",
    String(m.format_version));
  check(renderDash(m).includes("UNKNOWN") || m.tasks.every(t => !t.unknown.length),
    "and an UNKNOWN in the model reaches the text", String(UNKNOWN));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/build-dash.test.mjs 2>&1 | head -3`
Expected: `Cannot find module '.../src/build/dash.mjs'`.

**On the broken implementation** — the shape this guards against is `renderDash(db, opts)` taking the database and querying it again, with `dashModel` used only for the JSON. Under it every assertion in the first block passes except **`the text renders from the model it is handed`**, because the mutated model never reaches the text. That single assertion is the task. A second shape is a `dashModel` that builds its own reduced task object — `{id, phase, waiting}` — instead of reusing `taskShow`; under it the three `byte-identical` assertions pass on the fields it kept and **`the dash's task carries every field show does`** goes red naming the dropped ones. The reason that matters is not tidiness: a reduced object is a second answer to "what is true about this task", and the two drift the first time one is extended.

**The stub loop for this task**: green after Step 3 (**control green**); then change `renderDash(m)` to re-read by giving it a second parameter and querying `db` for the phase, and confirm with `grep -n 'prepare' src/build/dash.mjs | wc -l` that a statement appeared where there were none (**stub verified applied** — `dash.mjs` prepares nothing of its own, so a non-zero count *is* the stub); re-run and confirm **`the text renders from the model it is handed`** goes red while the byte-identical assertions stay green (**the RIGHT assertion red**); restore by `cp` from a pre-edit copy and re-run green (**restore verified by file copy**).

- [ ] **Step 3: Implement `src/build/dash.mjs`**

```js
// dash -- the builder's digest.
//
// NOT src/dash.mjs. That file is the guardian's: it renders the guardian's three
// bands from the guardian's store, they share no row with a task, and it is one
// of the two live-but-untested modules in this repository -- measured, with a
// positive control, at zero test files naming it or its exports. Extending it
// from here would put the builder's only operator surface behind a file nothing
// covers.
//
// A DIGEST, not a dashboard. It answers five questions and refuses to grow a
// sixth: is it alive, what is it doing, what is waiting on you and for how long,
// what happened since you last looked, and what did it decline, fail or refuse.
// The research this follows is blunt about why -- "no one but SRE and Platform
// engineers want to see the pretty graphs" -- and the failure mode is not
// clutter, it is that the one line that matters stops being findable.
//
// EVERY FACT COMES FROM taskShow. This module prepares no statement of its own,
// which is the mechanical form of "the dash must compute nothing `show --json`
// cannot see": a second query is a second answer to one question, and two
// answers that are each individually correct disagree silently.

import { taskList, envelope, READ_FORMAT_VERSION, UNKNOWN } from "./show.mjs";

export { envelope };

export function dashModel(db, { now, capabilities, projects = [], since = null }) {
  const tasks = taskList(db, { now, capabilities });
  return {
    format_version: READ_FORMAT_VERSION,
    generated_at: now,
    projects: projects.map(p => ({ name: p.name, nwo: p.nwo })),
    switches: { ...capabilities },
    tasks,
    // Task 9 fills these five from `tasks` and nothing else.
    alive: null, doing: [], waiting_on_you: [], since_you_looked: [], declined: [],
    since,
  };
}

/** THE HUMAN TEXT IS NOT A STABLE INTERFACE. Parse `--json`, never this. */
export function renderDash(m) {
  const out = [`builder digest  ${m.projects.map(p => p.nwo).join(" ") || "(no projects)"}`];
  out.push(`  switches  ${Object.entries(m.switches).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join("  ")}`);
  out.push("");
  if (!m.tasks.length) out.push("  no tasks");
  for (const t of m.tasks)
    out.push(`  ${t.id}  ${t.phase.padEnd(13)} ${(t.waiting.first ?? "-").padEnd(23)} ` +
             `${t.depth === UNKNOWN ? "depth UNKNOWN" : "depth " + t.depth}  ${t.title}`);
  return out.join("\n");
}
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/build-dash.test.mjs      # expect all green
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add src/build/dash.mjs test/build-dash.test.mjs
git commit -m "feat(build): a builder digest rendered from the read model"
```

Commit body: record that `dash.mjs` prepares no statement of its own, and that this is the mechanical form of "computes nothing `show --json` cannot see".

---

### Task 8: Age-in-state comes from `phase_event`, and the switches are read from the live profile

**Files:**
- Modify: `src/build/dash.mjs` (`dashModel`), `src/build/show.mjs` (`evidenceFor`, `taskShow`)
- Test: `test/build-dash.test.mjs` (append before its closing `db.close()` / `rmSync` / `console.log` / `process.exit` group)

**Interfaces:**
- Consumes: the `phase_event` table.
- Produces: `ageInState(ev, row) -> { seconds, from } | null` exported from `src/build/show.mjs` and reachable on every model as `age`. `from` is `"phase_event"` or `"created_at"`, and never `"updated_at"`. Task 9 renders it.

**Why `updated_at` is refused by name.** MEASURED (`docs/measured/2026-08-22-the-shadow-compared-two-moments.md`): `pull_request.updated_at` does **not** change when a review thread is resolved. The class is general — a column touched by writes unrelated to the change being measured is not a change signal — and `task.updated_at` is written by every transition compensation, including ones that change no phase. §11.6 `:738` asks for *"age-in-state from the event log with server-clock elapsed"*, and the event log is `phase_event`.

- [ ] **Step 1: Append the failing test**

Append to `test/build-dash.test.mjs`, **before** its closing group:

```js
// `updated_at` is not a change signal. It is written by transitions that change
// no phase, and the measured instance of this class is that a pull request's
// updated_at does not move when a review thread is resolved. Section 11.6 asks
// for age-in-state FROM THE EVENT LOG, and this is that in one assertion.
{
  insertTask(db, { id: "bt:age", phase: "SIZING", at: NOW - 10_000 });
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,artifact_sha,detail)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run("bt:age", NOW - 600, "dispatch.sizing", "FILED", "SIZING", 1, 1, "sha-a", "{}");
  // The trap: touch updated_at to NOW, as a compensation that changed no phase
  // would. A dash reading this column answers "0 seconds" for a task that has
  // been stuck for ten minutes.
  db.prepare("UPDATE task SET updated_at = ? WHERE id = 'bt:age'").run(NOW);

  const m = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  const t = m.tasks.find(x => x.id === "bt:age");
  check(t.age?.seconds === 600,
    "age-in-state is 600s, from the phase_event that entered this phase", JSON.stringify(t.age));
  check(t.age?.from === "phase_event", "and it says which column it came from", JSON.stringify(t.age));
  check(t.age?.from !== "updated_at",
    "and never updated_at, which a phase-preserving compensation moves", JSON.stringify(t.age));

  // CONTROL: a NEWER event for the same phase moves the age. Without this the
  // assertion above passes on a constant.
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,artifact_sha,detail)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run("bt:age", NOW - 60, "resume", "SIZING", "SIZING", 1, 2, null, "{}");
  const m2 = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  check(m2.tasks.find(x => x.id === "bt:age").age.seconds === 60,
    "control: a newer event entering the same phase moves the age",
    JSON.stringify(m2.tasks.find(x => x.id === "bt:age").age));

  // A task with no event at all: created_at, and it SAYS so. Not zero, and not
  // a throw -- both of which read as an answer.
  insertTask(db, { id: "bt:noev", phase: "FILED", at: NOW - 300 });
  const t3 = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS })
    .tasks.find(x => x.id === "bt:noev");
  check(t3.age?.seconds === 300 && t3.age?.from === "created_at",
    "a task with no phase_event falls back to created_at and names the fallback", JSON.stringify(t3.age));
}

// ── the switches are read live, never from a stored copy ─────────────────────
{
  const on = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  const off = dashModel(db, { now: NOW, capabilities: { ...ALL_ON, observe: false }, projects: PROJECTS });
  check(on.switches.observe === true && off.switches.observe === false,
    "the dash reports the switches it was handed, both ways",
    `${on.switches.observe} / ${off.switches.observe}`);
  check(renderDash(off).includes("observe=off"),
    "and the text says which one is off, by name", renderDash(off).slice(0, 200));

  const filed = off.tasks.filter(t => t.phase === "FILED");
  check(filed.length > 0 && filed.every(t => t.waiting.all.includes("WAITING_FOR_CAPABILITY")),
    "and every FILED task reads WAITING_FOR_CAPABILITY under the same call, with no write",
    JSON.stringify(filed.map(t => t.waiting.first)));

  // No column anywhere holds a switch: a stored copy is a second source of truth
  // that goes stale the moment the profile is edited, and nothing reports that.
  const cols = db.prepare("SELECT name FROM pragma_table_info('task')").all().map(r => r.name);
  check(!cols.some(c => /observe|capab|switch/i.test(c)),
    "control: no task column stores a capability", cols.join(","));
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/build-dash.test.mjs 2>&1 | grep -E "^FAIL"`
Expected: every `age` assertion red — `t.age` is `undefined`, so `t.age?.seconds === 600` is false. The switch assertions are green already from Task 7's model, except `and the text says which one is off, by name`, which is green because `renderDash` already prints the switch line. Confirm that before Step 3: an assertion green before the implementation is not covering the implementation.

**On the broken implementation** — the shape this guards against is `age: now - row.updated_at`, which is the obvious one and the one the column name invites. Under it **`age-in-state is 600s`** goes red reading 0, **`and it says which column it came from`** goes red, and `control: a newer event entering the same phase moves the age` **also goes red at 0** — three reds, and the three together say "the source is wrong", not "the arithmetic is wrong". A subtler shape is `max(at) FROM phase_event` with no phase filter, which reads the newest event of any kind; under it the first block passes and the control passes too, and it fails only when the newest event is a `sizing.decided` that entered no phase — so the implementation filters on `to_phase = task.phase` and the comment says why.

**The stub loop for this task**: green after Step 3 (**control green**); then change `ageInState` to `{ seconds: now - row.updated_at, from: "updated_at" }` and confirm with `grep -n 'updated_at' src/build/show.mjs` (**stub verified applied**); re-run and confirm **`age-in-state is 600s`**, **`and it says which column it came from`** and **`and never updated_at`** go red while `control: no task column stores a capability` stays green (**the RIGHT assertion red**); restore by `cp` and re-run green (**restore verified by file copy**).

- [ ] **Step 3: Implement `ageInState`**

Add to `src/build/show.mjs`, and add the read to `evidenceFor` beside the others:

```js
// in evidenceFor's returned object, beside `liveRun`:
    // The event that ENTERED the current phase. Not max(at) over every event: a
    // `sizing.decided` or a hold annotation carries no to_phase and would read
    // as "the phase changed just now" for a task that has not moved in hours.
    enteredAt: db.prepare(
      `SELECT max(at) at FROM phase_event
        WHERE task = ? AND to_phase = (SELECT phase FROM task WHERE id = ?)`).get(taskId, taskId)?.at ?? null,
```

```js
/**
 * How long this task has been in its current phase, and from which column.
 *
 * NEVER `task.updated_at`. That column is written by transitions that change no
 * phase, so it answers "when did anything happen" rather than "how long has this
 * been stuck" -- and the measured instance of the class is that a pull request's
 * `updated_at` does not move when a review thread is resolved, which is the one
 * event an operator most wants to see.
 *
 * `from` is returned beside the number because a fallback that does not announce
 * itself is a different measurement wearing the same name.
 */
export function ageInState(row, ev) {
  if (ev.enteredAt != null) return { seconds: Math.max(0, ev.now - ev.enteredAt), from: "phase_event" };
  return { seconds: Math.max(0, ev.now - row.created_at), from: "created_at" };
}
```

and add one line to `taskShow`'s model, beside `waiting`:

```js
    age: ageInState(row, ev),
```

Then add `age` to the frozen key set: **PR-E1's freeze fixture must be regenerated in this commit**, because `test/task-show.test.mjs`'s key-set assertion goes red the moment `age` appears. Re-run the fixture command from PR-E1 Task 6 Step 1, and say in the commit body that `format_version` stays `1` because the change is purely additive and no key was removed or renamed.

- [ ] **Step 4: Run it, then commit**

```bash
$N test/build-dash.test.mjs     # expect all green
$N test/task-show.test.mjs      # expect all green, after regenerating the freeze fixture
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add src/build/show.mjs src/build/dash.mjs test/build-dash.test.mjs test/fixtures/read-model-v1.json
git commit -m "feat(build): age-in-state from the event log, never updated_at"
```

---

### Task 9: The digest answers five questions, a draining cancel says how many rows are left, and a pin carries its expiry

**Files:**
- Modify: `src/build/dash.mjs` (`dashModel`, `renderDash`), `src/build/tables.mjs` (`territory_lease`'s `reader`), `bin/reeve` (the `task` route: a `dash` subcommand)
- Test: `test/build-dash.test.mjs` (append before its closing group)

**Interfaces:**
- Consumes: `taskShow`'s `draining`, `territory`, `escalations`, `waiting`, `age`, `running` (PR-E1 Task 3, Task 8); `singleton_lease` for the heartbeat.
- Produces: the five keys filled — `alive`, `doing`, `waiting_on_you`, `since_you_looked`, `declined` — and `reeve task dash [--json] [--since <unix>]`.

**The five, and the refusal to grow a sixth.** R11: separate the glanceable status surface from the detail surface, and answer five questions only — is it alive (heartbeat and last-seen); what is it doing; **what is waiting on me and for how long**; what did it do since I last looked; what did it decline, fail or refuse. §11.6 `:738` adds the fields each must carry, §2.2 `:136` puts the territory pin and its expiry beside the task, and §3.5 `:272` makes a CANCELLING task render the count of rows still draining.

- [ ] **Step 1: Append the failing test**

Append to `test/build-dash.test.mjs`, **before** its closing group:

```js
// Five questions, and a test that the sixth cannot be added quietly. The failure
// a digest has is not clutter: it is that the one line that matters stops being
// findable, and nothing reports that it stopped.
{
  const m = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS, since: NOW - 3600 });
  const FIVE = ["alive", "doing", "waiting_on_you", "since_you_looked", "declined"];
  for (const k of FIVE) check(k in m, `the digest answers "${k}"`, Object.keys(m).join(","));

  // The set is closed. A new question is a deliberate act with a test, not a
  // field someone added while passing.
  const SUPPORTING = ["format_version", "generated_at", "projects", "switches", "tasks", "since"];
  const extra = Object.keys(m).filter(k => !FIVE.includes(k) && !SUPPORTING.includes(k));
  check(extra.length === 0, "and nothing else, so the digest cannot grow a sixth question quietly", extra.join(","));
}

// ── what is waiting on me, AND FOR HOW LONG ──────────────────────────────────
{
  insertTask(db, { id: "bt:held", phase: "SIZING" });
  db.prepare("INSERT INTO hold_reason(task,reason,detail,at) VALUES(?,?,?,?)")
    .run("bt:held", "blocked_founder", "needs a spec repo", NOW - 7200);

  const m = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  const row = m.waiting_on_you.find(x => x.id === "bt:held");
  check(row, "a task held on the founder is in waiting_on_you",
    JSON.stringify(m.waiting_on_you.map(x => x.id)));
  check(row?.waiting === "WAITING_FOR_FOUNDER", "with the substate", JSON.stringify(row));
  check(typeof row?.for_seconds === "number" && row.for_seconds >= 7200,
    "and FOR HOW LONG, which is the half of the question a state alone does not answer",
    JSON.stringify(row));

  // CONTROL: a task waiting on the machine is NOT in waiting_on_you. Without
  // this, waiting_on_you passes as a synonym for "every waiting task", and the
  // one surface an operator scans becomes the one they stop scanning.
  insertTask(db, { id: "bt:quota", phase: "SIZING" });
  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,'bt:quota',777,'L','queued',?,?)`).run(NOW - 100, NOW + 300);
  const m2 = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  check(!m2.waiting_on_you.some(x => x.id === "bt:quota"),
    "control: a task waiting on QUOTA is not waiting on you", JSON.stringify(m2.waiting_on_you.map(x => x.id)));
  check(m2.doing.some(x => x.id === "bt:quota") || m2.tasks.some(x => x.id === "bt:quota"),
    "but it is still visible: not-yours is not the same as not-shown",
    JSON.stringify(m2.doing.map(x => x.id)));
}

// ── a draining cancel says how many rows are left ────────────────────────────
{
  insertTask(db, { id: "bt:cancel", phase: "CANCELLING" });
  db.prepare(`INSERT INTO outbox(idempotency_key,kind,task,generation,fence,args,not_before,created_at,status,attempts,max_attempts)
              VALUES('k1','notify',?,1,1,'{}',0,?, 'pending',0,8)`).run("bt:cancel", NOW);
  const oid = db.prepare("SELECT id FROM outbox WHERE idempotency_key='k1'").get().id;
  db.prepare("INSERT INTO task_drain(task,outbox_id,recorded_at) VALUES(?,?,?)").run("bt:cancel", oid, NOW - 30);

  const m = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  const t = m.tasks.find(x => x.id === "bt:cancel");
  check(t.draining === 1, "a CANCELLING task carries the count of rows still draining", JSON.stringify(t.draining));
  check(renderDash(m).includes("draining 1"),
    "and the text says the number, because CANCELLING alone does not say whether it is nearly done",
    renderDash(m).slice(0, 600));

  db.prepare("UPDATE task_drain SET settled_at = ? WHERE task='bt:cancel'").run(NOW);
  const m2 = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  check(m2.tasks.find(x => x.id === "bt:cancel").draining === 0,
    "control: a settled row leaves the count, so the number is derived and not a flag");
}

// ── territory pins and their expiry, beside the task ─────────────────────────
{
  db.prepare(`INSERT INTO territory_lease(project,kind,path,task,expires_at,pinned_until)
              VALUES('nextly','prefix','src/',?,?,?)`).run("bt:held", NOW + 3600, NOW + 7200);
  const m = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  const t = m.tasks.find(x => x.id === "bt:held");
  check(t.territory.length === 1 && t.territory[0].path === "src/",
    "the claim is beside the task", JSON.stringify(t.territory));
  check(t.territory[0].pinned_until === NOW + 7200,
    "and the pin carries its expiry, not just the fact of being pinned", JSON.stringify(t.territory[0]));
  const text = renderDash(m);
  check(/src\//.test(text) && /pinned/.test(text),
    "and both reach the text", text.slice(0, 700));
}

// ── is it alive ──────────────────────────────────────────────────────────────
{
  const dead = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  check(dead.alive?.running === false,
    "with no singleton lease the digest says the builder is not running, rather than saying nothing",
    JSON.stringify(dead.alive));

  db.prepare(`INSERT INTO singleton_lease(name,pid,lstart,command,acquired_at,heartbeat_at,expires_at)
              VALUES('build',424242,'L','reeve build run',?,?,?)`).run(NOW - 300, NOW - 20, NOW + 300);
  const live = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  check(live.alive?.running === true && live.alive?.last_seen_seconds === 20,
    "control: with a lease it says running, and how long since the heartbeat",
    JSON.stringify(live.alive));
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/build-dash.test.mjs 2>&1 | grep -E "^FAIL"`
Expected: `the digest answers "alive"` passes (the key exists from Task 7, holding `null`), while `with no singleton lease the digest says the builder is not running` fails on `null?.running`, and every `waiting_on_you` and `draining 1` assertion fails. **`and nothing else, so the digest cannot grow a sixth question quietly` is green from the first run**, and must be — Task 7 established exactly those keys, and a control that is red before the implementation is testing the implementation rather than controlling it.

**On the broken implementation** — the shape this guards against is `waiting_on_you = tasks.filter(t => t.waiting.first)`, which reads as obviously right. Under it every positive assertion passes and **`control: a task waiting on QUOTA is not waiting on you` goes red alone**: the digest's most valuable line becomes a list of every waiting task, and an operator who scans it twice and finds nothing of theirs stops scanning it — the measured mechanism is that alert acceptance drops 30% for each repeat, and the surface degrades without ever reporting that it did. A second shape is `draining` as a boolean; under it `a CANCELLING task carries the count` goes red and `control: a settled row leaves the count` goes red with it, which distinguishes a wrong type from a wrong query.

**The stub loop for this task**: green after Step 3 (**control green**); then change `waiting_on_you`'s filter to `t => t.waiting.first !== null` and confirm with `grep -n 'waiting_on_you' src/build/dash.mjs` that the `HUMAN_WAITS` membership test is gone (**stub verified applied**); re-run and confirm **`control: a task waiting on QUOTA is not waiting on you`** goes red *alone*, with `a task held on the founder is in waiting_on_you` still green (**the RIGHT assertion red** — a stub that reds both broke the field rather than the filter); restore by `cp` and re-run green (**restore verified by file copy**).

- [ ] **Step 3: Fill the five, and add the route**

In `src/build/dash.mjs`:

```js
// The two substates only a human can clear. The other four clear themselves --
// a quota frees, a guardian finishes, a gate answers -- and putting them in
// `waiting_on_you` makes the one list an operator scans a list of everything,
// which is the same as not having it. Measured elsewhere and it generalises:
// acceptance of a repeated alert drops about 30% each time it repeats.
const HUMAN_WAITS = new Set(["WAITING_FOR_FOUNDER", "WAITING_FOR_NOTICE"]);
const TERMINAL = new Set(["DONE", "CANCELLED", "LOST", "INFEASIBLE"]);

export function dashModel(db, { now, capabilities, projects = [], since = null }) {
  const tasks = taskList(db, { now, capabilities });
  const lease = db.prepare(
    `SELECT pid, heartbeat_at, expires_at FROM singleton_lease WHERE name = 'build'`).get() ?? null;

  return {
    format_version: READ_FORMAT_VERSION,
    generated_at: now,
    projects: projects.map(p => ({ name: p.name, nwo: p.nwo })),
    switches: { ...capabilities },
    tasks,
    since,

    // 1. Is it alive? A heartbeat AND when it was last seen: "running" without
    // a last-seen is a claim a dead process can still make through its row.
    alive: {
      running: !!lease && lease.expires_at > now,
      pid: lease?.pid ?? null,
      last_seen_seconds: lease ? Math.max(0, now - lease.heartbeat_at) : null,
    },

    // 2. What is it doing? A live run, or a task that is moving.
    doing: tasks.filter(t => t.running || (!TERMINAL.has(t.phase) && !t.waiting.first))
                .map(t => ({ id: t.id, phase: t.phase, since: t.running?.since ?? null, title: t.title })),

    // 3. What is waiting on ME, and for how long. `for_seconds` is the half a
    // state alone does not answer, and it is the half that decides what to do
    // first.
    waiting_on_you: tasks.filter(t => HUMAN_WAITS.has(t.waiting.first))
      .map(t => ({ id: t.id, waiting: t.waiting.first,
                   for_seconds: t.waiting.since != null ? Math.max(0, now - t.waiting.since) : t.age.seconds,
                   title: t.title })),

    // 4. What happened since I last looked. `since` null means "no window given"
    // and the list is empty rather than everything -- an unbounded answer to a
    // bounded question is not a smaller mistake than a wrong one.
    since_you_looked: since == null ? [] : db.prepare(
      `SELECT task, at, op, from_phase, to_phase FROM phase_event WHERE at > ? ORDER BY at`).all(since),

    // 5. What did it decline, fail or refuse. Standing escalations, whichever
    // way they were announced -- the page list decides who is interrupted, never
    // what is recorded.
    declined: tasks.flatMap(t => t.escalations.map(e => ({ id: t.id, why: e.why, count: e.count,
                                                           since: e.first_seen_at }))),
  };
}
```

and extend `renderDash` so every one of the five reaches the text:

```js
export function renderDash(m) {
  const out = [`builder digest  ${m.projects.map(p => p.nwo).join(" ") || "(no projects)"}`];
  out.push(m.alive.running
    ? `  alive     pid ${m.alive.pid}, last seen ${m.alive.last_seen_seconds}s ago`
    : `  alive     NOT RUNNING (no live singleton lease)`);
  out.push(`  switches  ${Object.entries(m.switches).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join("  ")}`);

  out.push("", `  waiting on you (${m.waiting_on_you.length})`);
  if (!m.waiting_on_you.length) out.push("    nothing");
  for (const w of m.waiting_on_you) out.push(`    ${w.id}  ${w.waiting}  for ${w.for_seconds}s  ${w.title}`);

  out.push("", `  tasks (${m.tasks.length})`);
  if (!m.tasks.length) out.push("    none");
  for (const t of m.tasks) {
    out.push(`    ${t.id}  ${t.phase.padEnd(13)} ${(t.waiting.first ?? "-").padEnd(23)} ` +
             `${t.age.seconds}s in state (${t.age.from})  ` +
             `${t.depth === UNKNOWN ? "depth UNKNOWN" : "depth " + t.depth}  ${t.title}` +
             (t.draining !== null ? `  draining ${t.draining}` : ""));
    for (const c of t.territory)
      out.push(`      territory ${c.kind} ${c.path}` +
               (c.pinned_until ? `  pinned until ${c.pinned_until}` : "") +
               `  expires ${c.expires_at}`);
  }

  out.push("", `  declined, failed or refused (${m.declined.length})`);
  if (!m.declined.length) out.push("    nothing standing");
  for (const d of m.declined) out.push(`    ${d.id}  ${d.why}  x${d.count}`);

  if (m.since != null) {
    out.push("", `  since ${m.since} (${m.since_you_looked.length} event(s))`);
    for (const e of m.since_you_looked)
      out.push(`    ${e.at}  ${e.task}  ${e.op}  ${e.from_phase ?? "-"} -> ${e.to_phase ?? "-"}`);
  }
  return out.join("\n");
}
```

Add the route beside PR-E1's, inside the same `case "task":` block, and add `dash` to the `sub === "list" || ...` condition:

```js
      if (sub === "dash") {
        const models = dashModel(db, {
          now, capabilities: caps, projects: registryProjects(HOME),
          since: opt("since") === null ? null : Number(opt("since")),
        });
        console.log(flag("json") ? JSON.stringify(envelope("task.dash", models), null, 2) : renderDash(models));
        process.exit(EXITS.ok);
      }
```

`--since` is a valued flag and must be added to `FLAGS` in `bin/reeve` in the same commit, or the parser reads its value as a positional. `registryProjects` is the registry read S3-A T2 produces; if it is not exported, pass `[]` and say so in the commit body rather than reaching into `projects.json` here — a second registry reader is a second answer to what the projects are.

Finally, one declaration in `src/build/tables.mjs`: `territory_lease`'s `reader` currently reads `"the overlap check"`, and this task adds the second reader. Change it to `"the overlap check, dash"`. **`test/hub-crosscheck.test.mjs:66` asserts only that the field is a non-empty string, so this edit cannot be caught by a test** — it is bookkeeping that keeps the cross-check honest, and it is called out in the PR body for that reason.

- [ ] **Step 4: Run it, then commit**

```bash
$N test/build-dash.test.mjs     # expect all green
$N test/hub-crosscheck.test.mjs # expect all green: the declaration is still a non-empty string
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
git add src/build/dash.mjs src/build/tables.mjs bin/reeve test/build-dash.test.mjs
git commit -m "feat(build): the digest's five questions, and what is waiting on you"
```

Commit body: record that `waiting_on_you` holds only the two substates a human can clear and why; that `since_you_looked` is empty rather than unbounded when no window is given; and that `territory_lease`'s reader declaration changed with no test able to catch it.

---

### Task 10: PR-E2 close-out — freeze the digest's five questions, tracker, PR

**Files:**
- Modify: `test/build-dash.test.mjs` (append before its closing group), `tasks/reeve-tasks/trackers/s3.md` (**last commit only**)

- [ ] **Step 1: Freeze the five, both halves**

The digest's value is that it is short, and the way a short surface stops being short is one field at a time, each defensible on its own. Freeze **both** the question set and the fact that every task in the digest is a `taskShow` model — a freeze on the keys alone would let the tasks silently become a reduced shape.

Append to `test/build-dash.test.mjs`, **before** its closing group:

```js
// Frozen. A sixth question is a decision, and a decision has a test. The second
// half matters as much: freezing the top-level keys alone would let `tasks`
// quietly become a reduced object, and every assertion here would stay green.
{
  const m = dashModel(db, { now: NOW, capabilities: ALL_ON, projects: PROJECTS });
  const QUESTIONS = ["alive", "declined", "doing", "since_you_looked", "waiting_on_you"];
  const present = Object.keys(m).filter(k => QUESTIONS.includes(k)).sort();
  check(JSON.stringify(present) === JSON.stringify(QUESTIONS),
    "the five questions are exactly these five", present.join(","));

  const direct = taskShow(db, "bt:a", { now: NOW, capabilities: ALL_ON });
  const inDash = m.tasks.find(t => t.id === "bt:a");
  check(JSON.stringify(Object.keys(inDash).sort()) === JSON.stringify(Object.keys(direct).sort()),
    "and every task in the digest is a whole taskShow model, not a reduced one",
    `dash ${Object.keys(inDash).sort().join(",")}\n        show ${Object.keys(direct).sort().join(",")}`);
}
```

Verify the guard guards, **twice — once per half**:

1. Add `"experiments": []` to `dashModel`'s returned object; re-run and expect **`the five questions are exactly these five`** green (it filters) and the `and nothing else` assertion from Task 9 **red** — which is the pair that closes the gap, since a filtered check alone cannot see an addition. Restore by `cp`; re-run green.
2. Change `tasks` to `tasks.map(t => ({ id: t.id, phase: t.phase }))`; re-run and expect **`and every task in the digest is a whole taskShow model`** red and the byte-identical assertions from Task 7 red with it. Restore by `cp`; re-run green.

The second run is the one that matters: it is the half a key-set freeze cannot see.

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

Expected: no `FAILED` lines. 94 files after PR-E1, plus `test/build-dash.test.mjs`.

- [ ] **Step 3: The tracker row, as the LAST commit**

In §1's task table, set T14's `PR` and `STATE` to **BUILT**:

```markdown
| T14 | `reeve dash` for tasks | S3-E | `feat/s3-dash` | T13 | reeve#NN | BUILT | | | |
```

```bash
git add tasks/reeve-tasks/trackers/s3.md
git commit -m "docs(tracker): s3 T14 built"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/s3-dash
gh pr create --title "S3 PR-E2: the builder digest" --body-file - <<'BODY'
## What

`reeve task dash`, a digest rather than a dashboard. Five questions: is it alive,
what is it doing, what is waiting on you and for how long, what happened since
you last looked, and what did it decline, fail or refuse. Territory pins carry
their expiry beside the task, and a CANCELLING task renders the count of rows
still draining.

Age-in-state comes from `phase_event`, never from `task.updated_at`, and the
model says which column it came from.

`src/build/dash.mjs` prepares no statement of its own except the singleton lease
and the since-window: every task fact is a `taskShow` model, so the dash computes
nothing `task show --json` cannot see.

## Decisions taken in this PR

- **There is no HTML.** The design brief's T14 asks that "the HTML and the JSON
  derive from one value"; S3 is headless by decision, and the research this
  follows is CLI/digest-first. The property is unchanged and the test is the
  same: one model, two renderings, compared.
- **`waiting_on_you` holds only the two substates a human can clear.** The other
  four clear themselves, and a list of every waiting task is a list an operator
  scans twice and then stops scanning.
- **`since_you_looked` is empty when no window is given**, not unbounded.
- `territory_lease`'s `reader` declaration in `src/build/tables.mjs` gains the
  dash. The cross-check asserts only that the field is a non-empty string, so
  nothing can catch this if it is wrong — please read it.

## Review focus

- The `HUMAN_WAITS` set. It is two entries and it is the whole value of the
  waiting-on-you line; if `WAITING_FOR_NOTICE` belongs elsewhere, say so.
- `ageInState`'s query filters on `to_phase = task.phase`. Please check that a
  `sizing.decided` event, which carries no `to_phase`, cannot make a stuck task
  read as fresh.
- The freeze in the close-out has two halves and the second one (tasks are whole
  `taskShow` models) is the one a key-set freeze cannot see.
BODY
gh pr comment --body "@codex review"
```

- [ ] **Step 5: Work the gate**

Comment `@codex review` on **every push**. Read **both** endpoints — a clean pass arrives as an issue comment and findings as a review object. Reply to **and resolve** every thread via GraphQL. Apply the taper rule.

**Do not merge.** Founder grant required.

---
<!-- NEXT-CHUNK -->
