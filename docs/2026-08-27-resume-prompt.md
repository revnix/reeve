# Resume prompt — paste this into a new session

Supersedes `docs/2026-08-26-resume-prompt.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). reeve lives at
~/Work/Products/reeve (github.com/revnix/reeve, private).

## Read these first, in this order

  ~/Work/Products/reeve/docs/2026-08-27-session-handoff.md   <- START HERE
  ~/Work/Products/reeve/docs/TRACKER.md
  ~/Work/Products/reeve/docs/measured/                        <- the measured facts

Treat the handoff's §0 as the ONLY statement of current facts, and note that §0
itself is mostly COMMANDS rather than prose. This prompt contains no current facts
at all, deliberately.

That is not tidiness. Three volatile facts were once restated in about twenty
places, and seven review rounds in a row found a correction applied to one copy
and left standing in the others. Then, on 2026-08-24, `main` moved twice in one afternoon against a file that said
otherwise. That taught the harder half: a fact a command can answer
should not be written down at all. Two tests enforce it now —
`test/docs-state-is-single-sourced.test.mjs` fails if a sentence naming a §0
subject appears outside §0 without deferring or carrying a date, and
`test/zero-agrees-with-the-code.test.mjs` fails if §0's progress row disagrees
with what the tree actually contains. The second one exists because §0 was wrong
about §0 one commit after it was written.

## VERIFY before trusting any of it, and tell me what drifted

Run §0.1's command block. Every line matters, but four especially:

  · The `ps` line in §0.1 is not optional, because `launchctl kickstart` restarts
    from launchd's CACHED plist, so the file can say `--execute` while the running
    process does not (§0). That happened once, on 2026-08-23, and I nearly
    reported it as done.

  · The same gap applies to CODE, and §0.1 has a line for it: a running daemon
    holds the modules it loaded at startup, so the checkout's `HEAD` is not what
    it runs. The daemon writes its own commit into the log when it starts, and
    §0.1 greps for that line. Never substitute `git log -1 HEAD` (§0) for it: that
    reports a fix as deployed when the restart it needed has not happened.

  · §0.1's sqlite line must use `-readonly` and the PER-REPO path: `sqlite3`
    opens a missing file by CREATING it (§0.1), so a wrong path answers "zero
    rows" for a database it just made. That produced a confident zero on
    2026-08-24.

  · CHECK WHETHER CI IS ALIVE before you believe any red run. A job that reports
    failure with ZERO steps and no retrievable log never started. Diagnose with
    `gh api repos/revnix/reeve/actions/runs/<id>/jobs` and look for a step whose
    conclusion is failure. If there is none, it is infrastructure, and the code is
    simply unmeasured — run the suite locally and say so.

§0.1 runs doctor; whatever it reports is the answer. §6 says what the two merge
rules MEAN; §0 holds every outcome of theirs, and deliberately records none here,
because a resumed session told to expect a finding will read real drift as the
finding it expected.

## Your tasks, in priority order

1. **Work my open pull requests' review rounds.** §0 says which are open. Comment
   "@codex review" on every one and every push; reply to AND resolve every thread
   via GraphQL, because replying alone does not clear it. Read BOTH verdict
   endpoints — findings arrive as review threads, a clean pass arrives as an ISSUE
   comment with no review object and no commit field, so only its body's
   "Reviewed commit:" line dates it. Compare `totalCount` to what you fetched,
   because `reviewThreads(first:N)` truncates silently. Check a finding's
   `original_commit_id` against the head; `headRefOid` is the MERGED head and
   answers a different question.

   **Merge rule, and it is mine, not yours to soften:** it is stated in §0 and
   nowhere else. Read it there and apply it as written. Tell me if a review is in
   flight at the moment you act — do not present the snapshot as settled — and
   GATE on the reading rather than printing it and proceeding. I have watched a
   session print "open threads: 3" and merge in the same breath.

   **If a pull request passes ten rounds and the findings are not tapering, stop
   and bring me the SHAPE rather than the next fix.** That has happened twice.
   Once we split the change in two and the halves converged where the whole never
   did. Once we replaced the instrument.

2. **Then continue the programme.** §8 has the ordering and §6 says what each
   piece needs. The next item needs a design decision from me before any code —
   ask it rather than guessing.

3. **Keep a 15-minute watcher on my open pull requests**, if one is not already
   running. It is `tools/watch-prs.sh` in the repository — run it, do not rewrite
   it. Every lesson in its header was paid for once, and the one that matters most
   is that it must emit a HEARTBEAT and alarm on a FAILED PROBE: an earlier
   version read an API blip as "the pull request closed" and exited with a line
   that looked like a clean stop.

4. **When those are done**, analyse what is left in §6 and §8 and bring me a
   recommendation with options and trade-offs. Do not pick a big new direction
   without me.

## Other sessions are alive — check before touching anything

Use ListAgents and SendMessage. Names change on restart, so LIST rather than
assume. §7 has the territory split. Ask before crossing it and expect to be asked;
that has prevented at least two collisions and cost nothing.

It has been worth real time rather than courtesy. A peer found a defect in my
outbox repair, corrected a false deadline I had passed on, gave me the import-graph
idea that found a live gap in my own code within ten minutes, and the exit-code
lesson that exposed one of my tests reading false. Verify what they claim against
the code before acting on it — doing so changed the answer twice — and concede
plainly when they are right.

## Do NOT

- Do not `git pull` or switch branches in ~/Work/Products/reeve. That is the
  running daemon's checkout. I have given standing permission to fast-forward and
  restart it after a merge — clean checkout, verify by CONTENT because a squash
  breaks ancestry, full suite green BEFORE restarting, `bootout` then `bootstrap`
  so launchd re-reads the file, then confirm with `ps` and with the daemon's own
  startup line. The first `bootstrap` has failed with "5: Input/output error" on
  every restart for two days; retry up to three times and check for a PID, never
  for the absence of an error.
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
    docs/measured/) or marked intent. Measure the PLATFORM too: `execFileSync`
    rejects a fractional timeout outright, `timeout: 0` bounds nothing, and on BSD
    `seq`, `seq 1 0` counts DOWN and prints "1 0".
  - **After writing a test, stub the fix back OUT and confirm it goes red — and
    read the EXIT CODE, not the lines.** A stub that crashes a file prints no FAIL
    line, and a grep-based loop reads that as "untested".
  - **Verify the base is GREEN before a sweep.** A pre-existing failure leaks into
    every probe, and every reading becomes a measurement of it.
  - **A control that passes for a second reason is not a control.** One of mine
    was satisfied by a different rule, so it proved the rule and not the binding.
  - **A check compared against something derived from itself cannot fail.** I
    wrote one and only found it by stubbing an impossible value in.
  - **Never `| head` a search whose result you will treat as a set.** It turns
    "these are the occurrences" into "these are some occurrences", and nothing in
    the output says which. Print the COUNT first if the listing might be long.
  - **The third instance of a shape is evidence about the DESIGN.** Remove the
    fallible read rather than correcting it again.
  - **An exemption that never fires still widens what gets through.** Stub every
    "except when" and require it to go red, or delete it.
  - **A check answers a narrower question than the caller reads it as.** That was
    the shape of most of two days' findings. Write the COMPARISON rather than a
    better rule: a test that fails when two statements of one fact disagree.
  - **A working seam nothing is plugged into is the failure to look for.** A
    projection worked for weeks and reached no decision; a stub that removed the
    wire left every test green because they all called the seam directly.
  - **Verify a merge by CONTENT.** A squash merge breaks SHA ancestry.
  - **One heredoc per shell invocation**, and assert on every text patch — a
    missed anchor must abort, never half-apply.
  - A profile edit is not in force until the daemon restarts. Verify the running
    process, not the file.

## What needs me, so you do not wait on it silently

§6 has these in full and §0 holds every current state for them, so what follows
names only what each one IS, with §0 as the source throughout: the clearing
semantics for review-body findings, the merge-authority ruleset, the merge shape,
whether to re-arm, the second project, the ntfy read user. A summary of their
status here would prime you to read real drift as the finding you were told to
expect.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```
