# Session handoff — 2026-08-29

Supersedes `docs/2026-08-28-session-handoff.md` for anything they disagree on.
That document's §1 to §5 still describe what reeve IS and how the work is done;
this one carries the state, the decisions taken since, and what is left.

---

## 0. STATE — MEASURE first, then read what only a person can tell you

The rule from the previous handoff holds and has now been paid for twice more:
**a fact a command can answer should not be written down at all.** Writing it
down does not make it available, it makes a second copy that ages, and the copy
is the one people read.

The second payment was mine, this session. I measured a repository's default
branch as failing every recent run, recommended a task on the strength of it, and
six hours later it had been green for most of the day. Nobody had lied; the
reading had simply expired. See §7.

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
gh pr list --repo revnix/reeve --state open --limit 100 --json number,headRefName,author \
   -q '.[] | "#\(.number) \(.author.login) \(.headRefName)"'
gh issue list --repo revnix/reeve --state open --limit 100 --json number,title -q '.[] | "#\(.number) \(.title)"'

# Is reeve ARMED? Read the PROCESS, never the plist: `launchctl kickstart`
# replays launchd's cached copy, so the file and the process can disagree.
ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"

# The two profile switches that decide whether the review half does anything.
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.reeve/profiles/nextlyhq/nextly.json'))); \
print('reviewActions:', d['watch'].get('reviewActions')); \
[print(' ', r['login'], r['kind'], repr(r.get('bodyFindings','ABSENT'))) for r in d['reviewers']]"

# A SPAWN, not a prepared contract. `worker_run.pid` is written from the spawn
# callback, so it is the witness that a worker actually ran.
sqlite3 -readonly ~/.reeve/state/nextlyhq/nextly.db \
  'select (select count(*) from run) as prepared,
          (select count(*) from worker_run where pid is not null) as spawned'

