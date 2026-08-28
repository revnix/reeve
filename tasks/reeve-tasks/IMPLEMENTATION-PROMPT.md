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
    executable bit is caught) and distinguishes the states ancestry cannot: **`0`** merged by
    content · **`31`** the content did **not** arrive · **`32`** it arrived and `main` has moved
    since · **`22`** not merged yet · **`23`** it could not tell. **Until reeve#60 merges, do the
    comparison by hand** — `git rev-parse <head>:<path>` against `git rev-parse origin/main:<path>`
    for every changed path — and treat any path you could not read as unverified rather than as
    matching.
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
2. Read the stage tracker (`tasks/reeve-tasks/trackers/s3.md`) and
   `tasks/reeve-tasks/trackers/MASTER.md` to see what other lanes hold.
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

**⛔ GATE: no reading of implementation files, no branch, no code, until the claim is pushed.**

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

### Phase 2: Implement — one task, in the plan's steps

1. Branch from the task's stated base:
   `git worktree add -b <branch> ~/Work/Products/reeve-wt/<name> <base>`.
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

1. Commit; push; open the PR with `gh pr create --body-file - <<'BODY' … BODY`, with
   `## What` / `## Decisions taken in this PR` / `## Review focus`.
2. **The tracker line is the LAST commit before the PR.** The tracker conflicts on every branch;
   one line added last makes the conflict trivial. STATE is **BUILT**, never MERGED — this
   commit precedes the PR and merging needs a grant.
3. `gh pr comment --body "@codex review"`. **Comment it on every push, not only the first.**
4. **Read BOTH verdict endpoints.** A clean pass arrives as an **issue** comment (*"Didn't find
   any major issues"* + *"Reviewed commit: <sha>"*); findings arrive as **review** objects.
   *"Something went wrong"* and *"You have reached your usage limits"* are **refusals, not
   passes** — and the reviewer refused **57% of requests** in one measured week.
5. **Check the verdict's `commit_id` against the current head.** A verdict at an older head is
   **stale** and says nothing about what you just pushed. Corollary: **commit the tracker and
   any docs BEFORE requesting review**, or your own push makes the verdict you asked for stale.
6. For each finding: **verify the claim against the source before acting.** Bots are wrong often
   enough that taking one at face value has produced real defects here. Then fix it properly,
   assert every text patch's anchor actually matched (**a bad anchor means nothing was
   written**), reply with what changed and why, and **resolve the thread via GraphQL — replying
   alone does not clear it.**
7. **Fix the invariant, not the site.** If the same finding shape appears a third time, the
   design is wrong: remove the fallible read rather than patching its third instance.
8. **The taper rule:** ten rounds without the findings tapering means **stop and bring the
   shape**, not the next fix. Split the PR; do not push an eleventh round.

**⛔ GATE: `**Do not merge.** Founder grant required.`**

### Phase 4: Merge — only on an explicit grant for this PR

When, and only when, the founder grants this specific PR:

1. **Re-verify at the moment of merge**, not from an earlier read: CI green with **real steps**
   (see *Reading CI* below), and zero unresolved threads on **both** endpoints.
2. Merge, with **no AI attribution in the squash message**.
3. **Verify by CONTENT:** compare the merged tree hash or the individual file blobs against the
   branch head. **Never** by ancestry — the branch commit is not an ancestor.

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
