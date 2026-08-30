# Session handoff — 2026-08-31

Supersedes `docs/2026-08-30-session-handoff.md` for anything they disagree on. That
document's §1-§5 still describe what reeve IS; the 2026-08-28 handoff's §1-§5 remain
the deepest description of the architecture. This one carries 2026-08-30 and 31.

---

## 0. STATE — MEASURE first, then read what only a person can tell you

**A fact a command can answer should not be written down.** Writing it down does not
make it available, it makes a second copy that ages, and the copy is the one people
read. This section is mostly COMMANDS for that reason.

### 0.1 Facts to MEASURE — never trust a file for these, this one included

```bash
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
prs=$(gh pr list --repo revnix/reeve --state all --limit 200 \
        --json headRefName,headRefOid,isCrossRepository \
        -q '.[] | select(.isCrossRepository | not) | "\(.headRefOid) \(.headRefName)"') \
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

# NOT a pinned number: these two answer about ONE pull request, and a resumed
# session reading a verdict for the wrong one is the stale-tip merge this block
# exists to prevent, wearing the costume of a passing gate. Unset is an abort.
: "${pr:?set pr=<number> for the pull request you are asking about}"
node scripts/premerge.mjs "$pr"                       # SHOULD a merge happen
node scripts/verify-merge.mjs "$pr"                   # did a merge carry everything
# ~4ms; every anchor still resolves. IN FLIGHT when this was written, so check it
# exists first: a missing file exits MODULE_NOT_FOUND, which is not the same answer
# as "no anchors rotted".
[ -f test/anchors-resolve.test.mjs ] && node test/anchors-resolve.test.mjs
# ~20 minutes, and run it in an ISOLATED detached worktree at a COMMITTED head. It
# writes stubbed source and restores a startup snapshot, so an edit made while it runs
# is silently overwritten — and this checkout is shared by three sessions.
node scripts/stub-sweep.mjs
```

If any of that disagrees with any prose in this repository, the command wins and the
prose is stale. That includes this section.

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

## 1. What landed, 2026-08-30 and 31

Ten of mine, each verified by CONTENT on 2026-08-31 rather than by GitHub reporting success:

| | |
|---|---|
| #88 | the outbox dependency edge, salvaged from the abandoned stage 3 |
| #89 | the legacy migration's counters keyed by a null prototype |
| #90, #93, #95 | file URLs decoded rather than read as a path — three rounds (see §0) |
| #91 | an approval bound to the commit it was given on |
| #94 | the sweep widened (see §0 for the rule it introduced) |
| #97 | two review fixes that missed their merges |
| #99 | a stub anchor #94 broke, and the ratio that counted it as coverage |
| #101 | the lint rule that replaced a text search (see §0 for the rule it enforces) |

The other two lanes landed #83, #86, #87, #92, #96, #98, #100, #102.

---

## 2. THE SHAPE OF EVERY DEFECT FOUND TODAY

Read this before writing code. Almost every defect found — by codex, by either peer,
or by me — was **one shape: a check that reports success while measuring nothing.**

- **fixtures agreeing with the code that produced them.** The SPILL producer read
  `f.thread_id` and `f.body`; the projection emits `id` and `excerpt`. 6,022 assertions
  passed because I wrote the producer and its fixtures together, so both used one
  invented vocabulary. The stub sweep cannot catch this: it proves an assertion CAN
  fail, never that a fixture is REAL.
- **an assertion whose expected value is what a broken implementation returns.** "Zero
  orphans" cannot be moved by breaking the detector. Two of my own stubs came back
  NOT_CAUGHT for this reason.
- **a control built from the filter it then asserts.** `unexempt.every(f => !DATA.has(f))`
  where `unexempt` was built with `!DATA.has(f)` is a tautology.
- **a gate comparing a commit to itself.** On a push to the default branch its remote ref IS the head
  being judged, so the diff is empty and the grandfathering gate passed without
  looking (2026-08-30).
- **an anchor that silently stopped matching.** A refactor moved the code; nothing in
  the manifest could notice.
- **a ratio counting refusals as coverage.** The number added to stop coverage being
  overstated was itself overstating it.
- **a lint config that skipped a file and printed nothing.** "File ignored" and "file
  clean" are the same output.
- **a shell failure read as data.** An unquoted `$VAR:path`, a failed `cd`, a zsh
  history modifier — each returned empty, and empty was the answer being looked for.

**The habit that catches all of them:** before believing a green, ask what would have
to be true for it to be red, then make that happen. Several times today the answer was
"nothing could", which is not a passing test.

**The second habit:** when a comment contains "and" or "rather than", check BOTH halves
exist in the code. Five times this session I stated a two-clause rule and built one
clause — the ratchet without its pin, a directory invariant checked one way, a
proven-entry count that left the proven-FILE count alone, a comment about writes whose
code counted declarations, and a rule whose comment promised http URLs stayed legal
while the code refused them.

---

## 3. Who holds what

**Read the open pull requests with §0.1's command; this section deliberately lists
none.** An enumeration here is a second copy of a fact that changes hourly, and the
copy is the one people read.

What does not change hourly is the LANES:

