# Resume prompt -- the guardian lane, after 2026-09-01

Paste this whole file as the first message of a new session.

---

You are resuming the GUARDIAN lane of `reeve` (`github.com/revnix/reeve`, local
`~/Work/Products/reeve`). A previous session ran out of context. Everything you need is in
`docs/2026-09-01-guardian-handoff.md`.

**This prompt deliberately contains no facts about the current state.** Not the branch
names, not the open pull requests, not what is red. Every one of those was wrong within an
hour last time, and a resumed session that trusts a stale number spends its first hour
chasing drift that does not exist. The handoff's section 0 is the authority and it is
commands, not prose.

## Do these in order

1. **Read `docs/2026-09-01-guardian-handoff.md` in full**, then RUN its section 0.1 block.
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
- **Never merge without an explicit grant for that pull request.** A grant names one pull
  request and does not carry to the next one.
- Before saying a pull request is ready, run `node scripts/premerge.mjs <pr>` and quote its
  verdict and the head commit it names. Section 4 of the handoff is what happens when you
  do not.
- Ask when blocked, with plain-English options, pros and cons, and an honest
  recommendation. Push back when you disagree, and say so with evidence.
- No AI attribution in commits or pull requests. Conventional Commits, lowercase subject.
  Never `--no-verify`. No `as any`, no `@ts-expect-error`, no eslint-disable.
- Do not change reeve's arming in either direction without asking.
- Do not pull or switch branches in the daemon's checkout. Work in a worktree made from
  `origin/main`.

## The traps that cost this lane the most time

Each of these produced a confident, wrong answer:

- **A verification expires when the tree moves.** Re-run the whole thing after any change
  to the code under test, and carry the assertion COUNT, not just which assertion went red.
- **The daemon's checkout is not the repository.** It is never pulled and was twenty
  commits stale. Read `git show origin/main:<path>`.
- **An unquoted variable does not word-split in this shell.** It caused four separate inert
  checks in one day, each printing something plausible.
- **A killed verification leaves broken code in the working tree.** Register restore
  handlers on every signal and assert the files match afterwards.
- **Never `git stash` here.** The stash is shared by every worktree of the repository.
- **The manifest is merged by taking the base copy WHOLE and re-appending**, then verified
  by content. A count is satisfied by removing a different entry, and a reverted
  modification changes no total at all.

## What to do when you have nothing queued

Do not invent work. Read section 6 of the handoff, measure what is still open with section
0.1, and bring the founder a choice: the options, what each costs, and your honest
recommendation. Two questions in section 5 and section 6 are explicitly the founder's to
answer and not yours to start.
