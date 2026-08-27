// The decision function must be TOTAL: every reachable verdict maps to exactly one
// action, and no state falls through to a silent WAIT.
import { nextAction, ACTIONS, ESCALATIONS } from "../src/watcher.mjs";
// DERIVED, never restated. The clause set lived in verdict.mjs and ten test
// files, three of which asserted TOTALITY over their own copy -- and a matrix
// claiming totality over a stale copy is how a clause ships with no branch while
// its test reports full coverage.
import { computeVerdict, CLAUSE_IDS } from "../src/verdict.mjs";

let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) { console.log(`        got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; } };

// reviewActions is ON here so these cases still exercise the underlying decision
// logic. It is OFF by default in production until review ingest exists, and that
// default is covered by test/review-gate.test.mjs rather than weakened here.
const P = { rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
            authority: { policy: "propose_and_merge" }, watch: { reviewActions: true } };
const cl = (id, state, detail = "") => ({ id, state, detail });
// The clause set, kept in step with the verdict's own by a check below rather
// than by memory. A hardcoded list here silently stopped reaching the mechanism
// the moment a clause was added: `swap("cleared", ...)` replaced nothing, the
// fixture stayed all-pass, and the test reported MERGE instead of failing.
// Was a hardcoded list here. It is `CLAUSE_IDS` now: one declaration,
// compared against what `computeVerdict` actually emits in both directions.
const CLAUSES = CLAUSE_IDS;
const ev = (clauses, extra = {}) => ({
  pr: 1, state: "open",
  verdict: { state: clauses.some(c => c.state === "BLOCK") ? "BLOCK" : clauses.some(c => c.state === "UNKNOWN") ? "UNKNOWN" : "PASS", clauses, summary: "x" },
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  checks: {}, ...extra,
});
const allPass = () => CLAUSE_IDS.map(id => cl(id, "PASS"));
const swap = (id, state, detail) => allPass().map(c => (c.id === id ? cl(id, state, detail) : c));

// ── terminal shapes ───────────────────────────────────────────────────────
check("a fully green PR merges", nextAction(ev(allPass()), P).action, ACTIONS.MERGE);
check("a merged PR parks", nextAction(ev(allPass(), { state: "merged" }), P).action, ACTIONS.PARK);
check("a closed PR parks", nextAction(ev(allPass(), { state: "closed" }), P).action, ACTIONS.PARK);

// Merge authority is a profile decision. A green verdict where reeve may only
// propose is a finished PR awaiting a maintainer, not a merge.
check("green on a propose-only repo parks",
  nextAction(ev(allPass()), { ...P, authority: { policy: "propose_only" } }).action, ACTIONS.PARK);
check("and marks itself awaiting a maintainer",
  nextAction(ev(allPass()), { ...P, authority: { policy: "propose_only" } }).awaitingMaintainer, true);

// ── escalations ───────────────────────────────────────────────────────────
check("a conflicted branch escalates",
  nextAction(ev(swap("mergeable", "BLOCK", "mergeStateStatus DIRTY")), P).why, ESCALATIONS.DIRTY);

// Every open PR blocks on a red base at once, so it is ONE escalation, not N repairs.
{
  const d = nextAction(ev(swap("base", "BLOCK", "the base branch is red")), P);
  check("a red base escalates", d.why, ESCALATIONS.BASE_RED);
  check("and is marked shared, so it pushes once", d.shared, true);
}
check("a required check that never reported escalates",
  nextAction(ev(swap("ci", "BLOCK", "required check(s) never reported: CI Gate")), P).why, ESCALATIONS.MISSING_REQUIRED);

// ── CI ────────────────────────────────────────────────────────────────────
check("a failure this PR CAUSED is fixed here",
  nextAction(ev(swap("ci", "BLOCK", "failing: unit"), { checks: { caused: ["unit"], inherited: [] } }), P).action, ACTIONS.FIX_CI);

// Repairing an inherited failure inside a feature PR hides where it came from.
check("a purely INHERITED failure is not fixed here",
  nextAction(ev(swap("ci", "BLOCK", "failing: Browser tests"), { checks: { caused: [], inherited: ["Browser tests"] } }), P).action, ACTIONS.ESCALATE);

// One attempt per fingerprint: a second try at the same failure is another guess.
{
  const e = ev(swap("ci", "BLOCK", "failing: unit"), { checks: { caused: ["unit"], inherited: [] } });
  const first = nextAction(e, P, { fingerprint: "fp1", fixAttempts: new Map() });
  check("the first attempt fixes", first.action, ACTIONS.FIX_CI);
  const second = nextAction(e, P, { fingerprint: "fp1", fixAttempts: new Map([["fp1", 1]]) });
  check("the second attempt escalates instead of guessing again", second.action, ACTIONS.ESCALATE);
  check("and names why", second.why, ESCALATIONS.REPEATED_FAILURE);
}

// ── in flight ─────────────────────────────────────────────────────────────
check("an in-flight check waits", nextAction(ev(swap("ci", "UNKNOWN", "checks not settled: RUNNING")), P).action, ACTIONS.WAIT);

// A reviewer that has not run is not a stall: it is a round nobody asked for.
check("a reviewer that has not run triggers a request",
  nextAction(ev(swap("review", "UNKNOWN", "not yet run: codex")), P).action, ACTIONS.REQUEST_REVIEW);
check("but not past the soft cap",
  nextAction(ev(swap("review", "UNKNOWN", "not yet run: codex"), { rounds: { n: 5, softCap: 5, hardCap: 10, unspilledCritical: 0 } }), P).action, ACTIONS.WAIT);

// 65 of 65 Codex comments were quota refusals: that is a supply problem.
{
  const d = nextAction(ev(swap("review", "UNKNOWN", "unreachable: codex=REFUSED — absence is not approval")), P);
  check("all reviewers unreachable escalates", d.why, ESCALATIONS.REVIEWERS_DOWN);
  check("and is shared, not per-PR", d.shared, true);
}

// An UNKNOWN that never resolves is a stall, and a silent stall is the failure mode.
check("an UNKNOWN that outlives its window escalates",
  nextAction(ev(swap("ci", "UNKNOWN", "not settled")), P, { unknownSince: 0, now: 99999 }).why, ESCALATIONS.NOT_CHECKABLE);

// ── findings ──────────────────────────────────────────────────────────────
check("unresolved threads are worked",
  nextAction(ev(swap("threads", "BLOCK", "2 of 5 unresolved")), P).action, ACTIONS.FIX_FINDINGS);
check("ledger blockers are worked",
  nextAction(ev(swap("findings", "BLOCK", "1 active finding")), P).action, ACTIONS.FIX_FINDINGS);

// Past the soft cap with nothing critical: spill the remainder to a follow-up.
check("past the soft cap with only minor findings, spill",
  nextAction(ev(swap("threads", "BLOCK", "2 unresolved"), { rounds: { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 0 } }), P).action, ACTIONS.SPILL);

// A critical is NEVER spilled.
check("the cap with a critical open escalates",
  nextAction(ev(swap("rounds", "BLOCK", "hard cap reached with 1 P1 open")), P).why, ESCALATIONS.CAP_WITH_CRITICAL);

// ── staleness ─────────────────────────────────────────────────────────────
check("a verdict at the wrong revision re-requests",
  nextAction(ev(swap("review", "BLOCK", "covered at a different revision")), P).action, ACTIONS.REQUEST_REVIEW);
check("and marks it stale",
  nextAction(ev(swap("review", "BLOCK", "covered at a different revision")), P).stale, true);

// A branch that is merely behind its base is repairable without judgement.
check("a BEHIND branch updates rather than escalating",
  nextAction(ev(swap("mergeable", "BLOCK", "mergeStateStatus BEHIND")), P).action, ACTIONS.UPDATE_BRANCH);
// An unrecognised merge state names itself instead of reading as unclassified.
check("an unrecognised merge state escalates with the state named",
  /UNMERGEABLE/.test(nextAction(ev(swap("mergeable", "BLOCK", "mergeStateStatus UNMERGEABLE")), P).why), true);

// ── a builder hold is read before anything that could act on the PR ───────
// A matrix that varies ONE clause at a time cannot see a precedence bug at all,
// so these vary two. Both are the ways late placement loses.
{
  // A held PR with red CI. Reached in clause order the `ci` branch answers first
  // and returns FIX_CI -- the guardian dispatching a fixer at a task the builder
  // deliberately parked, which is the exact outcome `pr_hold` exists to prevent.
  const both = swap("hold", "BLOCK", "ownership_lost: the task no longer owns this path")
    .map(c => (c.id === "ci" ? cl("ci", "BLOCK", "failing: unit") : c));
  const d = nextAction(ev(both, { checks: { caused: ["unit"], inherited: [] } }), P, { fixAttempts: new Map() });
  check("a held PR with red CI parks rather than dispatching a fixer", d.action, ACTIONS.PARK);
  check("and says the builder is holding it", /held by the builder/.test(d.why), true);

  // CONTROL: the same red CI without the hold still dispatches, or the branch
  // above has simply disabled FIX_CI rather than deferring to the hold.
  const noHold = swap("ci", "BLOCK", "failing: unit");
  check("control: the same red CI without a hold still dispatches a fixer",
    nextAction(ev(noHold, { checks: { caused: ["unit"], inherited: [] } }), P, { fixAttempts: new Map() }).action,
    ACTIONS.FIX_CI);
}
{
  // A hold that could not be scoped, alongside another UNKNOWN. Left to fall
  // through, the generic sweep reports it as an unscopeable clause rather than
  // as the configuration fault it is.
  const both = swap("hold", "UNKNOWN", "no hub connection")
    .map(c => (c.id === "threads" ? cl("threads", "UNKNOWN", "projection unreadable") : c));
  const d = nextAction(ev(both), P, { fixAttempts: new Map() });
  check("an unscopeable hold escalates as itself, not as a generic unknown",
    /builder hold state unknown/.test(d.why), true);
  check("and is not reported as a classifier gap", d.gap, undefined);
}
{
  // A hold present and CLEAR must not park: the clause exists on every verdict
  // the guardian renders once a hub is wired, so a PASS that parked would stop
  // every PR in the repository.
  check("a PASS hold does not park", nextAction(ev(allPass()), P).action, ACTIONS.MERGE);
}

// ── totality ──────────────────────────────────────────────────────────────
// No reachable combination may fall through to a silent WAIT with no reason.
{
  const states = ["PASS", "BLOCK", "UNKNOWN"];
  const ids = CLAUSE_IDS;
  let unclassified = 0, missingWhy = 0;
  for (const id of ids) for (const st of states) {
    const d = nextAction(ev(swap(id, st, "detail")), P, { fixAttempts: new Map() });
    if (d.gap) unclassified++;
    if (!d.why) missingWhy++;
  }
  check("no verdict combination is unclassified", unclassified, 0);
  check("every decision carries a reason", missingWhy, 0);
}


// A decision reason must never contain the literal string "undefined". This shape
// appeared twice — "FIX_CI failing: undefined" — and patching where it surfaced
// did not stop it, so an unnamed failure is now undispatchable by construction:
// a fixer cannot be told to repair a check nobody can name.
{
  const e = ev(swap("ci", "BLOCK", "failing: an unnamed check"), { checks: { caused: [undefined], inherited: [] } });
  const d = nextAction(e, P, { fixAttempts: new Map() });
  check("an unnamed failure escalates rather than dispatching", d.action, ACTIONS.ESCALATE);
  check("and says so plainly", /could not name it/.test(d.why), true);
  check("no decision reason ever contains 'undefined'", /undefined/.test(d.why), false);
}
{
  const e = ev(swap("ci", "BLOCK", "failing: unit"), { checks: { caused: ["unit", undefined, ""], inherited: [] } });
  const d = nextAction(e, P, { fixAttempts: new Map() });
  check("a mixed list keeps only the named entries", d.why, "failing: unit");
  check("and dispatches on them", d.action, ACTIONS.FIX_CI);
}

// GitHub can refuse a merge for a requirement none of the clauses model.
// Measured on nextly #1129: every check green, no blocking threads, and
// mergeStateStatus BLOCKED because the ruleset demands an approving review.
// That is a routine needs-a-human state; reporting it as a gap in the
// classifier tells the founder the code is broken when the PR just needs them.
{
  const d = nextAction(ev(swap("mergeable", "BLOCK", "mergeStateStatus BLOCKED")), P);
  check("protection unmet beyond the clauses escalates by name", d.why, ESCALATIONS.PROTECTION_UNMET);
  check("and is not reported as a classifier gap", d.gap, undefined);
  check("and carries GitHub's own word in the detail, not the key", d.detail, "mergeStateStatus BLOCKED");

  // Control: a BLOCK the watcher genuinely cannot name still reaches the
  // catch-all -- the new branch must not swallow real gaps.
  const g = nextAction(ev(allPass().concat(cl("zzz", "BLOCK", "??"))), P);
  check("an unknown blocking clause still reports a gap", g.gap, true);
  check("and says it is unclassified", /unclassified/.test(g.why), true);
}

// ── a swap that swaps nothing ──────────────────────────────────────────────
//
// `swap(id, …)` replaces a clause in the fixture. When the fixture's clause list
// does not know that id, it replaces NOTHING: the fixture stays all-pass, the
// decision is MERGE, and the assertion beneath it reports whatever an all-pass
// verdict does. That is worse than a stale list that under-covers, because the
// green is not merely uninformative -- it is actively wrong, and the test passes
// while inert. It happened here: adding `cleared` left three assertions
// measuring nothing until this was noticed.
//
// So the fixture is checked for reaching the mechanism, which is the general form
// of the defect. It is deliberately NOT a second canonical clause list: the
// builder lane is landing `CLAUSE_IDS`, exported from verdict.mjs and compared
// against what `computeVerdict` emits, and two canonical lists would be exactly
// the defect this file is guarding against, arriving as its fix. When that lands,
// `CLAUSES` here becomes the import and this check stays, because it answers a
// different question: not "is the list right" but "did the fixture bite".
// One check, not two. The obvious first one -- "every id this file swaps is one
// the fixture contains" -- is CIRCULAR: `allPass()` is built FROM `CLAUSES`, so
// it compares a list against something derived from itself and cannot fail.
// Stubbing an unknown id into the list left it green, which is how I know.
{
  const before = nextAction(ev(allPass()), P).action;
  const changed = CLAUSES.filter(id => nextAction(ev(swap(id, "BLOCK", "x")), P).action === before);
  check("and blocking any one of them changes the decision, so no swap is inert",
    changed.join(",") || "none", "none");
}

// ── a thread nobody came back to is work, not a gap ─────────────────────────
//
// `nextAction` is total by construction: a BLOCK matching no branch falls to
// "unclassified verdict … gap: true". That totality only helps if new clauses are
// actually classified, so adding one without a branch turns a real finding into
// an escalation about the decision function itself.
check("an uncleared thread ASKS THE REVIEWER, rather than dispatching a fixer",
  nextAction(ev(swap("cleared", "BLOCK", "1 thread(s) that codex has not come back to")), P).action,
  ACTIONS.REQUEST_REVIEW);
// After a push, threads go uncleared because nobody has reviewed the new head
// yet, and the review clause blocks for the same reason. The reviewer's return is
// the only thing that clears them, so the stale review must be asked for FIRST --
// dispatching a fixer here sends a worker at findings whose only problem is that
// nobody has looked at them.
{
  const both = allPass().map(c => c.id === "cleared" ? cl("cleared", "BLOCK", "uncleared")
                                : c.id === "review" ? cl("review", "BLOCK", "reviewed an older revision") : c);
  const d = nextAction(ev(both), P);
  check("a push that unclears threads asks for the review, not a fix", d.action, ACTIONS.REQUEST_REVIEW);
  check("and says which, so the two cases are distinguishable", /older revision/.test(d.why ?? ""), true);
}
// THE REGRESSION THIS ORDERING CAUSED, asserted directly. Past the soft cap with
// an unbuilt critical count, a real finding must still reach a fixer: the
// watcher handles UNKNOWN before BLOCK findings, so an UNKNOWN rounds clause
// stopped every repair rather than stopping a spill.
{
  const past = { rounds: { n: 6, softCap: 5, hardCap: 10, unspilledCritical: null, criticalGap: "not-derived" } };
  check("past the cap with an unbuilt critical count, a finding still dispatches a fixer",
    nextAction(ev(swap("findings", "BLOCK", "2 open"), past), P).action, ACTIONS.FIX_FINDINGS);

  // END TO END, through computeVerdict rather than a hand-built clause list.
  //
  // The check above hands `nextAction` clauses directly, so it cannot see the
  // verdict deciding what state `rounds` is in -- and that decision is the P1.
  // Collapsing the transient/permanent split left this file GREEN while the
  // composition was broken, which is the seam-versus-mounted trap: the watcher
  // was fine, the verdict was fine in isolation, and together they waited
  // forever. Only a test that runs both catches it.
  const compose = over => computeVerdict({
    head: "c".repeat(40),
    checks: { verdict: "GREEN", settled: true, failing: [] },
    base: { verdict: "GREEN" },
    reviewers: [{ login: "codex", kind: "blocking", state: "CLEAN", reviewedHead: "c".repeat(10) }],
    rounds: { n: 2, softCap: 5, hardCap: 10, unspilledCritical: 0, blockingCritical: 0 },
    threads: { unresolved: 0, total: 4, readable: true },
    cleared: { readable: true, uncleared: 0, reviewers: [] },
    bodyFindings: { readable: true, open: 0, reviewers: [] },
    unreadableBodies: { readable: true, open: 0, reviewers: [] },
    ledgerBlockers: 0, mergeState: "CLEAN", ...over,
  });
  const through = (over, hist) => nextAction(
    { pr: 1, state: "open", verdict: compose(over), checks: {}, rounds: hist ?? { n: 2, softCap: 5, hardCap: 10, unspilledCritical: 0 } }, P).action;

  check("and the same holds through computeVerdict, which is where the state is decided",
    through({ threads: { unresolved: 2, total: 4, readable: true } }), ACTIONS.FIX_FINDINGS);

  // The permanent gap this block was written for is closed -- an unreadable review
  // body is counted as one `unknown` finding instead of being left out of the
  // count -- so the cap is enforced rather than announced as unenforced. What that
  // must NOT have cost is the property the block exists to protect: the cap stops
  // a spill, never every repair.
  check("past the cap a critical now ESCALATES, which is the cap actually enforced",
    through({ rounds: { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 1, blockingCritical: 1 },
              threads: { unresolved: 2, total: 4, readable: true } },
            { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 1 }),
    ACTIONS.ESCALATE);
  // ...and an ADVISORY reviewer's critical does not, which is why the count was
  // split. Every gating clause passes, so escalating here would be the pull
  // request stopped by an opinion the profile says does not gate. The universal
  // count is still 1, so the spill branch below still refuses — one fixture
  // showing the two rules reading two numbers and disagreeing on purpose.
  check("control: an advisory critical past the cap dispatches instead of escalating",
    through({ rounds: { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 1, blockingCritical: 0 },
              threads: { unresolved: 2, total: 4, readable: true } },
            { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 1 }),
    ACTIONS.FIX_FINDINGS);
  check("control: and past the cap with a KNOWN zero it still spills rather than stalling",
    through({ rounds: { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 0 },
              threads: { unresolved: 2, total: 4, readable: true } },
            { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 0 }),
    ACTIONS.SPILL);

  // A body finding composes to a FIXER, not to another request for a round. Both
  // halves worked in isolation before this: the fold derived it and the clause
  // blocked on it, and the watcher answered by asking the reviewer to come back --
  // so the finding was derived, counted, and acted on by nothing.
  check("an open review-body finding dispatches a fixer, with no thread unresolved",
    through({ bodyFindings: { readable: true, open: 1, reviewers: ["codex"] } }),
    ACTIONS.FIX_FINDINGS);
  check("control: and with none open the same shape does not dispatch one",
    through({}), ACTIONS.MERGE);

  // A BODY FINDING PLUS A STALE REVIEW ASKS, IT DOES NOT FIX AGAIN.
  //
  // Nothing a worker does can close a body finding: it has no thread, so the only
  // operation that clears one is the same reviewer reviewing again. Fixing it
  // therefore pushes a new head, which leaves the finding open AND makes the
  // review stale — and this branch sits above the stale-review branch, so it would
  // dispatch another worker at the finding it had just repaired, once per push for
  // as long as the budget lasted.
  const staleReviewer = [{ login: "codex", kind: "blocking", state: "CLEAN", reviewedHead: "d".repeat(10) }];
  check("with the review stale, an open body finding asks for a round instead of fixing again",
    through({ reviewers: staleReviewer,
              bodyFindings: { readable: true, open: 1, reviewers: ["codex"] } }),
    ACTIONS.REQUEST_REVIEW);
  check("control: with the reviewer covering THIS head, the same finding does dispatch a fixer",
    through({ bodyFindings: { readable: true, open: 1, reviewers: ["codex"] } }),
    ACTIONS.FIX_FINDINGS);
  // And the exemption is scoped to body findings alone: an unresolved THREAD can
  // be closed by a worker, so a stale review must not stop that.
  // A BODY REEVE CANNOT READ FETCHES A PERSON, and does it before anything that
  // could act on the pull request. Not a worker: there is nothing for one to fix.
  // Not a silent block: clearing a body finding needs its author to review the
  // same head again, which a one-time commenter never will, so blocking alone
  // leaves a pull request nothing can free.
  check("an unreadable review body escalates rather than dispatching a worker",
    through({ unreadableBodies: { readable: true, open: 1, reviewers: ["a-human"] } }),
    ACTIONS.ESCALATE);
  check("and it wins over a fixer that would otherwise run, because it is read first",
    through({ unreadableBodies: { readable: true, open: 1, reviewers: ["a-human"] },
              threads: { unresolved: 2, total: 4, readable: true } }),
    ACTIONS.ESCALATE);
  // AND AN UNRELATED UNCERTAINTY DOES NOT DEFER IT. This is a definite state —
  // reeve knows it cannot read the body — so it must not queue behind the generic
  // "something is in flight" wait. GitHub still computing mergeability is the
  // ordinary case, and below that branch the operator got "a clause could not be
  // evaluated" after the settling window instead of the sentence naming the
  // reviewer to declare. An immediate escalation anything else can postpone is not
  // immediate.
  check("an unrelated UNKNOWN clause does not defer it into a wait",
    through({ unreadableBodies: { readable: true, open: 1, reviewers: ["a-human"] },
              mergeState: "" }),
    ACTIONS.ESCALATE);
  check("control: that same UNKNOWN really does produce a wait on its own",
    through({ mergeState: "" }), ACTIONS.WAIT);
  check("control: with every body readable, that same shape dispatches the fixer",
    through({ threads: { unresolved: 2, total: 4, readable: true } }),
    ACTIONS.FIX_FINDINGS);

  check("control: a stale review does NOT hold back a fixer for an unresolved thread",
    through({ reviewers: staleReviewer,
              threads: { unresolved: 2, total: 4, readable: true } }),
    ACTIONS.FIX_FINDINGS);
}
// Past the hard cap it stops asking and fetches a person.
check("past the hard cap an uncleared thread escalates rather than asking again",
  nextAction(ev(swap("cleared", "BLOCK", "uncleared"), { rounds: { n: 10, softCap: 5, hardCap: 10, unspilledCritical: 0 } }), P).action,
  ACTIONS.ESCALATE);
// And it must not steal the dispatch when a real finding is open.
check("control: a genuine finding still dispatches a fixer",
  nextAction(ev(swap("findings", "BLOCK", "2 open")), P).action, ACTIONS.FIX_FINDINGS);
check("control: and it is NOT reported as an unclassified verdict",
  /unclassified/.test(nextAction(ev(swap("cleared", "BLOCK", "x")), P).why ?? ""), false);
check("an unreadable projection waits rather than passing",
  nextAction(ev(swap("cleared", "UNKNOWN", "cannot say")), P).action, ACTIONS.WAIT);

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
