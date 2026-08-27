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
 * @param {object} i.checks          {verdict, settled, failing[]} from the reconciler
 * @param {object} i.base            {verdict} for the base branch's own head
 * @param {object[]} i.reviewers     [{login, kind, state, reviewedHead}]
 * @param {object} i.rounds          {n, softCap, hardCap, unspilledCritical}
 * @param {object} i.threads         {unresolved, total, readable}
 * @param {number} i.ledgerBlockers  count of active findings blocking this PR, or null if unreadable
 * @param {string} i.mergeState      GitHub mergeStateStatus
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
export const CLAUSE_IDS = Object.freeze(
  ["ci", "base", "review", "rounds", "threads", "findings", "mergeable", "cleared", "hold"]);

export function computeVerdict(i) {
  const clauses = [];
  const add = (id, state, detail) => clauses.push({ id, state, detail });

  // 1. CI at the pinned head, settled. An unsettled green is a workflow that has
  //    not scheduled its jobs yet, which reads identically to a clean run.
  if (!i.checks) add("ci", UNKNOWN, "no check reading");
  else if (!i.checks.settled) add("ci", UNKNOWN, `checks not settled: ${i.checks.verdict}${i.checks.why ? ` (${i.checks.why})` : ""}`);
  else if (i.checks.verdict === "GREEN") add("ci", PASS, "all checks passing at the pinned head");
  else if (i.checks.verdict === "MISSING_REQUIRED") add("ci", BLOCK, i.checks.why);
  else if (i.checks.verdict === "RED") {
    const names = (i.checks.failing ?? []).map(f => f?.name).filter(Boolean).join(", ") || "an unnamed check";
    // Inherited red is still red for THIS gate: merging it does not make the base
    // worse, but it also cannot be called green. The scheduler decides whether to
    // proceed; the verdict only reports.
    add("ci", BLOCK, `failing: ${names}${i.checks.inherited?.length ? ` (inherited from base: ${i.checks.inherited.join(", ")})` : ""}`);
  } else add("ci", UNKNOWN, `check verdict ${i.checks.verdict}`);

  // 2. The base's own health. GitHub does not check this when strict is false, so
  //    a PR can merge cleanly into a branch that is already broken.
  if (!i.base) add("base", UNKNOWN, "base health not read");
  else if (i.base.verdict === "GREEN") add("base", PASS, "base is green");
  else if (i.base.verdict === "RED") add("base", BLOCK, "the base branch is red; merging into it hides the next failure");
  else add("base", UNKNOWN, `base verdict ${i.base.verdict}`);

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

    if (atHead.length === blocking.length) add("review", PASS, `${blocking.length} blocking reviewer(s) covered at ${i.head?.slice(0, 8)}`);
    else if (unreachable.length) add("review", UNKNOWN, `unreachable: ${unreachable.map(r => `${r.login}=${r.state}`).join(", ")} — absence is not approval`);
    else if (notRun.length) add("review", UNKNOWN, `not yet run: ${notRun.map(r => r.login).join(", ")}`);
    else add("review", BLOCK, `covered at a different revision: ${covered.map(r => `${r.login}@${(r.reviewedHead ?? "?").slice(0, 8)}`).join(", ")}`);
  }

  // 4. Round budget. Past the soft cap only P0/P1 keep the loop running, and a
  //    critical finding is never spilled to a follow-up.
  const R = i.rounds;
  if (!R) add("rounds", PASS, "no round accounting");
  else if (R.n >= R.hardCap && R.unspilledCritical > 0)
    add("rounds", BLOCK, `hard cap ${R.hardCap} reached with ${R.unspilledCritical} P0/P1 finding(s) open — escalate, never spill a critical`);
  else if (R.n >= R.softCap && R.unspilledCritical > 0)
    add("rounds", BLOCK, `past soft cap ${R.softCap} with ${R.unspilledCritical} critical finding(s) still open`);
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
    add("rounds", UNKNOWN, `past soft cap ${R.softCap} and reeve cannot say how many criticals are open`);
  else add("rounds", PASS, `round ${R.n} of ${R.softCap}/${R.hardCap}`);

  // 5. Unresolved threads. A truncated read is not zero: reviewThreads(first:100)
  //    has produced four consecutive false "zero unresolved" reports.
  if (!i.threads || i.threads.readable === false) add("threads", UNKNOWN, "thread state not readable");
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
    add("cleared", UNKNOWN, `cannot say which threads a reviewer has returned to${i.cleared?.why ? ` — ${i.cleared.why}` : ""}`);
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
    add("bodyFindings", UNKNOWN, `cannot say what a reviewer stated in a review body${B?.why ? ` — ${B.why}` : ""}`);
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
    add("bodyReadable", UNKNOWN, `cannot say whether every review body was readable${U?.why ? ` — ${U.why}` : ""}`);
  else if (U.open > 0)
    add("bodyReadable", BLOCK, `${U.open} review body/bodies from ${U.reviewers.join(", ")} that reeve cannot read — declare bodyFindings for them`);
  else add("bodyReadable", PASS, "every review body was readable");

  // 6. Ledger blockers. null means the store could not answer, which is not zero.
  //    The previous gate skipped this check entirely when the read failed.
  if (i.ledgerBlockers === null || i.ledgerBlockers === undefined) add("findings", UNKNOWN, "could not read blocking findings");
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
  if (i.hold) {
    if (i.hold.readable === false) add("hold", UNKNOWN, `builder hold not readable: ${i.hold.why}`);
    else if (i.hold.held) add("hold", BLOCK, i.hold.detail ? `${i.hold.reason}: ${i.hold.detail}` : String(i.hold.reason));
    else add("hold", PASS, "the builder has not held this PR");
  }

  // 7. GitHub's own mergeability. UNKNOWN is GitHub still computing; retry.
  const MS = String(i.mergeState ?? "").toUpperCase();
  if (!MS) add("mergeable", UNKNOWN, "mergeStateStatus not read");
  else if (MS === "CLEAN" || MS === "UNSTABLE") add("mergeable", PASS, MS);
  else if (MS === "UNKNOWN") add("mergeable", UNKNOWN, "GitHub is still computing mergeability");
  else add("mergeable", BLOCK, `mergeStateStatus ${MS}`);

  const state = clauses.reduce((acc, c) => worst(acc, c.state), PASS);
  return {
    state, head: i.head, clauses,
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
export function publishArgs(v, { nwo, context = "ops/merge-policy", asApp = false }) {
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
