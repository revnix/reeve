# Resume prompt — paste this into a new session

Supersedes `docs/2026-08-29b-resume-prompt.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). reeve lives at
~/Work/Products/reeve (github.com/revnix/reeve).

Your first job is TWO BRANCHES THAT ARE PUSHED BUT HAVE NO PULL REQUEST. A
session that lists only pull requests will not see them and may rebuild the work.

## Read these first, in this order

  ~/Work/Products/reeve/docs/2026-08-30-session-handoff.md   <- START HERE
  ~/Work/Products/reeve/docs/2026-08-28-session-handoff.md   <- §1-§5 for what reeve IS
  ~/Work/Products/reeve/docs/TRACKER.md
  ~/Work/Products/reeve/docs/measured/                        <- the measured facts

Treat §0 as the ONLY statement of current facts, and note that §0 is mostly
COMMANDS rather than prose. This prompt contains no current facts at all;
every one it might have named is deferred to §0.

That is not tidiness. Three volatile facts were once restated in about twenty
places, and a correction was applied to one copy and left standing in the others.
Two tests enforce it — test/docs-state-is-single-sourced.test.mjs and
test/zero-agrees-with-the-code.test.mjs. Both caught real errors in the handoff you
are about to read, including a stage claimed as landed that is only on a branch.

## VERIFY before trusting any of it, and tell me what drifted

Run §0.1's command block. Every line matters, but six especially:

  · The `ps` line is not optional. The restart command replays launchd's CACHED
    plist, so the file can say one thing while the running process says another.

  · The same gap applies to CODE. A running daemon holds the modules it loaded at
    startup, so the checkout's HEAD is not what it runs.

  · A MEASUREMENT EXPIRES. Re-measure immediately before ACTING, not once at the
    start.

  · CHECK WHETHER CI IS ALIVE before believing any red run. A job reporting failure
    with ZERO steps never started. Count steps via the jobs endpoint.

  · LIST THE PUSHED BRANCHES, not just the pull requests. §0.1 has the command.

  · Run the stub sweep, and read what it says about ITS OWN manifest. An anchor that
    no longer matches exactly once is reported UNRUNNABLE with the divergence point.

§0.1 runs doctor; whatever it reports is the answer. §0 holds every outcome and this
prompt deliberately records none, because a resumed session told to expect a finding
will read real drift as the expected one.

## Your tasks, in priority order

1. **Open the two branches in §5 as pull requests, ONE AT A TIME.** Both are
   verified at the exact commit they are pushed at. Open the second only once the
   first has settled, so a red CI on one does not obscure the other.

   For each: comment "@codex review", work whatever comes back, bring it to zero
   unresolved with CI green. Reply to AND resolve every thread via GraphQL, because
   replying alone does not clear it. Derive thread ids in the SAME command that
   writes the reply — pasting them from an earlier fetch once answered three
   findings on the wrong threads and reported success three times. Read BOTH verdict
   endpoints: findings arrive as review threads, a clean pass arrives as an ISSUE
   comment. Compare totalCount to what you fetched.

   **VERIFY AFTER THE LAST PUSH, NOT DURING.** The default branch went red because a
   change was pushed while its verification was still running against the older
   head. The check existed, ran, and would have caught it; the merge did not wait.
   A green that describes a superseded commit is not a green.

   **Verification runs on an ISOLATED COPY.** `scripts/` does not hold it; it is a
   detached worktree at the branch's committed HEAD, because editing a worktree
   while its own sweep runs corrupts the reading AND destroys the edit. That
   happened three times before the mechanism changed. Rebuild it if you need it.

   **The merge rule is mine, not yours to soften:** it is stated in §0 and nowhere
   else. Read it there and apply it as written. GATE on the reading rather than
   printing it and proceeding.

   After any push, ask GitHub whether that branch's pull request has since landed,
   and check the result carried what you pushed — see §0 for the state of anything
   named here. A clean verdict from the merge verifier is about the SQUASH COMMIT,
   not your branch's final state.

   **If findings stop tapering, stop and bring me the SHAPE rather than the next
   fix.** On one pull request this session that produced two redesigns, and both
   times the answer was the same: the platform already computed what the code was
   re-deriving. Delegating removed an inventory; enumerating added a round.

2. **That cleanup is DONE** and was replaced by a lint rule. This document is
   SUPERSEDED — read `docs/2026-08-31-session-handoff.md`, whose §0 records it; the
   handoff this prompt names does not. Do not redo the cleanup.

3. **Then bring me the decisions in §6 and §8** with options and trade-offs. One is
   already written up with three options and a recommendation. Do not start the
   arming question without me.

4. **Keep a 15-minute watcher on my open pull requests.** It is `tools/watch-prs.sh`
   in the repository — run it, do not rewrite it. It must emit a HEARTBEAT and alarm
   on a FAILED PROBE: an earlier version read an API blip as "the pull request
   closed" and exited with a line that looked like a clean stop.

## Other sessions are alive — check before touching anything

Use ListAgents and SendMessage. **Names change on restart, so LIST rather than
assume.** §0 names the peer's lane. Tell them what you are on and ask what they are
on; they have been accurate and have caught real errors in my work, including a
merge that would have reverted 8KB of tracker.

Verify what a peer claims against the code before acting on it, and concede plainly
when they are right. I have twice quoted a line number that came from a checkout
several commits behind — deriving from a stale tree is indistinguishable from
recalling. Anchor on TEXT, not on line numbers.

## Do NOT

- Do not `git pull` or switch branches in ~/Work/Products/reeve. That is the running
  daemon's checkout. I have given standing permission to fast-forward and restart it
  after a merge — clean checkout, verify by CONTENT because a squash breaks
  ancestry, full suite green BEFORE restarting, `bootout` then `bootstrap`, then
  confirm with `ps` AND a NEW startup line in the daemon's own log. Do not read a
  pid as proof. Allow about 8 seconds between bootout and bootstrap: 3 seconds fails
  with an I/O error and leaves the service DOWN. Only restart when something in the
  daemon's own module graph changed; check rather than assume.
- **Do not merge `docs/s3-foundation`** to pick up the S3-A plan. §8 says why.
- Do not change reeve's arming in either direction without asking. §0 says how it is
  set.
- Never `--no-verify`. Conventional Commits. No AI attribution anywhere — a hook
  blocks the vendor's name in commits and pull request bodies, including factual
  uses; rewrite rather than argue.
- Do not use `gh pr create --body` with backticks. Write the body to a file and use
  `--body-file`.
- Do not widen your own permissions. If the harness blocks an action, explain what
  you were trying to do and let me decide.

## House rules that earned their place

  - **Measure, do not assume.** Every claim is measured (say when, record it under
    docs/measured/) or marked intent. Measure the PLATFORM too: `timeout` does not
    exist on macOS, `$?` after a command substitution is the substitution's,
    `process.exit` does not flush pending stdout, `gh pr merge` has no `--hostname`
    (`-R` takes `[HOST/]OWNER/REPO`), `URL.hostname` drops the port, and
    `.gitignore`'s `node_modules/` does not match a SYMLINK of that name.
  - **Stub the fix back OUT and read the EXIT CODE, not the lines.** Commit first,
    so `git checkout` is the restore. Add a manifest entry whenever you add a guard —
    unless the guard cannot be shown to fire, in which case add NONE and write the
    reason in the source. An entry that cannot go red for the right reason looks
    like coverage.
  - **Build the tree that should fail it.** A control proves a check does not fire
    wrongly; only a fixture that exhibits the defect proves it fires at all. The
    strongest form: build the input where the NAIVE reader gets it wrong, and assert
    that it does.
  - **A caveat that documents a hole is worse than no caveat**, because it reads as
    though the case was considered and handled.
  - **Enumerating the bad states is a deny-list on a value space you do not own.**
    Name the good states positively so an unanticipated one fails safe.
  - **When several causes share one observable outcome, assert the CAUSE.**
  - **Declare a constant ABOVE its first reader.** Three temporal-dead-zone bugs
    have shipped here; `node --check` cannot see one.
  - **A hole in an array is invisible to forEach, map and filter.** Count with an
    indexed loop.
  - **Never `| head` a search whose result you will treat as a set.** And `$` in a
    grep pattern is an anchor, not a literal — use `-F`.
  - **The third instance of a shape is evidence about the DESIGN.** Change the
    mechanism rather than trying harder to remember.
  - **One heredoc per shell invocation**, and assert on every text patch — a missed
    anchor must abort, never half-apply.

## What the tooling CANNOT catch, so you have to

The stub sweep proves a test can fail when the code breaks. It cannot prove the test
asserts something TRUE, and it cannot help when the FIXTURE is the problem. Where
they land is unambiguous: it is almost always the fixture, not the assertion. The
assertion states the right property; the tree it runs against cannot produce the
condition.

The tell is that the instrument measured something ADJACENT to the property, and the
adjacent thing was chosen because it was easier to reach. When a test passes, ask
what would have to be true for it to fail, and then make that happen.

## What needs me, so you do not wait on it silently

§0, §6 and §8 have these in full, so this names only what each one IS: whether to
re-arm, the merge shape, the CI cost decision, the R-05/R-08 decisions, the test
clock in the live store, the second project, and the ntfy read user.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```
