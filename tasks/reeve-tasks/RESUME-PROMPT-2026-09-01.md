# Resume prompt — paste the block below into a fresh session

Everything between the rules is the prompt. It assumes nothing about what you remember.

---

Resume the **reeve builder lane**. **Do not trust any value in this prompt — read it.**
Everything here was true on 2026-09-01 and this repository merged twelve pull requests in the
previous day.

## Read these first, in this order

1. On `main`: **`tasks/reeve-tasks/HANDOFF-2026-09-01.md`** — the full context. **Read it
   completely before doing anything.** It supersedes `HANDOFF-2026-08-30*.md`, which is stale
   and sends its reader to a task that has already completed. If it is not on `main` yet, it is
   in PR **#113**.
2. On `main`: **`tasks/reeve-tasks/plans/README.md`** — around forty recorded findings against
   the six S3 plans, each with the command that established it. **This is the most valuable file
   in the repository right now.** The plans are wrong in specific, recorded ways.
3. `tasks/reeve-tasks/IMPLEMENTATION-PROMPT.md`, and `trackers/s3.md` §4 (binding decisions)
   and §5 (durable findings).

## Where you are

- **`main` was `d7bc6bd`** and green. Re-read:
  `git -C ~/Work/Products/reeve-wt/vh log --oneline -1 origin/main`
- **One PR is mine: #110** `fix/artifact-followups`, the nine findings deferred from T4.
  Work its reviews first.
- **#111 and #112 belong to other lanes.** Do not touch them.
- **S3-A is complete; T3 and T4 are merged; T5 is next and unblocked.** Stage 3 stands at
  14 of 78 plan tasks. The only open issue is **#46**.
- Work in a fresh worktree off `origin/main`. Node is
  **`~/.nvm/versions/node/v24.17.0/bin/node`** — PATH node is v22 and several suites crash there.
  **`REEVE_HOME` must name a directory literally called `.reeve`.**

## Do this first

```
gh pr list --repo revnix/reeve --state open --json number,headRefName
```

`author` **cannot** identify a lane — the sessions share the account. **Identify by BRANCH.**
An empty list is a real answer **only** if the same query with `--state merged` returns rows.

