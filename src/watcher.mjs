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
  // GitHub refusing for a requirement no clause models -- on nextly this is the
  // ruleset's approving-review demand, which reeve neither gives nor overrides.
  PROTECTION_UNMET: "GitHub's protection requires something reeve does not provide (typically an approving review)",
  REVIEWERS_DOWN: "no blocking reviewer is reachable",
  NOT_CHECKABLE: "a clause could not be evaluated and stayed that way",
};

const clause = (v, id) => v.clauses.find(c => c.id === id);

/**
 * @param {object} e   the evaluatePr() result
 * @param {object} p   the profile
 * @param {object} h   history: {fixAttempts: Map<fingerprint,int>, unknownSince: epoch|null, now: epoch}
 */
/**
 * Review actions are gated OFF until review ingest exists.
 *
 * The data they depend on is not real: `unspilledCritical` is hard-coded to zero,
 * so the clause enforcing "criticals are never spilled" cannot fire while SPILL
 * fires on exactly that value -- reeve would have moved P0 findings to a follow-up
 * and called it policy. `rounds.n` counts the latest reviewed head per reviewer,
 * so one reviewer completing twenty rounds still reads as one.
 *
 * Escalating instead is not a smaller version of doing the work; it is the honest
 * one. "Not built" must not look like "nothing to do".
 */
const REVIEW_ACTIONS = new Set([ACTIONS.REQUEST_REVIEW, ACTIONS.FIX_FINDINGS, ACTIONS.SPILL]);

// The gated why is an IDENTITY, so it is built from WHICH action was gated,
// never from the clause detail. The detail is a report -- for threads it reads
// "13 of 17 thread(s) unresolved" -- and embedding it meant every resolved or
// newly opened thread changed the key, which the escalation layer reads as a NEW
// problem. Measured on nextly #1128: three phone pushes in one morning for one
// unchanged condition, at 13 of 17, then 23 of 27. The founder was being paged
// about progress.
const GATED_WHY = {
  [ACTIONS.FIX_FINDINGS]: "needs a human: the review half is not built, so reeve cannot work the unresolved review threads",
  [ACTIONS.REQUEST_REVIEW]: "needs a human: the review half is not built, so reeve cannot request a review round",
  [ACTIONS.SPILL]: "needs a human: the review half is not built, so reeve cannot spill findings past the round cap",
};

function gateReviewActions(decision, p) {
  if (!REVIEW_ACTIONS.has(decision.action)) return decision;
  if (p.watch?.reviewActions === true) return decision;
  return {
    ...decision,
    action: ACTIONS.ESCALATE,
    why: GATED_WHY[decision.action],
    // The clause detail, counts and all, for the log and `reeve why` -- a report
    // belongs on surfaces a human reads deliberately, not in the key that pages.
    detail: decision.why,
    gated: decision.action,
  };
}