# The outbox occupancy. It licenses a schema rebuild and it EXPIRES the moment
# reeve delivers anything; see §4.
for f in ~/.reeve/state/*/*.db; do echo "$f -> $(sqlite3 -readonly "$f" 'select count(*) from outbox')"; done

./bin/reeve doctor nextlyhq/nextly --as-app           # what is broken today
grep "shadow:" ~/.reeve/reeve.log | tail -1           # the review shadow streak

# MERGE AUTHORITY, both layers. They are separate mechanisms over one branch and
# changing either says nothing about the other.
gh api repos/nextlyhq/nextly/branches/main/protection \
  -q '"enforce_admins: \(.enforce_admins.enabled)", "required: \(.required_status_checks.contexts)"'
gh api repos/nextlyhq/nextly/rulesets/16172495 \
  -q '("rules: " + ([.rules[].type]|join(", "))), (.bypass_actors[]|"bypass: \(.actor_type) \(.bypass_mode)")'

# IS CI ALIVE? A run's CONCLUSION cannot answer this: a job whose runner never
# started reports failure with ZERO steps. Count steps.
for id in $(gh run list --repo revnix/reeve --limit 3 --json databaseId -q '.[].databaseId'); do
  gh api "repos/revnix/reeve/actions/runs/$id/jobs" \
    -q "\"run $id: \" + ([.jobs[] | \"\(.name) \(.conclusion) steps=\(.steps|length)\"] | join(\" | \"))"
done

# Did a merge carry everything? `verify-merge.mjs` answers about the SQUASH
# COMMIT, which is not the same question as "did my last push land"; see §7.
node scripts/verify-merge.mjs <pr>
node scripts/stub-sweep.mjs                           # every stub still caught?
```

If any of that disagrees with any prose in this repository, the command wins and
the prose is stale. That includes this section.

### 0.2 Facts no command answers — the ones that need a person

| | |
|---|---|
| `--execute` is OFF **on purpose** | disarmed 2026-08-23 after a P0; re-arming is the founder's call, not a resumed session's |
| the review switch is **ON** | `watch.reviewActions` enabled 2026-08-27 with a profile declaring how each reviewer's bodies carry findings, derived from 694 stored review bodies |
| the durable-effect stages | **all four have landed**, stage 3 on 2026-08-30. §3 describes what it does |
| the repository is **PUBLIC** | made public 2026-08-27 to restore Actions minutes, exposure audited and accepted first |
| codex is a **blocking** reviewer | changed 2026-08-26 |
| the docs guard's review status | **out of the review rotation** since 2026-08-26. It stays in CI |
| the founder's merge rule | merge on CI green AND zero open threads, and **each merge needs its own grant** — a grant does not carry to the next pull request, and it does not override the rule |
| the R-01 merge authority | **PARTLY done.** The ruleset layer holds a required-checks rule and a narrowed admin bypass. `enforce_admins` was enabled 2026-08-29 and DISABLED again the same day on the founder's instruction, so the admin identity is exempt and the gate is decorative again by design. §5 has what is applied and what reversing it costs |
| the R-03 merge shape | **undecided.** The enquiry was done 2026-08-22 |
| the second project | `rextaihq/rext-backend` — **not started** |
| the ntfy read user | **not created.** Needs shell on the founder's server |
| what a real dispatch has proven | **nothing under the current contract.** The 2026-08-24 proof was a toy fixture |
| the CI cost decision | **open, and it is the founder's.** §6 has three options and a recommendation |
| the shadow agreement streak | **RESET on 2026-08-29** by a real divergence, from four days to zero. §9 has the diagnosis and why it is not merely a bug |
| the projection's deletion gap | **diagnosed, NOT fixed.** §9. It is new work in this lane and needs the founder's go-ahead before it starts |
| the peer session's lane | issue #50, the provider/hub session extraction. PR-0 merged; PR-1 in flight. They have committed to saying the moment it lands or is dropped |

**Change them HERE and nowhere else**; elsewhere, write "see §0". That is enforced
rather than intended by `test/docs-state-is-single-sourced.test.mjs` and
`test/zero-agrees-with-the-code.test.mjs`.

---

## 1. What landed this session

Four pull requests merged, in this order, each verified on the default branch by content (§0).

**#61 — the dependency edge.** An outbox row may name another row it waits for.
The drainer holds it back until that row has delivered, then substitutes the
parent's result into the child's arguments. This exists because `idem_key` is
fixed at enqueue time — that is what makes a double enqueue impossible — while a
spill's replies must name an issue number that does not exist until the create
has delivered. A compound handler would put both writes under one key and one
retry budget, so re-running after a successful create and a failed reply would
file a second issue.

**#63 and #67 — the stub sweep.** `scripts/stub-sweep.mjs` over
`src/stubsweep.mjs`, with `test/stub-manifest.mjs` and a REQUIRED `Stub sweep` CI
job. It breaks the code on purpose and requires the tests to notice. §2 is about
why it exists and what it deliberately does not do.

**#65 — the spill handlers.** `gh.issue.create` and `gh.thread.resolve` as
effects reeve performs itself, with the `kind` CHECK widened through a table
rebuild that carries rows across rather than refusing.

Plus the merge-authority work in §5, and a docs commit recording it.

**Since then, on 2026-08-29:** three further review rounds on the sweep pull
request, which is still open (§0). §10 says exactly where it stands and what a
resumed session should do with it.

---

## 2. The stub sweep, and the boundary it declares

### 2.1 Why it exists

A green suite proves the code passes the tests. It does not prove the tests could
ever have failed, and those are different claims.

Three assertions in #61 proved a mechanism existed without proving it was
REACHED — a count asserted where the right and wrong readings are both zero, a
deadline bound whose CALLER never passed a deadline, and a guard whose fixture
filtered the row out before the guarded line ran. All three were green, plausible
and worthless. All three were caught by stubbing the fix back out and reading the
exit code; none by writing the test, reading it back, or review.

The instrument that caught them existed only as a habit. On one run
`git checkout -- src/` restored to the last COMMIT and destroyed the uncommitted
fixes it was about to measure. **A verification step that depends on remembering
is the fallible read**, and the third instance of a shape is evidence about the
design.

### 2.2 What it refuses to do, and what each refusal cost

- **A dirty working tree.** A sweep restores between entries and cannot tell your
  work from a stub.
- **`git checkout` as the restore.** It restores to the last commit, which is a
  different tree from the one it was handed. Every target is snapshotted to a byte
  copy first.
- **A shell string to build the edit.** A harness that interpolates through a
  shell can report a quoting accident as a finding.
- **A confirmation grep.** A stub is proven to have landed by a HASH CHANGE.
- **An anchor that does not match exactly once**, counting OVERLAPPING
  occurrences — advancing past a match by its own length made `"aaa"` contain one
  `"aa"`.
- **An edit outside the repository or inside `.git`.** Checked by real path:
  `join(ROOT, file)` escapes on `..`, an in-repo symlink escapes without one, and
  changes under `.git` are invisible to `git status` so a failed restore there
  would corrupt the repository silently.

### 2.3 Four verdicts, only one of which passes

`expectRed` names the ASSERTION, not the file. A file-level expectation is
satisfied by any failure in that file.

| verdict | meaning |
|---|---|
| `CAUGHT` | the named assertion failed — the only passing outcome |
| `NOT_CAUGHT` | green with the defect back in: either nothing asserts it, or something does and its FIXTURE cannot reach the mechanism |
| `WRONG_RED` | something failed, but not the named assertion |
| `CRASHED` | the test died without reporting an assertion |

A run killed for exceeding its time limit is `UNRUNNABLE` even when its partial
output matches, because the run never completed.

### 2.4 What it does NOT do, stated because an unstated gap reads as covered

**It does not supervise what a test spawns.** It ends a test it is still holding,
on a signal or a timeout, so the tree is never left stubbed. A worker started by
a test that then exits NORMALLY survives, and cannot reliably be stopped. Three
measurements, in order:

- after the child exits, `process.kill(-pgid)` returns ESRCH and
  `pgrep -g <pgid>` finds nothing — the group is gone with its leader;
- sampling `pgrep -P` WHILE the child lives DOES return the worker's real pid,
  matching the pid the worker reports for itself;
- and `process.kill(<that pid>, "SIGKILL")` then returns ESRCH anyway, while that
  process is demonstrably alive and writes seconds later.

The third is unexplained. A sampling loop was written and REMOVED: it cost a
`pgrep` every 50ms of every test run — thousands of process spawns per sweep,
paid in CI on every push — to deliver a property it could not keep. Applying a
stub, reading a verdict and restoring the tree is the tool's job; process
supervision belongs to whoever wrote the test, or to a sandbox.

**Two things carry a written limit rather than an assertion**: that one, and the
byte budget on retained assertion lines, which prevents an out-of-memory rather
than a wrong reading — with it and without it the verdict is identical, so a stub
of it is correctly `NOT_CAUGHT`. The manifest says why it has no entry, so nobody
adds one and then bends a test to suit it.

**And it cannot catch a wrong EXPECTATION.** Stubbing the code cannot reveal an
assertion that asserts something false. That happened five times this session;
§7 has the shape.

### 2.5 Platform

`KILL_STRATEGY` is explicit and fails closed: `taskkill /T /F` on win32,
process-group plus a descendant sweep on darwin and linux, and **null everywhere
else, which refuses at start-up** rather than running with no way to stop what it
spawns. `process.kill(-pid)` is not the mechanism on Windows at all and `pgrep`
is absent there. The manifest is imported through `pathToFileURL`, because
`resolve()` yields `C:\repo\...` and `import()` reads `c:` as an unsupported
scheme — a fix for a platform the tool could not otherwise reach.

---

## 3. Stage 3 — what SPILL now does

Landed 2026-08-30; see §0 for the state of all four stages.

When a pull request reaches its review-round cap with non-critical findings
unresolved, the daemon's `decision.action === "SPILL"` branch enqueues, in the decision's
own transaction:

- one `gh.issue.create` carrying every finding, with a permalink PINNED to the head
  so it still resolves after the parent merges;
- one `gh.pr.comment` per THREADED finding, each depending on the issue and naming
  its number through a `${dep.number}` token resolved at delivery;
- and one `gh.thread.resolve` per threaded finding.

A finding stated in a review body has no thread: it is carried into the issue and
given no reply and no resolve, because replying to it would be a comment posted at
nothing.

**Why two rows and not one compound handler.** `idem_key` is fixed at enqueue time,
which is what makes a double enqueue impossible, while a reply must name an issue
number that does not exist until the create has delivered. One handler would put
both writes under one key and one retry budget, so re-running after a successful
create and a failed reply would file a SECOND issue.

**The prerequisite that was not in the original plan.** `enqueue` returns null when
the key is already held, so on any re-run the parent's row id was unavailable and the
edge could not be rebuilt — and a child written with no `depends_on` drains at once,
finds no parent for its token, and is refused. Nothing visibly breaks and the spill
never happens. `outboxIdFor` and `enqueueWithDependants` close that.

**The witness** `test/zero-agrees-with-the-code.test.mjs` looks for is the daemon
CALLING the producer, not an effect declaration: the declarations moved into
`src/outbox/spill.mjs`, and pointing the witness at that module would let a module
written ahead of the wiring satisfy it.

---

## 4. The measurement that expires

Both live stores held ZERO outbox rows, which is what let #65 rebuild the table
rather than refuse. **That stops being true the moment reeve delivers anything**,
because `settleOutbox` marks a delivered effect `done` and never deletes it.

That was not a hypothetical. The first version of #65 refused a populated outbox
and told the operator to drain the queue — advice that can never be satisfied,
because `done` rows persist. Any armed deployment would have been unable to open
its database again, permanently. Rows are carried across now, and an interrupted
rebuild is recovered on the next open rather than discarded.

Re-measure it (§0.1) before relying on it again.

---

## 5. Merge authority — what was applied, and how to undo it

Applied 2026-08-29 with the founder's approval, both layers, verified by reading
back rather than by trusting the write.

**The ruleset** on `nextlyhq/nextly`'s default branch — its id is in §0.1's command — gained a
`required_status_checks` rule, and its `OrganizationAdmin` bypass was narrowed
from `always` to `pull_request`.

**Branch protection** gained `enforce_admins`, and then had it removed again the
same day on the founder's instruction (§0). That switch is the whole of the
admin exemption: on means no exemption, off means the admin identity is exempt.
There is no third position — "enforced but I am exempt" IS the off state.

**Why that required check and not a better one.** The substantive jobs are
PATH-CONDITIONAL — a pull request touching nothing they watch runs neither — so
requiring one would block a pull request that legitimately does not run it.
`Decide what this commit can affect` was already branch protection's required
context, which makes it proven workable rather than merely plausible, and it was
measured on 12 of the last 12 pull requests before enforcing.

**What it costs the founder**, measured rather than asserted: required reviews
are off, `strict` is off, there is no push allowlist. So the practical loss is
pushing directly to the default branch, and merging a pull request whose one
check is red or absent.

**To revert**, DELETE the same `enforce_admins` endpoint §0.1's command reads.
The pre-change protection JSON is not in the repository; re-derive it from this
section. Reverting puts R-01 (§0) back where it was — the gate reported as
decorative — which is the state reeve's fourth capability cannot stand in.

---

## 6. Unfinished work, and what each piece needs

**Stage 3 part three** (§3). Held on the peer, not blocked on anything else.

**The CI cost decision, and it is the founder's.** A full sweep is several
minutes; the signal and process-tree cases cost about twenty seconds each, and CI
pays it on every push. Three options:

1. **Leave it.** Honest, and the cost is real — reeve exhausted its Actions
   minutes once already this month.
2. **Tier by cost**: cheap entries every push, expensive ones on merge. Rejected
   as the recommendation, because it changes what a green `Stub sweep` MEANS —
   "the cheap ones are caught and the expensive ones were caught at some earlier
   merge" is a weaker claim wearing the same badge. And the two expensive cases
   guard the failure where the tree looks correct afterwards, which is exactly
   when you want them on the change that introduces the risk.
3. **Gate by what each entry GUARDS** — recommended, and it is the peer's
   proposal rather than mine. The expensive cases test the runner's own
   machinery; only a change to the runner can break them. So run them when the
   diff touches the runner, and always on merge. The honest cost: a path filter
   is a rule at N sites, so each manifest entry should DECLARE the paths that
   make it relevant, beside its anchor and expected-red, rather than the workflow
   carrying a second list that drifts.

**R-05 and R-08 tidying** (§0). One declared reviewer silent across twenty pull
requests; codex's P0 marker never fired across thousands of classified findings.
Either it files no P0s or the pattern is wrong and every P0 landed as `unknown`.
`unknown` blocks, so nothing unsafe has happened; which is true is not known.
Cheap, measurable, and in this lane.

**Eleven documents claim this repository is private.** True when written, not now
(§0).

**Two pagination mechanisms** — `gh api --paginate` on live reads and a
hand-rolled twenty-page reader in ingest. Recorded rather than reconciled.

---

## 7. The shapes this session paid for

All four are one family: **a check answers a NARROWER question than the caller
reads it as, and the green is indistinguishable either way.** Carry these; do not
re-derive them.

**A measurement expires.** I measured a repository's default branch failing 10 of
10 runs, recommended a task on it, and six hours later it had been green most of
the day. Nothing lied. A reading with no timestamp attached to its USE is an
inherited fact by the time you act on it. Re-measure immediately before acting,
not at the start of the session.

**A clean verdict is persuasive enough that a caveat beside it reads as
decoration.** On 2026-08-29 the merge verifier (§0) gave #63 a clean verdict, and was correct:
it compares the default branch against the SQUASH COMMIT, and it printed a SCOPE
line saying it does not establish that the merge covers the whole pull request. Six fixes pushed after the merged head never landed. What caught it
was a COUNT — the sweep reported 14/14 where the branch reported 20/20 — not the
tool, not review, and not careful reading. The peer has since changed the
tool to print the verified head beside the branch's live head.

**Never discard the output of the thing whose failure you are diagnosing.** A
harness of mine spawned the process under test with `stdio: "ignore"`, so when it
failed the one process that knew was writing to `/dev/null` and the block reported
`(no output captured)`. Three debugging rounds went to a cause that was never in
the code under test. reeve already has this on record: `session-health.sh`
discards a diagnostic and then INVENTS one, which is why the OPS HEALTH banner
lies. A channel closed for tidiness, and a confident wrong answer arriving in the
gap.

**Guard constants belong at the top of the file.** Both use-before-declaration
bugs shipped this session went into GUARDS — a pass deadline read above its own
`const`, and a `KILL_STRATEGY` guard at line 74 whose constant was at line 183. A
guard goes in at the top and its constant beside the implementation further down,
so the ordering is wrong BY DEFAULT. `node --check` cannot see a temporal dead
zone, because the file parses.

**And the one the sweep cannot catch.** Five times this session a test of mine
passed for a reason other than the one it named — a matcher using exact-element
equality for a substring; a fixture ending in `process.exit`, which does not flush
stdout, so the flood it existed to produce never happened; a marker path nested
through `JSON.stringify` twice; an assertion that "helper-ran never appears" when
the control run's helper legitimately completes; and a fixture that littered on
BOTH runs so the pre-check caught it and the block passed on a verdict it does not
name. Stubbing the code cannot reveal a wrong expectation. Only running the
fixture and reading what it actually produced can.

**A corollary worth its own line:** when two defences are redundant BY DESIGN,
removing either alone changes nothing observable and the stub reads `NOT_CAUGHT`
correctly. The honest stub is a COMPOUND one that removes both.

---

## 8. Strategy, and what matters next

reeve exists so that watching, judging and repairing a repository does not need a
person in the loop for the ordinary cases. The ordering is about what makes the
next capability trustworthy.

1. **Stage 3 part three** (§3), which finishes capability 3 and closes the review
   half. Held on the peer.
2. **A real dispatch on a real repository** — see §0 for what has actually been
   proven. In this project a dispatch once found what roughly 640 green tests
   missed. It needs arming, which is the founder's call.
3. **The merge-refusal capability**, after a shadow week. It can only stand as a
   required status check that the actuator cannot bypass, so R-01's remaining
   switch (§0) gates it. Do not build it while that switch is off; raise it with
   the founder first.
4. **The tidying** (§6), which is cheap and can batch.

**A stop line is worth naming.** This kind of tooling expands for ever if allowed
to. Capability 3 finished plus one proven real dispatch is a defensible definition
of done; after that the guardian should go into maintenance and be touched when it
fails, not when something could be better.

**One caution about the evidence.** The move from shadow to enforcing is meant to
rest on the agreement streak reeve records itself (§0). It measures the projection
against a live read, and it should not be read as proving the review surface
agrees — §9 is what happens when it disagrees, and why that is the instrument
working rather than failing.

---

## 9. The shadow divergence — diagnosed, not fixed

The agreement streak reset (§0). This is what happened and why it matters more
than one wrong number.

### 9.1 What the daemon recorded

```
#1325: SHADOW DIVERGENCE — thread count differs: live 25, derived 26;
                           resolved differs: live 18, derived 19
```

One extra thread in the projection, and that extra one counted as resolved.

### 9.2 The cause, established by reading the code rather than guessing

`derivePr` builds its view from EVERY `external_id` ever recorded in `inbox` for
that pull request. `inbox_current` records which GENERATION an object is on — the
Git blobs-and-refs split described in the 2026-08-28 handoff §4 — but there is no
way to record that an object **no longer exists**.

So when a thread disappears from GitHub, which a deleted review comment does, the
projection keeps it for ever. Its last stored payload said `is_resolved: true`, so
it is counted in `total` AND in `resolved`. That is exactly the shape observed:
one extra, and resolved.

`src/review/shadow.mjs` is correct, and its own comment predicted this: *"a
mismatch means ingest lost one or invented one."* It invented one.

### 9.3 Why the fix is not a small patch

`observe()` already computes completeness — `readable: total !== null && seen >=
total`. An absent object may only be treated as deleted when the read was
COMPLETE. In a truncated read, absence is not deletion, and acting on it would
erase live threads from the projection.

That is the never-read-absence rule with unusually high stakes: get it wrong and
the projection silently drops threads that gate a merge. The shape to build is a
presence marker on `inbox_current`, written only for a readable observation, with
`derivePr` excluding absent rows — the append-only `inbox` untouched.

### 9.4 Why it was not started

Three reasons, all of which a resumed session should weigh again rather than
inherit:

- it is new work rather than a review round, and the founder's priority order puts
  open pull requests first;
- the failure mode of a wrong fix is severe, so it wants the full stub-sweep
  treatment rather than a quick patch;
- and **it is not urgent**: reeve is unarmed (§0), so nothing acts on the
  projection today. What it blocks is ARMING — §8's item 2 and 3 both rest on the
  streak being trustworthy evidence, and it is not while this stands.

Fixing it does not restore the streak. It starts a fresh one from a correct
baseline, which is the honest outcome and worth saying out loud before anyone
reads a short streak as a regression.

---

## 10. The sweep pull request, and what a resumed session should do with it

It is open (§0), it is this lane's, and its branch lives in the worktree
`~/Work/Products/reeve-wt/sweep`. Authorship cannot identify it — every pull
request is pushed as the founder — so identify it by the FILES it touches:
`scripts/stub-sweep.mjs`, `src/stubsweep.mjs`, `test/stub-manifest.mjs`,
`test/stubsweep.test.mjs`. The peer session has committed to staying out of all
four.

### 10.1 Why it exists at all

An earlier sweep pull request merged at a head its branch had already moved past,
so six fixes were answered on the pull request and never landed. This one carries
them plus everything since. It takes the manifest from fourteen entries back to
twenty-seven.

### 10.2 What round three fixed

Four findings, three of them P1:

- **The real git directory is resolved, not assumed.** `.git` is a 63-byte POINTER
  FILE in a worktree or a separate-git-dir repository — measured on this machine —
  so a hard-coded `<root>/.git` guards a pointer while the metadata sits
  elsewhere. Resolved through `git rev-parse --absolute-git-dir`, and the literal
  pointer is refused too, because rewriting it redirects the repository.
- **A line forged by INTERLEAVING can no longer be classified.** The raw capture is
  two streams as they arrived, so stdout writing `FAIL  wrong assertion` unterminated
  and stderr writing ` the guard holds\n` concatenates into an assertion neither
  stream emitted. Every raw line is indented, so none of them can match the
  protocol's anchor; only the per-stream reconstruction is classifiable.
- **Ignored artifacts are fingerprinted by content**, not listed by path, because a
  control run overwriting an existing ignored cache leaves every path reading
  identical. Files are hashed; DIRECTORIES are not, and that limit is stated in the
  source rather than hidden — an artifact created inside an already-ignored
  directory is not detected.
- **The named assertion is reserved outside the retention budget**, so twenty
  thousand unrelated failures before it cannot crowd it out and make the entry read
  `WRONG_RED` for a stub it did catch.

### 10.3 The part worth reading before touching it

**All four fixes were initially UNVERIFIED.** Every stub left the suite green. The
fixes were written, reviewed by eye, and proved nothing — the sweep caught it only
because it was run before pushing.

Then TWO of the four tests written to close that gap could not exhibit their
defect either:

- the separate-git-dir fixture wrote its manifest AFTER committing, so the runner
  refused for a DIRTY TREE rather than for git metadata. Both refusals exit 2, so
  the first assertion passed on entirely the wrong cause; only a second assertion
  on WHY it refused caught it;
- and the forged-line fixture's two stdout writes coalesced into one data event
  before stderr's arrived, so no interleaving ever reached the parent. Pauses
  between the writes were needed to make the condition happen at all.

All four are now caught, each against a tree that can genuinely exhibit its defect,
and all four are in the manifest.

### 10.4 The rule that fell out of it

**When several causes share one observable outcome, assert the cause and not the
outcome.** Exit code 2 meant both "refused for git metadata" and "refused because
the tree was dirty". Nothing but a second assertion on the reason separated them.

That belongs with §7's family, and it is the sixth instance in this pull request
lineage. The pattern in WHERE they land is now unambiguous: it is almost always
the FIXTURE, not the assertion. The assertion states the right property; the tree
it runs against cannot produce the condition.
