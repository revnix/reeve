// Did a pull request's content actually reach main?
//
// ANCESTRY CANNOT ANSWER THIS, and neither can a subject line. The repository
// squash-merges: the merge collapses a branch into one new commit with a new
// tree, so the branch head is NEVER an ancestor of main and
// `git merge-base --is-ancestor` says "no" for a merged pull request and an
// abandoned one alike. The squash also takes the PULL REQUEST TITLE, so grepping
// main for an intermediate commit's subject reports every one of them missing.
//
// Both instruments have produced a false alarm here. The subject check reported
// four fixes lost when one was, at the moment someone was trying to find out
// whether a fix had been lost -- which is when an instrument earns its keep or
// does not.
//
// The question that CAN be answered: for each file the pull request touched, is
// the blob on main identical to the blob at the pull request's head? That is
// content. It does not care how the commit got there, and it is what "merged"
// has to mean.
//
// The logic lives here rather than in the script so it can be tested without a
// network: `scripts/verify-merge.mjs` is the shell that fetches, exactly as
// `scripts/capture-baseline.mjs` delegates to `src/baseline.mjs`.

/** The states a file can be in, and the four are not two. */
export const FILE_STATE = Object.freeze({
  matches: "MATCHES",   // main's blob equals the head's blob
  drifted: "DRIFTED",   // it equalled the head at the squash commit, and main has moved since
  missing: "MISSING",   // it matches neither: the content did not arrive
  deleted: "deleted",   // absent from head and from main alike, which is consistent
});

/** The verdict for the whole pull request. */
export const VERDICT = Object.freeze({
  merged: "MERGED BY CONTENT",
  moved: "MERGED, THEN MOVED",
  absent: "NOT ON MAIN",
  empty: "UNREADABLE",
});

/**
 * Classify one pull request's files.
 *
 * `blobAt(rev, path)` returns the blob id or `null` when the path does not exist
 * at that revision. It is injected so this is testable with no repository at
 * all; the script passes one that shells to `git rev-parse`.
 *
 * `squash` may be null, and then DRIFTED cannot be distinguished from MISSING --
 * so it is reported as MISSING, which is the answer that prompts a look rather
 * than the one that reassures.
 */
export function classifyFiles(paths, { head, main, squash = null, blobAt }) {
  return paths.map(path => {
    const atHead = blobAt(head, path);
    const atMain = blobAt(main, path);
    const atSquash = squash ? blobAt(squash, path) : null;
    let state;
    if (atHead === null && atMain === null) state = FILE_STATE.deleted;
    else if (atHead === atMain) state = FILE_STATE.matches;
    else if (atSquash !== null && atSquash === atHead) state = FILE_STATE.drifted;
    else state = FILE_STATE.missing;
    return { path, state, head: atHead, main: atMain, squash: atSquash };
  });
}

/**
 * The verdict over classified files.
 *
 * AN EMPTY SET IS NOT A PASS. A pull request reporting zero changed files is a
 * read that saw nothing, and answering "all files match" over nothing is how a
 * narrowing check reports success -- the same shape as a grep whose pattern
 * cannot match reporting an absence. It returns UNREADABLE so the caller looks.
 *
 * MISSING outranks DRIFTED: if any file did not arrive at all, that is the
 * headline, and a second file having moved afterwards does not soften it.
 */
export function verdictFor(files) {
  if (files.length === 0) {
    return { verdict: VERDICT.empty, counts: { matches: 0, drifted: 0, missing: 0, deleted: 0 },
             why: "the pull request reports zero changed files, so there is nothing to compare. An empty set is not a pass." };
  }
  const counts = { matches: 0, drifted: 0, missing: 0, deleted: 0 };
  for (const f of files) {
    if (f.state === FILE_STATE.matches) counts.matches++;
    else if (f.state === FILE_STATE.drifted) counts.drifted++;
    else if (f.state === FILE_STATE.missing) counts.missing++;
    else counts.deleted++;
  }
  if (counts.missing > 0) {
    return { verdict: VERDICT.absent, counts,
             why: `${counts.missing} of ${files.length} file(s) on main match neither the head nor the squash commit. The content did not arrive.\n` +
                  `A common cause: a fix pushed to the branch AFTER the pull request merged. That push succeeds and reaches nothing.` };
  }
  if (counts.drifted > 0) {
    return { verdict: VERDICT.moved, counts,
             why: `${counts.drifted} file(s) matched at the squash commit and differ on main now. The content DID arrive, and something changed it since.\n` +
                  `That may be a legitimate follow-up or someone overwriting the work. This cannot tell which, and a human decides.` };
  }
  return { verdict: VERDICT.merged, counts,
           why: `All ${counts.matches + counts.deleted} file(s) on main are byte-identical to the pull request head.\n` +
                `Verified by blob hash, not by ancestry: the branch commit is not an ancestor of main and never will be, because this repository squash-merges.` };
}

// Exit codes in the 15-125 band reeve owns. Node reserves 1 and 3-14 -- a
// rethrowing uncaughtException handler exits 7, an unsettled top-level await
// exits 13, and reeve has both -- bash owns 126-128+N, and launchd emits 78
// into reeve's own log. Anything below 15 collides with something that is not
// reeve, and the collision is invisible until a wrapper acts on it.
export const EXIT = Object.freeze({
  ok: 0,
  usage: 20,
  absent: 22,       // no such pull request, or it is not merged yet
  unreadable: 23,   // git or gh could not answer, or there was nothing to compare
  no: 31,           // measured negative: the content did not arrive
  drifted: 32,      // it arrived, and main has moved since
});

export function exitFor(verdict) {
  if (verdict === VERDICT.merged) return EXIT.ok;
  if (verdict === VERDICT.absent) return EXIT.no;
  if (verdict === VERDICT.moved) return EXIT.drifted;
  return EXIT.unreadable;
}