export function nextAction(e, p, h = {}) {
  const v = e.verdict;
  const now = h.now ?? Math.floor(Date.now() / 1000);
  // Every branch returns through here, so the review gate is applied once, at the
  // single exit, rather than at each of the six call sites where one would
  // eventually be missed.
  const act = (action, why, extra = {}) => gateReviewActions({ action, why, ...extra }, p);

  // A closed or merged PR is finished, whatever its checks say. Reviewing or
  // pushing into one strands the work silently.
  if (e.state && e.state !== "open") return act(ACTIONS.PARK, `PR is ${e.state}`);

  // 0. A BUILDER HOLD, read before anything that might act on the PR.
  //
  // The builder wrote `pr_hold` on purpose and a founder clears it with `reeve
  // task resume`. That is a decision already taken, not a defect to repair and
  // not a gap in reeve, so it is PARK.
  //
  // ORDER IS THE WHOLE POINT, and late placement loses in two directions at
  // once. A held PR that also has red CI reaches the `ci` branch below and
  // returns FIX_CI -- the guardian dispatching a fixer at a task the builder
  // deliberately parked, which is the precise outcome `pr_hold` exists to
  // prevent. And a `hold` clause left to fall through reaches the unclassified
  // escalation at the end of this function, which carries `gap: true` -- the
  // flag reserved for a verdict reeve does not understand -- so every ordinary
  // held PR would report an implementation gap, every tick, with the merge
  // correctly blocked and the reason a lie.
  //
  // UNKNOWN escalates rather than parking: "the hold cannot be scoped" is a
  // configuration fault for the founder to fix, not a decision to respect.
  const hold = clause(v, "hold");
  if (hold?.state === "BLOCK") return act(ACTIONS.PARK, `held by the builder: ${hold.detail}`);
  if (hold?.state === "UNKNOWN") return act(ACTIONS.ESCALATE, `builder hold state unknown: ${hold.detail}`);

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
  // `cleared` deliberately does NOT join these two, and getting that wrong was a
  // real defect. See its own branch below, after the stale-review one.
  const cleared = clause(v, "cleared");
  if (threads?.state === "BLOCK" || findings?.state === "BLOCK") {
    const R = e.rounds ?? {};
    // `?? 0` here would read an UNKNOWN critical count as "no criticals" and spill
    // on it, which is the standing ruling inverted. Only a known zero may spill.
    if ((R.n ?? 0) >= (R.softCap ?? 5) && R.unspilledCritical === 0)
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

  // 6b. A thread the blocking reviewer has not come back to. AFTER the stale
  //     review above, and the action is to ask them rather than to fix anything.
  //
  //     Putting this in the findings branch was wrong twice over. After a push,
  //     `derivePr` marks previously cleared threads uncleared until the reviewer
  //     covers the new head -- so every push dispatched a worker at findings that
  //     were uncleared only because nobody had looked at the new revision yet,
  //     when the one thing that could clear them is the review this skipped past.
  //
  //     And where the reviewer HAS covered this head, a thread going uncleared
  //     means it was resolved AFTER their round -- the bot dismissing its own
  //     finding, which is the case this clause exists for. The answer there is the
  //     same: ask the reviewer to come back and confirm. Nothing about either case
  //     says "send a worker to change code".
  //
  //     Not dispatching also closes a narrower window: a reviewer's round landing
  //     between the fold and this decision leaves the count a tick stale, and a
  //     stale count that costs a review request is self-correcting where one that
  //     costs a worker is not.
  if (cleared?.state === "BLOCK") {
    const R = e.rounds ?? {};
    if ((R.n ?? 0) < (R.hardCap ?? 10))
      return act(ACTIONS.REQUEST_REVIEW, cleared.detail, { round: (R.n ?? 0) + 1, uncleared: true });
    return act(ACTIONS.ESCALATE, ESCALATIONS.CAP_WITH_CRITICAL, { detail: cleared.detail });
  }

  if (v.state === "PASS") {
    // Merge authority is a profile decision, not a verdict one. A green verdict
    // on a repo where reeve may only propose is a finished PR, not a merge.
    const policy = p.authority?.policy;
    if (policy === "owner" || policy === "propose_and_merge") return act(ACTIONS.MERGE, "every clause satisfied");
    return act(ACTIONS.PARK, `verdict is PASS but authority.policy is '${policy}': awaiting a maintainer`,
               { awaitingMaintainer: true });
  }

  // GitHub can refuse a merge for a requirement none of the clauses model.
  // The fall-through at the top assumed a lower clause always explains BLOCKED;
  // nextly #1129 was the counterexample -- every check green, threads clear,
  // and mergeStateStatus BLOCKED because the ruleset demands an approving
  // review. A routine needs-a-human state, not a gap in this function.
  const blocking = v.clauses.filter(c => c.state === "BLOCK");
  if (blocking.length && blocking.every(c => c.id === "mergeable"))
    return act(ACTIONS.ESCALATE, ESCALATIONS.PROTECTION_UNMET, { detail: blocking[0].detail });

  // Total by construction: a BLOCK that matched no branch above is a gap in this
  // function, and saying so is better than silently waiting.
  return act(ACTIONS.ESCALATE, `unclassified verdict ${v.state}: ${v.summary}`, { gap: true });
}

/** One line per PR, for the fleet band of the dashboard. */
export function describe(e, decision) {
  const waiting = decision.action === ACTIONS.WAIT ? decision.why.split(";")[0] : decision.why;
  return `#${e.pr} ${String(e.verdict.state).padEnd(7)} ${decision.action.padEnd(15)} ${waiting.slice(0, 68)}`;
}
