# Resume prompt — paste this into a new session

Supersedes `docs/2026-08-30-resume-prompt.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). reeve lives at
~/Work/Products/reeve (github.com/revnix/reeve).

YOU ARE THE GUARDIAN LANE, and you are not alone in this repository. How many other
sessions there are, and which lanes they hold, is in §0 and changes — do not take a
count from this prompt. ENUMERATE THE LIVE ONES with ListAgents before touching
anything shared, then SendMessage. Names change on restart, so LIST rather than
assume, and a peer named in §0 may have exited.

## Read these first, in this order

  ~/Work/Products/reeve/docs/2026-08-31-session-handoff.md   <- START HERE
  ~/Work/Products/reeve/docs/2026-08-28-session-handoff.md   <- §1-§5 for what reeve IS
  ~/Work/Products/reeve/docs/TRACKER.md
  ~/Work/Products/reeve/docs/measured/                        <- the measured facts

Treat §0 as the ONLY statement of current facts, and note that §0 is mostly
COMMANDS rather than prose. This prompt contains no current facts at all.

That is not tidiness. Volatile facts were once restated in about twenty places and a
correction was applied to one copy. Two tests enforce it —
test/docs-state-is-single-sourced.test.mjs and test/zero-agrees-with-the-code.test.mjs
— and while WRITING that handoff they caught nine stale or unscoped sentences in it,
including a stage row whose wording made the parser read a stage as landed that was
not.

## VERIFY before trusting any of it, and tell me what drifted

Run §0.1's command block. Every line matters, but six especially:

  · The `ps` line is not optional. The restart command replays launchd's CACHED
    plist, so the file can say one thing while the running process says another.

  · The same gap applies to CODE. A running daemon holds the modules it loaded at
    startup, so the checkout's HEAD is not what it runs.

  · A MEASUREMENT EXPIRES. Re-measure immediately before ACTING, not once at the start.

  · CHECK WHETHER CI IS ALIVE before believing any red. A job reporting failure with
    ZERO steps never started. Count steps.

  · LIST THE PUSHED BRANCHES, not just the pull requests. §0.1 has the command, and
    it SUBTRACTS the branches already in review — a bare listing of heads includes
    every open branch, which a session reads as hidden work and rebuilds.

  · IF `test/anchors-resolve.test.mjs` EXISTS, run it — about four milliseconds, and
    it tells you whether any manifest anchor has rotted. It was in flight when this
    was written, so check before running: a missing file exits MODULE_NOT_FOUND, which
    is not the same answer as "no anchors rotted". The full sweep answers the same
    question in twenty minutes, which is why nobody ran it and why anchors reached the
    default branch.

## §2 OF THE HANDOFF IS THE MOST IMPORTANT THING IN IT

Read it before writing code. Nearly every defect found across two days was ONE shape:
a check that reports success while measuring nothing. Fixtures agreeing with the code
that produced them. A control built from the filter it then asserts. A gate comparing
a commit to itself. An anchor that stopped matching. A shell error read as data.

The habit that catches all of them: **before believing a green, ask what would have to
be true for it to be red, then make that happen.** Several times the answer was
"nothing could", which is not a passing test.

And when a comment contains "and" or "rather than", CHECK BOTH HALVES EXIST IN THE
CODE. Five times in one session I stated a two-clause rule and built one clause.

## Your tasks, in priority order

1. **Work whatever came back on my open pull requests.** §0.1 lists them. Reply to
   AND resolve every thread via GraphQL — replying alone does not clear it. Derive
   thread ids in the SAME command that writes the reply, and key on the finding's
   TEXT, never on its file path: two findings on one file once got the same answer
   while the tool reported success twice.

   Read BOTH verdict endpoints. Findings arrive as review threads; a clean pass
   arrives as an ISSUE comment. And a summary saying "Completed" is not a clean pass —
   a finding arrived after one such summary and would have merged had I trusted it.

2. **Then the test clock** (§0, §6). Guard that refuses a future timestamp on write,
   THEN the correction. Guard first, so it cannot come back.

3. **Then `ci.flakePatterns`** (§6): declared in the schema, zero readers. Wire or
   delete; deleting is probably right. Ask me.

4. **Bring me the V6 measurement when I am at a keyboard with a quiet session.** §0
   owns its status. READ §6 BEFORE ACTING ON THIS: at the time of writing the plan is
   not in the commit that carries this prompt, so the row names something you cannot
   open yet, and §6 says which change brings it. Do not start by hunting for a file
   that is not there. When it is available it needs a window with no interactive use,
   two verbatim allowance readings with times, and agreement on caps. ITS OBLIGATION BELONGS TO T16 IN THE BUILDER LANE — settle with
   that lane whether it lands there or separately before doing it.

5. **Keep a 15-minute watcher on my open pull requests.** It is `tools/watch-prs.sh`
   in the repository — run it, do not rewrite it. It emits a HEARTBEAT, and alarms after TWO
   CONSECUTIVE failed probes rather than the first — measured, `MISSES >= 2` in the
   script. A single failed tick that recovers says nothing, so the watch can be blind
   for one interval without telling you. An earlier version read an API blip as "the
   pull request closed" and exited with a line that looked like a clean stop.

## HOW TO HAND ME A PULL REQUEST

Run `node scripts/premerge.mjs <pr>` and quote its verdict AND the head SHA (see §0
for the rule this extends). My grant then names a COMMIT rather than a number.

This is not ceremony. FOUR pull requests merged at an older commit than their branch
tip and silently dropped the last round of review fixes, costing three follow-up pull
requests. The gate already answered that and nothing was running it. Three merges
since have been clean.

## Do NOT

- Do not `git pull` or switch branches in ~/Work/Products/reeve. That is the running
  daemon's checkout. Standing permission to fast-forward and restart AFTER a merge:
  clean checkout, verify by CONTENT because a squash breaks ancestry, full suite green
  BEFORE restarting, `bootout` then `bootstrap` with about 8 seconds between them (3
  fails with an I/O error and leaves the service DOWN), then confirm with `ps` AND a
  NEW startup line in the daemon's own log. Do not read a pid as proof. Only restart
  when something in the daemon's own module graph changed; check rather than assume.
- Do not change arming in either direction without asking. §0 says how it is set.
- Never `--no-verify`. Conventional Commits. No AI attribution anywhere — a hook
  blocks the vendor's name in commits and pull request bodies, including factual uses;
  rewrite rather than argue.
- Do not use `gh pr create --body` with backticks. Write the body to a file and use
  `--body-file`. Backticks in a shell string run as command substitution and have
  already wrecked one reply loop.
- **Never merge `test/stub-manifest.mjs` hunk by hunk.** Take the default branch's
  copy whole and re-append your entries once. Merging it produces array holes, and a
  hole is invisible to `forEach` and to `node --check`.
- Do not widen your own permissions. If the harness blocks an action, explain what you
  were trying to do and let me decide.

## House rules that earned their place

  - **Measure, do not assume**, and measure the PLATFORM too. Recent ones: `bin/*`
    does NOT match an extensionless file in eslint flat config (`bin/!(*.*)` does);
    a child's `exit` can precede its stdio drain where `close` cannot; `gh pr merge`
    has no `--hostname`; `URL.hostname` drops the port.
  - **An absence search needs a positive control.** Three separate inert measurements
    in one session returned empty, and empty was the expected answer each time. An
    unquoted `$VAR:path`, a failed `cd`, and a zsh history modifier.
  - **Stub the fix back OUT and read the EXIT CODE.** Commit first, so `git checkout`
    is the restore. Add a manifest entry whenever you add a guard — unless the guard
    cannot be shown to fire, in which case add NONE and write the reason in the source.
  - **Build the tree that should fail it.** A control proves a check does not fire
    wrongly; only a fixture that exhibits the defect proves it fires at all.
  - **A caveat that documents a hole is worse than no caveat.**
  - **The third instance of a shape is evidence about the DESIGN.** Change the
    mechanism rather than trying harder to remember.
  - **Do not trust a plan's "produces" clause you have not run.** A rationale was found
    repeated verbatim across two plan documents and backwards in both; two copies of
    one error read as two sources agreeing.
  - **One heredoc per shell invocation**, and assert on every text patch — a missed
    anchor must abort, never half-apply.

## What needs me, so you do not wait on it silently

§0 owns each in full, and this deliberately names none of them. Read the table there;
it is short, and every row says what the decision IS and what it waits on.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```
