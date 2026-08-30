# Session handoff — 2026-08-30

Supersedes `docs/2026-08-29-session-handoff.md` for anything they disagree on.
Its §1-§5 still describe what reeve IS and how the work is done; the 2026-08-28
handoff's §1-§5 remain the deepest description of the architecture. This one
carries what changed on 2026-08-30, the decisions taken, and what is left.

---

## 0. STATE — MEASURE first, then read what only a person can tell you

**A fact a command can answer should not be written down.** Writing it down does
not make it available, it makes a second copy that ages, and the copy is the one
people read. This section is mostly COMMANDS for that reason.

### 0.1 Facts to MEASURE — never trust a file for these, this one included

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
cd ~/Work/Products/reeve && git fetch -q origin

git log --oneline -1 origin/main                     # what `main` is
git log --oneline -1 HEAD                            # the CHECKOUT; NOT what runs

# What the DAEMON runs, which is a different fact. A running process holds the
# modules it loaded at startup, so fast-forwarding the checkout moves the tree and
# not the process. The daemon writes this itself the moment it starts.
grep "daemon starting" ~/.reeve/reeve.log | tail -1

# --limit, because `gh pr list` fetches 30 by default and a silent truncation
# presents a partial list as the whole work queue.
gh pr list --repo revnix/reeve --state open --limit 100 --json number,headRefName,author \
   -q '.[] | "#\(.number) \(.author.login) \(.headRefName)"'
gh issue list --repo revnix/reeve --state open --limit 100 --json number,title -q '.[] | "#\(.number) \(.title)"'

# BRANCHES PUSHED BUT NOT YET OPENED. Two exist; a resumed session that only lists
# pull requests will not see them and may rebuild the work.
git ls-remote origin | grep -E 'spill-durable-effects|approval-bound-to-head'

# Is reeve ARMED? Read the PROCESS, never the plist: `launchctl kickstart` replays
# launchd's cached copy, so the file and the process can disagree.
ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"

./bin/reeve doctor nextlyhq/nextly --as-app           # what is broken today
grep "shadow:" ~/.reeve/reeve.log | tail -1           # the review shadow streak

# IS CI ALIVE? A run's CONCLUSION cannot answer this: a job whose runner never
# started reports failure with ZERO steps. Count steps.
for id in $(gh run list --repo revnix/reeve --branch main --limit 2 --json databaseId -q '.[].databaseId'); do
  gh api "repos/revnix/reeve/actions/runs/$id/jobs" \
    -q "\"run $id: \" + ([.jobs[] | \"\(.name) \(.conclusion // .status) steps=\(.steps|length)\"] | join(\" | \"))"
done

