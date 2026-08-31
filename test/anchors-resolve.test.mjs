// Every manifest anchor must still resolve, and this must be CHEAP.
//
// The sweep already reports an unresolved anchor as UNRUNNABLE and reports it better
// than this does. It also costs about twenty minutes, because it runs every named
// test twice. This costs milliseconds, because reading a file and counting a
// substring is all the question needs.
//
// THE GAP IS WHY ANCHORS REACH THE DEFAULT BRANCH. Measured 2026-08-30: two entries
// were verified CAUGHT when they were written; review fixes in the SAME pull request
// then moved the lines they named -- one de-indented by two spaces, one condition
// split across three lines; the suite and the linter both passed, because neither
// reads an anchor; and the only thing that does was too slow to run again before
// pushing. The verification was real, and it was verification of a tree that then
// changed.
//
// So this is a PRECONDITION of the sweep rather than a duplicate of it. It shares
// `countOccurrences` and `describeMiss` with `applyEdit`, so the two cannot disagree
// about what resolving means -- two implementations of that would be the second
// inventory this whole class of defect is made of.
import { unresolvedAnchors } from "../src/stubsweep.mjs";
import { STUBS } from "./stub-manifest.mjs";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// ── the mechanism, on synthetic input ──────────────────────────────────────────
//
// Before the real tree, because the real tree's expected answer is ZERO unresolved,
// and a check whose expected value is zero cannot be shown to work by a tree that
// happens to be clean. These say the detector can find one.
{
  const files = { "a.mjs": "const x = 1;\nconst y = 2;\n", "b.mjs": "dup\ndup\n" };
  const read = f => { if (!(f in files)) throw new Error("ENOENT"); return files[f]; };

  check(unresolvedAnchors([{ name: "ok", edits: [{ file: "a.mjs", find: "const x = 1;" }] }], { read, key: f => f }).length === 0,
    "control: an anchor that appears exactly once resolves");

  const gone = unresolvedAnchors([{ name: "gone", edits: [{ file: "a.mjs", find: "const z = 3;" }] }], { read, key: f => f });
  check(gone.length === 1 && gone[0].count === 0, "an anchor that appears NOWHERE is reported",
    JSON.stringify(gone));
  check(/no part of the anchor|then diverged|reads/.test(gone[0].why ?? ""),
    "and the report says where it diverged, not merely that it failed", gone[0].why);

  const dup = unresolvedAnchors([{ name: "dup", edits: [{ file: "b.mjs", find: "dup" }] }], { read, key: f => f });
  check(dup.length === 1 && dup[0].count === 2,
    "an anchor that appears TWICE is reported too, because applying it would pick one arbitrarily",
    JSON.stringify(dup));

  const missing = unresolvedAnchors([{ name: "nofile", edits: [{ file: "c.mjs", find: "x" }] }], { read, key: f => f });
  check(missing.length === 1 && missing[0].count === null,
    "an unreadable file is reported rather than skipped, since a skipped entry is an unchecked one",
    JSON.stringify(missing));
}

// ── multiple edits to one file are judged IN ORDER ─────────────────────────────
//
// The sweep applies an entry's edits sequentially to one in-memory source per file:
// `for (const ed of edits) src = applyEdit(src, ed)`. Re-reading the pristine file
// for each edit answers a different question and can answer it the OPPOSITE way --
// an earlier replacement that creates or removes a later anchor makes the two
// disagree, and the cheap check would then pass on a stub the sweep will refuse.
{
  const read = () => "alpha\nbeta\n";

  // Sequentially valid: the second anchor exists only AFTER the first edit runs.
  const seq = unresolvedAnchors([{ name: "seq", edits: [
    { file: "f.mjs", find: "alpha", replace: "gamma" },
    { file: "f.mjs", find: "gamma", replace: "delta" },
  ] }], { read, key: f => f });
  check(seq.length === 0,
    "an edit whose anchor is CREATED by the edit before it resolves, because the check applies them in order",
    JSON.stringify(seq));

  // Pristine-valid but sequentially broken: the second anchor is consumed by the first.
  const eaten = unresolvedAnchors([{ name: "eaten", edits: [
    { file: "f.mjs", find: "alpha", replace: "x" },
    { file: "f.mjs", find: "alpha", replace: "y" },
  ] }], { read, key: f => f });
  check(eaten.length === 1 && eaten[0].count === 0,
    "and one whose anchor is CONSUMED by the edit before it is reported, which a pristine re-read would have passed",
    JSON.stringify(eaten));

  // Duplication is the other direction of the same defect.
  const dup = unresolvedAnchors([{ name: "dup", edits: [
    { file: "f.mjs", find: "beta", replace: "alpha" },
    { file: "f.mjs", find: "alpha", replace: "z" },
  ] }], { read, key: f => f });
  check(dup.length === 1 && dup[0].count === 2,
    "and one whose anchor is DUPLICATED by the edit before it is reported as ambiguous",
    JSON.stringify(dup));
}

