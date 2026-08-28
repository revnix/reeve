// Is a merged pull request's content still on main?
//
// Why this is tested at all: the checks it replaces were ancestry, which this
// repository's squash merges make permanently false, and a subject-line grep,
// which reported four fixes lost when one was. Both were reached for at the
// moment the answer mattered. A replacement that were itself untested would be
// the third instrument nobody had seen fail.
//
// Every case injects `entryAt`, so no repository, no network and no `gh` are
// involved, and the classification can be driven into states a real merge would
// take days to produce.

import { classifyFiles, verdictFor, pathsOf, safePath, exitFor,
         FILE_STATE, VERDICT, EXIT, ABSENT } from "../src/mergecheck.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// A fixture tree as a table: trees[rev][path] = "<mode> <id>". A path absent
// from a listed revision means the revision was read and holds no such path.
const fixture = (trees) => (rev, path) => {
  const t = trees[rev] ?? {};
  if (!Object.hasOwn(t, path)) return ABSENT;
  const [mode, id] = t[path].split(" ");
  return { mode, id };
};
const H = "head", M = "origin/main", S = "squash";
const F = "100644", X = "100755", L = "120000";

// --- THE CASE THAT FORCED THE REDESIGN --------------------------------------
// Main touches a pull request's file after the branch diverges. The squash
// correctly combines both edits, so the merge's tree differs from the HEAD's
// tree even though the pull request's change landed perfectly.
//
// MEASURED on a real git fixture -- a branch editing line 1, a main editing
// line 3, a GitHub-style squash -- the head-based comparison returned
// MISSING / NOT ON MAIN over content that was demonstrably present. A false
// negative in the COMMON case, in a tool built to prevent false readings.
{
  const entryAt = fixture({ [H]: { "f.txt": `${F} pr-only` },        // the branch's tree
                            [S]: { "f.txt": `${F} pr-plus-main` },   // both edits, folded
                            [M]: { "f.txt": `${F} pr-plus-main` } });// and still there
  const files = classifyFiles(["f.txt"], { squash: S, main: M, head: H, entryAt });
  const v = verdictFor(files);
  check(files[0].state === FILE_STATE.intact,
    "a merge whose base moved reads as INTACT, not as missing", files[0].state);
  check(v.verdict === VERDICT.intact && exitFor(v.verdict) === EXIT.ok,
    "so the verdict is MERGED, AND INTACT ON MAIN, exit 0", v.verdict);
  check(files[0].headDiffersFromMerge === true,
    "the head does differ from the merge here, and that is recorded", String(files[0].headDiffersFromMerge));
  check(/cannot tell them apart/.test(v.why),
    "but it is reported as an observation with both causes named, never as the verdict", v.why);
}

// --- main moved after the merge ----------------------------------------------
{
  const entryAt = fixture({ [H]: { "a.mjs": `${F} mine` },
                            [S]: { "a.mjs": `${F} mine` },
                            [M]: { "a.mjs": `${F} someone-else` } });
  const v = verdictFor(classifyFiles(["a.mjs"], { squash: S, main: M, head: H, entryAt }));
  check(v.verdict === VERDICT.drifted && exitFor(v.verdict) === EXIT.drifted,
    "content changed after the merge is MERGED, THEN CHANGED ON MAIN, exit 32", v.verdict);
  check(/human decides/.test(v.why), "and it refuses to guess whether that was a follow-up or an overwrite");
}

// --- MODE IS PART OF THE ENTRY ----------------------------------------------
// `git rev-parse <rev>:<path>` returns the blob, and mode lives in the tree, so
// a lost executable bit shares its blob id with the version that never had one.
{
  const bit = fixture({ [S]: { "run.sh": `${X} same-blob` }, [M]: { "run.sh": `${F} same-blob` } });
  check(classifyFiles(["run.sh"], { squash: S, main: M, entryAt: bit })[0].state === FILE_STATE.drifted,
    "an executable bit lost after the merge is caught even though the blob matches");
  const sym = fixture({ [S]: { p: `${L} same-blob` }, [M]: { p: `${F} same-blob` } });
  check(classifyFiles(["p"], { squash: S, main: M, entryAt: sym })[0].state === FILE_STATE.drifted,
    "and so is a symlink that became a regular file with the same payload");
  // The control: matching in BOTH mode and id must still be INTACT, or the
  // comparison is broken rather than stricter.
  const ok = fixture({ [S]: { "run.sh": `${X} b` }, [M]: { "run.sh": `${X} b` } });
  check(classifyFiles(["run.sh"], { squash: S, main: M, entryAt: ok })[0].state === FILE_STATE.intact,
    "control: an entry matching in both mode and id is INTACT");
}

