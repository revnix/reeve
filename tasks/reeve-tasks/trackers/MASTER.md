# reeve builder — MASTER TRACKER

**One screen. Where each stage stands, and what needs the founder.** Every detail lives in the
per-stage file. If something here takes more than one line, it belongs in that file instead.

**Roadmap and authoring rules:** `../MASTER-PLAN.md`. **Spec:** `docs/2026-08-21-builder-design.md`.
**Historical record, untouched:** `docs/TRACKER.md` — it is the programme's history and is not
maintained here. Do not edit it to agree with this file.

**How to re-derive any STATE below**, so no row is trusted from memory:

```bash
git log --format='%s' origin/main | grep -c '(#'          # 38 squash subjects at 16cd880
git log --format='%h %s' origin/main | grep -E '\(#44\)$' # one PR's squash SHA
```

That grep is **not complete on its own**: PR **#3** merged before the `(#N)` subject convention
existed and its squash SHA (`0d31350`) carries no number. Verified 2026-08-27 by
`gh api repos/revnix/reeve/pulls/3 --jq .merge_commit_sha` and `git merge-base --is-ancestor`.
Any other pre-convention PR would be invisible the same way; the count above (38) against 42
merged PRs is the measure of how many.

**Last verified:** 2026-08-28, `main` = **`36b4107`**. It moved twice during the S3 planning
session (`c500cfe` → `16cd880` → `36b4107`); #54 was workflow-only so no source anchor moved.
**`revnix/reeve` is PUBLIC** since 2026-08-27 — a closed founder decision, see `s3.md`.

---

## Stages

| Stage | STATE | PRs | Tracker | Blocked on |
|---|---|---|---|---|
| S0 Amend the design, freeze authority | **MERGED** | #3 | `s1.md` | — |
| S1 The worker boundary | **MERGED** | #3, #4, #5 | `s1.md` | — |
| S2 Hub core | **MERGED** | #20, #30, #35, #40, #44, #53 | `s2.md` | — |
| **S3 Founder-filed read/report phases** | **PLANNED** | none yet | `s3.md` | two pre-PRs (below) |
| S4 Private spec PR and the gate | NOT STARTED | — | — | S3 |
| S5 Ledger hardening, then intake | NOT STARTED | — | — | S4 |
| S6 Local implementation | NOT STARTED | — | — | S5 |
| S7 PR publication, receipt import | NOT STARTED | — | — | S6 |
| S8 Dark merge coordinator | NOT STARTED | — | — | S7 **and a founder decision in the guardian programme** (the `ops/merge-policy` required-check flip). Not this programme's to schedule. |
| S9 Shadow, chaos, replay eval | NOT STARTED | — | — | S8 |
| S10 Supervised canaries | NOT STARTED | — | — | S9 + the 21-item gate at `design:842-864` |
| S11 Ubuntu parity | NOT STARTED | — | — | S10 |
| S12 Windows parity | NOT STARTED | — | — | S11 |

STATE is one of exactly five words: **NOT STARTED · PLANNED · IN FLIGHT · MERGED · ABANDONED.**
A stage is MERGED only when every row of its Verify table names a file that exists and is green.

---

## In flight right now

| what | who | where |
|---|---|---|
| The foundation — this commit | this lane | `reeve#58`, in review — **6 codex review objects, 42 threads**; the latest round's 6 findings are fixed in this commit |
| The merge verifier, split out of #58 | this lane | `reeve#60`, in review — **3 codex review objects, 11 threads**; the latest round's 4 findings are being fixed there |
| The six S3 stage plans — **written, not yet in a PR** | this lane | branch `docs/s3-foundation`; they land one at a time (decision 17) |

**S3's eleven documents are complete.** Six plans (14,167 lines, 78 tasks), a master plan, an
implementation prompt and five trackers.

**P1 is DONE** — `reeve#57` merged as `89c4af6`, verified by content; the suite went 550s → 303s
and `test/offline-tests.test.mjs` guards the relapse. Its claim is RELEASED.

**The next action is P2 — issue `reeve#50`**, extracting the guardian's provider/hub session out
of `tick()`. It is unclaimed. The design is written and reviewed
(**not in this commit** — it lands with the S3 plan family; until then the design is the body of
issue `reeve#50` itself, which states the six rules and the acceptance test). Measured on
`a529096`, `tick()` is **2,282 lines** and has
grown 14% since the issue naming it was filed. **T1 does not start until P2 merges.**

Claims are one file each under `claims/`. **Read `claims/README.md` before starting anything.**

---

## ⚠ Needs the founder

| # | What | Blocks | Asked |
|---|---|---|---|
| F4 | **Six defaulted answers may be overridden** — worker isolation, instruction-file neutralization, the V6 measurement shape, whether S3 flips `observe` live, escalation-versus-paging, and the `--json` contract. Each was defaulted to the brief's recommendation and recorded so an override is cheap. | **Blocks nothing.** *Affects* S3 T7, T8, T15, T16 — reversibly | 2026-08-27, recorded in `s3.md` §2 |
| F5 | **Create the three spec repos** — F1 named them; none exists yet. Private, one per project. | **S3 T2** | 2026-08-27 |

