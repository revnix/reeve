// A script that starts with a shell word isn't running a missing program (#194).
//
// Setup detection takes a package script's first word to be the program it runs,
// and reports the script broken when that program is neither a dependency nor
// installed. reeve's own `npm test` is a `for` loop over the test files, so init
// warned it ran a missing program called `for`. These tests give the detector one
// fixture per case: keywords, builtins, subshells, assignments (quoted, escaped
// and unbalanced), wrappers that run the next command, expansions, and a program
// that really is missing.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCommands } from "../src/profile/detect.mjs";
import { scriptShell } from "../src/profile/shellscript.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const root = mkdtempSync(join(tmpdir(), "reeve-detect-"));
// What detection says about one script, run as the `test` intent. `shell` stands
// in for the shell npm runs, when a case needs one whatever this machine's is.
const detectTest = (script, devDependencies = {}, { shell, files = {} } = {}) => {
  const dir = join(root, `fixture-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: script }, devDependencies }));
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
    chmodSync(join(dir, file), 0o755);
  }
  return detectCommands(dir, "typescript", "npm", shell ? { shell } : {}).commands.test;
};
const broken = (r, word) => r.state === "broken" && (word === undefined || r.reason?.includes(word));

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

  // ── read as the shell runs it (#201) ──────────────────────────────────────
  //
  // Each shape here made a broken script read as present. They are judged only
  // where failure is certain: a script that may still pass stays present.
  const jest = { jest: "^29.0.0" };

  // After command, exec or nohup, an assignment is the program's name. Only env
  // takes assignments after its own name.
  const afterWrapper = ["command", "exec", "nohup"].map((w) => ({ w, r: detectTest(`${w} MODE=test jest`, jest) }));
  check(afterWrapper.every(({ r }) => broken(r, "'MODE=test'") && /only env takes an assignment/.test(r.reason ?? "")),
    "an assignment after command, exec or nohup is a program's name, which fails", JSON.stringify(afterWrapper));

  // A wrapper's options that still run the command don't stop it being judged.
  const withOptions = ["command -p no-such-runner", "env -i no-such-runner", "env -u HOME no-such-runner", "exec -a label no-such-runner"]
    .map((s) => ({ s, r: detectTest(s) }));
  check(withOptions.every(({ r }) => broken(r, "'no-such-runner'")),
    "options that still run the command, command -p, env -i and -u, exec -a, don't stop it being judged", JSON.stringify(withOptions));
  const emptied = detectTest("env -i jest --ci", jest);
  check(broken(emptied, "'jest'"),
    "env -i empties the environment, PATH with it, so a dependency's runner isn't found", JSON.stringify(emptied));

  // Words the shell npm runs has, or doesn't, asked of that shell.
  const shell = scriptShell();
  const asked = (word) => {
    const r = spawnSync("sh", ["-c", `command -V '${word}'`], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    return / is a (special )?shell builtin| is a (shell keyword|reserved word)/.test(r.stdout + r.stderr);
  };
  const words = [["source", "source ./env.sh && jest --ci"], ["[[", "[[ -f jest.config.js ]] && jest --ci"],
                 ["function", "function t { jest; }; t"], ["select", "select x in a; do jest; done"]]
    .map(([word, script]) => ({ word, hasIt: asked(word), r: detectTest(script, jest) }));
  check(shell !== null && words.every(({ hasIt, r }) => (r.state === "broken") === !hasIt),
    "a word is the shell's own exactly when the shell npm runs scripts with says so", JSON.stringify({ shell: shell?.name, words }));
  const dashLike = { name: "dash", builtins: new Set(["echo", "exit", "true", "false", "set", "export", "command", "exec", ":", "."]),
                     keywords: new Set(["if", "for", "while", "until", "case", "!", "{", "}"]) };
  const bashLike = { ...dashLike, name: "bash", builtins: new Set([...dashLike.builtins, "source"]),
                     keywords: new Set([...dashLike.keywords, "[[", "function", "select", "time"]) };
  const onDash = detectTest("[[ -f x ]] && jest --ci", jest, { shell: dashLike });
  const onBash = detectTest("[[ -f x ]] && jest --ci", jest, { shell: bashLike });
  check(broken(onDash, "which dash") && onBash.state === "present",
    "[[ is a missing program under dash and a keyword under bash", JSON.stringify({ onDash, onBash }));

  // A script that always fails.
  const always = ["false", "exit 1", "echo checking && exit 2", "! true"].map((s) => ({ s, r: detectTest(s) }));
  const never = ["true", "exit 0", ":"].map((s) => ({ s, r: detectTest(s) }));
  check(always.every(({ r }) => broken(r, "always fails")) && never.every(({ r }) => r.state === "present"),
    "a script that always fails is broken, and one that always passes isn't", JSON.stringify({ always, never }));

  // Redirections before the command are skipped.
  const redirected = [">out no-such-runner", "2>&1 no-such-runner --ci", "<in no-such-runner"].map((s) => ({ s, r: detectTest(s) }));
  const redirectedOk = detectTest(">out jest --ci", jest);
  check(redirected.every(({ r }) => broken(r, "'no-such-runner'")) && redirectedOk.state === "present",
    "a redirection before the command is skipped, and the program behind it judged", JSON.stringify({ redirected, redirectedOk }));

  // Commands after the first, by the operators' own rules.
  const later = ["echo setup && no-such-runner", "set -e; no-such-runner; true", "cat input | no-such-runner", "true || false; no-such-runner"]
    .map((s) => ({ s, r: detectTest(s) }));
  const survives = ["no-such-runner; true", "no-such-runner || true", "no-such-runner | cat", "set -e; false && true; echo ok",
                    "exit 0; no-such-runner", "no-such-runner && for f in a; do echo; done; true"].map((s) => ({ s, r: detectTest(s) }));
  check(later.every(({ r }) => broken(r, "'no-such-runner'")),
    "a missing program after a first command is judged when it decides the result: after &&, under set -e, at a pipeline's end", JSON.stringify(later));
  check(survives.every(({ r }) => r.state === "present"),
    "and not where the script can still pass: before ; or ||, earlier in a pipeline, after exit, or before commands that aren't read", JSON.stringify(survives));

  // A reserved word only counts unquoted; a quoted builtin still runs.
  const quotedKeyword = ['"for" x', "'if' y", "\\while z"].map((s) => ({ s, r: detectTest(s) }));
  const quotedBuiltin = detectTest("'echo' hi");
  check(quotedKeyword.every(({ r }) => r.state === "broken") && quotedBuiltin.state === "present",
    "a quoted reserved word is a program's name, and a quoted builtin still runs", JSON.stringify({ quotedKeyword, quotedBuiltin }));

  // A PATH given with the command is where it's looked up.
  const pathed = ["PATH=/nowhere node --test", "PATH=/nowhere jest --ci", "export PATH=/nowhere; node x", "env PATH=/nowhere node x"]
    .map((s) => ({ s, r: detectTest(s, jest) }));
  const ownBin = detectTest("PATH=./tools runner --ci", {}, { files: { "tools/runner": "#!/bin/sh\n" } });
  const expanded = detectTest("PATH=$HOME/bin:$PATH no-such-runner");
  check(pathed.every(({ r }) => r.state === "broken") && ownBin.state === "present" && expanded.state === "present",
    "a literal PATH before the program is where it's looked up, and a PATH built from expansions isn't judged",
    JSON.stringify({ pathed, ownBin, expanded }));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
