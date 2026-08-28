// Is a merged pull request's content still on main?
//
// WHAT THIS COMPARES, AND WHY IT CHANGED. The first version compared main
// against the BRANCH HEAD, and that is wrong in the ordinary case. If main
// touches a pull request's file after the branch diverges, the squash correctly
// combines both edits -- so the merge's tree differs from the head's tree even
// though the pull request's change landed perfectly. MEASURED on a real git
// fixture: a branch editing line 1, a main editing line 3, and a GitHub-style
// squash produced `MISSING / NOT ON MAIN` over a merge whose content was
// demonstrably present. A false negative in the COMMON case, in a tool built to
// prevent false readings.
//
// THE SQUASH COMMIT IS WHAT MERGED, and it already incorporates whatever main
// did beforehand -- so comparing main against the squash is exact and cannot be
// confounded by a moving base. That is the question this answers:
//
//     for every path the pull request touched, is main's tree entry still the
//     one the merge produced?
//
// ANCESTRY STILL CANNOT ANSWER IT. This repository squash-merges, so the branch
// head is never an ancestor of main and `git merge-base --is-ancestor` gives the
// same answer for a merged pull request and an abandoned one. Subject lines are
// worse: a squash takes the pull request TITLE, so grepping main for an
// intermediate commit reports every one as missing. Both produced a false alarm
// here in one week.
//
// WHAT THIS DELIBERATELY NO LONGER CLAIMS. It does not tell you whether a commit
// pushed to the branch AFTER the merge was lost. A branch head differing from
// the squash has two causes -- a late push, or a base that moved before the
// merge -- and tree entries cannot distinguish them. That divergence is reported
// as an observation with both readings named, never as a verdict.

export const ABSENT = Symbol("absent");   // the revision was read; it holds no such path
export const UNREAD = Symbol("unread");   // the revision was not consulted at all

export const FILE_STATE = Object.freeze({
  intact: "INTACT",     // main's entry is the one the merge produced
  drifted: "DRIFTED",   // main has changed this path since the merge
  gone: "REMOVED",      // the merge left it absent, and main still has it absent
});

export const VERDICT = Object.freeze({
  intact: "MERGED, AND INTACT ON MAIN",
  drifted: "MERGED, THEN CHANGED ON MAIN",
  unreadable: "UNREADABLE",
});

const sameEntry = (a, b) => {
  if (a === UNREAD || b === UNREAD) return false;
  if (a === ABSENT || b === ABSENT) return a === b;
  return a.id === b.id && a.mode === b.mode;
};

const describe = (e) => e === ABSENT ? "absent" : e === UNREAD ? "unread" : `${e.mode} ${e.id}`;

/**
 * Classify every path the pull request touched.
 *
 * `entryAt(rev, path)` returns `{mode, id}` or `ABSENT`. It must NEVER return
 * `ABSENT` for a revision it could not read -- the caller proves each revision
 * readable first, because "I could not look" and "it is not there" are different
 * answers and only one of them is about the path.
 *
 * `head` is optional and is NOT used to decide the verdict. It is compared only
 * to report divergence, which is an observation rather than a finding.
 */
export function classifyFiles(paths, { squash, main, head = UNREAD, entryAt }) {
  return paths.map(path => {
    const atSquash = entryAt(squash, path);
    const atMain = entryAt(main, path);
    const atHead = head === UNREAD ? UNREAD : entryAt(head, path);
    const state = sameEntry(atSquash, atMain)
      ? (atSquash === ABSENT ? FILE_STATE.gone : FILE_STATE.intact)
      : FILE_STATE.drifted;
    return {
      path, state,
      squash: describe(atSquash), main: describe(atMain), head: describe(atHead),
      // Recorded, never decisive. See the header: two causes, indistinguishable.
      headDiffersFromMerge: atHead === UNREAD ? null : !sameEntry(atHead, atSquash),
    };
  });
}