**Only a row whose `Blocks` cell names a task actually stops work.** A *defaulted* question does
not: `../IMPLEMENTATION-PROMPT.md` Phase 1 says a question with a recorded default is
non-blocking and must be proceeded under, naming the default in the PR body. F4 sat in this table
with four task ids in its `Blocks` cell, which would have halted four tasks waiting for answers
the workflow says they do not need. **F5 is the only genuine blocker.**

### Answered 2026-08-27

| # | What | Answer |
|---|---|---|
| F1 | Name the spec repos | **Create them, one per project, named `<project>-specs`**: `revnix/reeve-specs`, `nextlyhq/nextly-specs`, `revnix/rext-specs`, all private. Rejected, with the reason recorded so it is not reopened: **one shared repo** fails because `specRepoId` is a numeric GitHub id **per project**, so three projects sharing one id makes the snapshot stop distinguishing them — which fights the design's own identity model (§11.1, *"immutable numeric GitHub ids… with human-readable snapshots beside them"*); **reusing the code repos** fails because spec PRs would land beside code PRs, which is exactly the separation S4's gate depends on. |
| F2 | Arm `--execute` on the live guardian? | **Leave it off for now.** S3's first code PRs (T7, T8) modify files the running daemon executes, so arming before those merge means a live daemon acting on code that is mid-change. Revisit after T8 merges. The #52 gate itself is lifted — this is a separate, deliberate decision not to arm. |
| F3 | The 15-minute watcher loop | **STOPPED**, 2026-08-27; job `0011c181` cancelled. Nothing of this lane's was open. A watcher with no subject reports "quiet" every fifteen minutes, and quiet-with-no-subject is the exact reading that let a 22-hour CI outage go unremarked. **Restart it when S3's first PR opens.** |

---

## Programme-level standing decisions — do not re-litigate

1. **Never merge without an explicit per-PR grant.** Grants never carry over. Re-verify CI and
   threads **at the moment of merge**. Verify a merge **by CONTENT** — tree hash or file blobs
   — **never by ancestry**, because this repo squash-merges.
2. **The merge rule is "CI green AND zero open threads"**, reaffirmed by the founder 2026-08-25
   over a recommendation to tighten it. Measured consequence, recorded so it stays a decision:
   **25 of 40 PRs merged with the last verdict still carrying findings**, 47 threads open at
   merge, four with no reply and no deferral record.
3. **The stage order is a hard sequence.** No stage starts before the previous one is green.
4. **Nothing merges a *builder* PR before S10.** reeve's own PRs are a different thing (rule 1).
5. **The taper rule** (founder, 2026-08-26): ten review rounds without the findings tapering
   means stop and bring the shape, not the next fix.

---

## Closed by ruling — do not reopen

| ruling | date | why it is closed |
|---|---|---|
| **S3 splits into six plan documents**, at most three or four **PRs** each | 2026-08-27 (cap unit corrected 2026-08-28) | The three S2 *plan* PRs produced 561 of 1,282 findings (43.8% of every finding this repo's review has ever produced). PR#12 was one file, 213 findings, 15 rounds. **The unit is PRs, and it moved twice** — "lines", then "plan tasks", which is arithmetically impossible against the committed decomposition of **78 tasks across 6 documents** (3–4 tasks each allows 24). A PR holds several tasks; S3's 78 are 16 PRs. Reasoning in `../MASTER-PLAN.md` §B.1. |
| **The master plan is roadmap + authoring spec in ONE file** | 2026-08-27 | So they cannot drift apart. |
| **`docs/TRACKER.md` is untouched as the historical record**; per-stage trackers hold live state | 2026-08-27 | 10 of its 20 unchecked boxes sit on merged work; the format, not the file, was the defect. |
| **Issue #50 lands before S3's dispatcher** | 2026-08-27 | S3's T8 is the second call site that makes #50's own acceptance test writable. |
| **The test suite's dead network is fixed in a standalone PR before T1** | 2026-08-27 | 550.1s → **159.8s** measured with a control; it is the instrument S3 is measured with sixteen times. **That 159.8s is the ceiling a whole-suite `gh` shim reached, and it is not what shipped:** `reeve#57` stubbed the two files carrying 84.5% of the calls and delivered **550s → 303s**. Budget against **303s**; the remaining gap is the other nine files, and `hub-backup-restore` is real SQLite work, not network. |
| **`specRepo` and `gateDefinitionPaths` are provisioned now** (Option A) | 2026-08-27 | Splitting `SNAPSHOT_FIELDS` re-opens the shape it was consolidated to close. F1 named the repos; now blocked on **F5**, their creation. |
| **The builder always shares the guardian's hub** | 2026-08-27 | So an absent hub on a builder PR is the merge authority being gone, not an ordinary machine. |
| **Stay headless**; `--json` becomes a contract, not a courtesy | 2026-08-27 | `src/dash.mjs` records why there is no server: a previous stack *"spent weeks serving unauthenticated admin to the LAN."* A future GUI is a second renderer over the same read model and must argue against that decision explicitly, not forget it. |
