# Resume prompt

Copy everything between the lines into a new session, started in
`~/Work/Products/reeve`.

---

We are continuing a build that is well advanced and running. **Read
`~/Work/Products/reeve/docs/HANDOFF.md` in full before doing anything else**,
including before asking me a clarifying question. Most of what is in it was
learned by something going wrong, and the details are the point.

## What this is

`reeve` is an agent-ops control plane at `~/Work/Products/reeve`
(`github.com/revnix/reeve`, private). It watches the pull requests my agent fleet
opens, root-causes CI failures, dispatches workers to fix them, computes whether a
PR is safe to merge, and publishes that verdict to GitHub **so that GitHub does
the refusing**. It must serve many projects of different stacks.

`docs/USING-REEVE.md` is the plain-English version, written for someone with no
context. Read it too — it is short, and it states what reeve is *not*.

## State as of 2026-08-21

- **Running as a launchd agent** (`com.revnix.reeve`) on `nextlyhq/nextly`,
  observe-only: no `--execute`, no `--enforce`. It has run unattended for eleven
  hours, survived a network outage, and pushed escalations to ntfy overnight.
- **The Codex audit list is closed.** Every finding in
  `docs/2026-08-20-reeve-comprehensive-audit.md` is either fixed or explicitly
  deferred, and the handoff says which.
- **`--execute` is proven on `revnix/reeve` only**, against PR #2 with a planted
  failure. Ten dispatches, and the failures were all defects in reeve — see the
  handoff's dispatch table. Do NOT arm it on nextly on the strength of one green
  run; the useful signal is several consecutive clean dispatches over days.

## Rules for how you work on this

1. **Measure, do not remember.** Run the command that establishes a fact before
   stating it.
2. **Every absence search needs a positive control.** One that reports zero for
   everything is broken, not conclusive.
3. **A fix needs a test that fails on the broken code — and check the stub
   applied.** A stub that silently did not apply looks exactly like a blind guard.
4. **If the same finding recurs after a fix, the fix was aimed at a symptom.**
   This happened repeatedly; stop patching and remove the fallible read.
5. **UNKNOWN never merges. Absence is never success.** Not in a verdict, not in a
   metric, not in a status screen.
6. **Never name reeve in a public or client repo.**
7. **Node on PATH is v22**; reeve needs `~/.nvm/versions/node/v24.17.0/bin/node`.
8. Conventional Commits, no attribution trailer of any kind.
9. Tell me plainly when something is unproven or wrong, including your own work.

## The lesson that cost the most, so you do not repeat it

**When a system reports a NUMBER where it holds the DETAIL, whoever reads it will
guess.** `runWorker` returned the denied commands from the first failed dispatch
and the daemon kept only the count. Two whole rounds went into reproducing by hand
what the run already knew — from hand-written prompts that did not match the
generated one, so both reproductions gave wrong answers. Printing the refused
commands was fifteen lines and named the cause immediately.

Second: **a sandbox for a code fixer cannot restrict execution.** A worker holding
`Write` can write a script and run it. What is enforceable is authority, network
and paths — plus the diff gate, which sees what happened rather than what was
permitted.

## Settled decisions — do not reopen

- The Nextly product fleet is **PAUSED**.
- **No paid reviewer.** CodeRabbit Pro Plus was declined.
- reeve **shells out to `claude`**; never the Agent SDK with a subscription token.
- reeve **never merges**. It publishes a verdict; GitHub refuses.
- The shadow week exits on **seven days with zero false blocks**, not on a date.
- `nextly-ops` **stays** until reeve can import its task graph. It is still the
  live task system.

## First thing to do

Verify the system still works using §10 of the handoff — **run those commands
separately**, they exceed a two-minute tool timeout together. Then tell me what
you found, including anything that has drifted.

Expect `doctor` to report **BROKEN** on nextly. That is correct.

## Then

Ask me before starting anything large. The two candidates are: more `--execute`
dispatches on `revnix/reeve` to build the evidence for arming nextly, or the
remaining non-audit work (task import so `nextly-ops` can retire, and an
operational backup for `~/.reeve/state/`, which is currently one copy on one
laptop).
