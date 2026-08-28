// Whether a pull request's content reached main, and the answers that are not
// each other.
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

import { classifyFiles, verdictFor, pathsOf, exitFor,
         FILE_STATE, VERDICT, EXIT, ABSENT, UNREAD } from "../src/mergecheck.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// A fixture tree as a table: trees[rev][path] = "<mode> <id>", absent means the
// revision was read and holds no such path.
const fixture = (trees) => (rev, path) => {
  const t = trees[rev] ?? {};
  if (!Object.hasOwn(t, path)) return ABSENT;
  const [mode, id] = t[path].split(" ");
  return { mode, id };
};
const H = "head", M = "origin/main", S = "squash";
const F = "100644", X = "100755", L = "120000";

// --- a clean squash merge ----------------------------------------------------
{
  const entryAt = fixture({ [H]: { "a.mjs": `${F} b1`, "b.mjs": `${F} b2` },
                            [S]: { "a.mjs": `${F} b1`, "b.mjs": `${F} b2` },
                            [M]: { "a.mjs": `${F} b1`, "b.mjs": `${F} b2` } });
  const files = classifyFiles(["a.mjs", "b.mjs"], { head: H, main: M, squash: S, entryAt });
  const v = verdictFor(files);
  check(files.every(f => f.state === FILE_STATE.matches), "every path matches when the content arrived");
  check(v.verdict === VERDICT.merged && exitFor(v.verdict) === EXIT.ok,
    "the verdict is MERGED BY CONTENT and exits 0", v.verdict);
}

// --- the lost push: a fix committed to the branch AFTER the merge -------------
// Not hypothetical. It happened here: a review round was pushed to a branch
// whose pull request had already merged, the push succeeded, main never saw it,
// and nothing errored anywhere.
{
  const entryAt = fixture({ [H]: { "a.mjs": `${F} round4` },
                            [S]: { "a.mjs": `${F} round3` },
                            [M]: { "a.mjs": `${F} round3` } });
  const v = verdictFor(classifyFiles(["a.mjs"], { head: H, main: M, squash: S, entryAt }));
  check(v.verdict === VERDICT.absent && exitFor(v.verdict) === EXIT.no,
    "a fix pushed after the merge is NOT ON MAIN, exit 31", v.verdict);
  check(/pushed to the branch AFTER/.test(v.why), "and the message names the cause that produces it");
}

// --- merged, then main moved on ----------------------------------------------
{
  const entryAt = fixture({ [H]: { "a.mjs": `${F} mine` },
                            [S]: { "a.mjs": `${F} mine` },
                            [M]: { "a.mjs": `${F} someone-else` } });
  const v = verdictFor(classifyFiles(["a.mjs"], { head: H, main: M, squash: S, entryAt }));
  check(v.verdict === VERDICT.moved && exitFor(v.verdict) === EXIT.drifted,
    "content that arrived and was then changed is MERGED, THEN MOVED, exit 32", v.verdict);
  check(/human decides/.test(v.why), "and it refuses to guess which of the two it is");
}

// --- A DELETION THAT ARRIVED AND WAS UNDONE IS DRIFT, NOT ABSENCE ------------
// The defect that made ABSENT and UNREAD separate symbols. With both collapsed
// into `null`, the squash comparison was guarded by a non-null test, this case
// fell through to MISSING, and the tool reported NOT ON MAIN over a deletion
// that had landed correctly.
{
  const entryAt = fixture({ [H]: {},                              // deleted by the PR
                            [S]: {},                              // and the deletion merged
                            [M]: { "gone.mjs": `${F} restored` } }); // then main put it back
  const files = classifyFiles(["gone.mjs"], { head: H, main: M, squash: S, entryAt });
  check(files[0].state === FILE_STATE.drifted,
    "a deletion that merged and was later undone reads as DRIFTED", files[0].state);
  check(verdictFor(files).verdict === VERDICT.moved,
    "so the verdict is MERGED, THEN MOVED rather than NOT ON MAIN");
  // The control: a deletion that never arrived must still be MISSING, or the
  // fix above would have made every deletion look like drift.
  const never = fixture({ [H]: {}, [S]: { "gone.mjs": `${F} still-here` }, [M]: { "gone.mjs": `${F} still-here` } });
  check(classifyFiles(["gone.mjs"], { head: H, main: M, squash: S, entryAt: never })[0].state === FILE_STATE.missing,
    "control: a deletion that never merged is still MISSING");
}

