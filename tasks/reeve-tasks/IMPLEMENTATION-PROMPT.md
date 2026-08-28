# reeve — Task Implementation Prompt

**Use this for every task in this repository.** Paste it, name the task, and follow it in order.

**Task:** `<tracker file>` → `<task id>`, e.g. `tasks/reeve-tasks/trackers/s3.md` → **T1**.

---

## About reeve

reeve is a **guardian and a builder** for the founder's repositories. The guardian watches PRs,
diagnoses red CI, dispatches a worker to fix it, and judges the result against a nine-clause
worst-wins verdict. The builder takes a filed task through sizing, research, design, spec,
implementation and publication, behind capability switches that turn on one stage at a time.

**One thing above all: a live guardian daemon runs on this machine, from
`~/Work/Products/reeve`.** It watches real PRs on real repositories. Nothing you do may
interrupt it, and several ordinary commands would.

**reeve is a PUBLIC repository** as of 2026-08-27 — a deliberate founder decision taken with the
exposure audited beforehand. Three things follow, and they are not one rule:

- **Naming reeve inside `revnix/reeve` is fine.** It is reeve's own home and names itself throughout.
- **Rule 15 (design §1.7) is unchanged and still binds**: no effect reeve produces against **any
  other repository** may name it — not a branch, a commit message, a PR title or body, a check
  name, a label, or a comment marker.
- **The spec repositories must be PRIVATE.** Design `:77` refuses to run against a spec repo whose
  visibility is anything but exactly `private`, re-queried per effect with no cache. reeve's own
  repository going public relaxes that by nothing.

**Assume everything you commit here is world-readable**, because it is.

---

## Source of truth, in order of authority

| # | File | What it decides |
|---|---|---|
| 1 | `docs/2026-08-21-builder-design.md` | The spec. §14 is the rollout, and each stage's *Verify:* clause is that stage's definition of done. It outranks everything below. |
| 2 | `tasks/reeve-tasks/MASTER-PLAN.md` | The roadmap S3→S12 and the authoring spec. Part B is how a plan, tracker or measured document is written here. |
| 3 | `tasks/reeve-tasks/plans/…` | The stage plan. Task-by-task, with the failing test written before the implementation. |
| 4 | `tasks/reeve-tasks/trackers/…` | **Live state.** What is claimed, what is open, what review found, what the founder decided. |
| 5 | `docs/measured/` | 21+ measurements. **If something here contradicts your intuition, it wins** — it was measured, with a control, and the reason it exists is that the intuition was wrong. |
| 6 | `docs/TRACKER.md` | **Historical record only. Do not edit it.** 10 of its 20 unchecked boxes sit on merged work; the format was the defect, not the content. |

**The design and the code disagree in seven measured places.** They are listed in
`MASTER-PLAN.md` §B.11 with the stage that closes each. **A plan that quotes the design without
checking that table sends you after files that do not exist** — `worktree.mjs` and
`acquireWorktree` are the worked example: the design says *"reused untouched"* and neither has
existed since `src/checkout.mjs` replaced them.

---

## Hard rules

### MUST

1. **Claim the task before doing anything else.** See Phase 0. Nothing is worked unclaimed.
2. **Read the plan's task in full, then the files it names**, before writing a line. The plan
   was written by someone with more context than the task fragment carries.
3. **Node is always `~/.nvm/versions/node/v24.17.0/bin/node`.** Alias it: `N=~/.nvm/versions/node/v24.17.0/bin/node`.
   The `node` on `PATH` is v22 and `node:sqlite` emits an ExperimentalWarning there; CI asserts
   a floor of 24.
4. **Run the four-check stub loop on every fix.** Control green → **stub verified applied** →
   the **RIGHT** assertion red → **restore verified byte-identical by file copy**. Four checks,
   not three. ***A stub that produces no failures means the property is UNTESTED*** — not that
   the code is right.
5. **Restore by file copy, never `git checkout`.** `git checkout` restores to the last *commit*
   and silently discards uncommitted work. That has cost real lines in this repository.
