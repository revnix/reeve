# Resume prompt — paste the block below into a fresh session

Everything between the rules is the prompt. It assumes nothing about what you remember.

---

Resume the reeve S3 programme. **Do not trust any value in this prompt — read it.** Everything
here was true on 2026-08-28 and the repository moves several times a day; it moved three times
during the session that wrote this.

## Read these first, in this order

1. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/HANDOFF-2026-08-28.md` — the full context, every
   decision, the remaining work. **Read it completely before doing anything.**
2. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/trackers/MASTER.md` — one screen: stage states
   and what needs the founder.
3. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/trackers/s3.md` — **§4 is the decisions, which
   are binding and not to be re-litigated. §7 is the re-measured source anchors. §8 is the 38
   places the design brief and the code disagree.**
4. `~/Work/Products/reeve-wt/c4/tasks/reeve-tasks/MASTER-PLAN.md` **Part B** and
   `IMPLEMENTATION-PROMPT.md` — the rules every task is executed under.

## Where you are

- **`main` was `281655a`.** Re-read it: `git -C ~/Work/Products/reeve-wt/core log --oneline -1 origin/main`.
- **Two open PRs, both yours.** **#58** `docs/s3-foundation-core` (the planning foundation, docs
  only) and **#60** `fix/merge-verifier`. Both were green with **zero unresolved threads** when
  this was written — **verify that, do not assume it.**
- **Open issues: #50, #46, #43.** #51 has closed.
- **Worktrees:** `core` = #58, `verifier` = #60, `c4` = the six S3 stage plans **which are not on
  `main` and not in any PR**, `ghseam` = merged #57, disposable.
- **`revnix/reeve` is PUBLIC.** A deliberate founder decision, closed, do not reopen. Rule 15 still
  binds for effects against **other** repositories, and the spec repos must be **private**.

## Do this first, every time

```
gh pr list --repo revnix/reeve --state open --json number,headRefName
```

Then for each PR of yours, read **both** verdict endpoints — findings arrive as **review objects**,
a clean pass arrives as an **issue comment** and never as a review — and check each verdict's
`commit_id` against the current head, because **a verdict at an older head is stale and says
nothing**. Then unresolved threads via GraphQL `reviewThreads(first:100)`.

**BLIND IS NOT QUIET.** A read that fails is reported as unread, never as "nothing new". This is
not hypothetical: a `gh api --jq --arg` misuse printed an error where findings would go, and it
would have read as a clean pass.

## The work, in order

1. **#58 and #60 need a merge grant each** — ask Mobeen. Grants never carry over, and CI and
   threads are re-verified **at the moment of merge**. Verify a merge **by CONTENT, never
   ancestry**: this repo squash-merges, so a branch commit is never an ancestor of `main`.
2. **Any new review findings** on either PR. Verify each claim against the source before acting,
   fix the **invariant** rather than the site, run the four-check stub loop, re-run the suite,
   reply **and** resolve each thread, then `@codex review`.
3. **F5 — create three private spec repos**: `revnix/reeve-specs`, `nextlyhq/nextly-specs`,
   `revnix/rext-specs`. This is the founder's to do and it **blocks S3 T2**.
4. **P2 — issue #50**, the provider/hub session. Design is
   `c4:tasks/reeve-tasks/ISSUE-50-SESSION-DESIGN.md`. **`src/daemon.mjs` is peer territory — tell
   the peer lane before touching it.**
5. **Then S3-A's plan lands, T1–T2 execute, then S3-B** — one document at a time (decision 17),
   because a plan is revised by what executing its predecessor taught.

## Decisions already taken — do not re-litigate

Full table in handoff §3 and `trackers/s3.md` §4. In short: six plan documents; **plans carry
properties, not inline test code**; the plan cap's unit is **PRs per document, 3–4** (it was
corrected twice — "lines" then "tasks", the latter arithmetically impossible against 78 tasks in
6 documents); `admitTask`'s INSERT widens for `depth`/`priority`; `NEVER_TOOLS` becomes a
per-action subtraction for the three BUILD actions only; `specRepoId` resolves from GitHub by nwo,
never from the hub cache; **a stub is proven applied by a hash change, not a grep**; the foundation
lands before any stage plan; `--execute` stays off until after T8.

## How to work here

- **Node is `~/.nvm/versions/node/v24.17.0/bin/node`.** The PATH node is v22 and four suites crash
  on it. **`REEVE_HOME` must point at a directory literally named `.reeve`.**
- **The four-check stub loop** on every fix: control green → **stub proven applied by a sha change,
  not a grep** (three greps were measured inert) → the RIGHT assertion red while controls stay
  green → restore verified byte-identical **by file copy, never `git checkout`**. *A stub that
  produces no failures means the property is UNTESTED.*
- **Run the full suite** excluding `test/escape.test.mjs`, with the `fail=0` accumulator — `|| echo`
  is a false green. Measure against **one base**, never a chained comparison.
- **Every absence claim needs a positive control THAT ACTUALLY MATCHES.** An inert control was
  reached for twice in one session, once while verifying someone else's finding.
- **A plain grep cannot see structure.** It reported live open-gate phrasing that was struck
  through, and quoted-historical filenames as live ones. When the claim is about markup or
  columns, parse rather than match.
- **Branch from `origin/main`**, never local `main` — pulling in the live checkout is forbidden, so
  local `main` can lack the dependency you just verified.
- **A push to a branch whose PR already merged goes nowhere and succeeds.** Check the PR is still
  `OPEN` before believing a push mattered.
- **Commit docs and tracker changes BEFORE requesting review**, or your own push makes the verdict
  you asked for stale.
- **CI's four states** — `dead` / `ran` / `pending` / `all-skipped`. Never `jobs_with_steps == 0`.
- **Never `--no-verify`. No AI attribution anywhere**, including squash-merge messages.
- **Do not** restart the reeve daemon, run `launchctl`, run `reeve canary`, or `git pull` in
  `~/Work/Products/reeve` — a live guardian runs from it. `git fetch` is fine. **Never `git stash`**
  — the stack is shared across ~19 worktrees.
- **Tell the peer lane** (`nextly-integrations-*`, via `ListAgents`) before touching
  `src/daemon.mjs`, `src/db/**`, `src/outbox/**`, `src/github/**`, `src/pr.mjs`, `src/verdict.mjs`,
  `src/watcher.mjs`, `src/review/**` or `src/prompts.mjs`. It has paid for itself twice.
- **Set a 15-minute watcher** on your open PRs if one is not already running.
- **When you have a question**: plain-English context → options with plain-English pros and cons
  and a concrete example in this codebase → an honest recommendation with reasoning → one clear
  line stating what you need decided.

## The two failure shapes this programme keeps paying for

**A correction that exists and is not propagated.** Nine findings in one PR were this: a rule
amended in one file and left standing in another. §B.8 rule 3 requires the back-patch, and it was
broken four times by the document that states it. **When you correct a rule, grep for every place
it appears before you commit.**

**A reference to something that does not exist.** Five instances: a prescribed script that was
absent, a design file not in the commit citing it, a declared writer `intake.mjs`, a
`measure-provider` subcommand `doctor` advises and the CLI refuses, and two test files named in
S2's Verify rows. **Before naming a file, a symbol or a command, check it is there.**

## Open for the founder

Merge grants for **#58** and **#60**; creating the three spec repos (**F5**); and the six defaulted
answers in `trackers/s3.md` §2, which may be overridden at any time.

---

**End of prompt.**
