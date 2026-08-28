# S3-A: Profile Fields and the Registry, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every profile key S3 reads is declared in the validator, generated into documentation, and read through one module; and a registry entry carries enough for `resolveSnapshot` to produce a complete admission snapshot from local evidence, with a malformed entry an error rather than a dropped row.

**Architecture:** Two PRs against `revnix/reeve` `main`. PR-A1 adds `builder.budgets`, `builder.maxConcurrentTasks`, `builder.budget.maxPackages`, `builder.lease.starvedHours` and `builder.provider.*` to `FIELDS` in `src/profile/schema.mjs`, their defaults to `UNIVERSAL_DEFAULTS`, `builder`/`worker` to `src/init.mjs`'s key order, `src/build/capabilities.mjs` as the single reader of the capability switches, and `scripts/profile-reference.mjs` generating `docs/profile-reference.md`. PR-A2 adds `src/build/registryio.mjs` — the registry loader moved out of `bin/reeve` and the `io` object `resolveSnapshot` takes — and rewires `bin/reeve`, leaving `src/build/registry.mjs` untouched. **S3 is the first stage that dispatches a builder worker. No task in S3 performs any GitHub effect, opens any PR, or enqueues any outbox row of a `gh.*` or `git.push.branch` kind; the switches for those are off and S3 does not change that and must not.** And sharper for this plan: **S3-A itself dispatches nothing, and performs no network call from inside a transaction — every lookup it adds is local, injectable, and runs before any transaction opens.**

**Tech Stack:** Node `~/.nvm/versions/node/v24.17.0/bin/node` (PATH node is v22 and `node:sqlite` warns there), `node:sqlite` `DatabaseSync`, plain-script tests under `test/*.test.mjs` (CI runs every file in that glob on ubuntu-latest under three TZs), no dependencies added.

**Spec:** `docs/2026-08-21-builder-design.md` — §14 S3 (`:826`) is the stage definition and its *Verify:* clause is the definition of done. The sections that bind this plan: §1.4 (capability switches), §1.5 `:69` (the registry, the registry snapshot, and *"Every new profile key … is added to the profile `FIELDS` validator **first**"*), §4.1 `:290` (the per-action budget object), §5 `:335` (the `maxPackages` floor), §10.2 `:558` (`starvedHours`), §10.3 `:562` (`maxConcurrentTasks`), §10.4 `:569-572` (the scheduler knobs and *"Limits are measured before they are chosen"*), §11.6 (documentation generated from the validator).

**This is one of six plans for S3.** The three S2 **plan** PRs — 14 files, all Markdown — produced **561 of the 1,282 findings review has ever raised in this repository, 43.8% of everything**; the decisive one, PR#12, was **one file, +3,994 lines, 213 findings, 15 rounds**, against PR#20's 30 files and 26 findings. A single S3 plan would be 6,000–8,000 lines, which is precisely the artifact measured to be unreviewable, so S3 is six documents carrying **at most three or four plan tasks each**. (The cap's unit is TASKS, not lines — corrected 2026-08-27, `../MASTER-PLAN.md` §B.1.2.)

| plan | scope |
|---|---|
| `2026-08-27-s3a-profile-and-registry.md` | T1 profile `FIELDS` + the capability reader; T2 the registry entry and `resolveSnapshot`'s `io` |
| `2026-08-27-s3b-filing-and-artifacts.md` | T3 `reeve task file`; T4 artifacts and `reviewArtifact`; T5 the phase report schemas |
| `2026-08-27-s3c-dispatch.md` | T6 `phase_run` and revocation; T7 the sandbox/prompt action cases; T8 the tick dispatch; T9 resume |
| `2026-08-27-s3d-phases.md` | T10 SIZING; T11 RESEARCH and `--agents` fan-out; T12 DESIGN |
| `2026-08-27-s3e-operator-surface.md` | T13 `task list\|show\|why`; T14 `dash`; T15 escalations and doctor |
| `2026-08-27-s3f-measurements.md` | T16 the six §14 measurements and the documents that record them |

Their review history — every finding and what each changed — is `s3-review-history.md`. **Order matters:** A lands before B, B before C. **This plan is first; it depends on nothing but its base**, which is issue reeve#50's merge commit (tracker §1, row P2). Its two PRs are ordered A1 then A2.

---

## Global Constraints

- **Node:** always `~/.nvm/versions/node/v24.17.0/bin/node`. Alias it `N` in every shell: `N=~/.nvm/versions/node/v24.17.0/bin/node`. `node` on PATH is v22 and `node:sqlite` emits an ExperimentalWarning there; CI asserts a floor of 24.
- **Tests:** plain scripts, no framework. Use the `check(ok, name, detail)` helper shape every existing test file uses; `console.log("PASS  name")` / `"FAIL  name"`; end with `process.exit(fail ? 1 : 0)`. New files under `test/` are discovered by CI automatically.
- **The four-check stub loop for every fix:** control green, stub verified applied, the RIGHT assertion red, restore verified **by file copy, never `git checkout`** — `git checkout` restores to the last *commit* and has silently discarded uncommitted work in this repository. Every task below names its stub in a **step**, not in this bullet.
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

  The glob must not simply be `test/*.test.mjs`: that includes `escape.test.mjs`, which writes decoys into the shared `~/.reeve/canary/` tree the live daemon reads and probes the login keychain. Run it once on a quiet machine to complete the baseline.
- **The baseline is 93 test files, 0 failures, 5,131 PASS assertions**, excluding `test/escape.test.mjs`, measured on the content of `16cd880` under `REEVE_HOME` pointing at a directory **literally named `.reeve`**, with `~/.nvm/versions/node/v24.17.0/bin/node`. The instrument was controlled before its output was believed: one file (`test/verdict.test.mjs`) reports 72 PASS lines on its own, so the counter counts something; and a deliberately red probe exits 1 and the accumulator sees it, so a red file could not have been silently absorbed. **That is the base every task in this document is measured against, never a chained comparison against the previous task.**
- **"Append to `test/x.test.mjs`" always means "insert before that file's terminator."** Every test file in this repository ends with a cleanup line and `process.exit(fail ? 1 : 0)`. A block pasted after `process.exit` never runs, **and the file still reports green** — the worst available outcome, because it is indistinguishable from a passing test. Each append step below names its terminator explicitly.
- **No raw SQL outside `src/db/` and `src/build/`** — and this constraint is not the comfortable one it looks like. `src/provider.mjs:9-13` states the rule; MEASURED, **12 paths violate it with 98 `.prepare()` calls**, and the only guard that exists (`test/provider-scheduler.test.mjs:851-874`, with a proper positive control) checks **exactly one file**. **Do not add a thirteenth.** Neither PR in this plan executes any SQL: PR-A1 touches no store, and PR-A2's new module reads a JSON file and shells to `git`, delegating every hub read to `resolveRepoIdAt`.
- **Conventional Commits**, lowercase, `type(scope): subject`, ≤72 characters. **No attribution trailer of any kind.** Never `--no-verify`.
- Every change carries a what/why comment in the style of the file it lands in. Comments never reference tasks, plans, findings, or this document.
- No `as any`, no `@ts-expect-error`, no lint suppression.
- **Escalation keys are identities.** No counts, durations, paths, or SHAs in the key. Neither PR here raises one.
- **Rule 15 (§1.7) still binds, and its premise has changed.** `revnix/reeve` was made **PUBLIC** on 2026-08-27 — a deliberate founder decision, taken with the exposure audited and in front of them, to restore Actions minutes exhausted at the org level. So the old form of this constraint (*"this plan touches only `revnix/reeve`, which is private"*) is **false and must not be restated**. What survives is the rule itself, unchanged: **no effect this stage produces against any OTHER repository may name reeve** — not a branch, a commit message, a PR title or body, a check name, a label, or a comment marker. The spec repos S3 provisions must be **private**, and design `:77` refuses to run against a spec repo whose visibility is anything but exactly `private`. Reeve naming itself, inside its own now-public repository, is not a Rule 15 violation; naming reeve in an artifact it sends elsewhere always is.
- **Every timestamp is `INTEGER` seconds from `unixepoch()`** unless the column name ends `_ms`. Never a TEXT date.

### Isolation while this plan is being written or executed

A guardian daemon is live on the founder's host, running from `~/Work/Products/reeve` under launchd since 2026-08-20. Therefore, for anyone executing this plan:

- Work in a worktree (`git worktree add -b <branch> ~/Work/Products/reeve-wt/<name> origin/main`), never in `~/Work/Products/reeve`. A `git pull` there swaps code under a running process.
- Do not run `reeve canary`: it costs a real model call and writes one shared state file at `~/.reeve/canary/<owner>/<repo>.json` that the daemon also reads. Last writer wins.
- Do not restart the daemon, run `launchctl`, or stop the service. `reeve doctor` is read-only and is fine.
- **Never `git stash`.** The stash stack is shared across every worktree on this machine — about nineteen of them — and `lint-staged` pushes to it too, so a `pop` takes a stranger's work in progress.
- `docs/TRACKER.md` and `tasks/reeve-tasks/trackers/s3.md` conflict on every branch. Add the tracker line as the **last commit before opening the PR**, so the conflict is one line.

### What S2 measured, which changes how these tests are written

Do not re-derive any of these.

| Measured fact | Consequence for S3-A |
|---|---|
| `admitTask(db, snapshot, filing, { isAlive = () => true })` (`src/build/registry.mjs:218`) — the default **fails open**: any recorded restore holder reads as alive, which is the conservative direction there, but a caller that omits `isAlive` gets a liveness answer nobody computed | No task here calls `admitTask`. **The rule it establishes binds T2 anyway:** `src/build/loop.mjs:11-18` documents exactly this hazard for the sibling `refreshGateState`, and Task 10 asserts the daemon path passes a real `isAlive` rather than inheriting a default |
| A permission rule takes an absolute path only with **two** leading slashes; `Read(/Users/x/.ssh/**)` matches nothing, silently (`docs/measured/2026-08-22-the-read-deny-list-was-inert.md`) | Any permission rule this plan writes or asserts uses `//`. A rule that matches nothing looks identical to a rule that is working |
| `pull_request.updated_at` does **not** change when a review thread is resolved (`docs/measured/2026-08-22-the-shadow-compared-two-moments.md`) | `updated_at` is not a change signal anywhere. Task 6 derives `registryVersion` from the registry's **content**, never from its mtime, for the same reason |
| A scratch HOME closes the keychain **search list**, not the keychain (`docs/measured/2026-08-22-scratch-home-closes-the-keychain.md`, read its correction banner) | Never argue containment from a scratch HOME in a comment or a commit body here |
| A key present in `FIELDS` and absent from the seed reaches nobody: `commitPattern` is in the validator and appears **zero** times in `src/init.mjs`, so every freshly initialised profile lacked it and the live one had it only by hand (`docs/measured/2026-08-22-refusal-is-one-shape-per-reason.md`) | Task 2 adds the defaults **and** the key order in the same commit as the `FIELDS` entries, and asserts a bare profile reads them |

### Decisions taken by the founder for this stage, 2026-08-27

Recorded so no executor re-litigates them. Items 1–8 are the tracker's §4; items 9–11 are reading hazards this plan inherits.

