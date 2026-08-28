// Did a pull request's content actually reach main?
//
// ANCESTRY CANNOT ANSWER THIS, and neither can a subject line. The repository
// squash-merges: the merge collapses a branch into one new commit with a new
// tree, so the branch head is NEVER an ancestor of main and
// `git merge-base --is-ancestor` says "no" for a merged pull request and an
// abandoned one alike. The squash also takes the PULL REQUEST TITLE, so grepping
// main for an intermediate commit's subject reports every one of them missing.
//
// Both instruments produced a false alarm here in one week. The subject check
// reported four fixes lost when one was -- at the moment someone was trying to
// find out whether a fix had been lost, which is when an instrument earns its
// keep or does not.
//
// The question that CAN be answered: for each path the pull request touched, is
// the TREE ENTRY on main identical to the tree entry at the pull request's head?
// Entry, not blob: the executable bit and the symlink flag live in the tree, so
// two revisions can share a blob id and still differ in a way that matters --
// a script that is no longer executable has the same bytes it always had.
//
// The logic lives here rather than in the script so it can be tested without a
// network, exactly as `scripts/capture-baseline.mjs` delegates to
// `src/baseline.mjs`.

/**
 * THREE ANSWERS, NOT TWO, and conflating them is the defect this module exists
 * to avoid making itself.
 *
 * `ABSENT` -- the revision was read and the path is not in it. A fact.
 * `UNREAD`  -- the revision was not consulted at all. NOT a fact about the path.
 *
 * They were one value (`null`) in the first version, and it produced a real
 * defect: a pull request that DELETES a file, where main later restores it,
 * has the path absent at head and absent at the squash -- which is arrival
 * followed by drift. Collapsed into `null` it read as "never arrived" and the
 * verifier said NOT ON MAIN over a change that had landed correctly.
 */
export const ABSENT = Symbol("absent");
export const UNREAD = Symbol("unread");

export const FILE_STATE = Object.freeze({
  matches: "MATCHES",   // main's entry equals the head's entry, mode included
  drifted: "DRIFTED",   // it equalled the head at the squash commit, and main has moved since
  missing: "MISSING",   // it matches neither: the content did not arrive
  deleted: "deleted",   // absent from head and from main alike, which is consistent
});

export const VERDICT = Object.freeze({
  merged: "MERGED BY CONTENT",
  moved: "MERGED, THEN MOVED",
  absent: "NOT ON MAIN",
  unreadable: "UNREADABLE",
});

/** Two tree entries are the same when the object AND the mode agree. */
const sameEntry = (a, b) => {
  if (a === UNREAD || b === UNREAD) return false;
  if (a === ABSENT || b === ABSENT) return a === b;
  return a.id === b.id && a.mode === b.mode;
};

/**
 * Classify one pull request's paths.
 *
 * `entryAt(rev, path)` returns `{mode, id}`, or `ABSENT` when the revision was
 * read and holds no such path. It must NEVER return `ABSENT` for a revision it
 * could not read -- the caller raises UNREADABLE for that case before getting
 * here, because "I could not look" and "it is not there" are different answers
 * and only one of them is about the path.
 *
 * `squash` may be `UNREAD`, meaning no squash commit was available. Then DRIFTED
 * cannot be distinguished from MISSING, and the result degrades to MISSING --
 * the answer that prompts a look, never the reassuring one.
 */
export function classifyFiles(paths, { head, main, squash = null, entryAt }) {
  const readSquash = squash !== null && squash !== UNREAD;
  return paths.map(path => {
    const atHead = entryAt(head, path);
    const atMain = entryAt(main, path);
    const atSquash = readSquash ? entryAt(squash, path) : UNREAD;
    let state;
    if (atHead === ABSENT && atMain === ABSENT) state = FILE_STATE.deleted;
    else if (sameEntry(atHead, atMain)) state = FILE_STATE.matches;
    // The squash comparison runs even when both sides are ABSENT: a deletion
    // that arrived and was later undone is drift, not absence.
    else if (sameEntry(atHead, atSquash)) state = FILE_STATE.drifted;
    else state = FILE_STATE.missing;
    return { path, state, head: describe(atHead), main: describe(atMain), squash: describe(atSquash) };
  });
}

const describe = (e) =>
  e === ABSENT ? "absent" : e === UNREAD ? "unread" : `${e.mode} ${e.id}`;

/**
 * The verdict over classified paths.
 *
 * AN EMPTY SET IS NOT A PASS. A pull request reporting zero changed files is a
 * read that saw nothing, and answering "all files match" over nothing is how a
 * narrowing check reports success. It returns UNREADABLE so the caller looks.
 *
 * MISSING outranks DRIFTED: if any path did not arrive at all, that is the
 * headline, and another having moved afterwards does not soften it.
 */
export function verdictFor(files) {
  if (files.length === 0) {
    return { verdict: VERDICT.unreadable, counts: { matches: 0, drifted: 0, missing: 0, deleted: 0 },
             why: "the pull request reports zero changed paths, so there is nothing to compare. An empty set is not a pass." };
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
             why: `${counts.missing} of ${files.length} path(s) on main match neither the head nor the squash commit. The content did not arrive.\n` +
                  `A common cause: a fix pushed to the branch AFTER the pull request merged. That push succeeds and reaches nothing.` };
  }
  if (counts.drifted > 0) {
    return { verdict: VERDICT.moved, counts,
             why: `${counts.drifted} path(s) matched at the squash commit and differ on main now. The content DID arrive, and something changed it since.\n` +
                  `That may be a legitimate follow-up or someone overwriting the work. This cannot tell which, and a human decides.` };
  }
  return { verdict: VERDICT.merged, counts,
           why: `All ${counts.matches + counts.deleted} path(s) on main are identical to the pull request head, mode included.\n` +
                `Verified by tree entry, not by ancestry: the branch commit is not an ancestor of main and never will be, because this repository squash-merges.` };
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
  unreadable: 23,   // a revision, the file list, or the remote could not be read
  no: 31,           // measured negative: the content did not arrive
  drifted: 32,      // it arrived, and main has moved since
});

export function exitFor(verdict) {
  if (verdict === VERDICT.merged) return EXIT.ok;
  if (verdict === VERDICT.absent) return EXIT.no;
  if (verdict === VERDICT.moved) return EXIT.drifted;
  return EXIT.unreadable;
}

/**
 * Every path a pull request touched, INCLUDING the source side of a rename.
 *
 * GitHub reports a rename as one entry carrying the destination and
 * `previous_filename`. Checking only the destination misses half the change: if
 * main later restores the old path while keeping the new one, every path checked
 * matches the head and the verifier exits 0 over a tree that has drifted.
 *
 * The old path is expected to be ABSENT at head, so it verifies as a deletion,
 * which is exactly what a rename is on that side.
 */
export function pathsOf(files) {
  const out = [];
  for (const f of files) {
    if (f.filename) out.push(f.filename);
    if (f.previous_filename && f.previous_filename !== f.filename) out.push(f.previous_filename);
  }
  return [...new Set(out)];
}
