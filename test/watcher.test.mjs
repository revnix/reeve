// The decision function must be TOTAL: every reachable verdict maps to exactly one
// action, and no state falls through to a silent WAIT.
import { nextAction, ACTIONS, ESCALATIONS } from "../src/watcher.mjs";
import { computeVerdict } from "../src/verdict.mjs";

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
const CLAUSES = ["ci", "base", "review", "rounds", "threads", "cleared", "findings", "mergeable"];
const ev = (clauses, extra = {}) => ({
  pr: 1, state: "open",
  verdict: { state: clauses.some(c => c.state === "BLOCK") ? "BLOCK" : clauses.some(c => c.state === "UNKNOWN") ? "UNKNOWN" : "PASS", clauses, summary: "x" },
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  checks: {}, ...extra,
});
const allPass = () => CLAUSES.map(id => cl(id, "PASS"));
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

// ── totality ──────────────────────────────────────────────────────────────
// No reachable combination may fall through to a silent WAIT with no reason.
{
  const states = ["PASS", "BLOCK", "UNKNOWN"];
  const ids = ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"];
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
check("an uncleared thread dispatches a fixer, not a gap",
  nextAction(ev(swap("cleared", "BLOCK", "1 thread(s) that codex has not come back to")), P).action,
  ACTIONS.FIX_FINDINGS);
check("control: and it is NOT reported as an unclassified verdict",
  /unclassified/.test(nextAction(ev(swap("cleared", "BLOCK", "x")), P).why ?? ""), false);
check("an unreadable projection waits rather than passing",
  nextAction(ev(swap("cleared", "UNKNOWN", "cannot say")), P).action, ACTIONS.WAIT);

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
