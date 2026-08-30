// Every tracked executable under bin/ must have a lint configuration.
//
// WHY THIS EXISTS. A file eslint has no configuration for is SKIPPED, and `eslint .`
// says nothing about it. Skipped and clean are the same output. That is how widening
// a glob from `bin/reeve` to `bin/*` removed all coverage of the production CLI while
// every command still reported success -- the exact shape of failure this repository
// keeps paying for, arriving through a configuration file.
//
// Flat config matches extensionless files only with a pattern that admits them:
// `bin/*`, `bin/**` and `bin/**/*` all fail; `bin/!(*.*)` works. That is measured
// rather than reasoned, and it is the kind of fact that is easy to get wrong twice.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// fileURLToPath, not the property this repository forbids reading.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "bin"], { encoding: "utf8" })
  .split("\n").filter(Boolean);
check(tracked.length > 0, `control: ${tracked.length} tracked file(s) under bin/, so this is not vacuous`,
  tracked.join(", "));

for (const rel of tracked) {
  let printed = "";
  try {
    printed = execFileSync("npx", ["eslint", "--print-config", rel],
                           { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { printed = ""; }
  let rules = null;
  try { rules = JSON.parse(printed).rules; } catch { /* left null */ }
  check(rules !== null && rules["reeve/no-url-pathname"] !== undefined,
    `${rel} resolves a config that enables the rule`,
    "eslint has no configuration for it, so `eslint .` skips it and prints nothing — " +
    "extensionless files need a pattern like bin/!(*.*)");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
