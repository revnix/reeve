# Session handoff -- 2026-09-01, the guardian lane

Written for a session that has none of this context. Read section 0 first and RUN it;
everything below section 0 is commentary that was true when it was written.

This covers the GUARDIAN lane: the stub sweep, the watcher, the merge gates, and the hub
identity work. The builder lane keeps its own handoff for the same day under `tasks/`.

The name matters and is not cosmetic. `test/newest-doc.mjs` decides which handoff and which
prompt the two documentation guards police, and it recognises exactly
`YYYY-MM-DD-session-handoff[-N].md` and `YYYY-MM-DD-resume-prompt[-N].md`. The first
version of these files carried a `guardian-` prefix, so the resolver skipped them, both
guards ran happily against the PREVIOUS day's pair, and every green they reported was about
a document nobody had touched. If a same-day revision is needed, use the numeric suffix.

## 0. STATE -- MEASURE first, then read what only a person can tell you

Nothing in this document is a substitute for the commands below, INCLUDING the sentences
in this document. Every number here was true when it was written and several were wrong
within the hour. The block below is the authority; prose defers to it.

### 0.1 Facts to MEASURE -- never trust a file for these, this one included

```bash
# PIPEFAIL FIRST, or the guards below are decorative. `grep X file | tail -1 || handler`
# takes the pipeline's status from `tail`, which exits 0 on empty input -- so a missing
# log, an unreadable one, or one with no such record runs NO handler and prints a blank
# line that reads as a measurement. Measured 2026-09-01: without this line the handler
# does not run; with it, it does. The `||` was added first and was inert.
set -o pipefail
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
cd ~/Work/Products/reeve || exit 1

# CHAINED, because a failed fetch is silent and every read below then answers from the
# CACHED remote-tracking ref. The line labelled "what `main` is" would report stale
# state at exactly the moment this block exists to re-measure it.
git fetch -q origin || { echo "FETCH FAILED — everything below would be stale; stop here"; exit 1; }

# EVERY read below aborts when it fails. Stated once, here, because this block has
# produced the same defect repeatedly: a read that fails and reaches the reader as an
# EMPTY answer. That is worse than a wrong answer, because empty reads as good news --
# no unopened branches, no open work, nothing to do. If you add a read, guard it.

git log --oneline -1 origin/main                     # what `main` is
git log --oneline -1 HEAD                            # the CHECKOUT; NOT what runs

# What the DAEMON runs, a different fact: a running process holds the modules it
# loaded at startup, so fast-forwarding the checkout moves the tree, not the process.
# A PIPELINE HIDES ITS FIRST COMMAND. `tail` exits zero on empty input, so a missing
# log, an unreadable one, or one with no such record prints nothing and reads as a
# measurement. The rule above is not self-enforcing; a pipeline has to be told.
grep "daemon starting" ~/.reeve/reeve.log | tail -1 \
  || { echo "DAEMON RECORD UNREADABLE — this is not 'the daemon never started'"; exit 1; }

# --limit, because `gh pr list` fetches 30 by default and a silent truncation
# presents a partial list as the whole work queue.
gh pr list --repo revnix/reeve --state open --limit 100 --json number,headRefName,author \
   -q '.[] | "#\(.number) \(.author.login) \(.headRefName)"' \
  || { echo "OPEN-PR READ FAILED — an empty work queue would read as nothing to review"; exit 1; }
gh issue list --repo revnix/reeve --state open --limit 100 --json number,title -q '.[] | "#\(.number) \(.title)"' \
  || { echo "OPEN-ISSUE READ FAILED — same shape: empty is not the same as none"; exit 1; }

# BRANCHES PUSHED BUT NOT YET OPENED. A listing of heads is NOT that: it includes
# `main` and every branch that ever had a pull request, so a session reads it as hidden
# work and rebuilds something already reviewed. Subtract `main` and the heads of ALL
# pull request states -- an OPEN-only subtraction leaves merged and closed ones behind.
#
# CAPTURE BOTH LISTINGS AND ABORT ON EITHER. Inside a process substitution a failed
# read is invisible: without pipefail a failed PR listing leaves only `main` and every
# branch reports as unopened, while a failed remote listing gives comm an empty second
# input, so it succeeds and prints nothing -- an outage arriving as the answer you
# wanted. The two failures are opposite in shape and identical in danger.
#
# COMPARE COMMITS, NOT NAMES. A branch name reused after its earlier pull request
# closed or merged is not reviewed work; subtracting the bare name would treat the name
# as reviewed for ever and hide every later commit pushed under it. Pairing the object
# id with the name also handles a fork's pull request borrowing an origin branch's
# name. It can report a branch whose pull request GitHub has not yet caught up with --
# a false positive, which costs a glance, where the miss costs the work.
#
# On 2026-08-31 the pair form reported 13 branches where the name form reported 6. The
# extra seven were not noise: each tip was ahead of or diverged from the head its own
# merged pull request recorded, and none of those commits were in `main`. That is the
# merged-at-a-stale-commit hazard showing up from the other side, so the pair form
# measures something the name form cannot see. Re-measure; do not inherit the counts.
#
# Backticks in THIS block declare a subject the rest of the documents must defer to,
# so keep them for terms §0 genuinely owns. Quoting a tool name here in passing makes
# every durable sentence elsewhere that mentions the tool look like a state claim.
# PAGINATED, not capped. `--limit` is a maximum number of items to FETCH, so once the
# repository passes that number the oldest records drop out silently and every origin
# branch whose pull request fell outside the window reads as unopened work. A cap on an
# inventory used to decide what has NOT been reviewed fails in the direction that
# invents work. `gh api --paginate` walks every page; its `-q` runs per page, which is
# what this per-item filter wants.
prs=$(gh api --paginate "repos/revnix/reeve/pulls?state=all&per_page=100" \
        -q '.[] | select(.head.repo.full_name == .base.repo.full_name) | "\(.head.sha) \(.head.ref)"') \
  || { echo "PR LISTING FAILED — cannot tell unopened from reviewed; stop"; exit 1; }
heads=$(git ls-remote --heads origin) \
  || { echo "REMOTE LISTING FAILED — an empty answer would read as nothing-unopened; stop"; exit 1; }
comm -13 <(printf '%s\n' "$prs" | grep . | sort -u) \
         <(printf '%s\n' "$heads" | awk '{sub("refs/heads/","",$2); if ($2 != "main") print $1, $2}' | sort -u)

# Is reeve ARMED? Read the PROCESS, never the plist: `launchctl kickstart` replays
# launchd's cached copy, so the file and the process can disagree.
ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"

./bin/reeve doctor nextlyhq/nextly --as-app           # what is broken today
grep "shadow:" ~/.reeve/reeve.log | tail -1 \
  || { echo "SHADOW RECORD UNREADABLE — not a streak of zero"; exit 1; }

# IS CI ALIVE? A run's CONCLUSION cannot answer this: a job whose runner never
# started reports failure with ZERO steps, and that is infrastructure to restore
# rather than a diff to read. R-04 is that question, already implemented and tested:
# it refuses rows that have not concluded, reports a failed read as UNKNOWN instead
# of as an empty sample, and separates "red" from "never ran". A hand-rolled loop
# here was an unguarded second copy of it and is gone; do not reintroduce one.
./bin/reeve doctor revnix/reeve                       # R-04 answers this

# TWO MOMENTS, not one, and their preconditions EXCLUDE each other: premerge gates
# a pull request that is still OPEN, verify-merge answers only about one already
# MERGED. Measured 2026-08-31: each exits 22 when handed the other's state. So one
# variable cannot satisfy both, and running them in sequence always produced
# one real verdict and one refusal that looks like a verdict. Run the one whose
# moment you are in. Neither is pinned to a number; unset is an abort.
# SET THE ONE WHOSE MOMENT YOU ARE IN, and only that one. Requiring both aborted the
# block for every session that had exactly one -- which is every session -- so the
# commands below this line never ran at all. Running no gate is reported rather than
# passed over in silence: a gate that did not run and a gate that said yes must not
# look alike, which is the same rule the rest of this block is built on.
if [ -n "${open_pr:-}" ]; then
  node scripts/premerge.mjs "$open_pr"                # SHOULD this merge happen
fi
if [ -n "${merged_pr:-}" ]; then
  node scripts/verify-merge.mjs "$merged_pr"          # did that merge carry everything
fi
if [ -z "${open_pr:-}${merged_pr:-}" ]; then
  echo "NO MERGE GATE RAN — set open_pr=<number> of an OPEN pull request, or merged_pr=<number> of a MERGED one"
fi
# ~4ms; every anchor still resolves. IN FLIGHT when this was written, so check it
# exists first: a missing file exits MODULE_NOT_FOUND, which is not the same answer
# as "no anchors rotted".
# ABSENT IS NOT CLEAN. `[ -f x ] && node x` skips silently when the file is not there,
# and the sweep below then runs as though no anchor had failed -- the two outcomes the
# comment above says must differ, rendered identically.
if [ -f test/anchors-resolve.test.mjs ]; then node test/anchors-resolve.test.mjs
else echo "anchors-resolve is ABSENT -- this checkout cannot answer the anchor question"; exit 1; fi
# ~20 minutes, and run it in an ISOLATED detached worktree at a COMMITTED head. It
# writes stubbed source and restores a startup snapshot, so an edit made while it runs
# is silently overwritten — and this checkout is shared by three sessions.
# IN A DETACHED WORKTREE, not this checkout. The sweep edits files for twenty minutes and
# refuses a tree that changed under it; three sessions share this repository, and this
# checkout is also deliberately stale. A copy at one commit is the only thing it can
# measure. The logs go OUTSIDE the copy, or the sweep refuses its own output as dirt.
# AT THE FETCHED DEFAULT BRANCH, never at HEAD. This block runs in the daemon's checkout,
# whose HEAD is deliberately stale -- measured 2026-09-01 at twenty commits behind. A copy
# made from HEAD sweeps that stale tree and reports a verdict about a commit nobody is
# working on. Verified 2026-09-01 by making the copy both ways: `HEAD` produced a tree
# missing entries that exist on the default branch.
sweepdir=$(mktemp -d) && git worktree add -q --detach "$sweepdir" origin/main \
  || { echo "could not make an isolated copy; do not sweep the shared checkout"; exit 1; }

# COVERAGE, not just verdicts, and INSIDE the copy. The sweep prints
# `N entries over M of K test file(s)` and refuses an ORPHAN -- a test file with no
# entry and not grandfathered. The entry count is the number people quote and the
# FILE count is the one that describes the tree; six files hold most of the entries,
# so the two say very different things.
# IN THE COPY, because this reads `./src` and `./test` relative to the working
# directory. Run from the block's own cwd it imports the DELIBERATELY STALE checkout
# and reports that tree's debt under the default branch's name.
( cd "$sweepdir" && node -e 'import("./src/stubsweep.mjs").then(async S=>{
  const m=await import("./test/stub-manifest.mjs");
  const f=require("node:fs").readdirSync("test").filter(x=>x.endsWith(".test.mjs")).map(x=>"test/"+x);
  const c=S.coverage(m.STUBS,f,m.GRANDFATHERED);
  console.log(`files=${c.files.length} covered=${c.covered.length} grandfathered=${c.spared.length} orphans=${c.orphans.length}`);})' ) ; covrc=$?

# A DIFF BASE THAT IS NOT THIS COMMIT. The sweep's base defaults to `origin/main`
# in the sweep script itself, and this copy IS `origin/main` -- so the merge base is
# HEAD, the change set is empty, and the half of the sweep that enforces the
# grandfather ratchet measures nothing while reporting a pass. The script refuses that
# only under `GITHUB_ACTIONS`, so here it is silent. `origin/main~1` asks the question
# that is actually available on the default branch: did the last merge add an orphan or
# edit a grandfathered file. It is the same answer the workflow gets by passing the
# push event's previous commit.
( cd "$sweepdir" && STUB_SWEEP_BASE=origin/main~1 node scripts/stub-sweep.mjs ) ; sweeprc=$?
git worktree remove --force "$sweepdir"

# AND THE STATUS SURVIVES. `sweeprc` used to be printed and then dropped: the block's
# exit status came from whatever ran last, so a FAILED sweep left an authoritative
# block reporting success -- the pre-merge gate treated as passed on a run that said
# no. Both statuses are named, and either one non-zero fails the block.
[ "$covrc" -eq 0 ] || echo "COVERAGE READ FAILED (exit $covrc) -- do not read the absence as zero debt"
[ "$sweeprc" -eq 0 ] || echo "THE SWEEP FAILED (exit $sweeprc) -- read the verdict list, not the exit alone"
echo "sweep exit: $sweeprc; coverage exit: $covrc"
[ "$covrc" -eq 0 ] && [ "$sweeprc" -eq 0 ] || exit 1
```

