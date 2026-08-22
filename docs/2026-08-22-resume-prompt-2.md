# Resume prompt — paste this into a new session

Supersedes `docs/2026-08-22-resume-prompt.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). Read these first, in this
order, and treat them as the source of truth over anything you infer:

  ~/Work/Products/reeve/docs/2026-08-22-session-handoff-2.md   <- START HERE
  ~/Work/Products/reeve/docs/TRACKER.md                        <- done / in flight
  ~/Work/Products/reeve/docs/measured/                          <- the measured facts

Ignore docs/2026-08-22-session-handoff.md — it carries a SUPERSEDED banner and a
keychain claim that turned out to be wrong.

Then VERIFY the state rather than trusting the handoff, and tell me what drifted:

  export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
  cd ~/Work/Products/reeve && git fetch -q origin && git log --oneline -3 origin/main
  cd ~/Work/Products/reeve-wt/paths && npm install             # srt is a dev dep
  for f in test/*.test.mjs; do node "$f" >/dev/null || echo "FAILED $f"; done
  ./bin/reeve doctor nextlyhq/nextly --as-app
  tail -20 ~/.reeve/reeve.log

In one line: S1 is COMPLETE on main (#5, #6, #7 all merged; main 9bd0c61, 59 test
files green, daemon observe-only on it). reeve has never dispatched a worker and
dispatch is still refused in code.

## Your task

Three findings Codex left open on PR #7, now on main. The branch and worktree
already exist: `fix/per-commit-paths-and-attr-symlinks` at
~/Work/Products/reeve-wt/paths, with the handoff already committed on it.

1. P1 — src/daemon.mjs, walk the PER-COMMIT diffs. `changedFiles` compares the
   range endpoints, so a worker that touches a sensitive or out-of-territory path
   in one commit and restores it in a later one passes reviewDiff while the push
   still carries the intermediate commit. Walk ${since}..${ref} per commit.
   Thread PRRT_kwDOT-hWms6baCND

2. P1 — src/checkout.mjs, reject symlinked attribute files. `declaredFilters`
   reads every .gitattributes with readFileSync, following symlinks. A pull
   request can commit .gitattributes as a symlink to /dev/zero and the DAEMON
   hangs or exhausts memory before the worker is even launched. lstat first,
   refuse anything that is not a regular file, bound the size.
   Thread PRRT_kwDOT-hWms6baCNH

3. P2 — src/checkout.mjs, scope the git isolation to WORKER-CONTROLLED repos.
   Stronger than it looks: gitEnv() is applied to every git call in that module,
   including fetch, ls-remote and push against the FOUNDER's repo. If that repo's
   origin depends on a global url.<base>.insteadOf rewrite — common with SSH
   rewrites and corporate proxies — every dispatch and publication breaks. Codex
   reproduced it. The isolation exists for git run in worker-controlled
   directories; the founder's own repository is not one.
   Thread PRRT_kwDOT-hWms6baCNK

Read each finding in full on the PR before working it, and verify it against the
code — do not take a reviewer at face value, in either direction. One of today's
findings did not reproduce at all and was taken anyway as cheap insurance, with
the commit saying so.

## House rules that matter here

  - Measure, do not assume. Every claim in a doc or a PR reply is either measured
    (say when, and record it under docs/measured/) or marked intent. I acted on a
    stale document twice today and it cost real time both times.
  - After writing a test, stub the fix back OUT and confirm the test goes red.
    Three fixes today had NO test until a stub loop showed zero assertions going
    red, and two fixtures could not exhibit the defect they were written for.
  - An instrument made only of refusals passes when the worker can do nothing.
    Every boundary check needs a positive control beside it.
  - Absence searches need a positive control and a count. A quoting error made
    one sweep report "absent" for everything today.
  - Assert on every text patch you apply; do not report an edit as applied
    without checking the anchor matched.
  - Never write a tilde into a sandbox policy path, and remember an absolute path
    in a PERMISSION rule needs TWO leading slashes while the OS layer wants one.
  - `reeve canary` is the instrument that has caught seven defects the test suite
    could not. Run it before recommending anything be armed — never recommend on
    fixture measurements. It is SHARED: one state file, one real model call, so
    only one session runs it.
  - Conventional Commits, no Claude attribution, never --no-verify.
  - Comment "@codex review" on the PR and on every push. Reply to AND resolve
    every thread via GraphQL — replying alone does not clear it. Cap 10 rounds.
  - Do NOT merge. Each PR needs my explicit grant; the last one is spent.

## Other sessions are alive

Another session owns the builder S2 plan: PR #8, branch plan/s2-hub-core,
worktree ~/Work/Products/reeve-wt/s2. Do not touch it. Use ListAgents and
SendMessage to check what peers are on before starting anything outside your
lane, and tell them what you are on.

Do not `git pull` or switch branches in ~/Work/Products/reeve — that is the
running daemon's checkout. Restarting the daemon after a merge is fine and
expected (`launchctl kickstart -k gui/$(id -u)/com.revnix.reeve`), after
verifying the merge by CONTENT: squash merges mean SHA ancestry does not hold, so
compare trees (`git diff --name-only origin/main <your-pushed-head>` should be
empty).

## What needs me, so you do not wait on it silently

Nothing blocks this PR. After it lands: the --execute decision is mine, and I
want a live canary result on the merged code before I make it. R-01 (the ruleset
lets OrganizationAdmin bypass always, and carries no required status checks) is
also mine and is why every gate on that repo is currently decorative.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```

---

## Why the prompt is shaped this way

- **It points at documents rather than restating them**, so the next session
  reads the current file instead of a snapshot that is already stale.
- **It asks for verification first** and for drift to be reported, because a
  handoff is a claim about the past; the repo is the fact.
- **It names the superseded document explicitly**, because the failure it exists
  to prevent already happened once today.
- **It carries the traps forward**, since those are the parts that cost real time
  and would otherwise be rediscovered by repeating the mistake.
- **It names the other live sessions**, so the first act is not a collision.
