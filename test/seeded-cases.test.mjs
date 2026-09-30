// The shadow trial's seeded known-bad cases (#293): a recorded pull request,
// and cases that each change one thing about it, judged through reeve's own
// reading code with a stand-in gh and git that serve the recording.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, loadRecording, pinClock, runCase, runSeeded } from "../src/seeded.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const STAND_IN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "seeded-stand-in.mjs");
const r = loadRecording("nextly-1963");
const byName = (/** @type {string} */ n) => /** @type {import("../src/seeded.mjs").Case} */ (CASES.find((c) => c.name === n));

test("the good case passes, and each seeded known-bad case gets its verdict for its own reason", async () => {
  const results = await runSeeded();
  assert.equal(results.length, CASES.length);
  for (const x of results) assert.ok(x.ok, `${x.name}: ${x.detail}`);
  assert.deepEqual(results.filter((x) => x.got === "PASS").map((x) => x.name), ["good"], "only the good case passes");
  assert.ok(results.filter((x) => x.name !== "good").every((x) => x.got === "BLOCK" || x.got === "UNKNOWN"));
});

test("a read the recording doesn't hold makes a case unrunnable, never a verdict", async () => {
  // Without the head's check runs, the read fails as GitHub failing would, and
  // the UNKNOWN a bad case may meet would be a gap in its recording.
  const x = await runCase(r, { name: "a gap", why: "", must: "UNKNOWN", clauses: { ci: "UNKNOWN" },
    edit: (a) => { a.answers = a.answers.filter((y) => !y.call.some((c) => c.includes(`/commits/${r.head}/check-runs`))); } });
  assert.equal(x.ran, false);
  assert.equal(x.ok, false);
  assert.match(x.detail, new RegExp(`made a read its recording doesn't hold: gh api --paginate repos/${r.repo}/commits/${r.head}/check-runs`));
});

test("a case whose pull request can't be judged isn't a verdict", async () => {
  const x = await runCase(r, { name: "no head", why: "", must: "UNKNOWN", clauses: {},
    edit: (a) => a.each(["ls-remote", "refs/heads/"], (y) => (y.call.includes("refs/heads/main") ? {} : { stdout: "" })) });
  assert.equal(x.ran, false);
  assert.equal(x.ok, false);
  assert.match(x.detail, /wasn't judged: the head couldn't be pinned/);
});

test("an edit that finds nothing to change makes a case unrunnable, rather than the good case under its name", async () => {
  const x = await runCase(r, { name: "nothing changed", why: "", must: "PASS", clauses: {}, edit: (a) => a.each(["no such call"], () => ({})) });
  assert.equal(x.ran, false);
  assert.equal(x.ok, false);
  assert.match(x.detail, /couldn't be changed for it: no recorded answer to a call with no such call/);
});

test("a case must come out as it must, and for its own reason", async () => {
  const wrongVerdict = await runCase(r, { ...byName("good"), name: "said to block", must: "BLOCK" });
  assert.equal(wrongVerdict.got, "PASS");
  assert.equal(wrongVerdict.ok, false);
  assert.match(wrongVerdict.detail, /came out PASS, where it must be BLOCK/);
  const wrongReason = await runCase(r, { ...byName("red CI"), name: "red CI, said to be threads", clauses: { threads: "BLOCK" } });
  assert.equal(wrongReason.got, "BLOCK");
  assert.equal(wrongReason.ok, false);
  assert.match(wrongReason.detail, /not for its reason: threads is PASS, not BLOCK/);
});

test("a case is judged at its recording's moment, not today's", async () => {
  const x = await runCase(r, byName("good"));
  assert.equal(x.at, Date.parse(r.at) / 1000);
});

test("a pinned clock reads the time it was pinned at, moves only when advanced, and gives the real one back", () => {
  const Real = Date;
  const { advance, restore } = pinClock(1_900_000_000);
  try {
    assert.equal(Date.now(), 1_900_000_000_000);
    assert.equal(new Date().getTime(), 1_900_000_000_000);
    assert.equal(new Date(0).getTime(), 0, "a time given is still that time");
    advance(300);
    assert.equal(Date.now(), 1_900_000_300_000);
    assert.equal(new Date().getTime(), 1_900_000_300_000);
  } finally {
    restore();
  }
  assert.equal(Date, Real);
});

test("the stand-in answers only a call it holds exactly, and a large answer whole", () => {
  const dir = tempDir("reeve-seeded-stand-in-");
  const big = "x".repeat(1_000_000) + "\n";
  writeFileSync(join(dir, "answers.json"), JSON.stringify([{ call: ["gh", "api", "repos/o/r"], status: 0, stdout: big }]));
  const env = { ...process.env, SEEDED_ANSWERS: join(dir, "answers.json"), SEEDED_MISSES: join(dir, "misses") };
  const whole = spawnSync(process.execPath, [STAND_IN, "gh", "api", "repos/o/r"], { encoding: "utf8", env, maxBuffer: 4_000_000 });
  assert.equal(whole.status, 0);
  assert.equal(whole.stdout.length, big.length, "the whole answer, not what a pipe took before exit");
  const longer = spawnSync(process.execPath, [STAND_IN, "gh", "api", "repos/o/r", "--jq", ".x"], { encoding: "utf8", env });
  assert.equal(longer.status, 1, "a call with more arguments than one recorded isn't that call");
  assert.ok(existsSync(join(dir, "misses")), "and it's written down as a read the recording doesn't hold");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "misses"), "utf8").trim()), ["gh", "api", "repos/o/r", "--jq", ".x"]);
});
