# Resume prompt — S2 plan programme

Paste everything below the line into a fresh session.

---

You are resuming the **reeve S2 plan programme**. I am the founder (Mobeen).

## Read this first, before anything else

**`~/Work/Products/reeve-wt/pa/docs/2026-08-23-session-handoff-3.md`** — the full
handoff: state, decisions, what remains, the mistakes made and why they matter.
Read it completely before your first action. Everything below assumes it.

If that worktree is gone, the same file is on branch `plan/s2a-hub-store`:
`git -C ~/Work/Products/reeve show plan/s2a-hub-store:docs/2026-08-23-session-handoff-3.md`

## Isolation — these are hard, and one of them is load-bearing today

A **live guardian daemon is running** from `~/Work/Products/reeve` against
`nextlyhq/nextly`, under launchd `KeepAlive`, executing `bin/reeve` from that
checkout directly.

- Do **not** restart the daemon, run `launchctl`, or `git pull` in
  `~/Work/Products/reeve`. A pull swaps code under a running process.
- Do **not** run `reeve canary` — it costs a real model call and writes a shared
  state file at `~/.reeve/canary/<owner>/<repo>.json` that the daemon reads.
- Work only in the worktrees: `~/Work/Products/reeve-wt/pa` (#11),
  `pb` (#12), `pc` (#13).
- `reeve doctor`, reading `src/`, and running the test suite are all fine.
- Exclude `test/escape.test.mjs` from suite runs — it writes into the shared
  `~/.reeve/canary/` tree the daemon reads.

Other Claude sessions run concurrently on this machine. Use `ListAgents` and
`SendMessage` to confirm nobody else is in reeve before you claim territory, and
tell them what you are taking.

## The immediate work

Three **plan** PRs are open (documents only, no `src/` changes):

- **#11** S2-A hub store — `plan/s2a-hub-store`, **0 open**
- **#12** S2-B phase machine — `plan/s2b-phase-machine`, **12 open**
- **#13** S2-C provider scheduler — `plan/s2c-provider-scheduler`, **13 open**

Work the open review findings. The handoff §8 lists all 25 with their thread IDs
and one-line summaries. Then keep working whatever new rounds arrive.

## Re-arm the watcher

The 15-minute watcher was a session cron and **died with the previous session**.
Re-arm it as your second action, after reading the handoff:

```
/loop 15m <the watcher prompt in handoff §13 / the one below>
```

Watch #11, #12 and #13 for new review feedback each tick. For each: fetch
unresolved threads via GraphQL `reviewThreads(first:100)`, **and** read
`repos/revnix/reeve/issues/<n>/comments` — a Codex **clean pass is an issue
comment**, never a review object, and "Something went wrong" / "You have reached
your Codex usage limits" are refusals, not passes. Check the verdict's
`commit_id` against the current head; an older head is stale. If nothing is new,
say so briefly and do not re-request pending reviews.

## How to work a finding

1. **Verify the claim against the actual plan text or source first.** Do not take
   a bot at face value. Roughly one in ten needs reframing rather than applying,
   and several have been sharper than they first read.
2. **Fix it properly**, with a comment saying what and why in the style of the
   surrounding text.
3. **Assert every text patch's anchor matched exactly once.** A missed anchor
   means nothing was written — and because the write happens at the end of the
   script, an abort discards the edits that already "succeeded". **Verify counts
   in the same run as the write.**
4. **Sweep the class, not the instance.** Four separate findings this programme
   were "you fixed one of these and not its siblings". When a finding names one,
   grep for the rest — and never `head` an absence search.
5. **Reply to AND resolve** each thread via GraphQL. Replying alone does not
   clear it.
6. Re-run the cross-document invariants (handoff §7): 32 tables; the `task.phase`
   CHECK in A equal to `phases.mjs` in B at 21 states; comparison-set membership
   both directions; every compensation has an `applyCompensation` branch.
7. Commit, push, and comment `@codex review` on that PR — on **every** push.

## Hard rules

- **Never merge.** Every PR needs my explicit per-PR grant, and a grant is spent
  when used.
- **Fold changes into the existing PRs. Do not open new PRs for small changes.**
- Never `--no-verify`. Conventional Commits, lowercase, `type(scope): subject`,
  ≤72 chars. **No Claude attribution anywhere.**
- `docs/TRACKER.md` conflicts on every branch: one line, last commit before
  opening a PR. #12 and #13 deliberately do not touch it.
- If B or C needs a column A does not have, add it to A's migration 1 while it is
  still editable and record it in the consuming plan's consumed-interfaces table.
- Measure, do not assume. Every claim is either measured (say when, record under
  `docs/measured/`) or marked as intent.
- Every test step must state what the test looks like on the **broken**
  implementation. A test that passes either way proves nothing — I have made that
  mistake twice in this plan already.

## Node

`~/.nvm/versions/node/v24.17.0/bin/node`. PATH node is v22 and `node:sqlite`
warns there.

## Standing question I owe you an answer on

193 review threads across the three PRs, 25 open, no clean pass yet. Each PR
reaches zero and a new round lands against the text the previous round added.
Ask me what "good enough to merge" looks like before assuming the loop should run
to a clean pass — it may never arrive.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
