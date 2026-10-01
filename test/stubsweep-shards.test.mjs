// The stub sweep split into shards, judged as one sweep (#324).
//
// The whole manifest no longer fits one CI job's time limit, so the nightly
// sweep runs it as shards in parallel. A shard proves only the entries it ran,
// so the verdict comes from combining every shard's report: refused unless each
// shard reported once, at one commit, and every entry asked for was measured
// exactly once. A shard that stopped early, timed out or never ran must not read
// as entries that passed, and the orphan check, which only a whole run can make,
// must survive the split.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sweep from "../src/stubsweep.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/stub-sweep.mjs", import.meta.url));
/** @type {any} */ const S = sweep;
const fn = (/** @type {string} */ name) => (typeof S[name] === "function" ? S[name] : () => assert.fail(`src/stubsweep.mjs has no ${name}`));

test("a shard is i/n, counted from 1, and anything else is refused rather than read as some shard", () => {
  const parse = fn("parseShard");
  assert.equal(parse(undefined), null);
  assert.equal(parse(""), null);
  assert.deepEqual(parse("1/4"), { index: 1, count: 4 });
  assert.deepEqual(parse("4/4"), { index: 4, count: 4 });
  for (const bad of ["0/4", "5/4", "1/0", "a/4", "1/4/2", " 1/4", "1 / 4", "-1/4", "1.5/4"])
    assert.match(String(parse(bad)?.error), /STUB_SWEEP_SHARD must be i\/n/, `${JSON.stringify(bad)} is refused`);
});

test("the shards of a sweep partition its entries: each in exactly one shard, in the manifest's order", () => {
  const shardOf = fn("shardOf");
  const entries = Array.from({ length: 11 }, (_, k) => ({ name: `e${k}` }));
  for (let count = 1; count <= 5; count++) {
    const shards = Array.from({ length: count }, (_, i) => shardOf(entries, { index: i + 1, count }).map((/** @type {any} */ e) => e.name));
    const all = shards.flat();
    assert.equal(all.length, entries.length, `${count} shard(s) between them run every entry once`);
    assert.deepEqual([...all].sort(), entries.map((e) => e.name).sort());
    for (const s of shards) assert.deepEqual(s, entries.map((e) => e.name).filter((n) => s.includes(n)), "in the manifest's order");
    assert.ok(Math.max(...shards.map((s) => s.length)) - Math.min(...shards.map((s) => s.length)) <= 1, "and evenly");
  }
});

