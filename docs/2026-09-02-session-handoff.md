# Session handoff -- 2026-09-02, the guardian lane

Written for a session that has none of this context. Read section 0 first and RUN it;
everything below section 0 is commentary that was true when it was written.

This covers the GUARDIAN lane: the stub sweep, the merge gates, the hub schema, and the
operator-facing refusals the CLI prints. The operator lane (S3-E) keeps its own record.

The name matters and is not cosmetic. `test/newest-doc.mjs` decides which handoff and which
prompt the two documentation guards police, and it recognises exactly
`YYYY-MM-DD-session-handoff[-N].md` and `YYYY-MM-DD-resume-prompt[-N].md`. A prefixed name
is skipped by that resolver, both guards then run happily against the PREVIOUS day's pair,
and every green they report is about a document nobody has touched. That happened on
2026-09-01 and cost six real defects a full review round to surface. If a same-day revision
is needed, use the numeric suffix.

## 0. STATE -- MEASURE first, then read what only a person can tell you

Nothing in this document is a substitute for the commands below, INCLUDING the sentences in
this document. Every number here was true when it was written and several were wrong within
the hour. The block is the authority; prose defers to it.

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

# ONE ACCUMULATOR, and the block exits from it.
#
# Three findings in two review rounds were all this shape: a step's non-zero
# status printed and then overwritten by whatever ran next, so the block reported
# success while a gate inside it said no. Fixing them one at a time left the twin
# standing each time -- the sweep was repaired and the merge gates were not, in the
# same commit. So the read that can be forgotten is gone: every fallible step calls
# `note_refusal`, and the last line exits from what it accumulated.
#
# READS THAT MUST ABORT still abort on the spot, and they are a different thing: a
# failed fetch or a failed pull-request listing makes every line below it answer
# from stale or empty data, and continuing would produce confident wrong output
# rather than an incomplete report.
blockrc=0
note_refusal() { blockrc=1; echo "SECTION 0 REFUSES: $*"; }

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

# WHICH MIGRATION NUMBER IS FREE. The next migration is numbered from this, and the
# hub opener applies migrations by version WITHOUT enforcing contiguity -- so a tree
# carrying 1..N-1 and N+1 makes the read routes compute a missing N and refuse every
# hub on the machine.
#
# FROM THE DEFAULT BRANCH, not from this checkout. The first version of this line
# imported the module directly and answered 3 while the default branch said 6,
# because this block runs in a checkout that is deliberately never pulled. A number
# read here and handed to another lane is a wrong number handed with confidence.
git show origin/main:src/build/hubdb.mjs | grep -m1 "HUB_SCHEMA_VERSION = " \
  || note_refusal "could not read the schema version; the next migration number is unknown"

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
  node scripts/premerge.mjs "$open_pr" \
    || note_refusal "premerge says this merge should not happen (#$open_pr)"   # SHOULD this merge happen
fi
if [ -n "${merged_pr:-}" ]; then
  node scripts/verify-merge.mjs "$merged_pr" \
    || note_refusal "verify-merge says that merge did not carry everything (#$merged_pr)"
fi
# NO GATE IS A REFUSAL, not a warning. A block whose exit status cannot tell "no
# gate ran" from "the gate said yes" is the same defect as one that drops a gate's
# verdict, and a caller reads the status rather than the text.
if [ -z "${open_pr:-}${merged_pr:-}" ]; then
  note_refusal "no merge gate ran — set open_pr=<number> of an OPEN pull request, or merged_pr=<number> of a MERGED one"
fi
# ~4ms; every anchor still resolves. IN FLIGHT when this was written, so check it
# exists first: a missing file exits MODULE_NOT_FOUND, which is not the same answer
# as "no anchors rotted".
# ABSENT IS NOT CLEAN. `[ -f x ] && node x` skips silently when the file is not there,
# and the sweep below then runs as though no anchor had failed -- the two outcomes the
# comment above says must differ, rendered identically.
# MOVED INTO THE ISOLATED COPY BELOW, and this is why: run here it reported
# "anchors-resolve is ABSENT" every time, because the file does not exist in a
# checkout twenty commits behind. A refusal that fires on every run teaches a reader
# to skip it, and the one time it means something is the run they skip.
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
# IN THE COPY, for the same reason the coverage read is: the file exists on the
# default branch and not necessarily here.
( cd "$sweepdir" && node test/anchors-resolve.test.mjs ) \
  || note_refusal "a manifest anchor no longer resolves on the default branch"

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
[ "$covrc" -eq 0 ] || note_refusal "the coverage read failed (exit $covrc) -- do not read the absence as zero debt"
[ "$sweeprc" -eq 0 ] || note_refusal "the sweep failed (exit $sweeprc) -- read the verdict list, not the exit alone"
echo "sweep exit: $sweeprc; coverage exit: $covrc"

