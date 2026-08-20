// watcher — given a verdict, decide the single next action for a PR.
//
// Pure and total: every reachable state maps to exactly one action, and there is
// no default branch that quietly means "do nothing". A watcher whose unknown
// states fall through to WAIT is a watcher that stalls silently, which is
// indistinguishable from one that is working.
//
// The actions are deliberately few. Each one is something a worker can be
// dispatched to do, or something only the founder can resolve.

export const ACTIONS = {
  UPDATE_BRANCH: "UPDATE_BRANCH", // the branch is behind its base; bring it forward
  WAIT: "WAIT",                     // something is in flight; check again later
  FIX_CI: "FIX_CI",                 // a failure this PR caused; root-cause and repair
  FIX_FINDINGS: "FIX_FINDINGS",     // unresolved review threads to work
  REQUEST_REVIEW: "REQUEST_REVIEW", // no verdict at this head; ask for a round
  SPILL: "SPILL",                   // cap reached; move the remainder to a follow-up
  MERGE: "MERGE",                   // every clause satisfied
  PARK: "PARK",                     // nothing reeve can do; not an error
  ESCALATE: "ESCALATE",             // the founder decides
};

/** Escalation reasons, so the phone push can say WHY in four words. */
export const ESCALATIONS = {
  BASE_RED: "the base branch is red",
  MISSING_REQUIRED: "a required check never reported",
  CAP_WITH_CRITICAL: "round cap reached with a critical finding open",
  REPEATED_FAILURE: "the same failure survived a second fix",
  DIRTY: "the branch conflicts with its base",
  REVIEWERS_DOWN: "no blocking reviewer is reachable",
  NOT_CHECKABLE: "a clause could not be evaluated and stayed that way",
};

const clause = (v, id) => v.clauses.find(c => c.id === id);

/**
 * @param {object} e   the evaluatePr() result
 * @param {object} p   the profile
 * @param {object} h   history: {fixAttempts: Map<fingerprint,int>, unknownSince: epoch|null, now: epoch}
 */
