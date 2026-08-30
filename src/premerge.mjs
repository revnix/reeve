/**
 * Should this merge happen? -- asked BEFORE it does.
 *
 * `mergecheck.mjs` answers the opposite question: did a merge carry what it should,
 * read afterwards from a merge commit. Same data, opposite direction, and different
 * consequences when wrong -- so this is its own module rather than a gate bolted
 * inside a verifier. It also keeps the two files singly owned, which two lanes
 * editing one file have already cost us today.
 *
 * It exists because two pull requests merged at a head their branch had moved past.
 * The second stranded two review fixes on the branch, and a third merged with a
 * review finding still open and its fix uncommitted. Every existing check answers
 * after the fact.
 *
 * PURE. It is given what was read and returns a verdict; nothing here talks to the
 * network, so every state below is reachable in a test.
 */

/** The branch tip is what would merge, and every thread is settled. */
export const CLEAR = "CLEAR";
/** A positively-read reason not to merge. */
export const REFUSE = "REFUSE";
/**
 * Nobody has reviewed it. NOT a pass, and this is the state most likely to be
 * argued away: `reviewThreads` returning an empty list means both "reviewed and
 * nothing was raised" and "never reviewed", and those are different facts. A pull
 * request nobody reviewed is not a pull request whose review is clear.
 */
export const UNREVIEWED = "UNREVIEWED";
/**
 * The read did not establish the thing. Absence of evidence, kept apart from
 * evidence of absence -- a truncated page, an unreadable ref listing and a fork
 * whose head repository could not be identified all land here rather than passing.
 */
export const UNKNOWN = "UNKNOWN";

/**
 * Thread state from ONE listing.
 *
 * `totalCount` against the number of nodes actually fetched is the completeness
 * signal: a page cap silently truncating the list would otherwise make a partial
 * read look clear, which is how "zero unresolved" becomes a lie.
 */
/**
 * GitHub's own answer to "can this merge", which this gate had been re-deriving.
 *
 * Four rounds of review each found another input to that question I had not
 * enumerated -- because the question is unbounded and GitHub already computes it.
 * Asking it is not laziness: `mergeStateStatus` folds in branch protection, required
 * reviews, conflicts, draft state and being behind the base, none of which this could
 * see and all of which decide whether a merge is possible.
 *
 * So mergeability is DELEGATED, and this module keeps only what GitHub does not
 * enforce: that the merge is bound to the head that was verified, and that review
 * evidence belongs to that head rather than to an earlier one.
 */
export function mergeabilityState({ mergeable, mergeStateStatus } = {}) {
  // MERGEABLE is GitHub's own tri-state and UNKNOWN means it is still computing.
  // Treating "not MERGEABLE" as a refusal would report a transient as a defect.
  if (mergeable === "CONFLICTING")
    return { state: REFUSE, why: "GitHub reports the branch as conflicting" };
  if (mergeable !== "MERGEABLE")
    return { state: UNKNOWN,
             why: `GitHub has not established mergeability (${mergeable ?? "unread"}); it computes this asynchronously` };
  // CLEAN and HAS_HOOKS are the two states that permit a merge. UNSTABLE means a
  // check failed and is caught by checkState with a better message, but it is named
  // here so this function's answer does not depend on the other running.
  const ok = new Set(["CLEAN", "HAS_HOOKS"]);
  const status = String(mergeStateStatus ?? "").toUpperCase();
  if (!status) return { state: UNKNOWN, why: "the merge state could not be read" };
  if (ok.has(status)) return { state: CLEAR, why: `GitHub reports the merge state as ${status}` };
  // UNKNOWN is GitHub STILL COMPUTING, exactly as it is for `mergeable`, and it
  // reaches this function even once mergeable has resolved. Falling through to REFUSE
  // reported an asynchronous transient as an actionable blocker, which a caller
  // keying on the exit codes would go and try to fix.
  if (status === "UNKNOWN")
    return { state: UNKNOWN, why: "GitHub has not finished computing the merge state; it does this asynchronously" };
  return { state: REFUSE, why: `GitHub reports the merge state as ${status}, which does not permit a merge` };
}