node scripts/verify-merge.mjs <pr>                    # did a merge carry everything
node scripts/premerge.mjs <pr>                        # SHOULD a merge happen — new today
node scripts/stub-sweep.mjs                           # every stub still caught?
```

If any of that disagrees with any prose in this repository, the command wins and
the prose is stale. That includes this section.

### 0.2 Facts no command answers — the ones that need a person

| | |
|---|---|
| `--execute` is OFF **on purpose** | disarmed 2026-08-23 after a P0; re-arming is the founder's call |
| the review switch is **ON** | `watch.reviewActions` enabled 2026-08-27 |
| the durable-effect stages | **1, 2 and 4 have landed. 3 was never merged and is ABANDONED, not deferred** — its pull request was closed on the founder's decision rather than left to resume; §5 says why, and what survived it |
| the repository is **PUBLIC** | made public 2026-08-27, exposure audited first |
| codex is a **blocking** reviewer | changed 2026-08-26 |
| the founder's merge rule | merge on CI green AND zero open threads, and **each merge needs its own grant** — a grant does not carry to the next pull request |
| the R-01 merge authority | **PARTLY done**; `enforce_admins` was enabled and DISABLED again on the founder's instruction, so the admin identity is exempt by design |
| the R-03 merge shape | **undecided** |
| the second project | `rextaihq/rext-backend` — **not started** |
| the ntfy read user | **not created** |
| what a real dispatch has proven | **nothing under the current contract** |
| the CI cost decision | **open, and it is the founder's**. §6 has three options and a recommendation |
| the peer session's lane | the builder lane: S3-A tasks, `src/build/**`, `src/profile/**`, docs generators. They have listed my ground back accurately and stayed off it all day |

**Change them HERE and nowhere else**; elsewhere write "see §0". Enforced by
`test/docs-state-is-single-sourced.test.mjs` and `test/zero-agrees-with-the-code.test.mjs`.

---

## 1. What landed on the default branch on 2026-08-30

**#78 — `displayPath` gets disjoint namespaces.** It claimed to be injective and
was not: an undecodable filename rendered as `<decoded> <bytes HASH>`, and a valid
filename can BE that text, so a swap left both the reported line and the
fingerprint identical. A name that survives a UTF-8 round trip is `u:<name>`; raw
bytes are `x:<hex>`. Two byte sequences cannot collide.

**#79 — the pre-merge gate.** `src/premerge.mjs` (pure judgement) and
`scripts/premerge.mjs` (the reads). §2 is about what it became and why.

**#84 — repairing three manifest entries #79 broke.** §4 is about how that
happened, because the cause matters more than the fix.

The peer landed #80, #81 and #82 in the same window.

---

## 2. The pre-merge gate, and the two redesigns it took

It exists because four merges went early in one day, each through a different
window: two at a head the branch had moved past, one with a review thread open,
one with CI still running. Every check reeve had answered AFTER the merge.

It asks four questions before the button: would the merge carry the branch tip,
is every review thread settled, has CI finished and passed, and does GitHub itself
consider this mergeable.

### 2.1 Four states, and it never rounds up

`REFUSE` beats `UNKNOWN` beats `UNREVIEWED` beats `CLEAR`, and every half is
always reported. `UNREVIEWED` is the state most likely to be argued away and is
the point: an empty thread list means both "reviewed and nothing raised" and
"nobody looked". `UNKNOWN` keeps a truncated page, an unreadable ref listing, an
unidentifiable fork head, unfinished checks and checks that never ran out of the
pass — each with a DIFFERENT reason, so a reader can tell them apart.

### 2.2 It was redesigned twice, and both times the answer was to stop competing with GitHub

Six review rounds produced 26 threads: 7, then 3, 3, 3, 4, 5. It never tapered,
and twice the reason was the same shape one layer apart.

**Round four: mergeability.** Every round found another input to "can this merge"
that had not been enumerated, because the question is unbounded and GitHub already
computes it. `mergeStateStatus` folds in branch protection, required reviews,
conflicts, draft state and being behind the base. Two computations of one
predicate, and the gate's was the one nobody would notice disagreeing.

**Round six: review presence.** Having delegated mergeability, the gate went on
re-deriving REVIEW state by hand from thread timestamps. Three findings killed it
at once: a review anchored to head A can be SUBMITTED after head B is pushed; an
author with write access can add and resolve their own inline comment; and
`pushedDate` is nullable, so the rule disabled itself exactly when it could not
tell — fail-open wearing the words of caution.

**The rule worth carrying:** when a review round finds another input to a question
you are answering, ask whether the platform already answers it. Delegating removes
an inventory; enumerating adds a round.

### 2.3 What it still gets wrong, and the branch that fixes it

`reviewDecision` is only head-bound where the repository dismisses stale
approvals, and most do not. An approval on head A survives an unreviewed head B.
The source said so in a comment and mapped `APPROVED` to `CLEAR` anyway.

**A caveat that documents a hole rather than closing it is worse than no caveat**,
because it reads as though the case was considered and handled. That is why it
survived six rounds.

`fix/approval-bound-to-head` (§5) binds the approval to the approving review's own
`commit.oid`, keeps the aggregate only as "was a review given at all", and makes
an unreadable approval `UNKNOWN` rather than clear.

---

## 3. Stage 3 — what SPILL now does

When a pull request reaches its review-round cap with non-critical findings
unresolved, the daemon's `decision.action === "SPILL"` branch enqueues, in the
decision's own transaction:

- one `gh.issue.create` carrying every finding, with a permalink PINNED to the
  head so it still resolves after the parent merges;
- one `gh.pr.comment` per THREADED finding, each depending on the issue and naming
  its number through a `${dep.number}` token resolved at delivery;
- and one `gh.thread.resolve` per threaded finding.

A finding stated in a review body has no thread: carried into the issue, given no
reply and no resolve, because replying to it would be a comment posted at nothing.

**Two rows, not one compound handler.** `idem_key` is fixed at enqueue time, which
is what makes a double enqueue impossible, while a reply must name a number that
does not exist until the create has delivered. One handler would put both writes
under one key and one retry budget, so re-running after a successful create and a
failed reply would file a SECOND issue.

**The prerequisite the plan did not have.** `enqueue` returns null when the key is
already held, so a re-run could not recover the parent's row id and the edge could
not be rebuilt. A child written with no `depends_on` drains at once, finds no
parent for its token, and is refused — nothing visibly breaks and the spill never
happens. `outboxIdFor` and `enqueueWithDependants` close it.

**Keyed on the findings fingerprint**: on the head it would file a fresh issue at
every push; on the pull request alone it would never file a second one after the
findings changed.

**The stage witness moved** from an effect declaration to the daemon CALLING the
producer. The declarations live in `src/outbox/spill.mjs` now, and pointing the
witness at that module would let a module written ahead of the wiring satisfy it.

---

## 4. How the default branch went red on 2026-08-30, and the rule that came out of it

On 2026-08-30 #79 merged with a failing `Stub sweep`. Three manifest entries named code the
review delegation had changed, and the delegation was pushed while the
verification was still running against the OLDER head. The check existed, ran, and
would have caught all three — the merge simply did not wait for it.

**Verify after the last push, not during.** A green that describes a superseded
commit is not a green.

The three failures were also three different lies a manifest entry can tell:
`UNRUNNABLE` (its anchor was deleted), `WRONG_RED` (it named a renamed assertion),
and `CRASHED` (it matched the first of two similar returns and truncated a
statement into a syntax error). All three read as "the sweep is broken" until
looked at.

---

## 5. Stage 3 was closed, and what survived it

**`feat/spill-durable-effects` is dead.** Do not resume it. The pull request was
closed on 2026-08-30 rather than worked, for two reasons that are about whether it
should exist rather than about how it was written.

It could not have worked. The producer read `f.thread_id` and `f.body`; the
projection at `src/review/derive.mjs` emits `id` and `excerpt`, so the thread filter
matched nothing and every issue line would have been blank. Six thousand passing
assertions did not catch it because the producer and its fixtures were written
together and shared one invented vocabulary. They agreed with each other. Neither
agreed with the projection. **The stub sweep cannot catch this class** — it proves
an assertion can fail when the code breaks, and these assertions could.

And it reopened a settled decision: §15a of the review-ingest design records SPILL
staying off indefinitely, because round counts measure how often bots re-reviewed a
push rather than whether reeve's fix loop is stuck. That reason still holds, so the
trigger is the wrong one and a correct producer would only deliver it more reliably.
**Do not rebuild SPILL without deciding the trigger first**, and decide it from
reeve's own shadow data rather than from the round counter.

What survived is `enqueueWithDependants` and `outboxIdFor`: enqueue an effect whose
value only an earlier effect's delivery can supply, and rebuild that edge rather
than a broken one on any re-run. Nothing about it is SPILL-specific.

**`fix/approval-bound-to-head`** — §2.3. It answers the review finding described
there; see §0. Was raised on 2026-08-30, still pushed and not yet opened.

---

## 6. Unfinished work, and what each piece needs

**The `.pathname` cleanup.** Ten uses across the repository, four in
`test/stubsweep.test.mjs`. `new URL(...).pathname` leaves a path percent-encoded,
so any checkout whose path contains a space breaks — and the failure is
indistinguishable from the staleness those assertions exist to detect, so whoever
hits it regenerates, sees no diff, and has no next move. `fileURLToPath()` is the
correct API. Found by the peer in their own file; mechanical, and wants its own
small change rather than widening something.

**The CI cost decision, and it is the founder's.** A full sweep is about eighteen
minutes and CI pays it on every push. Three options: leave it; tier by cost
(rejected — it changes what a green `Stub sweep` MEANS); or gate by what each
entry guards, which is the recommendation, with each manifest entry declaring the
paths that make it relevant rather than the workflow carrying a second list.

**R-05 and R-08**, measured 2026-08-29, and the answers differ from what was
assumed: see §0 for anything since: codex has filed no P0 at all in this store (52 findings, P1→critical,
P2→major, none unknown), and `greptile-apps` has exactly ONE round, on one pull
request, on 2026-08-18, which produced zero findings while claiming outcome
`findings`. Both want a decision from the founder rather than more measurement; see §0 for what is settled.

**The test clock in the live store.** `reviewer_supply.since` for `greptile-apps`
is the suite's `NOW` constant, dated five months ahead, as measured 2026-08-30 (see §0). One row,
one column, confirmed by scanning all 200 integer columns with a positive control.
Nothing reads `since` today, so it is latent. The recommendation is a guard that
rejects a future timestamp on write, then the correction.

**Issue #43** was offered to the peer and taken. **Issue #46** is unclaimed.

---

## 7. The shapes this session paid for

**A caveat that documents a hole is worse than none.** §2.3.

**Delegate rather than enumerate.** §2.2. When a review round finds another input
to a question you answer, ask whether the platform already answers it.

**A control proves a check does not fire wrongly; only a fixture that exhibits the
defect proves it fires at all.** Both are needed and neither substitutes. The
strongest form, learned from the peer: build the input where the NAIVE reader gets
it wrong, and assert that it does. Applied to the head binding and to the approval
binding, where the fixture makes the two readings DISAGREE — with them equal, both
pass and the test proves nothing.

**A guard that cannot be shown to fire should have no manifest entry.**
`enqueueWithDependants`'s refusal branch is unreachable by construction, its stub
read `NOT_CAUGHT`, and its fixture had been passing on SQLite's CHECK constraint
rather than on the guard. The entry was removed and the reason written into the
source. An entry that cannot go red for the right reason looks like coverage.

**Three instances mean stop remembering and change the mechanism.** Editing a
worktree while its own sweep ran corrupted three readings; the sweep restores files
between entries, so a concurrent edit is destroyed AND the reading is garbage.
Verification now runs on an ISOLATED COPY — a detached worktree at the branch's
committed HEAD — so the sweep runs somewhere nobody is typing. It also refuses when
the source worktree is dirty, because a green on the copy would describe the
committed tree rather than what you are looking at.

**A hole in an array is invisible to `forEach`, `map` and `filter`.** Two manifest
appends left `},` followed by a bare `,`, which is an elision rather than a syntax
error: `node --check` accepts it and the array carries an `undefined`. The check
written to find it used `forEach` and reported clean. It is an indexed loop now,
with a control proving the loop sees a hole that `forEach` skips.

**A host is not a hostname.** Four findings on one pull request on 2026-08-30, each
about the host travelling with the read and each in a different place: see §0 for that pull request's state: the API calls, the suggested
command, a flag that command does not accept (`gh pr merge` has no `--hostname`;
`-R` takes `[HOST/]OWNER/REPO`, verified against gh 2.96.0), and the port
(`URL.hostname` drops it).

**Enumerating the bad states is a deny-list on a value space you do not own.** A
legacy `StatusContext` reports progress in `state`, so `PENDING` was non-empty,
fell through, and cleared the gate. `SUCCESS` is named positively now.

**Deriving from a stale tree is indistinguishable from recalling.** A line number
was quoted to the peer as derived; it came from a checkout three commits behind.
Anchor on TEXT, not on line numbers.

---

## 8. Strategy — what matters next

The durable-effect programme is complete (§0). What it unlocks is arming, and
arming rests on the shadow projection being trustworthy evidence.

**The order I would take:**

1. **Open and land the two branches in §5**, one at a time so a red CI on one does
   not obscure the other. The approval fix closes the only unresolved thread in
   this lane.
2. **The `.pathname` cleanup** (§6). Small, mechanical, and it removes a failure
   whose symptom impersonates a different failure.
3. **The CI cost decision** (§6) — needs the founder, not code.
4. **Then arming**, which is the founder's call and rests on 1-3.

**What NOT to do:** do not merge `docs/s3-foundation` to pick up the S3-A plan.
Measured 2026-08-30: its tracker copy is about 8KB SMALLER than the default
branch's, so merging it reverts real tracker content (see §0 before acting on this).
