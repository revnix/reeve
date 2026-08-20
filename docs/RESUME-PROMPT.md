# Resume prompt

Copy everything between the lines into a new session, started in
`~/Work/Products/reeve`.

---

We are continuing a build that is already well advanced. **Read
`~/Work/Products/reeve/docs/HANDOFF.md` in full before doing anything else**, including before
asking me a clarifying question. It carries the entire context, every founder ruling, every
measured fact, and the list of what remains. Do not skim it — the details are the point, and most
of them were learned by something going wrong.

## What this is

`reeve` is an agent-ops control plane at `~/Work/Products/reeve` (`github.com/revnix/reeve`,
private). It watches the pull requests my agent fleet opens, root-causes CI failures, dispatches
workers to fix them, computes whether a PR is safe to merge, and publishes that verdict to GitHub
so GitHub does the refusing. It replaces `nextly-ops`, whose merge gate had merged zero of its last
ten merges while claiming to be the only sanctioned path.

It must serve **many projects of different stacks**, not one. That is the primary requirement.

## Rules for how you work on this

1. **Measure, do not remember.** Every number in the handoff was measured. If you are about to
   state a fact, run the command that establishes it. If you cannot, say so.
2. **Every absence search needs a positive control.** An absence search that reports zero for
   everything is broken, not conclusive. This has already caused a near-miss deletion.
3. **A fix needs a test that fails on the broken code.** Write it, watch it fail, then fix. A test
   you did not see fail proves nothing.
4. **If the same finding recurs in a new place after a fix, the fix was aimed at a symptom.**
   Stop patching and remove the fallible read. This happened three times in one session before I
   caught it.
5. **UNKNOWN never merges.** Absence is never success. Every fail-open defect in the old system was
   an UNKNOWN rendered as a PASS.
6. **Never name reeve in a public repo or a client repo** — not in a check context, a workflow, a
   branch, a commit message or a committed file. Neutral names only.
7. **Node on PATH is v22; reeve needs v24.** Always invoke
   `~/.nvm/versions/node/v24.17.0/bin/node`.
8. Commit messages follow Conventional Commits, describe the code rather than the process, and
   **carry no attribution trailer of any kind**.
9. Tell me plainly when something is unproven, half-finished or wrong — including your own earlier
   work. I would rather hear it than have it look finished.

## Settled decisions — do not reopen

The handoff has all sixteen. The ones most likely to be accidentally re-litigated:

- The Nextly product fleet is **PAUSED** and stays paused until reeve can watch it.
- **No paid reviewer.** CodeRabbit Pro Plus was explicitly declined. Do not raise it again.
- reeve **shells out to `claude`**; it must never embed the Agent SDK with my subscription token.
- reeve **never calls merge** on its own authority. It publishes a verdict; GitHub refuses.
- The shadow week exits only on **seven days of data with zero false blocks**.

## First thing to do

Verify the system still works, using the block in §10 of the handoff. Then tell me what you found,
including anything that has drifted since the handoff was written. Expect `doctor` to report
**BROKEN** on nextly — that is correct and will stay true until the ruleset is repaired.

## Then

The recommended next task is **proving the daemon overnight**: install the validated launchd agent
at `~/Work/Products/reeve/deploy/com.revnix.reeve.plist`, run in shadow mode with `--execute` off,
and read the log in the morning. This is the project's entire stated purpose and it has never been
demonstrated. It needs nothing from me.

The strongest alternative is **fixing the three reviewer lenses**, because they gate the merge
condition and Codex is 93% refused. Tell me which you would pick and why, then proceed — do not
wait for me unless the choice genuinely changes what gets built.

Section 8 of the handoff has the full remaining list in order. Section 9 has the traps that will
bite you; read it before your first Bash command, particularly the one about the archive guard
refusing commands that merely name a path.

---

## Optional additions

If you want the new session to start on something specific instead, replace the "Then" section
with one of:

- *"Start with the state migration: JSONL to reeve's SQLite store. It is what makes deleting
  `bin/ledger`, `dispatch`, `merge-gate` and `dashboard` possible."*
- *"Start by proving the core/profile seam on a second project. Use `rext-backend` (Python, uv,
  alembic) or `21century-web-v4` (Next.js, dual lockfiles, no CI). Anything you must edit in the
  core to make it work was misfiled."*
- *"Start by fixing the three reviewer lenses in
  `~/Work/Products/nextly-workspace/nextly-ops/plugins/agent-ops/agents/reviewer-*.md`, then port
  them into reeve."*