### 0.2 Facts no command answers — the ones that need a person

| | |
|---|---|
| `--execute` is OFF **on purpose** | disarmed 2026-08-23 after a P0; re-arming is the founder's call, and it now waits on ONE measurement rather than on a decision — see the pool row |
| `--enforce` is OFF | needs 7 clean shadow days AND the founder; the streak reset 2026-08-29, so early September at the earliest |
| the review switch is **ON** | `watch.reviewActions` enabled 2026-08-27 |
| the durable-effect stages | **1, 2 and 4 have landed. Stage three was never merged and is ABANDONED, not deferred** — closed on the founder's decision 2026-08-30; what survived it is `enqueueWithDependants` |
| the repository is **PUBLIC** | made public 2026-08-27, exposure audited first |
| codex is a **blocking** reviewer | for reeve's OWN workflow; changed 2026-08-26 |
| the MANAGED PROJECT's reviewers | **all optional, 2026-08-31** — the roster R-05 measures on `nextlyhq/nextly`. A silent one is not a problem to solve. Does NOT touch the row above. R-08 needs nothing: a detector that has not fired is unproven rather than broken |
| the founder's merge rule | CI green AND zero open threads, and **each merge needs its own grant** — a grant does not carry. **Extended 2026-08-30: handed over with `scripts/premerge.mjs`'s verdict and the head SHA**, so a grant names a commit |
| the CI cost decision | **DECIDED 2026-08-30: widen the sweep.** It was framed as cost and was not one — the repository is public, CI is not billed, and the eighteen minutes cost review latency |
| every test file needs a stub | **DECIDED 2026-08-30.** A file named by no entry and absent from `GRANDFATHERED` fails the sweep. A grandfathered file loses its place the moment it is MODIFIED, and the list may only shrink |
| reading `.pathname` | **BANNED outright 2026-08-31** by a lint rule, not a text search. Deciding which URLs are file URLs is undecidable; review found six ways the approximation was wrong |
| whether headless and interactive Claude usage share one pool | **UNMEASURED, and it gates arming.** The CLI exposes no usage subcommand (2.1.246), so it is observational and needs the founder. Plan: `docs/measured/2026-08-31-subscription-pool-plan.md`. It satisfies **V6**, whose obligation the tracker assigns to **T16** in the builder lane |
| the R-01 merge authority | **PARTLY done**; `enforce_admins` was enabled and DISABLED again on the founder's instruction, so the admin identity is exempt by design |
| the R-03 merge shape | **undecided** |
| the second project | `rextaihq/rext-backend` — **not started** |
| the ntfy read user | **not created** |
| the test clock | `reviewer_supply.since` for `greptile-apps` carries the suite's `NOW` constant, read live 2026-08-31. Nothing reads `since`, so it is latent. Guard first, then correct |
| **THREE sessions now** | guardian (this one), builder (`src/build/**`, `src/profile/**`, S3 tasks), and a third holding S3 T13. All three have listed each other's ground back accurately |

