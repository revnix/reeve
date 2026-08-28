# Resume prompt — 2026-08-27

> # ⛔ HISTORICAL. DO NOT PASTE THIS INTO A SESSION.
>
> **Superseded 2026-08-28. Every document it orders written now exists**, and following it would
> rewrite committed work: it says *"none has been started"* and instructs a fresh session to write
> the master plan, the trackers, the implementation prompt and all six stage plans in parallel —
> under the **superseded ~1,200-line cap**. That cap's unit has since moved twice: to tasks, and
> then to **PRs**, which is what `MASTER-PLAN.md` §B.1 and both live trackers now carry.
>
> **What is actually next** is in `trackers/MASTER.md` under *In flight* and *Needs the founder*,
> and the current rules are `MASTER-PLAN.md` Part B and `IMPLEMENTATION-PROMPT.md`. Start there.
>
> This file is kept, unedited below the banner, because it is the record of what was believed on
> 2026-08-27 — and because editing a superseded document into agreement with the present is what
> this programme's own correction discipline forbids. Read it as history, never as an instruction.

---

## The original prompt, as written on 2026-08-27

Everything between the rules is the prompt. It assumes nothing about what you remember.

---

Resume the reeve S3 planning work. **Do not trust any value in this prompt — read it.**
Facts here were true at `c500cfe` on 2026-08-27 and the repository moves.

## Read these first, in this order

1. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/HANDOFF-2026-08-27.md` — the full context,
   every decision, the remaining work. **Read it completely before doing anything.**
2. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/S3-DESIGN-BRIEF.md` — 1,068 lines. The
   product of a fourteen-agent audit (2.3M tokens, 678 tool calls, zero errors). It carries
   §14 verbatim, the sixteen S3 tasks with their files and Verify criteria, the house-style
   templates, and the evidence for every claim. **This is what you write from.**
3. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/S3-AUDIT-REPORTS.md` — 650KB, the thirteen
   raw agent reports. Consult when the brief compresses something you need in full.
4. For house style, read two existing plans in full before writing any:
   `docs/superpowers/plans/2026-08-23-s2a-hub-store.md` (6,328 lines, 13 tasks) and
   `docs/superpowers/plans/2026-08-23-s2c-provider-scheduler.md` (2,724 lines, 5 tasks).

## Where you are

- Worktree `~/Work/Products/reeve-wt/c4`, branch **`docs/s3-foundation`**, cut from `main`.
- **S2 is complete.** Six PRs merged: #20, #30, #35, #40, #44, #53. `main` is now
  **`16cd880`** — the peer merged #49 at 17:51:13Z, after `c500cfe`.
- #49 **merged**. The only open PR is **#54** `fix/ci-concurrency`; it is not yours either.
- Four open issues: **#43, #46, #50, #51**.
- **CI RECOVERED at ~2026-08-27T16:31Z after ~22 hours.** Measured: run `33068759549`,
  `run_attempt=2`, `completed/success`, `Test` 9 steps, `CI Gate` 3 steps. `main` is green.
  PR #54 `fix/ci-concurrency` landed in the window and is the plausible cause; **that is a
  correlation, not a measurement** — do not report it as the cause. The four-state
  discriminator in the handoff stays the instrument (**not** `jobs_with_steps == 0`, which is
  one step short), because the next outage will look identical to the last one.
- Test baseline: **re-measure it.** #49 added two test files, so the 91-file figure is one
  merge out of date; the current count is **93 runnable** (exclude `test/escape.test.mjs`;
  `REEVE_HOME` must point at a directory literally named `.reeve`). Use
  `~/.nvm/versions/node/v24.17.0/bin/node` — the PATH node is v22 and warns on `node:sqlite`.

## The task: write eleven documents

None has been started. Two audit files and the handoff are already committed on the branch.
Write in this order, because each fixes conventions the next one uses:

1. **`tasks/reeve-tasks/MASTER-PLAN.md`** — two parts in one file. Part A: the roadmap
   S3→S12, each stage with scope, gate, dependencies and state, taken from §14 verbatim.
   Part B: the authoring spec — the exact plan template, task-sizing rules with the measured
   evidence behind them, Verify conventions, the consumed-interfaces table, and what belongs
   in a plan versus a tracker. Brief §3.4 specifies it.
2. **`tasks/reeve-tasks/trackers/`** — `MASTER.md` (one screen: stage states and what needs
   the founder), `s3.md` (live task state), `s1.md` and `s2.md` backfilled from the record
   so the format has history, and `claims/README.md` describing the claim protocol. Brief
   §3.2 gives the format and the measured reasons it differs from `docs/TRACKER.md`.
3. **`tasks/reeve-tasks/IMPLEMENTATION-PROMPT.md`** — reeve-specific. Handoff §6 lists
   exactly what to carry over from the nextly prompt, what to replace, and the full claim
   protocol the founder asked for.
4. **`tasks/reeve-tasks/plans/`** — six documents, each capped at **~1,200 lines**:
   `2026-08-27-s3a-profile-and-registry.md` (T1–T2), `-s3b-filing-and-artifacts.md` (T3–T5),
   `-s3c-dispatch.md` (T6–T9, highest risk), `-s3d-phases.md` (T10–T12),
   `-s3e-operator-surface.md` (T13–T15), `-s3f-measurements.md` (T16).
   Brief §2.2 specifies every task completely — files, consumed interfaces, Verify criteria,
   dependencies, line budget. **Do not invent tasks; the decomposition is done.**

The six plans can be fanned out in parallel — each one's content is fully specified — but
read the two S2 plans for style first, and give every writer the same style reference so
the family does not drift, which is a defect the audit found in the existing set.

## Decisions already taken — do not re-litigate

Full table with reasoning in handoff §4. In short: files live at `tasks/reeve-tasks/` in the
reeve repo; S3 is **§14 verbatim including all six measurements**; the master plan is
**roadmap + authoring spec in one file**; per-stage trackers hold live state while
`docs/TRACKER.md` is untouched as the historical record; **six plan documents**, because the
three S2 plan PRs produced 43.8% of every review finding this repo has ever seen; **issue
#50 lands before S3's dispatcher**, because S3's dispatcher is the second call site that
makes #50's own acceptance test writable; **`specRepo` and `gateDefinitionPaths` get
provisioned now**; and **the test suite's dead network is fixed in a standalone PR before
T1** — 550.1s → 159.8s, measured with a control, PASS output byte-identical.

Six further questions were defaulted to the brief's recommendation and the founder may
override: worker isolation, instruction-file injection, the V6 measurement shape, whether
S3 flips `observe` live, escalation-versus-paging, and the `--json` contract. Handoff §4.

## Two PRs before T1

1. Fix the test suite's `gh` network — standalone, not folded into T1.
2. Issue **#50** — extract the provider/hub session from `tick()`, which is
   `src/daemon.mjs:956-3206`, **2,251 lines**, with **50** provider/hub touch points.

## How to work here

- **Never merge without an explicit per-PR grant.** Grants never carry over. Re-verify CI
  and threads *at the moment of merge*. **Verify a merge by CONTENT, never ancestry** — this
  repo squash-merges, so branch commits are never ancestors of `main`.
- **The four-check stub loop** on every fix: control green → stub verified applied → the
  RIGHT assertion red → restore byte-identical **by file copy, never `git checkout`**.
  *A stub that produces no failures means the property is untested.*
- **Never truncate a search you will reason about as a set.** Print the count first. **Every
  absence claim needs a positive control** — five instruments failed silently in the last
  session and every one was caught by a control, never by the output looking wrong.
- **Do not state an enumeration as complete.** Say what you searched and how.
- **Never `--no-verify`. No Claude attribution** anywhere, including squash-merge messages.
- **Never `git stash`** — the stack is shared across ~19 worktrees.
- **Do not** restart the reeve daemon, run `launchctl`, run `reeve canary`, or `git pull` in
  `~/Work/Products/reeve` — a live guardian runs from that checkout. `git fetch` is fine.
- **Tell the peer lane** (a session named `nextly-integrations-*`; use `ListAgents`) before
  touching `src/daemon.mjs`, `src/db/**`, `src/outbox/**`, `src/github/**`, `src/pr.mjs`,
  `src/verdict.mjs`, `src/watcher.mjs`, `src/review/**`, `src/prompts.mjs` — and always
  before changing the SHAPE of `computeVerdict`'s clause set or the ORDER of `nextAction`'s
  branches.
- **When you have a question**, use this structure: plain-English context → options with
  plain-English pros and cons and a concrete example in this codebase → an honest
  recommendation with reasoning → one clear line stating what you need decided.

## Open for the founder

Naming the spec repos (one private repo per project, for `specRepo`); whether to arm
`--execute` now that #52 is closed; and whether the 15-minute watcher loop should be
stopped, repointed at #50, or left as an outage watch.

---

**End of prompt.**
