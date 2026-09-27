// A workspace member's scripts run with the shell its workspace root's .npmrc
// names, since npm reads the root's instead of the member's own. So which
// .npmrc names a member's shell turns on whether the root lists the member, read
// as npm's own matcher reads the patterns, and on both when that can't be told.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectCommands } from "../src/profile/detect.mjs";
import { npmScriptShells } from "../src/profile/shellscript.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const root = tempDir("reeve-npm-shells-");
// npm's settings from the project alone: none from a home or the machine.
const npmEnv = { PATH: process.env.PATH, HOME: join(root, "home"), npm_config_userconfig: join(root, "none"), npm_config_globalconfig: join(root, "none") };

/**
 * A workspace whose root's .npmrc names bash, and whose member at `where`, which
 * `patterns` may list, names sh and has a test script only bash runs. Returns the
 * member's folder.
 */
function member(name, patterns, where) {
  const files = {
    "package.json": JSON.stringify({ workspaces: patterns }),
    ".npmrc": "script-shell=bash\n",
    [`${where}/package.json`]: JSON.stringify({ name: "web", scripts: { test: "[[ -f package.json ]] && jest --ci" }, devDependencies: { jest: "^29.0.0" } }),
    [`${where}/.npmrc`]: "script-shell=/bin/sh\n",
  };
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name, file)), { recursive: true });
    writeFileSync(join(root, name, file), body);
  }
  return join(root, name, where);
}

test("a workspace pattern's braces and classes are read as npm's are, so its member takes the root's shell", () => {
  assert.deepEqual(npmScriptShells(member("braced", ["{packages,apps}/*"], "apps/web"), npmEnv), ["bash"]);
  assert.deepEqual(npmScriptShells(member("classed", ["packages/[a-z]*"], "packages/web"), npmEnv), ["bash"]);
});

test("a workspace pattern the reader can't read leaves both folders' shells in play", () => {
  // A backslash: npm reads it as an escape, and Node's matcher as a separator.
  const dir = member("escaped", ["packages/w\\eb"], "packages/web");
  const shells = npmScriptShells(dir, npmEnv);
  assert.equal(shells.length, 2, JSON.stringify(shells));
  assert.ok(shells.includes("bash"));
  assert.equal(detectCommands(dir, "typescript", "npm").commands.test.state, "present", "a script bash runs isn't called broken");
});
