// The stub sweep runs each test file offline, as the runner runs it (#257).
//
// After #253, `npm test` and CI give every test file the tests' offline gh first
// on PATH and an empty home of its own. A sweep's child got neither, so a stub
// that switched off one of a test's stand-ins sent its read to whatever gh came
// first, under the developer's own login, and a stub that made a test write into
// its home wrote into the real one. The escape probe is the exception here as in
// CI: it measures the sandbox against the real gh and home, and so do its stubs.
//
// This runs the real sweep on a throwaway repository, with a gh of its own first
// on the sweep's PATH that stands for the real one and notes each call.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fixtures/temp.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/stub-sweep.mjs", import.meta.url));
const root = tempDir("reeve-sweep-offline-");
const bin = tempDir("reeve-sweep-realgh-");
const home = tempDir("reeve-sweep-home-");
const called = join(bin, "called");
// The stand-in for the developer's real gh: it answers, and writes down that it did.
writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${called}"\necho real\n`, { mode: 0o755 });

mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
writeFileSync(join(root, "src", "read.mjs"),
  `import { execFileSync } from "node:child_process";\n` +
  `import { mkdirSync, writeFileSync } from "node:fs";\n` +
  `import { homedir } from "node:os";\n` +
  `import { join } from "node:path";\n` +
  `export function read(seam = null) {\n` +
  `  if (seam) return seam();\n` +
  `  try { return execFileSync("gh", ["api", "repos/o/r"], { encoding: "utf8" }).trim(); } catch { return "unreachable"; }\n` +
  `}\n` +
  `export function save(at = null) {\n` +
  `  const dir = at ?? join(homedir(), ".reeve");\n` +
  `  mkdirSync(dir, { recursive: true });\n` +
  `  writeFileSync(join(dir, "note"), "x");\n` +
  `  return dir;\n` +
  `}\n`);
writeFileSync(join(root, "test", "read.test.mjs"),
  `import test from "node:test";\n` +
  `import assert from "node:assert/strict";\n` +
  `import { mkdtempSync, rmSync } from "node:fs";\n` +
  `import { tmpdir } from "node:os";\n` +
  `import { join } from "node:path";\n` +
  `import { read, save } from "../src/read.mjs";\n` +
  `test("a read goes through its stand-in", () => { assert.equal(read(() => "stand-in"), "stand-in"); });\n` +
  `test("a note goes where it is told", () => {\n` +
  `  const at = mkdtempSync(join(tmpdir(), "n-"));\n` +
  `  try { assert.equal(save(at), at); } finally { rmSync(at, { recursive: true, force: true }); }\n` +
  `});\n`);
// The escape probe, by name: it reads through the real gh on purpose.
writeFileSync(join(root, "test", "escape.test.mjs"),
  `import test from "node:test";\n` +
  `import assert from "node:assert/strict";\n` +
  `import { read } from "../src/read.mjs";\n` +
  `test("the probe reaches the real gh", () => { assert.equal(read(), "real"); });\n`);
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "sweep@example.invalid");
git("config", "user.name", "sweep");

/** Sweep one manifest entry, with the stand-in for the real gh first on the sweep's own PATH. */
const sweep = (stub) => {
  writeFileSync(join(root, "test", "stub-manifest.mjs"), `export const STUBS = ${JSON.stringify([{ why: "a stub", ...stub }], null, 2)};\n`);
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  const env = { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs"),
                PATH: `${bin}:${process.env.PATH}`, HOME: home, REEVE_HOME: join(home, "reeve-home") };
  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8", env });
  return { exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const readCalls = () => (existsSync(called) ? readFileSync(called, "utf8") : "");

test("a stub that switches off a test's stand-in meets the offline gh, never the real one", () => {
  const before = readCalls();
  const r = sweep({ name: "seam-off", test: "test/read.test.mjs", expectRed: "a read goes through its stand-in",
                    edits: [{ file: "src/read.mjs", find: "  if (seam) return seam();", replace: "" }] });
  assert.match(r.out, /1\/1 stub\(s\) caught/, r.out.slice(-600));
  assert.equal(readCalls(), before, "the swept file reached the real gh");
});

test("a stub that sends a test's write into its home writes into a home of its own", () => {
  const r = sweep({ name: "home-write", test: "test/read.test.mjs", expectRed: "a note goes where it is told",
                    edits: [{ file: "src/read.mjs", find: "  const dir = at ?? join(homedir(), \".reeve\");", replace: "  const dir = join(homedir(), \".reeve\");" }] });
  assert.match(r.out, /1\/1 stub\(s\) caught/, r.out.slice(-600));
  assert.equal(existsSync(join(home, ".reeve")), false, "the swept file wrote into the sweep's own home");
});

test("the escape probe keeps the real gh, as CI gives it", () => {
  const before = readCalls();
  const r = sweep({ name: "probe-off", test: "test/escape.test.mjs", expectRed: "the probe reaches the real gh",
                    edits: [{ file: "src/read.mjs", find: "  try { return execFileSync(\"gh\", [\"api\", \"repos/o/r\"], { encoding: \"utf8\" }).trim(); } catch { return \"unreachable\"; }",
                              replace: "  return \"no probe\";" }] });
  assert.match(r.out, /1\/1 stub\(s\) caught/, r.out.slice(-600));
  assert.notEqual(readCalls(), before, "the escape probe's control run never reached the real gh");
});

// ── a control run the runner would fail proves nothing ────────────────────────

const verdictOf = (out, name) => new RegExp(`${name}\\s+([A-Z_]+)`).exec(out)?.[1] ?? "none";

test("a control run that reaches gh is unrunnable, as the runner fails that file", () => {
  writeFileSync(join(root, "test", "strays.test.mjs"),
    `import test from "node:test";\n` +
    `import assert from "node:assert/strict";\n` +
    `import { read } from "../src/read.mjs";\n` +
    `test("a read that can't be reached still answers", () => { assert.equal(typeof read(), "string"); });\n`);
  const r = sweep({ name: "strays-gh", test: "test/strays.test.mjs", expectRed: "a read that can't be reached still answers",
                    edits: [{ file: "src/read.mjs", find: "catch { return \"unreachable\"; }", replace: "catch { return 0; }" }] });
  assert.equal(verdictOf(r.out, "strays-gh"), "UNRUNNABLE", r.out.slice(-600));
  assert.match(r.out, /called gh/);
});

test("a control run that writes into its home's .reeve is unrunnable too", () => {
  writeFileSync(join(root, "test", "writes.test.mjs"),
    `import test from "node:test";\n` +
    `import assert from "node:assert/strict";\n` +
    `import { save } from "../src/read.mjs";\n` +
    `test("a note is kept somewhere", () => { assert.ok(save()); });\n`);
  const r = sweep({ name: "writes-home", test: "test/writes.test.mjs", expectRed: "a note is kept somewhere",
                    edits: [{ file: "src/read.mjs", find: "  return dir;", replace: "  return \"\";" }] });
  assert.equal(verdictOf(r.out, "writes-home"), "UNRUNNABLE", r.out.slice(-600));
  assert.match(r.out, /wrote into its home's \.reeve/);
});