6. **Run the full suite before every commit**, excluding `test/escape.test.mjs`, with the
   accumulator that makes a red suite non-zero:

   ```bash
   fail=0
   for f in test/*.test.mjs; do
     case "$f" in */escape.test.mjs) continue;; esac   # writes into the LIVE daemon's ~/.reeve/canary
     $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }
   done
   # NONZERO on red. `|| echo` turns a failing node process into a SUCCESSFUL command, so this
   # loop exits 0 with any number of red files -- and it is the mandatory pre-commit gate, so an
   # executor checking the command status commits on a suite that just failed. The flag is set
   # inside the loop because a pipeline's status is its last command's, and the last one is `done`.
   [ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }
   ```

7. **Measure every pass against ONE base**, never a chained comparison against the previous
   task. The base is in the stage tracker's §7 and is currently **93 files, 0 failures, 5,131
   PASS** on `16cd880`. Re-measure it if `main` has moved.
8. **`REEVE_HOME` must point at a directory literally named `.reeve`**, or `init.test.mjs`
   fails spuriously and you will spend an hour on a defect that is not there.
9. **Every absence claim needs a positive control**, and any claim about a **set** prints a
   **COUNT first**. **Never `| head` or `| tail` a search you will reason about as a set.**
10. **Never state an enumeration as complete.** Say what you searched and how, so the boundary
    travels with the claim: *"grep for `\.run(|\.exec(|await` across 996-1459 found three"*
    invites the correction that *"the only side effects are three"* forecloses.
