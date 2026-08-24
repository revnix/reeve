# Resume prompt — paste this into a new session

Supersedes `docs/2026-08-22-resume-prompt-2.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). Read these first, in this
order, and treat them as the source of truth over anything you infer:

  ~/Work/Products/reeve/docs/2026-08-23-session-handoff.md    <- START HERE
  ~/Work/Products/reeve/docs/TRACKER.md                       <- done / in flight
  ~/Work/Products/reeve/docs/measured/                         <- the measured facts

Ignore docs/2026-08-22-session-handoff.md (superseded banner) and treat
docs/2026-08-22-session-handoff-2.md as history.

## Read §0 of the handoff FIRST, then this

**This document contains no current facts, deliberately.** What is merged, whether
reeve is armed, what `main` is, which PRs are open — all of that lives in
`docs/2026-08-23-session-handoff.md` §0 and nowhere else.

That is not tidiness. The same three facts had been restated in about twenty
places across these two files, and six review rounds in a row found a correction
applied to one copy and left standing in the others. The sixth found this very
paragraph claiming the prompt held no state while three sections still did. Twenty
copies of a daily-changing fact will always drift, and patching whichever copy
review lands on only moves which one is wrong.

So: read §0 for STATE. Read this for what to DO and for the traps that cost hours.
If the two ever disagree, §0 wins and this file is stale.

The durable part, which does not go stale: reeve could not publish at all, because
its worker could not run `git add` or `git commit` — the sandbox that landed 22
Aug denied Bash writes to `.git`. Three dispatches produced three correct fixes
and shipped none. Only run 3 reached far enough to demonstrate it; runs 1 and 2
hit max_turns first. It was a regression — reeve published three times on 21 Aug,
on its own repo, before that sandbox existed.

## VERIFY the state before trusting any of it, and tell me what drifted

  export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
  cd ~/Work/Products/reeve && git fetch -q origin && git log --oneline -3 origin/main
  for f in test/*.test.mjs; do node "$f" >/dev/null || echo "FAILED $f"; done
  ./bin/reeve doctor nextlyhq/nextly --as-app
  ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"
  tail -30 ~/.reeve/reeve.log

That `ps` line is not optional. It is the ONLY way to know reeve is actually
armed: `launchctl kickstart` restarts from launchd's cached plist, so the file
can say `--execute` while the running process does not have it. That happened on
23 Aug and I nearly reported it as done.

Expected: `main`, the arming, and what is open all match §0 — that is what you are
checking against, and if the running process disagrees with §0 about `--execute`,
someone changed one without the other, so find out which before doing anything
else. Also expect doctor `broken` on R-01 and R-03 ONLY (both mine) and the test
files green. Note the daemon's checkout may be BEHIND main, so the running process
can be on older code than the tests you just ran.

## Your task, in priority order

1. **The P0 is FIXED and MERGED — do not re-open or rebuild it.** Read
   `docs/measured/2026-08-23-three-real-dispatches.md` Finding 1 for why it
   existed, and §0 of the handoff for what landed.

   What was chosen: reeve stages and commits, and it stages EXACTLY the paths the
   worker declared in `filesTouched`. The worker keeps git's READ commands
   (`status`, `diff`, `log`, `show`) and loses `add`, `commit`, `push` and
   `remote`. It also keeps `git clean`, which is NOT read-only — it deletes
   untracked files, and with `-d`/`-x` untracked directories and ignored files
   too. Nor is it the only route: any script-capable runner can unlink a file, and
   a TypeScript unit gets `Bash(node:*)` with `node -e` usable. The honest
   position is that the worker already HAS a delete, `git clean` is the legible
   one to point it at, and what bounds the risk is that nothing it can reach was
   ever committed — not that the retained set is inert.

   Whether reeve is re-armed, and what is still open, are both in §0. What does
   NOT go stale: re-arming is the founder's call, and it is worth taking against a
   real dispatch rather than on the strength of the tests — the defect that
   started all this was found by a dispatch, and roughly 640 green tests never saw
   it.

   Do NOT assume the diff gate makes the rest free. `reviewDiff`
   (`sandbox.mjs:714-767`) judges PATHS and territory, not whether an allowed edit
   was intended, so committing whatever a worker left needs its own selection
   rules — the prompt used to say "commit only the files your fix touches" and
   that judgement has to go somewhere. This experiment produced
   `scratch_write_test.txt`, which is exactly the case: inside the lane, allowed
   by the gate, and not part of the fix.
   Whatever we choose needs a test that FAILS on today's code.

   Read the section above Finding 3 before proposing anything. This is the SIXTH
   time the prompt has claimed a capability the grant does not carry, and the
   21 Aug set includes this exact defect one step later in the sequence.

   But do NOT propose generating the prompt from the DECLARED grant as the answer
   to all six. It cannot touch Finding 1: `sandboxFor` grants `Bash(git:*)`,
   carries no add/commit deny, and emits `filesystem.denyWrite: []`, so a
   generator reading that would still advertise `git commit` and the P0 would
   survive. Five of the six are drift between two things reeve writes; the sixth
   comes from beneath them. Tell me what it would cost to represent or PROBE the
   effective restrictions, which is the only version that reaches all six.

2. **Work whatever PRs §0 lists as open, and respect the ten-round cap.** A PR at
   ten review requests stops: answer and resolve what is there, do NOT request an
   eleventh, and bring me a judgement instead. #15 hit that cap at 43 findings and
   was merged on it. The signal is not the count alone — it is the count together
   with findings that have been narrowing for several rounds.

3. **Watch for the first real dispatch on nextly.** It has never dispatched there.
   Mind which table you use for that: `worker_run` only landed on 22 Aug
   (`0d31350`) with no backfill, so its emptiness says nothing about the 20-21 Aug
   dispatch era. What does carry is that nextly's store has been recording since
   2026-08-19 13:03 and holds ZERO `run` rows and ZERO `fix_attempt` rows, and
   `fix_attempt` landed 20 Aug (`0eadfd5`), before those dispatches. The 20-21 Aug
   runs were against `revnix/reeve`, whose store holds the `fix_attempt` row.

   A red PR does not always spend an attempt. `watcher.mjs:120-136` escalates a
   missing required check, an inherited-only failure, or one it cannot name
   WITHOUT dispatching, and `daemon.mjs:808-812` then declines a caused, named
   failure whose checks are ALL demonstrated flakes — before `startRun`, so there
   is no transcript, no worktree and no spent attempt to capture. Only a caused,
   named, not-wholly-flaky failure past the containment and capacity gates reaches
   `recordFixAttempt`. Even then it is not necessarily spent: preparation happens
   AFTER the record, and a checkout, auth or settings failure refunds it
   (`daemon.mjs:1043`), as does pre-bind cancellation (`:1066`) — in those cases
   there is no transcript and the fingerprint stays retryable. Once worker
   EXECUTION begins the attempt is spent even if nothing publishes, and that run
   is the one-shot data: capture the transcript, the worktree diff and the
   escalation, not just a log tail.

## The daemon freeze is LIFTED; the tracker entry is still owed

`src/daemon.mjs` was frozen for a `threadDetails` session that never pushed a
branch. I lifted it on 23 Aug so the P0 could be fixed, and that work has merged.

`docs/TRACKER.md` is still untouched, and an entry is OWED for: PR #14, the
arming, the worker limits, the three dispatches, the P0 and its fix. Write it
once those PRs land, not before.

## What is true about the worker, measured on 2026-08-23

  - the fix quality was GOOD 3/3 — the experiment set out to find a confidently
    BAD fix and did not find one
  - it published NOTHING 3/3, but for two different reasons. Runs 1 and 2 were
    `failed (max_turns)` and never reached the publication gate at all
    (`daemon.mjs:1161-1181` routes an unfinished run before it). Only RUN 3
    demonstrates the commit restriction: `git add`/`git commit` fail with EPERM on
    `.git/index.lock`. Do not carry a 3/3 reproduction claim forward
  - the controls for run 3: a Bash write elsewhere in the same worktree SUCCEEDED,
    and an identical copy commits fine unsandboxed. reeve's own settings do not
    cause it
  - `src/prompts.mjs:31` tells the worker "`pnpm test` is permitted" when pnpm
    may not be granted, and :33-34 forbids absolute paths while the only
    unconditional runtime grant IS an absolute path
  - findings 2-4 are fixture-sensitive and may not reproduce on nextly. Finding 1
    is in the contract and reproduces everywhere

## Decisions already made — do not re-open

  - Arm it fully WITH merge authority. I heard the concern about
    propose_and_merge + admin + a bypassable ruleset and chose it anyway. The
    GitHub rules get fixed at the end.
  - Limits stay 10 min / 20 turns / 1 worker.
  - `maxFixAttemptsPerFinding` stays 1. NOTE: I decided that before the P0 was
    understood — I accepted a reeve that had not yet published, not one that
    cannot. Ask me again once task 1 has a plan.
  - PRs #1 and #2 are closed. Do not reopen them.
  - No `git push --dry-run` probe in doctor. The one-off was run by hand: both
    repos returned PUSH AUTHORISED.

## House rules that earned their place

  - **Do not inherit a factual claim from a handoff, including this one.** The
    23 Aug session was told "reeve has never dispatched a worker", repeated it in
    three documents and a PR body, and it was false. Re-verifying it is what
    uncovered the P0.
  - Measure, do not assume. Every claim is either measured (say when, record it
    under docs/measured/) or marked intent.
  - **After writing a test, stub the fix back OUT and confirm it goes red.** In
    PR #14 three assertions passed with the code they tested deleted, twice. A
    test that a helper works is not a test that it is WIRED IN.
  - Give every experiment run its OWN root. Runs 1 and 2 of the dispatch
    experiment are unrecoverable because run 3 reused the path.
  - `git diff main..branch` is NOT what a PR proposes — that is tree difference.
    Compute from `git merge-base` or you will report something false.
  - A profile edit is not in force until the daemon restarts (`loadProfile` runs
    once at startup). Verify the running process, not the file.
  - Removing a reading is not finished until every sentence that depended on it
    has been re-read.
  - Assert on every text patch; do not report an edit as applied without checking
    the anchor matched.
  - Conventional Commits, never --no-verify. **No AI attribution anywhere** — a
    hook blocks the vendor's name in commits and PR bodies, including factual
    uses; rewrite rather than argue.
  - Comment "@codex review" on every PR and every push. Reply to AND resolve each
    thread via GraphQL — replying alone does not clear it. Cap 10 rounds. Expect
    real findings: #14 took 10 rounds and 22, and PR #15 was documents only and
    still took 6, four of which were my own false claims.
  - **Do not merge.** Every PR needs my explicit grant, and the last one is spent.

## Who owns what — all three S2 plan PRs have MERGED

  - S2-A/B/C plans (#11, #12, #13) and their follow-up #17 are IN main. S2 is
    planned, not built. Do not wait on or coordinate with those lanes.
  - threadDetails wiring: never started, no branch was ever pushed. Nobody owns
    `src/daemon.mjs`.
  - What is open and mine: see §0 of the handoff. It is the only list that stays
    current.

Use ListAgents and SendMessage to check what peers are on before touching
anything outside your lane, and tell them what you are on.

Do NOT `git pull` or switch branches in ~/Work/Products/reeve — that is the
running daemon's checkout. How dangerous a restart is depends on whether
`--execute` is on, which §0 has — but the checkout is live either way, and a
half-applied tree is always a bad thing to hand a daemon. Restarting after a merge is fine and expected, after verifying the merge by
CONTENT. Squash merges break SHA ancestry, and comparing SNAPSHOTS does not
settle it either — restricting the diff to your paths still reports a difference
once anything else touches those paths after the squash. Ask whether YOUR PATCH
is present, which is a question about the change rather than about the tree:

  BASE=$(git merge-base origin/main <your-pushed-head>)
  git diff $BASE <your-pushed-head> | git apply --reverse --check -

  # run from a clean checkout of origin/main; exit 0 means every hunk you
  # proposed is already there

Read a FAILURE carefully rather than as loss. It means your exact hunks are no
longer reversible, which is also what a LATER commit touching the same lines
produces — measured on 24 Aug: #18 merged fine and then #19 edited the same
functions, so #18's patch stopped reverse-applying while every line of it was
present. When it fails, spot-check the identifiers your change introduced before
concluding anything was dropped.

## What needs me, so you do not wait on it silently

  - R-01: the ruleset lets admins bypass everything and requires no status check.
    Agreed to fix at the end; it is why every gate on nextly is decorative.
  - Capability 3 routing. The outbox EXISTS (src/db/schema.sql:110-130,
    src/db/ops.mjs:239-284) with zero callers and no drainer, so the options are
    wire and drain it now, or wait to reuse the builder's drainer at S2/S4. NOT a
    third option: docs/TRACKER.md:39-43 requires those effects go through the
    outbox, and reeve's 16 direct `gh` call sites elsewhere do not relax it.
  - ntfy read user (needs shell on 95.217.11.127).
  - Whether to raise the fix-attempt cap from 1.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```

---

## Why the prompt is shaped this way

- **It leads with the P0**, because it is why reeve is switched off, and turning
  it back on before the fix lands would spend a paid attempt per eligible red PR
  to re-prove something already measured.
- **It makes the `ps` check non-optional**, because the plist/process divergence
  already bit once and is invisible to anyone reading files.
- **It tells the reader not to trust it**, first house rule. The document it
  replaces was believed rather than checked, and that cost a P0 two days of
  invisibility.
- **It names the freeze and who it was promised to**, since the tracker entry is
  owed and writing it early is exactly the collision it exists to prevent.
- **It separates what reproduces everywhere from what is fixture-bound**, so the
  next session does not fix a synthetic fixture's problems and believe it fixed
  nextly's.
