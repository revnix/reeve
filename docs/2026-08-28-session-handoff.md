# Session handoff — 2026-08-28

Supersedes `docs/2026-08-26-session-handoff.md` for anything they disagree on. A
2026-08-27 pair was written and dropped on the founder's call before it landed;
nothing here inherits from it.

---

## 0. STATE — MEASURE first, then read what only a person can tell you

Thirteen review rounds once found a fact corrected in one place and left standing
in another, so this section became the single place to write them down. Then
`main` moved twice in one afternoon while this file said otherwise, which taught
the harder half: **a fact a command can answer should not be written down at all.**
Writing it down does not make it available, it makes a second copy that ages, and
the copy is the one people read.

So §0 has two halves, and the split is the point.

### 0.1 Facts to MEASURE — never trust a file for these, this one included

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
cd ~/Work/Products/reeve && git fetch -q origin

git log --oneline -1 origin/main                     # what `main` is
git log --oneline -1 HEAD                            # what the CHECKOUT is; NOT what runs

# What the DAEMON runs, which is a different fact. A running process holds the
# modules it loaded at startup, so fast-forwarding the checkout moves the tree and
# not the process. The daemon writes this itself the moment it starts.
grep "daemon starting" ~/.reeve/reeve.log | tail -1

# --limit, because `gh pr list` fetches 30 by default and a silent truncation
# presents a partial list as the whole work queue.
gh pr list --state open --limit 100 --json number,headRefName,author \
   -q '.[] | "#\(.number) \(.author.login) \(.headRefName)"'
gh issue list --state open --limit 100 --json number,title -q '.[] | "#\(.number) \(.title)"'

# Is reeve ARMED? Read the PROCESS, never the plist: `launchctl kickstart`
# replays launchd's cached copy, so the file and the process can disagree.
ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"

# The two profile switches that decide whether the review half does anything.
# A profile edit is not in force until the daemon restarts.
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.reeve/profiles/nextlyhq/nextly.json'))); \
print('reviewActions:', d['watch'].get('reviewActions')); \
[print(' ', r['login'], r['kind'], repr(r.get('bodyFindings','ABSENT'))) for r in d['reviewers']]"

# A SPAWN, not a prepared contract. Both tables get a row before any process is
# started, so counting them answers "was a dispatch prepared". `worker_run.pid` is
# written from the spawn callback, so it is the witness that a worker actually ran.
sqlite3 -readonly ~/.reeve/state/nextlyhq/nextly.db \
  'select (select count(*) from run) as prepared,
          (select count(*) from worker_run where pid is not null) as spawned'

./bin/reeve doctor nextlyhq/nextly --as-app           # what is broken today
grep "shadow:" ~/.reeve/reeve.log | tail -1           # the review shadow streak

# IS CI ALIVE? A run's CONCLUSION cannot answer this: a job whose runner never
# started reports failure with ZERO steps. Count steps, which is the positive
# signal that something executed. `gh run list` cannot report them.
for id in $(gh run list --limit 3 --json databaseId -q '.[].databaseId'); do
  gh api "repos/revnix/reeve/actions/runs/$id/jobs" \
    -q "\"run $id: \" + ([.jobs[] | \"\(.name) \(.conclusion) steps=\(.steps|length)\"] | join(\" | \"))"
done

