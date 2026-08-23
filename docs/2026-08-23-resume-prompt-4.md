# Resume prompt — S2 plan programme (supersedes resume-prompt-3)

Paste everything below the line into a fresh session.

---

You are resuming the **reeve S2 plan programme**. I am the founder (Mobeen).

## Read this first, before anything else

**`~/Work/Products/reeve-wt/pa/docs/2026-08-23-session-handoff-4.md`** — the full
handoff: state, decisions, measured facts, what remains, and the mistakes that
cost the most. Read it completely before your first action. Everything below
assumes it. Ignore `session-handoff-3.md`; it is superseded and wrong in places.

If that worktree is gone:
`git -C ~/Work/Products/reeve show plan/s2a-hub-store:docs/2026-08-23-session-handoff-4.md`

## Your first action: rebuild the paginated thread query

The helper scripts lived in a session scratchpad and died with it. **Recreate
`threads.sh` and `reply.sh` from handoff §1 before you read any thread count.**

`reviewThreads(first:100)` without pagination reports **zero unresolved** once a
PR passes 100 threads, because page 1 is the oldest threads and they are all
resolved. #12 and #13 are already past 100. I was told "all three PRs are at
zero" on exactly this bug while 44 findings sat unread — do not repeat it. Read
`totalCount` and compare it to what you fetched.

## Isolation — hard, and one is load-bearing today

A **live guardian daemon runs** from `~/Work/Products/reeve` against
`nextlyhq/nextly` under launchd `KeepAlive`, executing `bin/reeve` from that
checkout directly.

- Do **not** restart the daemon, run `launchctl`, or `git pull` in
  `~/Work/Products/reeve`. `git fetch` from a worktree is fine.
- Do **not** run `reeve canary` — it costs a real model call and writes a shared
  state file at `~/.reeve/canary/<owner>/<repo>.json` that the daemon reads.
- Work only in `~/Work/Products/reeve-wt/{pa,pb,pc}` (#11, #12, #13).
- Exclude `test/escape.test.mjs` from suite runs — it writes decoys into that
  same shared canary tree.
- `reeve doctor`, reading `src/`, and running the suite are all fine.

Other Claude sessions run concurrently. One of them merged PR #14 into reeve
mid-programme. Use `ListAgents` / `SendMessage` before claiming territory.

## The immediate work

Three **plan** PRs are open (documents only, no `src/` changes): **#11**
`plan/s2a-hub-store`, **#12** `plan/s2b-phase-machine`, **#13**
`plan/s2c-provider-scheduler`. Work the open review findings, then keep working
whatever new rounds arrive.

Counts change every twenty minutes — read them live. At handoff time #11 was at
zero and #12 and #13 each had a fresh unread round.

## Re-arm the watcher

The 15-minute watcher was a session cron and **died with the previous session**.
Re-arm it after reading the handoff:

```
/loop 15m <the watcher prompt below>
```

> Watch revnix/reeve PRs #11 (S2-A hub store), #12 (S2-B phase machine), #13
> (S2-C provider scheduler) for new review feedback and CI, and work whatever
> comes back autonomously.
>
> Each tick: (1) fetch unresolved threads with the **paginated** query for each
> PR, and also read `repos/revnix/reeve/issues/<n>/comments` — a Codex clean pass
> is an ISSUE comment, never a review object, and "Something went wrong" /
> "usage limits" are refusals. A review object with the Codex header and **zero
> inline comments** plus a 👍 reaction on the `@codex review` comment is the
> fourth shape: no suggestions. (2) If nothing is new, say so briefly and do not
> re-request pending reviews. (3) For each finding: verify the claim against the
> actual plan text or source before acting, fix it properly, assert every text
> patch's anchor matched, reply to the thread and resolve it via GraphQL. (4)
> Re-run the cross-document invariants, commit, push, comment `@codex review`.
> (5) Fold everything into the existing PRs — no new ones. (6) If B or C needs a
> column or interface A lacks, add it to A while migration 1 is still editable
> and record it in the consuming plan's consumed-interfaces table. (7) Never
> merge; never `--no-verify`; do not restart the daemon or run `reeve canary`.
> (8) Confirm `origin/main` has not moved; if it has, check whether it touched
> `src/daemon.mjs` and **re-derive every cited line number**.
>
> Worktrees: `~/Work/Products/reeve-wt/pa` (#11), `pb` (#12), `pc` (#13). Report
> per tick: which PRs had new findings, how many, what was fixed, what is open.

## How to work a finding

1. **Verify the claim against the actual text or source first.** Roughly one in
   ten needs reframing rather than applying. Two this programme were factually
   wrong and were refuted with a measurement — do that rather than arguing.
2. **Fix it properly**, with a comment saying what and why in the style of the
   surrounding text.
3. **Assert every anchor matched exactly once, and verify in the same run as the
   write.** A script that aborts before its write saves nothing; one that writes
   file A then fails on file B leaves A written.
4. **Sweep the class, not the instance.** When a finding names one site, grep for
   the rest. Never `head` an absence search; pair it with a count and a positive
   control.
5. **Reply AND resolve.** Replying alone does not clear the thread.
6. **Re-run the cross-document invariants** (handoff §5 has the script): 32
   tables; `TABLE_OWNERS`/`PROSE_TABLES` complete; `COMPARISON_SET` ↔ `HANDLERS`
   both ways; `TABLE_OWNERS.replayed` agrees with `HANDLERS`; every kind B emits
   is handled or in `NON_REPLAYED_KINDS`; A's `task.phase` CHECK equals
   `phases.mjs` at 21 states; 14 compensations with 14 table rows;
   `HOLD_ESCALATION` keys ⊆ `pr_hold`'s CHECK set.
7. **Commit, push, and comment `@codex review`** — on every push.

## Hard rules

- **Never merge.** Every PR needs my explicit per-PR grant, and a grant is spent
  when used.
- **Fold changes into the existing PRs. Do not open new ones for small changes.**
- Never `--no-verify`. Conventional Commits, lowercase, `type(scope): subject`,
  ≤72 chars. **No Claude attribution anywhere.**
- `docs/TRACKER.md` conflicts on every branch: only `pa` touches it, one line,
  last commit before opening a PR. B and C deliberately do not.
- Measure, do not assume. Every claim is either measured (say when, record it
  under `docs/measured/`) or marked as intent.
- Every test step must state what the test looks like on the **broken**
  implementation. A test that passes either way proves nothing — that has been
  the single most common defect in this programme, including in my own fixes.
- **Prefer a control that would fail on the over-fix.** Most of the durable value
  in these plans is in the `control:` assertions.

## Node

`~/.nvm/versions/node/v24.17.0/bin/node`. PATH node is v22 and `node:sqlite`
warns there.

## The question I owe you an answer on — ask me early

~380 review threads across the three PRs and no clean pass has ever arrived on
any of them. Recent rounds mostly find defects in the *previous round's fixes*,
which is a loop with no natural exit because every repair is new surface.

**Ask me what "good enough to merge" looks like before assuming the loop should
run to a clean pass.** A cap — merge at zero-open, accepting that another round
would find more — would end it. Waiting for a clean pass may not.

Work autonomously, tell me when you need something, and do not claim anything is
verified that you have not run.
