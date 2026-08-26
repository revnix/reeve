# Session handoff — 2026-08-26

Supersedes `docs/2026-08-24-session-handoff.md` for anything they disagree on.

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
git log --oneline -1 HEAD                            # what the DAEMON runs; drift is normal
gh pr list --state open --json number,headRefName,author,baseRefName \
   -q '.[] | "#\(.number) \(.author.login) \(.headRefName) -> \(.baseRefName)"'

# Is reeve ARMED? Read the PROCESS, never the plist: `launchctl kickstart`
# replays launchd's cached copy, so the file and the process can disagree.
ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"

# Has a real dispatch ever happened? The store is PER REPO, and read-only here:
# sqlite3 opens a missing path by CREATING it, so a wrong path answers "zero rows"
# for a database it just made.
sqlite3 -readonly ~/.reeve/state/nextlyhq/nextly.db \
  'select (select count(*) from run) as runs, (select count(*) from worker_run) as workers'

./bin/reeve doctor nextlyhq/nextly --as-app           # what is broken today
grep "shadow:" ~/.reeve/reeve.log | tail -1           # the review shadow streak
```

If any of that disagrees with any prose in this repository, the command wins and
the prose is stale. That includes this section.

### 0.2 Facts no command answers — the ones that need a person

These are decisions and intent. A command can tell you `--execute` is absent; only
this can tell you that its absence is deliberate.

| | |
|---|---|
| `--execute` is OFF **on purpose** | disarmed 2026-08-23 after a P0; re-arming is the founder's call, not a resumed session's |
| the publish fix | **merged** — #19. Repairs are staged and committed by reeve, never by the worker |
| prompt/grant fix | **merged** — #18 |
| the dispatch write-up | **merged** — #15 |
| the outbox fence | **merged** — #27 |
| the lease guard + property assertions | **merged** — #29 |
| what a real dispatch has proven | nothing yet under the current contract. If `run` is empty, the publish path is carried by tests alone |
| the tracker | current to 2026-08-24; §6 says what belongs in it after that |
| capability 1 — watch, judge, escalate | the one that is meant to be on |
| capability 2 — repair red CI | built, and gated behind `--execute` above |
| capability 3 — work review threads | being built now; §3 is the whole plan and where it has got to |
| capability 4 — refuse an unsafe merge | not started; needs a shadow week and the R-01 ruleset flip |
| the builder daemon | not something this programme runs; S2 is a peer's lane, see §7 |
| the founder's merge rule | merge on CI green AND zero open threads. Reaffirmed 2026-08-25 over my recommendation to wait for a verdict |

**Change these HERE and nowhere else**; elsewhere, write "see §0". That is
enforced rather than intended: `test/docs-state-is-single-sourced.test.mjs` fails
if a present-tense state claim, or a block naming one of the subjects above,
appears in the resume prompt or in this file outside §0 without deferring to it.

---

## 1. What reeve is, in one paragraph

reeve is an agent-ops control plane: a daemon that watches a repository's pull
requests, judges them against a declared policy, escalates what needs a person,
and — when armed — dispatches a sandboxed worker to repair red CI and publishes
the fix itself. It lives at `github.com/revnix/reeve` (private), runs under
launchd from `~/Work/Products/reeve`, and stores per-repository state under
`~/.reeve/state/<owner>/<repo>.db`.

Two programmes share the codebase. **The guardian** is the above. **The builder**
takes a task and builds it across a phase machine. They are separate daemons with
separate stores. Which of them is running is a §0 fact.

---

## 2. The guardian's four capabilities

Whether each is on is a §0 fact and is not repeated here. This table says what
each capability IS; §0 says where it stands.

| # | capability | what it does |
|---|---|---|
| 1 | Watch, judge, escalate | reads every open pull request, judges it, and raises what needs a person |
| 2 | Repair red CI | dispatches a sandboxed worker at a red check, gates the diff, and publishes the fix |
| 3 | Work review threads | answers and resolves review findings without a person relaying them |
| 4 | Refuse an unsafe merge | stands between a pull request and `main` as a required check |

---

## 3. The durable-effect programme

The third of the four capabilities in §2. Where it has got to is a §0 fact; this
section is the design and the reasoning behind it.

This is the live piece of work. Read this section before touching anything in
`src/outbox/` or the review-request path in `src/daemon.mjs`.

### 3.1 Why an outbox at all

reeve decides something and the decision implies a visible GitHub write. If those
two are not durable together, a crash between them leaves a store saying the round
was requested and a pull request where nothing was said. Re-deriving on the next
tick is **not** a repair: the head, the profile, the pull request's state or an
UNKNOWN timeout can all have moved, so the next tick may legitimately decide
something else and the effect is not late, it is gone.

So a decision and its effects are written in ONE transaction, and a drainer
carries them out afterwards.

### 3.2 The four-PR plan

Where each has got to is a §0 fact. This says what each one IS.

| PR | what |
|---|---|
| 1 | the fencing token — a settle that cannot overwrite another drainer's live delivery |
| 2 | the drainer, the handler, and `REQUEST_REVIEW` as its first real producer |
| 3 | `SPILL` onto the same path |
| 4 | real thread details into `FIX_FINDINGS`, which reads an empty list until this lands |

PR 2 was opened as one change, reached **ten review rounds and thirty-two
findings without tapering**, and was split into two on the founder's decision. The
split ran 5 findings → 6 → clean on the mechanics half, which the single PR never
managed. §0 lists what is open now.

### 3.3 The properties the drainer holds, and why each is there

Every one of these was a review finding before it was a property. They are listed
because re-deriving them costs more than reading them.

- **One holder at a time.** `settleOutbox` matched on `id` alone, so a drainer
  whose lease had expired could mark done a delivery another was mid-way through.
  A TTL plus a liveness check is NOT a substitute: `isAlive` answers "is anyone
  there", never "is this still yours", and a paused process keeps its pid.
- **`lease_token` is separate from `attempts`, and must stay separate.** `attempts`
  is the retry BUDGET (`dead = attempts >= max_attempts`) so it may only count real
  attempts; a fence must count every lease including one that delivered nothing.
  Two facts that both increase are still two facts.
- **Bounded per pass in BOTH senses** — how many effects and how long. A row count
  bounds neither, and the drain runs inside a tick that also reads pull requests,
  publishes verdicts and raises alerts. The budget covers recovery too: a
  whole-pass bound that excludes part of the pass is not one.
- **A delivery is bounded by the SMALLER of its lease and the pass's remainder.**
  The lease protects the row from a second drainer; the pass protects the tick from
  this one; neither implies the other.
- **The subprocess timeout is what actually closes the lease race**, because the
  handler chain is synchronous. A promise race cannot create its timer while a
  synchronous call is in flight.
- **It never leases a kind it cannot perform, and says how many wait.** A stuck
  queue and an idle one look identical otherwise.
- **Delivery is at-most-once.** The unique key stops a double enqueue and the fence
  stops two drainers settling over each other; neither closes the window where the
  comment posts and the drainer dies before recording it. So the key travels into
  the comment as an invisible marker, filtered at the source, with the AUTHOR
  checked — the key is built from public values, so without that a contributor
  could post the marker and the retry would settle done having never asked.
- **Every failed read falls THROUGH and posts.** A timeout, a truncated buffer and
  a rate limit all look exactly like "no marker found".
- **A reconciliation pass may confirm a delivery, never make one.** Recovery grants
  one lease past the budget so the marker check can find a delivery whose settle
  was lost to a crash; if it finds nothing, posting would deliver on an attempt the
  budget already refused.
- **Reconciliation is against the desired SET, not one key.** Doing it while
  creating a replacement meant it never ran when the desired set was empty — a
  reviewer removed from the profile would still be summoned.

### 3.4 The gates, and why there are two

`--execute` is "may reeve act at all". `watch.reviewActions` is "may it act on
review threads". **Both are required to queue an effect AND to deliver one.**

Gating only production is not enough: a queue outlives the run that made it, so
producing while disarmed moves the acting to whichever run drains it next. Gating
only delivery is not enough either: turning the review switch off would stop new
requests and leave the queued ones to post. The halt marker is rechecked at the
moment of acting, because backup and the self-audit run between the last
per-pull-request check and the end-of-tick drain.

The dead-letter escalation sits OUTSIDE both gates. A terminal row is a fact about
the store, not about whether this run may act, and an observational run is the one
most likely to have a person reading it.

### 3.5 The residual, stated rather than papered over

If a reviewer reviews **without being asked**, the queued request for that head is
not retired and will be posted. Closing it means asking "has this reviewer already
reviewed here?" at delivery, which reeve knows from its own review ingest but the
drainer does not read. Narrower than what has been fixed, and real.

The capability test over `src/outbox/effects.mjs` is a source-level allowlist, not
a runtime boundary. `globalThis["fet" + "ch"]` defeats it and no static walk will
see that. Closing it properly needs a permission model for handlers.

---

## 4. What was learned the expensive way

These cost hours. They are the reason to read this file rather than re-derive it.

- **A fixture that cannot exhibit the defect passes for the wrong reason.** Found
  repeatedly: a whitespace case with the space in the middle; a "declared but
  unchanged" case using a file that did not exist; a lease-race test using an async
  handler when the production path is synchronous; three test blocks sharing a
  database, so the row the block was named for was never the row leased.
- **After writing a test, stub the fix back OUT and confirm it goes red** — and
  **read the exit code, not just the lines.** A stub that makes a file crash prints
  no `FAIL` line at all, so a grep-based loop reads it as "the property is
  untested".
- **A guard that lives in the caller is not a guard.** `enqueue` requires its own
  transaction; `supersedeEffects` was written afterwards without one. A rule
  applied at one of two sites is a near miss that has already happened.
- **The third instance of a shape is evidence about the DESIGN.** Four staging
  defects in four rounds became one design change and every exclusion rule
  disappeared. A denylist widened three times should have been an allowlist.
- **Never read ABSENCE as success.** Read a positive signal that the check RAN.
- **Assert the property, not the wording** — but do not delete an assertion as
  redundant without checking what it actually covered. Naming two withheld tools
  says nothing about shell-level network access.
- **A mechanism's LIMIT does not travel with its behaviour**, and a reserve must
  be taken from the quantity being spent. A floor derived from the lease was 50s of
  a 60s budget.
- **Measure the platform, do not assume it.** `execFileSync` rejects a fractional
  timeout outright; `timeout: 0` bounds nothing; ENOBUFS and ETIMEDOUT differ only
  in `code`, both setting `signal: SIGTERM` with `killed` undefined.
- **A review can land AFTER the state reads clean.** Measured nine times across two
  sessions. §0 records the founder's rule for what to do about it.
- **Verify a merge by CONTENT, not SHA ancestry.** A squash merge breaks ancestry.
- **`gh`'s `headRefOid` is the MERGED head**; a review comment's
  `original_commit_id` is what a finding actually looked at; a CLEAN pass is an
  ISSUE comment with no review object and no commit field, so only the body's
  "Reviewed commit:" line dates it. Reading one endpoint answers the wrong
  question.

---

## 5. How the work is actually done

- **One heredoc per shell invocation.** Two in one call mis-parsed and silently
  restored a file before the tests ran, producing a wrong "the stub did not bite".
- **Assert on every text patch.** Every edit is a python replace with
  `assert t.count(old) == 1` before writing, so a missed anchor aborts rather than
  half-applying.
- **Small PRs.** The repository's own measurement: crossing ~10 changed files
  roughly triples the review rounds. Both halves of PR 2 are under it.
- **Reply to AND resolve every thread via GraphQL** — replying alone does not clear
  it — then comment `@codex review` to request the next round.
- **A 15-minute watcher** on open PRs, at
  `<scratchpad>/watch-prs.sh`. It emits a heartbeat every eighth tick, keeps the
  last good reading when a probe fails, alarms after two blind ticks, and only a
  positively-read closed state stops it. An earlier version treated an API blip as
  "the PR closed" and exited with a line that looked like a clean stop.

---

## 6. Unfinished work, and what each piece needs

**The last two PRs of the durable-effect programme.** §3.2 has the plan and §0
says where it has got to. The fourth is what makes `FIX_FINDINGS` able to act on a
review finding rather than merely notice one — it reads `e.threadDetails`, which
is written by nothing.

**Bring `docs/TRACKER.md` up to date.** §0 says how current it is. What is owed:
the PR split and why, the two halves, and this session's findings.

**R-01, the merge authority.** doctor reports it broken on `nextlyhq/nextly`:
admins exempt from every rule, an org-admin bypass with mode `always`, and the
ruleset carries **no required status check at all**. Instructions were written and
sent to the founder on 2026-08-24; they need the founder's account, about fifteen
minutes. It blocks the fourth capability in §2, which has nowhere to stand without
a required check — see §0 for where that capability sits.

**R-03, the merge shape.** doctor reports the repository declares squash while 8
of the last 20 commits on `main` are merge commits. Not investigated. A gate
written against a false premise passes for the wrong reason.

**The wrong-worker experiment could be re-run.** It published correctly on
2026-08-24 — 61s, $0.42, 16 turns, 0 denials — against a toy fixture. The harness
is `<scratchpad>/wrong-worker/{build-fixture.sh,run.mjs}`. It has never been run
against a real repository.

**Also open:** ntfy read user (needs shell on 95.217.11.127); second project
(`rextaihq/rext-backend`).

---

## 7. The builder programme, and the peer session

S2 is a **peer session's lane**, held by a session that has been renamed at least
once — ask over `SendMessage` rather than going by any name written here, and see
§0 for what of theirs is open. Do not take builder work without checking with
them first.

Territory, agreed explicitly and worth re-confirming rather than assuming:

| lane | files |
|---|---|
| this one | `src/daemon.mjs`, `src/db/ops.mjs`, `src/outbox/**`, `src/github/app.mjs`, `src/prompts.mjs` |
| the peer's | `src/build/**`, `bin/reeve`, `test/hub-*` |

**S2-C will edit `src/daemon.mjs` in 42 places.** The peer has undertaken to say so
before starting. That one genuinely overlaps and is not something to resolve at
merge time.

Cross-session work has repeatedly been worth the time rather than merely avoiding
collisions: the peer found a defect in an outbox repair, corrected a false
deadline, supplied the import-graph idea that found a live gap here within ten
minutes, and the exit-code lesson that found a load-bearing test of mine reading
false. Verify what they claim against the code before acting on it — doing so
changed the answer twice — and concede plainly when they are right.

---

## 8. Strategy — what this is all for

The goal is a control plane that can be trusted to act on a real repository
without a person watching each action. Everything above is in service of one
question: **can reeve be armed and left alone?**

The order that follows from that:

1. **The durable-effect programme finished** (§3), because it is what makes reeve
   able to close a loop rather than only report on one.
2. **A real dispatch on a real repository**, because the publish path is carried by
   tests and one toy fixture. In this project a dispatch once found what roughly
   640 green tests missed.
3. **R-01**, because refusing an unsafe merge means standing as a required status
   check, and a ruleset with no required checks has nowhere to stand.
4. **The merge-refusal capability** (§2, fourth row), after a shadow week.

Re-arming is the founder's decision at every step, and §0 records that the current
setting is deliberate.
