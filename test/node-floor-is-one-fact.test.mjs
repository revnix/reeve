// The supported Node floor is ONE fact, and it had three homes.
//
// `package.json` enforces it, `package-lock.json` mirrors it, and `README.md`
// advertises it to whoever is about to install. Two of those drifted to `>=24`
// while the code required 24.10.0 for `DatabaseSync.setAuthorizer`, and they were
// found one at a time, as separate findings, because nothing compares them. A
// fourth home would be found the same way.
//
// This is the comparison. It does not care what the floor IS -- raising it is a
// deliberate act -- only that every place stating it says the same thing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
const readme = readFileSync(join(repo, "README.md"), "utf8");

const declared = pkg.engines?.node;
// The floor has to be READ before it can be compared, and a missing one would
// otherwise make every assertion below compare undefined to undefined and pass.
check(typeof declared === "string" && /^>=\s*\d+(\.\d+){0,2}$/.test(declared),
  "fixture: package.json declares a Node floor this test can compare against",
  String(declared));

check(lock.packages?.[""]?.engines?.node === declared,
  "package-lock.json mirrors package.json's Node floor",
  `lock says ${JSON.stringify(lock.packages?.[""]?.engines?.node)}, package.json says ${JSON.stringify(declared)}`);

// The README states it for humans, in prose. Only the VERSION is compared --
// the sentence around it is free to change.
const want = declared.replace(/^>=\s*/, "");
const stated = readme.match(/\*\*Node\s*(?:≥|>=)\s*([\d.]+?)\.?\*\*/);
check(stated != null,
  "fixture: README states a Node requirement in the form this test reads",
  "expected a line like `- **Node ≥ 24.10.0.**` in README.md");
check(stated?.[1] === want,
  "README advertises the same Node floor the package enforces",
  `README says ${stated?.[1]}, package.json says ${want}`);

// AND THE REASON IS REACHABLE, because a floor without one gets lowered by the
// next person who cannot see why it is there. 24.10.0 is not about `node:sqlite`
// being stable; it is the release that added `DatabaseSync.setAuthorizer`, which
// the guardian's restricted hub connection refuses to open without.
check(/setAuthorizer/.test(readme),
  "and README names what the floor is FOR, not only what it is");

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
