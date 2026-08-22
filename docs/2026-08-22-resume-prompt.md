# Resume prompt — paste this into a new session

Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). Read these before doing
anything, in this order, and treat them as the source of truth over anything you
infer:

  ~/Work/Products/reeve/docs/2026-08-22-session-handoff.md   <- start here
  ~/Work/Products/reeve/docs/TRACKER.md                      <- what is done / in flight
  ~/Work/Products/reeve/docs/measured/                       <- the measured facts
  ~/Work/Products/reeve/docs/2026-08-21-builder-design.md    <- the builder spec

Then VERIFY the state rather than trusting the handoff, and tell me anything
that has drifted:

  cd ~/Work/Products/reeve && git log --oneline -3 origin/main
  cd ~/Work/Products/reeve-wt/s3 && git log --oneline main..HEAD    # PR-3 branch
  export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"         # node 24 is a floor
  npm install                                                       # srt is a dev dep
  for f in test/*.test.mjs; do node "$f" >/dev/null || echo "FAILED $f"; done
  ./bin/reeve doctor nextlyhq/nextly --as-app
  tail -20 ~/.reeve/reeve.log

Where things stand in one line: S1 is complete on main (PR-1 0d31350, PR-2
1a2fbea); PR-3 is in flight on branch feat/s1-standalone-clones (worktree
~/Work/Products/reeve-wt/s3, 3 commits, 58 test files green); reeve has never
dispatched a worker and dispatch is still refused in code.

Your next task is the PR-3 tail, in this order (section 7 of the handoff):

  1. Remove or re-point the now-dead worktree code (acquireWorktree /
     releaseWorktree / pushWorktree in src/worktree.mjs, resolveWorktree in
     src/daemon.mjs). Dispatch no longer uses them but tests still cover them,
     which is false confidence.
  2. Fix the doctor wording for the new arrangement: R-15 still describes the
     keychain as gating dispatch, and it no longer does.
  3. Open the PR on revnix/reeve, comment "@codex review", and work the rounds.
  4. Run a LIVE canary on the real profile as evidence. Do not recommend arming
     anything on fixture measurements.

House rules that matter here:

  - Measure, do not assume. Every claim in a doc or a PR reply is either measured
    (say when, and record it under docs/measured/) or marked intent.
  - After writing a test, stub the fix back OUT and confirm the test goes red.
    A test that passes either way proves nothing. This caught two of my own bad
    tests this session.
  - Assert on every text patch you apply; I twice reported an edit as applied
    when the anchor had not matched.
  - Never write a tilde into a sandbox policy path. `~/...` expands against the
    PROCESS's home, and workers now have a scratch home, so a tilde silently
    protects nothing. This nearly shipped.
  - Codex re-reports stale findings across rounds. Verify each against the code
    before working it. The revision cap is 10 rounds. The signal to stop is when
    findings stop being new areas and become follow-ups on your own fixes.
  - Reply to AND resolve every Codex thread via GraphQL. Replying is not enough.
  - Conventional Commits, no Claude attribution, never --no-verify, no `as any`.
  - Do not merge without asking me. Each PR needs its own explicit grant; the
    last one is spent. CI green and zero open threads are necessary, not
    sufficient.
  - Ask me with plain English, options with pros and cons, and your honest
    recommendation. Push back if you disagree with me.

What needs me, so you do not wait on it silently: nothing blocks PR-3. After it
lands and a live canary passes, I decide whether to set worker.isolation:
"scratch-home" and start the daemon with --execute.

One guardian item is also open and independent: the review shadow week reset on
2026-08-22 because PR #1134 diverged ("resolved differs: live 13, derived 18").
Investigate that when the PR-3 tail is done — it is a real disagreement between
reeve's derived review state and GitHub's live one.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```

---

## Why the prompt is shaped this way

- **It points at documents rather than restating them**, so the next session
  reads the current file instead of a snapshot that may already be stale.
- **It asks for verification first** and for drift to be reported, because a
  handoff is a claim about the past; the repo is the fact.
- **It carries the traps forward**, since those are the parts that cost real time
  and would otherwise be rediscovered by repeating the mistake.
- **It names what needs the founder**, so nothing waits silently.