/**
 * Was this pull request REVIEWED, and does that answer belong to the current head?
 *
 * Three findings in one round showed a timestamp model cannot answer this, and they
 * were one mistake: I delegated mergeability to GitHub and then went on re-deriving
 * review state by hand, one layer in.
 *
 *   · a review anchored to head A can be SUBMITTED after head B is pushed, so its
 *     comment is newer than B while reviewing A;
 *   · an author with write access can add and resolve their own inline comment,
 *     manufacturing one resolved thread with nobody else having looked;
 *   · and `pushedDate` is nullable, so the rule disabled itself exactly when it could
 *     not tell -- fail-OPEN wearing the words of caution.
 *
 * `reviewDecision` is GitHub's own answer and is head-aware wherever the repository
 * dismisses stale reviews. Null means no review is REQUIRED, which is not the same as
 * one having been given, so it is UNREVIEWED rather than clear.
 */
export function reviewState({ reviewDecision } = {}) {
  const d = String(reviewDecision ?? "").toUpperCase();
  if (d === "APPROVED") return { state: CLEAR, why: "GitHub reports the review as APPROVED" };
  if (d === "CHANGES_REQUESTED") return { state: REFUSE, why: "GitHub reports CHANGES_REQUESTED" };
  if (d === "REVIEW_REQUIRED")
    return { state: UNREVIEWED, why: "GitHub reports REVIEW_REQUIRED, so nobody has approved this state" };
  return { state: UNREVIEWED,
           why: "GitHub reports no review decision, which means none is REQUIRED rather than that one was given" };
}

/**
 * Unresolved threads, which is a FACT rather than an inference.
 *
 * The half GitHub does not fold into `reviewDecision`: a thread can be open while a
 * pull request is approved. Whose review counts, and which head it was about, is
 * `reviewState`'s question -- answering it from a thread count is how an author
 * resolving their own comment could read as a review.
 */
export function threadState({ totalCount, nodes } = {}) {
  if (!Array.isArray(nodes) || typeof totalCount !== "number")
    return { state: UNKNOWN, unresolved: [], why: "the thread listing could not be read at all" };
  if (nodes.length !== totalCount)
    return { state: UNKNOWN, unresolved: [],
             why: `only ${nodes.length} of ${totalCount} threads were fetched, so "none unresolved" would be about a page rather than the pull request` };
  const unresolved = nodes.filter(n => !n?.isResolved);
  return unresolved.length
    ? { state: REFUSE, unresolved, why: `${unresolved.length} of ${totalCount} thread(s) are unresolved` }
    : { state: CLEAR, unresolved: [],
        why: totalCount === 0 ? "no threads were raised" : `all ${totalCount} thread(s) are resolved` };
}

/**
 * Head state: would the merge carry the branch's tip?
 *
 * The wording of a difference is deliberately weak, and stays weak. Unequal tips
 * prove only that the merge would take a commit the branch has moved past -- not
 * that anything is missing from the default branch, which a force-reset, a
 * cherry-pick or a second merge would also produce.
 */
export function headState({ prHead, branchNow, branchRead } = {}) {
  if (!prHead)
    return { state: UNKNOWN, why: "the pull request's head could not be read" };
  if (branchRead !== "read")
    return { state: UNKNOWN,
             why: branchRead === "gone"
               ? "the head branch is gone from its repository, so there is no tip to compare"
               : "the head repository's refs could not be read, which is not the same as the branch being absent" };
  if (prHead === branchNow)
    return { state: CLEAR, why: "the pull request's head is the branch tip" };
  // WHAT IS KNOWN, and no more. This wording has now been corrected three times, in
  // two tools, each time by weakening it. Unequal tips mean the merge takes a commit
  // the branch does not currently point at -- they do NOT mean work is lost: a
  // branch force-reset BACKWARD to an ancestor differs from the head while the head
  // still carries everything reachable from it. Establishing which needs an ancestry
  // read this deliberately does not make, so it says only what it measured and names
  // the check a person can run.
  return { state: REFUSE,
           why: `the merge would take ${String(prHead).slice(0, 7)} while the branch is at ${String(branchNow).slice(0, 7)}; ` +
                "whether that difference loses anything is NOT established here — " +
                `check with: git log --oneline ${String(prHead).slice(0, 12)}..${String(branchNow).slice(0, 12)}` };
}

/**
 * CI state from the rollup on the pull request's HEAD.
 *
 * Three distinct not-clear answers, and collapsing any of them into a pass is how a
 * merge lands on unfinished evidence -- which happened on this repository the same
 * day this gate was written.
 *
 *   no checks at all      a repository with no CI, or checks that never started.
 *                         "Nothing failed" is not "something passed".
 *   anything unfinished   a conclusion does not exist yet. Pending is the state a
 *                         merge button is most likely to be pressed during.
 *   anything failed       refuse, and name what.
 *
 * A LIMIT, stated rather than hidden: a successful conclusion is taken at face
 * value here. A job whose runner never started reports a conclusion with ZERO
 * steps, and telling those apart needs a per-job call this deliberately does not
 * make. The gate is about whether to merge NOW, and a zero-step success is a
 * different investigation.
 */
