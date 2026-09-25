// Type checking, and the lint rules beside it (#153).
//
// tsc checks each file that starts with `// @ts-check`. The core verdict and
// evidence modules must be among them, so none drops out of checking unseen,
// and the project must check clean. The two lint rules the type checker's first
// bugs called for must fire where they should and nowhere else: no-undef on a
// name nothing defines, and no-use-before-define on a variable read before its
// definition in the same scope, which is the temporal dead zone.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => join(ROOT, "node_modules", ".bin", name);
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// The verdict, and every module that gathers or judges its evidence.
const CORE = ["src/verdict.mjs", "src/pr.mjs", "src/github/reconciler.mjs", "src/watcher.mjs", "src/premerge.mjs",
              "src/mergecheck.mjs", "src/review/derive.mjs", "src/review/ingest.mjs", "src/review/shadow.mjs"];

const project = spawnSync(bin("tsc"), ["-p", ROOT, "--listFilesOnly"], { encoding: "utf8", timeout: 120_000 });
const listed = new Set((project.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
const unchecked = CORE.filter((f) => !readFileSync(join(ROOT, f), "utf8").startsWith("// @ts-check\n") || !listed.has(join(ROOT, f)));
check(project.status === 0 && unchecked.length === 0,
  "the core verdict and evidence modules are type-checked: each starts with // @ts-check and is in the project",
  JSON.stringify({ status: project.status, unchecked }));

const typecheck = spawnSync(bin("tsc"), ["-p", ROOT], { encoding: "utf8", timeout: 120_000 });
check(typecheck.status === 0, "the project type-checks", (typecheck.stdout ?? "").slice(0, 600));

// A file that breaks each rule once, and does three things that are fine: calls
// a function declared below it, which is hoisted, reads, from a function that
// runs later, a variable defined below it, and uses one of Node's globals.
const fixture = [
  "export const early = () => later;",
  "hoisted();",
  "function hoisted() {}",
  "export const x = y + 1;",
  "const y = 2;",
  "missingName();",
  "const later = 3;",
  "process.exitCode = 0;",
].join("\n");
const lint = spawnSync(bin("eslint"), ["--stdin", "--stdin-filename", join(ROOT, "src", "lint-fixture.mjs"), "--format", "json"],
  { cwd: ROOT, input: fixture, encoding: "utf8", timeout: 120_000 });
let messages = [];
try { messages = JSON.parse(lint.stdout)[0]?.messages ?? []; } catch { /* reported below */ }
const found = messages.map((m) => `${m.ruleId}@${m.line}`).sort();
check(JSON.stringify(found) === JSON.stringify(["no-undef@6", "no-use-before-define@4"]),
  "lint flags a name nothing defines and a variable read before its definition, and not a hoisted function, a later read or a Node global",
  JSON.stringify({ found, stderr: (lint.stderr ?? "").slice(0, 300) }));

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