- **guardian** (this session) — `src/daemon.mjs`, `src/db/**`, `src/outbox/**`,
  `src/github/**`, `src/pr.mjs`, `src/premerge.mjs`, `src/review/**`, `src/prompts.mjs`,
  `scripts/stub-sweep.mjs`, `test/stub-manifest.mjs`, `tools/**`
- **builder** — `src/build/**`, `src/profile/**`, the S3 task chain, docs generators
- **third session** — S3 T13, the task read model: `bin/reeve` routes and
  `src/build/taskmodel.mjs`

`test/stub-manifest.mjs` is the guardian's and every lane needs entries in it. Adding
your OWN test files' entries is expected; **never resolve a conflict in it hunk by
hunk** — take the default branch's copy whole and re-append once.

**Two anchors rotted under merged work.** Whether they are still rotted, and where a
repair lives, is a §0.1 question — run the anchor command and the pull request listing
rather than trusting a sentence here. Three sessions reached those two entries
independently on 2026-08-30, so before repairing them, check whether someone already
has: a second repair conflicts on the manifest.

## 4. THE FINDING THAT MATTERS MOST FOR THE NEXT SESSION

**Four pull requests merged at an OLDER commit than their branch tip**, silently
dropping the last round of review fixes each time. #90, #93, #94, #95. Each cost a
follow-up (#93, #95, #97).

The cause is structural: a grant names a PR NUMBER, so the person holding the
information and the person taking the action are never the same reader. Changing my
push ordering twice did not stop it.

`scripts/premerge.mjs` already answered this and nothing was running it. Its FIRST
check is `headState`, which REFUSES when the merge would take a commit the branch has
moved past. `scripts/verify-merge.mjs` catches the same thing but only AFTER, which is
a post-mortem rather than a gate.

**So: run the gate, quote the verdict AND the sha, every time.** Three merges since
have been clean.

---

## 5. The sweep, as it now stands

74 entries over 12 of 113 test files; 101 grandfathered. Measured 2026-08-31 IN THIS
COMMIT'S TREE — the first version of this line was measured in a feature branch's
worktree and every count was one ahead, which a resumed session would have read as
drift. Re-measure with §0.1 rather than trusting it.

- §0 owns the rule; what follows is only how the mechanism enforces it
- the pin reads the list at the BASE commit and refuses growth
- the coverage line distinguishes **entries present from entries PROVEN**, because an
  unrunnable entry guards nothing
- an unresolvable diff base **refuses** rather than reporting an empty diff, and the
  message names `fetch-depth: 0`
- a 4ms anchor-resolution pass is IN FLIGHT, not merged, because the only check that
  reads an anchor costs twenty minutes and so was never run before a push. Until it
  lands, the twenty-minute sweep is the only thing that answers that question

---

## 6. What is genuinely left

**The V6 measurement.** §0 owns the status. **The plan is not in this commit** — it
lands with the decisions change; until that merges, this row names something a reader
cannot open, and that is stated rather than hidden. It needs
the founder for a quiet window, two verbatim allowance readings with times, and
agreement on caps. **Its obligation belongs to T16 in the builder lane** — whether it
lands there or separately is a coordination question, not a technical one.

**The test clock.** §0 owns it. Guard that refuses a future timestamp on write, THEN
the correction, so it cannot come back.

**One flake, not a defect.** `test/provider-scheduler.test.mjs` failed once on the
default branch (2026-08-30) with one of twenty racing children exiting zero and empty. The builder lane proved by
import graph that the change it landed with could not reach that file, identified a
candidate mechanism — the test resolves on `exit` where `close` guarantees stdio has
drained, a distinction `src/supervisor.mjs` already carries — and **could not reproduce
it in 480 children**. Three test files share the shape.

That last sentence used to say nobody had fixed it, correctly. It was wrong, and the
correction matters more than the flake. Production waits for `close` at
`src/supervisor.mjs` for exactly this reason, in a comment that says `exit` can precede
the final result line; the test listens on `exit` and reads the buffer at that instant.
So the listener is a defect on the evidence already in the tree, and 480 children that
did not reproduce a race establish nothing about whether the race exists. Failing to
reproduce is not evidence of absence.

The fix is one line — listen on `close` — but `test/provider-scheduler.test.mjs` sits
in GRANDFATHERED, and §0 states what editing such a file then costs. That is why this
is a task rather than a drive-by, and it is a reason to schedule it rather than a
reason to call it safe.

---

## 7. House rules that earned their place today

- **Measure, do not assume.** And measure the PLATFORM: `bin/*` does NOT match an
  extensionless file in eslint flat config (`bin/!(*.*)` does); `exit` can precede a
  child's stdio drain where `close` cannot; and the pull-request listing truncates by
  default, which is why §0.1 passes an explicit limit.
- **An absence search needs a positive control.** Three separate inert measurements
  today returned empty, and empty was the expected answer.
- **Never merge `test/stub-manifest.mjs`.** Take the default branch's copy WHOLE and re-append once.
  Merging it has produced array holes, and a hole is invisible to `forEach` and to
  `node --check`.
- **A caveat that documents a hole is worse than no caveat.**
- **The third instance of a shape is evidence about the DESIGN.** Change the mechanism.
- **Do not trust a plan's "produces" clause you have not run.** The builder lane found
  a rationale repeated VERBATIM across two plan documents and backwards in both — two
  copies of one error read as two sources agreeing.
