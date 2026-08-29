# Resume prompt — paste this into a new session

Supersedes `docs/2026-08-28-resume-prompt.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). reeve lives at
~/Work/Products/reeve (github.com/revnix/reeve).

## Read these first, in this order

  ~/Work/Products/reeve/docs/2026-08-29-session-handoff.md   <- START HERE
  ~/Work/Products/reeve/docs/2026-08-28-session-handoff.md   <- §1-§5 for what reeve IS
  ~/Work/Products/reeve/docs/TRACKER.md
  ~/Work/Products/reeve/docs/measured/                        <- the measured facts

Treat the 2026-08-29 handoff's §0 as the ONLY statement of current facts, and note
that §0 is mostly COMMANDS rather than prose. This prompt contains no current facts at all,
deliberately: it holds no current facts, and every one it might have named is
deferred to §0.

That is not tidiness. Three volatile facts were once restated in about twenty
places, and seven review rounds running found a correction applied to one copy and
left standing in the others. Two tests enforce it —
test/docs-state-is-single-sourced.test.mjs fails if a sentence naming a §0 subject
appears outside §0 without deferring or carrying a date, and
test/zero-agrees-with-the-code.test.mjs fails if §0's stage row disagrees with what
the tree contains. Both caught real errors in the handoff you are about to read,
including a stage claimed that had not landed.

## VERIFY before trusting any of it, and tell me what drifted

Run §0.1's command block. Every line matters, but six especially:

  · The `ps` line is not optional. The restart command in §0 replays launchd's
    CACHED plist, so the file can say one thing while the running process says
    another.

  · The same gap applies to CODE. A running daemon holds the modules it loaded at
    startup, so the checkout's HEAD is not what it runs. The daemon writes its own
    commit into the log when it starts. Never substitute `git log -1 HEAD`.

  · A MEASUREMENT EXPIRES. Re-measure immediately before ACTING, not once at the
    start. I measured a repository's default branch failing every recent run,
    recommended work on the strength of it, and six hours later it had been green
    most of the day. Nothing lied; the reading aged.

  · CHECK WHETHER CI IS ALIVE before believing any red run. A job reporting
    failure with ZERO steps never started, and a conclusion cannot tell you which
    happened. Count steps via the jobs endpoint.

  · Read the PROFILE, not your memory of it. Two switches decide whether the
    review half does anything, and a profile edit is not in force until restart.

  · Run the stub sweep. It reports on its own manifest, and a manifest rots
    against refactors by design — an anchor that no longer matches exactly once is
    reported UNRUNNABLE with the divergence point rather than silently skipped.

§0.1 runs doctor; whatever it reports is the answer. §6 says what the unfinished
work NEEDS; §0 holds every outcome and deliberately records none here, because a
resumed session told to expect a finding will read real drift as the expected one.

## Your tasks, in priority order

1. **Work my open pull requests' review rounds.** §0 says which are open, and
   which are MINE versus the peer session's — authorship cannot tell them apart,
   because we both push as me. Ask the peer rather than assuming.

   Comment "@codex review" on every one and every push; reply to AND resolve every
   thread via GraphQL, because replying alone does not clear it. Derive thread ids
   in the SAME command that writes the reply — pasting them from an earlier fetch
   once answered three findings on the wrong threads and reported success three
   times. Read BOTH verdict endpoints: findings arrive as review threads, a clean
   pass arrives as an ISSUE comment. Compare totalCount to what you fetched.

   **The merge rule is mine, not yours to soften:** it is stated in §0 and nowhere
   else. Read it there and apply it as written. GATE on the reading rather than
   printing it and proceeding — I have watched a session print an open-thread count
   and merge in the same breath.

   After any push, ask GitHub whether that branch's pull request has since merged.
   A push to one that has SUCCEEDS and lands nowhere.

   **And check the merge carried what you pushed.** A clean verdict from the merge
   verifier is about the SQUASH COMMIT, not about your branch's final state. Six
   fixes were answered on a pull request and never reached the default branch;
   what caught it was a COUNT disagreeing, not the tool.

   **If findings stop tapering, stop and bring me the SHAPE rather than the next
   fix.** That has happened four times. Once we split the change in two and the
   halves converged where the whole never did; once we replaced the instrument;
   once the third instance of one shape meant the design was wrong; and once the
   answer was to REMOVE the mechanism and state the boundary instead.

2. **Then continue the programme.** §8 has the ordering and §6 says what each
   piece needs. The top item is HELD on the peer session by agreement — do not
   start it on silence, ask them. The item after that needs a decision from me
   before any code.

3. **Keep a 15-minute watcher on my open pull requests**, if one is not already
   running. It is `tools/watch-prs.sh` in the repository — run it, do not rewrite
   it. It must emit a HEARTBEAT and alarm on a FAILED PROBE: an earlier version
   read an API blip as "the pull request closed" and exited with a line that looked
   like a clean stop.

4. **When those are done**, analyse what is left in §6 and §8 and bring me a
   recommendation with options and trade-offs. There is one decision already
   waiting for me there, written up with three options and a recommendation.

## Other sessions are alive — check before touching anything

Use ListAgents and SendMessage. **Names change on restart, so LIST rather than
assume** — mine changed mid-session and a message to the old name failed. §0 names
the peer's lane. Tell each other before changing the SET of clause ids
computeVerdict emits or the ORDER of nextAction's branches.

Verify what a peer claims against the code before acting on it, and concede
plainly when they are right. I once sent a collision notice for a file I was not
touching because I described my branch from memory instead of running
`git diff --name-only`. Later I found I really WAS in a file I had told them was
free — deriving it rather than recalling it is what caught that too.

## Do NOT

- Do not `git pull` or switch branches in ~/Work/Products/reeve. That is the
  running daemon's checkout. I have given standing permission to fast-forward and
  restart it after a merge — clean checkout, verify by CONTENT because a squash
  breaks ancestry, full suite green BEFORE restarting, `bootout` then `bootstrap`,
  then confirm with `ps` AND with a NEW startup line in the daemon's own log. Do
  not read a pid as proof. Allow about 8 seconds between bootout and bootstrap:
  3 seconds fails with an I/O error and leaves the service DOWN.
- Do not change reeve's arming in either direction without asking. §0 says how it
  is set.
- Never `--no-verify`. Conventional Commits. No AI attribution anywhere — a hook
  blocks the vendor's name in commits and pull request bodies, including factual
  uses; rewrite rather than argue.
- Do not use `gh pr create --body` with backticks. Write the body to a file and
  use `--body-file`.
- Do not widen your own permissions. If the harness blocks an action, explain what
  you were trying to do and let me decide. It blocked me twice on one command and
  was right to.

## House rules that earned their place

  - **Measure, do not assume.** Every claim is measured (say when, record it under
    docs/measured/) or marked intent. Measure the PLATFORM too: `timeout` does not
    exist on macOS, `$?` after a command substitution is the substitution's,
    execFileSync rejects a fractional timeout, and `process.exit` does not flush
    pending stdout.
  - **Stub the fix back OUT and read the EXIT CODE, not the lines.** Commit first,
    so `git checkout` is the restore — a sweep killed by a timeout otherwise leaves
    the tree stubbed. `scripts/stub-sweep.mjs` now does this as a repository
    artefact; add a manifest entry whenever you add a guard.
  - **A control must be able to match**, and must not pass for a second reason.
  - **When two defences are redundant BY DESIGN**, removing either alone changes
    nothing and the stub reads NOT_CAUGHT correctly. The honest stub removes both.
  - **Never discard the output of the thing whose failure you are diagnosing.** A
    harness that spawns with `stdio: "ignore"` cannot say why it failed, and a
    confident wrong cause arrives in the gap.
  - **Declare a guard's constant at the TOP of the file.** Both use-before-
    declaration bugs shipped in one session went into guards, because a guard goes
    in early and its constant goes in late. `node --check` cannot see a temporal
    dead zone.
  - **Never `| head` a search whose result you will treat as a set.**
  - **The third instance of a shape is evidence about the DESIGN.** Sometimes the
    answer is to delete the mechanism and write down the boundary.
  - **A working seam nothing is plugged into is the failure to look for.**
  - **One heredoc per shell invocation**, and assert on every text patch — a missed
    anchor must abort, never half-apply.

## What the tooling CANNOT catch, so you have to

The stub sweep proves a test can fail when the code breaks. It cannot prove the
test asserts something TRUE. Five times in one session a test passed for a reason
other than the one it named: a matcher using exact-element equality for a
substring; a fixture ending in `process.exit` so the output it existed to produce
never arrived; a marker path nested through JSON.stringify twice; an assertion
that a marker "never appears" when a control run legitimately writes it; and a
fixture that dirtied the tree on BOTH runs so the wrong check caught it.

The tell is always the same: the instrument measured something ADJACENT to the
property, and the adjacent thing was chosen because it was easier to get at. When
a test passes, ask what it would take for it to fail, and then make that happen.

## What needs me, so you do not wait on it silently

§6 has these in full and §0 holds every current state, so this names only what each
one IS: whether to re-arm, the merge shape, the CI cost decision (three options and
a recommendation are written up), the second project, and the ntfy read user.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```
