// Stand-in shells, and what setup detection says about one package script, for
// the shell reader's node:test files. test/detect-shell-scripts.test.mjs, the
// older script-style file, keeps its own copies until it moves over.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectCommands } from "../../src/profile/detect.mjs";
import { tempDir } from "./temp.mjs";

// npm's own settings can name another shell: here only a fixture's .npmrc does,
// whatever this machine's user and global config say.
const root = tempDir("reeve-detect-");
for (const key of Object.keys(process.env)) if (/^npm_config_(script_shell|userconfig|globalconfig)$/i.test(key)) delete process.env[key];
process.env.npm_config_userconfig = join(root, "no-user-npmrc");
process.env.npm_config_globalconfig = join(root, "no-global-npmrc");

// The shells say what dash and bash have, as scriptShell asks them, whatever
// this machine's are.
const BUILTINS = ["echo", "printf", "exit", "true", "false", "set", "export", "readonly", "unset", "cd", "read", "trap", "alias",
                  "command", "exec", ":", ".", "test", "["];
const NO_SYNTAX = { "|&": false, "<<<": false, "&>": false, "&>>": false, ">&": false };
export const dashShell = { name: "dash", paths: [], execOptions: false, execEndsOptions: false, appendAssign: false, pipefail: true,
                           badOptionEnds: true, syntax: NO_SYNTAX, unsetLastOptionWins: true, pTakesOperands: false,
                           readonlyAssignEnds: true, builtins: new Set(BUILTINS),
                           keywords: new Set(["if", "for", "while", "until", "case", "!", "{", "}"]) };
export const bashShell = { ...dashShell, name: "bash", execOptions: true, execEndsOptions: true, appendAssign: true, badOptionEnds: false,
                           unsetLastOptionWins: false, pTakesOperands: true,
                           syntax: Object.fromEntries(Object.keys(NO_SYNTAX).map((op) => [op, true])),
                           builtins: new Set([...BUILTINS, "source", "declare"]),
                           keywords: new Set([...dashShell.keywords, "[[", "function", "select", "time"]) };
// Either may run the script, merged as scriptShells merges them: a keyword
// either has, and `allKeywords` for the ones both have.
export const eitherShell = { ...dashShell, name: "dash or bash", unsetLastOptionWins: "maybe", pTakesOperands: "maybe",
                             builtins: new Set([...dashShell.builtins, ...bashShell.builtins]),
                             keywords: new Set([...dashShell.keywords, ...bashShell.keywords]), allKeywords: new Set(dashShell.keywords) };

/** What detection says about `script` as a package's `test` script, run by `runner` under `shell`. */
export function detectTest(script, devDependencies = {}, { shell, files = {}, runner = "npm" } = {}) {
  const dir = join(root, `fixture-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: script }, devDependencies }));
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
    chmodSync(join(dir, file), 0o755);
  }
  return detectCommands(dir, "typescript", runner, shell ? { shell } : {}).commands.test;
}

/** Whether detection read the script as broken, for a reason that names `word` when given. */
export const broken = (r, word) => r.state === "broken" && (word === undefined || r.reason?.includes(word));
