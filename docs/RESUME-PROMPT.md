# Resume prompt

Copy everything between the lines into a new session, started in
`~/Work/Products/reeve`.

---

We are continuing a build that is already running in production. **Read
`~/Work/Products/reeve/docs/HANDOFF.md` in full before doing anything else**,
including before asking me a clarifying question. Then read
`~/Work/Products/reeve/docs/USING-REEVE.md`, which is short and says what reeve
is *not*.

Do not skim either. Most of what is in them was learned by something going wrong,
and the details are the point.

## What this is

`reeve` is an agent-ops control plane at `~/Work/Products/reeve`
(`github.com/revnix/reeve`, private). It watches the pull requests my agent fleet
opens, root-causes CI failures, dispatches workers to fix them, computes whether a
PR is safe to merge, and publishes that verdict to GitHub **so that GitHub does
the refusing**. It must serve many projects of different stacks — that is the
primary requirement, not a nice-to-have.

## State as of 2026-08-21, end of the third session

- **69 commits, 37 test files, 0 failing, CI green on main.**
- **The daemon is RUNNING** as a launchd agent (`com.revnix.reeve`) on
  `nextlyhq/nextly`, **observe-only**: no `--execute`, no `--enforce`. 260+ ticks,
  survived a network outage, escalates to ntfy topic `revnix-reeve`.
- **Hourly backups** with a restore verified against the real store.
- **The Codex audit list is closed** — every finding fixed or explicitly deferred.
- **`--execute` has THREE clean CI-verified runs out of fifteen**, across two
  failure shapes. Run 15 is the one worth trusting: a logic inversion in
  `src/db/ops.mjs` failing three assertions in `test/lifecycle.test.mjs`, so the
  failing test did not name the module at fault. Run 13 refused to dispatch at
  all, correctly, and that refusal exposed a real defect.
- The third session found **four defects that 576 passing assertions did not**,
  all by running the system and reading what it stored. See §6.5 of the handoff.

## Rules for how you work on this

1. **Measure, do not remember.** Run the command that establishes a fact before
   stating it. If you cannot, say so.
2. **Every absence search needs a positive control.** One that reports zero for
   everything is broken, not conclusive.
3. **A fix needs a test that fails on the broken code — and verify the stub
   applied.** A stub that silently did not apply looks exactly like a blind guard,
   and I nearly rewrote a working guard because of one.
4. **A fixture that cannot exhibit the defect proves nothing.** Two of my
   verifications last session were like this, and one of them let a real security
   hole through while I wrote a commit message claiming it was proven.
5. **Read the WHOLE log before claiming an outcome.** I reported a dispatch as a
   success from a partial read; the branch had moved because a worker bypassed the
   gate, and the tick had crashed.
6. **If the same finding recurs after a fix, the fix was aimed at a symptom.**
   This happened repeatedly. Stop patching and remove the fallible read.
7. **UNKNOWN never merges. Absence is never success.** Not in a verdict, not in a
   metric, not in a status screen.
8. **Never name reeve in a public or client repo.**
9. **Node on PATH is v22**; reeve needs `~/.nvm/versions/node/v24.17.0/bin/node`.
10. Conventional Commits, no attribution trailer of any kind.
11. Tell me plainly when something is unproven, half-finished or wrong —
    including your own work. I would rather hear it than have it look finished.

## The two lessons that cost the most, so you do not repeat them

**A system that reports a NUMBER where it holds the DETAIL will be guessed at.**
`runWorker` returned the denied commands from the first failed dispatch and the
daemon kept only the count. Two whole rounds went into reproducing by hand what
the run already knew, from hand-written prompts that did not match the generated
one — so both reproductions gave wrong answers. Printing the refused commands was
fifteen lines and named the cause immediately.

**A sandbox for a code fixer cannot restrict execution.** A worker holding `Write`
can write a script and run it. What is enforceable is authority, network and paths
— plus the diff gate, which sees what happened rather than what was permitted. I
made this mistake twice in one session, in two different shapes, after already
measuring it once.

## Settled decisions — do not reopen

- The Nextly product fleet is **PAUSED**.
- **No paid reviewer.** CodeRabbit Pro Plus was explicitly declined.
- reeve **shells out to `claude`**; never the Agent SDK with a subscription token.
- reeve **never merges**. It publishes a verdict; GitHub refuses.
- A worker **never publishes**. reeve does, after checking the diff.
- The shadow week exits on **seven days with zero false blocks**, not on a date,
  and the clock runs from 2026-08-21.
- **`nextly-ops` stays.** It is still the live task graph; reeve has no task
  import and the two systems track different things.

## What the last session learned, in one line

**The defects that matter are not found by reading code or adding assertions.**
Two of the three were visible only in stored state — a `fix_attempt` row and
doctor's rendered output. Budget for USE, not for review.

## First thing to do

Verify the system still works using **§10 of the handoff** — run those commands
**separately**, they exceed a two-minute tool timeout together. Then tell me what
you found, including anything that has drifted since 2026-08-21.

Expect `doctor` to report **BROKEN** on nextly. That is correct and will stay true
until the ruleset is repaired, which is deliberately last.

## Then

The recommended next task is **the failure shapes still untested** (§10 of the
handoff has the recipe, and the caveat that re-planting the SAME failure trips the
retry brake by design). Three clean runs across two shapes is real evidence, but
what remains untested is the harder half: an INTERMITTENT failure, one with two
independent causes, one whose fix spans several files, and — most importantly —
**what happens when a worker is WRONG.** Every run so far produced a correct fix,
so the second-attempt path and the escalation after it have never been exercised
by a genuine bad fix. Each dispatch takes about three minutes and costs roughly
$1.50-2.

The strongest alternative is **reeve auditing itself on a schedule** — running
`doctor` against its own health and escalating when it degrades. That is the first
real step toward the founder's standing goal that reeve "watch its own work and
keep improving", and it is small. It is now honest to schedule, which it was not
before: `doctor` reported UNKNOWN for its own lease health until this session.

Section 8 of the handoff has the full remaining list in order. Section 9 has the
traps; read it before your first Bash command, particularly the archive-guard hook
and the note about scripted edits to `daemon.mjs`.

Tell me which you would pick and why, then proceed — do not wait for me unless the
choice genuinely changes what gets built.

---

## Optional replacements for the "Then" section

- *"Start by proving the core/profile seam on `rextaihq/rext-backend` — 85 merges
  in 90 days, real workflows, python/uv plus typescript. Anything you must edit in
  the core to make it work was misfiled."*
- *"Start with the Go and PHP command tables in `src/profile/detect.mjs`. Go and
  Rust detect as languages but yield no commands; PHP does not detect at all, and
  there are 8 PHP repos in the portfolio."*
- *"Start with review ingest: round counting from distinct reviewed heads,
  severity from finding text, thread identity. `watch.reviewActions` stays false
  until it is complete and tested end to end."*