export function checkState({ nodes, totalCount = null } = {}) {
  if (!Array.isArray(nodes))
    return { state: UNKNOWN, failing: [], why: "the check rollup could not be read" };
  // THE SAME COMPLETENESS RULE AS THREADS, which this did not have. A rollup with
  // more than one page returns its first page silently, and a hundred passing checks
  // beside one omitted pending one read as CLEAR -- the gate defeated by the shape it
  // was built to catch, on the connection added last.
  if (totalCount !== null && nodes.length !== totalCount)
    return { state: UNKNOWN, failing: [],
             why: `only ${nodes.length} of ${totalCount} checks were fetched, so "all succeeded" would be about a page` };
  const runs = nodes.filter(Boolean);
  if (runs.length === 0)
    return { state: UNKNOWN, failing: [],
             why: "no checks ran at all, and nothing failing is not the same as something passing" };
  // A CheckRun reports a null conclusion while it runs; a legacy StatusContext has
  // no conclusion at all and reports progress in `state`, where PENDING and EXPECTED
  // are non-empty. Reading "has a value" as "finished" therefore cleared the gate for
  // a pull request whose only status was still pending -- the exact thing this
  // refuses for a CheckRun, passing through the other shape.
  //
  // So SUCCESS is named POSITIVELY and everything else is not-success. A state this
  // does not recognise lands in unfinished rather than in clear, which is the
  // direction that cannot silently pass.
  const norm = r => String(r.conclusion ?? r.state ?? "").toUpperCase();
  const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  // STALE is TERMINAL. It belongs with the failures rather than with the unfinished:
  // a stale run never completes, so reporting "has not finished" tells automation to
  // wait for something that will not arrive, and a retry loop never ends. The
  // distinction that matters here is not success-versus-failure but whether anything
  // further will happen.
  const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED",
                          "ERROR", "STARTUP_FAILURE", "STALE"]);
  const failing = runs.filter(r => FAILED.has(norm(r)));
  const unfinished = runs.filter(r => !FAILED.has(norm(r)) && !PASSED.has(norm(r)));
  if (failing.length)
    return { state: REFUSE, failing,
             why: `${failing.length} check(s) failed: ${failing.map(r => r.name ?? r.context ?? "?").join(", ")}` };
  if (unfinished.length)
    return { state: UNKNOWN, failing: [],
             why: `${unfinished.length} of ${runs.length} check(s) have not finished, so nothing about this commit is established yet` };
  return { state: CLEAR, failing: [], why: `all ${runs.length} check(s) succeeded` };
}

/**
 * The combined answer, and it never rounds up.
 *
 * REFUSE beats UNKNOWN beats UNREVIEWED beats CLEAR: the worst news wins, so no
 * summary line can read as a pass while carrying a reason not to merge. Both
 * reasons are always reported, because knowing only the first means fixing it and
 * being surprised by the second.
 */
export function gate({ head, threads, checks, mergeability, review } = {}) {
  const parts = [headState(head), threadState(threads), checkState(checks),
                 mergeabilityState(mergeability), reviewState(review)];
  const rank = { [REFUSE]: 3, [UNKNOWN]: 2, [UNREVIEWED]: 1, [CLEAR]: 0 };
  const state = parts.reduce((w, p) => (rank[p.state] > rank[w] ? p.state : w), CLEAR);
  // THE HEAD THIS VERDICT IS ABOUT, in full, so a caller can BIND the merge to it.
  //
  // `premerge && gh pr merge` has a window: a push can land between the read and the
  // merge, and the CLEAR then describes head A while GitHub merges head B. A gate
  // that returns success without giving the caller the means to close that window
  // has moved the race rather than removed it. `gh pr merge --match-head-commit SHA`
  // refuses when the head has moved, and this is the SHA to give it -- full, because
  // an abbreviation is not what that flag wants.
  return { state, head: parts[0], threads: parts[1], checks: parts[2], mergeability: parts[3], review: parts[4],
           clear: state === CLEAR,
           verifiedHead: head?.prHead ?? null,
           why: parts.map(p => `${p.state}: ${p.why}`) };
}