# Did a push reach somewhere that matters? A push to a branch whose pull request
# has already merged SUCCEEDS and lands nowhere.
gh pr list --state all --head <branch> --limit 1 --json number,state
```

If any of that disagrees with any prose in this repository, the command wins and
the prose is stale. That includes this section.

### 0.2 Facts no command answers — the ones that need a person

These are decisions and intent. A command can tell you `--execute` is absent; only
this can tell you that its absence is deliberate.

| | |
|---|---|
| `--execute` is OFF **on purpose** | disarmed 2026-08-23 after a P0; re-arming is the founder's call, not a resumed session's |
| the review switch is **ON** | `watch.reviewActions` was enabled 2026-08-27 on the founder's decision, together with a profile that declares how each reviewer's bodies carry findings. Both are write-free while `--execute` is absent, and both REDUCED notification volume |
| the reviewer declarations were **measured, not guessed** | derived 2026-08-27 from 694 stored review bodies. Two assumptions were wrong: CodeRabbit does state findings in bodies (46 of 87), and 60 of its 89 findings were landing unreadable because its bodies use a severity token its thread markers never covered |
| the durable-effect stages | **1, 2 and 4 have landed. 3 has not.** §3.2 says what each one IS — this row is the only place that says which have landed |
| the repository is **PUBLIC** | made public 2026-08-27 to restore Actions minutes, with the exposure audited and accepted by the founder first. Not reversible in effect: all 153 commits at that moment are readable |
| codex is a **blocking** reviewer | changed 2026-08-26. Before it, round counts were permanently zero and every cap-gated decision was unreachable |
| the docs guard's review status | **out of the review rotation** since 2026-08-26. It stays in CI; it is not sent for further adversarial rounds |
| the founder's merge rule | merge on CI green AND zero open threads, and **each merge needs its own grant** — a grant does not carry to the next pull request, and it does not override the rule |
| the R-03 merge shape | **undecided.** The enquiry was done on 2026-08-22 (§6); choosing what this repository declares is the founder's |
| the second project | `rextaihq/rext-backend` — **not started.** No profile, no store, nothing watching it |
| the ntfy read user | **not created.** Needs shell on the founder's server |
| what a real dispatch has proven | **nothing under the current contract.** §0.1's counts cannot answer this: neither table records which contract a worker ran under, nor whether the publish completed. The 2026-08-24 proof was a toy fixture |

**Change them HERE and nowhere else**; elsewhere, write "see §0". That is enforced
rather than intended: `test/docs-state-is-single-sourced.test.mjs` fails if a
sentence naming one of these subjects appears outside §0 without deferring to it
or carrying a date, and `test/zero-agrees-with-the-code.test.mjs` fails if the
stages row disagrees with what the tree actually contains.

---

## 1. What reeve is, in one paragraph

reeve is an agent-ops control plane: a daemon that watches a repository's pull
requests, judges them against a declared policy, escalates what needs a person,
and — when armed — dispatches a sandboxed worker to repair red CI and publishes
the fix itself. It lives at `github.com/revnix/reeve`, runs under launchd from
`~/Work/Products/reeve`, and stores per-repository state under
`~/.reeve/state/<owner>/<repo>.db`.

Two programmes share the codebase. **The guardian** is the above, and is this
lane. **The builder** takes a task and builds it across a phase machine, and is a
peer session's lane — see §7. They are separate daemons with separate stores.

---

## 2. The guardian's four capabilities

Whether each is on is a §0 fact and is not repeated here. This table says what
each capability IS.

| # | capability | what it does |
|---|---|---|
| 1 | Watch, judge, escalate | reads every pull request, judges it, and raises what a person must decide |
| 2 | Repair red CI | dispatches a sandboxed worker at a red check, gates the diff, and publishes the fix |
| 3 | Work review threads | answers and resolves review findings without a person relaying them |
| 4 | Refuse an unsafe merge | stands between a pull request and the default branch as a required check |

Capability 4's publishing half already exists: reeve posts a check run on every
tick. It blocks nothing, for two independent reasons — the check publishes as
`neutral` unless `--enforce` is passed, and the merge-authority ruleset (§0) leaves
this repository with no required status checks for it to be one of.

---

## 3. The durable-effect programme (§0 for where it stands)

The third of the four capabilities in §2. This section is the design and the
reasoning; §0.2's stages row says which parts have landed.

### 3.1 Why an outbox at all

reeve decides something and the decision implies a visible GitHub write. If those
two are not durable together, a crash between them leaves a store saying the round
was requested and a pull request where nothing was said. Re-deriving on the next
tick is **not** a repair: the head, the profile, the pull request's state or an
UNKNOWN timeout can all have moved, so the next tick may legitimately decide
something else and the effect is not late, it is gone.

### 3.2 The four stages

| stage | what it IS |
|---|---|
| 1 | the fencing token — a settle that cannot overwrite another drainer's live delivery |
| 2 | the drainer, the handler, and `REQUEST_REVIEW` as its first real producer |
| 3 | `SPILL` onto the same path |
| 4 | real thread details into `FIX_FINDINGS` |

Stage 2 was opened as one change. It reached ten review rounds and thirty-two
findings without tapering, on 2026-08-25. The founder's decision then was to split
it in two, and the mechanics half ran 5 findings, then 6, then clean — which the
single pull request never managed.

### 3.3 The properties the drainer holds, and why each is there

Every one of these was a review finding first. The list exists so nobody pays for
them twice — do not re-derive it.

- **ONE holder at a time.** `leaseOutbox` bumps a fence; `settleOutbox` refuses a
  settle from anyone else. A TTL plus a liveness check is NOT a substitute: a
  paused process keeps its pid, so `isAlive` answers yes for exactly the process to
  refuse.
- **`lease_token` and `attempts` are separate columns and must stay so.** A fence
  counts every lease; a budget counts real attempts. Two facts that both increase
  are still two facts.
- **Delivery is AT-LEAST-ONCE with best-effort deduplication.** This repository's
  own audit ruled that an outbox never advertises exactly-once.
- **Delivery is bounded; CONFIRMING a delivery is bounded separately.** A POST can
  create another comment; a marker read can only conclude "still cannot tell".
- **A lease that never ran refunds its budget and keeps its fence.**
- **The pass deadline is one absolute instant.**
- **A capability boundary is proved at run time, not read off the source.**

### 3.4 The gates

`--execute` (§0) is "may reeve act at all". `watch.reviewActions` (§0) is "may it
act on review threads". Both are required to queue AND to deliver, expressed as a
filter over the handler map so a kind reeve may not perform is unleaseable rather
than merely skipped.

---

## 4. What the review path does, and the holes closed in it

This is the newest work and the least likely to be understood from the code alone.

**The projection reaches decisions, bound to a revision.** `derivePr` classifies
every finding by severity and clears the ones a later round covers; `reviewState`
counts them. `reviewFacts` in `src/pr.mjs` carries that into the evaluation, and
the projection is bound to the head it was derived for — clearing is
head-dependent, so a projection derived for the previous head is not stale by the
clock and is still wrong.

**The tick folds before it judges.** It used to evaluate, then observe, ingest and
derive, so every decision read the previous tick's projection.

**Resolved is a claim; cleared is evidence.** The verdict read GitHub's
`isResolved`, so a critical finding could leave by being dismissed by the thing
that filed it. A `cleared` clause reads the fold's own record instead.

**Findings stated in a review BODY are derived.** A P0 written in a review's
summary with no inline comment used to be invisible, which is why the critical
count was unusable and both the round cap and SPILL sat inert. A body finding has
no thread, so the founder ruled on 2026-08-27 that the same reviewer reviewing the
same revision again clears it. A body reeve cannot READ becomes one finding of
unknown severity and escalates to a person, because no worker can act on it and
only the operator can clear it by describing that reviewer.

**Two counts, because two rules ask different questions.** `unspilledCritical`
counts every reviewer, since a critical is never spilled whoever filed it.
`blockingCritical` counts only reviewers whose opinion gates a merge, and it is
what the round cap reads.

**The inbox separates storage from ordering.** It is content-addressed, so
re-polling unchanged data writes nothing — right for storage and wrong as an
answer to "what does this object say now". A body edited A → B → A matches A's
stored hash, so nothing is written and the newest generation is still B.
`inbox_current` is the missing half, upserted on every observation including a
de-duplicated one; the split is the one Git makes between blobs and refs.

---

## 5. How the work is done

- **Measure, do not assume.** Every claim is measured, with a date, recorded under
  `docs/measured/`, or marked intent. Measure the PLATFORM too: `execFileSync`
  rejects a fractional timeout, `timeout: 0` bounds nothing, `timeout` does not
  exist on macOS, and on BSD `seq`, `seq 1 0` counts DOWN.
- **After writing a test, stub the fix back OUT and read the EXIT CODE.** Commit
  first, so `git checkout` is the restore: a sweep killed by a timeout otherwise
  leaves the tree stubbed.
- **`$?` after a command substitution is the substitution's.** `echo "$(basename
  $f) EXIT=$?"` reports basename's status, not the test's.
