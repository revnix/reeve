// A script that starts with a shell word isn't running a missing program (#194).
//
// Setup detection takes a package script's first word to be the program it runs,
// and reports the script broken when that program is neither a dependency nor
// installed. reeve's own `npm test` is a `for` loop over the test files, so init
// warned it ran a missing program called `for`. These tests give the detector one
// fixture per case: keywords, builtins, subshells, assignments (quoted, escaped
// and unbalanced), wrappers that run the next command, expansions, and a program
// that really is missing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCommands } from "../src/profile/detect.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const root = mkdtempSync(join(tmpdir(), "reeve-detect-"));
// What detection says about one script, run as the `test` intent.
const detectTest = (script, devDependencies = {}) => {
  const dir = join(root, `fixture-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: script }, devDependencies }));
  return detectCommands(dir, "typescript", "npm").commands.test;
};

try {
  // The report itself: reeve's own test script.
  const own = detectCommands(ROOT, "typescript", "npm").commands.test;
  check(own.state === "present", "reeve's own test script, a for loop, is not reported broken", JSON.stringify(own));

  const keyword = detectTest('for f in test/*.test.mjs; do node "$f" || exit 1; done');
  check(keyword.state === "present", "a script that starts with a shell keyword is not reported broken", JSON.stringify(keyword));

  const builtin = detectTest("echo no tests yet && exit 0");
  check(builtin.state === "present", "a script that starts with a shell builtin is not reported broken", JSON.stringify(builtin));

  const subshell = detectTest("(cd packages/core && vitest run)");
  check(subshell.state === "present", "a script that starts with a subshell is not reported broken", JSON.stringify(subshell));

  // An assignment isn't the program. The one behind it is, and is judged.
  const assigned = detectTest("NODE_ENV=test jest --ci", { jest: "^29.0.0" });
  check(assigned.state === "present", "a leading assignment before a program that is a dependency is not reported broken", JSON.stringify(assigned));
  const assignedMissing = detectTest("NODE_ENV=test no-such-runner --ci");
  check(assignedMissing.state === "broken" && /'no-such-runner'/.test(assignedMissing.reason ?? ""),
    "a leading variable assignment is skipped, and the program behind it judged", JSON.stringify(assignedMissing));

  // Quotes and escapes keep a value whole, as the shell does, so the program
  // behind it is the one judged.
  const quoted = detectTest('MSG="two words" no-such-runner');
  check(quoted.state === "broken" && /'no-such-runner'/.test(quoted.reason ?? ""),
    "a quoted assignment value that spans words is skipped whole, and the program behind it judged", JSON.stringify(quoted));
  const escaped = detectTest("MSG=hello\\ node no-such-runner");
  check(escaped.state === "broken" && /'no-such-runner'/.test(escaped.reason ?? ""),
    "an escaped space keeps an assignment's value whole, so the program behind it is judged, not the word after the space", JSON.stringify(escaped));
  const unbalanced = detectTest('MSG="unterminated jest');
  check(unbalanced.state === "present", "a script with an unbalanced quote isn't misread, so it isn't judged", JSON.stringify(unbalanced));

  // Wrappers run the command after them.
  const wrapped = ["command", "exec", "time", "nohup", "env NODE_ENV=test"].map((w) => ({ w, r: detectTest(`${w} no-such-runner --ci`) }));
  check(wrapped.every(({ r }) => r.state === "broken" && /'no-such-runner'/.test(r.reason ?? "")),
    "a program run through command, exec, time, nohup or env is judged", JSON.stringify(wrapped));
  const envOk = detectTest("env NODE_ENV=test jest --ci", { jest: "^29.0.0" });
  check(envOk.state === "present", "env before a program that is a dependency is present, not a missing program called env", JSON.stringify(envOk));
  const lookup = detectTest("command -v jest");
  check(lookup.state === "present", "a wrapper given options isn't judged, since command -v only looks a program up", JSON.stringify(lookup));
  const expansion = detectTest("$RUNNER --ci");
  check(expansion.state === "present", "a program named by an expansion isn't judged", JSON.stringify(expansion));

  const missing = detectTest("no-such-runner --ci");
  check(missing.state === "broken" && /runs 'no-such-runner', which is neither a dependency nor installed/.test(missing.reason ?? ""),
    "a script whose program is really missing is still reported broken", JSON.stringify(missing));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
