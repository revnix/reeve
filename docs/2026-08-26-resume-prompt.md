# Resume prompt — paste this into a new session

Supersedes `docs/2026-08-24-resume-prompt.md`. Copy everything inside the fence.

---

```
Resume the reeve build. I am the founder (Mobeen). reeve lives at
~/Work/Products/reeve (github.com/revnix/reeve, private).

## Read these first, in this order

  ~/Work/Products/reeve/docs/2026-08-26-session-handoff.md   <- START HERE
  ~/Work/Products/reeve/docs/TRACKER.md
  ~/Work/Products/reeve/docs/measured/                        <- the measured facts

Treat the handoff's §0 as the ONLY statement of current facts, and note that §0
itself is mostly COMMANDS rather than prose. This prompt contains no current facts
at all, deliberately.

That is not tidiness. Three volatile facts were once restated in about twenty
places, and seven review rounds in a row found a correction applied to one copy
and left standing in the others. Then `main` moved twice in one afternoon while
the file said otherwise, which taught the harder half: a fact a command can answer
should not be written down at all. `test/docs-state-is-single-sourced.test.mjs`
now fails if a present-tense state claim, or a block naming a §0 subject, appears
in either document outside §0 without deferring to it.

## VERIFY before trusting any of it, and tell me what drifted

Run §0.1's command block. Every one of those lines matters, but two especially:

  · The `ps` line is not optional. `launchctl kickstart` restarts from launchd's
    CACHED plist, so the file can say `--execute` while the running process does
    not. That happened once and I nearly reported it as done. If the process and
    §0 disagree about arming, find out which changed before doing anything else.

  · The sqlite line must use `-readonly` and the PER-REPO path. `sqlite3` opens a
    missing file by CREATING it, so a wrong path answers "zero rows" for a
    database it just made. That exact mistake produced a confident zero once.

Expect doctor `broken` on R-01 and R-03. Both are mine and both are in §6.

## Your tasks, in priority order

1. **Work my open PRs' review rounds.** §0 says which are open. Comment
   "@codex review" on every PR and every push; reply to AND resolve every thread
   via GraphQL, because replying alone does not clear it. Read BOTH verdict
   endpoints — findings arrive as review threads, a clean pass arrives as an ISSUE
   comment with no review object and no commit field, so only its body's
   "Reviewed commit:" line dates it. Compare `totalCount` to what you fetched,
   because `reviewThreads(first:N)` truncates silently. Check a finding's
   `original_commit_id` against the head; `headRefOid` is the MERGED head and
   answers a different question.

   **Merge rule, and it is mine, not yours to soften:** merge when CI is green AND
   zero threads are open. I reaffirmed that after being told a verdict often lands
   after the state reads clean. Tell me if a review is in flight at the moment you
   merge — do not present the snapshot as settled — but merge.

   **If a PR passes ten review rounds without the findings tapering, stop and
   bring me the shape rather than the next fix.** That happened once, we split the
   PR, and the halves converged where the whole never did. The repository's own
   measurement is that crossing ~10 changed files roughly triples the rounds.

2. **Then continue the capability-3 programme.** §3.2 has the four-PR plan and
   where it has got to. Do not re-derive §3.3 — every property in it was a review
   finding first, and the list exists so you do not pay for them twice.

3. **Keep a 15-minute watcher on my open PRs**, if one is not already running.
   §5 says where it is and what it must do. It must emit a HEARTBEAT and alarm on
   a FAILED PROBE: an earlier version read an API blip as "the PR closed" and
   exited with a line that looked like a clean stop.

4. **When those are done**, analyse what is left in §6 and §8 and bring me a
   recommendation with options and trade-offs. Do not pick a big new direction
   without me.

## Other sessions are alive — check before touching anything

Use ListAgents and SendMessage. Names change on restart, so LIST rather than
assume; a peer of mine was unreachable under the name it had used an hour
earlier. §7 has the territory split and the one overlap that needs a conversation
before it starts.

This has been worth real time rather than courtesy: a peer found a defect in my
outbox repair, corrected a false deadline I had already passed on, gave me the
import-graph idea that found a live gap in my own code within ten minutes, and the
exit-code lesson that exposed one of my tests reading false. Verify what they
claim against the code before acting on it — doing so changed the answer twice —
and concede plainly when they are right.

## Do NOT

- Do not `git pull` or switch branches in ~/Work/Products/reeve. That is the
  running daemon's checkout. I have given standing permission to fast-forward and
  restart it after a merge — clean checkout, verify by CONTENT, full suite green
  BEFORE restarting, `bootout` then `bootstrap` so launchd re-reads the file, then
  confirm the running flags with `ps`. Arming never changes without asking.
- Do not change reeve's arming in either direction without asking. §0 says how it
  is set; whatever it says was a deliberate call and is mine to reverse.
- Never `--no-verify`. Conventional Commits. No AI attribution anywhere — a hook
  blocks the vendor's name in commits and PR bodies, including factual uses;
  rewrite rather than argue.
- Do not use `gh pr create --body` with backticks in it. The shell eats fenced
  blocks and I have shipped a PR body with the evidence silently removed. Write
  the body to a file and use `--body-file`.

## House rules that earned their place

  - **Measure, do not assume.** Every claim is measured (say when, record it under
    docs/measured/) or marked intent. Measure the PLATFORM too: `execFileSync`
    rejects a fractional timeout outright, `timeout: 0` bounds nothing, and
    ENOBUFS and ETIMEDOUT differ only in `code`.
  - **After writing a test, stub the fix back OUT and confirm it goes red — and
    read the EXIT CODE, not just the lines.** A stub that makes a file crash
    prints no FAIL line, and a grep-based loop reads that as "untested".
  - **Check the fixture can exhibit the defect.** Repeatedly the reason a test
    passed: a shared database meant the row a block was named for was never the row
    leased; an async handler was used where production is synchronous.
  - **The third instance of a shape is evidence about the DESIGN.** Remove the
    fallible read rather than correcting it again. A denylist widened three times
    should have been an allowlist.
  - **A guard that lives in the caller is not a guard.** A rule applied at one of
    two sites is a near miss that has already happened.
  - **Never read ABSENCE as success.** Read a positive signal that the check RAN.
  - **Assert the property, not the wording** — but do not delete an assertion as
    redundant without checking what it actually covered.
  - **A reserve must be taken from the quantity being spent.** A floor derived from
    the wrong number was 50s of a 60s budget.
  - **Verify a merge by CONTENT.** A squash merge breaks SHA ancestry.
  - **One heredoc per shell invocation**, and assert on every text patch — a
    missed anchor must abort, never half-apply.
  - A profile edit is not in force until the daemon restarts (`loadProfile` runs
    once at startup). Verify the running process, not the file.

## What needs me, so you do not wait on it silently

§6 has these in full. In short: R-01, the ruleset that lets admins bypass every
rule and requires no status check; whether to re-arm; the second project; and the
ntfy read user.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
```
