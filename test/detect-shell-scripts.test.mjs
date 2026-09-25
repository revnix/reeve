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
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCommands } from "../src/profile/detect.mjs";
import { npmScriptShells, runnerShells, scriptShells } from "../src/profile/shellscript.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const root = mkdtempSync(join(tmpdir(), "reeve-detect-"));
// npm's own settings can name another shell: here only a fixture's .npmrc does,
// whatever this machine's user and global config say.
for (const key of Object.keys(process.env)) if (/^npm_config_(script_shell|userconfig|globalconfig)$/i.test(key)) delete process.env[key];
process.env.npm_config_userconfig = join(root, "no-user-npmrc");
process.env.npm_config_globalconfig = join(root, "no-global-npmrc");
// What detection says about one script, run as the `test` intent. `shell` stands
// in for the shell npm runs, when a case needs one whatever this machine's is.
const detectTest = (script, devDependencies = {}, { shell, files = {}, runner = "npm" } = {}) => {
  const dir = join(root, `fixture-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: script }, devDependencies }));
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
    chmodSync(join(dir, file), 0o755);
  }
  return detectCommands(dir, "typescript", runner, shell ? { shell } : {}).commands.test;
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
  // Under dash, whose exec takes no options, `exec -a` runs a program called -a.
  const withOptions = ["command -p no-such-runner", "env -i no-such-runner", "env -u HOME no-such-runner"]
    .map((s) => ({ s, r: detectTest(s) }));
  const execOptions = detectTest("exec -a label no-such-runner");
  check(withOptions.every(({ r }) => broken(r, "'no-such-runner'")) && broken(execOptions),
    "options that still run the command, command -p, env -i and -u, exec -a, don't stop it being judged", JSON.stringify({ withOptions, execOptions }));
  const emptied = detectTest("env -i jest --ci", jest);
  check(broken(emptied, "'jest'"),
    "env -i empties the environment, PATH with it, so a dependency's runner isn't found", JSON.stringify(emptied));

  // Words the shell npm runs has, or doesn't, asked of that shell.
  const shell = scriptShells(npmScriptShells(root));
  const asked = (word) => {
    const r = spawnSync(npmScriptShells(root)[0], ["-c", `command -V '${word}'`], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    return / is a (special )?shell builtin| is a (shell keyword|reserved word)/.test(r.stdout + r.stderr);
  };
  const words = [["source", "source ./env.sh && jest --ci"], ["[[", "[[ -f jest.config.js ]] && jest --ci"], ["chdir", "chdir . && jest --ci"],
                 ["function", "function t { jest; }; t"], ["select", "select x in a; do jest; done"]]
    .map(([word, script]) => ({ word, hasIt: asked(word), r: detectTest(script, jest) }));
  check(shell !== null && words.every(({ hasIt, r }) => (r.state === "broken") === !hasIt),
    "a word is the shell's own exactly when the shell npm runs scripts with says so", JSON.stringify({ shell: shell?.name, words }));
  const dashLike = { name: "dash", execOptions: false, appendAssign: false,
                     builtins: new Set(["echo", "printf", "exit", "true", "false", "set", "export", "unset", "cd", "read", "trap", "alias",
                                        "command", "exec", ":", "."]),
                     keywords: new Set(["if", "for", "while", "until", "case", "!", "{", "}"]) };
  const bashLike = { ...dashLike, name: "bash", execOptions: true, appendAssign: true, builtins: new Set([...dashLike.builtins, "source", "declare"]),
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
  check(quotedKeyword.every(({ r }) => broken(r, "as a program")) && quotedBuiltin.state === "present",
    "a quoted reserved word is a program's name, and a quoted builtin still runs", JSON.stringify({ quotedKeyword, quotedBuiltin }));

  // A PATH given with the command is where it's looked up.
  const pathed = ["PATH=/nowhere node --test", "PATH=/nowhere jest --ci", "export PATH=/nowhere; node x", "env PATH=/nowhere node x"]
    .map((s) => ({ s, r: detectTest(s, jest) }));
  const ownBin = detectTest("PATH=./tools runner --ci", {}, { files: { "tools/runner": "#!/bin/sh\n" } });
  const expanded = detectTest("PATH=$HOME/bin:$PATH no-such-runner");
  check(pathed.every(({ r }) => r.state === "broken") && ownBin.state === "present" && expanded.state === "present",
    "a literal PATH before the program is where it's looked up, and a PATH built from expansions isn't judged",
    JSON.stringify({ pathed, ownBin, expanded }));

  // ── read more closely (#205) ──────────────────────────────────────────────
  //
  // Each shape here made a script that passes read as broken, or one that
  // always fails read as present.

  // The shell is the one npm's script-shell setting names, read as npm reads
  // it: the environment first, then the project's .npmrc (its workspace root's,
  // for a workspace), the user's and the global one.
  const tree = (name, files) => {
    const dir = join(root, name);
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), body);
    }
    return dir;
  };
  const npmEnv = { PATH: process.env.PATH, HOME: join(root, "home"), npm_config_userconfig: join(root, "none"), npm_config_globalconfig: join(root, "none") };
  const plain = tree("rc-plain", { "package.json": "{}" });
  const project = tree("rc-project", { "package.json": "{}", ".npmrc": "script-shell = /bin/bash ; ours\n" });
  const userRc = join(tree("rc-user", { ".npmrc": "script-shell=bash\n" }), ".npmrc");
  const globalRc = join(tree("rc-global", { npmrc: "script-shell=ksh\n" }), "npmrc");
  const mono = tree("rc-mono", {
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }), ".npmrc": "script-shell=bash\n",
    "packages/web/package.json": "{}", "packages/web/.npmrc": "script-shell=zsh\n",
    "tools/package.json": "{}", "tools/.npmrc": "script-shell=zsh\n",
  });
  const sectioned = tree("rc-section", { "package.json": "{}", ".npmrc": "[section]\nscript-shell=zsh\n" });
  const replaced = tree("rc-replaced", { "package.json": "{}", ".npmrc": 'script-shell="${SHELL_DIR}/bash"\n' });
  const relativeRc = tree("rc-relative", { "package.json": "{}", ".npmrc": "script-shell=./tools/sh\n" });
  const settings = {
    plain: npmScriptShells(plain, npmEnv),
    project: npmScriptShells(project, npmEnv),
    fromEnv: npmScriptShells(project, { ...npmEnv, npm_config_script_shell: "zsh" }),
    fromEnvUpper: npmScriptShells(project, { ...npmEnv, NPM_CONFIG_SCRIPT_SHELL: "zsh" }),
    user: npmScriptShells(plain, { ...npmEnv, npm_config_userconfig: userRc }),
    projectOverUser: npmScriptShells(project, { ...npmEnv, npm_config_userconfig: userRc }),
    global: npmScriptShells(plain, { ...npmEnv, npm_config_globalconfig: globalRc }),
    workspace: npmScriptShells(join(mono, "packages", "web"), npmEnv),
    notWorkspace: npmScriptShells(join(mono, "tools"), npmEnv),
    section: npmScriptShells(sectioned, npmEnv),
    replaced: npmScriptShells(replaced, { ...npmEnv, SHELL_DIR: "/usr/bin" }),
    relative: npmScriptShells(relativeRc, npmEnv),
  };
  const wanted = { plain: ["sh"], project: ["/bin/bash"], fromEnv: ["zsh"], fromEnvUpper: ["zsh"], user: ["bash"], projectOverUser: ["/bin/bash"],
                   global: ["ksh"], workspace: ["bash"], notWorkspace: ["zsh"], section: ["sh"], replaced: ["/usr/bin/bash"],
                   relative: [join(relativeRc, "tools", "sh")] };
  check(Object.entries(wanted).every(([k, v]) => JSON.stringify(settings[k]) === JSON.stringify(v)),
    "npm's script-shell is read as npm reads it: the environment, then the project's .npmrc, a workspace root's for its workspaces, the user's, the global one",
    JSON.stringify({ settings, wanted }));
  const underBash = detectTest("[[ -f x ]] && jest --ci", jest, { files: { ".npmrc": "script-shell=bash\n" } });
  check(underBash.state === "present",
    "the shell asked is the one npm's script-shell names, so a word of bash's is no missing program under bash", JSON.stringify(underBash));

  // `!` inverts a whole pipeline, and set -e never stops at one it inverts. An
  // exit inside it ends the script before anything is inverted.
  const bangPasses = ["! true | false", "set -e; ! true; echo reached"].map((s) => ({ s, r: detectTest(s) }));
  const bangFails = ["! false | true", "! exit 1"].map((s) => ({ s, r: detectTest(s) }));
  check(bangPasses.every(({ r }) => r.state === "present") && bangFails.every(({ r }) => broken(r, "always fails")),
    "! inverts a whole pipeline, set -e never stops at one, and an exit inside it ends the script first", JSON.stringify({ bangPasses, bangFails }));

  // A line continuation, or a newline after &&, || or |, joins two lines into
  // one list; an operator with nothing after it is a syntax error.
  const joined = [["NODE_ENV=test \\\n  jest --ci", "present"], ["jest --ci ||\n  no-such-runner", "present"],
                  ["echo setup && \\\n  no-such-runner", "'no-such-runner'"], ["no-such-runner &&\n  jest --ci", "'no-such-runner'"],
                  ["jest --ci &&", "syntax error"], ["jest --ci |", "syntax error"],
                  ["jest --ci\n\n", "present"], ["no-such-runner --ci\n", "'no-such-runner'"]]
    .map(([s, want]) => ({ s, want, r: detectTest(s, jest) }));
  check(joined.every(({ want, r }) => (want === "present" ? r.state === "present" : broken(r, want))),
    "a line continuation, or a newline after an operator, joins the lines and makes no empty command; an operator with nothing after it is a syntax error",
    JSON.stringify(joined));

  // A command that ran may have made the program a later one is missing: an
  // install, a build, a command substitution, a file written. One running
  // beside it in a pipeline can't have.
  const madeBefore = ["npm ci && no-such-runner", "node build.js; no-such-runner", "echo x > out.txt && no-such-runner",
                      "echo $(npm ci) && no-such-runner", "no-such-runner $(npm ci)"].map((s) => ({ s, r: detectTest(s) }));
  const beside = detectTest("npm ci | no-such-runner");
  check(madeBefore.every(({ r }) => r.state === "present") && broken(beside, "'no-such-runner'"),
    "a missing program after one that may change files, an install say, may be there by then; one beside it in a pipeline can't be",
    JSON.stringify({ madeBefore, beside }));

  // cd, and env -C, move where relative names are found from. CDPATH can send a
  // bare folder name elsewhere, to a runner that is there.
  const runner = { "tools/runner": "#!/bin/sh\n" };
  const moved = ["cd tools && ./runner --ci", "cd tools && PATH=. runner", "env -C tools ./runner", "cd $DIR && ./runner"]
    .map((s) => ({ s, r: detectTest(s, {}, { files: runner }) }));
  const movedMissing = detectTest("cd tools && ./missing", {}, { files: runner });
  const cdpath = tree("cdpath", { "tools/runner": "#!/bin/sh\n" });
  chmodSync(join(cdpath, "tools", "runner"), 0o755);
  process.env.CDPATH = cdpath;
  const viaCdpath = detectTest("cd tools && ./runner", {}, { files: { "tools/other": "" } });
  delete process.env.CDPATH;
  check(moved.every(({ r }) => r.state === "present") && broken(movedMissing, "'./missing'") && viaCdpath.state === "present",
    "a relative program or PATH entry is found from the folder cd or env -C moved to", JSON.stringify({ moved, movedMissing, viaCdpath }));

  // command -p, and env with PATH unset, look only in the standard path.
  const fixtureRunner = { "fixture-runner": "^1.0.0" };
  const standard = ["command -p fixture-runner --ci", "env -u PATH fixture-runner --ci", "env --unset=PATH fixture-runner --ci"]
    .map((s) => ({ s, r: detectTest(s, fixtureRunner) }));
  const standardOk = ["command -p ls", "env -u HOME fixture-runner --ci"].map((s) => ({ s, r: detectTest(s, fixtureRunner) }));
  check(standard.every(({ r }) => broken(r, "'fixture-runner'")) && standardOk.every(({ r }) => r.state === "present"),
    "command -p and env -u PATH look only in the standard path", JSON.stringify({ standard, standardOk }));

  // An alias defined in the script changes what later words run.
  const aliased = detectTest("alias no-such-runner=true\nno-such-runner");
  check(aliased.state === "present", "an alias definition leaves what follows it unread", JSON.stringify(aliased));

  // A pathname pattern names whatever files match it.
  const pattern = detectTest("./scripts/run-*.sh", {}, { files: { "scripts/run-all.sh": "#!/bin/sh\n" } });
  check(pattern.state === "present",
    "a command word holding a pathname pattern isn't judged: it names whatever files match", JSON.stringify(pattern));

  // set's options end at --, - or its first operand, and a set that may or may
  // not have run leaves set -e unsure.
  const setShapes = ["set -- -e; false; true", "set x -e; false; true", "set - -e; false; true", "set -e; set $FLAGS; false; true",
                     "set -e; jest --ci && set +e; false; true"].map((s) => ({ s, r: detectTest(s, jest) }));
  const setOn = detectTest("set -eo pipefail; false; true");
  check(setShapes.every(({ r }) => r.state === "present") && broken(setOn, "always fails"),
    "set reads options only until --, - or its first operand, and one that may not have run leaves set -e unsure",
    JSON.stringify({ setShapes, setOn }));

  // exec's options are the shell's own: dash's exec takes none.
  const execDash = ["exec -a label jest --ci", "exec -- jest --ci"].map((s) => ({ s, r: detectTest(s, jest, { shell: dashLike }) }));
  const execBash = ["exec -a label jest --ci", "exec -- jest --ci"].map((s) => ({ s, r: detectTest(s, jest, { shell: bashLike }) }));
  const execEnds = detectTest("exec -- jest --ci", jest, { shell: { ...dashLike, execEndsOptions: true } });
  check(broken(execDash[0].r, "'-a'") && broken(execDash[1].r, "'--'") && execBash.every(({ r }) => r.state === "present") && execEnds.state === "present",
    "exec takes options only in a shell whose exec has them: under dash, exec -a runs a program called -a", JSON.stringify({ execDash, execBash, execEnds }));

  // A trap can end the script its own way.
  const trapped = detectTest("trap 'exit 0' EXIT; no-such-runner");
  check(trapped.state === "present", "a trap can decide how the script ends, so a script that sets one isn't judged", JSON.stringify(trapped));

  // A bare exit exits with the status just before it.
  const exitOk = detectTest("false; true && exit");
  const exitFails = detectTest("true; false || exit");
  check(exitOk.state === "present" && broken(exitFails, "always fails"),
    "a bare exit exits with the status just before it, inside an and-or list too", JSON.stringify({ exitOk, exitFails }));

  // A builtin that may set PATH leaves a later missing program unsure.
  const setsPath = [["printf -v PATH %s ./tools; runner", bashLike], ["read PATH < pathfile; runner", undefined]]
    .map(([s, sh]) => ({ s, r: detectTest(s, {}, { shell: sh, files: { ...runner, pathfile: "tools\n" } }) }));
  check(setsPath.every(({ r }) => r.state === "present"),
    "a builtin that may set PATH, printf -v or read, leaves a later missing program unjudged", JSON.stringify(setsPath));

  // Programs are found as npm finds them: in any node_modules/.bin from the
  // package up, and as a dependency of a folder above, such as a workspace root.
  const monorepo = tree("monorepo", {
    "package.json": JSON.stringify({ workspaces: ["web"], devDependencies: { "root-runner": "^1.0.0" } }),
    "node_modules/.bin/hoisted-runner": "#!/bin/sh\n",
  });
  const inWorkspace = ["root-runner --ci", "hoisted-runner --ci", "no-such-runner --ci"].map((script) => {
    tree("monorepo", { "web/package.json": JSON.stringify({ name: "web", scripts: { test: script } }) });
    return { script, r: detectCommands(join(monorepo, "web"), "typescript", "npm").commands.test };
  });
  check(inWorkspace[0].r.state === "present" && inWorkspace[1].r.state === "present" && broken(inWorkspace[2].r, "'no-such-runner'"),
    "a program is found as npm finds it: in any node_modules/.bin from the package up, or as a dependency of a folder above it, such as a workspace root",
    JSON.stringify(inWorkspace));

  // ── the runner's shell, and more of each shell (#205, second round) ─────────
  //
  // Each shape here made a script that passes read as broken.

  // The runner picks the shell. bun takes the first of bash, sh and zsh on the
  // PATH. yarn 2 and later, pnpm's shell emulator and bun's own shell are shells
  // the reader doesn't model, so their scripts aren't judged.
  const which = (name) => realpathSync(spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim());
  const shellsIn = tree("runner-shells", {});
  for (const [folder, name] of [["both", "bash"], ["both", "sh"], ["plain-sh", "sh"]]) {
    mkdirSync(join(shellsIn, folder), { recursive: true });
    symlinkSync(which(name), join(shellsIn, folder, name));
  }
  const at = (folder) => ({ ...npmEnv, PATH: join(shellsIn, folder) });
  const runners = {
    bunWithBash: runnerShells(plain, "bun", at("both")),
    bunWithSh: runnerShells(plain, "bun", at("plain-sh")),
    bunOwnShell: runnerShells(tree("bun-own", { "package.json": "{}", "bunfig.toml": '[run]\nshell = "bun"\n' }), "bun", at("both")),
    yarnBerry: runnerShells(tree("yarn-berry", { "package.json": "{}", ".yarnrc.yml": "nodeLinker: node-modules\n" }), "yarn", npmEnv),
    yarnPinned: runnerShells(tree("yarn-pinned", { "package.json": JSON.stringify({ packageManager: "yarn@4.1.0" }) }), "yarn", npmEnv),
    yarnClassic: runnerShells(tree("yarn-classic", { "package.json": "{}", ".yarnrc": 'script-shell "/bin/bash"\n' }), "yarn", npmEnv),
    pnpmEmulated: runnerShells(tree("pnpm-emulated", { "package.json": "{}", "pnpm-workspace.yaml": "packages: []\nshellEmulator: true\n" }), "pnpm", npmEnv),
    pnpmNpmrcEmulated: runnerShells(tree("pnpm-npmrc-emulated", { "package.json": "{}", ".npmrc": "shell-emulator=true\n" }), "pnpm", npmEnv),
    pnpmScriptShell: runnerShells(tree("pnpm-yaml-shell", { "package.json": "{}", "pnpm-workspace.yaml": "scriptShell: bash\n" }), "pnpm", npmEnv),
    unmodelled: runnerShells(plain, "uv", npmEnv),
  };
  check(JSON.stringify(runners.bunWithBash) === JSON.stringify([which("bash")]) && JSON.stringify(runners.bunWithSh) === JSON.stringify([which("sh")])
    && runners.bunOwnShell === null && runners.yarnBerry === null && runners.yarnPinned === null
    && runners.yarnClassic.includes("/bin/bash") && runners.pnpmEmulated === null && runners.pnpmNpmrcEmulated === null
    && runners.pnpmScriptShell.includes("bash") && runners.unmodelled === null,
    "the runner picks the shell: bun the first of bash, sh and zsh, yarn 1 and pnpm their settings, and yarn 2, an emulator or bun's own shell none the reader models",
    JSON.stringify(runners));
  const underBun = detectTest("[[ -f package.json ]] && jest --ci", jest, { runner: "bun" });
  const underBerry = detectTest("no-such-runner --ci", {}, { runner: "yarn", files: { ".yarnrc.yml": "nodeLinker: node-modules\n" } });
  check(underBun.state === "present" && underBerry.state === "present",
    "a script bun runs is read as bash reads it, and one yarn 2 runs isn't judged", JSON.stringify({ underBun, underBerry }));

  // A list run in the background can't end the script, or move it.
  const background = detectTest("exit 1 & true");
  const movedApart = detectTest("cd tools & ./runner", {}, { files: runner });
  check(background.state === "present" && broken(movedApart, "'./runner'"),
    "a list ended by & runs apart: its exit ends only itself, and its cd moves nothing after it", JSON.stringify({ background, movedApart }));

  // A tilde is a home folder, expanded before the word is used.
  const tildes = ["~/no-such-folder/runner --ci", "PATH=~/no-such-folder no-such-runner"].map((s) => ({ s, r: detectTest(s) }));
  check(tildes.every(({ r }) => r.state === "present"), "a word or a PATH that starts from ~ isn't judged: it's a home folder", JSON.stringify(tildes));

  // bash's own time takes -- as the end of its options.
  const timed = detectTest("time -- jest --ci", jest, { shell: bashLike });
  check(timed.state === "present", "the shell's own time takes -- before the command it times", JSON.stringify(timed));

  // A builtin the lists don't hold is asked of the shell before it's called
  // missing, and bash lists its own.
  const shopt = detectTest("echo setup; shopt -s globstar", {}, { files: { ".npmrc": "script-shell=bash\n" } });
  const askedBash = detectTest("echo setup; shopt -s globstar", {}, { shell: { ...bashLike, paths: ["bash"], builtins: new Set(["echo"]) } });
  check(shopt.state === "present" && askedBash.state === "present",
    "a builtin no list holds is asked of the shell before it's called a missing program", JSON.stringify({ shopt, askedBash }));

  // A workspace pattern's braces are expanded as npm's globs expand them, and a
  // pattern the reader can't match leaves both folders' settings in play.
  const braced = tree("rc-braced", {
    "package.json": JSON.stringify({ workspaces: ["{packages,apps}/*"] }), ".npmrc": "script-shell=bash\n",
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { test: "[[ -f package.json ]] && jest --ci" }, devDependencies: jest }),
    "apps/web/.npmrc": "script-shell=/bin/sh\n",
  });
  const classed = tree("rc-classed", {
    "package.json": JSON.stringify({ workspaces: ["packages/[a-z]*"] }), ".npmrc": "script-shell=bash\n",
    "packages/web/package.json": JSON.stringify({ name: "web", scripts: { test: "[[ -f package.json ]] && jest --ci" }, devDependencies: jest }),
    "packages/web/.npmrc": "script-shell=/bin/sh\n",
  });
  const bracedShells = npmScriptShells(join(braced, "apps", "web"), npmEnv);
  const classedShells = npmScriptShells(join(classed, "packages", "web"), npmEnv);
  const bracedVerdict = detectCommands(join(braced, "apps", "web"), "typescript", "npm").commands.test;
  const classedVerdict = detectCommands(join(classed, "packages", "web"), "typescript", "npm").commands.test;
  check(JSON.stringify(bracedShells) === JSON.stringify(["bash"]) && classedShells.length === 2 && classedShells.includes("bash")
    && bracedVerdict.state === "present" && classedVerdict.state === "present",
    "a workspace pattern's braces are expanded as npm's are, and one the reader can't match leaves both folders' shells in play",
    JSON.stringify({ bracedShells, classedShells, bracedVerdict, classedVerdict }));

  // bash's NAME+=value is an assignment; dash's shell runs it as a program.
  const appended = ["echo setup; PATH+=:/tmp", "PATH+=:/nowhere; no-such-runner"].map((s) => ({ s, r: detectTest(s, {}, { shell: bashLike }) }));
  const appendedDash = detectTest("echo setup; PATH+=:/tmp", {}, { shell: dashLike });
  const appendedBash = detectTest("echo setup; PATH+=:/tmp", {}, { files: { ".npmrc": "script-shell=bash\n" } });
  check(appended.every(({ r }) => r.state === "present") && broken(appendedDash, "'PATH+=:/tmp'") && appendedBash.state === "present",
    "NAME+=value assigns where the shell has it, and adds to PATH what can't be known; where it doesn't, it's a program's name",
    JSON.stringify({ appended, appendedDash, appendedBash }));

  // env takes any word with an = in it for an assignment, quoted or not.
  const envAssigned = ['env "MSG=two words" jest --ci', "env A+=1 jest --ci"].map((s) => ({ s, r: detectTest(s, jest) }));
  check(envAssigned.every(({ r }) => r.state === "present"), "env takes any word with an = in it for an assignment, quoted or not",
    JSON.stringify(envAssigned));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