1. **S3 splits into six plan documents**, each carrying at most three or four plan tasks. *(The original form of this decision capped a document at ~1,200 LINES. That figure was computed against S3's 16 PRs, when a PR decomposes into three to five plan tasks and the house style runs ~500 lines per task; it was corrected to a TASK cap on 2026-08-27 — see `../MASTER-PLAN.md` §B.1.2 and tracker §4.13. The lever is fewer tasks per document, never thinner tasks.)* The three S2 plan PRs produced 561 of 1,282 findings — 43.8% of every finding this repository's review has ever produced. PR#12 was one file, 213 findings, 15 rounds.
2. **S3 is §14 verbatim, including all six measurements.** No obligation is dropped for being expensive; V5 alone is 20 runs, and the comparator for real dispatch cost is $2.66 for three (`docs/measured/2026-08-23-three-real-dispatches.md`).
3. **Issue reeve#50 lands before S3's dispatcher**, and its merge commit is **this plan's base**. #50's acceptance test is *"adding a new call site must not be able to skip a rule"*, and T8 is that call site.
4. **The test suite's dead network is fixed in a standalone PR before T1.** Measured with a control: 550.1s → 159.8s, PASS output byte-identical on the four largest files. Standalone, because it touches guardian files.
5. **`specRepo` and `gateDefinitionPaths` are provisioned now** — brief Q1, Option A. Option B splits `SNAPSHOT_FIELDS` into three lists, and the comment at `src/build/phases.mjs:130-155` records that the list was consolidated *because* it lived inside one branch and admission could not consult it. **This is BLOCKED on the founder naming the repositories** (tracker §2, F1). Tasks 8 and 11 say exactly what is buildable without that answer and what is not.
6. **The builder always shares the guardian's hub.** An absent hub on a builder PR is the merge authority being gone, not an ordinary machine.
7. **S3 stays headless, and `--json` is a contract rather than a courtesy.** Every read surface is `compute → data → render`.
8. **Task numbering restarts at 1 in each plan document.** S2's continuity across a family was a residue of the retired single document. Cross-references are prefixed (`S3-C Task 2`).
9. **Reading hazard C6 — `src/profile/schema.mjs` already carries keys the design never named.** §11.5 `:731` lists the intended `profile/schema.mjs` additions; `worker.isolation` (`:253`, default `"none"`) and `worker.dependencyPaths` (`:258`) exist and the design names neither. **Task 1 edits this exact file.** An executor who treats §11.5 as the inventory of what is there will conclude two live keys are strays and delete them. They are not: the live `nextlyhq/nextly.json` sets `worker.isolation` to `"scratch-home"`.
10. **Reading hazard C7 — `worktree.mjs` and `acquireWorktree` do not exist.** The design says *"Reused untouched: `worktree.mjs`"* (`:731`) and *"via the existing `acquireWorktree`"* (`:443`); `src/checkout.mjs` replaced both, while `src/build/tables.mjs:63` still declares `directory_lease: { writer: "worktree.mjs" }`. T2's neighbours in `src/build/` cite that table. Nothing in this plan may quote either name.
11. **Reading hazard C5 — the design's HOME posture is refused by code.** `:302` says *"**HOME is not isolated, on purpose.** … No API key variable is passed"*; `src/workerenv.mjs:135` throws without a `home`, `:136` throws if `home === homedir()`, and `:140` **requires** an OAuth token, because the keychain was measured readable from inside the sandbox. Carried here because it is a whole-stage hazard; it is S3-C T7's to close.

### Line references in this plan

Every reference to a source file names the **anchor text to search for** first and a line number second, and every number in this document was found by searching its anchor at **`16cd880`** — not copied from the design brief. The brief measured at `c500cfe`, and **PR reeve#49 merged on 2026-08-27 and moved four files** (`src/daemon.mjs`, `src/profile/schema.mjs`, `src/prompts.mjs`, `src/doctor.mjs`); `trackers/s3.md` §7 carries the re-derived values and is authoritative over the brief for those four. Line numbers in `src/daemon.mjs` moved twice during S2-C's own review as well. **A plan that sends an executor to a line number which has since moved is worse than one that sends them to a string: the string is still there.**

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

Each task names any imports it needs **beyond** these. One exception, and it is named rather than assumed: `test/profile-validate.test.mjs` does **not** use this harness. It has no `dir` and no `check`; it is built on `base`, `clone(o)`, `expectOk(name, p)` and `expectRefusal(name, p, matcher)` declared at `test/profile-validate.test.mjs:6-35`, and its terminator is `console.log(...)` / `process.exit(fail ? 1 : 0)` with no `rmSync`. Every append to that file below is written with **its** helpers. An earlier plan in this family's style reference appended a block calling `minimalProfile()` and `check()` to that file; neither exists there, and the correction is recorded in the file's own comment at its tail.

## File structure

| File | Responsibility after this plan |
|---|---|
| `src/profile/schema.mjs` (PR-A1) | `FIELDS` gains `builder.budgets`, `builder.maxConcurrentTasks`, `builder.budget.maxPackages`, `builder.lease.starvedHours` and the four `builder.provider.*` keys; `UNIVERSAL_DEFAULTS` gains their defaults; `validate` gains the reserved-versus-limit cross-field rule and three container names |
| `src/build/capabilities.mjs` (new, PR-A1) | `CAPABILITY_KEYS` derived from `FIELDS`, `capabilitiesFrom(profile)` producing the map `leaseEffect` takes, `capabilityOn(profile, name)`. The only reader of `builder.capabilities.*` |
| `src/init.mjs` (PR-A1) | `ORDER` gains `builder` and `worker`, so a generated profile writes them in a declared position instead of appended tail order |
| `scripts/profile-reference.mjs` (new, PR-A1) | `profileReference()` renders `FIELDS` and the comment above each key into Markdown; run directly it rewrites `docs/profile-reference.md` |
| `docs/profile-reference.md` (new, PR-A1) | the generated reference §11.6 requires. Never hand-edited |
| `test/fixtures/profile-fields-v1.json` (new, PR-A1) | the frozen `FIELDS` key inventory and its count |
| `test/profile-validate.test.mjs` (PR-A1) | the budget, knob, default and generated-reference assertions |
| `test/build-capabilities.test.mjs` (new, PR-A1) | the capability reader, asserted against the key strings `leaseEffect` actually emits |
| `src/build/registryio.mjs` (new, PR-A2) | `parseRegistry(text, path)`, `loadRegistry(home)`, `registryIo({...})`. Every filesystem, git and hub touch the registry path needs |
| `bin/reeve` (PR-A2) | the local `registryProjects` deleted; `loadRegistry` imported and used by the three routes that read the registry |
| `src/build/registry.mjs` (PR-A2) | **unchanged.** See Task 6 for why |
| `src/build/loop.mjs` (PR-A2) | unchanged in code; Task 10 proves `buildTick` refreshes from the loader's real rows |
| `test/hub-registry.test.mjs` (PR-A2) | the end-to-end `resolveSnapshot` block gains the missing-field control |
| `test/registry-io.test.mjs` (new, PR-A2) | the loader, the derived version, the io, and the no-write proof |
| `test/hub-gatestate.test.mjs` (PR-A2) | the two source-text guards over `bin/reeve` re-pointed at the imported loader |
| `test/hub-doctor.test.mjs` (PR-A2) | the H-7 fixtures given the two new required entry fields |

## The S3 Verify table

§14's clause for S3, verbatim (`docs/2026-08-21-builder-design.md:826`):

> *Verify:* one real scout task through to artifacts; **measure** real phase budgets, alias-to-model resolution, sandbox behaviour under fan-out, `--json-schema` reliability across 20 runs, and the headless-versus-interactive subscription pool (§10.4), each recorded in the profile or the tracker with dates.

The table lives here because this is the **first** document of the family, and `2026-08-27-s3f-measurements.md` **re-walks it last** (MASTER-PLAN §B.7.2). The defect that rule closes is measured: S2's table exists only at `2026-08-23-s2b-phase-machine.md:4365`, so a reader of S2-A alone could not find the stage's acceptance criteria at all.

**A deficit this document carries, stated plainly rather than filled with a number I cannot verify.** §B.7.2's cell shape is `Task N, <test file>, <named assertion>`, and no cell below can name an `N`: task numbering restarts per document (decision 8) and S3-C, S3-D and S3-F are not yet written, so any number here would be invented and would be wrong the moment those documents number their own tasks. Each cell therefore names the **plan document** and the **T-id from `S3-DESIGN-BRIEF.md` §2.2 and `trackers/s3.md` §1**, which is stable across that renumbering, plus the artifact `trackers/s3.md` §3 already commits each row to. **S3-F's re-walk replaces every cell with `Task N, <file>, <assertion>`, and the stage does not close until it has.** No row here is satisfied by a test name: §B.7.3 requires a file that exists and is green.

| Verify item | Where it is proven |
|---|---|
| V1 — one real scout task through to artifacts: FILED → SIZING → RESEARCH → DESIGN stopping at SPEC_DRAFT, three artifacts on disk, three shas in `phase_event`, three `phase_run` rows carrying contract snapshots, and **zero** GitHub effects | `2026-08-27-s3f-measurements.md`, T16; a `docs/measured/` document slugged `scout-task-end-to-end` plus the end-to-end test that S3-F names |
| V2 — **measure** real phase budgets: wall-clock, turns and USD per phase against the §4.1 guesses (8 / 20-60 / 20-60 min), written into `builder.budgets.*` or the tracker, with dates | `2026-08-27-s3f-measurements.md`, T16; slug `phase-budgets`. **The keys it writes into are declared by Task 1 of this document** |
| V3 — **measure** alias-to-model resolution: the resolved id for `fable` and for `sonnet`, read from a real `phase_run.model_id`, with the CLI version beside it | unit half `2026-08-27-s3c-dispatch.md`, T6; measured half `2026-08-27-s3f-measurements.md`, T16; slug `alias-to-model-resolution` |
| V4 — **measure** sandbox behaviour under fan-out: a RESEARCH worker at maximum subagent width with the canary's write and network probes, run **from inside a subagent** | unit half `2026-08-27-s3d-phases.md`, T11; measured half `2026-08-27-s3f-measurements.md`, T16; slug `sandbox-under-fanout` |
| V5 — **measure** `--json-schema` reliability across **20 runs** on the real phase schemas, reporting the count of malformed or missing structured outputs and what each looked like | `2026-08-27-s3f-measurements.md`, T16; slug `json-schema-reliability` |
| V6 — **measure** the headless-versus-interactive subscription pool (§10.4), guardian live **and** guardian idle, written to `provider_state` with `measured_at` | `2026-08-27-s3f-measurements.md`, T16; slug `subscription-pool`. **The profile keys that record the answer — `builder.provider.concurrencyLimit` and `guardianReserved` — are declared by Task 2 of this document** |

Every one of the six documents carries its own `## What this does NOT establish` section (MASTER-PLAN §B.13). **Neither PR in S3-A satisfies a Verify row**, and that is the correct state for the stage's first two PRs: they exist so the keys the measurements write into, and the snapshot a real task is admitted from, are declared before anything reads them.

---

# PR-A1: The builder's profile keys, and the one reader of the switches

**Branch:** `feat/s3-fields`. **Base:** issue reeve#50's merge commit on `main`. **Scope:** every profile key S3 reads, added to the validator **first** (`:69`, `:810`), with its default, its position in the generated profile, generated documentation, and a single module through which the capability switches are read. **Nothing in PR-A1 opens a database, executes SQL, spawns a process, or reads the network.**

---

### Task 1: The validator refuses a budget with zero attempts, and an action that has no phase

**Files:**
- Modify: `src/profile/schema.mjs` (the `BUDGETS` validator and one `FIELDS` entry; insert after the block ending `"builder.cancel.drainMinutes"`, at `:244`)
- Test: `test/profile-validate.test.mjs` (append before the terminator — the final `console.log(fail ? ... )` / `process.exit(fail ? 1 : 0)` pair; this file has **no** `rmSync`)

**Interfaces:**
- Consumes: `FIELDS`, `validate`, `withDefaults` from `src/profile/schema.mjs` (`export const FIELDS = {` at `:171`, `export function validate(profile) {` at `:347`).
- Produces: `FIELDS["builder.budgets"] -> [false, BUDGETS]` — one key holding `{<ACTION>: {budgetMinutes, maxTurns, model, effort, maxBudgetUsd, maxAttempts}}` for `BUILD_SIZE`, `BUILD_RESEARCH` and `BUILD_DESIGN`. S3-C's dispatcher reads it; S3-F's V2 measurement writes into it.

**Why one key and not eighteen.** `validate`'s unknown-key sweep accepts any leaf under a declared key: `for (const p of flatten(profile))` skips `p` when `[...known].some(k => p.startsWith(k + "."))` (`src/profile/schema.mjs:377`). So declaring `builder.budgets.BUILD_SIZE.budgetMinutes` and its siblings would make `builder.budgets.BUILD_NOPE.budgetMinutes` a leaf under a known prefix and wave it through. **The action names and the field names are refused inside this validator or they are not refused at all.**

- [ ] **Step 1: Append the failing test**

Append to `test/profile-validate.test.mjs`, before its terminator, using that file's own helpers:

```js
// ── builder.budgets ──────────────────────────────────────────────────────────
const withBudget = (b) => { const p = clone(base); p.builder = { budgets: b }; return p; };
expectOk("a per-action budget for every phase action",
  withBudget({ BUILD_SIZE:     { budgetMinutes: 8,  maxTurns: 15, model: "sonnet", effort: "low" },
               BUILD_RESEARCH: { budgetMinutes: 60, maxTurns: 60, model: "fable", effort: "high",
                                 maxBudgetUsd: 4.5, maxAttempts: 3 },
               BUILD_DESIGN:   { budgetMinutes: 60, maxTurns: 60 } }));
expectRefusal("a budget for an action that has no phase",
  withBudget({ BUILD_NOPE: { budgetMinutes: 8 } }), /BUILD_NOPE is not one of/);
expectRefusal("zero attempts, which is an off switch nobody chose",
  withBudget({ BUILD_SIZE: { maxAttempts: 0 } }), /BUILD_SIZE\.maxAttempts must be a positive integer/);
expectRefusal("zero budget minutes, which kills the worker at spawn",
  withBudget({ BUILD_SIZE: { budgetMinutes: 0 } }), /BUILD_SIZE\.budgetMinutes must be a positive integer/);
expectRefusal("a field that is not a budget field",
  withBudget({ BUILD_SIZE: { budgetMinutes: 8, retries: 2 } }), /BUILD_SIZE\.retries is not a budget field/);
expectRefusal("a budget that is not an object at all", withBudget("everything"), /builder\.budgets must be an object/);
// The singular and the plural differ by ONE letter and mean different things:
// `builder.budget.maxPackages` is section 5's slicing floor, `builder.budgets`
// is section 4.1's per-action knobs. Each must refuse the other's shape, or a
// typo lands in whichever key happens to accept it and configures nothing.
expectRefusal("the plural key holding the singular key's field",
  withBudget({ maxPackages: 2 }), /maxPackages is not one of/);
// CONTROL: the same fixture with NO builder key still validates, so every
// refusal above is about the budget and not about the base profile.
expectOk("control: the same profile with no builder.budgets", clone(base));
```

- [ ] **Step 2: Run it red**

```bash
$N test/profile-validate.test.mjs
```

Expected: `accepts: a per-action budget for every phase action` fails with `unexpected error: unknown key: builder.budgets.BUILD_SIZE.budgetMinutes`, and every `refuses:` line above fails printing `(none — it PASSED)` — because `builder` is an undeclared container today.

**On the broken implementation** — the shape this task exists to refuse is `builder.budgets` declared as a plain `isObj`, or as eighteen dotted leaf keys. Against `isObj`: `a budget for an action that has no phase`, `zero attempts`, `zero budget minutes`, `a field that is not a budget field` and `the plural key holding the singular key's field` all go red, while `a per-action budget for every phase action`, `a budget that is not an object at all` and the control stay green — so a validator that only checks the outer type is visible as exactly five failures, not as a general failure. Against the eighteen-leaf shape, only `a budget for an action that has no phase` and `a field that is not a budget field` go red, and they are the two the prefix sweep cannot see; everything else passes, which is what makes that the tempting wrong answer.

**The stub loop for this task**, run after Step 3: (1) control — full file green; (2) stub applied and verified — replace the body of `BUDGETS` with `return null;` and confirm the file on disk contains that line (`grep -n "return null;" src/profile/schema.mjs`); (3) the RIGHT assertions red — exactly the five `refuses:` lines above, with `accepts:` and the control still green; (4) restore verified **by file copy**: `cp /tmp/schema.mjs.bak src/profile/schema.mjs` from a copy taken before the stub, then re-run and confirm green. Never `git checkout` here — Task 2 edits the same file and an uncommitted edit would be destroyed.

- [ ] **Step 3: Add the validator and the key**

Insert into `src/profile/schema.mjs` above `export const FIELDS = {` (`:171`):

```js
// The three phase actions a builder budget may be written for. Section 4.1's
// table is the source: SIZING, RESEARCH and DESIGN are what S3 dispatches, and a
// budget for an action nothing dispatches configures nothing while looking like
// configuration.
const BUILD_ACTIONS = Object.freeze(["BUILD_SIZE", "BUILD_RESEARCH", "BUILD_DESIGN"]);
// Six fields, and the kind of value each takes. Restated nowhere else: the
// generated reference renders this object rather than a second description.
const BUDGET_FIELDS = Object.freeze({
  budgetMinutes: "positive-int", maxTurns: "positive-int", maxAttempts: "positive-int",
  maxBudgetUsd: "positive-number", model: "name", effort: "name",
});
// ONE key, not eighteen. The unknown-key sweep accepts any leaf under a declared
// key, so `builder.budgets.BUILD_NOPE.budgetMinutes` would be a leaf under a
// known prefix and would validate. The action names and the field names are
// refused here or they are not refused anywhere.
const BUDGETS = v => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "must be an object";
  for (const [action, budget] of Object.entries(v)) {
    if (!BUILD_ACTIONS.includes(action))
      return `${action} is not one of ${BUILD_ACTIONS.join(", ")}`;
    if (typeof budget !== "object" || budget === null || Array.isArray(budget))
      return `${action} must be an object`;
    for (const [k, val] of Object.entries(budget)) {
      const kind = BUDGET_FIELDS[k];
      if (!kind) return `${action}.${k} is not a budget field`;
      // ZERO IS NOT A BUDGET. `maxAttempts: 0` dispatches nothing and reports
      // nothing; `budgetMinutes: 0` kills the worker at spawn. Both read as
      // configuration and behave as an off switch the founder never chose.
      if (kind === "positive-int" && !(Number.isInteger(val) && val > 0))
        return `${action}.${k} must be a positive integer`;
      if (kind === "positive-number" && !(typeof val === "number" && Number.isFinite(val) && val > 0))
        return `${action}.${k} must be a positive number`;
      // The CLI owns the model and effort vocabularies and resolves an alias at
      // dispatch. A closed list here would be a second copy of a vocabulary this
      // file cannot check, and would refuse a valid profile the day the CLI adds
      // to it -- while the alias-to-model answer is something this stage MEASURES
      // rather than enumerates. So the rule is the shape of a name.
      if (kind === "name" && !(typeof val === "string" && /^[A-Za-z0-9._-]+$/.test(val)))
        return `${action}.${k} must be a bare name`;
    }
  }
  return null;
};
```

and add to `FIELDS`, immediately after the `"builder.cancel.drainMinutes"` entry (`:244`):

```js
  // Per-action worker knobs, section 4.1. Absent means the code defaults apply;
  // a partial object means only the fields it names are overridden.
  "builder.budgets":                     [false, BUDGETS],
```

- [ ] **Step 4: Run it green, run the stub loop, then commit**

```bash
cp src/profile/schema.mjs /tmp/schema.mjs.bak
$N test/profile-validate.test.mjs      # expect all green
# ... run the four-check stub loop from Step 2 here, restoring by `cp` ...
$N test/profile-validate.test.mjs      # expect all green again after the restore
git add src/profile/schema.mjs test/profile-validate.test.mjs
git commit -m "feat(profile): per-action builder budgets in FIELDS"
```

---

### Task 2: A bare profile reads every scheduling default, and a reservation that swallows the limit is refused

**Files:**
- Modify: `src/profile/schema.mjs` (`FIELDS`; `UNIVERSAL_DEFAULTS` at `:444`; the container list inside `validate` at `:367`; the cross-field section after the `rounds.hardCap` rule)
- Modify: `src/init.mjs` (`const ORDER = [` at `:40`)
- Test: `test/profile-validate.test.mjs` (append before the terminator)

**Interfaces:**
- Consumes: `withDefaults` (`src/profile/schema.mjs:457`), `UNIVERSAL_DEFAULTS` (`:444`), `canonical` (`src/init.mjs:42`), all of Task 1.
- Produces: `builder.maxConcurrentTasks` (default 2), `builder.budget.maxPackages` (default 2), `builder.lease.starvedHours` (default 24), `builder.provider.concurrencyLimit` (2), `.guardianReserved` (1), `.cooldownSeconds` (300), `.preemptAtBoundary` (true). S3-C's tick reads the concurrency keys; S3-F's V6 writes the two pool keys with a measurement date.

**Why the defaults and the key order land in this commit and not a later one.** `docs/measured/2026-08-22-refusal-is-one-shape-per-reason.md` records `commitPattern` present in `FIELDS` and appearing **zero** times in `src/init.mjs`: the seed never set it, every freshly initialised profile gave the reviewer no way to bind a clean pass to a revision, and the live profile had it only because somebody added it by hand. A declared key with no default and no position is a key that reaches one machine.

- [ ] **Step 1: Append the failing test**

```js
// ── the scheduling knobs, and their defaults ─────────────────────────────────
const withBuilder = (b) => { const p = clone(base); p.builder = b; return p; };
expectOk("the four scheduler knobs, the concurrency cap, the package floor and the starve window",
  withBuilder({ maxConcurrentTasks: 3, budget: { maxPackages: 4 }, lease: { starvedHours: 12 },
                provider: { concurrencyLimit: 4, guardianReserved: 0, cooldownSeconds: 30,
                            preemptAtBoundary: false } }));
expectRefusal("zero concurrent tasks", withBuilder({ maxConcurrentTasks: 0 }),
  /builder\.maxConcurrentTasks must be a positive integer/);
expectRefusal("a negative reservation", withBuilder({ provider: { guardianReserved: -1 } }),
  /builder\.provider\.guardianReserved must be a non-negative integer/);
expectRefusal("a truthy string where a boolean switch belongs",
  withBuilder({ provider: { preemptAtBoundary: "true" } }), /builder\.provider\.preemptAtBoundary/);
// Section 10.4's admission rule admits a builder request only when held leases
// are below `concurrencyLimit` MINUS `guardianReserved`. Reserving the whole
// pool is therefore a silent, permanent off switch for the builder that reads as
// a tuning choice -- so it is refused where it can still be explained.
expectRefusal("a reservation that leaves the builder no slot at all",
  withBuilder({ provider: { concurrencyLimit: 2, guardianReserved: 2 } }),
  /guardianReserved \(2\) must be less than builder\.provider\.concurrencyLimit \(2\)/);
expectOk("control: a reservation that leaves exactly one slot",
  withBuilder({ provider: { concurrencyLimit: 2, guardianReserved: 1 } }));
// The container guard: an array or a string here would take the defaults as
// named properties, validate, and serialize to nothing.
expectRefusal("builder.provider as an array", withBuilder({ provider: [] }),
  /builder\.provider must be an object/);

// ── the defaults reach a profile that sets none of them ──────────────────────
{
  const d = withDefaults(clone(base));
  for (const [path, want] of [["maxConcurrentTasks", 2], ["budget.maxPackages", 2],
                              ["lease.starvedHours", 24], ["provider.concurrencyLimit", 2],
                              ["provider.guardianReserved", 1], ["provider.cooldownSeconds", 300],
                              ["provider.preemptAtBoundary", true]]) {
    const got = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), d.builder);
    console.log(`${got === want ? "PASS" : "FAIL"}  defaults: builder.${path} is ${want}`);
    if (got !== want) { console.log(`        got ${JSON.stringify(got)}`); fail++; }
  }
  // CONTROL: an explicit value is NEVER overridden by the default.
  const explicit = withDefaults(withBuilder({ maxConcurrentTasks: 7 }));
  console.log(`${explicit.builder.maxConcurrentTasks === 7 ? "PASS" : "FAIL"}  defaults: an explicit value wins`);
  if (explicit.builder.maxConcurrentTasks !== 7) fail++;
  // And the defaulted profile is itself valid, or the defaults have invented a
  // profile the validator would refuse.
  expectOk("control: the defaulted profile validates", clone(base));
}

// ── the generated profile writes builder and worker in a declared position ───
{
  const { canonical } = await import("../src/init.mjs");
  const order = Object.keys(canonical(withDefaults(withBuilder({ maxConcurrentTasks: 2 }))));
  const declared = order.indexOf("builder") >= 0 && order.indexOf("worker") >= 0 &&
                   order.indexOf("builder") < order.indexOf("watch");
  console.log(`${declared ? "PASS" : "FAIL"}  init: builder and worker have a declared position`);
  if (!declared) { console.log("        order was: " + order.join(",")); fail++; }
}
```

- [ ] **Step 2: Run it red**

```bash
$N test/profile-validate.test.mjs
```

Expected: the `accepts:` line fails with `unknown key: builder.maxConcurrentTasks` (and six siblings), every `defaults:` line fails with `got undefined`, and `init: builder and worker have a declared position` fails because `ORDER` names neither.

**On the broken implementation** — the wrong answer here is adding the seven `FIELDS` entries and stopping, which is exactly the `commitPattern` shape. Then every `refuses:` and the `accepts:` line go green while all seven `defaults:` lines and `init: builder and worker have a declared position` stay red — eight failures that name the missing half precisely. The second wrong answer is adding the defaults without the cross-field rule: everything goes green except `a reservation that leaves the builder no slot at all`, with `control: a reservation that leaves exactly one slot` still green, so the pair distinguishes "the rule is missing" from "the rule refuses everything".

**The stub loop for this task**: (1) control — full file green; (2) stub applied and verified — delete the seven lines from `UNIVERSAL_DEFAULTS` and confirm with `grep -c "builder.provider" src/profile/schema.mjs`, which must drop by four; (3) the RIGHT assertions red — the seven `defaults:` lines only, with every `refuses:` still green because `FIELDS` is untouched; (4) restore by `cp` from the backup taken at the start of the step, then re-run green.

- [ ] **Step 3: Add the keys, the defaults, the containers, the cross-field rule and the order**

In `src/profile/schema.mjs`, above `FIELDS`:

```js
const POSITIVE_INT     = v => (Number.isInteger(v) && v > 0 ? null : "must be a positive integer");
const NON_NEGATIVE_INT = v => (Number.isInteger(v) && v >= 0 ? null : "must be a non-negative integer");
```

Into `FIELDS`, after `"builder.budgets"`:

```js
  // How many builder tasks may hold a worker at once (section 10.3). One worker
  // per task is a separate, non-configurable rule.
  "builder.maxConcurrentTasks":          [false, POSITIVE_INT],
  // Section 5's deterministic floor: territory spanning more packages than this
  // forces `standard` depth and at least two slices. Singular `budget`; the
  // plural `builder.budgets` is section 4.1's per-action knobs.
  "builder.budget.maxPackages":          [false, POSITIVE_INT],
  // Section 10.2: how long one task's territory lease may go on producing skips
  // before `bt:<id>:lease:starved` fires on the HOLDING task.
  "builder.lease.starvedHours":          [false, POSITIVE_INT],
  // Section 10.4's scheduler. Whether headless and interactive usage draw from
  // one pool is account-specific and is MEASURED before it is chosen; the
  // defaults below are the design's stated interim values and carry no
  // measurement date until a real run writes one.
  "builder.provider.concurrencyLimit":   [false, POSITIVE_INT],
  // Zero is legal: it means the guardian takes its chances with the builder.
  "builder.provider.guardianReserved":   [false, NON_NEGATIVE_INT],
  "builder.provider.cooldownSeconds":    [false, POSITIVE_INT],
  "builder.provider.preemptAtBoundary":  [false, isBool],
```

Into the container list inside `validate` (`:367`), which today reads `["builder", "builder.capabilities", "builder.cancel", "builder.founder", "builder.network", "builder.network.research", "worker"]`, add `"builder.budget"`, `"builder.lease"` and `"builder.provider"`. `builder.budgets` is **not** added: it is a `FIELDS` key with its own validator, which already answers `must be an object`.

Into the cross-field section of `validate`, after the `rounds.hardCap` rule:

```js
  // A reservation at or above the limit admits no builder request, ever: the
  // admission rule is "held leases below limit MINUS reserved". That is a
  // permanent off switch wearing the clothes of a tuning knob, and the only
  // place it can still be explained to the operator is here.
  const limit = get(profile, "builder.provider.concurrencyLimit");
  const reserved = get(profile, "builder.provider.guardianReserved");
  if (Number.isInteger(limit) && Number.isInteger(reserved) && reserved >= limit)
    errors.push(`builder.provider.guardianReserved (${reserved}) must be less than ` +
                `builder.provider.concurrencyLimit (${limit}), or no builder request is ever admitted`);
```

Into `UNIVERSAL_DEFAULTS` (`:444`), beside the capability switches:

```js
  "builder.maxConcurrentTasks": 2,
  "builder.budget.maxPackages": 2,
  "builder.lease.starvedHours": 24,
  // Interim, from section 10.4: limit 2, reserved 1, until a measurement replaces
  // them with a dated pair.
  "builder.provider.concurrencyLimit": 2,
  "builder.provider.guardianReserved": 1,
  "builder.provider.cooldownSeconds": 300,
  "builder.provider.preemptAtBoundary": true,
```

And in `src/init.mjs`, `ORDER` at `:40` becomes:

```js
const ORDER = ["schemaVersion", "project", "identity", "authority", "state", "units",
               "lanes", "ci", "merge", "reviewers", "rounds", "risk", "tools",
               "builder", "worker", "watch"];
```

- [ ] **Step 4: Run it green, run the stub loop, then commit**

```bash
cp src/profile/schema.mjs /tmp/schema.mjs.bak
$N test/profile-validate.test.mjs      # expect all green
$N test/checkout-root.test.mjs         # also calls withDefaults; expect all green
$N test/reviewer-status.test.mjs       # asserts the existing defaults; expect all green
# ... run the four-check stub loop from Step 2, restoring by `cp` ...
git add src/profile/schema.mjs src/init.mjs test/profile-validate.test.mjs
git commit -m "feat(profile): builder scheduling knobs, with defaults and order"
```

---

### Task 3: The capability reader emits the same key strings the outbox gates on

**Files:**
- Create: `src/build/capabilities.mjs`, `test/build-capabilities.test.mjs`
- Test: `test/build-capabilities.test.mjs` (new; opens with `/* ... standard harness ... */`, slug `caps`)

**Interfaces:**
- Consumes: `FIELDS` (`src/profile/schema.mjs:171`); `openHub`, `hubTx` (`src/build/hubdb.mjs`); `enqueueEffect`, `leaseEffect` (`src/build/outbox.mjs:246`, `:329`).
- Produces: `CAPABILITY_KEYS -> readonly string[]`, `capabilitiesFrom(profile) -> Readonly<Record<string, boolean>>` — the exact map `leaseEffect`'s `capabilities` option expects — and `capabilityOn(profile, name) -> boolean`, which throws on a name the profile does not declare. S3-C's dispatcher gates `observe` through `capabilityOn`; the outbox drainer builds its map with `capabilitiesFrom`.

**The second-inventory rule, and how this task obeys it.** `test/hub-outbox.test.mjs:29-35` builds its `allOn` map by writing the five key strings out by hand, and every future call site would do the same; a typo in one of them reads as "off", which is fail-closed and therefore invisible. So `CAPABILITY_KEYS` is **derived from `FIELDS`** rather than listed, and the test asserts the key set **by importing both sides** — `CAPABILITY_KEYS` from this module, and the strings `leaseEffect` actually emits, recovered from the `last_error` it writes at `src/build/outbox.mjs:418` (`` `${cap} is not set; every builder capability defaults to off` ``). A test that compared this module against a list retyped in the test would be a third inventory.

`capabilityFor` (`src/build/outbox.mjs:306`) is module-private and stays private: this task adds no export to `outbox.mjs`, so the outbox is unmodified by PR-A1.

- [ ] **Step 1: Write the failing test**

`test/build-capabilities.test.mjs`:

```js
// The capability switches have exactly one reader, and the key set it produces
// is asserted against the strings the OUTBOX emits -- not against a list retyped
// here, which would be a second inventory of the same five names and would agree
// with itself while disagreeing with the code.
/* ... standard harness ... */   // slug "caps"
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { enqueueEffect, leaseEffect } from "../src/build/outbox.mjs";
import { CAPABILITY_KEYS, capabilitiesFrom, capabilityOn } from "../src/build/capabilities.mjs";
import { FIELDS } from "../src/profile/schema.mjs";

const NOW = 1_800_000_000;

// A task and the phase_event rows its fences reference: `outbox.fence` is
// NOT NULL REFERENCES phase_event(seq), so an enqueue with nothing to point at
// fails on the foreign key rather than on anything this file is about.
const seed = (db, id) => {
  db.prepare(
    `INSERT INTO task(id, project, repo_id, nwo_snapshot, title, phase, generation,
                      source_kind, source_key, repo_path, profile_path, profile_hash,
                      default_branch, visibility, registry_version, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())`)
    .run(id, "p", 1, "o/r", "t", "SPEC_DRAFT", 1, "founder", `k:${id}`,
         "/repo", "/profile.json", "hash", "main", "private", 1);
  for (let i = 0; i < 12; i++)
    db.prepare(
      `INSERT INTO phase_event(task, at, op, from_phase, to_phase, from_generation, to_generation, detail)
       VALUES(?, unixepoch(), 'phase.advanced', 'SPEC_DRAFT', 'SPEC_DRAFT', 1, 1, '{}')`).run(id);
};

check(CAPABILITY_KEYS.length === 5 && CAPABILITY_KEYS.every(k => k in FIELDS),
  "every capability key is one the validator declares", JSON.stringify(CAPABILITY_KEYS));
check(CAPABILITY_KEYS.length ===
      Object.keys(FIELDS).filter(k => k.startsWith("builder.capabilities.")).length,
  "control: and there are exactly as many as FIELDS declares, so none was dropped",
  `${CAPABILITY_KEYS.length} vs ${Object.keys(FIELDS).filter(k => k.startsWith("builder.capabilities.")).length}`);

// FAIL CLOSED. Absent, null and the string "true" are all off -- `leaseEffect`
// requires `=== true`, and a reader that coerced would hand it a truthy value
// the validator itself never accepted.
{
  const off = capabilitiesFrom({});
  check(CAPABILITY_KEYS.every(k => off[k] === false), "an empty profile reads every switch as false");
  const coerced = capabilitiesFrom({ builder: { capabilities: { observe: "true", publishPr: 1 } } });
  check(coerced["builder.capabilities.observe"] === false &&
        coerced["builder.capabilities.publishPr"] === false,
    "and a truthy non-boolean is still off", JSON.stringify(coerced));
  const on = capabilitiesFrom({ builder: { capabilities: { observe: true } } });
  check(on["builder.capabilities.observe"] === true, "control: a real true reads as true");
  let threw = false;
  try { capabilityOn({}, "teleport"); } catch { threw = true; }
  check(threw, "capabilityOn refuses a switch the profile does not declare");
  check(capabilityOn({ builder: { capabilities: { observe: true } } }, "observe") === true,
    "control: and answers one it does");
}

// ── the key strings, recovered from the outbox rather than restated ──────────
{
  const db = openHub(join(dir, "caps.db")); seed(db, "bt:c");
  const rows = [["git.push.branch", {}], ["gh.pr.create", {}], ["gh.pr.comment", {}],
                ["gh.pr.close", {}], ["gh.pr.body", {}], ["gh.review.request", {}],
                ["gh.pr.merge", {}], ["gh.pr.create", { repo: "spec" }],
                // LAST, and never gated: it is the control that proves the lease
                // reached the end of the queue rather than stopping early.
                ["notify", {}]];
  rows.forEach(([kind, args], i) => hubTx(db, () => enqueueEffect(db, {
    idempotencyKey: `bt:c:g1:cap:${i}`, kind, taskId: "bt:c", generation: 1, fence: 1, args })));

  const leased = leaseEffect(db, { worker: "w", capabilities: capabilitiesFrom({}), now: NOW });
  check(leased?.kind === "notify",
    "with every switch off the only effect leased is the never-gated one", JSON.stringify(leased));
  const emitted = new Set(db.prepare("SELECT last_error FROM outbox WHERE status='refused'")
    .all().map(r => String(r.last_error).split(" ")[0]));
  check(emitted.size >= 3 && [...emitted].every(k => CAPABILITY_KEYS.includes(k)),
    "every key the outbox names when it refuses is one this module reports",
    JSON.stringify([...emitted]));
  for (const k of ["builder.capabilities.publishPr", "builder.capabilities.draftSpec",
                   "builder.capabilities.mergeBuilderPr"])
    check(emitted.has(k), `and ${k} is one of them`, JSON.stringify([...emitted]));
  db.close();
}

/* ... standard harness terminator ... */
```

- [ ] **Step 2: Run it red**

```bash
$N test/build-capabilities.test.mjs
```

Expected: `Cannot find module` for `../src/build/capabilities.mjs`, before any assertion runs.

**On the broken implementation** — the shape being guarded against is a `CAPABILITY_KEYS` written out by hand, which passes every assertion in this file today and diverges silently the first time a sixth switch is added to `FIELDS`. The assertion that catches it is `control: and there are exactly as many as FIELDS declares`, which goes red on a hand-written list the moment `FIELDS` grows and stays green on a derived one. The second shape is a `capabilitiesFrom` that coerces: `and a truthy non-boolean is still off` goes red while `control: a real true reads as true` stays green, so a coercing reader is one failure and not two.

**The stub loop for this task**: (1) control — the file green; (2) stub applied and verified — change `read(profile, key) === true` to `!!read(profile, key)` and confirm with `grep -n '!!read' src/build/capabilities.mjs`; (3) the RIGHT assertion red — `and a truthy non-boolean is still off`, alone, with the outbox block still green because that block passes an empty profile; (4) restore by `cp` from the backup, re-run green.

- [ ] **Step 3: Write the module**

`src/build/capabilities.mjs`:

```js
// capabilities -- the one reader of `builder.capabilities.*`.
//
// The switches are five booleans in the profile, and the outbox gates on their
// FULL KEY STRINGS: `leaseEffect`'s `capabilities` map is keyed by them, and it
// requires `=== true`, so an absent or misspelt key reads as off. That is
// fail-closed and therefore invisible, which is why every call site building the
// map by hand was a defect waiting on a typo.
//
// THE KEY LIST IS DERIVED FROM `FIELDS`, never restated. A capability added to
// the validator and forgotten here would be a switch the outbox can name and
// this module could never report.
import { FIELDS } from "../profile/schema.mjs";

export const CAPABILITY_PREFIX = "builder.capabilities.";

export const CAPABILITY_KEYS = Object.freeze(
  Object.keys(FIELDS).filter(k => k.startsWith(CAPABILITY_PREFIX)));

const read = (profile, path) =>
  path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), profile);

/**
 * The capability map `leaseEffect` takes, keyed by full profile path.
 *
 * FAIL CLOSED ON ANYTHING THAT IS NOT `true`. Absent, null, 1 and "true" are all
 * off. The validator refuses a non-boolean, so a coercing reader here would
 * authorise a value the profile could never legally carry -- and the value it
 * would authorise is a real push, pull request or merge.
 */
export function capabilitiesFrom(profile) {
  const out = {};
  for (const key of CAPABILITY_KEYS) out[key] = read(profile, key) === true;
  return Object.freeze(out);
}

/**
 * One switch, by its bare name (`observe`), for a caller gating a transition.
 *
 * It THROWS on a name the profile does not declare rather than answering false.
 * A misspelt capability answered `false` is a transition that never happens and
 * never explains why, which is the same silence the map above exists to remove.
 */
export function capabilityOn(profile, name) {
  const key = CAPABILITY_PREFIX + name;
  if (!CAPABILITY_KEYS.includes(key))
    throw new Error(`${key} is not a capability the profile declares`);
  return capabilitiesFrom(profile)[key];
}
```

- [ ] **Step 4: Run it green, run the stub loop, then commit**

```bash
cp src/build/capabilities.mjs /tmp/capabilities.mjs.bak
$N test/build-capabilities.test.mjs    # expect all green
$N test/hub-outbox.test.mjs            # unchanged; expect all green
# ... run the four-check stub loop from Step 2, restoring by `cp` ...
git add src/build/capabilities.mjs test/build-capabilities.test.mjs
git commit -m "feat(build): one reader for the capability switches"
```

---

### Task 4: The profile reference regenerates identically, so the documentation cannot drift

**Files:**
- Create: `scripts/profile-reference.mjs`, `docs/profile-reference.md`
- Test: `test/profile-validate.test.mjs` (append before the terminator)

**Interfaces:**
- Consumes: `FIELDS` (`src/profile/schema.mjs:171`); the source text of `src/profile/schema.mjs` itself.
- Produces: `profileReference(source?) -> string` — the whole reference as Markdown; and `noteFor(source, key) -> string` — the `//` comment block immediately above a key, joined into one paragraph. Run as a script it writes `docs/profile-reference.md`.

**Why the prose is read out of the source and not passed in.** §11.6 requires documentation generated from the validator *"so configuration docs and code cannot drift"*. A generator that took a description per key would put the prose in a third place — the validator, the generator, and the reader's memory — and the copy that goes stale is the one a reader trusts. The comment above each key already exists and is already maintained; reading it is what makes the generator a projection rather than an inventory. A key with no comment block above it renders an empty cell, which is honest: there is nothing to say about it yet.

- [ ] **Step 1: Append the failing test**

```js
// ── the generated reference ──────────────────────────────────────────────────
// A stale generated file is a lie a reader cannot detect: it looks exactly like
// a fresh one. So the test regenerates and compares, and names the command.
{
  const { profileReference } = await import("../scripts/profile-reference.mjs");
  const { readFileSync } = await import("node:fs");
  const fresh  = profileReference();
  const onDisk = readFileSync(new URL("../docs/profile-reference.md", import.meta.url), "utf8");
  console.log(`${onDisk === fresh ? "PASS" : "FAIL"}  docs: profile-reference.md is current`);
  if (onDisk !== fresh) { console.log("        run: node scripts/profile-reference.mjs"); fail++; }
  // CONTROL: the comparison is not two empty strings agreeing. The generator
  // must actually carry this PR's new keys and a real count.
  const carries = fresh.includes("`builder.budgets`") &&
                  fresh.includes("`builder.provider.concurrencyLimit`") &&
                  new RegExp(`^${Object.keys(FIELDS).length} keys\\.$`, "m").test(fresh);
  console.log(`${carries ? "PASS" : "FAIL"}  control: the generated reference names the new keys and counts them`);
  if (!carries) fail++;
  // CONTROL: the prose really came from the source. `builder.budgets`' comment
  // block is above it in schema.mjs; an empty cell for every key would satisfy
  // the equality check above and document nothing.
  const documented = /\| `builder\.budgets` \| optional \| \S/.test(fresh);
  console.log(`${documented ? "PASS" : "FAIL"}  control: a key's own comment reaches its row`);
  if (!documented) fail++;
}
```

This block reads `FIELDS`, which `test/profile-validate.test.mjs` already imports at `:4`.

- [ ] **Step 2: Run it red**

```bash
$N test/profile-validate.test.mjs
```

Expected: an unhandled `ERR_MODULE_NOT_FOUND` for `../scripts/profile-reference.mjs`, which exits non-zero before the terminator.

**On the broken implementation** — the shape being guarded against is a hand-written `docs/profile-reference.md`, committed once and never regenerated. Against it, `docs: profile-reference.md is current` goes red and the three controls stay green (or the module is absent and nothing runs at all, which is a different and louder failure). The second shape is a generator whose comment scraper never matches — every cell empty. Then `docs: profile-reference.md is current` is **green**, because the committed file was generated by the same broken scraper, and only `control: a key's own comment reaches its row` goes red. That control is the assertion carrying the weight here: equality between two outputs of the same generator proves nothing on its own.

