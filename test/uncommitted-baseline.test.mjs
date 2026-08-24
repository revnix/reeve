// What the dirty gate counts as the worker's work, and what it costs to decide.
//
// The baseline is a path -> digest map of what preparation itself left untracked.
// Two things have to hold at once: a file reeve did not put there is the worker's
// however deep inside a copied tree it sits, and deciding that must not re-read
// the whole tree after every paid worker run.
import { uncommittedFiles } from "../src/daemon.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const root = mkdtempSync(join(tmpdir(), "reeve-baseline-"));
const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
g("init", "-q", "-b", "f");
writeFileSync(join(root, "seed.js"), "seed\n");
g("add", "-A");
g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed");

// An unignored dependency tree, as preparation would leave it.
mkdirSync(join(root, "vendor"), { recursive: true });
const copied = [];
for (let i = 0; i < 40; i++) {
  const rel = `vendor/dep-${String(i).padStart(3, "0")}.js`;
  writeFileSync(join(root, rel), `dependency ${i}\n`);
  copied.push(rel);
}
// A digest that is stable for these files and lets the test count reads. It
// returns null for a path that is not there, because that is what the real
// `digestOf` does and it is exactly what the deleted case depends on -- a fake
// that answered "SAME" for a missing file could not exhibit that at all.
let reads = [];
const digest = abs => { reads.push(abs); return existsSync(abs) ? "SAME" : null; };
const baseline = Object.fromEntries(copied.map(rel => [rel, "SAME"]));

// --- nothing of the worker's -------------------------------------------------
{
  reads = [];
  const left = uncommittedFiles(root, baseline, { digest });
  check(Array.isArray(left) && left.length === 0,
    "an untouched copied tree leaves nothing for the gate to refuse", JSON.stringify(left));
  // The cost half. Every one of these files appears in `status` AND in the
  // baseline, so a check keyed on what FAILED rather than on what status reported
  // hashes each of them twice -- 40 here, up to 20,000 in the bound, each read
  // synchronously and up to 64 MiB.
  const counts = reads.reduce((m, p) => m.set(p, (m.get(p) ?? 0) + 1), new Map());
  const twice = [...counts.entries()].filter(([, n]) => n > 1);
  check(twice.length === 0, "and no path is hashed twice to decide it",
    twice.map(([p, n]) => `${p} x${n}`).slice(0, 3).join(", "));
  check(reads.length > 0, "control: the baseline really was consulted", String(reads.length));
}

// --- the worker's own file, inside the copied tree ---------------------------
{
  writeFileSync(join(root, "vendor", "patch.js"), "the worker's\n");
  reads = [];
  const left = uncommittedFiles(root, baseline, { digest });
  check(left.includes("vendor/patch.js"),
    "a file reeve never put there is the worker's, however deep it sits", JSON.stringify(left));
  rmSync(join(root, "vendor", "patch.js"));
}

// --- a copy the worker EDITED ------------------------------------------------
{
  reads = [];
  const edited = abs => (abs.endsWith("dep-007.js") ? "DIFFERENT" : digest(abs));
  const left = uncommittedFiles(root, baseline, { digest: edited });
  check(left.includes("vendor/dep-007.js"),
    "an edited copy is the worker's, because the digest no longer matches", JSON.stringify(left));
}

// --- a copy the worker DELETED -----------------------------------------------
{
  rmSync(join(root, "vendor", "dep-011.js"));
  // Deleting an untracked file leaves NO status record: there is nothing to report.
  const status = g("status", "--porcelain", "--untracked-files=all");
  check(!status.includes("dep-011"), "control: git reports nothing at all for the deleted copy", status.slice(0, 120));
  reads = [];
  const left = uncommittedFiles(root, baseline, { digest });
  check(left.includes("vendor/dep-011.js"),
    "a deleted copy is still the worker's, though status never mentions it", JSON.stringify(left).slice(0, 200));
}

// --- a copy the worker patched AND declared, which reeve then committed --------
{
  // The legitimate case the declaration exists to permit. reeve force-stages and
  // commits the patched dependency, after which status is silent about it for the
  // same reason a deletion is silent -- nothing is outstanding. Its digest no
  // longer matches the pre-worker baseline precisely BECAUSE the repair is
  // carried, so a sweep that only compares digests refuses the very thing it was
  // asked to ship.
  writeFileSync(join(root, "vendor", "dep-003.js"), "patched by the worker\n");
  g("add", "--force", "--", "vendor/dep-003.js");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fix(ci): patch the dep");
  check(!g("status", "--porcelain", "--untracked-files=all").includes("dep-003"),
    "control: git says nothing about it once committed", g("status", "--porcelain", "--untracked-files=all").slice(0, 100));
  check(g("ls-files", "--", "vendor/dep-003.js") === "vendor/dep-003.js",
    "control: and it is tracked now", "");
  const left = uncommittedFiles(root, baseline, { digest });
  check(!left.includes("vendor/dep-003.js"),
    "a committed dependency patch is NOT reported as uncommitted work", JSON.stringify(left).slice(0, 200));
  // And the deleted one from the block above must still be caught, so this
  // exclusion has not simply switched the sweep off.
  check(left.includes("vendor/dep-011.js"),
    "control: the deleted copy is still caught alongside it", JSON.stringify(left).slice(0, 200));
}

// --- an unreadable checkout fails closed -------------------------------------
{
  const gone = join(root, "does-not-exist");
  check(uncommittedFiles(gone, baseline, { digest }) === null,
    "an unreadable checkout returns null rather than an empty list", "");
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