/**
 * The verdict.
 *
 * AN EMPTY SET IS NOT A PASS. A pull request reporting zero changed paths is a
 * read that saw nothing, and answering "all intact" over nothing is how a
 * narrowing check reports success.
 */
export function verdictFor(files) {
  if (files.length === 0) {
    return { verdict: VERDICT.unreadable, counts: { intact: 0, drifted: 0, gone: 0, headDiverged: 0 },
             why: "the pull request reports zero changed paths, so there is nothing to compare. An empty set is not a pass." };
  }
  const counts = { intact: 0, drifted: 0, gone: 0, headDiverged: 0 };
  for (const f of files) {
    if (f.state === FILE_STATE.intact) counts.intact++;
    else if (f.state === FILE_STATE.drifted) counts.drifted++;
    else counts.gone++;
    if (f.headDiffersFromMerge === true) counts.headDiverged++;
  }
  const note = counts.headDiverged > 0
    ? `\n\nNote: ${counts.headDiverged} path(s) differ between the branch head and the merge. That has two causes and this cannot tell them apart:\n` +
      `  - commits pushed to the branch AFTER it merged, which reached nothing and are carried by no merge;\n` +
      `  - main having moved before the merge, which the squash correctly folded in.\n` +
      `Look at the branch if it matters. It is not evidence about main either way.`
    : "";
  if (counts.drifted > 0) {
    return { verdict: VERDICT.drifted, counts,
             why: `${counts.drifted} of ${files.length} path(s) on main differ from what the merge produced. The content arrived and something changed it since.\n` +
                  `That may be a legitimate follow-up or someone overwriting the work. This cannot tell which, and a human decides.${note}` };
  }
  return { verdict: VERDICT.intact, counts,
           why: `All ${files.length} path(s) on main are exactly what the merge produced, mode included.\n` +
                `Compared against the SQUASH COMMIT rather than the branch head: the squash already incorporates whatever main did before the merge, so a base that moved cannot make this read as missing.${note}` };
}

// Exit codes in the 15-125 band reeve owns. Node reserves 1 and 3-14 -- a
// rethrowing uncaughtException handler exits 7, an unsettled top-level await
// exits 13, and reeve has both -- bash owns 126-128+N, and launchd emits 78 into
// reeve's own log. Anything below 15 collides with something that is not reeve.
export const EXIT = Object.freeze({
  ok: 0,
  usage: 20,
  absent: 22,       // no such pull request, or it is not merged
  unreadable: 23,   // a revision, the file list, the base or the remote could not be trusted
  drifted: 32,      // it merged, and main has moved since
});

export function exitFor(verdict) {
  if (verdict === VERDICT.intact) return EXIT.ok;
  if (verdict === VERDICT.drifted) return EXIT.drifted;
  return EXIT.unreadable;
}

/**
 * Every path a pull request touched, INCLUDING the source side of a rename.
 * GitHub reports a rename as one entry carrying the destination and
 * `previous_filename`; checking only the destination misses half the change.
 */
export function pathsOf(files) {
  const out = [];
  for (const f of files) {
    if (f.filename) out.push(f.filename);
    if (f.previous_filename && f.previous_filename !== f.filename) out.push(f.previous_filename);
  }
  return [...new Set(out)];
}

/**
 * Render an API-supplied path safely.
 *
 * A filename is attacker-supplied on any repository that takes outside
 * contributions. A newline, a carriage return or an ANSI escape in one lets a
 * contributor overwrite the displayed verdict or forge a line that reads like a
 * successful result -- turning the report itself into the false reassurance this
 * tool exists to remove. Control characters become visible escapes. The JSON
 * output is left alone, because a consumer parses it rather than reading it.
 */
export function safePath(path) {
  // C0 is \u0000-\u001f, DEL is \u007f, C1 is \u0080-\u009f. Written as escapes
  // rather than literals so the pattern survives being copied through a shell.
  return String(path).replace(/[\u0000-\u001f\u007f-\u009f]/g,
    (c) => "\\x" + c.codePointAt(0).toString(16).padStart(2, "0"));
}
