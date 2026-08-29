# Resume prompt — paste this into a new session

Supersedes `docs/2026-08-29-resume-prompt.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). reeve lives at
~/Work/Products/reeve (github.com/revnix/reeve).

Your first job is the sweep pull request. It is mine, it is open, and §10 of the
handoff is written for you specifically.

## Read these first, in this order

  ~/Work/Products/reeve/docs/2026-08-29-session-handoff.md   <- START HERE, then §10
  ~/Work/Products/reeve/docs/2026-08-28-session-handoff.md   <- §1-§5 for what reeve IS
  ~/Work/Products/reeve/docs/TRACKER.md
  ~/Work/Products/reeve/docs/measured/                        <- the measured facts

Treat §0 as the ONLY statement of current facts, and note that §0 is mostly
COMMANDS rather than prose. This prompt holds no current facts at all; every one
it might have named is deferred to §0.

That is not tidiness. Three volatile facts were once restated in about twenty
places, and seven review rounds running found a correction applied to one copy and
left standing in the others. Two tests enforce it —
test/docs-state-is-single-sourced.test.mjs and
test/zero-agrees-with-the-code.test.mjs. Both have caught real errors in the very
document you are about to read, including a stage claimed that had not landed.

## VERIFY before trusting any of it, and tell me what drifted

Run §0.1's command block. Every line matters, but six especially:

  · The `ps` line is not optional. The restart command in §0 replays launchd's
    CACHED plist, so the file can say one thing while the running process says
    another.

  · The same gap applies to CODE. A running daemon holds the modules it loaded at
    startup, so the checkout's HEAD is not what it runs. Never substitute
    `git log -1 HEAD`.

  · A MEASUREMENT EXPIRES. Re-measure immediately before ACTING, not once at the
    start. I measured a repository's default branch failing every recent run,
    recommended work on it, and six hours later it had been green most of the day.

  · CHECK WHETHER CI IS ALIVE before believing any red run. A job reporting
    failure with ZERO steps never started, and a conclusion cannot tell you which
    happened. Count steps via the jobs endpoint.

  · Read the PROFILE, not your memory of it.

  · Run the stub sweep, and read what it says about ITS OWN manifest. An anchor
    that no longer matches exactly once is reported UNRUNNABLE with the divergence
    point. That has caught several of my own refactors, in the same session that
    made them.

§0.1 runs doctor; whatever it reports is the answer. §0 holds every outcome and
this prompt deliberately records none, because a resumed session told to expect a
finding will read real drift as the expected one.

## Your tasks, in priority order

1. **Finish the sweep pull request.** §0 says which pull requests are open and §10
   is entirely about this one. Identify it by the FILES it touches, not by author —
   every pull request here is pushed as me, so authorship cannot tell my lane from
   the peer's. §10 names the four files.

   Its last round is fixed and pushed, or nearly so; check §0 and the branch state
   rather than assuming either way. Then: comment "@codex review", work whatever
   comes back, and bring it to zero unresolved with CI green.

   Read §10.3 before you touch it. Four fixes on that pull request were shipped
   UNVERIFIED, and two of the tests written to close that gap could not exhibit
   their own defect. That is the failure mode to expect from yourself here.

   Comment "@codex review" on every push; reply to AND resolve every thread via
   GraphQL, because replying alone does not clear it. Derive thread ids in the SAME
   command that writes the reply — pasting them from an earlier fetch once answered
   three findings on the wrong threads and reported success three times. Read BOTH
   verdict endpoints: findings arrive as review threads, a clean pass arrives as an
   ISSUE comment. Compare totalCount to what you fetched.

   **The merge rule is mine, not yours to soften:** it is stated in §0 and nowhere
   else. Read it there and apply it as written. GATE on the reading rather than
   printing it and proceeding.

   After any push, ask GitHub whether that branch's pull request has since merged,
   and check the merge carried what you pushed — a clean verdict from the merge
   verifier is about the SQUASH COMMIT, not your branch's final state. That exact
   gap is why this pull request exists at all.

   **If findings stop tapering, stop and bring me the SHAPE rather than the next
   fix.** That has happened four times. Once splitting the change made the halves
   converge where the whole never did; once we replaced the instrument; once the
   third instance of one shape meant the design was wrong; and once the answer was
   to REMOVE the mechanism and write down the boundary instead.

2. **Then bring me the shadow divergence.** §9 has the full diagnosis: the
   projection can only grow, so a thread deleted on GitHub is counted for ever, in
   both the total and the resolved count. The cause is established and the fix's
   shape is written down. It is NOT started, and §9.4 says why — including the
   reason it is not urgent. Do not start it without telling me; it is new work in
   this lane rather than a review round, and the failure mode of a wrong fix is
   that the projection silently drops threads that gate a merge.

3. **Keep a 15-minute watcher on my open pull requests**, if one is not already
   running. It is `tools/watch-prs.sh` in the repository — run it, do not rewrite
   it. It must emit a HEARTBEAT and alarm on a FAILED PROBE: an earlier version
   read an API blip as "the pull request closed" and exited with a line that looked
   like a clean stop.

4. **When those are done**, analyse what is left in §6 and §8 and bring me options
   with trade-offs. One decision is already written up there with three options and
   a recommendation.

## Other sessions are alive — check before touching anything

Use ListAgents and SendMessage. **Names change on restart, so LIST rather than
assume** — mine changed mid-session and a message to the old name failed outright.
§0 names the peer's lane, and §10 names the files they have agreed to stay out of.

Verify what a peer claims against the code before acting on it, and concede plainly
when they are right. I once sent a collision notice for a file I was not touching
because I described my branch from memory instead of running `git diff --name-only`.
Later I found I really WAS in a file I had told them was free — deriving rather
than recalling caught that too. A peer's lead was also right about a gap in my own
work that I had not looked for.

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
    `process.exit` does not flush pending stdout, and two stdout writes can coalesce
    into one data event before a stderr write between them arrives.
  - **Stub the fix back OUT and read the EXIT CODE, not the lines.** Commit first,
    so `git checkout` is the restore. `scripts/stub-sweep.mjs` does this as a
    repository artefact; add a manifest entry whenever you add a guard.
  - **Build the tree that should fail it.** An assertion over a fixture that cannot
    produce the condition is the most common way a test lies here.
  - **When several causes share one observable outcome, assert the CAUSE.** One exit
    code meant two different refusals, and only a second assertion separated them.
  - **When two defences are redundant BY DESIGN**, removing either alone changes
    nothing and the stub reads NOT_CAUGHT correctly. The honest stub removes both.
  - **A control must be able to match**, and must not pass for a second reason.
  - **Never discard the output of the thing whose failure you are diagnosing.**
  - **Declare a guard's constant at the TOP of the file.** Both use-before-
    declaration bugs shipped in one session went into guards. `node --check` cannot
    see a temporal dead zone, and it cannot see a block placed outside a braceless
    loop either — both parse.
  - **Never `| head` a search whose result you will treat as a set.**
  - **The third instance of a shape is evidence about the DESIGN.** Sometimes the
    answer is to delete the mechanism and write down the boundary.
  - **A working seam nothing is plugged into is the failure to look for.**
  - **One heredoc per shell invocation**, and assert on every text patch — a missed
    anchor must abort, never half-apply.

## What the tooling CANNOT catch, so you have to

The stub sweep proves a test can fail when the code breaks. It cannot prove the
test asserts something TRUE, and it cannot help when the FIXTURE is the problem.
Six times in this pull request lineage a test passed for a reason other than the
one it named, and the pattern in where they land is unambiguous: it is almost
always the fixture, not the assertion. The assertion states the right property; the
tree it runs against cannot produce the condition.

The tell is that the instrument measured something ADJACENT to the property, and
the adjacent thing was chosen because it was easier to reach. When a test passes,
ask what would have to be true for it to fail, and then make that happen.

## What needs me, so you do not wait on it silently

§6 and §9 have these in full and §0 holds every current state, so this names only
what each one IS: whether to re-arm, the merge shape, the CI cost decision, whether
to start the shadow-divergence fix, the second project, and the ntfy read user.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```