**Change them HERE and nowhere else**; elsewhere write "see §0". Enforced by
`test/docs-state-is-single-sourced.test.mjs` and `test/zero-agrees-with-the-code.test.mjs`.

---

## 1. What this lane landed on 2026-09-01

SEVEN pull requests from this lane merged on 2026-09-01. Ten merged in total that day;
three belong to the other two lanes, and counting those as this lane's was the first
version of this sentence. Measure the current list with section 0.1 rather than trusting
this one: it is a record of what was done, not a claim about what is on the default branch
now.

| what | why it mattered |
|---|---|
| re-anchor after the task-file change | the default branch was red; two anchors resolved nowhere |
| the provider measurement store | the pool experiment had nowhere to record its answer |
| a stubbed run shorter than its control is not a reading | four entries were proving a fraction of what they claimed |
| the watcher names why there are no checks | an unmergeable branch and an outage rendered identically |
| UNKNOWN is not-decided-yet, not cannot-merge | a transient state would have read as blocked once per push |
| the premerge entry runs to the end | it had been proving 8 of 78 assertions |
| the refusal must not advise stashing | the stash is shared repository-wide, not per checkout |

Two remain open at the time of writing: the hub identity table, and the orphan gate. Their
numbers and state are section 0.1 facts.

## 2. THE SHAPE OF EVERY DEFECT FOUND TODAY

