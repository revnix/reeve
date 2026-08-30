> **SUPERSEDED by the 2026-08-30 pair.** Its §0 says issue #50 is *under way*; #50 is
> COMPLETE. Read `HANDOFF-2026-08-30.md` and `RESUME-PROMPT-2026-08-30.md` instead.
> Kept because its findings sections are still accurate and are cited.

# Resume prompt — paste the block below into a fresh session

Everything between the rules is the prompt. It assumes nothing about what you remember.

---

Resume the reeve builder programme. **Do not trust any value in this prompt — read it.**
Everything here was true on 2026-08-29 and the repository moves several times a day; it moved nine
times during the session that wrote this.

## Read these first, in this order

1. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/HANDOFF-2026-08-29.md` — the full context, every
   decision, the remaining work. **Read it completely before doing anything.**
2. The body of **issue `reeve#50`** and its **two comments** — that is the design of record for the
   work in flight, and the comments carry design changes made after the issue was written.
3. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/ISSUE-50-SESSION-DESIGN.md` — the six-PR
   sequence, §5's characterisation strategy, §7's what-it-does-not-solve.
4. On `main`: `tasks/reeve-tasks/IMPLEMENTATION-PROMPT.md` (the rules every task runs under) and
   `tasks/reeve-tasks/trackers/s3.md` §4 (decisions — binding, not to be re-litigated) and §5
   (durable findings, including the nine places the design brief is wrong).

## Where you are

- **`main` was `7fdb143`.** Re-read it: `git -C ~/Work/Products/reeve-wt/ch log --oneline -1 origin/main`.
- **Two open PRs are yours:** **#69** `feat/characterise-tick` (worktree `reeve-wt/ch`) and
  **#68** `fix/verdict-names-its-head` (worktree `reeve-wt/vh`). **#67 is the peer's — do not touch it.**
- **`reeve#50` is in flight.** PR-0 of six merged as `87f437b`. #69 is PR-1.
- **F5 is DONE** — the three spec repos exist and are private.

## Do this first

```
gh pr list --repo revnix/reeve --state open --json number,headRefName
```

Then for each PR of yours read **both** verdict endpoints — findings are **review objects**, a
clean pass is an **issue comment** carrying ``**Reviewed commit:** `<sha>` `` (markdown emphasis
AND backticks sit between the label and the sha, so a whitespace-only regex matches nothing and
reads as "no pass"). Check each verdict's sha against the current head. Then unresolved threads via
GraphQL `reviewThreads(first:100)`.

**BLIND IS NOT QUIET.** A read that fails is reported as unread, never as "nothing new".

## The work, in order

1. **#69 has THREE unresolved findings.** They are one shape — *a field in the signature that
   looks populated but cannot detect the change it exists for*. Handoff §2 has the substance:
   - the `maintenance-on-release-and-cooldown` scenario never reaches the cooldown half, so its
     **name promises coverage it does not have**;
   - `id` is over-redacted — the lease id is deterministic **behavioural** data, so releasing id 2
     instead of the claimed id 1 currently compares equal;
   - the default claim returns **no token**, so every release records `"token":null` and dropping
     the token from the release path would be invisible.
2. **#68** is at zero unresolved; confirm CI and re-check both endpoints.
3. **Ask Mobeen for a merge grant for each.** Grants are per-PR and never carry over. Verify any
   merge **by CONTENT** — `node scripts/verify-merge.mjs <pr>` — never ancestry.
4. **Then PR-2 of #50**: delete the stale-snapshot gate at `daemon.mjs:1382` and its only consumer
   at `:1532`. Re-derive those line numbers first.
5. PR-3 (combine in place), PR-4 (move to `src/build/hubsession.mjs`), PR-5 (the acceptance test).

## Decisions already taken — do not re-litigate

Full table in handoff §4. In short: the design brief is **research, not a specification**;
`verify-merge.mjs` **does not claim whole-PR coverage** and states its SCOPE on every verdict; the
plan cap's unit is **PRs, 3–4 per document**; merge grants are **per-PR**; stub-sweep manifest
entries go in **once per PR at the end**.

