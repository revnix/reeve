// A workspace member without a lockfile of its own uses the root's package manager.
//
// A pnpm workspace keeps one lockfile, at its root, and none in its members; npm,
// yarn and bun workspaces do the same. Detection read each unit's lockfile alone,
// so a member unit had none, got no package manager at all, and had its commands
// written as `npm run ...`. On Nextly that was `e2e`, a member of the root's pnpm
// workspace: `reeve init` wrote `npm run lint` for it and reported that no package
// manager was settled.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectUnits } from "../src/profile/detect.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const scripts = { lint: "eslint .", "check-types": "tsc --noEmit" };
const devDependencies = { eslint: "9.0.0", typescript: "5.0.0" };

/** A checkout: files by relative path, each a string or an object written as JSON. */
function checkout(files) {
  const root = tempDir("reeve-ws-");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}
const unit = (root, id) => detectUnits(root).units.find(u => u.id === id);

test("a pnpm workspace member without a lockfile uses pnpm, as the root does", () => {
  const root = checkout({
    "package.json": { name: "root", scripts, devDependencies },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  # Browser tests.\n  - "e2e"\n',
    "e2e/package.json": { name: "e2e", scripts, devDependencies },
  });
  const e2e = unit(root, "e2e");
  assert.equal(e2e.packageManager, "pnpm");
  assert.equal(e2e.commands.lint.cmd, "pnpm run lint");
  assert.equal(e2e.commands.typecheck.cmd, "pnpm run check-types");
});

test("an npm workspace member without a lockfile uses npm, as the root does", () => {
  const root = checkout({
    "package.json": { name: "root", workspaces: ["tools"], scripts, devDependencies },
    "package-lock.json": { lockfileVersion: 3 },
    "tools/package.json": { name: "tools", scripts, devDependencies },
  });
  assert.equal(unit(root, "tools").packageManager, "npm");
});

test("a folder the workspace doesn't list is not given the root's package manager", () => {
  const root = checkout({
    "package.json": { name: "root", scripts, devDependencies },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - e2e\n",
    "other/package.json": { name: "other", scripts, devDependencies },
  });
  assert.equal(unit(root, "other").packageManager, null);
});

test("a folder the workspace excludes with ! is not given the root's package manager", () => {
  const root = checkout({
    "package.json": { name: "root", scripts, devDependencies },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - '*'\n  - '!sandbox'\n",
    "e2e/package.json": { name: "e2e", scripts, devDependencies },
    "sandbox/package.json": { name: "sandbox", scripts, devDependencies },
  });
  assert.equal(unit(root, "e2e").packageManager, "pnpm");
  assert.equal(unit(root, "sandbox").packageManager, null);
});

test("a folder that isn't a JavaScript package doesn't take a JavaScript workspace's manager, whatever the glob says", () => {
  const root = checkout({
    "package.json": { name: "root", scripts, devDependencies },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - '*'\n",
    "e2e/package.json": { name: "e2e", scripts, devDependencies },
    "tools/pyproject.toml": "[project]\nname = \"tools\"\n",
  });
  assert.equal(unit(root, "e2e").packageManager, "pnpm");
  assert.equal(unit(root, "tools").packageManager, null);
});

test("a quoted glob in an inline list keeps the commas inside it", () => {
  const root = checkout({
    "package.json": { name: "root", scripts, devDependencies },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages: ['{foo,bar}', \"e2e\"]\n",
    "foo/package.json": { name: "foo", scripts, devDependencies },
    "bar/package.json": { name: "bar", scripts, devDependencies },
    "e2e/package.json": { name: "e2e", scripts, devDependencies },
  });
  for (const id of ["foo", "bar", "e2e"]) assert.equal(unit(root, id).packageManager, "pnpm", id);
});

test("a flow list written across lines is read whole", () => {
  const root = checkout({
    "package.json": { name: "root", scripts, devDependencies },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": 'packages: [\n  "apps/*",\n  "e2e"\n]\n',
    "e2e/package.json": { name: "e2e", scripts, devDependencies },
  });
  assert.equal(unit(root, "e2e").packageManager, "pnpm");
});

test("an npm workspace reads its patterns in order, so a later one lists a folder again", () => {
  const root = checkout({
    "package.json": { name: "root", workspaces: ["*", "!bar", "bar", "!baz"], scripts, devDependencies },
    "package-lock.json": { lockfileVersion: 3 },
    "bar/package.json": { name: "bar", scripts, devDependencies },
    "baz/package.json": { name: "baz", scripts, devDependencies },
  });
  assert.equal(unit(root, "bar").packageManager, "npm");
  assert.equal(unit(root, "baz").packageManager, null);
});

test("a member with a lockfile of its own keeps what its lockfile says", () => {
  const root = checkout({
    "package.json": { name: "root", scripts, devDependencies },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages: [e2e]\n",
    "e2e/package.json": { name: "e2e", scripts, devDependencies },
    "e2e/package-lock.json": { lockfileVersion: 3 },
  });
  assert.equal(unit(root, "e2e").packageManager, "npm");
});

test("the inherited package manager is noted, so the operator sees where it came from", () => {
  const root = checkout({
    "package.json": { name: "root", scripts, devDependencies },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n- e2e\n",
    "e2e/package.json": { name: "e2e", scripts, devDependencies },
  });
  assert.match(detectUnits(root).notes.join("\n"), /e2e.*pnpm workspace/);
});
