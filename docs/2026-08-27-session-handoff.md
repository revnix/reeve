# Session handoff — 2026-08-27

Supersedes `docs/2026-08-26-session-handoff.md` for anything they disagree on.

---

## 0. STATE — MEASURE first, then read what only a person can tell you

Thirteen review rounds once found a fact corrected in one place and left standing
in another, so this section became the single place to write them down. Then
`main` moved twice in one afternoon while this file said otherwise, which is the
lesson the single-source rule could not teach on its own: **a fact a command can
answer should not be written down at all.** Writing it down does not make it
available, it makes a second copy that ages, and the copy is the one people read.

So §0 has two halves, and the split is the point.

### 0.1 Facts to MEASURE — never trust a file for these, this one included

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
cd ~/Work/Products/reeve && git fetch -q origin

git log --oneline -1 origin/main                     # what `main` is
git log --oneline -1 HEAD                            # what the CHECKOUT is; NOT what runs

# What the DAEMON runs, which is a different fact. A running process holds the
# modules it loaded at startup, so fast-forwarding the checkout moves the tree and
# not the process — and does not move it until a restart actually succeeds, which
# it may not. The daemon writes this itself at the moment it starts.
grep "daemon starting" ~/.reeve/reeve.log | tail -1

# --limit, because `gh pr list` fetches 30 by default and a silent truncation
# presents a partial list as the whole work queue.
gh pr list --state open --limit 100 --json number,headRefName,author,baseRefName \
   -q '.[] | "#\(.number) \(.author.login) \(.headRefName) -> \(.baseRefName)"'

# Is reeve ARMED? Read the PROCESS, never the plist: `launchctl kickstart`
# replays launchd's cached copy, so the file and the process can disagree.
ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"

# A SPAWN, not a prepared contract. Both tables get a row before any process is
# started, so counting them answers "was a dispatch prepared" — which is positive
# for a run that failed before it ever spawned. `worker_run.pid` is written from
# the spawn callback, so it is the witness that a worker actually ran.
sqlite3 -readonly ~/.reeve/state/nextlyhq/nextly.db \
  'select (select count(*) from run) as prepared,
          (select count(*) from worker_run where pid is not null) as spawned'

./bin/reeve doctor nextlyhq/nextly --as-app           # what is broken today
grep "shadow:" ~/.reeve/reeve.log | tail -1           # the review shadow streak

# IS CI ALIVE? A job that "fails" with zero steps never ran.
gh run list --limit 5 --json headSha,conclusion,headBranch \
   -q '.[] | "\(.headSha[0:7]) \(.headBranch) \(.conclusion)"'