11. **Verify a merge by CONTENT, never ancestry.** This repo squash-merges, so a branch commit
    is **never** an ancestor of `main`. Compare tree hashes or file blobs, or run
    **`node scripts/verify-merge.mjs <pr>`** — **which lands in its own PR, `reeve#60`, because it
    is code and this one is documents.** It compares TREE ENTRIES (mode included, so a lost
    executable bit is caught) against the **squash commit**, and distinguishes the states ancestry
    cannot: **`0`** merged and still intact on `main` · **`32`** it merged and `main` has changed
    since · **`22`** not merged yet · **`23`** it could not tell · **`20`** usage.

    **Compare against the SQUASH COMMIT, never the branch head** — by hand or in code. If `main`
    touches a file after the branch diverges, the squash folds both edits in, so the merge's tree
    differs from the head's *even though the change landed perfectly*. Measured on a real git
    fixture, the head-based comparison reported content that was demonstrably present as missing:
    a false negative in the **common** case. The squash already incorporates whatever `main` did
    beforehand, so it cannot be confounded by a moving base.

    **Until reeve#60 merges, do it by hand — with `ls-tree`, not `rev-parse`.** `git rev-parse
    <rev>:<path>` returns the blob, and **mode lives in the tree**, so a lost executable bit
    shares its blob id with the version that never had one:

    ```bash
    #!/bin/bash
    squash=$(gh pr view <pr> --json mergeCommit --jq .mergeCommit.oid) || exit 23
    # A FETCH THAT FAILED MUST NOT BECOME A VERDICT. Unchained, the next line
    # resolves a CACHED origin/main, and the loop then prints no DRIFTED paths --
    # a network or auth failure reading exactly like a clean verification.
    git fetch origin refs/heads/main:refs/remotes/origin/main --quiet \
      || { echo "UNREADABLE: could not refresh origin; refusing to classify against stale refs"; exit 23; }
    # PIN it. origin/main is MUTABLE: left as a name, every ls-tree below
    # re-resolves it, and a concurrent fetch can serve some paths from the old
    # main and some from the new.
    main=$(git rev-parse "origin/main^{commit}") || exit 23
    drift=0
    # -z and `read -d ''`, NOT `for p in $(...)`. A filename may contain a space,
    # a tab or a newline, and word splitting would iterate FRAGMENTS -- absent
    # from both revisions, so both ls-tree reads come back empty and EQUAL, and a
    # path that really had drifted reports clean. Filenames are attacker-supplied.
    # Process substitution, not a pipe, so `drift` survives the loop.
    while IFS= read -r -d '' p; do
      a=$(git --literal-pathspecs ls-tree "$squash" -- "$p")
      b=$(git --literal-pathspecs ls-tree "$main"   -- "$p")
      [ "$a" = "$b" ] || { echo "DRIFTED: $p"; drift=1; }
    done < <(git --literal-pathspecs diff-tree --no-commit-id --no-renames --name-only -r -z "$squash")
    [ "$drift" -eq 0 ] && echo "MERGED, AND INTACT ON MAIN" || exit 32
    ```

    **`--literal-pathspecs`**, because a filename is attacker-supplied and git reads a path
    beginning `:` as pathspec magic. **The paths come from the squash's own diff**, not from the
    API's file list: that list describes the branch head, which a push after the merge moves.
    Treat any path you could not read as **unverified**, never as matching.
12. **Conventional Commits**, lowercase, `type(scope): subject`, ≤72 characters.
13. **Every change carries a what/why comment in the style of the file it lands in.** Comments
    never reference tasks, plans, findings, or any planning document.
14. **Ask when requirements are unclear**, in the structure in rule 15. Quote the specific part.
15. **Every question or proposed option follows this structure — no shortcuts, even for a small
    question:**
    - **Plain-English context** — one or two sentences on what is being asked and why it
      matters, written for a human, not in jargon.
    - **Options** — a short label each, a plain-English description of what it actually does,
      plain-English pros and cons (say *why*, and *for whom*), and **a concrete example of how
      it plays out in this codebase**.
    - **Honest recommendation** — pick one and say why. **Push back if the founder's preference
      looks wrong**; do not rubber-stamp. Base it on the source, the measured documents and
      current library docs, not on vibes.
    - **What I need from you** — one clear line stating exactly what decision is needed.
16. **Research prior art before any behaviour-changing task** — how comparable systems solve the
    same problem — and use **Context7** for current library documentation before writing code
    against a library. Training data lags.
17. **Update the tracker after each task, not in a batch**, and **release the claim** when the
    task is merged.

### MUST NOT

1. **Do NOT merge without the founder's explicit, per-PR grant.** Grants never carry over. A
   grant for PR #40 is not a grant for #44. Re-verify CI and open threads **at the moment of
   merge**, not from an earlier read.
2. **Do NOT restart the reeve daemon, run `launchctl`, run `reeve canary`, or `git pull` in
   `~/Work/Products/reeve`.** A live guardian runs from that checkout, and a `git pull` swaps
   code under a running process. **`git fetch` is fine.** Work in a worktree:
   `git worktree add -b <branch> ~/Work/Products/reeve-wt/<name> origin/main`.
   `reeve doctor` is read-only and is fine.
3. **Do NOT `git stash`.** The stash stack is shared across ~19 worktrees; a `pop` takes a
   stranger's work in progress.
4. **Do NOT `--no-verify`**, `HUSKY=0`, or any other hook bypass. Fix the underlying problem.
5. **Do NOT attribute any AI assistant** in commit messages, commit bodies, PR descriptions, or
   **squash-merge messages** — no trailers, no generated-with footers, no mentions in prose.
6. **Do NOT touch another lane's territory.** Tell the guardian/peer lane before touching
   `src/daemon.mjs`, `src/db/**`, `src/outbox/**`, `src/github/**`, `src/pr.mjs`,
   `src/verdict.mjs`, `src/watcher.mjs`, `src/review/**`, `src/prompts.mjs` — and **always**
   before changing the SHAPE of `computeVerdict`'s clause set or the ORDER of `nextAction`'s
   branches. Find it with `ListAgents`.
7. **Do NOT add raw SQL outside `src/db/` and `src/build/`.** The rule is stated at
   `src/provider.mjs:9-13` and is already violated by 12 paths with 98 `.prepare()` calls, with
   a guard that checks exactly one file. **Do not add a thirteenth.**
8. **Do NOT work more than one task at a time.**
9. **Do NOT introduce a new lint error, type error, test failure or warning.** "It was broken
   before" is not a licence to make it worse — flag pre-existing failures in the PR body.
10. **Do NOT re-litigate a decision recorded in a tracker's §4.** If you think one is wrong,
    say so as a question under rule 15; do not quietly build the other thing.
11. **Do NOT run `test/escape.test.mjs` in the routine loop.** It writes decoy files into the
    shared `~/.reeve/canary/` tree the live daemon reads, and probes the login keychain. Run it
    deliberately, on a quiet machine.
12. **Do NOT read absence as quiet.** A CI job with zero steps, an empty branch list, a silent
    review bot and a renamed session all look identical to "nothing happened". Read a
    **positive** signal or report that you could not.

---

## Execution workflow

Follow the phases in order. Each gate is completed before the next phase starts.

### Phase 0: Claim

1. Read `tasks/reeve-tasks/trackers/claims/README.md` in full. **Every path in this prompt is
   repository-relative**, because each later step runs from the repository root.
2. **Read every claim file on a freshly fetched `origin/main` — that is the only authoritative
   record of what is held.** Not `MASTER.md`, and not the stage tracker: **an initial claim writes
   neither.** Step 4 below requires a PR containing *only* the claim file, so a new claim can
   never appear in `MASTER.md`, and a lane that checks only there sees a claimed task as free,
   overwrites the claim file, and starts duplicate work — the protocol failing in exactly the
   situation it exists for.

   ```bash
   git fetch origin refs/heads/main:refs/remotes/origin/main --quiet
   for f in $(git ls-tree --name-only origin/main tasks/reeve-tasks/trackers/claims/); do
     case "$f" in */README.md) continue;; esac
     echo "== $f"; git show "origin/main:$f" | sed -n '1,12p'   # header is authoritative
   done
   ```

   The **top-level `state:`** is the answer — `HELD` · `RELEASED` · `TAKEN OVER` — and the blocks
   below it are history. **If the loop lists no files, say so as "I could not read the claims",
   not as "nothing is claimed"**: an empty listing and an unreadable one look identical here.
   Then read the stage tracker (`tasks/reeve-tasks/trackers/s3.md`) and
   `tasks/reeve-tasks/trackers/MASTER.md` for live state and context — they summarise, they do
   not decide.
3. Confirm the task's **dependencies are MERGED**, by content — not "the PR is open", not "it
   was approved".
4. **Publish the claim where the protocol says peers look, which is `main`.** Write
   `tasks/reeve-tasks/trackers/claims/<stage>-<task-id>.md` from the template **on a branch of its
   own**, open a PR containing **only that file**, and get it merged. One small file, touching
   nothing else, reviews in a minute and cannot conflict with anyone.

   **Why not just push it to your feature branch:** a commit on a feature branch is not on `main`,
   and `claims/README.md` tells other lanes to look on `main`. Two lanes could each push a claim
   to their own branch, each see nothing on `main`, and both start the same task — the protocol
   failing in the one situation it exists for. **A claim nobody can see is not a claim, and
   "pushed" is not "visible".**

**READ THE PLAN'S TASKS FIRST — the claim cannot be written without them.** `claims/README.md`
requires a claim to enumerate every file it covers, and that list is the plan's `**Files:**`
block. Reading the plan to derive it is not working the task, and the gate below has never
forbidden it; without this the protocol is circular, and the only ways out are publishing a claim
with an incomplete territory boundary or working out of order. Read the plan tasks in the PR
package you are claiming, take their `**Files:**` union, and write that into the claim.

**⛔ GATE: no EDITS to implementation files, no branch, no code, until the claim is pushed.**
Reading is always permitted — reading is how the claim is written.

### Phase 1: Understand

1. Read the plan's task in full: its `**Files:**`, its `**Interfaces:**`, its
   `**On the broken implementation**` block, and the stub it names.
2. **Verify the plan's line references before trusting them.** Each names an anchor string and
   a line number, with the commit the number was true at. **`main` moves.** Search the string;
   if it is gone, stop and reconcile rather than adapting.
3. Read the consumed interfaces **in the source**, not in the plan's summary of them. If any
   signature has changed, **stop and reconcile** — that instruction is in the plan's own opener
   for a reason.
4. Read the measured documents the task names.
5. Research prior art and fetch current library docs (rule 16).
6. Ask any question under rule 15.

**⛔ GATE: do not proceed while a BLOCKING question is unanswered, or while a consumed interface
has changed under the plan.**

**A question with a recorded default is not blocking.** The stage tracker's §2 marks some
questions *defaulted*: the decision was taken without the founder, is recorded with its reasoning,
and is reversible cheaply. They exist precisely so work is not stopped — proceed under the default
and name in the PR body which one you relied on. **A question with an empty Answer and no default
IS blocking**; F5 (the spec repositories do not exist yet) is the current example, and no amount
of reasoning substitutes for it.

### Phase 2: Implement — EVERY task in the claimed PR package, in the plan's steps

**A claimed row is a PR, and a PR holds several plan tasks.** S3's 78 plan tasks are grouped into
16 PRs (`MASTER-PLAN.md` §B.1), so steps 2–6 below are **one task's cycle, and you repeat them
for every task in the package** before Phase 3 opens the PR. **Each task is its own commit.**

Run this loop until no task in the package is left:

- [ ] every plan task in the claimed PR has had steps 2–6 run against it
- [ ] each one is a separate commit, so a reviewer can read them apart
- [ ] the gate below passed for the package as a whole, on the final state

**Closing out after the first task, or collapsing several tasks into one commit, both produce a
PR that reports BUILT over work that is not built.** The tracker's `BUILT` unblocks ordered
downstream tasks, so a package marked built early is a dependency that is not there.

1. Branch from **`origin/main`**, never from local `main`:
   `git fetch origin --quiet && git worktree add -b <branch> ~/Work/Products/reeve-wt/<name> origin/main`.
   **Local `main` may be behind, and this workflow forbids `git pull` in the live checkout** — so
   an executor can verify a dependency merged on the remote and then branch from a `main` that
   does not contain it, silently omitting the very thing they just checked for. If you want to be
   certain, branch from the dependency's **verified squash SHA** instead: it is in the tracker's
   `Merge` column and cannot be stale by construction.

   **A single squash SHA is only sufficient when the task has ONE dependency.** A *join* task has
   more than one, and any one of their SHAs omits the others. **T16 is the worked example**: it
   depends on **T12 and T15**, which merge independently. Branch from T15's squash and T12 is
   missing; branch from T12's and T15 is — the failure is symmetric, and whichever merged second
   is the one you silently lose. For a join, **the base must contain every dependency**: take
   `origin/main` after verifying all of them merged, and check the base you chose actually holds
   each one:

   ```bash
   for dep in <dep-squash-sha>...; do
     git merge-base --is-ancestor "$dep" "$base" || echo "BASE OMITS $dep"
   done
   ```

   **Ancestry is the right test here and it does not contradict rule 11.** Rule 11 forbids
   ancestry for asking *did this PR merge*, because a squash makes the **branch head** a
   permanent non-ancestor. This asks a different question — *does this base include that merge
   commit* — and the squash commit is on `main` by construction, so ancestry answers it exactly.
   Two questions that look alike are not one question.
   A fresh worktree **cannot commit until `node_modules` exists** — husky needs it. Budget the
   install.
2. **Write the failing test first.** **The plan does not contain the test body** — it names the
   behavioural claim, the interfaces, the assertion that must go red, and the ones that must stay
   green as controls. **You write the test, in the editor, from those.** That is deliberate: code
   inside a Markdown fence is never executed, so a test written there is never seen to run, and
   ten of the defects found in the first two plan documents were exactly that. If a plan hands you
   a test body verbatim it predates this rule — use it, but run it before you trust it.
3. **Run it and watch it fail**, and check that the failure is the one the plan predicts. A test
   that fails for a different reason is not the test you meant to write.
4. **Run the four-check stub loop** the task names (rule 4). This is the step that catches a
   test which cannot fail — and a plan can survive sixteen adversarial review rounds and still
   contain one. It was found by *executing* Task 1, not by reviewing it.
5. Implement the minimum that makes it pass.
6. Run the file green, then the full suite (rule 6).

**⛔ GATE before committing:**

- [ ] the new assertion has been **seen red** against the broken implementation, and the stub was
      **verified applied** before that red was believed
- [ ] the restore was verified **byte-identical, by file copy**
- [ ] the full suite is green against the **one base** (rule 7), with the accumulator
- [ ] no new lint, type or test failure; pre-existing ones flagged
- [ ] husky passed without any bypass
- [ ] every change carries a what/why comment, referencing nothing outside the code
- [ ] the change does only what the task requires

### Phase 3: Open the PR, and work the gate

**The order of the first three steps is the rule, and it matches `MASTER-PLAN.md` §B.6's
canonical sequence.** The tracker commit comes **before** `gh pr create`, so the PR carries its
`BUILT` state from the outset. Opening first and amending the tracker after leaves the opened PR
briefly claiming nothing, and the later push makes any verdict you already asked for stale.

1. **Commit the work.**
2. **Then the tracker line, as the LAST commit before the PR.** The tracker conflicts on every
   branch; one line added last makes the conflict trivial. STATE is **BUILT**, never MERGED —
   this commit precedes the PR and merging needs a grant.
3. **Push, then open the PR** with `gh pr create --body-file - <<'BODY' … BODY`, with
   `## What` / `## Decisions taken in this PR` / `## Review focus`.
