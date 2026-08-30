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
export function threadState({ totalCount, nodes } = {}) {
  if (!Array.isArray(nodes) || typeof totalCount !== "number")
    return { state: UNKNOWN, unresolved: [], why: "the thread listing could not be read at all" };
  if (nodes.length !== totalCount)
    return { state: UNKNOWN, unresolved: [],
             why: `only ${nodes.length} of ${totalCount} threads were fetched, so "none unresolved" would be about a page rather than the pull request` };
  if (totalCount === 0)
    return { state: UNREVIEWED, unresolved: [],
             why: "no review threads exist, which is not the same as a review that raised nothing" };
  const unresolved = nodes.filter(n => !n?.isResolved);
  return unresolved.length
    ? { state: REFUSE, unresolved,
        why: `${unresolved.length} of ${totalCount} thread(s) are unresolved` }
    : { state: CLEAR, unresolved: [], why: `all ${totalCount} thread(s) are resolved` };
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
  return { state: REFUSE,
           why: `the merge would take ${String(prHead).slice(0, 7)} while the branch is at ${String(branchNow).slice(0, 7)} — ` +
                "commits on the branch would not be carried" };
}

/**
 * The combined answer, and it never rounds up.
 *
 * REFUSE beats UNKNOWN beats UNREVIEWED beats CLEAR: the worst news wins, so no
 * summary line can read as a pass while carrying a reason not to merge. Both
 * reasons are always reported, because knowing only the first means fixing it and
 * being surprised by the second.
 */
export function gate({ head, threads } = {}) {
  const parts = [headState(head), threadState(threads)];
  const rank = { [REFUSE]: 3, [UNKNOWN]: 2, [UNREVIEWED]: 1, [CLEAR]: 0 };
  const state = parts.reduce((w, p) => (rank[p.state] > rank[w] ? p.state : w), CLEAR);
  return { state, head: parts[0], threads: parts[1],
           clear: state === CLEAR,
           why: parts.map(p => `${p.state}: ${p.why}`) };
}
