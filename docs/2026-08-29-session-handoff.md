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
| the durable-effect stages | **1, 2 and 4 have landed. 3 has not.** Stage 3 is the PRODUCER, so the groundwork under it landing does not land the stage; §3 says what remains |
| the repository is **PUBLIC** | made public 2026-08-27 to restore Actions minutes, exposure audited and accepted first |
| codex is a **blocking** reviewer | changed 2026-08-26 |
| the docs guard's review status | **out of the review rotation** since 2026-08-26. It stays in CI |
| the founder's merge rule | merge on CI green AND zero open threads, and **each merge needs its own grant** — a grant does not carry to the next pull request, and it does not override the rule |
| the R-01 merge authority | **CLOSED 2026-08-29.** Both layers are set; §5 records what was applied, why, and how to revert |
| the R-03 merge shape | **undecided.** The enquiry was done 2026-08-22 |
| the second project | `rextaihq/rext-backend` — **not started** |
| the ntfy read user | **not created.** Needs shell on the founder's server |
| what a real dispatch has proven | **nothing under the current contract.** The 2026-08-24 proof was a toy fixture |
| the CI cost decision | **open, and it is the founder's.** §6 has three options and a recommendation |
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

## 3. Stage 3, and the one part that is left

Parts one and two have landed (§0). **Part three is the PRODUCER**: the daemon's
`decision.action === "SPILL"` branch, at roughly `src/daemon.mjs:2345`, currently
builds a worker prompt and escalates because SPILL is in `UNBUILT_ACTIONS`. It
must instead enqueue, in one transaction with the decision:

- a `gh.issue.create` effect;
- one `gh.pr.comment` per spilled thread, each depending on it and naming the
  issue number through a `${dep.number}` token;
- and a `gh.thread.resolve` per thread.

It is **written and HELD**, deliberately (§0). Rebasing a few lines inside one
`else if` onto a large restructure is far cheaper than the reverse. Do not start
it on silence; ask.

**The witness** `test/zero-agrees-with-the-code.test.mjs` looks for is
`kind: "gh.issue.create"` in `src/daemon.mjs` — the producer, not the handler, so
a handler added ahead of the wiring cannot make the tree claim a stage that has
not landed.

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

**Branch protection** gained `enforce_admins`.

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
3. **The merge-refusal capability**, after a shadow week. R-01 is now closed
   (§0), so it finally has somewhere to stand.
4. **The tidying** (§6), which is cheap and can batch.

**A stop line is worth naming.** This kind of tooling expands for ever if allowed
to. Capability 3 finished plus one proven real dispatch is a defensible definition
of done; after that the guardian should go into maintenance and be touched when it
fails, not when something could be better.

**One caution about the evidence.** The move from shadow to enforcing is meant to
rest on the shadow agreement streak reeve records itself. That streak measures the
projection against a live read, and it should not be read as proving the review
surface agrees.
