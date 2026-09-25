// scripts/test-reporter.mjs: the node:test reporter the stub sweep runs every
// test file with, so a node:test file prints this repository's `PASS  name` and
// `FAIL  name` lines (#224). Written with node:test, as new tests are.
//
// One fixture file holds every shape a test can take, and runs once under the
// reporter; each test below reads the lines it printed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fixtures/temp.mjs";

const REPORTER = fileURLToPath(new URL("../scripts/test-reporter.mjs", import.meta.url));
const shapes = join(tempDir("reeve-reporter-"), "shapes.test.mjs");
writeFileSync(shapes, `import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
test("passes", () => { assert.equal(1, 1); });
test("fails an assertion", () => { assert.equal(1, 2); });
test("throws a TypeError", () => { const x = undefined; return x.y; });
test("times out", { timeout: 50 }, async () => { await new Promise((r) => setTimeout(r, 2_000)); });
test("a parent", async (t) => {
  await t.test("child passes", () => {});
  await t.test("child fails", () => { assert.ok(false); });
});
describe("a group", () => { it("in a group", () => {}); });
test("skipped", { skip: true }, () => {});
test("todo", { todo: true }, () => {});
test("two\\nlines", () => {});
`);
const run = spawnSync(process.execPath, [`--test-reporter=${REPORTER}`, "--test-reporter-destination=stdout", shapes],
  { encoding: "utf8", timeout: 60_000 });
const lines = (run.stdout ?? "").split("\n").filter(Boolean);

test("a passing test prints PASS and its name", () => {
  assert.ok(lines.includes("PASS  passes"), lines.join("\n"));
});

test("a failed assertion prints FAIL and its name", () => {
  assert.ok(lines.includes("FAIL  fails an assertion"), lines.join("\n"));
});

test("a test that throws anything but an assertion error prints ERROR, never PASS or FAIL", () => {
  assert.ok(lines.some((l) => l.startsWith("ERROR  throws a TypeError: ")), lines.join("\n"));
  assert.ok(!lines.some((l) => /^(PASS|FAIL) {2}throws a TypeError/.test(l)), lines.join("\n"));
});

test("a test that times out prints ERROR", () => {
  assert.ok(lines.some((l) => l.startsWith("ERROR  times out: ")), lines.join("\n"));
});

test("subtests print each, and their parent fails with them", () => {
  assert.deepEqual(lines.filter((l) => /child|a parent/.test(l)), ["PASS  child passes", "FAIL  child fails", "FAIL  a parent"]);
});

test("a describe block prints nothing, and the tests in it print", () => {
  assert.ok(lines.includes("PASS  in a group"), lines.join("\n"));
  assert.ok(!lines.some((l) => / {2}a group$/.test(l)), lines.join("\n"));
});

test("a skipped or todo test prints nothing", () => {
  assert.ok(!lines.some((l) => /skipped|todo/.test(l)), lines.join("\n"));
});

test("a name on several lines prints on one", () => {
  assert.ok(lines.includes("PASS  two lines"), lines.join("\n"));
});

test("the file exits as node decides: non-zero when a test failed", () => {
  assert.equal(run.status, 1, run.stderr);
});