test("the shards' reports combine into one sweep's results, refused for a shard that didn't report, an entry not measured once, another commit or another ask", () => {
  const combine = fn("combineShards");
  const manifest = ["a", "b", "c"].map((name) => ({ name, test: "test/t.test.mjs" }));
  const caught = (/** @type {string} */ name) => ({ name, verdict: "CAUGHT" });
  const report = (/** @type {string} */ shard, /** @type {string[]} */ names, over = {}) =>
    ({ shard, head: "h1", wanted: [], results: names.map(caught), ...over });
  const one = report("1/2", ["a", "c"]), two = report("2/2", ["b"]);
  const ok = combine(manifest, [two, one], { head: "h1" });
  assert.deepEqual(ok.refusals, []);
  assert.deepEqual(ok.results.map((/** @type {any} */ r) => r.name), ["a", "b", "c"], "in the manifest's order");
  assert.equal(ok.whole, true, "every entry asked for, so a whole sweep");
  const refused = (/** @type {any[]} */ reports, /** @type {RegExp} */ why) => {
    const r = combine(manifest, reports, { head: "h1" });
    assert.match(r.refusals.join("\n"), why, JSON.stringify(r.refusals));
  };
  refused([], /no shard reported/);
  refused([one], /shard 2\/2 never reported/);
  refused([one], /1 entry never measured: b/);
  refused([one, one, two], /shard 1\/2 reported 2 times/);
  refused([one, report("1/2", ["a"], { shard: "2/2" }), two], /shard 2\/2 reported 2 times/);
  refused([one, report("2/2", ["b", "c"])], /1 entry measured more than once: c/);
  refused([one, report("2/2", ["b"], { head: "h0" })], /shard 2\/2 swept h0, not h1/);
  // A shard that never finished leaves a report saying so, which replaces one an earlier attempt left.
  refused([one, { shard: "2/2", incomplete: true }], /shard 2\/2 didn't finish/);
  refused([one, report("2/2", ["b"], { wanted: ["b"] })], /the shards were asked for different entries/);
  refused([one, report("2/2", ["b", "zz"])], /1 result for an entry this sweep didn't ask for: zz/);
  refused([one, report("2/3", ["b"])], /a report isn't one of 2 shards: "2\/3"/);
  refused([report("", ["a", "b", "c"], { shard: null })], /a report isn't one of/);
  // Asked for some entries only: measured once each, and not a whole sweep.
  const some = combine(manifest, [report("1/2", ["a"], { wanted: ["a", "b"] }), report("2/2", ["b"], { wanted: ["a", "b"] })], { head: "h1" });
  assert.deepEqual(some.refusals, []);
  assert.equal(some.whole, false);
});

// A throwaway repository with three entries, all caught, swept as shards.
// The null guard first: `typeof null` is "object", so the object guard would answer for it.
const SOURCE = `export function safe(v) {\n  if (v === null) throw new Error("null");\n  if (typeof v === "object") throw new Error("not a scalar");\n  if (v === undefined) throw new Error("no value");\n  return String(v);\n}\n`;
function fixture(/** @type {string} */ extraTest = "") {
  const root = tempDir("reeve-sweep-shards-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), SOURCE);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { safe } from "../src/thing.mjs";\n` +
    `test("an object is refused", () => { assert.throws(() => safe({}), /not a scalar/); });\n` +
    `test("no value is refused", () => { assert.throws(() => safe(undefined), /no value/); });\n` +
    `test("null is refused", () => { assert.throws(() => safe(null), /null/); });\n` + extraTest);
  const guard = (/** @type {string} */ name, /** @type {string} */ red, /** @type {string} */ line) =>
    ({ name, why: `drop the ${name} guard`, test: "test/thing.test.mjs", expectRed: red, edits: [{ file: "src/thing.mjs", find: line, replace: "" }] });
  writeFileSync(join(root, "test", "stub-manifest.mjs"), `export const STUBS = ${JSON.stringify([
    guard("object", "an object is refused", `  if (typeof v === "object") throw new Error("not a scalar");\n`),
    guard("undefined", "no value is refused", `  if (v === undefined) throw new Error("no value");\n`),
    guard("null", "null is refused", `  if (v === null) throw new Error("null");\n`),
  ], null, 2)};\n`);
  const git = (/** @type {string[]} */ ...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "sweep@example.invalid"); git("config", "user.name", "sweep");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  return { root, git, reports: tempDir("reeve-sweep-reports-") };
}
const run = (/** @type {string} */ root, /** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}) => {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd: root, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs"), ...env } });
  return { exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const readOr = (/** @type {string} */ p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

test("a sweep run as shards, each reporting what it ran, combines into the verdict a whole run gives, orphan check included", () => {
  const { root, git, reports } = fixture();
  const shard = (/** @type {number} */ i) => run(root, [], { STUB_SWEEP_SHARD: `${i}/2`, STUB_SWEEP_RESULTS: join(reports, `shard-${i}.json`) });
  const one = shard(1), two = shard(2);
  assert.equal(one.exit, 0, one.out.slice(-600));
  const first = readOr(join(reports, "shard-1.json"));
  assert.deepEqual(first?.results?.map((/** @type {any} */ r) => r.name), ["object", "null"], "shard 1 of 2 ran the 1st and 3rd entries: " + one.out.slice(-600));
  assert.equal(first.shard, "1/2");
  assert.equal(first.head, git("rev-parse", "HEAD").trim());
  assert.doesNotMatch(one.out, /\bundefined\b.*CAUGHT/, "and not the 2nd");
  assert.equal(two.exit, 0, two.out.slice(-600));
  assert.deepEqual(readOr(join(reports, "shard-2.json"))?.results?.map((/** @type {any} */ r) => r.name), ["undefined"]);
  const both = run(root, ["--combine", join(reports, "shard-1.json"), join(reports, "shard-2.json")]);
  assert.equal(both.exit, 0, both.out.slice(-600));
  assert.match(both.out, /3\/3 stub\(s\) caught/);
  assert.match(both.out, /3 entries over 1 of 1 test file\(s\); 0 grandfathered/);
  // One shard's report alone isn't the sweep.
  const half = run(root, ["--combine", join(reports, "shard-1.json")]);
  assert.equal(half.exit, 1, half.out.slice(-600));
  assert.match(half.out, /shard 2\/2 never reported/);
  // A test file with no entry: no shard can see it's an orphan, the combined sweep must.
  writeFileSync(join(root, "test", "orphan.test.mjs"), `import test from "node:test";\ntest("nothing", () => {});\n`);
  git("add", "-A"); git("commit", "-q", "-m", "an orphan");
  assert.equal(shard(1).exit, 0, "a shard can't judge orphans");
  assert.equal(shard(2).exit, 0);
  const orphaned = run(root, ["--combine", join(reports, "shard-1.json"), join(reports, "shard-2.json")]);
  assert.equal(orphaned.exit, 1, orphaned.out.slice(-600));
  assert.match(orphaned.out, /no manifest entry and are not grandfathered:\n {2}test\/orphan\.test\.mjs/);
});

test("a shard asked for wrongly, or a combine given no report, is refused before anything runs", () => {
  const { root } = fixture();
  const bad = run(root, [], { STUB_SWEEP_SHARD: "3/2" });
  assert.equal(bad.exit, 2, bad.out.slice(-400));
  assert.match(bad.out, /STUB_SWEEP_SHARD must be i\/n/);
  assert.doesNotMatch(bad.out, /CAUGHT/, "nothing ran");
  const none = run(root, ["--combine"]);
  assert.equal(none.exit, 2, none.out.slice(-400));
  assert.match(none.out, /--combine needs the shards' reports/);
  const both = run(root, ["--combine", "x.json"], { STUB_SWEEP_SHARD: "1/2" });
  assert.equal(both.exit, 2, both.out.slice(-400));
  assert.match(both.out, /--combine judges every shard/);
});

test("a test the sweep runs gets none of the sweep's own shard or report settings", () => {
  // A test that runs a sweep of its own, as the sweep's tests do, would otherwise run a shard of it, and write its report over this one's.
  const { root, reports } = fixture(`test("the sweep's shard and report aren't the test's", () => {\n` +
    `  assert.equal(process.env.STUB_SWEEP_SHARD, undefined);\n  assert.equal(process.env.STUB_SWEEP_RESULTS, undefined);\n});\n`);
  const report = join(reports, "shard-1.json");
  const r = run(root, [], { STUB_SWEEP_SHARD: "1/1", STUB_SWEEP_RESULTS: report });
  assert.equal(r.exit, 0, r.out.slice(-600));
  assert.match(r.out, /3\/3 stub\(s\) caught/);
  assert.deepEqual(readOr(report)?.results?.map((/** @type {any} */ x) => x.verdict), ["CAUGHT", "CAUGHT", "CAUGHT"]);
});

test("a shard given no entries, as a sweep asked for fewer than it has shards gives, reports so and leaves the verdict to the combine", () => {
  const { root, reports } = fixture();
  // Two entries asked for, over three shards: the third gets none.
  const shard = (/** @type {number} */ i) => run(root, ["object", "null"], { STUB_SWEEP_SHARD: `${i}/3`, STUB_SWEEP_RESULTS: join(reports, `shard-${i}.json`) });
  const ran = [shard(1), shard(2), shard(3)];
  assert.equal(ran[2].exit, 0, "an empty shard isn't a failed one: " + ran[2].out.slice(-400));
  assert.match(ran[2].out, /shard 3\/3 has no entries/);
  assert.deepEqual(readOr(join(reports, "shard-3.json"))?.results, []);
  const both = run(root, ["--combine", ...[1, 2, 3].map((i) => join(reports, `shard-${i}.json`))]);
  assert.equal(both.exit, 0, both.out.slice(-600));
  assert.match(both.out, /2\/2 stub\(s\) caught/);
  // Control: a sweep that isn't a shard, given no entries, still fails.
  writeFileSync(join(root, "test", "stub-manifest.mjs"), "export const STUBS = [];\n");
  execFileSync("git", ["commit", "-qam", "no entries"], { cwd: root });
  assert.notEqual(run(root, []).exit, 0, "measuring nothing never passes");
});
