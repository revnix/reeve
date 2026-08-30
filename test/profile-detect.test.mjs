// `detectCommands` had no test file at all, which is the more interesting half
// of what this fixes.
//
// It reads a package.json the repository under inspection wrote, and decides
// whether each intent's script is present, absent, or BROKEN -- broken meaning
// the script runs a tool that is neither a dependency nor installed. That
// verdict goes into a generated profile, so a wrong "present" is a command
// `reeve` will later run and watch fail.
//
// The defect it shipped with: `deps` was a plain object literal and the tool
// name comes from the script BODY, so a script reading `constructor lint .`
// found `Object` on the prototype, `!deps[tool]` was false, and the broken
// check silently skipped -- the one case it exists to report.

import { detectCommands } from "../src/profile/detect.mjs";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dirs = [];
/** A throwaway checkout carrying one package.json, plus optional node_modules/.bin entries. */
const project = (pkg, bins = []) => {
  const d = mkdtempSync(join(tmpdir(), "reeve-detect-"));
  dirs.push(d);
  writeFileSync(join(d, "package.json"), JSON.stringify(pkg, null, 2));
  for (const b of bins) {
    mkdirSync(join(d, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(d, "node_modules", ".bin", b), "#!/bin/sh\n");
  }
  return d;
};
const lintOf = (pkg, bins) => detectCommands(project(pkg, bins), "typescript", "npm").commands.lint;

// ── the three verdicts it exists to produce ─────────────────────────────────
{
  const present = lintOf({ scripts: { lint: "eslint ." }, devDependencies: { eslint: "^9" } });
  check(present.state === "present" && present.cmd === "npm run lint",
    "a declared script whose tool IS a dependency is present, with the command to run it",
    JSON.stringify(present));

  const absent = lintOf({ scripts: { build: "tsc -b" } });
  check(absent.state === "absent" && absent.cmd === null,
    "an intent with no matching script is absent", JSON.stringify(absent));

  const broken = lintOf({ scripts: { lint: "biome check ." }, devDependencies: {} });
  check(broken.state === "broken" && /biome/.test(broken.reason ?? ""),
    "a script whose tool is neither a dependency nor installed is BROKEN, and the tool is named",
    JSON.stringify(broken));
}

// ── a tool name that is also a prototype key ────────────────────────────────
//
// The defect. Each of these is a real string a package.json can contain, and
// each one used to read as "present" because the lookup found an inherited
// property instead of a declared dependency.
{
  for (const tool of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const got = lintOf({ scripts: { lint: `${tool} lint .` }, devDependencies: {} });
    check(got.state === "broken" && new RegExp(tool).test(got.reason ?? ""),
      `a script running '${tool}' is BROKEN, not silently present`, JSON.stringify(got));
  }

  // NEGATIVE CONTROL: the fixture really can exhibit the defect. A plain-object
  // lookup built from the SAME package.json must find these truthy -- otherwise
  // the assertions above would pass for a reader that still had the bug, and
  // they would be measuring nothing.
  const pkg = { scripts: { lint: "constructor lint ." }, devDependencies: {} };
  const plain = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  check(Boolean(plain["constructor"]) === true,
    "negative control: a PLAIN-object lookup finds `constructor` truthy on that same input",
    JSON.stringify(typeof plain["constructor"]));
  const nullProto = Object.assign(Object.create(null), pkg.dependencies, pkg.devDependencies);
  check(nullProto["constructor"] === undefined,
    "control: and a null-prototype one does not, which is the whole difference");
}

// ── the two ways a tool is legitimately fine ────────────────────────────────
{
  // A local binary, with no dependency entry at all.
  const local = lintOf({ scripts: { lint: "biome check ." } }, ["biome"]);
  check(local.state === "present",
    "a tool present in node_modules/.bin is not broken, even with no dependency entry",
    JSON.stringify(local));

  // The allowlisted runners, which are never dependencies of the project.
  for (const runner of ["node", "tsc", "pnpm", "npm", "yarn", "turbo", "nx"]) {
    const got = lintOf({ scripts: { lint: `${runner} something` }, devDependencies: {} });
    check(got.state === "present", `'${runner}' is allowlisted and stays present`, JSON.stringify(got));
  }
  // CONTROL: the allowlist is not simply everything. A near-miss must still be
  // broken, or the regexp is matching more than it names.
  const near = lintOf({ scripts: { lint: "nodemon x" }, devDependencies: {} });
  check(near.state === "broken",
    "control: a name merely STARTING with an allowlisted one is still broken", JSON.stringify(near));
}

// ── a package.json that is not what it claims ───────────────────────────────
{
  const noScripts = lintOf({ devDependencies: { eslint: "^9" } });
  check(noScripts.state === "absent", "a package.json with no scripts at all is absent, not a crash",
    JSON.stringify(noScripts));

  // `scripts` keyed by a prototype name must not make an intent appear.
  const protoScript = lintOf({ scripts: { __proto__: { lint: "eslint ." } }, devDependencies: {} });
  check(protoScript.state === "absent",
    "a `__proto__` entry in scripts does not conjure an intent", JSON.stringify(protoScript));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