// --- MODE IS PART OF THE ENTRY ----------------------------------------------
// `git rev-parse <rev>:<path>` returns the blob, and mode lives in the tree. A
// pull request that only sets the executable bit shares its blob id with the
// version that never got it, so a blob-only check certifies a script that is no
// longer executable.
{
  const entryAt = fixture({ [H]: { "run.sh": `${X} same-blob` },
                            [S]: { "run.sh": `${X} same-blob` },
                            [M]: { "run.sh": `${F} same-blob` } }); // bit lost
  const files = classifyFiles(["run.sh"], { head: H, main: M, squash: S, entryAt });
  check(files[0].state === FILE_STATE.drifted,
    "an executable bit that did not survive is caught even though the blob matches", files[0].state);
  const sym = fixture({ [H]: { "p": `${L} same-blob` }, [S]: { "p": `${L} same-blob` }, [M]: { "p": `${F} same-blob` } });
  check(classifyFiles(["p"], { head: H, main: M, squash: S, entryAt: sym })[0].state === FILE_STATE.drifted,
    "and so is a symlink that became a regular file with the same payload");
  // The control: identical mode AND id must still match, or the comparison is
  // simply broken rather than stricter.
  const ok = fixture({ [H]: { "run.sh": `${X} b` }, [S]: { "run.sh": `${X} b` }, [M]: { "run.sh": `${X} b` } });
  check(classifyFiles(["run.sh"], { head: H, main: M, squash: S, entryAt: ok })[0].state === FILE_STATE.matches,
    "control: an entry matching in both mode and id still reads as MATCHES");
}

// --- renames carry two paths -------------------------------------------------
{
  const files = [{ filename: "new/a.mjs", previous_filename: "old/a.mjs" },
                 { filename: "b.mjs" },
                 { filename: "same.mjs", previous_filename: "same.mjs" }];
  const paths = pathsOf(files);
  check(paths.includes("new/a.mjs") && paths.includes("old/a.mjs"),
    "a rename contributes BOTH its destination and its source", JSON.stringify(paths));
  check(paths.filter(p => p === "same.mjs").length === 1,
    "and a previous_filename equal to the filename is not counted twice", JSON.stringify(paths));
  // Four, not three: the rename contributes two paths and the other two entries
  // one each. This assertion said three on the first pass and the test caught the
  // arithmetic -- which is the whole reason the count is asserted rather than
  // just the membership.
  check(paths.length === 4, "so three entries including one rename yield four distinct paths", JSON.stringify(paths));
}

// --- MISSING outranks DRIFTED ------------------------------------------------
{
  const entryAt = fixture({ [H]: { "gone.mjs": `${F} x`, "moved.mjs": `${F} y` },
                            [S]: { "gone.mjs": `${F} OTHER`, "moved.mjs": `${F} y` },
                            [M]: { "gone.mjs": `${F} OTHER`, "moved.mjs": `${F} later` } });
  const v = verdictFor(classifyFiles(["gone.mjs", "moved.mjs"], { head: H, main: M, squash: S, entryAt }));
  check(v.verdict === VERDICT.absent, "one path that never arrived outranks another that merely moved", v.verdict);
  check(v.counts.missing === 1 && v.counts.drifted === 1,
    "and both are still counted, so the report does not hide the second", JSON.stringify(v.counts));
}

// --- an empty set is NOT a pass ----------------------------------------------
{
  const v = verdictFor([]);
  check(v.verdict === VERDICT.unreadable && exitFor(v.verdict) === EXIT.unreadable,
    "a pull request with no paths is UNREADABLE, exit 23, not merged", v.verdict);
  check(/not a pass/.test(v.why), "and says so rather than reporting all-clear over nothing");
  const entryAt = fixture({ [H]: { a: `${F} 1` }, [S]: { a: `${F} 1` }, [M]: { a: `${F} 1` } });
  check(verdictFor(classifyFiles(["a"], { head: H, main: M, squash: S, entryAt })).verdict === VERDICT.merged,
    "control: one matching path over the same code path does report merged");
}

// --- a deletion on both sides is consistent ----------------------------------
{
  const entryAt = fixture({ [H]: {}, [S]: {}, [M]: {} });
  const files = classifyFiles(["removed.mjs"], { head: H, main: M, squash: S, entryAt });
  check(files[0].state === FILE_STATE.deleted,
    "a path absent from head and from main alike is consistent, not missing", files[0].state);
  check(verdictFor(files).verdict === VERDICT.merged, "so a pull request that only deletes verifies");
}

// --- no squash commit: drift cannot be told from absence ---------------------
{
  const entryAt = fixture({ [H]: { "a.mjs": `${F} mine` }, [M]: { "a.mjs": `${F} other` } });
  const files = classifyFiles(["a.mjs"], { head: H, main: M, squash: UNREAD, entryAt });
  check(files[0].state === FILE_STATE.missing,
    "with no squash commit, a difference degrades to MISSING, the answer that prompts a look", files[0].state);
  check(files[0].squash === "unread",
    "and the report says the squash side was never read, rather than calling it absent", files[0].squash);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
