# Resume prompt

Copy everything between the lines into a new session, started in
`~/Work/Products/reeve`.

---

We are continuing a build that is already running in production. **Read
`~/Work/Products/reeve/docs/HANDOFF.md` in full before doing anything else**,
including before asking me a clarifying question. Then read
`~/Work/Products/reeve/docs/USING-REEVE.md`, which is short and says what reeve
is *not*, and skim `docs/2026-08-21-review-ingest-design.md` §12 — the adversarial
attack ledger for the half you are most likely to touch.

Do not skim the handoff. Almost everything in it was learned by something going
wrong, and the details are the point.

## What this is, in one line

`reeve` is an agent-ops control plane (`github.com/revnix/reeve`, private) that
watches the pull requests my agent fleet opens, root-causes CI failures,
dispatches workers to fix them, and computes whether a PR is safe to merge — then
publishes that verdict so **GitHub** does the refusing.

**reeve is a GUARDIAN, not a BUILDER.** It does not pick work, research, design or
write features. A Claude session builds and opens the PR; reeve takes over from
there. If you find yourself planning to make reeve implement features, stop and
say so — that is a separate, undesigned programme (handoff §0).

## State as of 2026-08-21, end of session three

- **93 commits, 44 test files, 0 failing, CI green, `HEAD == origin/main`.**
- The daemon runs as `com.revnix.reeve` on `nextlyhq/nextly`, **observe-only**.
- **4 capabilities; 1 is on.** Watch ✓ · Fix CI ✗ · Work review threads ✗ ·
  Block merges ✗ (handoff §1).
- **Dispatch: 3 clean CI-verified runs across 2 failure shapes.** Not proof.
- **Review ingest PR-1..PR-4 built and running in shadow.** PR-5 is time-blocked
  on 5 clean shadow days, starting 22 Aug.
- Session three found **12 defects, 5 of them fail-opens live in production**, and
  every one was found by RUNNING the system, not reading it.

## Rules for how you work on this

1. **Measure, do not remember.** Run the command that establishes a fact before
   stating it. If you cannot, say so.
2. **Every absence search needs a positive control.** One that reports zero for
   everything is broken, not conclusive.
3. **A fix needs a test that fails on the broken code — and verify the stub
   applied.** Control green → stub verified applied → the RIGHT assertion red →
   restore verified. All four, every time.
4. **A fixture that cannot exhibit the defect proves nothing.**
5. **Read the WHOLE log before claiming an outcome.**
6. **If the same finding recurs after a fix, the fix was aimed at a symptom.**
   Remove the fallible read instead.
7. **UNKNOWN never merges. Absence is never success.** Not in a verdict, not in a
   metric, not in a status screen, not in a streak.
8. **An escalation key is an IDENTITY, not a report.** No counts, durations or
   paths in the key — they go in `detail`. This was fixed FOUR times in one day.
9. **Any new optional parameter guarding a safety rule ships with its call-site
   assertion in the same commit.** Four parameters silently switched off their own
   rule in one day (`reviewDiff.action`, `announceable.waiting`,
   `announceable.finished`, `derivePr.complete`).
10. **Never name reeve in a public or client repo.**
11. **Node on PATH is v22**; reeve needs `~/.nvm/versions/node/v24.17.0/bin/node`.
12. Conventional Commits, no attribution trailer of any kind.
13. Tell me plainly when something is unproven, half-finished or wrong —
    including your own work. I would rather hear it than have it look finished.

## The lessons that cost the most

**A signal that fires on non-events is not a signal.** Fixed four times in one
day: a count inside an escalation key, `WAIT` read as "resolved", a merged PR
whose escalation could never retire, and an audit that ran before the backup and
paged about a gap the same tick closed 54ms later.

**The defects that matter are found by USING the system, not reviewing it.** Two
of session three's worst were visible only in stored state — a `fix_attempt` row
and a projection's `complete` flag. Budget for use, not for review.

**A mechanism read and never written is worse than a missing one**, because the
next reader finds two and trusts the wrong one. `ctx.lastIngestIncomplete`
appeared exactly once in the file, on the read side, and made every truncated
observation into a confident projection.

## Settled decisions — do not reopen

