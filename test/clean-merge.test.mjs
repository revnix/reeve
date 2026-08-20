// The hero metric counted absence as success.
//
// cleanMergeRate asked how many check runs at the merge commit were not passing
// and called zero "clean". A merge with NO check runs at all produces zero too, so
// a pull request nothing ever tested scored identically to one that passed
// everything -- in the single number the dashboard leads with, chosen precisely
// because it read 0% on the system this replaces while every other metric looked
// healthy.
//
// The same shape as every fail-open defect in the old gate: an absent signal read
// as a good one.
import { cleanMergeRate } from "../src/status.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// A stand-in for the API: PR number -> the check rows at its merge commit.
const probeFor = table => ({
  merged: () => Object.keys(table).map(n => ({ number: Number(n), sha: `sha${n}` })),
  checks: sha => table[sha.replace("sha", "")],
});

const green = [{ name: "CI", conclusion: "success" }];
const red = [{ name: "CI", conclusion: "failure" }];

{
  const r = cleanMergeRate("o/r", 10, probeFor({ 1: green, 2: green, 3: red }));
  check(r.ok && r.judged === 3 && r.clean === 2, "control: two of three green is judged as such", JSON.stringify(r));
  check(Math.abs(r.rate - 2 / 3) < 1e-9, "and the rate is over what was judged", String(r.rate));
}

// THE defect.
{
  const r = cleanMergeRate("o/r", 10, probeFor({ 1: green, 2: [] }));
  check(r.judged === 1, "a merge with NO checks is not judged", JSON.stringify(r));
  check(r.clean === 1 && Math.abs(r.rate - 1) < 1e-9,
    "so it neither counts as clean nor drags the rate down — it is simply not evidence",
    JSON.stringify(r));
  check(r.unjudged === 1, "and the count of unjudged merges is reported, not hidden", JSON.stringify(r));
}
{
  // Every merge unjudged means there is no rate at all, not a perfect one.
  const r = cleanMergeRate("o/r", 10, probeFor({ 1: [], 2: [] }));
  check(!r.ok, "when nothing can be judged there is no rate", JSON.stringify(r));
  check(/unjudged|no .*judged/i.test(r.why ?? ""), "and it says why", JSON.stringify(r.why));
}

// A required check that never reported is the same absence, one level up.
{
  const partial = [{ name: "Lint", conclusion: "success" }];
  const r = cleanMergeRate("o/r", 10, probeFor({ 1: partial }), { required: ["Lint", "Browser tests"] });
  check(!r.ok || r.unjudged === 1,
    "a merge missing a REQUIRED check is unjudged, not clean", JSON.stringify(r));
}
{
  const full = [{ name: "Lint", conclusion: "success" }, { name: "Browser tests", conclusion: "success" }];
  const r = cleanMergeRate("o/r", 10, probeFor({ 1: full }), { required: ["Lint", "Browser tests"] });
  check(r.ok && r.clean === 1, "control: with every required check green it is clean", JSON.stringify(r));
}

// Not being able to ask is not an answer either.
{
  const r = cleanMergeRate("o/r", 10, { merged: () => [{ number: 1, sha: "s" }], checks: () => null });
  check(!r.ok, "an unreadable API yields no rate rather than a flattering one", JSON.stringify(r));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