One shape, eleven times, in eleven different mechanisms. **A check that reports success
while measuring nothing.** If you read one section of this document, read this one -- not
because the instances matter, but because the next one will not look like any of them.

1. The sweep recorded WHETHER an assertion ran, never how many. A stubbed run that printed
   the named failure and then died returned CAUGHT and was structurally incapable of
   returning anything else.
2. Four manifest entries were proving a fraction of what they claimed. One was at 8 of 78.
3. A command block turned every failed read into an empty answer -- no unopened branches,
   no open work, nothing to do. Empty reads as good news.
4. The watcher's alarm skipped the one probe most likely to fail, so a watch that failed
   at startup and again at the first tick reported neither.
5. A database trigger made the writer's own check untestable: both layers refused with the
   same words, so deleting the writer's left the assertion green.
6. `coverage()` classified an undeclared test file as an orphan and called that the
   failure in its own comment. Nothing read it.
7. A reconciliation read a field the event does not carry, so its set was always empty and
   the repair never ran.
8. A fixture asserted a tick fails when a table is missing, after the code stopped reading
   that table. It would have passed for ever against an undamaged store.
9. A positive control passed for the wrong reason. Measured 2026-09-01: the same listing
   exits ZERO on an unresolvable repository when `--author @me` is given, and 1 without it,
   because the flag routes through a search reporting no matches rather than an error.