**The #50 acceptance test is a PROVENANCE assertion, not an unreachability one** — an
unreachability assertion has no natural positive control, and passes for three different reasons.
Assert instead that every hub handle acquired came **through the session**, paired with a vacuity
check that any were acquired at all. If that cannot be expressed against the real tick, **that is
a result and gets reported**, not a weaker test shipped as done.

## How to work here

- **Node is `~/.nvm/versions/node/v24.17.0/bin/node`.** PATH node is v22 and four suites crash.
  **`REEVE_HOME` must point at a directory literally named `.reeve`.**
- **The four-check stub loop** on every fix: control green → **stub proven applied by a HASH
  CHANGE, not a grep** → the RIGHT assertion red → restore verified byte-identical **by file copy,
  never `git checkout`**. *A stub that produces no failures means the property is UNTESTED.*
- **Judge every run on its EXIT CODE and the `all green` tail, never on a FAIL count** —
  `grep -c '^FAIL'` returns 0 on a crashed run, and a crash can happen after every assertion has
  printed PASS.
- **Extract every fenced command block from a document and RUN it before committing.** Code in a
  fence is never executed; four false greens shipped that way, one reporting a clean merge for an
  **unmerged** PR.
- **Never implement a proposed fix without testing it against the case that prompted it.** A
  stale-but-true value reads as corroboration and is worse than none.
- **Determinism is not portability.** A check that runs twice in one process cannot see host
  dependence.
- **"Derived" is not one property.** Derive from the thing that actually consults the list.
- **CI:** `pending` first, then `dead`, then `ran` — the counters are **not** mutually exclusive.
  **Steps do not live on the check-runs endpoint**; read them from `actions/jobs/<id>`.
- **Full suite** excluding `test/escape.test.mjs`, with the `fail=0` accumulator. Measure against
  **one base**.
- **Branch from `origin/main`**, never local `main`.
- **Do not** restart the daemon, run `launchctl`, run `reeve canary`, or `git pull` in
  `~/Work/Products/reeve` — a live guardian runs from it. **Never `git stash`.**
- **Set a 15-minute watcher** on your open PRs if one is not running.
- **When you have a question**: plain-English context → options with plain-English pros and cons
  and a concrete example in this codebase → an honest recommendation → one line stating what you
  need decided.

## The peer lane — you owe it a message

A session named `nextly-integrations-*` (via `ListAgents`). **It is HOLDING Stage 3 part three —
the SPILL producer at roughly `daemon.mjs:2345` — until #50 lands**, because rebasing a few lines
onto a restructure is cheaper than the reverse.

**Tell it the moment #50 lands or is abandoned. It must not hold on silence.** And leave the
`decision.action === "SPILL"` branch structurally recognisable: #50 moves provider/hub
*mechanics*, not decision branches.

Tell it before touching `src/daemon.mjs`, `src/db/**`, `src/outbox/**`, `src/github/**`,
`src/pr.mjs`, `src/verdict.mjs`, `src/watcher.mjs`, `src/review/**` or `src/prompts.mjs`.
Stay out of `tools/**`, `test/stub-manifest.mjs` and `test/stubsweep.test.mjs`.

## The failure shape this programme keeps paying for

**Something that looks like it is working while measuring nothing.** Every finding of the last two
sessions is an instance: a name-grep standing in for reachability; `"decisions":[null]` in every
artifact; a seam log recording six getter calls and nothing else; a scenario named for coverage it
did not have; an assertion whose fixture could not exhibit the defect; a marker file inside the
tree under test.

**The general form:** *the instrument measured something adjacent to the property, and the
adjacent thing was chosen because it is easier to get at.* Ask what is actually being measured
versus what is meant, and expect the gap to be in the convenient direction.

## Open for the founder

Merge grants for **#69** and **#68**. Everything else is unblocked.

---

**End of prompt.**