// ── two spellings of one file are ONE file ─────────────────────────────────────
//
// The runner coalesces targets with `join(ROOT, e.file)` and manifest validation
// accepts any non-empty string, so `f.mjs` and `./f.mjs` are one file to the sweep.
// Grouping by the raw spelling would make them two groups here, each reading the
// pristine source and each blind to what the other replaced -- a FALSE GREEN in the
// cheap check, which is the one failure mode it must not have.
{
  const read = () => "alpha\nbeta\n";
  for (const [label, second] of [["./f.mjs", "./f.mjs"], ["an ABSOLUTE spelling", "/f.mjs"]]) {
    // The RUNNER's key here, not identity: with identity the two spellings would not
    // coalesce and this assertion would pass while testing nothing.
    const mixed = unresolvedAnchors([{ name: "mixed", edits: [
      { file: "f.mjs", find: "alpha", replace: "beta" },
      { file: second,  find: "beta",  replace: "z" },
    ] }], { read, key: f => join("/", f) });
    check(mixed.length === 1 && mixed[0].count === 2,
      `two spellings of one path are grouped together (${label}), so the second edit sees what the first produced`,
      JSON.stringify(mixed) + "  (ungrouped, this reads as one clean occurrence and passes)");
  }
  // `/f.mjs` is the case a plain normalize() gets WRONG: it stays absolute and reads
  // as a different file, while the runner's join treats it as a segment of the root.

  // The control: the SAME two edits under one spelling must give the same answer.
  // If they differ, the normalisation is doing something other than coalescing.
  const same = unresolvedAnchors([{ name: "same", edits: [
    { file: "f.mjs", find: "alpha", replace: "beta" },
    { file: "f.mjs", find: "beta",  replace: "z" },
  ] }], { read, key: f => join("/", f) });
  check(same.length === 1 && same[0].count === 2,
    "control: and one spelling gives the identical verdict, so the grouping is coalescing rather than altering",
    JSON.stringify(same));
}

// ── and the real tree ──────────────────────────────────────────────────────────
{
  check(STUBS.length > 10, `control: ${STUBS.length} entries to check, so this is not vacuous`);
  const started = Date.now();
  // THE RUNNER'S OWN OPERATION as the key, and the reader takes that absolute path.
  // `join(ROOT, f)` is what scripts/stub-sweep.mjs uses, so `src/x.mjs`, `./src/x.mjs`,
  // `/src/x.mjs` and `a/../src/x.mjs` are one target here exactly as they are there.
  // The RUNNER's key exactly, including realpath: two paths reaching one file through
  // an in-repository symlink are one target to the sweep, which writes the first
  // before reading the second.
  const bad = unresolvedAnchors(STUBS, {
    key: f => { const abs = join(ROOT, f); try { return realpathSync(abs); } catch { return abs; } },
    read: abs => readFileSync(abs, "utf8") });
  const ms = Date.now() - started;
  check(ms < 5000, `control: the whole check took ${ms}ms, so it is cheap enough to run before every push`,
    "if this ever approaches the sweep's cost, the reason to have it separately is gone");
  check(bad.length === 0, "every manifest anchor resolves to exactly one place in the file it names",
    bad.map(b => `${b.name} -> ${b.file} (${b.count}): ${String(b.why).split("\n")[0]}`).join("\n        ") +
    "\n        re-anchor it to the text as it now stands; the sweep cannot apply a stub it cannot place");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
