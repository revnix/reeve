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
// WHERE THE PATHS COME FROM, AND WHY NOT THE API. The set of paths to check is
// taken from the SQUASH COMMIT'S OWN DIFF, not from `pulls/<n>/files`. That
// endpoint describes the branch HEAD, which a push after the merge moves -- so a
// late commit that restores one path and touches another changes the list
// without changing its length, and the omitted path goes unchecked while the
// count still agrees. The merge's diff is the exact set the merge produced, it
// needs no network, and it cannot be edited after the fact.
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
export function verdictFor(files, { branchOnly = [], crossCheck = "complete", squashProven = false } = {}) {
  if (files.length === 0) {
    return { verdict: VERDICT.unreadable, counts: { intact: 0, drifted: 0, gone: 0, headDiverged: 0 },
             why: "the merge commit's own diff names zero paths, so there is nothing to compare. An empty set is not a pass." };
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
  // Paths the branch touches that this MERGE did not produce. Benign for a late
  // push; NOT benign if the merge commit is a rebase tip, where the earlier
  // commits' paths are simply unverified. Both readings named, neither asserted
  // -- and named LOUDLY, because "not covered" read as "covered" is exactly the
  // false reassurance this tool exists to remove.
  const uncovered = branchOnly.length > 0
    ? `\n\nNOT COVERED BY THE VERDICT ABOVE: ${branchOnly.length} path(s) appear in the pull request's file list but are absent from this merge commit's diff:\n` +
      branchOnly.map(p => `  - ${safePath(p)}`).join("\n") +
      `\nTwo causes, and this cannot tell them apart:\n` +
      `  - commits pushed to the branch AFTER it merged, which this merge correctly does not carry, and which are fine to ignore;\n` +
      `  - a merge that is not a squash of the whole branch (a rebase merge names only its LAST commit), in which case those paths are UNVERIFIED and the verdict below covers less than the pull request.\n` +
      `Look at the branch if it matters.`
    : "";
  const incomplete = crossCheck !== "complete"
    ? `\n\nThe cross-check against the pull request's file list could not be completed (${crossCheck}), so paths the merge did not produce may exist and not be listed above. The verdict itself is unaffected: it is computed from the merge commit's own diff, which was read locally.`
    : "";
  const note2 = note + uncovered + incomplete;
  if (counts.drifted > 0) {
    return { verdict: VERDICT.drifted, counts,
             why: `${counts.drifted} of ${files.length} path(s) on main differ from what the merge produced. The content arrived and something changed it since.\n` +
                  `That may be a legitimate follow-up or someone overwriting the work. This cannot tell which, and a human decides.${note2}` };
  }
  // A PASS IS THE ONLY DANGEROUS VERDICT, so it is the only one this blocks.
  // DRIFTED already exits non-zero and sends a human to look; withholding it in
  // favour of UNREADABLE would lose a concrete finding to an uncertainty.
  //
  // Why a note is not enough here: the exit code IS the verdict to anything that
  // consumes this in a script, and prose is invisible to `verify-merge && merge`.
  // If a rebase merge named only its last commit, the earlier commits' paths are
  // in branchOnly and were never compared -- exit 0 would report a pass over
  // work nothing checked. Same for a cross-check that could not run: it is the
  // only thing that would have revealed such paths at all.
  if (!squashProven && (branchOnly.length > 0 || crossCheck !== "complete")) {
    return { verdict: VERDICT.unreadable, counts,
             why: `every path this merge produced is intact on main, but the merge cannot be shown to cover the whole pull request, so this is NOT a pass.\n` +
                  (branchOnly.length > 0
                    ? `${branchOnly.length} path(s) the pull request touches are absent from the merge commit's diff and were never compared.\n`
                    : `the cross-check that would reveal such paths could not be completed.\n`) +
                  `A squash merge carries the whole branch; a REBASE merge names only its last commit, and this repository permits rebase merges, so the two cannot be told apart from here.\n` +
                  `Disable rebase merges on the repository, or check the uncovered paths by hand.${note2}` };
  }
  return { verdict: VERDICT.intact, counts,
           why: `All ${files.length} path(s) on main are exactly what the merge produced, mode included.\n` +
                `Compared against the SQUASH COMMIT rather than the branch head: the squash already incorporates whatever main did before the merge, so a base that moved cannot make this read as missing.${note2}` };
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
 * The git reads this needs, over an injected runner.
 *
 * `run(args)` executes git with `args` and returns stdout. It is injected so the
 * ARGUMENT LISTS are testable without a repository: three of the properties here
 * are properties of the argv itself -- `--literal-pathspecs` on every call,
 * `--no-renames` and `-z` on the enumeration, and a PINNED sha rather than the
 * name `origin/main` -- and a property nothing can observe is a property nothing
 * defends. Each was a review finding whose fix would otherwise have shipped with
 * no test able to fail on its removal.
 */
export function gitFacts(run) {
  // `--literal-pathspecs` FIRST and on every call: a filename is
  // attacker-supplied, and git reads a leading `:` as pathspec magic, so
  // `:(literal):foo` would send a lookup after `:foo` instead. It also disables
  // wildcards, so a filename containing `*` cannot match some other file.
  // `--no-replace-objects` too: a `refs/replace/*` entry -- one left behind by
  // `git replace` during history inspection, say -- transparently substitutes a
  // different object for the one an OID names, and fetching does not clear them.
  // A replacement tree that happens to match main would produce a clean verdict
  // over an object that is NOT the squash GitHub reported.
  const g = (...args) => run(["--literal-pathspecs", "--no-replace-objects", ...args]);
  return {
    // Resolved to an object id, because `origin/main` is MUTABLE: left as a
    // name, each lookup re-resolves it and a concurrent fetch can serve some
    // paths from the old main and some from the new.
    pinMain: () => g("rev-parse", "origin/main^{commit}").trim(),
    // Through `g` like every other read, so "every git call this makes carries
    // --literal-pathspecs" is one uniform invariant a test can assert, rather
    // than a per-call judgement that rots the first time a call is added.
    parentsOf: (rev) => g("rev-list", "--parents", "-n", "1", rev).trim().split(/\s+/).slice(1),
    // `--no-renames` so a rename cannot collapse to its destination and drop the
    // source side -- `diff.renames` is a repository setting, and this must not
    // depend on it. `-z` because a filename may contain a newline, which git
    // would otherwise quote into a different string.
    // NOT trimmed: a filename may BEGIN with a space or a tab, and trimming the
    // -z output strips that byte off the FIRST path, sending the lookup after a
    // different name -- absent from both revisions, so it classifies REMOVED,
    // which is a passing state, over a path that may have drifted.
    mergePaths: (rev) =>
      g("diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", rev)
        .split("\0").filter(Boolean),
    // TREE ENTRY, not blob: mode lives in the tree, so an executable bit that
    // never arrived shares its blob id with the version that did.
    entryAt: (rev, path) => {
      const out = g("ls-tree", "--full-tree", rev, "--", path).trim();
      if (!out) return ABSENT;
      const [mode, , id] = out.slice(0, out.indexOf("\t")).split(/\s+/);
      return { mode, id };
    },
  };
}

/**
 * Paths the pull request's file list names that the merge commit did not
 * produce. Reported, never subtracted from the verdict: the verdict is about
 * what the merge did, and these are by definition not part of it.
 */
export function branchOnlyPaths(apiPaths, mergePaths) {
  const produced = new Set(mergePaths);
  return apiPaths.filter(p => !produced.has(p));
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