10. An identity event was gated on a read after the write rather than on the write, so
    every unchanged regenerate logged that something had changed.
11. Three of this lane's own test fixtures depended on an earlier step having been
    REFUSED, so a stub that let it through aborted the file rather than failing it.

**What caught them was never care.** It was controls: a clean-state run before each stub,
an assertion count against a baseline, a positive control on an absence search, and
`git status` after a killed process.

## 3. Who holds what

Three lanes work this repository at once and the seams were agreed in writing, not
inferred. Confirm ownership by asking rather than by reading this table; lanes move.

- **guardian (this lane)** -- `src/daemon.mjs`, `src/db/**`, `src/outbox/**`,
  `src/github/**`, `src/pr.mjs`, `src/verdict.mjs`, `src/watcher.mjs`, `src/review/**`,
  `src/prompts.mjs`, `src/premerge.mjs`, `tools/**`, `scripts/stub-sweep.mjs`,
  `src/stubsweep.mjs`, `test/stubsweep.test.mjs`.
- **builder lane** -- artifacts, phase reports, the task file and dry-run route.
- **operator lane** -- the dash, escalations, notify, and the health rows (as of
  2026-09-01).

Two seam rulings were made by measurement rather than by the territory list, because the
list was wrong about both. `src/notify.mjs` is imported only by `src/daemon.mjs`, so it is
this lane's by the seam and nobody's by the list; the operator lane writes the additive
field and this lane owns the line that PERSISTS it. `src/doctor.mjs` had zero changes from
this lane when measured on 2026-09-01, so it was handed over outright.

## 4. THE FINDING THAT MATTERS MOST FOR THE NEXT SESSION

