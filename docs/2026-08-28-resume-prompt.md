# Resume prompt — paste this into a new session

Supersedes `docs/2026-08-26-resume-prompt.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). reeve lives at
~/Work/Products/reeve (github.com/revnix/reeve).

## Read these first, in this order

  ~/Work/Products/reeve/docs/2026-08-28-session-handoff.md   <- START HERE
  ~/Work/Products/reeve/docs/TRACKER.md
  ~/Work/Products/reeve/docs/measured/                        <- the measured facts

Treat the handoff's §0 as the ONLY statement of current facts, and note that §0
itself is mostly COMMANDS rather than prose. This prompt contains no current facts
at all, deliberately.

That is not tidiness. Three volatile facts were once restated in about twenty
places, and seven review rounds in a row found a correction applied to one copy
and left standing in the others. Then, on 2026-08-24, `main` moved twice in one
afternoon against a file that said otherwise. That taught the harder half: a fact a command can
answer should not be written down at all. Two tests enforce it —
test/docs-state-is-single-sourced.test.mjs fails if a sentence naming a §0 subject
appears outside §0 without deferring or carrying a date, and
test/zero-agrees-with-the-code.test.mjs fails if §0's progress row disagrees with
what the tree contains.

## VERIFY before trusting any of it, and tell me what drifted

Run §0.1's command block. Every line matters, but five especially:

  · The `ps` line is not optional. `launchctl kickstart` (§0) restarts from launchd's
    CACHED plist, so the file can say one thing while the running process says
    another. That happened once and I nearly reported it as done.

  · The same gap applies to CODE. A running daemon holds the modules it loaded at
    startup, so the checkout's HEAD is not what it runs. The daemon writes its own
    commit into the log when it starts, and §0.1 greps for that line. Never
    substitute `git log -1 HEAD`.

  · §0.1's sqlite line must use `-readonly` and the PER-REPO path: sqlite3 opens a
    missing file by CREATING it, so a wrong path answers "zero rows" for a database
    it just made.

  · CHECK WHETHER CI IS ALIVE before believing any red run. A job that reports
    failure with ZERO steps never started, and a run's conclusion cannot tell you
    which happened. Count steps via the jobs endpoint; `gh run list` (§0) cannot
    report them.

  · Read the PROFILE, not your memory of it. Two switches decide whether the
    review half does anything, and a profile edit is not in force until the daemon
    restarts.

§0.1 runs doctor; whatever it reports is the answer. §6 says what the unfinished
work NEEDS; §0 holds every outcome, and deliberately records none here, because a
resumed session told to expect a finding will read real drift as the expected one.

## Your tasks, in priority order

1. **Work my open pull requests' review rounds.** §0 says which are open. Comment
   "@codex review" on every one and every push; reply to AND resolve every thread
   via GraphQL, because replying alone does not clear it. Derive thread ids in the
   SAME command that writes the reply — pasting them from an earlier fetch once
   answered three findings on the wrong threads and reported success three times.
   Read BOTH verdict endpoints: findings arrive as review threads, a clean pass
   arrives as an ISSUE comment. Compare totalCount to what you fetched, because
   reviewThreads(first:N) truncates silently.

   **Merge rule, and it is mine, not yours to soften:** it is stated in §0 and
   nowhere else. Read it there and apply it as written. GATE on the reading rather
   than printing it and proceeding — I have watched a session print "open threads:
   3" and merge in the same breath. A grant I give you is permission to merge when
   the rule is satisfied; it is not permission to merge when it is not.

   After any push, ask GitHub whether that branch's pull request has since merged.
   A push to one that has SUCCEEDS and lands nowhere, with no error anywhere in
   the sequence. That happened once and cost a fix.

   **If findings stop tapering, stop and bring me the SHAPE rather than the next
   fix.** That has happened three times. Once we split the change in two and the
   halves converged where the whole never did; once we replaced the instrument;
   once the third instance of one shape meant the design was wrong and restructuring
   removed the whole class.

2. **Then continue the programme.** §8 has the ordering and §6 says what each piece
   needs. The next item after that needs a decision from me before any code — ask
   it rather than guessing.

3. **Keep a 15-minute watcher on my open pull requests**, if one is not already
   running. It is `tools/watch-prs.sh` in the repository — run it, do not rewrite
   it. Every lesson in its header was paid for once, and the one that matters most
   is that it must emit a HEARTBEAT and alarm on a FAILED PROBE: an earlier version
   read an API blip as "the pull request closed" and exited with a line that looked
   like a clean stop.

4. **When those are done**, analyse what is left in §6 and §8 and bring me a
   recommendation with options and trade-offs. Do not pick a big new direction
   without me.

## Other sessions are alive — check before touching anything

Use ListAgents and SendMessage. Names change on restart, so LIST rather than
assume. §7 has the territory split and the rule that replaced it: tell each other
before changing the SET of clause ids computeVerdict emits or the ORDER of
nextAction's branches. Editing inside a branch you already own needs no ceremony.

Verify what a peer claims against the code before acting on it — doing so changed
the answer twice — and concede plainly when they are right. I have sent a collision
notice for a file I was not touching because I described my branch from memory
instead of running `git diff --name-only`; conceding fast cost less than defending
it would have.

## Do NOT

- Do not `git pull` or switch branches in ~/Work/Products/reeve. That is the
  running daemon's checkout. I have given standing permission to fast-forward and
  restart it after a merge — clean checkout, verify by CONTENT because a squash
  breaks ancestry, full suite green BEFORE restarting, `bootout` then `bootstrap`
  so launchd re-reads the file, then confirm with `ps` AND with a NEW startup line
  in the daemon's own log. Do not read a pid as proof of a restart: a stale
  `launchctl print` reported the old pid after a successful bootout, and the
  service was in fact down.
- Do not change reeve's arming in either direction without asking. §0 says how it
  is set; whatever it says was a deliberate call and is mine to reverse.
- Never `--no-verify`. Conventional Commits. No AI attribution anywhere — a hook
  blocks the vendor's name in commits and pull request bodies, including factual
  uses; rewrite rather than argue.
- Do not use `gh pr create --body` with backticks in it. The shell eats fenced
  blocks and I have shipped a body with the evidence silently removed. Write the
  body to a file and use `--body-file`.

## House rules that earned their place

  - **Measure, do not assume.** Every claim is measured (say when, record it under
    docs/measured/) or marked intent. Measure the PLATFORM too: execFileSync
    rejects a fractional timeout, `timeout: 0` bounds nothing, `timeout` does not
    exist on macOS, and on BSD seq, `seq 1 0` counts DOWN.
  - **Stub the fix back OUT and read the EXIT CODE, not the lines.** Commit first,
    so `git checkout` is the restore: a sweep killed by a timeout otherwise leaves
    the tree stubbed and the next reading measures the stub.
  - **`$?` after a command substitution is the substitution's.** `echo "$(basename
    $f) EXIT=$?"` reports basename's status. Every per-file result printed that way
    was worthless until a test I KNEW should fail reported passing.
  - **A control must be able to match.** A positive control whose term exists only
    on the branch under test returns nothing either way and proves nothing.
  - **Verify the base is GREEN before a sweep**, and in the same environment: a
    missing node_modules produced a failure I nearly read as a regression.
  - **A control that passes for a second reason is not a control.** One of mine was
    satisfied by a replacement sentinel rather than by the rule it tested.
  - **Never `| head` a search whose result you will treat as a set.**
  - **The third instance of a shape is evidence about the DESIGN.** Remove the
    fallible read rather than correcting it again.
  - **Refining a reading is not free.** Splitting one category into two must be
    re-checked against the answer it feeds, or the finer classification loses the
    coarser truth it refined.
  - **A working seam nothing is plugged into is the failure to look for.**
  - **One heredoc per shell invocation**, and assert on every text patch — a missed
    anchor must abort, never half-apply.

## What needs me, so you do not wait on it silently

§6 has these in full and §0 holds every current state for them, so what follows
names only what each one IS, with §0 as the source throughout: whether to re-arm,
the merge-authority ruleset, the merge shape, the second project, the ntfy read
user. A summary of their status here would prime you to read real drift as the
finding you were told to expect.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```