- **A control must be able to match.** A positive control whose term exists only
  on the branch under test returns nothing either way and proves nothing.
- **Verify a merge by CONTENT.** A squash collapses every commit subject into the
  pull request title, so grepping the default branch for a subject reports live
  work as missing.
- **Derive an id in the command that writes.** Pasting one copied out of scrollback
  sent three answers to the wrong destinations, and each reported success.
- **A push to a branch whose pull request has merged goes nowhere, and succeeds.**
- **The third instance of a shape is evidence about the DESIGN.** Remove the
  fallible read rather than correcting it again.
- **Reply to AND resolve every thread via GraphQL**, then comment `@codex review`.
  Findings arrive as review threads; a clean pass arrives as an ISSUE comment.
- **A 15-minute watcher** on open pull requests: `tools/watch-prs.sh`, in this
  repository. Run it, do not rewrite it.

---

## 6. Unfinished work, and what each piece needs

**Stage 3 of the durable-effect programme** (§0). `SPILL` onto the durable path:
one follow-up issue, replies naming it, and the threads resolved. It needs an
ordered effect — the replies depend on the issue's number — and the founder chose
a dependency edge between outbox rows over a compound handler, because each step
then keeps its own retry budget and idempotency.

**R-01** (§0), the merge authority. Part of it was applied on 2026-08-28: the
default branch's ruleset on the guarded repository gained a required-status-check
rule, and its organisation-admin bypass narrowed from always to pull-request-only.
`docs/measured/2026-08-28-r01-merge-authority.md` has the before and after, read
back from the API rather than assumed.

