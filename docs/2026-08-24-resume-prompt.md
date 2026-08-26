# Resume prompt — paste this into a new session

> **SUPERSEDED by `docs/2026-08-26-resume-prompt.md` (2026-08-26).** Kept as history.
> Its state claims were true when written and are not maintained. The
> single-source test does not scan this file.

Supersedes `docs/2026-08-23-resume-prompt.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). reeve lives at
~/Work/Products/reeve (github.com/revnix/reeve, private).

## Read these first, in this order

  ~/Work/Products/reeve/docs/2026-08-24-session-handoff.md   <- START HERE
  ~/Work/Products/reeve/docs/TRACKER.md                      <- §0 says whether it is current
  ~/Work/Products/reeve/docs/measured/                        <- the measured facts

Treat the handoff's §0 as the ONLY statement of current facts. This prompt
contains no current facts, deliberately: what is merged, whether reeve is armed,
what `main` is, which PRs are open — all of that is in §0 and nowhere else.

That is not tidiness. Those three facts had been restated in about twenty places
across two documents, and SEVEN review rounds in a row found a correction applied
to one copy and left standing in the others. Two of those rounds found the defect
INSIDE the fix — once in the paragraph claiming no copies remained. There is now a
test, `test/docs-state-is-single-sourced.test.mjs`, that fails if a present-tense
state claim appears in either document outside §0 without pointing at it. If §0
and anything else disagree, §0 wins and the other file is stale.

## VERIFY before trusting any of it, and tell me what drifted

  export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
  cd ~/Work/Products/reeve && git fetch -q origin && git log --oneline -3 origin/main
  for f in test/*.test.mjs; do node "$f" >/dev/null || echo "FAILED $f"; done
  ./bin/reeve doctor nextlyhq/nextly --as-app
  ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"
  tail -30 ~/.reeve/reeve.log

Everything should match §0. That `ps` line is not optional: `launchctl kickstart`
restarts from launchd's CACHED plist, so the file can say `--execute` while the
running process does not have it. That happened on 23 Aug and I nearly reported it
as done. If the running process and §0 disagree about `--execute`, someone changed
one without the other — find out which before doing anything else.

Compare doctor's `broken` findings against §0: the ones listed there are known
and mine, and anything else is new and worth stopping for. The daemon's checkout
can also drift behind `main`, which puts the running process on older code than
the tests you just ran — §0 says where it stands, and `ps` says it better.

## Your tasks, in priority order

1. **Work my open PRs' review rounds.** §0 lists them. Comment "@codex review" on
   every PR and every push; reply to AND resolve every thread via GraphQL, because
   replying alone does not clear it. Read BOTH verdict endpoints — findings arrive
   as review threads, a clean pass arrives as an ISSUE comment with no review
   object, and reading one answers the wrong question. Compare `totalCount` to what
   you fetched, because `reviewThreads(first:N)` truncates silently and
   under-reporting reads as clean. Check the verdict's `commit_id` against the
   head; a verdict at an older head is stale.

   **Cap: ten rounds per PR.** At the cap, answer and resolve what is there, do NOT
   request an eleventh, and bring me a judgement instead. Expect real findings —
   the last four PRs took 100+ between them and not one was a false positive.

2. **Then propose what is next and let me choose.** My standing recommendation,
   which I have not yet acted on: re-run the wrong-worker experiment against the
   FIXED code before touching nextly. The harness is
   `build-fixture.sh` + `run.mjs` (ask me for the scratchpad path). It costs about
   $1, spends no real PR's fix attempt, and answers the only question that matters
   — does reeve actually publish? The tests say yes; §0 says whether any real
   dispatch has ever agreed with them. Weigh those two against each other before
   deciding, in a project where a dispatch once found what ~640 green tests
   missed. Re-arming nextly is the step after that, not part of it.

   The other candidates, both real, both described in §6 and both with their
   current standing in §0: the owed tracker entry, and wiring capability 3 — which
   needs a routing decision from me and carries a known latent fencing defect whose
   repair is already worked out, with the wrong repair explicitly ruled out.

3. **Keep a 15-minute watcher on my open PRs**, if one is not already running. It
   must emit a HEARTBEAT as well as reporting changes — a watcher that reports only
   on change makes a dead watcher and a quiet one look identical, which is the
   exact bug it exists to catch.

## Other sessions are alive — check before touching anything

Use ListAgents and SendMessage. Other Claude sessions work this same repo and the
nextly monorepo. `nextly-integrations-28` owns the builder S2 lane and
`src/backup.mjs`; ask before touching hub or backup code. Tell them what you hold.

This has been worth real time, not just courtesy: peers found a defect in my
outbox repair, corrected a false deadline I had already passed to me, and gave me
three verification rules I did not have. Verify what they claim against the code
before acting on it — doing so changed the answer twice — and concede plainly when
they are right.

## Do NOT

- Do not `git pull` or switch branches in ~/Work/Products/reeve. That is the
  running daemon's checkout. Restarting after a merge is fine and expected, after
  verifying by CONTENT (see the handoff §11 — squash merges break SHA ancestry, and
  read a reverse-apply FAILURE carefully, since a later commit touching the same
  lines produces one too).
- Do not merge anything without asking me. Every PR needs its own grant and the
  last one is spent.
- Do not change reeve's arming without asking, in either direction. §0 says how
  it is set; whatever it says was a deliberate call and is mine to reverse.
- Never `--no-verify`. Conventional Commits. No AI attribution anywhere — a hook
  blocks the vendor's name in commits and PR bodies, including factual uses;
  rewrite rather than argue.

## House rules that earned their place

  - **Measure, do not assume.** Every claim is measured (say when, record it under
    docs/measured/) or marked intent.
  - **After writing a test, stub the fix back OUT and confirm it goes red.** Assertions
    have passed here with the code they tested deleted.
  - **Check the fixture can exhibit the defect.** Three times in one day a fixture
    could not, and passed for the wrong reason — a whitespace case with the space in
    the middle, a "declared but unchanged" case using a file that did not exist, and
    a corrupt-page case the query answered from an index without ever reading.
  - **The third instance of a shape is evidence about the DESIGN.** Remove the
    fallible read rather than correcting it again. Four staging defects in four
    rounds became one design change and every exclusion rule disappeared.
  - **Declaring a class swept is itself an unverified read.** After centralising,
    GREP for the thing and add the test that fails when a new copy appears.
  - **Never read ABSENCE as success.** Read a positive signal that the check RAN.
  - **A mechanism's LIMIT does not travel with its behaviour.** I carried one across
    a boundary and handed you a deadline that did not exist.
  - **Two facts that look alike are not one fact.** A fence and a retry budget both
    count up; merging them is overloading, not deduplication.
  - **A noisy gate is also an insensitive one.** A guard that fires on correct text
    gets weakened or ignored.
  - Assert on every text patch; do not report an edit as applied without checking
    the anchor matched.
  - A profile edit is not in force until the daemon restarts (`loadProfile` runs once
    at startup). Verify the running process, not the file.

## What needs me, so you do not wait on it silently

The handoff's §6 has these in full. In short: the capability-3 routing decision;
the owed tracker entry; R-01, the ruleset that lets admins bypass every rule; the
ntfy read user; and whether to re-arm.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```
