// The stub sweep reads a node:test file as it reads a script-style one (#224).
//
// node:test's own reporters print neither PASS nor FAIL, so the sweep read a
// file written with it as reporting no assertion at all, and every stub on it
// was CRASHED. The sweep runs each file with scripts/test-reporter.mjs, which
// prints those lines. This runs the real sweep on a throwaway repository whose
// test is written with node:test, and expects the readings a script-style file
// gets: caught, not caught, the wrong check, a crash, and a test that died where
// the one named should have failed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fixtures/temp.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/stub-sweep.mjs", import.meta.url));
const SOURCE = `export function safe(v) {\n  if (typeof v === "object") throw new Error("not a scalar");\n  return String(v);\n}\n`;
const root = tempDir("reeve-sweep-node-test-");
mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
writeFileSync(join(root, "src", "thing.mjs"), SOURCE);
writeFileSync(join(root, "test", "thing.test.mjs"),
  `import test from "node:test";\n` +
  `import assert from "node:assert/strict";\n` +
  `import { safe } from "../src/thing.mjs";\n` +
  `test("an object is refused", () => { assert.throws(() => safe({}), /not a scalar/); });\n` +
  `test("a scalar still works", () => { assert.equal(safe(3), "3"); });\n`);
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "sweep@example.invalid");
git("config", "user.name", "sweep");

// One manifest entry, committed, swept.
const sweep = (stub) => {
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = ${JSON.stringify([{ why: "a node:test stub", test: "test/thing.test.mjs", ...stub }], null, 2)};\n`);
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  return { exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const edit = (find, replace) => [{ file: "src/thing.mjs", find, replace }];
const guardLine = `  if (typeof v === "object") throw new Error("not a scalar");\n`;
const verdict = (out) => /· \S+: ([A-Z_]+)/.exec(out)?.[1] ?? (/CAUGHT/.test(out) ? "CAUGHT" : "none");

test("a node:test file's stub is caught by the test it names", () => {
  const r = sweep({ name: "nt-guard", expectRed: "an object is refused", edits: edit(guardLine, "") });
  assert.equal(r.exit, 0, r.out.slice(-400));
  assert.match(r.out, /1\/1 stub\(s\) caught/, r.out.slice(-400));
});

test("a node:test stub nothing catches fails the sweep as NOT_CAUGHT", () => {
  const r = sweep({ name: "nt-cosmetic", expectRed: "an object is refused", edits: edit("  return String(v);", "  return String(v); // noop") });
  assert.equal(r.exit, 1, r.out.slice(-400));
  assert.equal(verdict(r.out), "NOT_CAUGHT", r.out.slice(-400));
});

test("a node:test stub that fails a different test is WRONG_RED", () => {
  const r = sweep({ name: "nt-adjacent", expectRed: "an object is refused", edits: edit("  return String(v);", `  return String(v) + "!";`) });
  assert.equal(r.exit, 1, r.out.slice(-400));
  assert.equal(verdict(r.out), "WRONG_RED", r.out.slice(-400));
});

test("a node:test file that can't load is CRASHED", () => {
  const r = sweep({ name: "nt-crash", expectRed: "an object is refused", edits: edit("export function safe(v) {", "export function safe(v) { (") });
  assert.equal(r.exit, 1, r.out.slice(-400));
  assert.equal(verdict(r.out), "CRASHED", r.out.slice(-400));
});

test("a node:test test that throws where its assertion should fail is not read as caught", () => {
  // The named test throws a TypeError rather than failing its assertion: it died.
  const r = sweep({ name: "nt-died", expectRed: "a scalar still works", edits: edit("  return String(v);", "  return v.length.toFixed();") });
  assert.equal(r.exit, 1, r.out.slice(-400));
  assert.equal(verdict(r.out), "UNRUNNABLE", r.out.slice(-400));
});

test("the source is restored byte for byte after every stub", () => {
  assert.equal(readFileSync(join(root, "src", "thing.mjs"), "utf8"), SOURCE);
});
