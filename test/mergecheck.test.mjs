// Whether a pull request's content reached main, and the four answers that are
// not two.
//
// The reason this is tested at all: the check it replaces was ancestry, which
// this repository's squash merges make permanently false, and a subject-line
// grep, which reported four fixes lost when one was. Both were reached for at
// the moment the answer mattered. A replacement that is itself untested would
// be the third instrument nobody had seen fail.
//
// Every case below injects `blobAt`, so no repository, no network and no `gh`
// are involved and the classification can be driven into states a real merge
// would take days to produce.

import { classifyFiles, verdictFor, exitFor, FILE_STATE, VERDICT, EXIT } from "../src/mergecheck.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// A fixture repository as a table: blobs[rev][path]. Absent means the path does
// not exist at that revision, which is a different fact from an empty file.
const fixture = (blobs) => (rev, path) =>
  Object.hasOwn(blobs, rev) && Object.hasOwn(blobs[rev], path) ? blobs[rev][path] : null;

const H = "head", M = "origin/main", S = "squash";

// --- a clean squash merge ----------------------------------------------------
{
  const blobAt = fixture({ [H]: { "a.mjs": "b1", "b.mjs": "b2" },
                           [S]: { "a.mjs": "b1", "b.mjs": "b2" },
                           [M]: { "a.mjs": "b1", "b.mjs": "b2" } });
  const files = classifyFiles(["a.mjs", "b.mjs"], { head: H, main: M, squash: S, blobAt });
  const v = verdictFor(files);
  check(files.every(f => f.state === FILE_STATE.matches), "every file matches when the content arrived",
    JSON.stringify(files.map(f => f.state)));
  check(v.verdict === VERDICT.merged, "and the verdict is MERGED BY CONTENT", v.verdict);
  check(exitFor(v.verdict) === EXIT.ok, "which exits 0", String(exitFor(v.verdict)));
}

// --- the lost push: a fix committed to the branch AFTER the merge -------------
// This is not hypothetical. It happened in this repository: a review round was
// pushed to a branch whose pull request had already merged, the push succeeded,
// and main never saw it. Nothing anywhere errored.
{
  const blobAt = fixture({ [H]: { "a.mjs": "round4" },     // the branch moved on
                           [S]: { "a.mjs": "round3" },     // what actually merged
                           [M]: { "a.mjs": "round3" } });
  const files = classifyFiles(["a.mjs"], { head: H, main: M, squash: S, blobAt });
  const v = verdictFor(files);
  check(files[0].state === FILE_STATE.missing, "a fix pushed after the merge reads as MISSING", files[0].state);
  check(v.verdict === VERDICT.absent, "and the verdict is NOT ON MAIN", v.verdict);
  check(exitFor(v.verdict) === EXIT.no, "which exits 31, a measured negative", String(exitFor(v.verdict)));
  check(/pushed to the branch AFTER/.test(v.why), "and the message names the cause that produced it", v.why);
}

// --- merged, then main moved on ----------------------------------------------
{
  const blobAt = fixture({ [H]: { "a.mjs": "mine" },
                           [S]: { "a.mjs": "mine" },       // it did arrive
                           [M]: { "a.mjs": "someone-else" } }); // and was changed after
  const files = classifyFiles(["a.mjs"], { head: H, main: M, squash: S, blobAt });
  const v = verdictFor(files);
  check(files[0].state === FILE_STATE.drifted, "content that arrived and was then changed reads as DRIFTED", files[0].state);
  check(v.verdict === VERDICT.moved, "and the verdict distinguishes that from never arriving", v.verdict);
  check(exitFor(v.verdict) === EXIT.drifted, "which exits 32, not 31", String(exitFor(v.verdict)));
  check(/human decides/.test(v.why), "and it refuses to guess which of the two it is", v.why);
}

// --- MISSING outranks DRIFTED ------------------------------------------------
{
  const blobAt = fixture({ [H]: { "gone.mjs": "x", "moved.mjs": "y" },
                           [S]: { "gone.mjs": "OTHER", "moved.mjs": "y" },
                           [M]: { "gone.mjs": "OTHER", "moved.mjs": "later" } });
  const v = verdictFor(classifyFiles(["gone.mjs", "moved.mjs"], { head: H, main: M, squash: S, blobAt }));
  check(v.verdict === VERDICT.absent,
    "one file that never arrived outranks another that merely moved", v.verdict);
  check(v.counts.missing === 1 && v.counts.drifted === 1,
    "and both are still counted, so the report does not hide the second", JSON.stringify(v.counts));
}

// --- an empty set is NOT a pass ----------------------------------------------
// The failure this guards is the one this repository keeps finding: a check that
// narrows its input to nothing and reports success over the emptiness.
{
  const v = verdictFor([]);
  check(v.verdict === VERDICT.empty, "a pull request with no files is UNREADABLE, not merged", v.verdict);
  check(exitFor(v.verdict) === EXIT.unreadable, "and exits 23 rather than 0", String(exitFor(v.verdict)));
  check(/not a pass/.test(v.why), "and says so, rather than reporting all-clear over nothing", v.why);
  // The control: the SAME function over one matching file must say merged, so
  // the refusal above is a property of emptiness and not of a broken verdict.
  const blobAt = fixture({ [H]: { "a": "1" }, [S]: { "a": "1" }, [M]: { "a": "1" } });
  check(verdictFor(classifyFiles(["a"], { head: H, main: M, squash: S, blobAt })).verdict === VERDICT.merged,
    "control: one matching file over the same code path does report merged");
}

// --- a deleted file is consistent, not missing -------------------------------
{
  const blobAt = fixture({ [H]: {}, [S]: {}, [M]: {} });
  const files = classifyFiles(["removed.mjs"], { head: H, main: M, squash: S, blobAt });
  check(files[0].state === FILE_STATE.deleted,
    "a file absent from the head and from main alike is consistent, not missing", files[0].state);
  check(verdictFor(files).verdict === VERDICT.merged,
    "so a pull request that only deletes files still verifies");
}

// --- no squash commit: DRIFTED cannot be told from MISSING -------------------
// It must degrade to the answer that prompts a look, never to the reassuring one.
{
  const blobAt = fixture({ [H]: { "a.mjs": "mine" }, [M]: { "a.mjs": "other" } });
  const files = classifyFiles(["a.mjs"], { head: H, main: M, squash: null, blobAt });
  check(files[0].state === FILE_STATE.missing,
    "with no squash commit to compare, a difference degrades to MISSING", files[0].state);
  check(files[0].squash === null, "and the report says the squash blob was never read", String(files[0].squash));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