4. `gh pr comment --body "@codex review"`. **Comment it on every push, not only the first.**
5. **Read BOTH verdict endpoints.** A clean pass arrives as an **issue** comment (*"Didn't find
   any major issues"* + *"Reviewed commit: <sha>"*); findings arrive as **review** objects.
   *"Something went wrong"* and *"You have reached your usage limits"* are **refusals, not
   passes** — and the reviewer refused **57% of requests** in one measured week.
6. **Check the verdict's `commit_id` against the current head.** A verdict at an older head is
   **stale** and says nothing about what you just pushed. Corollary: **commit the tracker and
   any docs BEFORE requesting review**, or your own push makes the verdict you asked for stale.
7. For each finding: **verify the claim against the source before acting.** Bots are wrong often
   enough that taking one at face value has produced real defects here. Then fix it properly,
   assert every text patch's anchor actually matched (**a bad anchor means nothing was
   written**), reply with what changed and why, and **resolve the thread via GraphQL — replying
   alone does not clear it.**
8. **Fix the invariant, not the site.** If the same finding shape appears a third time, the
   design is wrong: remove the fallible read rather than patching its third instance.
9. **The taper rule:** ten rounds without the findings tapering means **stop and bring the
   shape**, not the next fix. Split the PR; do not push an eleventh round.