// --- a deletion that merged --------------------------------------------------
{
  const kept = fixture({ [S]: {}, [M]: {} });   // merged as a deletion, still gone
  const f1 = classifyFiles(["gone.mjs"], { squash: S, main: M, entryAt: kept });
  check(f1[0].state === FILE_STATE.gone, "a deletion that merged and stayed reads as REMOVED", f1[0].state);
  check(verdictFor(f1).verdict === VERDICT.intact, "and a pull request that only deletes verifies");

  const undone = fixture({ [S]: {}, [M]: { "gone.mjs": `${F} restored` } });
  const f2 = classifyFiles(["gone.mjs"], { squash: S, main: M, entryAt: undone });
  check(f2[0].state === FILE_STATE.drifted,
    "a deletion that merged and was later undone is DRIFTED, not absence", f2[0].state);
}

// --- head divergence is an observation, never a verdict ----------------------
// A head differing from the squash has TWO causes -- a commit pushed after the
// merge, or a base that moved before it -- and tree entries cannot distinguish
// them. Reporting either as fact would be the overclaiming this tool exists to
// avoid.
{
  const entryAt = fixture({ [H]: { "a.mjs": `${F} round4` },   // pushed after the merge
                            [S]: { "a.mjs": `${F} round3` },
                            [M]: { "a.mjs": `${F} round3` } });
  const files = classifyFiles(["a.mjs"], { squash: S, main: M, head: H, entryAt });
  const v = verdictFor(files);
  check(v.verdict === VERDICT.intact,
    "a commit pushed after the merge does not make the MERGE unsound", v.verdict);
  check(files[0].headDiffersFromMerge === true && v.counts.headDiverged === 1,
    "the divergence is counted", JSON.stringify(v.counts));
  check(/pushed to the branch AFTER it merged/.test(v.why) && /main having moved before the merge/.test(v.why),
    "and BOTH readings are named, so neither is asserted", v.why);
  // Without a head, no divergence may be claimed either way.
  const noHead = classifyFiles(["a.mjs"], { squash: S, main: M, entryAt });
  check(noHead[0].headDiffersFromMerge === null,
    "with no head read, divergence is null rather than false", String(noHead[0].headDiffersFromMerge));
  check(!/differ between the branch head/.test(verdictFor(noHead).why),
    "and the note is omitted rather than claiming the head agreed");
}

// --- an empty set is NOT a pass ----------------------------------------------
{
  const v = verdictFor([]);
  check(v.verdict === VERDICT.unreadable && exitFor(v.verdict) === EXIT.unreadable,
    "a pull request with no paths is UNREADABLE, exit 23, not intact", v.verdict);
  check(/not a pass/.test(v.why), "and says so rather than reporting all-clear over nothing");
  const entryAt = fixture({ [S]: { a: `${F} 1` }, [M]: { a: `${F} 1` } });
  check(verdictFor(classifyFiles(["a"], { squash: S, main: M, entryAt })).verdict === VERDICT.intact,
    "control: one matching path over the same code path does verify");
}

// --- renames carry two paths -------------------------------------------------
{
  const paths = pathsOf([{ filename: "new/a.mjs", previous_filename: "old/a.mjs" },
                         { filename: "b.mjs" },
                         { filename: "same.mjs", previous_filename: "same.mjs" }]);
  check(paths.includes("new/a.mjs") && paths.includes("old/a.mjs"),
    "a rename contributes BOTH its destination and its source", JSON.stringify(paths));
  check(paths.filter(p => p === "same.mjs").length === 1,
    "and a previous_filename equal to the filename is not counted twice");
  // Four, not three: the rename contributes two and the others one each. This
  // said three on the first pass and the test caught the arithmetic, which is
  // why the count is asserted and not only the membership.
  check(paths.length === 4, "so three entries including one rename yield four paths", JSON.stringify(paths));
}

// --- a filename is attacker-supplied ----------------------------------------
// On any repository taking outside contributions a contributor chooses these
// bytes. A carriage return or an ANSI escape lets them overwrite the verdict
// line or forge one that reads as success -- making the report itself the false
// reassurance the tool exists to remove.
{
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10), ESC = String.fromCharCode(27);
  const evil = "ok.txt" + CR + LF + VERDICT.intact + "  revnix/reeve#99" + ESC + "[2K";
  const out = safePath(evil);
  check(!new RegExp("[" + CR + LF + ESC + "]").test(out),
    "no control character survives safePath, so a forged verdict line cannot be printed", JSON.stringify(out));
  check(out.includes("\\x0d") && out.includes("\\x1b"),
    "they become visible escapes rather than vanishing", JSON.stringify(out));
  check(safePath("src/a-b_c.mjs") === "src/a-b_c.mjs",
    "control: an ordinary path is returned unchanged", safePath("src/a-b_c.mjs"));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
