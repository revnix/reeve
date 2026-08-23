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

## In one line

reeve is ARMED and CANNOT PUBLISH. `--execute` is live and the next ELIGIBLE red
CI on nextlyhq/nextly will dispatch (see task 3: several kinds of red escalate
without dispatching), but the worker cannot run `git add` or `git commit` — the
sandbox that landed 22 Aug denies Bash writes to `.git`. Three dispatches, three
correct fixes, zero published — though only run 3 demonstrates the commit block;
runs 1 and 2 hit max_turns first. That is a regression: reeve
published three times on 21 Aug, on its OWN repo, before that sandbox existed.

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

Expected: main `16769e7`, 60 test files green, doctor `broken` on R-01 and R-03
ONLY (both mine), and the running process carrying `--execute`.

## Your task, in priority order

1. **The P0: the worker cannot commit.** Read
   `docs/measured/2026-08-23-three-real-dispatches.md` Finding 1 in full — it has
   the evidence and both controls. Then bring me a decision, do not just start
   coding: the two shapes are (a) grant the worker `.git` writes, or (b) have
   reeve stage and commit on the worker's behalf after the diff gate, removing the
   worker's STAGING and MUTATION authority while keeping read-only git — it still
   needs `git status`, `git diff`, `git log` and `git show` to inspect its own
   work, and `sandbox.mjs:368-376` grants git broadly on purpose after narrower
   subcommand matching failed on a real dispatch. (b) is probably right, but it
   changes the worker contract, so it is my call.

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
   21 Aug set includes this exact defect one step later in the sequence. A fix
   that only unblocks `.git` leaves the mechanism that produced all six. Tell me
   what it would cost to generate the prompt from the grant instead.

2. **PR #15** (`docs/first-dispatches`, worktree ~/Work/Products/reeve-wt/paths)
   is open. Work its rounds: reply to AND resolve every thread via GraphQL, cap
   10 rounds, do not merge. It is documents only.

3. **Watch for the first real dispatch on nextly.** It has never dispatched there
   (verified: zero worker_run rows in ~/.reeve/state/nextlyhq/nextly.db). Note a
   red PR does not always spend an attempt: `watcher.mjs:120-136` escalates a
   missing required check, an inherited-only failure, or a failure it cannot name
   WITHOUT dispatching. Only a caused, named failure reaches `FIX_CI` and
   `recordFixAttempt`. For those, the one attempt is spent even when nothing
   publishes, so it is one-shot data: capture the worker transcript, the worktree
   diff and the escalation, not just a log tail. Expect no publication until task
   1 lands.

## A freeze is in force, and I promised it to another session

**Do not edit `src/daemon.mjs` or `docs/TRACKER.md`** until the threadDetails
session's PR lands. A tracker entry is OWED for PR #14, the arming, the worker
limits, the three dispatches and the P0 — write it the moment the freeze lifts,
not before, or you create the exact rebase conflict I warned them about.

Note task 1 may need `src/sandbox.mjs` and `src/prompts.mjs`, which are NOT
frozen. If it needs `daemon.mjs`, tell me and wait.

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

## Other sessions are alive — check before starting anything

  - S2-A/B/C plans: PRs #11, #12, #13, worktrees ~/Work/Products/reeve-wt/{pa,pb,pc}.
    These are CHAINED (#12 bases on #11's merge, #13 on #12's) and cannot be
    parallelised — their own plans say why.
  - threadDetails wiring: a session I started, branch `feat/thread-details`.
    It owns `src/daemon.mjs` until it lands.

Use ListAgents and SendMessage to check what peers are on before touching
anything outside your lane, and tell them what you are on.

Do NOT `git pull` or switch branches in ~/Work/Products/reeve — that is the
running daemon's checkout AND REEVE IS ARMED, so a restart there has real
consequences. Restarting after a merge is fine and expected, after verifying the
merge by CONTENT (squash merges break SHA ancestry: `git diff --name-only
origin/main <your-pushed-head>` should be empty).

## What needs me, so you do not wait on it silently

  - **The P0 fix shape** (task 1) — my call, not yours.
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

- **It leads with the P0**, because reeve is armed against a repository it cannot
  publish to, and every ELIGIBLE red PR there spends a paid attempt to prove it.
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