- The Nextly product fleet is **PAUSED**.
- **No paid reviewer.** CodeRabbit Pro Plus explicitly declined.
- reeve **shells out to `claude`**; never the Agent SDK with a subscription token.
- reeve **never merges**; a worker **never publishes**.
- **Go, Rust and PHP command tables: NOT NOW** (founder, session three).
- **SPILL stays off indefinitely.** Escalation at the cap is the honest behaviour.
- **Advisory criticals block** — a P0 is a P0 whoever filed it.
- **`nextly-ops` stays.** It is still the live task graph.
- **Codex gets more weight than the other reviewers** — measured: 3,042 threads
  and 946 of the 992 criticals across 500 PRs.
- Direct commits to `main` on `revnix/reeve` are fine; I granted merge authority.

## First thing to do

Verify the system with **§11 of the handoff** — run those commands **separately**,
they exceed a two-minute tool timeout together. Then tell me what you found,
including anything that has drifted.

Expect `doctor` to report **BROKEN** on nextly. That is correct and stays true
until the ruleset is repaired, which is deliberately last. Expect
`reeve shadow nextlyhq/nextly` to exit **3** until 5 clean days accumulate.

## Then — the task I want next

**Feed the 500-PR study into the worker prompts** (handoff §7 and §9.1 item 1).
I approved this explicitly. The study measured what my reviewers actually catch
across 500 merged PRs in 11 days:

- **Functional Correctness 39.9%** plus **Data Integrity & Integration 15.7%** —
  together **56% of all findings**. Not style, not naming.
- **992 critical findings** (29.1% of 3,405 threads), roughly 90 a day.
- **Codex** filed 3,042 threads and 946 of the 992 criticals. Weight it highest.
- PR size predicts pain sharply: crossing ~10 files roughly **triples** review
  cost (1.34 → 4.29 average rounds).

Turn that into measured guidance in `src/prompts.mjs` — quoting what was measured,
not inventing advice. The raw data and analysis script are in the scratchpad under
`prstudy/`; if that is gone, `fetch.mjs` regenerates it (**request `body`, not
`bodyText` — the latter strips the image markdown both bots put severity in, and
that error made a first pass report 92% unknown severity**).

After that, in order — all unblocked, roughly 2 days total:

1. **Wire flake detection.** `flakeEvidence` in `ci-rootcause.mjs` is written,
   documented, and called by NOTHING — zero callers, zero log mentions. nextly's
   main is red on 6 of its last 9 runs, so the day capability 2 is armed reeve
   will pay an agent ~$2 to "fix" randomness and then page me about a failure
   that never existed.
2. **Dispatch evidence: the wrong-worker shape.** All 3 clean runs produced
   CORRECT fixes, so the second-attempt path has never been exercised by a
   genuinely bad one. ~$2 and an hour.
3. **The `release` lane is dead by construction** — its entire territory
   (`.changeset/**`, `scripts/release/**`) sits in `sensitivePaths`, and sensitive
   refuses BEFORE territory is checked, so that lane can never publish anything.
4. *If you judge them worthwhile:* a size warning at PR-open (>10 files → expect
   4+ rounds), and reinstating Greptile (58 threads, 45 critical — the best hit
   rate of the three, currently dark for want of credits).

Tell me which you would pick and why, then proceed — do not wait for me unless the
choice genuinely changes what gets built.

## What is blocked, so you do not go looking

- **PR-5 of review ingest** — needs `reeve shadow` at 5 clean days (≈26 Aug).
- **The ruleset flip** — needs 7 clean verdict-shadow days (≈28 Aug) AND my
  decision. The riskiest step in the programme: work in flight starts blocking and
  it will feel like reeve got worse. That is the moment a bypass gets reopened and
  the programme dies. **Do not skip the shadow week.**
- **The ntfy phone channel** — needs me. All five tokens on the publishing account
  are write-only, role `user`, no read grants, `/v1/users` returns 401. Creating a
  reader needs shell on `95.217.11.127`. Desktop notifications on this Mac already
  work and are unaffected.
- **A second project** (`rextaihq/rext-backend`) — needs PR-gating CI written and
  the App installed there.

---

## Optional replacements for the "Then" section

- *"Start with flake detection instead — `flakeEvidence` has zero callers and
  nextly's main is red 6 of its last 9 runs."*
- *"Start by proving the core/profile seam on `rextaihq/rext-backend`. Anything
  you must edit in the core to make it work was misfiled."*
- *"Start with the wrong-worker dispatch shape — I want to see what reeve does
  when an agent produces a confident bad fix, before anything is armed."*