```

If any of that disagrees with any prose in this repository, the command wins and
the prose is stale. That includes this section.

### 0.2 Facts no command answers — the ones that need a person

These are decisions and intent. A command can tell you `--execute` is absent; only
this can tell you that its absence is deliberate.

| | |
|---|---|
| `--execute` is OFF **on purpose** | disarmed 2026-08-23 after a P0; re-arming is the founder's call, not a resumed session's |
| the durable-effect stages | **1, 2 and 4 have landed. 3 has not.** §3.2 says what each one IS — this row is the only place that says which have landed. Stage 4 arrived out of order: wiring the projection gave `FIX_FINDINGS` its real thread list, so the stage defined as "thread details into FIX_FINDINGS" was complete before SPILL's own delivery was built |
| the critical-count cap | **NOT ENFORCED.** Review-body findings are not derived, so `unspilledCritical` is null everywhere and the clause says so in its own detail rather than passing silently |
| codex is a **blocking** reviewer | changed 2026-08-26 on the founder's decision. Before it, round counts were permanently zero and every cap-gated decision was unreachable |
| the docs guard's review status | **out of the review rotation** since 2026-08-26. It stays in CI; it is not sent for further adversarial rounds. Ten rounds, forty-nine findings, and each round's fix opened the next round's holes |
| the publish fix | **merged** — repairs are staged and committed by reeve, never by the worker. Kept because a session that does not know this re-opens the question |
| the second project | `rextaihq/rext-backend` — **not started.** No profile, no store, nothing watching it |
| the ntfy read user | **not created.** Needs shell on 95.217.11.127, which is the founder's |
| the R-03 merge shape | **undecided.** The enquiry was done on 2026-08-22 (§6); choosing what this repository declares is the founder's, and has not been made |
| CI | **broken repository-wide since 2026-08-26.** Not the code — see §5 |
| the founder's merge rule | merge on CI green AND zero open threads. Reaffirmed 2026-08-25 over my recommendation to wait for a verdict |

**Change these HERE and nowhere else**; elsewhere, write "see §0". That is
enforced rather than intended: `test/docs-state-is-single-sourced.test.mjs` fails
if a sentence naming one of these subjects appears outside §0 without deferring to
it or carrying a date, and `test/zero-agrees-with-the-code.test.mjs` fails if the
stages row disagrees with what the tree actually contains.

---

## 1. What reeve is, in one paragraph

reeve is an agent-ops control plane: a daemon that watches a repository's pull
requests, judges them against a declared policy, escalates what needs a person,
and — when armed — dispatches a sandboxed worker to repair red CI and publishes
the fix itself. It lives at `github.com/revnix/reeve` (private), runs under
launchd from `~/Work/Products/reeve`, and stores per-repository state under
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
| 1 | Watch, judge, escalate | reads every open pull request, judges it, and raises what needs a person |
| 2 | Repair red CI | dispatches a sandboxed worker at a red check, gates the diff, and publishes the fix |
| 3 | Work review threads | answers and resolves review findings without a person relaying them |
| 4 | Refuse an unsafe merge | stands between a pull request and the default branch as a required check |

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
  settle from anyone else. A stalled drainer cannot mark done a delivery a live
  one is making. A TTL plus a liveness check is NOT a substitute: a paused process
  keeps its pid, so `isAlive` answers yes for exactly the process to refuse.
- **`lease_token` and `attempts` are separate columns and must stay so.** A fence
  counts every lease; a budget counts real attempts. Two facts that both increase
  are still two facts.
- **Delivery is AT-LEAST-ONCE with best-effort deduplication.** Not at-most-once —
  this repository's own audit ruled that an outbox never advertises exactly-once.
  The unique key stops a double ENQUEUE; the fence stops two drainers settling
  over each other; the marker makes a duplicate COMMENT unlikely. Only the third
  is about delivery, and a failed marker read deliberately posts anyway.
- **Delivery is bounded; CONFIRMING a delivery is bounded separately.** A POST can
  create another comment; a marker read can only conclude "still cannot tell".
  Charging both to one counter dead-lettered comments GitHub had actually created.
- **A lease that never ran refunds its budget and keeps its fence.** The lease
  happened; the attempt did not.
- **The pass deadline is one absolute instant.** Re-deriving it from a remainder
  sampled before the lease refunded whatever the lease waited for.
- **A capability boundary is proved at run time, not read off the source.** The
  ambient capabilities are removed in a child process and the handler is run
  against nothing but its injected caller. An import that cannot be READ is itself
  a violation, because an allowlist can only police what can be named.

### 3.4 The gates

`--execute` (§0) is "may reeve act at all". `watch.reviewActions` (§0) is "may it
act on review threads". Both are required to queue AND to deliver, expressed as a
filter over the handler map so a kind reeve may not perform is unleaseable rather
than merely skipped. HALTED is re-read at the moment of acting, because backup and
the self-audit run between the last per-pull-request check and the drain.

---

## 4. What the review path now does, and the three holes that were closed

This is the newest work and the least likely to be understood from the code alone.

**The projection reaches decisions, bound to a revision.** `derivePr` classifies
every review thread by severity and clears the ones a later round covers;
`reviewState` counts them. That fed a shadow log and nothing else. Now
`reviewFacts` in `src/pr.mjs` carries it into the evaluation, and the projection
is bound to the HEAD it was derived for — clearing is head-dependent, so a
projection derived for the previous head is not stale by the clock and is still
wrong.

**The tick folds before it judges.** It used to evaluate, then observe, ingest and
derive — so every decision read the previous tick's projection. `prAnchor` pins
the revision once, then the fold runs, then the evaluation. Two P1s came out of
that single ordering and neither was catchable downstream: a head check cannot see
a reviewer acting on the same revision, and a count cross-check cannot see a
thread EDITED in place.

**Resolved is a claim; cleared is evidence.** The verdict read GitHub's
`isResolved`, so a critical finding could leave it by being dismissed by the thing
that filed it — the bot resolves its own threads, and `@coderabbitai resolve` is
author-invokable. A `cleared` clause reads the fold's own record instead, blocks
independently of the round cap, and is scoped to BLOCKING reviewers: an advisory
reviewer that never returns would otherwise block a pull request forever.

**An uncleared thread asks the reviewer; it does not send a worker.** After a
push, threads are uncleared because nobody has reviewed the new head — so
dispatching a fixer skips the one thing that could clear them. Where the reviewer
HAS covered the head, an uncleared thread means it was resolved after their round,
and the answer is the same.

**What is still UNKNOWN, and why that is not paralysis** (§0 for its state). The
fold reads severity from thread rows only, so a P0 stated in a review body with no
inline thread is invisible to it. A zero missing one would spill a critical. But a permanent unbuilt capability must not present as a
per-pull-request uncertainty — reporting it as UNKNOWN made every pull request
past the soft cap UNKNOWN, and the watcher handles UNKNOWN before BLOCK findings,
so the cap stopped all remediation instead of stopping a spill. It passes and says
the cap is not enforced.

---

## 5. How the work is done

- **Measure, do not assume.** Every claim is measured, with a date, recorded under
  `docs/measured/`, or marked intent. Measure the PLATFORM too: `execFileSync`
  rejects a fractional timeout, `timeout: 0` bounds nothing, and on BSD `seq`,
  `seq 1 0` counts DOWN.
- **After writing a test, stub the fix back OUT and read the EXIT CODE.** A stub
  that crashes a file prints no FAIL line, and a grep-based loop reads that as
  "untested".
- **Verify the base is green BEFORE a sweep.** A pre-existing failure leaks into
  every probe and every reading becomes a measurement of it.
- **A control that passes for a second reason is not a control**, and a check
  compared against something derived from itself cannot fail.
- **Never `| head` a search whose result you will treat as a set.** It turns
  "these are the occurrences" into "these are some", and nothing says which.
- **Reply to AND resolve every thread via GraphQL** — replying alone does not
  clear it — then comment `@codex review` to request the next round.
- **A 15-minute watcher** on open pull requests: `tools/watch-prs.sh`, in this
  repository. Run it as `tools/watch-prs.sh [PR ...]`, or with no arguments for
  every open one you author. It emits a heartbeat, keeps the last good reading
  when a probe fails, alarms after two blind ticks, and only a positively-read
  closed state stops it.
- **CI cannot be trusted at the moment** (§0). A job that reports failure with
  ZERO steps and no retrievable log never ran; compare against a run that worked,
  which has nine steps and takes minutes. Diagnose with
  `gh api repos/revnix/reeve/actions/runs/<id>/jobs` and look for a failing step.
  If there is none, the run is infrastructure and the code is unmeasured — run the
  suite locally and say so rather than letting a stalled runner pass as a pass.

---

## 6. Unfinished work, and what each piece needs

**Review-body findings are not derived.** The fold reads severity from thread rows
only. This is the precondition for two things: the critical count becoming a
number, and SPILL becoming reachable. It needs a design decision first — a body
finding has no thread to resolve, so its clearing semantics are an open question,
and that question is the founder's.

**Stage 3 of the durable-effect programme** (§0). `SPILL` onto the durable path: one
follow-up issue, replies naming it, and the threads resolved. It needs an ordered
effect — the replies depend on the issue's number — and the founder chose a
dependency edge between outbox rows over a compound handler, because each step
then keeps its own retry budget and idempotency.

**R-01** (§0), the merge authority. What the rule MEANS: reeve's
fourth capability stands between a pull request and the default branch as a
required status check, so it needs a ruleset that requires one and does not exempt
the people most likely to merge. Instructions were sent to the founder on
2026-08-24; they need the founder's account, about fifteen minutes.

**R-03** (§0), the merge shape. What the rule MEANS: a gate that
assumes squash merges reasons about ancestry differently from one expecting merge
commits, so the declared shape and the actual history have to agree. The enquiry
was done on 2026-08-22 and recorded in
[the 22 August handoff](2026-08-22-session-handoff-2.md) — four merge commits in
the last twenty against a declared squash. What remains is the decision.

**The wrong-worker experiment.** It published correctly on 2026-08-24 — 61s,
$0.42, 16 turns, 0 denials — against a toy fixture, and has never been run against
a real repository. **Its original harness was LOST** with the scratchpad that held
it. Whether one exists today is a question `ls tools/` answers. Rebuilding is
perhaps an hour, and it goes in `tools/`.

**Also open:** two person-owned items whose state lives in §0.2 rather than in
this section, because a session would otherwise infer their state from an unticked
line here.

---

## 7. The peer session, and how that has worked

The builder programme (S1, S2, S2-B, S2-C) is a peer session's lane. Territory:
theirs is `src/build/**`, `bin/reeve`, `test/hub-*`; mine is `src/daemon.mjs`,
`src/pr.mjs`, `src/verdict.mjs`, `src/watcher.mjs`, `src/db/**`, `src/outbox/**`,
`src/review/**`, `src/github/**`, `src/prompts.mjs`.

Ask before crossing, and expect to be asked. I borrowed `src/daemon.mjs` for one
pull request and handed it straight back; they asked before taking it for theirs.
That has cost nothing and prevented at least two collisions.

The exchange has been worth real time rather than courtesy. Both sessions spent
the day trading one shape and sharpening it:

> **A check answers a NARROWER question than the caller reads it as, and the green
> is indistinguishable either way.**

Instances, all measured: a name comparison that could not see a wrong TYPE; a
count comparison that could not see an in-place EDIT; `isAlive` asked to mean both
"is anyone there" and "is this still yours"; `git grep | head -3` read as the
complete set; `$?` after `basename`; `seq 1 0` counting down; a `ps` on an empty
pid reporting zero; a refusal that was `SQLITE_BUSY` rather than the guard working.

Two refinements worth carrying:

- **An overclaiming check can be held dormant by an unrelated limitation.** The
  coverage is real and the blind spot is total — a gap shows in a coverage report
  and this does not. When a fix removes a limitation, re-examine every check
  downstream of it, because those checks have never run against the widened input.
- **An exemption that never fires still widens what gets through.** Stub every
  "except when" and require it to go red, or delete it.

---

## 8. Strategy, and what matters next

reeve exists so that the work of watching, judging and repairing a repository does
not need a person in the loop for the ordinary cases. Everything else is in
service of that, and the ordering below is about what makes the next capability
trustworthy rather than what is most interesting.

1. **Review-body findings** (§6), because two capabilities are waiting on it and
   both are currently honest-but-inert.
2. **Stage 3** (§0) of the durable-effect programme (§6), which finishes
   capability 3.
3. **A real dispatch on a real repository** — see §0 for what has actually been
   proven so far, which is the whole reason this ranks here. In this project a
   dispatch once found what roughly 640 green tests missed.
4. **R-01** (§0 for its state), because refusing an unsafe merge means standing as
   a required status check. A ruleset with no required checks has nowhere to stand.
5. **The merge-refusal capability** (§2, fourth row), after a shadow week.

The through-line of the last two days is that reeve's own instruments were the
thing most in need of repair. A projection that worked and reached no decision; a
verdict reading a claim instead of evidence; a tick that judged before it looked.
None of those were visible from the outside, and all of them were found by writing
the comparison rather than the better rule.