# THE LAST LINE, and the only place this block decides anything.
exit "$blockrc"
```

### 0.2 Facts no command answers -- the ones that need a person

| | |
|---|---|
| `--execute` is OFF **on purpose** | disarmed 2026-08-23 after a P0; re-arming is the founder's call and waits on ONE measurement rather than a decision -- see the pool row |
| `--enforce` is OFF | needs 7 clean shadow days AND the founder; the streak reset 2026-08-29 |
| the review switch is **ON** | `watch.reviewActions` enabled 2026-08-27 |
| the durable-effect stages | **1, 2 and 4 have landed. Stage three was never merged and is ABANDONED, not deferred** -- closed on the founder's decision 2026-08-30; what survived it is `enqueueWithDependants` |
| the repository is **PUBLIC** | made public 2026-08-27, exposure audited first |
| codex is a **blocking** reviewer | for reeve's OWN workflow; changed 2026-08-26 |
| the MANAGED PROJECT's reviewers | **all optional, 2026-08-31**. A silent one is not a problem to solve |
| the founder's merge rule | CI green AND zero open threads, and **each merge needs its own grant** -- a grant does not carry. Handed over with `scripts/premerge.mjs`'s verdict and the head SHA, so a grant names a commit |
| every test file needs a stub | **DECIDED 2026-08-30.** A file named by no entry and absent from `GRANDFATHERED` fails the sweep. A grandfathered file loses its place the moment it is MODIFIED, and the list may only shrink |
| reading `.pathname` | **BANNED outright 2026-08-31** by a lint rule, not a text search |
| whether headless and interactive Claude usage share one pool | **UNMEASURED, and it gates arming.** Observational, needs the founder. Plan: `docs/measured/2026-08-31-subscription-pool-plan.md`, corrected 2026-09-01 to name `provider_measurement` |
| the R-01 merge authority | **PARTLY done**; `enforce_admins` was enabled and DISABLED again on the founder's instruction |
| the R-03 merge shape | **undecided** |
| the second project | `rextaihq/rext-backend` -- **not started** |
| the ntfy read user | **not created** |
| **TWO lanes tonight** | guardian (this one) and the operator lane holding S3-E. Session names ROTATE -- ask, never infer |

**Change them HERE and nowhere else**; elsewhere write "see §0". Enforced by
`test/docs-state-is-single-sourced.test.mjs` and `test/zero-agrees-with-the-code.test.mjs`.

---

## 1. What this lane did, 2026-09-01 into 2026-09-02

Four pull requests merged from this lane. Measure the current list with section 0.1 rather
than trusting this one.

| what | why it mattered |
|---|---|
| **#124** a test file nobody declared fails the sweep | `coverage()` had always classified an undeclared test file as an orphan and its own comment called that the failure. Nothing read it |
| **#125** the day's handoff and resume prompt | and the rename that made the guards read them at all |
| **#131** section 0 now runs what it claims to run | six review findings, four P1, all inside the block a resumed session EXECUTES |
| **#134** a durable hub incarnation | migration 6, `hub_incarnation`, re-minted by `restoreHub` after every replay. Closes the storage half of #120 |
| **#135** a hole and a merely short history take different remedies | the read routes gave every shape of a missing migration the same advice. Twelve review findings, seven of one class |

Both were verified with `scripts/verify-merge.mjs` after landing rather than assumed: every
path on the default branch was exactly what the merge produced. Nothing from this lane was
open when this was written -- see §0 for what is open now.

## 2. The two defect shapes this lane keeps producing

Both were learned the hard way tonight, each three or more times, and both are now written
into the memory this session carries.

**A remedy that reads correctly and cannot be executed.** Seven of #135's twelve findings
were this. A command that refuses in the very state it is offered for; a snapshot restore
that would destroy a healthy store; a file that is three files; a marker no reader can hold;
a branch the caller never reached; a persistent lock called damage; a full disk called
damage. Every assertion I wrote checked that the sentence SAID something. None checked that
the instruction WORKED. The only thing that catches it is opening what the sentence names
and confirming the claim -- read the guard, list the files, run the command.

**A check that covers two properties reports on only one.** A discrimination harness with
one counterexample per message shape rather than per assertion; a manifest entry naming one
property while its edit broke two; two entries re-anchored onto one line. The tell is a
`WRONG_RED` verdict from the sweep, which is not noise: it is the instrument saying it
measured something other than what the entry named.

A third, older shape kept recurring too: **a fixture that certifies the wrong case.** A
"pre-v6" fixture that was really a damaged v6 hub; a "newer hub" recording only version 6,
which no binary can produce; fixtures carrying no `cause` at all when production always
attaches one.

## 3. Who holds what

Ask, do not infer. Session names rotated twice in one evening, and reading a name that no
longer resolves as a fact about OWNERSHIP is a mistake both lanes made.

- **This lane (guardian)**: `src/daemon.mjs`, `src/build/hubdb.mjs`, `src/build/hubfault.mjs`,
  `src/backup.mjs`, `bin/reeve`'s history refusals, the sweep and its manifest.
- **The operator lane (S3-E)**: `src/build/dash.mjs`, `src/build/announce.mjs`, the escalation
  identities and the page list, `test/task-show.test.mjs`.

Their branch was **written, tested and pushed with NO pull request open** as of 2026-09-02,
deliberately: the hub opener applies migrations by version without enforcing contiguity, so a
tree carrying a gap makes the read routes compute a missing number and refuse every hub on
the machine. Their migration is numbered from the schema version §0 measures.

## 4. The finding that matters most

`openHub` refuses a live hub recording a version newer than this binary BEFORE it takes the
lock, and `--force` does not reach that check. Any remedy naming `reeve restore --hub
--force` is therefore unrunnable for such a store -- which is the second refusal this whole
module exists to prevent, and it appeared three times in three different branches before the
condition was made a property of the STORE rather than of the diagnosis.

The move-aside sequence is the runnable answer, and it names all three files of a WAL
database because `openHub` forces WAL: measured, three files while open and one after a
clean close, with committed pages in the `-wal` after a crash.

## 5. The coverage debt

§0.1 measures it. What matters is the shape rather than the number: a handful of files
hold most of the entries, and the grandfathered list only shrinks when someone touches a
file. It fell by one tonight because `hub-drills.test.mjs` gained its first entry.

**This is a decision for the founder, not a task to start.** Paying it down deliberately is
weeks. The alternative is opportunistic -- a file earns coverage when someone touches it --
which is what has been happening. A middle option is to pay down only files covering
authority-bearing paths.

## 6. What is genuinely left

Nothing of this lane's was in flight when this was written; §0 says what is open now.

**#127** is answered in principle and has one item left: `builder:backup:failed` is raised by
the GUARDIAN into the guardian's store, and section 11.7 of the design assigns `builder:`
identities to the builder process and its hub table. That is a naming defect, and where a
backup escalation should be raised from is a decision about where backups live.

**#46's second half** -- removing the privileged startup read from `bin/reeve` and tightening
the structural assertion. Deferred all night because other lanes were in that file.

**#132** is the operator lane's and unblocks T15.

**Arming.** Three things gate it and none are code: the V6 measurement, an authority
baseline, and the worker isolation setting. All three need the founder.

## 7. House rules that earned their place

- **Gate BEFORE the commit, and gate the PUSH on the suite.** Not after. Run the anchor check
  and the linter first and let a failure abort the command before `git commit` is reached, and
  run the push only when the suite has reported zero failures. Both were learned by pushing
  red; the first refused a commit on 2026-09-02 that carried a half-repaired manifest.
- **Re-sweep every entry the behaviour touches**, not the entries the diff adds. A message is
  an interface: rewording one silently satisfied an assertion about something else entirely.
- **Measure the CURRENT tree.** A verification is a statement about a tree and expires the
  moment the tree moves, in the direction that reports success.
- **The daemon's checkout is not the repository.** It is deliberately never pulled.
- **Take the base copy whole and re-append.** Never merge the manifest hunk by hunk, and
  verify by CONTENT afterwards -- a count is satisfied by removing a different entry.
- **Capture the fork point BEFORE merging.** A merge-base recomputed afterwards resolves to
  the other side and the comparison then compares it to itself.
- **Never advise `git stash` here.** The stash is shared repository-wide and hooks write to it.
- **zsh does not word-split an unquoted variable**, and it applies `:t`-style modifiers to
  `$var:text`. Both produced inert checks that printed something plausible.
- **Reply, resolve, re-request.** A thread answered but not resolved still counts as open, and
  the merge gate reads it that way.