Then: **check #110** and work any review findings, and afterwards start **T5**
(`feat/s3-report-schema`, S3-B's PR-B3, the phase report schemas).

## THE RULE THAT MATTERS MOST, before you write any checker

**Take a gate's fixture from the plan that PRODUCES the thing being gated, never from the plan
you are executing.**

T4 took eleven review rounds and 33 findings. The expensive ones were all one shape: **a fixture
encoding the implementation rather than the contract**, so the checker and its tests agreed with
each other and disagreed with the artifact. A guard that could never fire, because it keyed on
phase names while every real caller passes `BUILD_*`. A gate that found **zero slices** in the
artifact its own producer is specified to emit, and refused correct work.

**The four-check stub loop cannot see this.** It proves a checker *can* fail, not that it is
checking the right thing.

T5's schemas are consumed by S3-D's phase tasks. **Read
`plans/2026-08-27-s3d-phases.md` for the shapes those tasks emit BEFORE writing a schema.**

## How to work here

- **The four-check stub loop on every fix:** control green → stub proven by a **HASH CHANGE, not
  a grep** → the RIGHT assertion red → restore **byte-identical by file copy, never
  `git checkout`**.
- **Compare the stubbed run's ASSERTION COUNT against the control's.** A stub that throws aborts
  the file, and a truncated run looks exactly like the missing assertions having passed.
- **A stub that produces no failures means the property is UNTESTED.** An entry that cannot go
  red is worse than no entry, because it reads as a guard.
- **Run `node test/anchors-resolve.test.mjs`** — 107 anchors in 8ms — and run it after **every**
  stub-manifest conflict resolution, not only before pushing.
- **`test/stub-manifest.mjs` conflicts on every branch.** Take `origin/main`'s copy **WHOLE** and
  re-append your own entries once; extract them by NAME from **your side** of the conflict
  (`git show :2:<path>`). **That technique silently reverts your own unmerged fixes in that
  file** — the anchors gate is the only thing that catches it.
- **Every new test file needs a manifest entry**, and a grandfathered file loses its
  grandfathering the moment you MODIFY it.
- **Verify merges by CONTENT:** `node scripts/verify-merge.mjs <pr>`, and check `merged-head`
  equals `branch-now`. Four fixes were silently dropped that way in one day.
- **Full suite** excludes `test/escape.test.mjs`, with a `fail=0` accumulator. **Baseline: 116
  files, 0 red.** CI runs `npm ci && npm run lint` BEFORE the suite, so a fresh worktree needs
  the install.
- **`$?` after a pipe or a `$(…)` is not your command's status.** Capture it into a variable first.
- **Generate string literals rather than hand-escaping them** — `JSON.stringify` of the real
  source line.

## Hard rules

- **NEVER MERGE** without Mobeen's explicit per-PR grant; grants never carry over. Re-read CI
  **and** the unresolved-thread count immediately before merging — a PR is a moving object, and
  that check held four merges in one night, each of which would have shipped something real.
- **Never `git stash`** (the stack is shared across ~19 worktrees). **Never `--no-verify`**
  except in a detached scratch worktree that cannot reach a branch, and disclose it when used.
- **Do not** restart the daemon, run `launchctl`, run `reeve canary`, or `git pull` in
  `~/Work/Products/reeve` — a live guardian runs from it. `git fetch` is fine.
- No `as any`, no `@ts-expect-error`, no lint suppression. The lint rule bans reading
  `.pathname`; the fix is `fileURLToPath`, never a disable comment.
- Conventional Commits, lowercase, ≤72 characters. **No attribution trailer of any kind.**

## The other lanes

Find them with `ListAgents`; they are named `nextly-integrations-*`.

**Tell the guardian lane before touching** `src/daemon.mjs`, `src/db/**`, `src/outbox/**`,
`src/github/**`, `src/pr.mjs`, `src/verdict.mjs`, `src/watcher.mjs`, `src/review/**`,
`src/prompts.mjs`, `src/premerge.mjs`. **Stay out of** `tools/**`, `scripts/stub-sweep.mjs`,
`test/stubsweep.test.mjs`. The operator-surface lane holds T13 (merged) and T14, and touches
`bin/reeve`'s `task` read routes.

**Announce which task you are taking before writing a file.** All three lanes caught defects in
each other's work on 2026-08-31 that no single lane's green suite would have found.

## Reading a pull request's state

CI four-state, **in this order**: `pending` FIRST, then `dead`, then `ran` — the counters are
**not** mutually exclusive. Steps do **not** live on the check-runs endpoint; read them from
`actions/jobs/<id>`. A clean pass is an ISSUE comment carrying ``**Reviewed commit:** `<sha>` ``
— match with `/Reviewed commit:\W{0,4}([0-9a-f]{7,40})/`, because markdown emphasis and
backticks sit between label and sha. Codex **also** posts a summary comment that is **edited in
place**, so read `updated_at`. It reacts `eyes` while reviewing and **`+1` when a review finishes
with NO findings** — a pass can be a reaction with no comment at all. "Something went wrong" and
"usage limits" are **REFUSALS**, not passes. **Check every verdict's sha against the current
head.**

**BLIND IS NOT QUIET.** A read that fails is reported as unread, never as "nothing new".

Verify every finding against the source before acting — Codex has been right on essentially
every finding across eleven rounds, and wrong about scope once. **Fix the CLASS, not the
instance:** one finding named four columns, and following it as a class found fifteen. Then reply
to the thread **AND resolve it via GraphQL** (replying alone does not clear it), push, and
comment `@codex review`. Set a **15-minute watcher** on your open PRs if one is not running.

---

**End of prompt.**
