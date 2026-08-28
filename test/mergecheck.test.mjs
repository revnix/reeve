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

import { classifyFiles, verdictFor, pathsOf, branchOnlyPaths, gitFacts, safePath, exitFor,
         displayPath, toByteString, crossCheckState, coverageProven,
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


// --- THE GIT READS, AS ARGUMENT LISTS ----------------------------------------
// These four properties live in the argv, not in the output, and each was a
// review finding. A property nothing can observe is a property nothing defends,
// so the runner is injected and the arguments themselves are the assertion.
{
  const calls = [];
  const REPLY = [];
  const G = gitFacts((args) => { calls.push(args); return REPLY.shift() ?? ""; });

  REPLY.push("deadbeef", "sha par", "a b", "100644 blob cafe\tf");
  G.pinMain(); G.parentsOf("sha"); G.mergePaths("sha"); G.treeEntries("sha");
  check(calls.length === 4, "the four reads issue four git calls", String(calls.length));
  check(calls.every(a => a[0] === "--literal-pathspecs"),
    "every git call leads with --literal-pathspecs, so a path beginning ':' is never read as pathspec magic",
    JSON.stringify(calls.map(a => a[0])));

  const pinCall = calls[0];
  check(pinCall.includes("rev-parse") && pinCall.includes("origin/main^{commit}"),
    "pinMain resolves origin/main to a commit id rather than leaving the mutable name",
    JSON.stringify(pinCall));

  // --no-renames, or a rename collapses to its destination and the source side
  // is never compared. -z, or a newline in a filename is quoted into a different
  // string. Both are repository-level defaults this must not be at the mercy of.
  const dt = calls[2];
  check(dt.includes("--no-renames"), "mergePaths disables rename detection, which is otherwise a repo setting", JSON.stringify(dt));
  check(dt.includes("-z"), "and asks for NUL-separated output", JSON.stringify(dt));
  check(dt.includes("-r") && dt.includes("--no-commit-id"), "and recurses, without the commit-id line", JSON.stringify(dt));
}

// The enumeration must survive a filename containing a newline -- the reason -z
// exists. A line-split would report this as two paths, neither of which exists.
{
  const evil = "src/a\nb.mjs";
  const G = gitFacts(() => [evil, "plain.mjs"].join("\0") + "\0");
  const got = G.mergePaths("sha");
  check(got.length === 2 && got[0] === evil,
    "a path containing a newline survives enumeration as ONE path", JSON.stringify(got));
}

// treeEntries returns mode AND id, and an empty listing is an empty map -- the
// revision was read and holds nothing, which the caller turns into ABSENT.
{
  const G = gitFacts(() => "100755 blob abc123\trun.sh");
  const e = G.treeEntries("rev").get("run.sh");
  check(e.mode === "100755" && e.id === "abc123", "treeEntries reads mode AND id from the tree entry", JSON.stringify(e));
  check(G.treeEntries("rev").get("nope") === undefined,
    "a path absent from the listing is a miss, which the caller reports as ABSENT");
  check(gitFacts(() => "").treeEntries("rev").size === 0, "an empty listing is an empty map");
}

// --- PATHS THE MERGE DID NOT PRODUCE -----------------------------------------
// The pull request's file list describes the branch HEAD. A push after the merge
// can change WHICH paths it names without changing HOW MANY, so a count check
// cannot catch it. These are reported, never folded into the verdict.
{
  const extra = branchOnlyPaths(["a.mjs", "late.mjs"], ["a.mjs"]);
  check(extra.length === 1 && extra[0] === "late.mjs",
    "a path the API lists and the merge did not produce is identified", JSON.stringify(extra));
  check(branchOnlyPaths(["a.mjs"], ["a.mjs", "b.mjs"]).length === 0,
    "control: the merge producing MORE than the API lists yields no branch-only paths");

  const entryAt = fixture({ [S]: { "a.mjs": `${F} x` }, [M]: { "a.mjs": `${F} x` } });
  const files = classifyFiles(["a.mjs"], { squash: S, main: M, entryAt });
  // AN UNCOVERED PATH REFUSES THE PASS. The exit code is the verdict to anything
  // consuming this in a script, and prose is invisible to `verify-merge && merge`.
  // A rebase merge names only its last commit, so the earlier commits' paths sit
  // in branchOnly having never been compared -- exit 0 there is a pass over work
  // nothing checked.
  const v = verdictFor(files, { branchOnly: extra });
  check(v.verdict === VERDICT.unreadable && exitFor(v.verdict) === EXIT.unreadable,
    "an uncovered path REFUSES the pass rather than exiting 0 with a note", v.verdict);
  check(/NOT COVERED BY THE VERDICT ABOVE/.test(v.why) && v.why.includes("late.mjs"),
    "and the uncovered path is still named", v.why);
  check(/rebase merge names only its LAST commit/.test(v.why),
    "and the reading under which it is NOT benign is named too");
  check(!/NOT COVERED BY THE VERDICT ABOVE/.test(verdictFor(files).why),
    "control: with no branch-only paths the section is absent, not empty");
  check(verdictFor(files).verdict === VERDICT.intact,
    "control: the SAME files with no uncovered paths do verify, so the refusal is the uncovered path and not the fixture");

  // ...unless a rebase merge has been ruled out at the repository level, which is
  // the only thing that can distinguish a squash from a rebase tip.
  const proven = verdictFor(files, { branchOnly: extra, squashProven: true });
  check(proven.verdict === VERDICT.intact && exitFor(proven.verdict) === EXIT.ok,
    "with rebase merges disabled on the repository, an uncovered path is a late push and verifies", proven.verdict);
  check(/NOT COVERED BY THE VERDICT ABOVE/.test(proven.why),
    "and is still reported, because a late push is worth seeing even when benign");
}

// A cross-check that could not run says so, and does not become a verdict.
{
  const entryAt = fixture({ [S]: { a: `${F} 1` }, [M]: { a: `${F} 1` } });
  const files = classifyFiles(["a"], { squash: S, main: M, entryAt });
  const v = verdictFor(files, { crossCheck: "rate limited" });
  check(v.verdict === VERDICT.unreadable && exitFor(v.verdict) === EXIT.unreadable,
    "a failed cross-check REFUSES the pass -- it is the only read that would reveal an uncovered path", v.verdict);
  check(/could not be completed \(rate limited\)/.test(v.why),
    "and the failure is reported with its reason rather than passing silently", v.why);
  check(!/could not be completed/.test(verdictFor(files).why),
    "control: a complete cross-check adds no such note");
  check(verdictFor(files).verdict === VERDICT.intact,
    "control: the same files with a complete cross-check do verify");
  check(verdictFor(files, { crossCheck: "rate limited", squashProven: true }).verdict === VERDICT.intact,
    "with rebase merges ruled out, a failed cross-check no longer withholds the pass");

  // A DRIFTED verdict is NOT withheld: it already exits non-zero and sends a
  // human to look, and swapping it for UNREADABLE would lose a concrete finding.
  const drifted = classifyFiles(["a"], {
    squash: S, main: M,
    entryAt: fixture({ [S]: { a: `${F} 1` }, [M]: { a: `${F} 2` } }),
  });
  const dv = verdictFor(drifted, { branchOnly: ["late.mjs"], crossCheck: "rate limited" });
  check(dv.verdict === VERDICT.drifted && exitFor(dv.verdict) === EXIT.drifted,
    "an uncovered path does NOT downgrade a DRIFTED finding to UNREADABLE", dv.verdict);
}

// An empty merge diff is UNREADABLE, and names which read was empty.
{
  const v = verdictFor([]);
  check(v.verdict === VERDICT.unreadable && exitFor(v.verdict) === EXIT.unreadable,
    "a merge whose diff names zero paths is UNREADABLE, not intact", v.verdict);
  check(/merge commit's own diff/.test(v.why),
    "and names the merge diff as the empty read, not the API list", v.why);
}


// --- REPLACEMENT OBJECTS ------------------------------------------------------
// A refs/replace/* entry transparently substitutes a different object for the
// one an OID names, and fetching does not clear them. A replacement tree that
// matched main would verify an object that is NOT the squash GitHub reported.
{
  const calls = [];
  const G = gitFacts((args) => { calls.push(args); return ""; });
  G.pinMain(); G.parentsOf("s"); G.mergePaths("s"); G.treeEntries("s");
  check(calls.every(a => a.includes("--no-replace-objects")),
    "every git call disables replacement objects, so a local git-replace cannot forge a match",
    JSON.stringify(calls.map(a => a.slice(0, 2))));
}

// --- A PATH MAY BEGIN WITH WHITESPACE ----------------------------------------
// The -z output must not be trimmed: a leading space belongs to the FIRST path,
// and stripping it sends the lookup after a different name -- absent from both
// revisions, so it classifies REMOVED, which is a PASSING state.
{
  const G = gitFacts(() => " leading.mjs\u0000second.mjs\u0000");
  const got = G.mergePaths("sha");
  check(got[0] === " leading.mjs",
    "a path beginning with a space survives enumeration byte-for-byte", JSON.stringify(got));
  check(got.length === 2, "and the rest of the list is unaffected", JSON.stringify(got));
  // The scalar reads still trim, or a trailing newline would become part of a sha.
  check(gitFacts(() => "abc123\n").pinMain() === "abc123",
    "while a scalar read is still trimmed, so a trailing newline never enters a revision id");
}


// --- A FILENAME'S BYTES ARE NOT A UTF-8 STRING -------------------------------
// Every invalid byte decodes to the SAME U+FFFD, so two paths differing only in
// such a byte become one string. MEASURED on a real git fixture: under a UTF-8
// runner, `x-\xfe.txt` and `x-\xff.txt` collapsed to a single map entry and the
// verdict was MERGED, AND INTACT ON MAIN over a file that had drifted. A false
// pass, produced by a decoder.
{
  const rec = (mode, id, path) => `${mode} blob ${id}\t${path}`;
  const A = "x-þ.txt", B = "x-ÿ.txt";   // latin1 byte-strings: 0xfe, 0xff
  const G = gitFacts(() => [rec(F, "a1", A), rec(F, "b1", B)].join("\0") + "\0");
  const t = G.treeEntries("rev");
  check(t.size === 2, "two paths differing only in an invalid byte stay TWO entries", String(t.size));
  check(t.get(A).id === "a1" && t.get(B).id === "b1",
    "and each keeps its own tree entry rather than one overwriting the other",
    JSON.stringify([t.get(A), t.get(B)]));

  // The control: collapse them the way a UTF-8 decode would, and the map loses one.
  const collapsed = new Map([[A, 1], [B, 2]].map(([k, v]) => ["x-�.txt", v]));
  check(collapsed.size === 1,
    "control: collapsing both to U+FFFD really does lose one, which is the defect this prevents");
}

// treeEntries parses mode and id, and a path containing a tab survives.
{
  const withTab = "dir/a\tb.txt";
  const G = gitFacts(() => `${X} blob deadbeef\t${withTab}\0${F} blob cafe\tplain\0`);
  const t = G.treeEntries("rev");
  check(t.get(withTab)?.mode === X && t.get(withTab)?.id === "deadbeef",
    "a path containing a TAB is split on the FIRST tab only, so the name survives",
    JSON.stringify([...t.keys()]));
  check(t.size === 2, "and the rest of the listing is unaffected", String(t.size));
}

// --- THE FETCH REFSPEC -------------------------------------------------------
// Without the leading `+`, a REWRITTEN main is a non-fast-forward: git refuses,
// the fetch fails, and every later run reports UNREADABLE against a stale ref.
{
  const calls = [];
  const G = gitFacts((a) => { calls.push(a); return ""; });
  G.fetchMain();
  const a = calls[0];
  check(a.includes("+refs/heads/main:refs/remotes/origin/main"),
    "the fetch refspec is FORCED, so a rewritten main can still be followed", JSON.stringify(a));
  check(a.includes("fetch") && !a.includes("pull"),
    "and it fetches rather than pulls, because a live guardian may run from this checkout");
}

// --- THE CROSS-CHECK COUNTS RECORDS, NOT EXPANDED PATHS ----------------------
// A rename yields two paths from one record, so counting expanded paths lets one
// rename hide one missing record -- reachable at the endpoint's 3,000-file cap.
{
  check(crossCheckState(3000, 3001) !== "complete",
    "a file list one record short is NOT complete, even though a rename would expand it back to the count");
  check(/3001/.test(crossCheckState(3000, 3001)) && /3000 records/.test(crossCheckState(3000, 3001)),
    "and the shortfall is reported with both numbers", crossCheckState(3000, 3001));
  check(crossCheckState(3001, 3001) === "complete", "control: a full list is complete");
  check(crossCheckState(2, undefined) === "complete",
    "control: with no reported count there is nothing to be short of");
}

// --- COVERAGE IS PROVEN PER PULL REQUEST, NEVER FROM REPO SETTINGS -----------
// A rebase merge names only its LAST commit. With one commit in the pull
// request, squash and rebase produce identical coverage; with more they do not,
// and the repository's CURRENT settings say nothing about a PAST merge.
{
  check(coverageProven(1) === true,
    "a one-commit pull request is covered by its merge commit whichever method was used");
  check(coverageProven(2) === false, "a two-commit pull request is not");
  check(coverageProven(null) === false && coverageProven(undefined) === false,
    "and an unknown commit count is NOT proven -- unknown is the safe answer");
}

// --- PATHS RENDER FOR HUMANS WITHOUT LOSING BYTES ----------------------------
{
  check(displayPath(toByteString("src/naïve.mjs")) === "src/naïve.mjs",
    "a valid UTF-8 path round-trips through the byte-string form and renders normally",
    displayPath(toByteString("src/naïve.mjs")));
  check(displayPath("bad-ÿ.txt") === "bad-\\xff.txt",
    "an undecodable byte renders as an escape, not as a replacement character",
    displayPath("bad-ÿ.txt"));
  const CR = String.fromCharCode(13);
  check(!displayPath(toByteString("ok" + CR + VERDICT.intact)).includes(CR),
    "and a carriage return still cannot forge a verdict line");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