**The stub loop for this task**: (1) control — the file green; (2) stub applied and verified — make `noteFor` `return "";` unconditionally and confirm with `grep -n 'return "";' scripts/profile-reference.mjs`; (3) the RIGHT assertion red — `control: a key's own comment reaches its row` alone, with `docs: profile-reference.md is current` **also** red because the committed file still holds the real prose, which is the correct pair; (4) restore by `cp`, re-run green. Run it a second time with the stub applied *and* the reference regenerated under it, to see `docs: ... is current` go green while the control stays red — that is the exact false green the control exists to catch, and it must be observed once.

- [ ] **Step 3: Write the generator**

`scripts/profile-reference.mjs`:

```js
// The profile reference, GENERATED from the validator.
//
// Section 11.6 requires configuration documentation and examples to be generated
// from `FIELDS` so the two cannot drift. Hand-written documentation for a
// validator is a second inventory of it, and the copy that goes wrong is the one
// a reader trusts, with nothing reporting the disagreement.
//
// The prose is the comment block already sitting above each key in
// `src/profile/schema.mjs`. Passing descriptions in here instead would put them
// in a THIRD place to edit.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIELDS } from "../src/profile/schema.mjs";

const SCHEMA = new URL("../src/profile/schema.mjs", import.meta.url);
const OUT    = new URL("../docs/profile-reference.md", import.meta.url);

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `//` comment block immediately above a key's line, as one paragraph. */
export function noteFor(source, key) {
  const lines = source.split("\n");
  const at = lines.findIndex(l => new RegExp(`^\\s*"?${escapeRe(key)}"?\\s*:`).test(l));
  if (at < 0) return "";
  const out = [];
  // Upwards until the first line that is not a `//` comment. A shared block above
  // a run of related keys therefore documents only the FIRST of them, and the
  // rest render empty -- which is true, and better than attributing one key's
  // prose to another.
  for (let i = at - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*\/\/ ?(.*)$/);
    if (!m) break;
    out.unshift(m[1]);
  }
  return out.join(" ").trim();
}

