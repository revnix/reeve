# Resume prompt -- paste this into a new session

Supersedes `docs/2026-09-01-resume-prompt.md`. Copy everything inside the fence.

Named to the scheme `test/newest-doc.mjs` recognises. A prefixed name is skipped by that
resolver, and the two documentation guards then police a DIFFERENT pair of documents while
reporting green -- which is what happened to the first version of the 2026-09-01 pair.

**This prompt contains no current facts.** Not the branch names, not the open pull requests,
not what is red. Every one of those was wrong within an hour last time. Section 0 of the
handoff is the authority, and it is commands rather than prose.

---

```
You are resuming the GUARDIAN lane of `reeve` (`github.com/revnix/reeve`, local
`~/Work/Products/reeve`). A previous session ran out of context. Everything you need is in
docs/2026-09-02-session-handoff.md.

**This prompt deliberately contains no facts about the current state.** Not the branch
names, not the open pull requests, not what is red. Every one of those was wrong within an
hour last time, and a resumed session that trusts a stale number spends its first hour
chasing drift that does not exist. The handoff's §0 is the authority and it is commands, not prose.

## Do these in order

1. **Run the state script with Node 24.**

   ```
   ~/.nvm/versions/node/v24.17.0/bin/node scripts/state.mjs
   ```

   The shell's default `node` on this host is v22, and the script refuses below
   v24.10 because the suite needs it -- so a bare `node` here would fail on every
   correct run and this step tells you to stop on a non-zero exit. The launchd
   job names the same absolute path for the same reason.

   Every reading it prints is a measurement or a refusal and there is no third
   thing, so an empty answer never reaches you as good news. Add `--sweep` for the
   full verification; it takes roughly twenty minutes and stops you on an
   incomplete run as well as on a finding.

   **It does not replace all of §0.1.** It covers the default branch, this
   checkout's distance from it, the running daemon and the commit that process
   loaded, the hub schema version, open pull requests, and branches with commits
   no pull request claims. Still only in §0.1 of the handoff, and still worth
   running when you need them: the open-ISSUE inventory, the daemon's live
   arguments and arming state, both `reeve doctor` reports, the shadow record,
   and the premerge / verify-merge gate for a specific pull request.

   Where the two overlap, prefer the script: §0.1's schema read reports a refusal
   on a SUCCESSFUL read (a `grep -m1` pipeline returning SIGPIPE under `pipefail`,
   141 in bash and 0 in zsh), and its sweep worktree installs no dependencies, so
   it calls a healthy main broken. A session following it stopped twice on a green
   repository. Neither defect is fixed in that document; the script is where the
   fixes are.

   Then read docs/2026-09-02-session-handoff.md for the context no command can
   give you -- the decisions, the constraints, and who holds what.

2. **Read section 2 before touching anything.** It is two defect shapes this lane produced
   repeatedly in one evening, each caught by review rather than by its own tests. The next
   instance will not resemble the listed ones, so learn the shape rather than the list.

3. **Establish who holds what by ASKING, not by reading section 3.** §0 records how many
   lanes there are; how many there are NOW is a question only they can answer, and session
   names rotate. Use `ListAgents`, then message each lane: say what you are taking, name the
   files, ask what they hold. Reading a name that no longer resolves as a fact about
   OWNERSHIP is a mistake both lanes made.

4. **Check your open pull requests for review findings and CI**, and work them. Reply to
   each thread, RESOLVE it, then re-request review with a `@codex review` comment. A thread
   answered but not resolved still counts as open and the merge gate reads it that way.

5. **Put a watcher on your open pull requests** if one is not already running. It is
   `tools/watch-prs.sh` in the repository -- run it, do not rewrite it. Pass the numbers
   explicitly, and note that this shell does not word-split an unquoted variable.

## How to work, mechanically

These are not preferences. Each was learned by shipping the failure.

- **Gate before you commit.** Run the anchor check and the linter first, in the same command
  as `git commit`, and let a failure abort before the commit is reached. Putting a guard's
  output ahead of a commit without gating on it is how red work reaches a branch.
- **Gate the push on the suite.** Run every `test/*.test.mjs`, print the head at both ends,
  and push only when the failure count is zero. A suite result from the commit BEFORE the
  one you are pushing is not evidence about it.
- **After changing behaviour, re-sweep every manifest entry that touches it** -- not the
  entries your diff adds. Entries that never mention your function still read its output.
- **When the sweep says WRONG_RED, the entry covers more than one property.** Split it.
- **Before writing any operator-facing remedy, open what it names and confirm the claim.**
  Read the guard, list the files, run the command.

## Standing instructions from the founder

- Best architectural decisions: researched, future-proof, scalable, industry standard. Best
  DX and UX. Depth over speed.
- **Read §0.2 for the merge rule and for what a grant covers -- never from memory or from
  this prompt -- and satisfy it by running `scripts/premerge.mjs` and handing over its
  verdict together with the head commit it names.**
- Ask when blocked, with plain-English options, pros and cons, and an honest recommendation.
  Push back when you disagree, with evidence.
- No AI attribution in commits or pull requests. Conventional Commits, lowercase subject.
  Never `--no-verify`. No `as any`, no `@ts-expect-error`, no eslint-disable.
- Do not change reeve's arming in either direction without asking.
- Do not pull or switch branches in the daemon's checkout.

## The traps that cost this lane the most time

The handoff states each fully; this list exists so you recognise the shape before you read it.

- A verification expires when the tree moves, and it expires toward success.
- The daemon's checkout is not the repository.
- This shell does not word-split an unquoted variable, and it applies `:t` modifiers to
  `$var:text`.
- Never stash here.
- The stub manifest has a merge procedure that section 0 and the handoff's house rules own;
  read it there rather than from memory.
- Capture the fork point BEFORE merging; a merge-base taken afterwards resolves to the other
  side and the comparison then compares that side to itself.

## What to do when you have nothing queued

Do not invent work. Read the handoff's closing sections, measure the remaining items with §0.1, then bring the founder a choice: the options, what each costs, and your honest
recommendation. Several of those questions are explicitly the founder's and not yours to
start; the handoff marks which.
```
