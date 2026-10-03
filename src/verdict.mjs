// @ts-check
// verdict — the single answer to "may this revision merge?"
//
// The whole design rests on one inversion: reeve does not merge. It computes this
// verdict, publishes it bound to an exact head_sha, and GitHub refuses. A stale or
// crashed reeve then fails to publish and the merge blocks, where the previous
// design merged on stale logic and merged 0 of 10 correctly-gated PRs.
//
// Three outcomes, and only one of them merges:
//   PASS   every clause satisfied at the pinned head
//   BLOCK  a clause is definitely unsatisfied
//   UNKNOWN a clause could not be evaluated
//
// UNKNOWN never merges. Every fail-open defect measured in the previous system was
// an UNKNOWN silently rendered as PASS: an absent gate script read as a pass, a
// rate-limited reviewer reporting state=success, a fork PR with zero check runs.

import { POLICY_CONTEXT, LEGACY_CONTEXTS } from "./github/reconciler.mjs";

export const PASS = "PASS";
export const BLOCK = "BLOCK";
export const UNKNOWN = "UNKNOWN";

/**
 * Does a reviewer's named revision cover the head under test? Prefix in either
 * direction, minimum 7 hex, because the two surfaces abbreviate differently.
 */
export function coversHead(reviewedHead, head) {
  if (!reviewedHead || !head) return false;
  const a = String(reviewedHead).toLowerCase();
  const b = String(head).toLowerCase();
  if (a.length < 7 || b.length < 7) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Worst wins. UNKNOWN outranks PASS so a clause that could not answer cannot be outvoted. */
function worst(a, b) {
  if (a === BLOCK || b === BLOCK) return BLOCK;
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  return PASS;
}

/**
 * @param {object} i
 * @param {string} i.head            the sha this verdict is ABOUT, pinned once
 * @param {object} i.checks          {verdict, settled, readable, failing[]} from the reconciler
 * @param {object} i.base            {verdict, readable} for the base branch's own head
 * @param {object[]} i.reviewers     [{login, kind, state, reviewedHead}]
 * @param {object} i.rounds          {n, softCap, hardCap, unspilledCritical}
 * @param {object} i.threads         {unresolved, total, readable}
 * @param {number} i.ledgerBlockers  count of active findings blocking this PR, or null if unreadable
 * @param {string} i.mergeState      GitHub mergeStateStatus, or MERGED for a merge judged after it
 * @param {object} [i.mergeRules]    for a merge: GitHub's record of the base's rules judging it, {readable, result, failed[]}
 * @param {object} i.profile
 */
/**
 * Every clause id `computeVerdict` can emit.
 *
 * ONE LIST, because there were four: this function's `add` calls, and three
 * test matrices that each restated the set and claimed totality over it. A
 * clause added without updating a matrix leaves that matrix asserting totality
 * over a set one short -- which is how a missing branch reaches production while
 * its test reports full coverage.
 *
 * `hold` is CONDITIONAL: it appears only when the caller supplies a reading. It
 * is listed here because the question is "which ids exist", not "which appear on
 * every verdict".
 */
/**
 * The kinds of UNKNOWN (#165), from the least serious to the most. The direction
 * says each UNKNOWN names its kind and its next action, and only the last kind
 * reaches a person:
 *   waiting  something is still running or settling; reeve looks again when it's done
 *   retry    a read failed; reeve reads again, with backoff
 *   missing  something required was never produced; reeve asks for it
 *   person   only a person can settle it
 */
export const UNKNOWN_KINDS = Object.freeze(["waiting", "retry", "missing", "person"]);

export const CLAUSE_IDS = Object.freeze(
  ["ci", "base", "review", "rounds", "threads", "findings", "mergeable", "cleared", "hold",
   // CONDITIONAL too: only where the profile names where tasks live (#167).
   "acceptance",
   // Two facts about review BODIES, and they are separate because their answers
   // are. `bodyFindings` is work — a worker can fix one and a later round can
   // supersede it. `bodyReadable` is reeve reporting that it cannot parse a
   // reviewer's bodies at all, which no worker can act on and only the operator
   // can clear by declaring that reviewer. The watcher routes them to different
   // places, so one id could not have carried both.
   "bodyFindings", "bodyReadable"]);

export function computeVerdict(i) {
  const clauses = [];
  // An UNKNOWN clause also says what kind it is and what happens next (#165).
  const add = (id, state, detail, kind = null, next = null) =>
    clauses.push(state === UNKNOWN ? { id, state, detail, kind, next } : { id, state, detail });

  // 1. CI at the pinned head, settled. An unsettled green is a workflow that has
  //    not scheduled its jobs yet, which reads identically to a clean run.
  //
  //    Another App's check under reeve's own name comes first, settled or not:
  //    something is speaking for the gate, and only a person can clear that.
  const impostors = i.checks?.impostors ?? [];
  if (impostors.length) {
    const who = [...new Set(impostors.map(r => (r.app ? `the App ${r.app}` : "a commit status")))].join(" and ");
    add("ci", BLOCK, `a check under reeve's own name, ${impostors[0].name}, comes from ${who}, not from reeve`);
  }
  // A base that requires reeve's shadow check is gated by a result that never
  // fails: the shadow result passes the rule whatever reeve found.
  else if (i.checks?.shadowRequired) add("ci", BLOCK, "the base requires reeve's shadow check, whose result passes the rule whatever reeve finds");
  else if (i.checks?.legacyRequired)
    add("ci", BLOCK, `the base requires ${LEGACY_CONTEXTS.join(" or ")}, a name reeve published under before, whose old results pass the rule whatever reeve finds; require ${POLICY_CONTEXT} instead`);
  else if (!i.checks) add("ci", UNKNOWN, "no check reading", "retry", "read the head's checks again");
  // A read that failed is not a set still settling: only reading again settles it.
  else if (i.checks.readable === false) add("ci", UNKNOWN, i.checks.why ?? "the head's checks couldn't be read", "retry", "read the head's checks again");
  else if (!i.checks.settled) add("ci", UNKNOWN, `checks not settled: ${i.checks.verdict}${i.checks.why ? ` (${i.checks.why})` : ""}`, "waiting", "look again once the checks settle");
  else if (i.checks.verdict === "GREEN") {
    // Named, so a pass here is never read as the queue's own check having run (#286).
    const q = i.checks.queueOnly ?? [];
    // And what passed without running, or failed where no rule requires it, named too (#344).
    const decided = i.checks.decided ?? [], beside = i.checks.ancillaryFailing ?? [];
    add("ci", PASS, `${beside.length ? "every required check" : "all checks"} passing at the pinned head` +
      (q.length ? `; ${q.join(" and ")} ${q.length === 1 ? "runs" : "run"} only in the merge queue, and ${q.length === 1 ? "is" : "are"} judged at its commit` : "") +
      (decided.length ? `; ${decided.join(" and ")} skipped, as ${i.checks.decidedBy} decided` : "") +
      (beside.length ? `; ${beside.join(", ")} failing, which no rule requires` : ""));
  }
  else if (i.checks.verdict === "MISSING_REQUIRED" || i.checks.verdict === "SKIPPED_REQUIRED") add("ci", BLOCK, i.checks.why);
  else if (i.checks.verdict === "RED") {
    const names = (i.checks.failing ?? []).map(f => f?.name).filter(Boolean).join(", ") || "an unnamed check";
    // Inherited red is still red for THIS gate: merging it does not make the base
    // worse, but it also cannot be called green. The scheduler decides whether to
    // proceed; the verdict only reports.
    add("ci", BLOCK, `failing: ${names}${i.checks.inherited?.length ? ` (inherited from base: ${i.checks.inherited.join(", ")})` : ""}`);
  } else add("ci", UNKNOWN, `check verdict ${i.checks.verdict}${i.checks.why ? `: ${i.checks.why}` : ""}`, "retry", "read the head's checks again");

  // 2. The base's own health. GitHub does not check this when strict is false, so
  //    a PR can merge cleanly into a branch that is already broken.
  // Of a merge judged after it (#352): the base's checks that were running at the merge are taken as they ended.
  const after = i.base?.endedAfter?.length ? `; ${i.base.endedAfter.length} check(s) there finished after the merge, taken as they ended` : "";
  if (!i.base) add("base", UNKNOWN, "base health not read", "retry", "read the base branch's checks again");
  else if (i.base.verdict === "GREEN") {
    // A workflow no rule requires, failing there, is named, not held against the pull request (#288).
    const beside = i.base.ancillaryFailing ?? [];
    add("base", PASS, "base is green" + after + (beside.length ? `; ${beside.join(", ")} failing there, which no rule requires` : ""));
  }
  else if (i.base.verdict === "RED") {
    // The pull request that repairs a red base passes, at its own green head,
    // every check failing there. Blocked, it would leave the base red for good,
    // as nothing else could merge either (#286). A base failing a check the head
    // doesn't show passing, one that runs only there say, still blocks.
    // The same check, from the same App: another's of one name shows nothing.
    // And only from a base read whole, which a part may hide more failures on,
    // at a commit the head contains: one from before shows nothing repaired.
    /** @type {{ name: string, app: string | null }[]} */ const failing = i.base.failing ?? [];
    /** @type {{ name: string, app: string | null }[]} */ const passed = i.checks?.passed ?? [];
    if (failing.length && i.base.complete === true && i.base.inHead === true && i.checks?.verdict === "GREEN" && i.checks.settled
        && failing.every((f) => passed.some((p) => p.name === f.name && p.app === f.app)))
      add("base", PASS, `the base branch is red, and this pull request passes every check failing there (${[...new Set(failing.map((f) => f.name))].join(", ")}), so it repairs it` + after);
    else add("base", BLOCK, "the base branch is red; merging into it hides the next failure" + after);
  }
  else if (i.base.readable === false) add("base", UNKNOWN, `the base branch's checks couldn't be read${i.base.why ? `: ${i.base.why}` : ""}`, "retry", "read the base branch's checks again");
  // Of a merge judged after it, with every check of its base ended (#352): they are read as they ended, so reading again says the same.
  else if (i.base.stillRunning && !i.base.stillRunning.length) add("base", UNKNOWN, `base verdict ${i.base.verdict}: every check there has ended, and none says whether the base was healthy`, "person", "weigh the base the merge went onto by hand");
  else add("base", UNKNOWN, `base verdict ${i.base.verdict}${i.base.stillRunning?.length ? `: ${i.base.stillRunning.join(", ")} still running` : ""}`, "waiting", "look again once the base branch's checks settle");

  // 3. Review coverage AT THIS HEAD, per blocking reviewer. Four states, never two:
  //    a refusal is ABSENT, never a pass. 65 of 65 Codex comments on the last 40
  //    merged PRs were quota refusals; treating that as "found nothing" is what
  //    produced 116 unreviewed merges.
  const blocking = (i.reviewers ?? []).filter(r => r.kind === "blocking");
  if (!blocking.length) {
    add("review", PASS, "no blocking reviewer configured");
  } else {
    const covered = blocking.filter(r => r.state === "CLEAN" || r.state === "VERDICT");
    // Codex names the revision it read as an ABBREVIATED sha ("**Reviewed commit:**
    // `8356918648`"), so coverage is a prefix comparison in either direction, never
    // string equality. A reviewer that names no revision has not demonstrated
    // coverage of THIS one, whatever it says.
    const atHead = covered.filter(r => coversHead(r.reviewedHead, i.head));
    const unreachable = blocking.filter(r => r.state === "REFUSED" || r.state === "NOT_INSTALLED");
    const notRun = blocking.filter(r => r.state === "NOT_RUN");

    // Of a merge judged after it (#342): what a reviewer said in the merge's
    // very second, a pass or a refusal, can't be put before it or after.
    const unplaced = blocking.filter(r => r.state === "UNPLACED");

    if (atHead.length === blocking.length) add("review", PASS, `${blocking.length} blocking reviewer(s) covered at ${i.head?.slice(0, 8)}`);
    else if (unplaced.length) add("review", UNKNOWN, `${unplaced.map(r => r.login).join(", ")} said something in the very second of the merge, which can't be put before it or after`, "person", "a person reads what the reviewer said at the merge");
    else if (unreachable.length) add("review", UNKNOWN, `unreachable: ${unreachable.map(r => `${r.login}=${r.state}`).join(", ")} — absence is not approval`, "person", "a person makes a blocking reviewer reachable again");
    else if (notRun.length) add("review", UNKNOWN, `not yet run: ${notRun.map(r => r.login).join(", ")}`, "missing", "ask the reviewers for a round at this head");
    else add("review", BLOCK, `covered at a different revision: ${covered.map(r => `${r.login}@${(r.reviewedHead ?? "?").slice(0, 8)}`).join(", ")}`);
  }

  // 4. Round budget. Past the soft cap only P0/P1 keep the loop running, and a
  //    critical finding is never spilled to a follow-up.
  // The cap BLOCKS on `blockingCritical` and refuses to SPILL on
  // `unspilledCritical`, and they are different numbers on purpose. Blocking-ness
  // says whose opinion gates a merge; the spill rule says a critical is never
  // deferred whoever filed it. Sharing one number made an advisory reviewer's
  // critical escalate a pull request every gating clause had passed.
  const R = i.rounds;
  if (!R) add("rounds", PASS, "no round accounting");
  else if (R.n >= R.hardCap && R.blockingCritical > 0)
    add("rounds", BLOCK, `hard cap ${R.hardCap} reached with ${R.blockingCritical} P0/P1 finding(s) open from a blocking reviewer — escalate, never spill a critical`);
  else if (R.n >= R.softCap && R.blockingCritical > 0)
    add("rounds", BLOCK, `past soft cap ${R.softCap} with ${R.blockingCritical} critical finding(s) still open from a blocking reviewer`);
  // PAST THE CAP with an UNKNOWN critical count is not a pass.
  //
  // `null > 0` is false, so an unreadable projection fell straight through to the
  // pass below -- absence read as success, in the clause that exists to stop a
  // critical being carried past the budget. Only asked past the soft cap, because
  // below it the critical count changes nothing and claiming ignorance there
  // would make every pull request UNKNOWN for a fact that does not matter yet.
  // UNKNOWN only when the count COULD have been known. A projection that is
  // unreadable right now is a per-pull-request uncertainty and saying so is
  // honest. Review-body findings never being derived is neither uncertain nor
  // per-pull-request: it is an unbuilt capability, recorded elsewhere, and
  // reporting it here as UNKNOWN made every pull request past the cap UNKNOWN --
  // which the watcher handles before BLOCK findings, so the cap stopped every
  // repair instead of stopping a spill. Absence read as success was the defect;
  // absence read as paralysis is not the fix.
  // A missing count is now always transient -- the projection could not be read on
  // this tick -- so UNKNOWN is honest and clears itself. The PASS that used to sit
  // here existed because the count was permanently missing, and a permanent gap
  // reported as UNKNOWN stopped every remediation instead of stopping a spill.
  // That gap is closed: a body reeve cannot read is counted as one unknown
  // finding, so the cap is enforced rather than announced as unenforced.
  else if (R.n >= R.softCap && R.unspilledCritical == null)
    add("rounds", UNKNOWN, `past soft cap ${R.softCap} and reeve cannot say how many criticals are open`, "retry", "read the open findings again");
  else add("rounds", PASS, `round ${R.n} of ${R.softCap}/${R.hardCap}`);

  // 5. Unresolved threads. A truncated read is not zero: reviewThreads(first:100)
  //    has produced four consecutive false "zero unresolved" reports.
  if (!i.threads || i.threads.readable === false) add("threads", UNKNOWN, "thread state not readable", "retry", "read the review threads again");
  else if (i.threads.unresolved > 0) add("threads", BLOCK, `${i.threads.unresolved} of ${i.threads.total} thread(s) unresolved`);
  else add("threads", PASS, `0 of ${i.threads.total} threads unresolved`);

  // 5b. Threads a reviewer has not come back to. A DIFFERENT question from the one
  //     above, and the difference is why the fold exists.
  //
  //     Resolved is a CLAIM. The bot resolves its own threads -- eight on one pull
  //     request with nobody replying -- and `@coderabbitai resolve` is
  //     author-invokable and bulk-resolves. So a critical finding can leave the
  //     clause above by being marked resolved by the thing that filed it.
  //
  //     Cleared is EVIDENCE: a later substantive round by the same reviewer, at
  //     this head, has been and gone. Uncleared threads block independently of the
  //     round cap -- being under the cap is not a reason to accept a finding
  //     nobody came back to.
  //
  //     Scoped upstream to blocking reviewers, so an advisory reviewer going quiet
  //     cannot block a pull request for ever.
  if (!i.cleared || i.cleared.readable === false)
    add("cleared", UNKNOWN, `cannot say which threads a reviewer has returned to${i.cleared?.why ? ` — ${i.cleared.why}` : ""}`, "retry", "read which threads each reviewer returned to again");
  else if (i.cleared.uncleared > 0)
    add("cleared", BLOCK, `${i.cleared.uncleared} thread(s) that ${i.cleared.reviewers.join(", ") || "a blocking reviewer"} has not come back to`);
  else add("cleared", PASS, "every blocking reviewer's threads have been returned to");

  // 5c. Findings stated in a review BODY, which have no thread to resolve.
  //
  //     Their OWN clause, and that is the whole point of it. The `threads` clause
  //     reads GitHub's live count of unresolved threads, and a body finding is not
  //     one, so a body-only finding left it passing. `cleared` did block, but the
  //     watcher answers `cleared` by asking for another review round -- right for a
  //     thread nobody has come back to, wrong here, because the reviewer has
  //     already spoken and what is missing is the fix. Between them a body finding
  //     was derived, counted, and acted on by nothing.
  //
  //     Routed alongside `threads` and `findings` in the watcher, so it dispatches
  //     a worker rather than another request for a round.
  const B = i.bodyFindings;
  if (!B || B.readable === false)
    add("bodyFindings", UNKNOWN, `cannot say what a reviewer stated in a review body${B?.why ? ` — ${B.why}` : ""}`, "retry", "read the review bodies again");
  else if (B.open > 0)
    add("bodyFindings", BLOCK, `${B.open} finding(s) stated in a review body by ${B.reviewers.join(", ") || "a blocking reviewer"}, with no thread to resolve`);
  else add("bodyFindings", PASS, "no open review-body findings");

  // 5d. Bodies reeve could not READ, which is a different question from whether
  //     there are findings in them and must not share a clause with it.
  //
  //     Its own clause because its answer is its own too. A body finding is work:
  //     a worker can fix it and a reviewer can supersede it. This is neither. No
  //     code is wrong, no thread exists, and the only thing that clears it is the
  //     operator describing that reviewer in the profile — so the watcher routes
  //     it to a person rather than to a worker.
  //
  //     Every author counts, rostered or not. Blocking-ness says whose OPINION
  //     gates a merge; this is not an opinion, it is reeve reporting that it does
  //     not know what was said, and a stranger's unread body is exactly as unread
  //     as a configured reviewer's.
  const U = i.unreadableBodies;
  if (!U || U.readable === false)
    add("bodyReadable", UNKNOWN, `cannot say whether every review body was readable${U?.why ? ` — ${U.why}` : ""}`, "retry", "read the review bodies again");
  else if (U.open > 0)
    add("bodyReadable", BLOCK, `${U.open} review body/bodies from ${U.reviewers.join(", ")} that reeve cannot read — declare bodyFindings for them`);
  else add("bodyReadable", PASS, "every review body was readable");

  // 6. Ledger blockers. null means the store could not answer, which is not zero.
  //    The previous gate skipped this check entirely when the read failed.
  if (i.ledgerBlockers === null || i.ledgerBlockers === undefined) add("findings", UNKNOWN, "could not read blocking findings", "retry", "read the ledger's findings again");
  else if (i.ledgerBlockers > 0) add("findings", BLOCK, `${i.ledgerBlockers} active finding(s) block this PR`);
  else add("findings", PASS, "no active blocking findings");

  // 7b. A BUILDER HOLD. The builder wrote `pr_hold` deliberately and a founder
  //     clears it; the guardian's job is to render it, never to act on it.
  //
  //     ABSENT IS NOT THE SAME AS UNREADABLE. `openHold` answers three ways for
  //     that reason: no hold lets the PR proceed, an unreadable hub must not. A
  //     boolean here would make an unreachable hub read as "nothing is held",
  //     which is precisely the fail-open the guest connection exists to stop.
  //
  //     Omitted entirely when the caller passes nothing, rather than defaulting
  //     to UNKNOWN: a guardian built before the hub existed has no opinion about
  //     holds, and an UNKNOWN clause would drag every verdict it renders to
  //     UNKNOWN for a question it was never asked.
  // Acceptance evidence (#167), only where the profile names where tasks live:
  // each criterion of the task a pull request delivers evidenced in its
  // description. None asked of one that delivers no task, and a task whose
  // criteria can't be read is no evidence of none.
  if (i.acceptance) {
    const a = i.acceptance;
    const many = (a.tasks?.length ?? 0) > 1;
    const list = (/** @type {number[]} */ ns) => (ns.length > 1 ? `${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}` : String(ns[0]));
    if (a.readable === false) add("acceptance", UNKNOWN, a.why ?? "the task it delivers couldn't be read", "retry", "look for the task it delivers again");
    else if (!a.tasks?.length) add("acceptance", PASS, "delivers no task, so no acceptance evidence is asked for");
    else if (!a.criteria) add("acceptance", UNKNOWN, `the task${many ? "s" : ""} it delivers name${many ? "" : "s"} no acceptance criteria, so none can be evidenced`, "person", "a person writes the task's acceptance criteria");
    else if (a.missing?.length)
      add("acceptance", BLOCK, `no acceptance evidence for criteri${a.missing.length > 1 ? "a" : "on"} ${list(a.missing)} of the ${a.criteria} the task${many ? "s" : ""} delivered name${many ? "" : "s"}`);
    else add("acceptance", PASS, `acceptance evidence for each of the ${a.criteria} criteria the task${many ? "s" : ""} delivered name${many ? "" : "s"}`);
  }

  if (i.hold) {
    if (i.hold.readable === false) add("hold", UNKNOWN, `builder hold not readable: ${i.hold.why}`, "person", "a person makes the builder's holds readable");
    else if (i.hold.held) add("hold", BLOCK, i.hold.detail ? `${i.hold.reason}: ${i.hold.detail}` : String(i.hold.reason));
    else add("hold", PASS, "the builder has not held this PR");
  }

  // 7. GitHub's own mergeability. UNKNOWN is GitHub still computing; retry.
  //
  // BLOCKED counts reeve's own check once that check is required, and the check
  // can only pass once this verdict does: taking BLOCKED at its word blocked
  // every verdict after the first, for ever. So BLOCKED is taken apart, and it
  // passes only when reeve's check is the one thing left that can be blocking:
  // no conflict, no review outstanding, every other required check passing, no
  // unresolved conversation the base requires resolved, not behind a base that
  // wants branches up to date, and nothing required that reeve doesn't
  // evaluate. Anything else GitHub can be waiting for keeps it
  // from passing, because finding reeve's check among the requirements doesn't
  // make it the only one. This never looks at whether reeve's check is passing,
  // because a verdict that did would flip on each publish.
  const MS = String(i.mergeState ?? "").toUpperCase();
  const parts = i.mergeParts ?? null;
  if (!MS) add("mergeable", UNKNOWN, "mergeStateStatus not read", "retry", "read the merge state again");
  else if (MS === "CLEAN" || MS === "UNSTABLE") add("mergeable", PASS, MS);
  // A merge judged after it (#342), by GitHub's own record of the base's rules
  // judging its push: passed, or gone past by a bypass, which is no pass. That
  // GitHub merged it shows neither. No live pull request reads so: GitHub's
  // merge states have no MERGED.
  else if (MS === "MERGED") {
    const r = i.mergeRules;
    // A record GitHub doesn't keep is no more there on reading again; one that couldn't be read may be.
    if (r?.readable !== true && r?.absent) add("mergeable", UNKNOWN, `whether the base's rules passed at the merge can't be told: ${r.why}`, "person", "a person reads what the base's rules made of the merge");
    else if (r?.readable !== true) add("mergeable", UNKNOWN, `whether the base's rules passed at the merge can't be told: ${r?.why ?? "GitHub's record of them wasn't read"}`, "retry", "read GitHub's record of the base's rules at the merge again");
    else if (r.result === "pass") add("mergeable", PASS, "GitHub merged it, and the base's rules passed then");
    else if (r.result === "bypass") add("mergeable", BLOCK, `merged past the base's rules, by a bypass${r.failed?.length ? `: ${r.failed.join("; ")}` : ""}`);
    else add("mergeable", UNKNOWN, `GitHub's record of the base's rules at the merge reads ${r.result}, neither passed nor bypassed`, "person", "a person reads what the base's rules made of the merge");
  }
  else if (MS === "UNKNOWN") add("mergeable", UNKNOWN, "GitHub is still computing mergeability", "waiting", "look again once GitHub has computed mergeability");
  else if (MS === "BLOCKED" && parts?.readable === false) add("mergeable", UNKNOWN, "mergeStateStatus BLOCKED, and GitHub reported an error reading its parts", "retry", "read what the base requires again");
  else if (MS === "BLOCKED" && parts) {
    const review = parts.reviewDecision === "CHANGES_REQUESTED" || parts.reviewDecision === "REVIEW_REQUIRED";
    const others = (state) => (parts.others ?? []).filter((c) => c.state === state).map((c) => c.context);
    const failing = others("failing"), waiting = [...others("running"), ...others("superseded"), ...others("expired"), ...others("missing"), ...others("unknown")];
    if (parts.mergeable === "CONFLICTING") add("mergeable", BLOCK, "mergeStateStatus BLOCKED: the branch conflicts with its base");
    else if (review) add("mergeable", BLOCK, `mergeStateStatus BLOCKED: review ${parts.reviewDecision}`);
    else if (parts.ownCheckRequired === false) add("mergeable", BLOCK, "mergeStateStatus BLOCKED, and not by reeve's own check");
    else if (parts.ownCheckRequired === null) add("mergeable", UNKNOWN, "mergeStateStatus BLOCKED, and whether reeve's own required check is among the reasons couldn't be read", "retry", "read the base's rules again");
    else if (failing.length) add("mergeable", BLOCK, `mergeStateStatus BLOCKED: required check(s) not passing: ${failing.join(", ")}`);
    else if (parts.unresolvedBlocks === true) add("mergeable", BLOCK, "mergeStateStatus BLOCKED: the base requires every conversation resolved");
    else if (parts.strict === true && parts.behind > 0) add("mergeable", BLOCK, `mergeStateStatus BLOCKED: the base requires branches up to date, and this one is ${parts.behind} commit(s) behind`);
    else if (!Array.isArray(parts.others) || parts.unresolvedBlocks == null || !Array.isArray(parts.unevaluated)
             || parts.strict == null || (parts.strict && !Number.isInteger(parts.behind)))
      add("mergeable", UNKNOWN, "mergeStateStatus BLOCKED, and what else the base requires couldn't be read", "retry", "read the base's rules again");
    else if (waiting.length) add("mergeable", UNKNOWN, `mergeStateStatus BLOCKED, waiting for required check(s): ${waiting.join(", ")}`, "waiting", "look again once the required checks report");
    // Only a person settles the base's other requirements, unless a run settles
    // each of them without anyone. Unmarked, a requirement is a person's.
    else if (parts.unevaluated.length && parts.unevaluated.every((u) => Array.isArray(parts.settlesAlone) && parts.settlesAlone.includes(u))) add("mergeable", UNKNOWN, `mergeStateStatus BLOCKED, waiting for what the base requires that reeve doesn't evaluate and a run settles: ${parts.unevaluated.join(", ")}`, "waiting", "look again once the base's other requirements settle");
    else if (parts.unevaluated.length) add("mergeable", UNKNOWN, `mergeStateStatus BLOCKED, and the base requires what reeve doesn't evaluate: ${parts.unevaluated.join(", ")}`, "person", "a person decides whether the base's other requirements are met");
    else if (parts.mergeable !== "MERGEABLE") add("mergeable", UNKNOWN, `mergeStateStatus BLOCKED, and GitHub hasn't settled whether the branch merges (${parts.mergeable ?? "unread"})`, "waiting", "look again once GitHub settles whether the branch merges");
    else add("mergeable", PASS, "mergeStateStatus BLOCKED by reeve's own required check, which this verdict decides; nothing else the base requires is outstanding");
  }
  else add("mergeable", BLOCK, `mergeStateStatus ${MS}`);

  const state = clauses.reduce((acc, c) => worst(acc, c.state), PASS);
  // An UNKNOWN verdict carries the most serious kind among its UNKNOWN clauses.
  const kind = state === UNKNOWN
    ? clauses.filter(c => c.state === UNKNOWN).reduce((k, c) => (UNKNOWN_KINDS.indexOf(c.kind) > UNKNOWN_KINDS.indexOf(k) ? c.kind : k), UNKNOWN_KINDS[0])
    : null;
  return {
    state, head: i.head, clauses, ...(kind ? { kind } : {}),
    summary: state === PASS ? "every clause satisfied at this revision"
           : state === BLOCK ? clauses.filter(c => c.state === BLOCK).map(c => c.id).join(", ") + " blocked"
           : clauses.filter(c => c.state === UNKNOWN).map(c => c.id).join(", ") + " could not be determined",
  };
}

/** Render for a check-run output body, and for humans. Machine-readable block included. */
export function renderVerdict(v) {
  const mark = s => (s === PASS ? "PASS " : s === BLOCK ? "BLOCK" : "?????");
  const lines = [
    `${v.state} at ${v.head?.slice(0, 8) ?? "unknown"} — ${v.summary}`,
    "",
    ...v.clauses.map(c => `  ${mark(c.state)}  ${c.id.padEnd(10)} ${c.detail}`),
  ];
  if (v.state === UNKNOWN) {
    lines.push("", "A clause that could not be evaluated does not pass. Every fail-open defect",
                   "measured in the previous system was an UNKNOWN rendered as a PASS.");
  }
  // The verdict is an artifact, not prose: a consumer parses this rather than the text.
  lines.push("", "```json", JSON.stringify({ state: v.state, head: v.head, clauses: v.clauses }, null, 2), "```");
  return lines.join("\n");
}

/**
 * Publish. A check run is the real surface but requires a GitHub App; a user
 * token gets 403. Falls back to a commit status, which is weaker but still
 * bindable as a required context, and a required context that never reports
 * BLOCKS rather than merges — which is the fail-closed primitive.
 */
export function publishArgs(v, { nwo, context = POLICY_CONTEXT, asApp = false }) {
  const conclusion = v.state === PASS ? "success" : v.state === BLOCK ? "failure" : "action_required";
  if (asApp) {
    return {
      surface: "check_run",
      method: "POST", path: `repos/${nwo}/check-runs`,
      body: {
        name: context, head_sha: v.head, status: "completed", conclusion,
        output: { title: `${v.state}: ${v.summary}`, summary: renderVerdict(v) },
      },
    };
  }
  return {
    surface: "status",
    method: "POST", path: `repos/${nwo}/statuses/${v.head}`,
    body: {
      state: v.state === PASS ? "success" : v.state === BLOCK ? "failure" : "pending",
      context,
      description: `${v.state}: ${v.summary}`.slice(0, 140),
    },
  };
}