export function nextAction(e, p, h = {}) {
  const v = e.verdict;
  const now = h.now ?? Math.floor(Date.now() / 1000);
  const act = (action, why, extra = {}) => ({ action, why, ...extra });

  // A closed or merged PR is finished, whatever its checks say. Reviewing or
  // pushing into one strands the work silently.
  if (e.state && e.state !== "open") return act(ACTIONS.PARK, `PR is ${e.state}`);

  // 1. Conflicts first: nothing else can be evaluated meaningfully on a branch
  //    that cannot merge at all, and rebasing is a decision, not a repair.
  const mergeable = clause(v, "mergeable");
  if (mergeable?.state === "BLOCK") {
    if (/DIRTY/i.test(mergeable.detail)) return act(ACTIONS.ESCALATE, ESCALATIONS.DIRTY);
    // BEHIND is repairable without judgement: bring the branch forward and re-read.
    if (/BEHIND/i.test(mergeable.detail)) return act(ACTIONS.UPDATE_BRANCH, mergeable.detail);
    // BLOCKED means GitHub's own requirements are unmet, which the clauses below
    // describe in detail. Fall through so the specific reason is reported rather
    // than the generic one.
    if (!/BLOCKED/i.test(mergeable.detail))
      return act(ACTIONS.ESCALATE, `GitHub refuses this merge: ${mergeable.detail}`);
  }

  // 2. A red base is not this PR's fault and not this PR's to fix. Every open PR
  //    blocks on it simultaneously, so it is one escalation, not N repairs.
  if (clause(v, "base")?.state === "BLOCK")
    return act(ACTIONS.ESCALATE, ESCALATIONS.BASE_RED, { shared: true });

  // 3. CI. Only a failure this PR CAUSED is repairable here; an inherited one is
  //    the base's problem and repairing it in a feature PR hides its origin.
  const ci = clause(v, "ci");
  if (ci?.state === "BLOCK") {
    if (/never reported/i.test(ci.detail)) return act(ACTIONS.ESCALATE, ESCALATIONS.MISSING_REQUIRED);
    const caused = e.checks?.caused ?? [];
    const inherited = e.checks?.inherited ?? [];
    if (!caused.length && inherited.length)
      return act(ACTIONS.ESCALATE, ESCALATIONS.BASE_RED, { shared: true, inherited });

    // One fix attempt per fingerprint. A second attempt at the same failure is
    // another guess, and guessing twice is the loop that runs away.
    const fp = h.fingerprint ?? null;
    const tried = fp ? (h.fixAttempts?.get?.(fp) ?? 0) : 0;
    const cap = p.rounds?.maxFixAttemptsPerFinding ?? 1;
    if (tried >= cap) return act(ACTIONS.ESCALATE, ESCALATIONS.REPEATED_FAILURE, { fingerprint: fp, tried });
    // Built only from names that exist. An unnamed failure is not dispatchable —
    // a fixer cannot be told to repair "undefined" — so it escalates instead.
    const named = caused.filter(n => typeof n === "string" && n.length > 0);
    if (!named.length) return act(ACTIONS.ESCALATE, `a check is failing but reeve could not name it: ${ci.detail}`, { unnamed: true });
    return act(ACTIONS.FIX_CI, `failing: ${named.join(", ")}`, { caused: named, attempt: tried + 1 });
  }

  // 4. Anything still in flight: wait. But an UNKNOWN that never resolves is a
  //    stall, so it escalates once it has outlived a reasonable settling window.
  const unknowns = v.clauses.filter(c => c.state === "UNKNOWN");
  if (unknowns.length) {
    const stuckFor = h.unknownSince != null ? now - h.unknownSince : 0;
    const limit = p.watch?.unknownEscalateSeconds ?? 3600;
    if (stuckFor > limit)
      return act(ACTIONS.ESCALATE, ESCALATIONS.NOT_CHECKABLE, { clauses: unknowns.map(c => c.id), stuckFor });

    // A reviewer that has not run is not a stall: it is a round we have not asked
    // for. Ask, if the budget allows.
    const review = clause(v, "review");
    if (review?.state === "UNKNOWN" && /not yet run/i.test(review.detail)) {
      const R = e.rounds ?? {};
      if ((R.n ?? 0) < (R.softCap ?? 5)) return act(ACTIONS.REQUEST_REVIEW, review.detail, { round: (R.n ?? 0) + 1 });
    }
    // Every blocking reviewer unreachable is a supply problem, not a PR problem.
    if (review?.state === "UNKNOWN" && /unreachable/i.test(review.detail))
      return act(ACTIONS.ESCALATE, ESCALATIONS.REVIEWERS_DOWN, { shared: true, detail: review.detail });

    return act(ACTIONS.WAIT, unknowns.map(c => `${c.id}: ${c.detail}`).join("; "), { unknownSince: h.unknownSince != null ? h.unknownSince : now });
  }

  // 5. Findings. Past the cap, criticals escalate and the rest spill.
  const rounds = clause(v, "rounds");
  if (rounds?.state === "BLOCK") return act(ACTIONS.ESCALATE, ESCALATIONS.CAP_WITH_CRITICAL, { detail: rounds.detail });

  const threads = clause(v, "threads");
  const findings = clause(v, "findings");
  if (threads?.state === "BLOCK" || findings?.state === "BLOCK") {
    const R = e.rounds ?? {};
    if ((R.n ?? 0) >= (R.softCap ?? 5) && (R.unspilledCritical ?? 0) === 0)
      return act(ACTIONS.SPILL, `past the soft cap with only non-critical findings open`, { round: R.n });
    const blocking = [threads, findings].filter(c => c?.state === "BLOCK");
    return act(ACTIONS.FIX_FINDINGS, blocking.map(c => c.detail).filter(Boolean).join("; ") || "findings block this PR",
               { threads: threads?.state === "BLOCK", findings: findings?.state === "BLOCK" });
  }

  // 6. A stale verdict: reviewed, but not this revision.
  const review = clause(v, "review");
  if (review?.state === "BLOCK") {
    const R = e.rounds ?? {};
    if ((R.n ?? 0) < (R.hardCap ?? 10)) return act(ACTIONS.REQUEST_REVIEW, review.detail, { round: (R.n ?? 0) + 1, stale: true });
    return act(ACTIONS.ESCALATE, ESCALATIONS.CAP_WITH_CRITICAL, { detail: review.detail });
  }

  if (v.state === "PASS") {
    // Merge authority is a profile decision, not a verdict one. A green verdict
    // on a repo where reeve may only propose is a finished PR, not a merge.
    const policy = p.authority?.policy;
    if (policy === "owner" || policy === "propose_and_merge") return act(ACTIONS.MERGE, "every clause satisfied");
    return act(ACTIONS.PARK, `verdict is PASS but authority.policy is '${policy}': awaiting a maintainer`,
               { awaitingMaintainer: true });
  }

  // Total by construction: a BLOCK that matched no branch above is a gap in this
  // function, and saying so is better than silently waiting.
  return act(ACTIONS.ESCALATE, `unclassified verdict ${v.state}: ${v.summary}`, { gap: true });
}

/** One line per PR, for the fleet band of the dashboard. */
export function describe(e, decision) {
  const waiting = decision.action === ACTIONS.WAIT ? decision.why.split(";")[0] : decision.why;
  return `#${e.pr} ${String(e.verdict.state).padEnd(7)} ${decision.action.padEnd(15)} ${waiting.slice(0, 68)}`;
}
