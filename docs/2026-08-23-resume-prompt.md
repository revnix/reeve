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
docs/2026-08-22-session-handoff-2.md as history: it describes a reeve that had
never dispatched a worker, and that stopped being true on 23 Aug.

## In one line

reeve is ARMED. `--execute` is live, `worker.isolation` is `scratch-home`, and it
will dispatch a real worker at the next red CI on nextlyhq/nextly. Three real
workers have now run (in a sandboxed experiment): three CORRECT fixes, ZERO
published, because the work is never committed.

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

1. **PR #15** (`docs/first-dispatches`, worktree ~/Work/Products/reeve-wt/paths)
   is open and awaiting Codex. Work its rounds: reply to AND resolve every
   thread via GraphQL, cap 10 rounds, do not merge. It is documents only.

2. **Watch for the first real dispatch.** reeve is armed and has never dispatched
   on nextly. Each red PR gets ONE attempt (`maxFixAttemptsPerFinding: 1`) and it
   is spent even when nothing publishes, so the first one is one-shot data:
   capture the worker transcript (~/.reeve/runs/...), the worktree diff, and the
   escalation, not just a log tail.

3. Then ask me what next. Do not start new reeve work without checking §"Other
   sessions" below — the lanes are narrow right now.

## A freeze is in force, and I promised it to another session

**Do not edit `src/daemon.mjs` or `docs/TRACKER.md`** until the threadDetails
session's PR lands. A tracker entry is OWED for PR #14, the arming, the worker
limits and the three dispatches — write it the moment the freeze lifts, not
before, or you create the exact rebase conflict I warned them about.

## What is true about the worker, measured on 2026-08-23

Read `docs/measured/2026-08-23-three-real-dispatches.md` in full. The short form:

  - the fix quality was GOOD 3/3 — the experiment set out to find a confidently
    BAD fix and did not find one
  - it published NOTHING 3/3, because the work was never committed
  - the worker creates a scratch file probing whether it can write, cannot `rm`
    it, and that stray file blocks publication on its own
  - refusals say only "This command requires approval", so it retries rather than
    adapting: 28 of 40 turns in two runs. RAISING THE TURN LIMIT DOES NOT HELP —
    it buys more retries of the same refusals
  - none of this is known to reproduce on nextly. The fixture had no lockfile and
    no node_modules, which is what sent the worker guessing. Only a real dispatch
    settles it, which is why task 2 matters

## Decisions already made — do not re-open

  - Arm it fully WITH merge authority. I heard the concern about
    propose_and_merge + admin + a bypassable ruleset and chose it anyway. The
    GitHub rules get fixed at the end.
  - Limits stay 10 min / 20 turns / 1 worker.
  - `maxFixAttemptsPerFinding` stays 1, and reeve stays armed, even though each
    red PR spends its only attempt on a fix that will not publish. The proper
    turn-on waits until the BUILDER is done; today's arming is evidence-gathering.
  - PRs #1 and #2 are closed. Do not reopen them.
  - No `git push --dry-run` probe in doctor. The one-off was run by hand: both
    repos returned PUSH AUTHORISED.

## House rules that earned their place

  - Measure, do not assume. Every claim is either measured (say when, record it
    under docs/measured/) or marked intent.
  - **After writing a test, stub the fix back OUT and confirm it goes red.** In
    PR #14 three assertions passed with the code they tested deleted, twice. A
    test that a helper works is not a test that it is WIRED IN.
  - `git diff main..branch` is NOT what a PR proposes — that is tree difference.
    Compute from `git merge-base` or you will report something false. I nearly
    did.
  - A profile edit is not in force until the daemon restarts (`loadProfile` runs
    once at startup). Verify the running process, not the file.
  - Removing a reading is not finished until every sentence that depended on it
    has been re-read. PR #14 produced three stale comments describing behaviour
    deleted in a later round of the same PR.
  - Assert on every text patch; do not report an edit as applied without checking
    the anchor matched.
  - Conventional Commits, never --no-verify. **No AI/Claude attribution
    anywhere** — a hook blocks the word in PR bodies, including factual uses;
    rewrite rather than argue.
  - Comment "@codex review" on every PR and every push. Reply to AND resolve each
    thread via GraphQL — replying alone does not clear it. Cap 10 rounds. Expect
    real findings: #14 took 10 rounds and 22, and several were defects introduced
    by my own fix for the previous round.
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
running daemon's checkout AND REEVE IS NOW ARMED, so a restart there has real
consequences. Restarting after a merge is fine and expected, after verifying the
merge by CONTENT (squash merges break SHA ancestry: `git diff --name-only
origin/main <your-pushed-head>` should be empty).

## What needs me, so you do not wait on it silently

  - R-01: the ruleset lets admins bypass everything and requires no status check.
    Agreed to fix at the end; it is why every gate on nextly is decorative.
  - The outbox question: guardian GitHub effects either wait for the builder's
    outbox (S2/S4) or use the direct `gh` path reeve already uses in src/github/.
    This blocks half of capability 3.
  - ntfy read user (needs shell on 95.217.11.127).
  - Whether to raise the fix-attempt cap from 1.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```

---

## Why the prompt is shaped this way

- **It leads with the arming**, because that is the fact most likely to cause harm
  if a new session does not know it. A restart of the daemon's checkout now has
  consequences it did not have yesterday.
- **It makes the `ps` check non-optional**, because the plist/process divergence
  already bit once and is invisible to anyone reading files.
- **It names the freeze and who it was promised to**, since the tracker entry is
  owed and writing it early is exactly the collision it exists to prevent.
- **It states what the dispatch evidence does NOT establish**, so the next session
  does not fix a synthetic fixture's problems and believe it fixed nextly's.
- **It carries the traps rather than the conclusions**, because the conclusions
  are in the handoff and the traps are what cost hours.