What remains is one switch and a precondition rather than a project. The switch
lives in BRANCH PROTECTION, a second mechanism governing the same branch, so
changing the ruleset said nothing about it. It was left alone deliberately on
2026-08-28, and the measured note records the base condition that has to change
first.

Note when picking it up that the substantive checks on that repository are
PATH-CONDITIONAL: a pull request touching nothing they watch runs neither of them,
so requiring one directly would block a pull request that legitimately does not run
it. That is why the required context is the aggregating job rather than a test
job.

The original framing is kept because it still explains WHY: reeve's fourth capability stands between a branch
and the default one as a required status check, so it wants a ruleset that
requires one and does not exempt the people most likely to land changes.
Instructions were sent to the founder on 2026-08-24; they need the founder's
account, about fifteen minutes.

**R-03** (§0), the merge shape. A gate that assumes squash merges reasons about
ancestry differently from one expecting merge commits, so the declared shape and
the actual history have to agree. The enquiry was done on 2026-08-22.

**R-05 and R-08 tidying** (§0). One declared reviewer has been silent across twenty
pull requests, and several detector patterns have never fired — including codex's
P0 marker, across thousands of classified findings. Either it files no P0s or the
pattern is wrong and every P0 has landed as `unknown`. `unknown` blocks, so
nothing unsafe has happened; which of the two is true is not known.

**Eleven documents claim this repository is private.** That was true when written
and is not now (§0). A false present-tense claim is what the docs guard exists to
stop, and it does not police plan files.

**The wrong-worker experiment.** It published correctly on 2026-08-24 — 61s,
$0.42, 16 turns, 0 denials — against a toy fixture. Its original harness was LOST
with the scratchpad that held it; whether one exists today is a question
`ls tools/` answers.

**Two pagination mechanisms** now exist: `gh api --paginate` on the live reads and
a hand-rolled reader with a twenty-page cap in ingest. Recorded rather than
reconciled.

---

## 7. The peer session, and how that has worked

The builder programme is a peer session's lane. Territory: theirs is
`src/build/**`, `bin/reeve`, `test/hub-*`; mine is `src/daemon.mjs`, `src/pr.mjs`,
`src/verdict.mjs`, `src/watcher.mjs`, `src/db/**`, `src/outbox/**`,
`src/review/**`, `src/github/**`, `src/prompts.mjs`.

A file list turned out to be the wrong unit. The rule that works is about SHAPE:
tell each other before changing the set of clause ids `computeVerdict` emits, or
the ORDER of `nextAction`'s branches. Editing inside a branch you already own
needs no ceremony.

The exchange has been worth real time rather than courtesy. They found a defect in
an outbox repair, corrected a false deadline, and caught a guard of theirs that
would have passed on my two new clause ids because its reader could not see a
camelCase name. I sent them a collision notice for a file I was not touching,
because I described my branch from memory instead of running
`git diff --name-only`; conceding that quickly cost less than defending it.

Both sessions spent two days trading one shape and sharpening it:

> **A check answers a NARROWER question than the caller reads it as, and the green
> is indistinguishable either way.**

Refinements worth carrying:

- **An overclaiming check can be held dormant by an unrelated limitation.** When a
  fix removes a limitation, re-examine every check downstream of it.
- **An exemption that never fires still widens what gets through.**
- **Refining a reading is not free.** Splitting one category into two must be
  re-checked against the answer it feeds, or the finer classification loses the
  coarser truth it refined.

---

## 8. Strategy, and what matters next

reeve exists so that the work of watching, judging and repairing a repository does
not need a person in the loop for the ordinary cases. The ordering below is about
what makes the next capability trustworthy rather than what is most interesting.

1. **Stage 3** (§0) of the durable-effect programme (§6), which finishes
   capability 3. Finishing it closes the review half.
2. **A real dispatch on a real repository** — see §0 for what has actually been
   proven, which is the whole reason this ranks here. In this project a dispatch
   once found what roughly 640 green tests missed. It needs arming, which is the
   founder's call.
3. **R-01** (§0), because refusing an unsafe merge means standing as a required
   status check, and a ruleset with no required checks has nowhere to stand.
4. **The merge-refusal capability** (§2, fourth row), after a shadow week.
5. **The tidying** (§6), which is cheap and can batch.

**A stop line is worth naming.** This kind of tooling expands for ever if allowed
to. Capability 3 finished plus one proven real dispatch is a defensible definition
of done; after that the guardian should go into maintenance and be touched when it
fails, not when something could be better.

**One caution about the evidence.** The move from shadow to enforcing is meant to
rest on the shadow agreement streak reeve records itself. That streak measures the
projection against a live read, and until recently it compared threads only — so
it is a weaker signal than its length suggests, and it should not be read as
proving the review surface agrees.
