# Resume prompt — paste the block below into a fresh session

Everything between the rules is the prompt. It assumes nothing about what you remember.

---

Resume the reeve builder programme. **Do not trust any value in this prompt — read it.**
Everything here was true on 2026-08-30 and the repository moved fourteen times in the day before
this was written.

## Read these first, in this order

1. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/HANDOFF-2026-08-30.md` — the full context, every
   decision, the remaining work. **Read it completely before doing anything.** The 2026-08-29 pair
   is superseded by it.
2. On `main`: `tasks/reeve-tasks/IMPLEMENTATION-PROMPT.md` (the rules every task runs under) and
   `tasks/reeve-tasks/trackers/s3.md` §4 (decisions — binding) and §5 (durable findings).
   **§1 of that tracker is WRONG in two places — see "Fix the tracker" below.**
3. `c4:tasks/reeve-tasks/plans/2026-08-27-s3a-profile-and-registry.md` — the eleven S3-A tasks.

## Where you are

- **`main` was `25f8617`.** Re-read: `git -C ~/Work/Products/reeve-wt/vh log --oneline -1 origin/main`.
- **Nothing of yours is open.** The one open PR, **#79 `feat/premerge-gate`**, is the PEER's.
- **Issue #50 is COMPLETE but still OPEN** — close it.
- **S3-A Task 1 and Task 3 are DONE** (#81, #80). **Task 4 is next.**
- Work in **`~/Work/Products/reeve-wt/vh`**.

## Do this first

```
gh pr list --repo revnix/reeve --state open --json number,headRefName,author
```

`author` **cannot** identify your lane — the peer session shares the account. Identify by BRANCH.
An empty list is a real answer only if the same query with `--state merged` returns rows.

Then, in order:

1. **Close issue #50**, after confirming against the issue's own text (handoff §3 has the rule-by-
   rule check). It was once reported done when only one of four rules had moved.
2. **Fix `trackers/s3.md`:** P1 is marked `CLAIMED` with no PR but **merged as #57 on 2026-08-28**;
   T1 is shown as not started but **both halves have landed**.
3. **Start S3-A Task 4** — plan line **660**, "the profile reference regenerates identically".
   Re-derive every line number first.

## How to read a PR's state

Read **CI**, **both verdict endpoints**, **the reactions endpoint**, and **threads**.

- CI four-state, in this order: `pending` FIRST, then `dead`, then `ran` — the counters are **not**
  mutually exclusive. Steps do **not** live on check-runs (it returns `steps: []` for every Actions
  job); read them from `actions/jobs/<id>`.
- A clean pass is an ISSUE comment carrying `**Reviewed commit:** \`<sha>\`` — use
  `/Reviewed commit:\W{0,4}([0-9a-f]{7,40})/`, because markdown emphasis AND backticks sit between
  label and sha.
- Codex **also** posts a live-updating summary comment (marker `codex-pull-request-review-summary`)
  whose commit sits in a table cell and which is **edited in place** — read `updated_at`, or a
  fresh verdict reads as stale.
- Codex reacts `eyes` while reviewing and **`+1` when a review finishes with NO findings** — a pass
  can be a REACTION with no comment at all.
- "Something went wrong" and "usage limits" are **REFUSALS**, not passes.

**BLIND IS NOT QUIET.** A read that fails is reported as unread, never as "nothing new".

## How to work here

- **Node is `~/.nvm/versions/node/v24.17.0/bin/node`.** PATH node is v22 and four suites crash.
  **`REEVE_HOME` must point at a directory literally named `.reeve`.**
- **The four-check stub loop** on every fix: control green → **stub proven applied by a HASH
  CHANGE, not a grep** → the RIGHT assertion red → restore verified byte-identical **by file copy,
  never `git checkout`**.
- **Check the stub REACHED the path.** A stub that misses reports green; a stub that makes the code
  THROW can report as "nothing moved". Three of five acceptance-test formulations failed the first
  way; a coverage sweep under-reported the second way.
- **Judge every run on its EXIT CODE and the `all green` tail, never on a FAIL count.**
- **Before trusting any coverage or determinism measurement, assert the BASELINE IS STABLE** — run
  it twice unchanged and require zero difference. A non-deterministic scenario makes every stub
  look effective; that already produced one false "0 of 14 unwatched" claim.
- **Verify by CONTENT, never ancestry.** `git log main..branch` showing commits proves nothing —
  this repo squash-merges, so branch commits are never ancestors. Use
  `node scripts/verify-merge.mjs <pr>`.
- **zsh eats globs.** `grep --include='*.mjs'` must be quoted; `$r:src/x` is a zsh modifier. Both
  produced inert reads that looked like answers.
- **Full suite** excludes `test/escape.test.mjs`, with a `fail=0` accumulator. Measure against ONE
  base.
- **Branch from `origin/main`**, never local `main`.
- **Do not** restart the daemon, run `launchctl`, run `reeve canary`, or `git pull` in
  `~/Work/Products/reeve` — a live guardian runs from it. **Never `git stash`.**
- **NEVER MERGE.** Each PR needs Mobeen's explicit per-PR grant; grants never carry over.
  Never `--no-verify`.
- **Set a 15-minute watcher** on your open PRs if one is not running.

## The peer lane

A session named `nextly-integrations-*` (via `ListAgents`). **Their hold is over** — #50 landed.

**Their ground:** the SPILL producer in `src/daemon.mjs` around **`:2296`**, the outbox dependency
edge, `src/review/ingest.mjs`, `src/review/derive.mjs`, `scripts/stub-sweep.mjs`,
`src/stubsweep.mjs`, `test/stub-manifest.mjs`, `test/stubsweep.test.mjs`. **Their open PR #79** is
the pre-merge gate — **do not build one**; that was explicitly declined so two would not disagree.

**Tell them before touching** `src/daemon.mjs`, `src/db/**`, `src/outbox/**`, `src/github/**`,
`src/pr.mjs`, `src/verdict.mjs`, `src/watcher.mjs`, `src/review/**`, `src/prompts.mjs`.
**Ask before claiming anything that might be theirs.** They have been right every time, and three
defects in this lane's code came from them.

## The failure shape this programme keeps paying for

**Something that looks like it is working while measuring nothing.** In the last two days:

- a **completed plan** read as a completed issue — the plan was narrower by three of four rules
- a **coverage sweep** that read one scenario's non-determinism as signal, reporting every site
  covered
- a **test that asserted the defect** — requiring a map to be full of `false`, which *was* the
  collapse it claimed to prevent, under a comment saying otherwise
- an **instrument whose baseline moved with the defect**: "is this the most recent acquisition?"
  passes when a retaining session stops asking
- a **test that hung** rather than failed, silently truncating a sweep
- four instances of a **second inventory** that agrees today

**The general form:** *the instrument measured something adjacent to the property, and the adjacent
thing was chosen because it is easier to get at.* Ask what is actually being measured versus what
is meant, and expect the gap to be in the convenient direction.

**And the newest one:** when two places must agree, derive one from the other **and assert the
derivation is non-empty**. Deriving alone replaces a typo-shaped bug with a nothing-shaped one.

## Open for the founder

- **Close issue #50** (or confirm you should).
- Nothing else is blocked. **#46** and **#43** are open issues; **#43** is the fourth instance of
  the second-inventory class and was offered to the peer lane.

---

**End of prompt.**