**⛔ GATE: `**Do not merge.** Founder grant required.`**

### Phase 4: Merge — only on an explicit grant for this PR

When, and only when, the founder grants this specific PR:

1. **Re-verify at the moment of merge**, not from an earlier read: CI green with **real steps**
   (see *Reading CI* below), and zero unresolved threads on **both** endpoints.
2. Merge, with **no AI attribution in the squash message**.
3. **Verify by CONTENT, by the procedure in rule 11 — do not restate it here.** Run
   `node scripts/verify-merge.mjs <pr>`, or rule 11's fallback if reeve#60 has not landed.

   **This step used to carry its own copy of the comparison, and the copy went stale**: it said
   *"compare … against the branch head"*, which rule 11 had already been corrected to forbid, and
   *"the merged tree hash"*, which compares the WHOLE tree and so reports every unrelated commit
   on `main` as a failure. Both would have failed a valid merge. **One procedure, in one place,
   referenced from everywhere else** — the drift between two copies of a rule is the single
   most common defect this document has produced, and a reference cannot drift from itself.

### Phase 5: Close out

1. Update the stage tracker: STATE → **MERGED**, the **squash SHA on `main`** (the only SHA a
   tracker row carries — per-round fix SHAs do not survive a squash merge), rounds, findings.
   *(Do not publish yet — steps 2 to 4 edit the same file. See step 5.)*