export function profileReference(source = readFileSync(SCHEMA, "utf8")) {
  const rows = Object.entries(FIELDS).map(([key, [required]]) =>
    // The pipe is escaped because a comment may legitimately contain one and an
    // unescaped pipe silently ends the table cell.
    `| \`${key}\` | ${required ? "required" : "optional"} | ${noteFor(source, key).replace(/\|/g, "\\|")} |`);
  return [
    "# Profile reference",
    "",
    "GENERATED from `src/profile/schema.mjs`. Do not edit by hand: run",
    "`node scripts/profile-reference.mjs`, which rewrites this file, and a test",
    "in `test/profile-validate.test.mjs` fails while it is stale.",
    "",
    `${rows.length} keys.`,
    "",
    "| key | required | what it is for |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

// Only when RUN, never when imported: the test imports this module, and a
// write-on-import would make the assertion regenerate the file it is checking.
if (process.argv[1] === fileURLToPath(import.meta.url))
  writeFileSync(OUT, profileReference());
```

- [ ] **Step 4: Generate, run it green, run the stub loop, then commit**

```bash
cp scripts/profile-reference.mjs /tmp/profile-reference.mjs.bak
$N scripts/profile-reference.mjs
head -12 docs/profile-reference.md          # eyeball the count line and the first rows
$N test/profile-validate.test.mjs           # expect all green
# ... run the four-check stub loop from Step 2, including the second run ...
git add scripts/profile-reference.mjs docs/profile-reference.md test/profile-validate.test.mjs
git commit -m "feat(profile): generate the profile reference from FIELDS"
```

---

### Task 5: PR-A1 close-out — freeze the key inventory, tracker, PR

**Files:**
- Create: `test/fixtures/profile-fields-v1.json`
- Modify: `test/profile-validate.test.mjs` (append before the terminator), `tasks/reeve-tasks/trackers/s3.md` (**last commit only**)

- [ ] **Step 1: Freeze the key inventory, and prove the freeze both halves**

The inventory is a **freeze fixture, not a runtime second inventory**: nothing reads it to decide anything, exactly as `test/fixtures/hub-schema-v1.json` freezes migration 1 without being consulted by the migration. Its whole purpose is to make the next addition deliberate — because a key added to `FIELDS` and to nothing else is the `commitPattern` shape, and it reached one machine.

Generate it from the code as it stands:

```bash
$N -e '
  const { writeFileSync } = await import("node:fs");
  const { FIELDS } = await import("./src/profile/schema.mjs");
  const { profileReference } = await import("./scripts/profile-reference.mjs");
  const { createHash } = await import("node:crypto");
  writeFileSync("test/fixtures/profile-fields-v1.json",
    JSON.stringify({ version: 1, frozen_at: "2026-08-27",
                     keys: Object.keys(FIELDS).sort(),
                     count: Object.keys(FIELDS).length,
                     reference_sha256: createHash("sha256").update(profileReference()).digest("hex"),
                     note: "a new key is deliberate: add it, regenerate the reference, and update both halves here"
                   }, null, 2) + "\n");
  console.log(Object.keys(FIELDS).length + " keys frozen");
'
```

Append to `test/profile-validate.test.mjs`, before its terminator:

```js
// The declared key set, frozen. Nothing reads this fixture to make a decision;
// it exists so that adding a key is a deliberate act with a diff, rather than a
// line that lands in FIELDS and nowhere else -- which is measured, and reached
// exactly one machine.
{
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { profileReference } = await import("../scripts/profile-reference.mjs");
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/profile-fields-v1.json", import.meta.url), "utf8"));
  const now = Object.keys(FIELDS).sort();
  const added   = now.filter(k => !frozen.keys.includes(k));
  const removed = frozen.keys.filter(k => !now.includes(k));
  const same = added.length === 0 && removed.length === 0;
  console.log(`${same ? "PASS" : "FAIL"}  freeze: the declared key set is unchanged`);
  if (!same) {
    console.log(`        added: ${added.join(",") || "(none)"} | removed: ${removed.join(",") || "(none)"}`);
    console.log("        If this change is intended, regenerate test/fixtures/profile-fields-v1.json");
    console.log("        AND docs/profile-reference.md in the same commit.");
    fail++;
  }
  const shaNow = createHash("sha256").update(profileReference()).digest("hex");
  console.log(`${shaNow === frozen.reference_sha256 ? "PASS" : "FAIL"}  freeze: and so is the reference it generates`);
  if (shaNow !== frozen.reference_sha256) {
    console.log(`        ${shaNow} vs ${frozen.reference_sha256}`); fail++;
  }
  console.log(`${frozen.count === now.length ? "PASS" : "FAIL"}  control: the fixture's own count agrees with its own list`);
  if (frozen.count !== now.length) fail++;
}
```

**The freeze is verified twice, once per half**, and the second run is the one that matters — a freeze verified only against the half it already covered proves nothing about the half that was added:

1. Add `"tools.nothing": [false, isStr],` to `FIELDS`; re-run; expect **`freeze: the declared key set is unchanged` red and `freeze: and so is the reference it generates` red**, everything else green. Restore with `cp /tmp/schema.mjs.bak src/profile/schema.mjs`; re-run green.
2. Edit only a **comment** above an existing key in `src/profile/schema.mjs` — change one word — and re-run; expect **`freeze: the declared key set is unchanged` GREEN and `freeze: and so is the reference it generates` RED**. That is the half a key-list-only freeze cannot see: the prose the generated documentation ships is part of what this PR froze. Restore by `cp`; re-run green.

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
# on a suite that just failed. The flag is set inside the loop because a
# pipeline's status is its last command's, and the last command here is `done`.
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
```

Expected: no `FAILED` lines. 93 pre-existing files plus `test/build-capabilities.test.mjs` — 94.

And the positive control §14 S0 named, run against the machine's real profiles rather than a fixture:

```bash
for p in ~/.reeve/profiles/*/*.json; do
  $N -e '
    const { readFileSync } = await import("node:fs");
    const { validate, withDefaults } = await import("./src/profile/schema.mjs");
    const { capabilitiesFrom } = await import("./src/build/capabilities.mjs");
    const j = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const r = validate(withDefaults(j));
    const caps = capabilitiesFrom(withDefaults(j));
    const anyOn = Object.entries(caps).filter(([, v]) => v === true).map(([k]) => k);
    console.log(process.argv[1], "| valid:", r.ok, "| switches on:", anyOn.length ? anyOn.join(",") : "none",
                "| builder key present:", Object.hasOwn(j, "builder"));
    process.exit(r.ok && anyOn.length === 0 ? 0 : 1);
  ' "$p" || { echo "REFUSED $p"; exit 1; }
done
```

Expected, and it is the whole point of running it against the real files: **every profile validates unchanged, every switch reads false, and `builder key present: false`** — measured on 2026-08-27, `~/.reeve/profiles/nextlyhq/nextly.json` carries no `builder` key at all and `worker: {"isolation":"scratch-home"}`. If any line prints `valid: false`, **stop and do not commit**: a daemon restart against an invalid profile dies at load, and the daemon is watching live work.

- [ ] **Step 3: The tracker line, as the LAST commit**

`tasks/reeve-tasks/trackers/s3.md` conflicts on every branch; one line added last makes the conflict trivial. In §1's task table, set T1's PR number and STATE to **BUILT**. **BUILT, never MERGED** — this commit precedes the PR, merging needs a founder grant, and a MERGED written here would claim delivery of an unmerged review branch and incorrectly unblock T2.

```bash
git add tasks/reeve-tasks/trackers/s3.md
git commit -m "docs(s3): tracker -- T1 built"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/s3-fields
gh pr create --title "S3 T1: builder profile fields and the capability reader" --body-file - <<'BODY'
## What

Every profile key S3 reads, added to the validator FIRST as section 1.5 requires:
per-action `builder.budgets`, `builder.maxConcurrentTasks`,
`builder.budget.maxPackages`, `builder.lease.starvedHours` and the four
`builder.provider.*` scheduler knobs, each with its default and its position in
a generated profile. Plus `src/build/capabilities.mjs`, the single reader of the
capability switches, and a profile reference generated from `FIELDS`.

No database is opened, no SQL is executed, no process is spawned and nothing
reads the network. No switch is turned on: every capability still reads false on
every profile on the machine, checked rather than assumed.

## Decisions taken in this PR

- **`builder.budgets` is ONE key with its own validator, not eighteen dotted
  leaves.** The unknown-key sweep accepts any leaf under a declared key, so the
  dotted form would have admitted `builder.budgets.BUILD_NOPE.budgetMinutes`.
- **`model` and `effort` are validated as bare names, not against a closed set.**
  The CLI owns those vocabularies and resolves aliases at dispatch; a list here
  would be a second copy this file cannot check, and alias-to-model resolution is
  something this stage MEASURES.
- **`guardianReserved >= concurrencyLimit` is refused.** Section 10.4 admits a
  builder request only below `limit - reserved`, so that pair is a permanent off
  switch wearing the clothes of a tuning knob.
- **`CAPABILITY_KEYS` is derived from `FIELDS`.** Five call sites would otherwise
  retype the key strings, and a typo reads as "off", which is fail-closed and
  therefore invisible.
- **The reference is generated and its prose is read out of the source
  comments**, so there is no third place to edit.

## Review focus

- `BUDGETS` in `src/profile/schema.mjs`: it is the only thing refusing an unknown
  action name, because the prefix sweep cannot.
- The freeze fixture asserts BOTH the key list and the sha of the generated
  reference. Please check the second half is not redundant: it catches a
  comment-only edit that changes shipped documentation and no key.
- `capabilitiesFrom` is asserted against the strings `leaseEffect` writes into
  `outbox.last_error`, not against a list. Please check that recovery is sound.
BODY
gh pr comment --body "@codex review"
```

- [ ] **Step 5: Work the gate**

Comment `@codex review` on **every push**, not only the first. Read **both** endpoints: a clean pass arrives as an issue comment, findings as review comments. Reply to **and resolve** every thread via GraphQL; replying alone does not clear it. Apply the taper rule: ten rounds without the findings tapering means stop and bring the shape, not the next fix.

**Do not merge.** Founder grant required.

---

---

# PR-A2: The registry entry, and a real `io` for `resolveSnapshot`

**Branch:** `feat/s3-registry-io`. **Base:** PR-A1's merge commit. **Scope:** the registry loader moved out of `bin/reeve` with its malformed-entry discipline intact and two new required fields; a derived registry version; and the nine-member `io` object `resolveSnapshot` takes, every member injectable and every default local. **Nothing in PR-A2 calls GitHub, and `resolveSnapshot` still performs no hub write and takes no lock.**

**One thing this PR cannot finish, named here rather than discovered mid-task.** `SNAPSHOT_FIELDS` (`src/build/phases.mjs:156`) requires `specRepoId` and `gateDefinitionHash` at admission, and S3 opens no spec PR and runs no gates. Founder decision 5 settles the shape — **Option A, provision both now** — but the concrete repository names and gate-definition paths are **founder input F1** (`trackers/s3.md` §2), unanswered as of 2026-08-27. Everything in this PR is buildable and testable against fixtures without that answer; what cannot happen without it is a **live** `reeve task file` against a real project, because the io will correctly return `null` for both and `missingSnapshotFields` will name them. Task 8 makes that refusal legible; Task 11 records it on the tracker rather than letting the branch look finished.

---

### Task 6: A registry entry without a repository path is an error, not a dropped row

**Files:**
- Create: `src/build/registryio.mjs`, `test/registry-io.test.mjs`
- Test: `test/registry-io.test.mjs` (new; opens with `/* ... standard harness ... */`, slug `regio`)

**Interfaces:**
- Consumes: nothing from PR-A1. `resolveSnapshot`'s expectations at `src/build/registry.mjs:183-212` — it reads `registry.projects[project]`, `entry.nwo`, `entry.repoPath`, `entry.profilePath` and `registry.version`.
- Produces: `parseRegistry(text, path) -> {projects: Array<{name,nwo,repoPath,profilePath}>, registry: {version, projects: Record<string, entry>}, error: string|null}`. `bin/reeve` reads `.projects` and `.error`; `resolveSnapshot` takes `.registry`.

**Why this lands in `registryio.mjs` and not in `registry.mjs`, against the brief's own file list.** `test/hub-registry.test.mjs:100-103` walks `src/build/registry.mjs`'s import graph — bounded at `hubdb.mjs` and `locks.mjs` — and asserts it reaches no `node:fs`, `node:child_process` or network module, with three controls proving the walk is not blind. That assertion is what makes *"`admitTask` performs no I/O"* a property of capability rather than a claim about discipline, and `registryProjects` is 78 lines built on `readFileSync`. **Moving it into `registry.mjs` turns that assertion red and takes the guarantee with it.** So `registry.mjs` is not modified by this PR at all, and every registry read lives in the new module beside it.

- [ ] **Step 1: Write the failing test**

`test/registry-io.test.mjs`:

```js
// The registry file, parsed. A MALFORMED ENTRY IS AN ERROR, not a row to drop:
// filtering one out returns `error: null`, doctor then sets `projectsKnown: true`
// over a project set the registry does not describe, and `hubFindings`
// SUPPRESSES every gate-state row absent from that set -- so a broken registry
// reports a clean hub while hiding the authority findings.
/* ... standard harness ... */   // slug "regio"
import { parseRegistry } from "../src/build/registryio.mjs";

const P = "/x/projects.json";
const good = { nextly: { nwo: "o/r", repoPath: "/repo", profilePath: "/p.json" } };
const parse = (obj) => parseRegistry(JSON.stringify(obj), P);

{
  const r = parse(good);
  check(r.error === null && r.projects.length === 1, "a well-formed registry parses", JSON.stringify(r.error));
  check(r.projects[0].repoPath === "/repo" && r.projects[0].profilePath === "/p.json",
    "and every row carries the repository path and the profile path", JSON.stringify(r.projects[0]));
  check(r.registry.projects.nextly?.nwo === "o/r",
    "and the same read yields the shape resolveSnapshot takes", JSON.stringify(r.registry.projects));
}

// The two new required fields, each refused for the same reason the nwo is: a
// row `resolveSnapshot` cannot complete is a row admission would key on nothing.
for (const [label, entry] of [
  ["no repoPath",        { nwo: "o/r", profilePath: "/p.json" }],
  ["no profilePath",     { nwo: "o/r", repoPath: "/repo" }],
  ["a relative repoPath",{ nwo: "o/r", repoPath: "repo", profilePath: "/p.json" }],
]) {
  const r = parse({ nextly: entry });
  check(r.projects.length === 0 && typeof r.error === "string" && /nextly/.test(r.error),
    `an entry with ${label} is a registry ERROR naming it`, JSON.stringify(r));
}

// The discipline carried over verbatim from the CLI, so moving the code did not
// quietly narrow it. Each of these was a measured hiding of an H-4 finding.
for (const [label, body] of [
  ["a top level that is an array", ["nextly"]],
  ["an entry that is a string",    { nextly: "bad" }],
  ["an entry with no nwo",         { nextly: { repoPath: "/repo", profilePath: "/p.json" } }],
  ["an nwo that is not owner/repo",{ nextly: { nwo: "notanwo", repoPath: "/repo", profilePath: "/p.json" } }],
  ["an nwo of dot segments",       { nextly: { nwo: "../..",  repoPath: "/repo", profilePath: "/p.json" } }],
  ["a bare hyphen as the owner",   { nextly: { nwo: "-/repo", repoPath: "/repo", profilePath: "/p.json" } }],
  ["consecutive hyphens",          { nextly: { nwo: "a--b/r", repoPath: "/repo", profilePath: "/p.json" } }],
  ["an owner past 39 characters",  { nextly: { nwo: "a".repeat(40) + "/r", repoPath: "/repo", profilePath: "/p.json" } }],
  ["a hyphenated owner past it",   { nextly: { nwo: Array(39).fill("a").join("-") + "/r", repoPath: "/repo", profilePath: "/p.json" } }],
]) check(parse(body).error !== null && parse(body).projects.length === 0,
  `${label} is a registry error`, JSON.stringify(parse(body).error));

// CONTROLS: the names that must keep working, or the rules above are refusing
// everything and prove nothing.
for (const nwo of ["owner/repo.js", "octo-example/my-repo", Array(20).fill("a").join("-") + "/repo"])
  check(parse({ nextly: { nwo, repoPath: "/repo", profilePath: "/p.json" } }).error === null,
    `control: ${nwo} is a name`, nwo);
check(parse("{ not json").error !== null, "unparseable JSON is an error, not an empty registry");

// ── the version is DERIVED from the content ─────────────────────────────────
// Section 1.5's registry format is `{name: {...}}` and carries no version field,
// while `task.registry_version` is NOT NULL and exists to detect that the
// registry moved under a task admitted from it. So it is a fingerprint of the
// content: an mtime changes when nothing did, and a hand-kept number is wrong
// the first time somebody forgets it.
{
  const a = parse(good).registry.version;
  check(Number.isInteger(a) && a > 0, "the registry version is a positive integer", String(a));
  check(parse(good).registry.version === a, "and is stable for identical content");
  check(parse({ nextly: { profilePath: "/p.json", repoPath: "/repo", nwo: "o/r" } }).registry.version === a,
    "and does not change when only key ORDER changes");
  check(parse({ nextly: { nwo: "o/r", repoPath: "/repo2", profilePath: "/p.json" } })
          .registry.version !== a, "and DOES change when a value changes");
}

/* ... standard harness terminator ... */
```

- [ ] **Step 2: Run it red**

```bash
$N test/registry-io.test.mjs
```

Expected: `Cannot find module` for `../src/build/registryio.mjs`.

**On the broken implementation** — the shape being guarded against is a copy of `bin/reeve:133-210` with `repoPath` and `profilePath` merely *read* rather than *required*. Then the three `an entry with ... is a registry ERROR naming it` assertions go red and every other assertion in the file stays green, including all nine inherited-discipline rows and all three name controls — so an incomplete move is exactly three failures at the two new fields, not a general failure. The second shape derives the version from `JSON.stringify(reg)` without sorting: `and does not change when only key ORDER changes` goes red alone, with `and DOES change when a value changes` still green.

**The stub loop for this task**: (1) control — the file green; (2) stub applied and verified — delete `repoPath` from the required-field check in `parseRegistry` and confirm with `grep -c repoPath src/build/registryio.mjs`, which must drop; (3) the RIGHT assertions red — `an entry with no repoPath` and `an entry with a relative repoPath` only, with `an entry with no profilePath` still green, which is what proves the two fields are checked independently rather than by one condition; (4) restore by `cp` from a backup taken before the stub.

- [ ] **Step 3: Write the loader**

`src/build/registryio.mjs`, the parse half. The comment block explaining why a malformed entry is an error is carried **verbatim** from `bin/reeve:137-147`, because it is the record of a measured defect and rewording it would make the record a paraphrase:

```js
// registryio -- the registry file, and the io `resolveSnapshot` is handed.
//
// EVERYTHING THAT TOUCHES THE DISK LIVES HERE, and that is the whole reason this
// module exists beside registry.mjs rather than inside it. registry.mjs's import
// graph is asserted to reach no filesystem and no network module, which is what
// makes "admitTask performs no I/O" a property of capability rather than a claim
// about discipline; a readFileSync added there takes the guarantee with it.
import { readFileSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { founderGitEnv } from "../gitguard.mjs";
import { hubPathFor } from "../paths.mjs";
import { resolveRepoIdAt } from "./repoid.mjs";

// GitHub's own rules. A login is alphanumeric segments joined by single inner
// hyphens, at most 39 characters; a repository name may carry `.`, `_` and `-`
// anywhere except as the whole name. The lookahead bounds the LENGTH before the
// shape rule runs, because a repetition bound counts repetitions and not
// characters -- `{0,38}` let a 77-character owner through, and an impossible
// login still marked the registry KNOWN.
const OWNER = String.raw`(?=[^/]{1,39}/)[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}`;
const REPO  = String.raw`(?!\.+$)[\w.-]+`;
const NWO   = new RegExp(`^${OWNER}/${REPO}$`);

// The version is DERIVED. Section 1.5's format is `{name: {...}}` with no
// version field, and `task.registry_version` is NOT NULL and exists so that a
// registry edited after admission is detectable. A content fingerprint answers
// exactly that; an mtime changes when nothing did, and a hand-kept number is
// wrong the first time somebody forgets it. Sorted, so key order is not content.
const versionOf = (reg) => {
  const canonical = JSON.stringify(Object.keys(reg).sort().map(
    n => [n, Object.keys(reg[n]).sort().map(k => [k, reg[n][k]])]));
  // 48 bits: comfortably inside SQLite's signed 64-bit INTEGER and inside
  // Number.MAX_SAFE_INTEGER, so it survives the round trip through JSON.
  return Number.parseInt(createHash("sha256").update(canonical).digest("hex").slice(0, 12), 16);
};

const absent = (v) => typeof v !== "string" || !v.startsWith("/");

/**
 * Parse a registry's TEXT. No filesystem access: `loadRegistry` reads the file.
 *
 * A MALFORMED ENTRY IS AN ERROR, not a row to drop.
 *
 * Filtering it out returned `error: null`, so doctor set `projectsKnown:
 * true` over a project set the registry did not actually describe -- and
 * `hubFindings` then SUPPRESSES gate-state rows absent from that set. A
 * registry of `{ "prod": "bad" }` therefore reported a clean hub while
 * hiding exactly the H-4 authority findings the H-7 path exists to preserve.
 * Silently narrowing the input is how a check answers a smaller question
 * than the one it was asked.
 *
 * `repoPath` and `profilePath` join `nwo` as required for the same reason, one
 * step further on: they are the two snapshot fields the registry alone supplies,
 * and an entry missing either cannot produce a snapshot admission would accept.
 * Dropping such a row would report a project as registered and unadmittable.
 */
export function parseRegistry(text, path) {
  let reg;
  try { reg = JSON.parse(text); }
  catch (e) { return { projects: [], registry: { version: 0, projects: {} }, error: `${path}: ${e.message}` }; }
  if (reg === null || typeof reg !== "object" || Array.isArray(reg))
    return { projects: [], registry: { version: 0, projects: {} },
             error: `${path}: the registry must be an object of name -> project, ` +
                    `not ${Array.isArray(reg) ? "an array" : typeof reg}` };
  const bad = Object.entries(reg)
    .filter(([, v]) => !v || typeof v !== "object" || Array.isArray(v) ||
                       typeof v.nwo !== "string" || !NWO.test(v.nwo) ||
                       absent(v.repoPath) || absent(v.profilePath))
    .map(([n]) => n);
  if (bad.length)
    return { projects: [], registry: { version: 0, projects: {} },
             error: `${path}: ${bad.length} malformed entr${bad.length === 1 ? "y" : "ies"} ` +
                    `(${bad.slice(0, 5).join(", ")}); each project must be an object with an ` +
                    `"owner/repo" nwo and absolute repoPath and profilePath` };
  return {
    projects: Object.entries(reg).map(([name, p]) =>
      ({ name, nwo: p.nwo, repoPath: p.repoPath, profilePath: p.profilePath })),
    registry: { version: versionOf(reg), projects: reg },
    error: null,
  };
}

/** The registry on disk. The read failure is ITSELF a finding, and is carried. */
export function loadRegistry(home, { readFile = readFileSync } = {}) {
  const path = join(home, "projects.json");
  try { return parseRegistry(readFile(path, "utf8"), path); }
  // Returning a bare [] made an unreadable registry indistinguishable from a
  // legitimately empty one -- and since H-4 reports projects that have NO
  // gate-state row, an empty expected set suppresses every one of them.
  catch (e) { return { projects: [], registry: { version: 0, projects: {} }, error: `${path}: ${e.message}` }; }
}
```

`lstatSync`, `execFileSync`, `founderGitEnv`, `hubPathFor` and `resolveRepoIdAt` are imported here and used by Task 8; a lint pass between the two commits will flag them as unused. Add them in Task 8's commit instead if the pre-commit hook refuses the intermediate state — the module's import list is the same either way.

- [ ] **Step 4: Run it green, run the stub loop, then commit**

```bash
cp src/build/registryio.mjs /tmp/registryio.mjs.bak
$N test/registry-io.test.mjs        # expect all green
# ... run the four-check stub loop from Step 2, restoring by `cp` ...
git add src/build/registryio.mjs test/registry-io.test.mjs
git commit -m "feat(build): the registry loader, with paths required"
```

---

### Task 7: `bin/reeve` reads the registry from one place, and a broken one still stops the tick

**Files:**
- Modify: `bin/reeve` (delete `const registryProjects = (home) => {` at `:133` through its closing `};` at `:210`; import `loadRegistry`; rewrite the three call sites at `:998`, `:1552` and `:1595`, and the re-read inside `ctx.resolveRepoId` at `:1667`)
- Modify: `test/hub-gatestate.test.mjs` (the two source-text guards), `test/hub-doctor.test.mjs` (the H-7 fixtures)

**Interfaces:**
- Consumes: `parseRegistry`, `loadRegistry` (Task 6).
- Produces: nothing new. `bin/reeve` keeps calling a function named `registryProjects` — as a one-line alias over `loadRegistry` — so the four call sites and the two source-text guards that read this file keep their anchor.

**Two existing assertions go red on this change, and they must be fixed in this commit, not discovered later.** A PR that widens a rule carries the fixes the widening requires, or the guard lands without them:

1. `test/hub-gatestate.test.mjs:299-301` asserts the literal source text `/\{ name, nwo: p\.nwo \}/` over `bin/reeve`, under the name *"fixture: registryProjects really does yield only a name and an nwo"*. That claim becomes **false** here, which is the point of the change; the assertion is replaced by one that reads the loader's real output rather than the CLI's text.
2. `test/hub-doctor.test.mjs:496-612` drives `builder doctor --json` against fixtures written as `{ prod: { nwo: "o/orphan" } }` and asserts a well-formed registry raises **no** H-7 (`:558-562`, and the `dotted`/`hyphened`/`longest` control at `:548-552`). Those entries now lack two required fields and would raise H-7, turning three controls red. Every fixture that is meant to be *well-formed* gains `repoPath` and `profilePath`; every fixture that is meant to be *malformed* is left exactly as it is.

`src/doctor.mjs` is **not modified**. `hubFindings` (`:1075`) takes `projects` and `projectsKnown` as inputs and reads only `p.nwo` when it builds `registered` (`:1155`); the richer rows change nothing there. H-7 itself is emitted at the route in `bin/reeve:1105`, not inside `hubFindings`, deliberately — *"`hubFindings` takes the project list as an input and cannot tell an empty list from a failed read"* (`bin/reeve:1121-1123`).

- [ ] **Step 1: Rewrite the two existing assertions, and watch them fail**

In `test/hub-gatestate.test.mjs`, replace the block at `:299-301` with:

```js
  // The tick is handed what the LOADER really produces, not a literal written
  // here. A fixture richer than production is what let every registered project
  // reach the no-id guard on every heartbeat while every assertion passed.
  const parsed = parseRegistry(JSON.stringify(
    { nextly: { nwo: "o/r", repoPath: "/repo", profilePath: "/p.json" } }), "/x/projects.json");
  check(parsed.error === null && Object.keys(parsed.projects[0]).sort().join(",") ===
        "name,nwo,profilePath,repoPath",
    "fixture: the loader yields exactly the four fields production carries",
    JSON.stringify(parsed.projects[0]));
```

with `import { parseRegistry } from "../src/build/registryio.mjs";` added beside that file's existing imports. Then in the block below it, replace the hand-written `projects: [{ name: "nextly", nwo: "o/r" }]` with `projects: parsed.projects`.

In `test/hub-doctor.test.mjs`, add `repoPath: "/repo", profilePath: "/p.json"` to each entry in the three **well-formed** fixtures at `:548-550` and `:558`, and to the `{ prod: { nwo: "o/orphan" } }` entry wherever it stands as a control. Leave every fixture in the twelve-case malformation loop at `:583-602` untouched.

```bash
$N test/hub-gatestate.test.mjs
$N test/hub-doctor.test.mjs
```

Expected before the CLI changes: `hub-gatestate` fails on `Cannot find module ../src/build/registryio.mjs` only if Task 6 is unmerged in this branch — it is not, so it fails instead on `fixture: the loader yields exactly the four fields production carries` being **green** while every well-formed `hub-doctor` control is **red**, because the CLI's own loader still requires only `nwo` and now receives entries carrying two fields it drops.

**On the broken implementation** — the shape guarded against here is deleting the CLI's copy and importing the new loader **without** updating the doctor fixtures. Then `test/registry-io.test.mjs` and `test/hub-gatestate.test.mjs` are green, the whole rest of the suite is green, and `test/hub-doctor.test.mjs` fails on exactly three control assertions: `control: a repository name containing dots is still a name`, `control: a well-formed registry raises no registry error`, and every `and the authority finding survives it` row in the malformation loop that depends on the orphan project being registered. Three named controls, in one file, is what an unfixed widening looks like.

**The stub loop for this task**: (1) control — `hub-doctor`, `hub-gatestate` and `registry-io` all green after Step 2; (2) stub applied and verified — remove `repoPath` from the required-field check in `parseRegistry`, confirming by `grep`; (3) the RIGHT assertion red — `an entry with no repoPath is a registry ERROR naming it` in `test/registry-io.test.mjs`, while `test/hub-doctor.test.mjs` goes **green throughout**, which is the observation that matters: the doctor fixtures now over-specify, and only the loader's own test can see the rule at all; (4) restore by `cp`, re-run all three green.

- [ ] **Step 2: Delete the copy and import the loader**

In `bin/reeve`, delete `:133-210` entirely and add to the import block beside the existing `src/build/` imports:

```js
import { loadRegistry } from "../src/build/registryio.mjs";
```

then, where the deleted function stood:

```js
// One loader, in one place. This alias exists so the four call sites below and
// the two tests that read this file's text keep their anchor while the rules --
// which are a record of measured authority-hiding defects -- live in the module
// where they can be unit-tested without spawning a CLI.
const registryProjects = (home) => loadRegistry(home);
```

The four call sites are unchanged: `:998` (`builder doctor`), `:1552` (the build tick), `:1595` (the guardian's project resolution) and `:1667` (the re-read inside `ctx.resolveRepoId`). Each already reads `.projects` and `.error` from the same call, which is what `test/hub-gatestate.test.mjs:344-346` asserts and which must stay true.

- [ ] **Step 3: Run it green, run the stub loop, then commit**

```bash
cp bin/reeve /tmp/reeve.bak
$N test/registry-io.test.mjs test/hub-gatestate.test.mjs   # each expect all green
$N test/hub-doctor.test.mjs                                 # expect all green
$N test/repo-id-lookup.test.mjs   # slices bin/reeve at "const registryProjects"; expect green
# ... run the four-check stub loop from Step 1, restoring by `cp` ...
git add bin/reeve test/hub-gatestate.test.mjs test/hub-doctor.test.mjs
git commit -m "refactor(cli): read the registry through one loader"
```

`test/repo-id-lookup.test.mjs:119` slices `bin/reeve` between `const repoIdOnce` and `const registryProjects`. The alias keeps that anchor string present, so the slice still bounds the same span; if that file goes red, the alias was renamed and must not be.

---

### Task 8: A snapshot resolved for a fixture project is complete, and a missing profile path is named in the refusal

**Files:**
- Modify: `src/build/registryio.mjs` (add `registryIo`), `test/registry-io.test.mjs` (append before the terminator), `test/hub-registry.test.mjs` (append before its terminator — the final `db.close();` / `}` / `rmSync` / `console.log` / `process.exit` group)

**Interfaces:**
- Consumes: `resolveSnapshot(registry, project, claims, io)` (`src/build/registry.mjs:183`); `SNAPSHOT_FIELDS` and `missingSnapshotFields(snapshot)` (`src/build/phases.mjs:156`, `:161`); `resolveClaims(claims, repoPath, io)` (`:123`); `resolveRepoIdAt(hubPath, project, {fetchRepoId, connect})` (`src/build/repoid.mjs:122`); `normalizeClaim` (`:68`).
- Produces: `registryIo(home, project, entry, opts) -> io` with **nine** members: `repoId`, `profileHash`, `defaultBranch`, `visibility`, `specRepoId`, `gateDefinitionHash`, `founderUserId`, `lstat`, `lsTree`. S3-B's `reeve task file` constructs one per filing.

**Nine members, not eight.** The brief's T2 specification lists eight and omits `lsTree`. Measured at `16cd880`, `resolveClaims` makes it a **precondition**, not an enhancement (`src/build/registry.mjs:152-155`): `if (typeof io?.lsTree !== "function") return { refusal: … }`, with its own comment recording why — `io.lsTree?.()` made a missing capability read as *"nothing is tracked"*, so every ENOENT became *"does not exist yet"* and an uninitialised submodule was admitted. An eight-member io refuses every filing.

**What is local and what is injected.** `profileHash`, `defaultBranch`, `visibility` and `founderUserId` are read from the profile file the entry names — the profile already carries `identity.defaultBranch`, `identity.visibility` and `builder.founder.userId`, so none of them is a network call. `lstat` and `lsTree` are filesystem and `git ls-tree` against the checkout. `repoId` goes through `resolveRepoIdAt`, which asks the hub first and falls back only to an **injected** `fetchRepoId`; S3-A injects none, so a project the hub has never admitted a task for yields `null`. `specRepoId` and `gateDefinitionHash` are **F1's**: until the founder names the spec repositories and the gate-definition paths, both resolve `null` by construction, `missingSnapshotFields` names them, and the filing is refused with the two field names in it. That refusal is the correct state and is asserted below — it is what makes the block visible instead of silent.

- [ ] **Step 1: Append the failing tests**

To `test/hub-registry.test.mjs`, before its terminator — this file already imports `resolveSnapshot`, `normalizeClaim` and `SNAPSHOT_FIELDS`:

```js
// ── an incomplete registry entry is named, field by field ───────────────────
// The end-to-end block above proves a COMPLETE snapshot. That green is satisfied
// by an implementation that never checks completeness at all, so the refusal is
// asserted too -- and by the field it names, not by the fact that it refused.
{
  const lookups = { repoId: async () => 1, visibility: async () => "private",
                    specRepoId: async () => 9, profileHash: async () => "h",
                    defaultBranch: async () => "main", gateDefinitionHash: async () => "g",
                    founderUserId: async () => 4242,
                    lstat: () => ({ isSymbolicLink: () => false }), lsTree: () => ({ mode: "040000" }) };
  const withEntry = (entry) => ({ version: 3, projects: { nextly: entry } });
  const full = { nwo: "o/r", repoPath: "/repo", profilePath: "/f" };

  const ok = await resolveSnapshot(withEntry(full), "nextly", [normalizeClaim("packages/x")], lookups);
  check(missingSnapshotFields(ok).length === 0,
    "a complete entry produces a snapshot with no missing field", JSON.stringify(missingSnapshotFields(ok)));

  const { profilePath, ...noProfile } = full;
  const short = await resolveSnapshot(withEntry(noProfile), "nextly", [normalizeClaim("packages/x")], lookups);
  check(missingSnapshotFields(short).includes("profilePath"),
    "and dropping the profile path is NAMED in what is missing", JSON.stringify(missingSnapshotFields(short)));
  check(!missingSnapshotFields(short).includes("repoPath"),
    "control: and only that field, so the check is per-field and not all-or-nothing",
    JSON.stringify(missingSnapshotFields(short)));
}
```

`missingSnapshotFields` must be added to that file's existing `phases.mjs` import at `:12`, which today brings in `SNAPSHOT_FIELDS` alone.

To `test/registry-io.test.mjs`, before its terminator:

```js
// ── the io, built from a real home ──────────────────────────────────────────
import { registryIo } from "../src/build/registryio.mjs";
import { resolveSnapshot, normalizeClaim } from "../src/build/registry.mjs";
import { missingSnapshotFields, SNAPSHOT_FIELDS } from "../src/build/phases.mjs";
import { mkdirSync } from "node:fs";
{
  const home = join(dir, "home"); mkdirSync(join(home, "state"), { recursive: true });
  const repo = join(dir, "repo");  mkdirSync(join(repo, "packages", "x"), { recursive: true });
  const prof = join(home, "p.json");
  writeFileSync(prof, JSON.stringify({ schemaVersion: 1, identity: { defaultBranch: "main", visibility: "private" },
                                       builder: { founder: { userId: 4242 } } }));
  const entry = { nwo: "o/r", repoPath: repo, profilePath: prof };
  const registry = { version: 7, projects: { nextly: entry } };

  const io = registryIo(home, "nextly", entry, {
    // No git in a bare tmpdir, so the index probe is injected. It is REQUIRED by
    // resolveClaims, not optional: an io without it refuses every claim.
    lsTree: () => ({ mode: "040000" }),
  });
  check(typeof io.lsTree === "function", "the io carries an index probe, which resolveClaims requires");
  const snap = await resolveSnapshot(registry, "nextly", [normalizeClaim("packages/x")], io);
  check(!snap.refusal, "a claim resolves against a real checkout path", JSON.stringify(snap.refusal));
  check(snap.profileHash && snap.defaultBranch === "main" && snap.visibility === "private" &&
        snap.founderUserId === 4242 && snap.registryVersion === 7,
    "and every locally answerable field comes from the profile the entry names", JSON.stringify(snap));
  // F1 IS UNANSWERED, and this is what that looks like. Both fields resolve null
  // with no spec repository named, `missingSnapshotFields` names both, and the
  // filing that consumes this is refused rather than admitted incomplete.
  const missing = missingSnapshotFields(snap);
  check(missing.includes("specRepoId") && missing.includes("gateDefinitionHash"),
    "with no spec repository configured, both fields are named as missing", JSON.stringify(missing));
  check(missing.includes("repoId"),
    "and so is the repository id, because no task has been admitted and no fetcher is injected",
    JSON.stringify(missing));
  // CONTROL: injecting the three closes the snapshot completely, so the refusal
  // above is about configuration and not about a resolver that answers nothing.
  const wired = registryIo(home, "nextly", { ...entry, specRepo: "o/spec", gateDefinitionPaths: ["gate.yml"] }, {
    lsTree: () => ({ mode: "040000" }), fetchRepoId: async (nwo) => (nwo === "o/spec" ? 9 : 1),
    readGateFile: () => "gate: yes",
  });
  const done = await resolveSnapshot(registry, "nextly", [normalizeClaim("packages/x")], wired);
  check(missingSnapshotFields(done).length === 0,
    "control: with a spec repository and a gate definition named, nothing is missing",
    JSON.stringify(missingSnapshotFields(done)));
  check(SNAPSHOT_FIELDS.every(f => done[f] != null),
    "control: and every one of the eleven declared fields carries a value", JSON.stringify(done));
}
```

- [ ] **Step 2: Run them red**

```bash
$N test/hub-registry.test.mjs
$N test/registry-io.test.mjs
```

Expected: `hub-registry` fails on `missingSnapshotFields is not defined` until the import is widened, then goes green on the first two assertions and red on none — because `resolveSnapshot` already behaves this way; that block is **characterisation plus the control the existing block lacks**. `registry-io` fails on `Cannot find module` for `registryIo`.

**On the broken implementation** — the shape guarded against is a `registryIo` that resolves `specRepoId` and `gateDefinitionHash` to a placeholder rather than to `null`. Then `with no spec repository configured, both fields are named as missing` goes red while both controls stay green, so a plausible-looking value is one failure and is unmistakable. The second shape is an io built without `lsTree`: `a claim resolves against a real checkout path` goes red with the refusal text *"territory cannot be resolved without an index probe"*, and every field assertion after it goes red too, which is the loud version — the one this task's nine-member count exists to prevent.

**The stub loop for this task**: (1) control — both files green; (2) stub applied and verified — make `specRepoId` in `registryIo` `async () => 0` and confirm with `grep -n "specRepoId" src/build/registryio.mjs`; (3) the RIGHT assertion red — `with no spec repository configured, both fields are named as missing`, alone, because `0` is not `null` and `missingSnapshotFields` filters on `== null`; the `control:` rows stay green; (4) restore by `cp`, re-run both green. That third check is worth reading twice: `0` is the value a placeholder most plausibly takes, and it passes a completeness test while naming a repository that does not exist.

- [ ] **Step 3: Add `registryIo`**

Append to `src/build/registryio.mjs`:

```js
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * The `io` `resolveSnapshot` takes, for one project, built from one home.
 *
 * NINE members. `lsTree` is not optional: `resolveClaims` treats it as a
 * precondition and refuses every claim without it, because an absent probe once
 * made "nothing is tracked" indistinguishable from "not tracked yet" and
 * admitted an uninitialised submodule.
 *
 * NOTHING HERE READS THE NETWORK ON ITS OWN ACCOUNT. Repository ids come from the
 * hub, or from an INJECTED fetcher and otherwise not at all; every other field is
 * read from the profile the registry entry names, or from the checkout. And
 * nothing here opens a transaction: `resolveSnapshot` is the async half that runs
 * BEFORE `admitTask`'s BEGIN IMMEDIATE, and a lookup that took a write lock would
 * hold it for as long as the lookup takes.
 */
export function registryIo(home, project, entry, {
  fetchRepoId = null, connect, lstat = lstatSync, readFile = readFileSync,
  lsTree, readGateFile,
} = {}) {
  const hubPath = hubPathFor(home);
  const profile = () => JSON.parse(readFile(entry.profilePath, "utf8"));
  const idFor = (nwo) => resolveRepoIdAt(hubPath, { name: project, nwo },
    connect ? { fetchRepoId, connect } : { fetchRepoId });
  return {
    repoId:      async (nwo) => idFor(nwo),
    profileHash: async (p) => sha256(readFile(p)),
    defaultBranch: async () => profile()?.identity?.defaultBranch ?? null,
    visibility:    async () => profile()?.identity?.visibility ?? null,
    founderUserId: async () => profile()?.builder?.founder?.userId ?? null,
    // F1: the spec repository is a registry field the founder has not yet named.
    // NULL, never a placeholder -- `missingSnapshotFields` filters on `== null`,
    // so a 0 or an empty string would complete the snapshot while naming a
    // repository that does not exist, and admission would accept it.
    specRepoId: async () => (entry.specRepo ? idFor(entry.specRepo) : null),
    // Section 8.3's gate definition, hashed from the paths the entry names,
    // relative to the checkout. S6 re-hashes this at the APPROVED base and
    // replaces whatever value S3 recorded; it is provisioned here, not relied on.
    gateDefinitionHash: async () => {
      const paths = entry.gateDefinitionPaths;
      if (!Array.isArray(paths) || paths.length === 0) return null;
      const read = readGateFile ?? ((p) => readFile(join(entry.repoPath, p), "utf8"));
      // The PATH is hashed beside its bytes, and the list is sorted: otherwise
      // renaming a gate file, or reordering the list, leaves the hash unchanged.
      return sha256([...paths].sort().map(p => `${p}\0${read(p)}`).join("\0"));
    },
    lstat,
    // `git ls-tree HEAD -- <path>` as `{mode}`, or null when git records nothing.
    // Injected in tests, because a fixture directory is not a repository and a
    // probe that cannot run must not read as "not tracked".
    lsTree: lsTree ?? ((repoPath, path) => {
      try {
        const out = execFileSync("git", ["-C", repoPath, "ls-tree", "HEAD", "--", path],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: founderGitEnv() });
        const mode = out.split(/\s/)[0];
        return mode ? { mode } : null;
      } catch { return null; }
    }),
  };
}
```

- [ ] **Step 4: Run them green, run the stub loop, then commit**

```bash
cp src/build/registryio.mjs /tmp/registryio.mjs.bak
$N test/registry-io.test.mjs test/hub-registry.test.mjs   # each expect all green
# ... run the four-check stub loop from Step 2, restoring by `cp` ...
git add src/build/registryio.mjs test/registry-io.test.mjs test/hub-registry.test.mjs
git commit -m "feat(build): a real io for resolveSnapshot"
```

---

### Task 9: Resolving a snapshot writes nothing to the hub and takes no lock

**Files:**
- Test: `test/registry-io.test.mjs` (append before the terminator)

**Interfaces:**
- Consumes: `registryIo` (Task 8); `openHub`, `hubTx` (`src/build/hubdb.mjs`); `HUB_LOOKUP_OPEN` (`src/build/repoid.mjs:163`); `admitTask` (`src/build/registry.mjs:218`).
- Produces: no code. This task adds only assertions, and it is a task rather than three lines inside Task 8 because the property it establishes is a **negative**, and a negative asserted in passing beside the positive it accompanies is the shape that has twice been satisfied by an instrument that could not see the thing.

**How the negative is established, and why the obvious instrument does not work.** Watching for a write does not work: `resolveSnapshot` takes no db at all, so there is nothing to watch, and the write that would matter happens inside `registryIo`'s hub lookup. So two independent checks, and both are needed:

1. **Capability removed.** `registryIo` is given a `connect` returning a handle that throws on `exec` and on any `prepare` whose SQL is not a plain `SELECT`. If `resolveSnapshot` returns a snapshot, nothing wrote.
2. **State compared, with the read proven.** Against a real hub with a real admitted task, every table's row count and `hub_event`'s maximum sequence are identical before and after — **and** the same call returns the repository id that hub recorded. Without that second half, "nothing changed" is satisfied by a lookup that never opened the hub, which is the narrowing that reports success.

- [ ] **Step 1: Append the failing test**

```js
// ── resolveSnapshot writes nothing, and takes no lock ───────────────────────
{
  const home = join(dir, "nw"); mkdirSync(join(home, "state"), { recursive: true });
  const repo = join(dir, "nwrepo"); mkdirSync(join(repo, "packages", "x"), { recursive: true });
  const prof = join(home, "np.json");
  writeFileSync(prof, JSON.stringify({ schemaVersion: 1, identity: { defaultBranch: "main", visibility: "private" },
                                       builder: { founder: { userId: 4242 } } }));
  const entry = { nwo: "o/r", repoPath: repo, profilePath: prof };
  const registry = { version: 7, projects: { nextly: entry } };

  const db = openHub(hubPathFor(home));
  // A real admitted task, so the hub HAS an id to answer with -- the positive
  // control that makes "nothing changed" mean something.
  db.prepare(
    `INSERT INTO task(id, project, repo_id, nwo_snapshot, title, phase, generation,
                      source_kind, source_key, repo_path, profile_path, profile_hash,
                      default_branch, visibility, registry_version, created_at, updated_at)
     VALUES('bt:n','nextly',77,'o/r','t','FILED',1,'founder','k','/r','/p','h','main','private',1,
            unixepoch(),unixepoch())`).run();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const census = () => Object.fromEntries(tables.map(t =>
    [t, db.prepare(`SELECT count(*) c FROM "${t}"`).get().c]));
  const before = JSON.stringify(census());
  db.close();

  const io = registryIo(home, "nextly", entry, { lsTree: () => ({ mode: "040000" }) });
  const snap = await resolveSnapshot(registry, "nextly", [normalizeClaim("packages/x")], io);

  const after = openHub(hubPathFor(home));
  // THE POSITIVE CONTROL, and it is the half that makes the negative mean
  // anything: "no row changed" is also true of a lookup that never opened the
  // hub. So prove the read reached the hub before believing that nothing moved.
  // (The previous form here asserted `JSON.stringify(census.call(null)) !==
  // undefined`, which is true of every value JSON can encode -- and `census`
  // closes over a db that is closed by this point, so it would have thrown
  // rather than passed. An assertion that cannot fail is not a control.)
  check(!snap.refusal && snap.repoId === 77,
    "control: the snapshot really was resolved, and carries the repo id the hub recorded",
    JSON.stringify(snap));
  const now = JSON.stringify(Object.fromEntries(tables.map(t =>
    [t, after.prepare(`SELECT count(*) c FROM "${t}"`).get().c])));
  check(now === before, "resolving a snapshot changed no row in any hub table", `${before}\n        ${now}`);
  check(after.prepare("SELECT count(*) c FROM writer_lease").get().c === 0 &&
        after.prepare("SELECT count(*) c FROM maintenance_lock").get().c === 0,
    "and took neither the writer lease nor the maintenance lock");
  after.close();
  // THE POSITIVE CONTROL, and without it "nothing changed" is satisfied by a
  // resolver that never opened the hub at all.
  check(snap.repoId === 77, "control: and it DID read the hub, returning the admitted id", String(snap.repoId));
}

// ── and it cannot write, because it was handed no way to ────────────────────
{
  const home = join(dir, "gw"); mkdirSync(join(home, "state"), { recursive: true });
  const repo = join(dir, "gwrepo"); mkdirSync(repo, { recursive: true });
  const prof = join(home, "gp.json");
  writeFileSync(prof, JSON.stringify({ schemaVersion: 1, identity: { defaultBranch: "main", visibility: "private" } }));
  const entry = { nwo: "o/r", repoPath: repo, profilePath: prof };
  openHub(hubPathFor(home)).close();

  let attempted = null;
  // `DatabaseSync` is imported at the top of the file, beside the other imports.
  // An inline `await import(...)` here does NOT work: this arrow is not async,
  // and `await` in a non-async function is a syntax error, so the file would
  // fail to parse and every assertion in it would be skipped rather than red.
  const guarded = (path) => {
    const real = new DatabaseSync(path, { readOnly: true });
    return {
      prepare: (sql) => {
        if (!/^\s*SELECT\b/i.test(sql)) { attempted = sql; throw new Error("a lookup may not write"); }
        return real.prepare(sql);
      },
      exec: (sql) => { attempted = sql; throw new Error("a lookup may not exec"); },
      close: () => real.close(),
    };
  };
  const io = registryIo(home, "nextly", entry, { connect: guarded, lsTree: () => ({ mode: "040000" }) });
  const snap = await resolveSnapshot({ version: 1, projects: { nextly: entry } }, "nextly",
    [normalizeClaim("packages/x")], io);
  check(!snap.refusal, "a snapshot resolves through a handle that refuses every write", String(attempted));
  check(attempted === null, "and no write was ever attempted", String(attempted));
}
```

`guarded` needs `DatabaseSync` at module scope. Add it to the file's existing import group; the whole helper then reads:

```js
import { DatabaseSync } from "node:sqlite";
// ... inside the block:
  const guarded = (path) => {
    const real = new DatabaseSync(path, { readOnly: true });
    return {
      prepare: (sql) => {
        if (!/^\s*SELECT\b/i.test(sql)) { attempted = sql; throw new Error("a lookup may not write"); }
        return real.prepare(sql);
      },
      exec: (sql) => { attempted = sql; throw new Error("a lookup may not exec"); },
      close: () => real.close(),
    };
  };
```

**Why this is spelled out rather than left to the executor.** An `await` inside a non-async arrow is a *parse* error, so the file does not run at all -- and a test file that does not parse reports no failures, which reads exactly like a test file that passed. That is the same shape as every other entry in this plan's controls: the failure is silent in the direction that looks like success.

- [ ] **Step 2: Run it red, then green**

```bash
$N test/registry-io.test.mjs
```

Expected on the first run, before Task 8's `connect` pass-through is in place: `a snapshot resolves through a handle that refuses every write` fails, because `registryIo` ignored `connect` and used the real opener. With Task 8's `connect ? { fetchRepoId, connect } : { fetchRepoId }` in place, all five assertions pass.

**On the broken implementation** — the shape guarded against is a `registryIo` that opens the hub with `openHub` instead of delegating to `resolveRepoIdAt`. `openHub` **migrates**: it applies every pending migration before answering. Against it, `resolving a snapshot changed no row in any hub table` goes red (the `schema_version` row count moves on a hub below the current version) while `control: and it DID read the hub` stays green — the pair that separates "did not look" from "looked and wrote". The second shape is an io that never opens the hub: `control: and it DID read the hub, returning the admitted id` goes red **alone**, and the two absence assertions stay green, which is precisely why that control is not optional.

**The stub loop for this task**: (1) control — the file green; (2) stub applied and verified — replace `resolveRepoIdAt(hubPath, …)` in `registryIo` with `openHub(hubPath)` followed by the same query, confirming with `grep -n openHub src/build/registryio.mjs`; (3) the RIGHT assertion red — `resolving a snapshot changed no row in any hub table`, with the read control still green; (4) restore by `cp`, re-run green.

- [ ] **Step 3: Commit**

```bash
$N test/registry-io.test.mjs      # expect all green
git add test/registry-io.test.mjs
git commit -m "test(build): resolveSnapshot writes nothing and takes no lock"
```

---

### Task 10: The tick refreshes a gate-state row from the rows the loader really produces

**Files:**
- Test: `test/hub-gatestate.test.mjs` (append before the terminator — the final `db.close();` / `}` / `rmSync` / `console.log` / `process.exit` group)

**Interfaces:**
- Consumes: `buildTick(ctx)` (`src/build/loop.mjs:36`); `parseRegistry` (Task 6); `resolveRepoId` (`src/build/repoid.mjs:83`); `isSameProcess` (`src/supervisor.mjs`).
- Produces: no code. `src/build/loop.mjs` is unchanged.

**What this proves, and what the brief said it would.** The brief's T2 Verify reads *"`buildTick` refreshes a real gate-state row for a fixture project for the first time (`src/build/loop.mjs:44-52` says today it never has)"*. Measured at `16cd880`, that is **already true and already asserted**: `test/hub-gatestate.test.mjs:313-314`, *"a registry-shaped project is refreshed, not skipped"*, is green today, and the comment at `loop.mjs:42-59` is a record of a defect S2-C already fixed by resolving the id from the hub. The remaining gap is narrower and real: that block feeds `buildTick` a **hand-written** `{ name, nwo }` literal, and a fixture richer or poorer than production is exactly what let the original defect survive every assertion. This task closes it by feeding the tick the loader's real output, and by asserting the daemon path's liveness argument rather than its default.

- [ ] **Step 1: Append the failing test**

```js
// ── the tick, fed by the LOADER rather than by a literal ────────────────────
{
  const db3 = openHub(join(dir, "g-loader.db"));
  const reg = parseRegistry(JSON.stringify(
    { nextly: { nwo: "o/r", repoPath: "/repo", profilePath: "/p.json" } }), "/x/projects.json");
  check(reg.error === null, "control: the fixture registry parses", String(reg.error));
  const admitted = { repoId: 1, nwo: "o/r", repoPath: "/repo", profilePath: "/p.json", profileHash: "h",
                     defaultBranch: "main", visibility: "private", specRepoId: 9,
                     gateDefinitionHash: "g", registryVersion: reg.registry.version, founderUserId: 4242 };
  admitResolved(db3, admitted, { id: "bt:loader", project: "nextly", title: "t",
                                 claims: [normalizeClaim("packages/x")] });
  const tick = await buildTick({ hub: db3, projects: reg.projects });
  check(tick.refreshed === 1 && tick.skipped.length === 0,
    "the loader's own rows are refreshed, not skipped", JSON.stringify(tick));
  const row = db3.prepare("SELECT repo_id, nwo_snapshot FROM repo_gate_state").get();
  check(row?.repo_id === 1, "and the row is keyed on the id the hub recorded at admission", JSON.stringify(row));
  // The richer row carries two fields the tick does not read. Asserting it is
  // unbothered is the difference between "production's shape works" and "a
  // narrower shape works and production was never tried".
  check(Object.keys(reg.projects[0]).length === 4,
    "control: and those rows really do carry four fields, not two", JSON.stringify(reg.projects[0]));
  // A project the loader lists and the hub has never seen is still skipped, or
  // "resolves the id" has become "invents one".
  const two = parseRegistry(JSON.stringify(
    { nextly: { nwo: "o/r", repoPath: "/repo", profilePath: "/p.json" },
      other:  { nwo: "o/never", repoPath: "/repo2", profilePath: "/p2.json" } }), "/x/projects.json");
  const mixed = await buildTick({ hub: db3, projects: two.projects });
  check(mixed.refreshed === 1 && mixed.skipped.includes("other"),
    "control: an unknown project is skipped and NAMED, not fabricated", JSON.stringify(mixed));
  db3.close();
}
```

`parseRegistry` is already imported by this file from Task 7.

- [ ] **Step 2: Run it, then commit**

```bash
$N test/hub-gatestate.test.mjs      # expect all green
```

**On the broken implementation** — the shape guarded against is a `buildTick` that reads a project's fields positionally, or a loader whose rows silently lose `repoPath` and `profilePath` between Task 6 and here. Against the second, `control: and those rows really do carry four fields, not two` goes red alone and every behavioural assertion stays green, which is the honest reading: the tick does not care, and the assertion exists to say the fixture is production's shape rather than a convenient subset. Against a `resolveRepoId` that fabricated an id, `control: an unknown project is skipped and NAMED` goes red while `the loader's own rows are refreshed` stays green.

**The stub loop for this task**: (1) control — the file green; (2) stub applied and verified — in `src/build/registryio.mjs`, drop `repoPath` and `profilePath` from `parseRegistry`'s returned rows, confirming with `grep -n "repoPath: p.repoPath" src/build/registryio.mjs` returning nothing; (3) the RIGHT assertions red — `control: and those rows really do carry four fields, not two` here **and** `and every row carries the repository path and the profile path` in `test/registry-io.test.mjs`, with every `buildTick` assertion still green; (4) restore by `cp`, re-run both files green.

```bash
git add test/hub-gatestate.test.mjs
git commit -m "test(build): the tick refreshes from the loader's real rows"
```

---

### Task 11: PR-A2 close-out — freeze the registry entry contract, tracker, PR

**Files:**
- Create: `test/fixtures/registry-entry-v1.json`
- Modify: `test/registry-io.test.mjs` (append before the terminator), `tasks/reeve-tasks/trackers/s3.md` (**last commit only**)

- [ ] **Step 1: Freeze both halves of the entry contract**

Two halves, and they fail differently: the **required fields** a registry entry must carry, and the **snapshot fields** the io must be able to fill. A freeze over one says nothing about the other.

```bash
$N -e '
  const { writeFileSync } = await import("node:fs");
  const { SNAPSHOT_FIELDS } = await import("./src/build/phases.mjs");
  const { parseRegistry } = await import("./src/build/registryio.mjs");
  const row = parseRegistry(JSON.stringify(
    { p: { nwo: "o/r", repoPath: "/r", profilePath: "/f" } }), "/x").projects[0];
  writeFileSync("test/fixtures/registry-entry-v1.json",
    JSON.stringify({ version: 1, frozen_at: "2026-08-27",
                     row_fields: Object.keys(row).sort(),
                     snapshot_fields: [...SNAPSHOT_FIELDS].sort(),
                     note: "widening either half is deliberate: update this fixture in the same commit"
                   }, null, 2) + "\n");
  console.log(JSON.stringify(Object.keys(row).sort()), SNAPSHOT_FIELDS.length + " snapshot fields");
'
```

Append to `test/registry-io.test.mjs`, before its terminator:

```js
// Both halves frozen. A row field added without a snapshot field is a value
// nothing consumes; a snapshot field added without a row field is an admission
// that can never complete. Neither freeze can see the other's half.
{
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/registry-entry-v1.json", import.meta.url), "utf8"));
  const row = parseRegistry(JSON.stringify(
    { p: { nwo: "o/r", repoPath: "/r", profilePath: "/f" } }), "/x").projects[0];
  check(Object.keys(row).sort().join(",") === frozen.row_fields.join(","),
    "freeze: a registry row carries exactly the fields it was frozen with",
    `${Object.keys(row).sort().join(",")} vs ${frozen.row_fields.join(",")}`);
  check([...SNAPSHOT_FIELDS].sort().join(",") === frozen.snapshot_fields.join(","),
    "freeze: and SNAPSHOT_FIELDS is unchanged, which is the other half",
    `${[...SNAPSHOT_FIELDS].sort().join(",")} vs ${frozen.snapshot_fields.join(",")}`);
}
```

**Run the stub loop once per half**, because a freeze verified only against the half it already covered proves nothing about the half that was added:

1. Add `worktreeRoot: p.worktreeRoot` to `parseRegistry`'s returned row; re-run; expect `freeze: a registry row carries exactly the fields it was frozen with` **red** and the snapshot half **green**. Restore by `cp`; re-run green.
2. Append `"ledgerName"` to `SNAPSHOT_FIELDS` in `src/build/phases.mjs`; re-run; expect the snapshot half **red** and the row half **green**. Restore by `cp`; re-run green — and re-run `test/hub-phases.test.mjs` too, which reads that constant.

- [ ] **Step 2: Full suite**

```bash
fail=0
for f in test/*.test.mjs; do
  case "$f" in */escape.test.mjs) continue;; esac   # writes into the LIVE daemon's ~/.reeve/canary
  $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
done
# NONZERO on red. `|| echo` turns a failing node process into a SUCCESSFUL
# command, so this loop exited 0 with any number of red files -- and it is the
# mandatory pre-commit gate, so an executor checking the command status commits
# on a suite that just failed. The flag is set inside the loop because a
# pipeline's status is its last command's, and the last command here is `done`.
[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
```

Expected: no `FAILED` lines. 94 files after PR-A1, plus `test/registry-io.test.mjs` — 95.

And the live-machine check, which is a **read** and safe to run beside the daemon:

```bash
$N -e '
  const { loadRegistry } = await import("./src/build/registryio.mjs");
  const r = loadRegistry(process.env.HOME + "/.reeve");
  console.log("projects:", r.projects.length, "| error:", r.error ?? "none");
'
```

Expected on 2026-08-27: `projects: 0 | error: /Users/…/.reeve/projects.json: ENOENT…` — **no registry file exists on this machine**, measured. That is the honest state and it is not a failure of this PR: it is the reason `builder doctor` emits H-7 today, and it is what founder input F1 fills. Record whatever this prints in the PR body.

- [ ] **Step 3: The tracker line, as the LAST commit**

In `tasks/reeve-tasks/trackers/s3.md` §1, set T2's PR number and STATE to **BUILT** — never MERGED, for the same reason as Task 5. And add one row to §4, because a decision taken during the stage belongs in the tracker and not in this plan:

> 10. **2026-08-27 — `registryProjects` lands in `src/build/registryio.mjs`, not in `src/build/registry.mjs`.** `test/hub-registry.test.mjs:100-103` walks `registry.mjs`'s import graph and asserts it reaches no filesystem or network module; that assertion is what makes *"`admitTask` performs no I/O"* a capability property rather than a discipline claim, and a `readFileSync` in that file turns it red. The brief's §2.2 T2 names `registry.mjs`; the source disagrees and the source wins.

Then, in §2, leave F1 **open** and add to its row that T2 shipped with `specRepoId` and `gateDefinitionHash` resolving `null` and named in the refusal, so no live filing can succeed until F1 is answered.

```bash
git add tasks/reeve-tasks/trackers/s3.md
git commit -m "docs(s3): tracker -- T2 built, and where the brief and the source disagreed"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/s3-registry-io
gh pr create --title "S3 T2: the registry entry, and a real io for resolveSnapshot" --body-file - <<'BODY'
## What

The registry loader moves out of `bin/reeve` into `src/build/registryio.mjs`,
keeping the malformed-entry-is-an-error discipline verbatim and adding
`repoPath` and `profilePath` as required fields. A nine-member `io` for
`resolveSnapshot`, every member injectable, every default local: repository ids
come from the hub or from an injected fetcher, and every other field is read
from the profile the entry names or from the checkout.

No GitHub call anywhere. `resolveSnapshot` still writes nothing to the hub and
takes no lock, asserted two independent ways.

## Decisions taken in this PR

- **The loader lands in `registryio.mjs`, NOT in `registry.mjs`.** The design
  brief says `registry.mjs`; `test/hub-registry.test.mjs:100-103` walks that
  module's import graph and asserts it reaches no filesystem module, which is
  what makes "admitTask performs no I/O" a capability property. `registry.mjs`
  is untouched by this PR.
- **The `io` has NINE members, not eight.** `resolveClaims` treats `lsTree` as a
  precondition and refuses every claim without it; an eight-member io refuses
  every filing.
- **`registryVersion` is derived from the registry's CONTENT**, sorted, as a
  48-bit fingerprint. Section 1.5's format carries no version field, and mtime
  changes when nothing did.
- **`specRepoId` and `gateDefinitionHash` resolve `null`, never a placeholder.**
  `missingSnapshotFields` filters on `== null`, so a `0` would complete a
  snapshot while naming a repository that does not exist. Founder input F1 is
  what fills them; until then a live filing is refused, by name.
- **`src/doctor.mjs` is unchanged.** H-7 is emitted at the route in `bin/reeve`,
  deliberately, and `hubFindings` reads only `p.nwo`.

## Review focus

- `test/hub-doctor.test.mjs`: the well-formed fixtures gained two fields and the
  malformed ones did not. Please check no fixture that is meant to be malformed
  was accidentally repaired.
- The no-write proof in `test/registry-io.test.mjs` has two halves and a positive
  control. Please check the control is load-bearing: without it, "nothing
  changed" is satisfied by a resolver that never opened the hub.
- The derived registry version. If a hand-maintained field is preferred, say so
  now: it is one function and it changes what every admitted task records.
BODY
gh pr comment --body "@codex review"
```

- [ ] **Step 5: Work the gate**

As in Task 5, Step 5. Comment `@codex review` on every push; read both endpoints; reply to and **resolve** every thread via GraphQL; apply the taper rule at ten rounds.

**Do not merge.** Founder grant required.

---

---

## Self-review

**Spec coverage.** §1.5 `:69` — *"Every new profile key (all `builder.*` knobs) is added to the profile `FIELDS` validator **first**"* — is what orders this document, and Tasks 1 and 2 discharge it for every key S3 reads: §4.1 `:290`'s six-field budget object for the three phase actions, §5 `:335`'s `maxPackages`, §10.2 `:558`'s `starvedHours`, §10.3 `:562`'s `maxConcurrentTasks` and §10.4 `:569-572`'s four scheduler knobs. §11.6's *"Profile documentation and examples are generated from the validator"* is Task 4. §1.4's switches gain their single reader in Task 3. §1.5's registry snapshot — *"repository numeric id and nwo snapshot, repo path, profile path and profile hash, default branch, visibility, spec repository numeric id, gate-definition hash, and registry version"* — is Tasks 6 and 8, and its eleventh field, `founderUserId`, comes from the profile because §5 authorises depth overrides against the founder's immutable numeric id. **No Verify row of §14 is satisfied by this document**, which is stated in the Verify table rather than implied: S3-A declares the keys the measurements write into and the snapshot a task is admitted from, and nothing here dispatches, measures or files.

**Placeholder scan.** Clean. No `TBD`, no "add appropriate error handling", no "similar to Task N", and every symbol referenced is defined either by a task in this document or at a `file:line` verified at `16cd880`. Two things that could be mistaken for placeholders are deliberate and are labelled: the Verify table's cells name a plan document and a T-id instead of a task number, because task numbering restarts per document and S3-C/D/F are unwritten — that deficit is stated in the table's own preamble; and `specRepoId`/`gateDefinitionHash` resolve `null` in Task 8, which is not a stub but the fail-closed answer founder input F1 replaces, asserted as a refusal that names both fields.

**Type consistency.** `FIELDS[key] -> [required: boolean, check: (v) => string|null]` throughout, which is the existing contract; `BUDGETS` and the two integer validators return `string|null` like every other. `CAPABILITY_KEYS: readonly string[]`, `capabilitiesFrom(profile) -> Readonly<Record<string, boolean>>` — the exact shape `leaseEffect`'s `capabilities` option takes — and `capabilityOn(profile, name) -> boolean`, throwing on an undeclared name. `parseRegistry(text, path) -> {projects: Array<{name,nwo,repoPath,profilePath}>, registry: {version: number, projects: Record<string, entry>}, error: string|null}`, with `loadRegistry(home, {readFile}) -> ` the same shape; the CLI reads `.projects` and `.error`, `resolveSnapshot` takes `.registry`, and the two never diverge because one call produces both. `registryIo(home, project, entry, opts) -> io` with nine members, seven async and two synchronous, matching what `resolveSnapshot` (`registry.mjs:194-212`) and `resolveClaims` (`:123-176`) actually call. `profileReference(source?) -> string`, `noteFor(source, key) -> string`.

**Where this plan and the design brief disagree, and what the source says.** Six places, each measured at `16cd880` rather than inherited. (1) `registryProjects` cannot move into `src/build/registry.mjs`: `test/hub-registry.test.mjs:100-103` asserts that module's import graph reaches no filesystem module, and the loader is built on `readFileSync`. (2) The `io` needs `lsTree` as a ninth member; `resolveClaims:152-155` refuses without it. (3) `H-7` lives at `bin/reeve:1105`, not in `src/doctor.mjs`, which this plan therefore does not modify. (4) The `builder.*` seed lives in `UNIVERSAL_DEFAULTS` at `src/profile/schema.mjs:444`, not in `src/init.mjs`; `init.mjs`'s real gap is `ORDER` at `:40`, which names neither `builder` nor `worker`. (5) `buildTick` already refreshes a gate-state row for a registry-shaped project — `test/hub-gatestate.test.mjs:313` is green today — so Task 10 proves the narrower and still-true thing: that it does so from the loader's own rows. (6) Two test files the brief's T2 file list omits, `test/hub-gatestate.test.mjs` and `test/hub-doctor.test.mjs`, carry assertions that go red on T2's change and are fixed in the same commit that causes them.
