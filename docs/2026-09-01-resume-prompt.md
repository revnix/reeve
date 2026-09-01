# Resume prompt -- paste this into a new session

Supersedes `docs/2026-08-31-resume-prompt.md`. Copy everything inside the fence.

Named to the scheme `test/newest-doc.mjs` recognises. A prefixed name is skipped by that
resolver, and the two documentation guards then police a DIFFERENT pair of documents while
reporting green -- which is what happened to the first version of this file.

**This prompt contains no current facts.** Not the branch names, not the open pull
requests, not what is red. Every one of those was wrong within an hour last time. §0 of the
handoff is the authority, and it is commands rather than prose.

---

```
You are resuming the GUARDIAN lane of `reeve` (`github.com/revnix/reeve`, local
`~/Work/Products/reeve`). A previous session ran out of context. Everything you need is in
docs/2026-09-01-session-handoff.md.

**This prompt deliberately contains no facts about the current state.** Not the branch
names, not the open pull requests, not what is red. Every one of those was wrong within an
hour last time, and a resumed session that trusts a stale number spends its first hour
chasing drift that does not exist. The handoff's section 0 is the authority and it is
commands, not prose.

## Do these in order

1. **Read docs/2026-09-01-session-handoff.md in full**, then RUN its section 0.1 block.
   Do not skip it because the prose above it looks current. If any command in that block
   fails, stop: the block is chained precisely so a failed read cannot reach you as an
   empty answer, and an empty answer there reads as good news.

2. **Read section 2 before touching anything.** It is one defect shape found eleven times
   in eleven mechanisms in a single day. The next instance will not resemble any of the
   eleven, so learn the shape rather than the list.

3. **Establish who holds what by ASKING, not by reading section 3.** Other sessions work
   this repository at the same time. Use `ListAgents`, then message the lanes: say what you
   are taking, name the files, and ask what they hold. Two seam rulings in this handoff were
   decided by measuring imports rather than by the territory list, because the list was
   wrong about both.

4. **Check your open pull requests for review findings and CI**, and work them. Reply to
   each thread, RESOLVE it, then re-request review with a `@codex review` comment. A thread
   answered but not resolved still counts as open and the merge gate reads it that way.

5. **Put a watcher on your open pull requests** if one is not already running. It is
   `tools/watch-prs.sh` in the repository -- run it, do not rewrite it. Pass the numbers
   explicitly, and note that this shell does not word-split an unquoted variable, so
   `$list` arrives as one argument and the watcher then watches one thing that does not
   exist.

## Standing instructions from the founder

- Best architectural decisions: researched, future-proof, scalable, industry standard.
  Best DX and UX. Depth over speed.
- **Never merge without an explicit grant naming that pull request.** The handoff's
  house-rules section states the rule and what it costs when it is treated loosely.
- Before saying a pull request is ready, run the pre-merge gate and quote its verdict with
  the head commit it names; §0 of the handoff owns what that gate reports. A whole section
  is devoted to what happened when that step was skipped -- read it before your first
  merge request.
- Ask when blocked, with plain-English options, pros and cons, and an honest
  recommendation. Push back when you disagree, with evidence.
- No AI attribution in commits or pull requests. Conventional Commits, lowercase subject.
  Never `--no-verify`. No `as any`, no `@ts-expect-error`, no eslint-disable.
- Do not change reeve's arming in either direction without asking.
- Do not pull or switch branches in the daemon's checkout. The handoff explains why, and
  §0.1 measures how far it has drifted.

## The traps that cost this lane the most time

Each produced a confident, wrong answer. The handoff's house-rules section states each one
fully; this list exists so you recognise the shape before you read it.

- A verification expires when the tree moves, and it expires toward success.
- The daemon's checkout is not the repository.
- This shell does not word-split an unquoted variable. Four inert checks in one day.
- A killed verification leaves broken code in the working tree.
- Never stash here.
- The stub manifest is merged by taking the base copy whole and re-appending, then verified
  by content rather than by count; §0 owns the numbers.

## What to do when you have nothing queued

Do not invent work. Read the handoff's closing sections and measure the remaining items
with §0.1, then bring the founder a choice: the options, what each costs, and your honest
recommendation. Two of those questions are explicitly the founder's to answer and not yours
to start; the handoff marks which.
```