2. Add any new **finding class** to the tracker's defect log — one row per class, ≤400
   characters, not one row per finding.
3. Add any **durable finding** — a lesson about plans or designs being wrong — to §5.
4. Add any decision taken during the task to §4, with its date and reason.
5. **Publish the tracker, once, with every close-out edit in it.** Steps 1 to 4 all write the
   same file, so open **one tracker-only PR** carrying the STATE change, the defect-log rows, the
   durable findings and the decisions together — one file, nothing else, reviews in a minute.
   **Publishing after step 1 would leave steps 2 to 4 in your checkout only**, and the workflow
   says to follow the phases in order, so they would never be published at all. Until this merges,
   every other lane reads `BUILT` on work that is done — precisely the 10-of-20 defect the
   per-stage tracker exists to remove, reintroduced one step later in the workflow.
6. **Release the claim**: `state: RELEASED`, with the reason and the date, **published as a
   claim-only PR** like every other claim transition. Do not delete the file. A release that lives
   only on a merged feature branch leaves the task HELD to everyone reading `main`, and the next
   task never starts.
7. Report: what merged, what it changed, what review found, what is still open.

---

## Reading CI, correctly

Zero job steps has **four** readings, not two, and collapsing any two of them is how a
conclusion gets read as a verdict about code that never executed:

```
dead    = jobs with status=completed AND conclusion NOT IN (skipped,cancelled) AND steps == 0
ran     = jobs with steps > 0
pending = jobs with status != completed

dead > 0     -> OUTAGE: nothing ran; the conclusion says nothing about the code
ran  > 0     -> REAL RESULT: read the diff
pending > 0  -> says nothing YET
otherwise    -> all skipped: says nothing
```

`jobs_with_steps == 0` is **one step short** and took three revisions to get right; its second
version declared an outage in a repository a peer had just measured healthy. **The disagreement
was the instrument.**

**And when a shared service fails, measure its SCOPE before hypothesising its cause.** A sibling
repository with an unrelated workflow separates repo-scoped from org-scoped for free and needs
no privilege at all. Report the scope as measured and the cause as unknown — those are different
claims, and only one of them needs `admin:org`.

---

## When things go wrong

**A test fails and you did not touch that area.** Check it against the **one base** first. This
repository has a known baseline; a failure present at the base is not yours. Flag it; do not
absorb it.

**An instrument disagrees with another instrument.** The disagreement **is** the finding. Do not
pick the friendlier reading. Five instruments failed silently in one session here and **every
one was caught by a control or a contradiction, never by the output looking wrong** — `timeout`
does not exist on macOS and reported *"91 of 91 files FAILED"* with `rc=0` on the same line;
`\s` and `\b` are unsupported in `awk` ERE and returned count=0 vacuously.

**`grep` behaves oddly.** `grep` is shadowed by `ugrep` on this machine and skips data files;
use `git grep`. But `git grep` is blind to ignored files, so use plain `grep -r` when the
question includes them. And `grep -F "A\|B"` **cannot match** — `-F` is literal; use `-e A -e B`.

**A fix creates the opposite failure.** The second fix is another assumption. Remove the
dependency instead of patching the direction.

**A guard is green and you are not sure it can go red.** Then it is not a guard. **Build the
tree that should fail it** and confirm it does. A negative regex over source text disables
itself silently on any rename or reformat — pair each one with a literal counter-control.

**You inherited a note, a constant or a handoff.** Re-measure it. Repetition is not
corroboration, and an inherited *hypothesis* is more dangerous than an inherited *fact* because
measuring against it feels like working. **Never inherit a tuned constant** — carry contracts,
not numbers.

**A permission rule seems to do nothing.** It probably does nothing. An absolute path in a
permission rule needs **two** leading slashes; `Read(/Users/x/.ssh/**)` matches nothing,
silently.

**A dispatch fails on what looks like a permission problem.** Treat it as a **layer** question,
not a grant question. The `.git` write block that stopped three dispatches dead lives *beneath*
reeve's own settings, and a worker once spent thirteen consecutive tool calls correctly
diagnosing an impossible instruction.

**The task turns out to be larger than one PR.** Say so, with the measurement — changed **lines**,
not files. Target ≤1,200 changed lines; hard stop at 2,000. Split it and update the tracker;
do not quietly ship a 4,000-line PR. The worst-converging PR in this corpus was 4,470 lines and
took 66 findings over 15 rounds without tapering.

**You are unsure which base to branch from.** The task's row in the stage tracker names it.
If that base has not merged, the task is not ready — say so rather than branching from `main`
and hoping.