**A gate that has never been run against the merge result has not been run.**

The sweep's own verdict named four failing entries on the pull request that widened it.
That evidence existed on the pull request. The merge happened twenty-one minutes before
the sweep concluded, on a green test job alone, and the default branch went red.

Two rules come out of that, and they are different rules:

- **A widening gate must land last, or carry the fixes for what it newly rejects.** Its
  own branch passes, because each entry passes individually; only the whole-manifest run
  fails, and that runs after the merge.
- **The sweep is roughly twenty minutes behind the test job.** A pull request touching
  `scripts/stub-sweep.mjs` or `src/stubsweep.mjs` must not be judged on the test job.

`node scripts/premerge.mjs <pr>` answers both and was not run. Run it and quote its verdict
BEFORE saying a pull request is ready, not after it merges.

## 5. The coverage debt, measured

The stub sweep's headline is an entry count. The number that describes the tree is the
FILE count, and the two diverge badly. Measured 2026-09-01 with the command in section 0.1:
six files held 78 per cent of all entries, and the single most-covered file was the sweep's
own test.

The grandfathered list is a ratchet that only moves when someone touches a file. Traced
across its whole life on 2026-09-01 it had fallen from 104 to 98 in three days while the
entry count more than doubled. Both numbers are section 0.1 facts now; re-measure them.

**This is a decision for the founder, not a task to start.** Paying the list down
deliberately is weeks of work. The alternative is opportunistic payment -- a file earns
coverage when someone touches it -- which is what has been happening. A middle option is to
pay down only the files covering authority-bearing paths, where a test that cannot fail is
worth the most to find.

## 6. What is genuinely left

**Arming.** Section 0 owns whether it is on. Three things gate it and none are code:
the V6 measurement, an authority baseline, and the worker isolation setting. The last two
are one command and one profile edit, and BOTH need the founder: capturing a baseline
freezes today's authority as the reference, and changing isolation removes a standing
dispatch refusal.

**The V6 measurement.** It needs a quiet window, three allowance readings with wall-clock
times, and agreement on caps. Its storage landed on 2026-09-01; what remains is the
measurement. One part is unresolved by design: the probe that validates the worker
credential without spending the allowance under test has no identified command, because
establishing one means running candidate calls against the live account and perturbing the
thing being measured. That has to happen with the founder present.

**The second half of the identity work.** Removing the privileged startup read from
`bin/reeve`, deleting the retry cadence with it, and tightening the structural assertion to
"no privileged opener on the guardian path at all". It was deliberately split out because
two other lanes were editing that file. Until it lands, the process-level reduction is
available rather than applied, and the pull request was retitled to say so after review
pointed out the overclaim.

**Two issues nobody holds** -- a cursor that cannot prove a hub incarnation, and task
readers sending a holed hub history to the wrong remedy. Both were filed by other lanes.

## 7. House rules that earned their place today

- **Measure, do not assume, and measure the CURRENT tree.** A verification is a statement
  about a tree and expires the moment the tree moves. One went stale in forty minutes, in
  the direction that reports success.
- **The daemon's checkout is not the repository.** It is deliberately never pulled, and on
  2026-09-01 it was twenty commits behind. Read the default branch through `git show`, or
  work in an isolated copy made from it; §0.1 measures the difference.
- **Sweep what your CODE can break, not what you wrote.** Those are different sets and
  only the first is the question.
- **A fixture step must never assume the step before it failed.** That refusal is the thing
  under test.
- **Never advise `git stash` in this repository.** The stash is shared repository-wide
  rather than per checkout, and hooks write to the same stack.
- **zsh does not word-split an unquoted variable.** It produced four separate inert checks
  in one day, each printing something plausible. Use `while read`, or quote and split
  explicitly.
- **Take the base copy whole and re-append.** Never merge the manifest hunk by hunk, and
  verify by CONTENT afterwards -- a count is satisfied by removing a different entry, and
  a reverted modification changes no total.
- **Reply, resolve, re-request.** A review thread that is answered but not resolved reads
  as outstanding, and the gate counts it.
