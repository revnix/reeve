// Every call reeve makes to GitHub, counted (#168), so the calls a tick makes,
// in all and per pull request, are measured before they're cut. Each place that
// runs `gh` runs it through src/github/calls.mjs, under the identity it reads as;
// the daemon takes the count as each tick starts and logs it as it ends.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, EVAL } from "./fixtures/tick-harness.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The counting module, or why it can't be had. */
const counting = async () => { try { return await import("../src/github/calls.mjs"); } catch (err) { return assert.fail(`src/github/calls.mjs: ${err}`); } };
/**
 * A stand-in for `gh`, as spawnSync answers it: no call leaves the machine. Asked
 * with GH_DEBUG, as the counting module asks, it says each request it makes on
 * stderr, as gh does: `pages` of them.
 */
const answers = (/** @type {string} */ out = "{}", { pages = 1, status = 0, said = "" } = {}) => /** @type {any} */ ((_cmd, _args, o) => ({
  status, signal: null, stdout: out,
  stderr: (o?.env?.GH_DEBUG ? Array.from({ length: pages }, () => "* Request at x\n* Request to https://api.github.com/x\n* Request took 1ms\n").join("") : "") + said,
}));

test("each request gh makes for reeve is counted, a paged read's every page, under the identity it reads as and its kind, and the count starts afresh once taken", async () => {
  const calls = await counting();
  const was = calls.runGhWith(answers());
  try {
    calls.takeCalls();
    calls.gh(["api", "repos/o/r/pulls/7"], {}, { who: "app" });
    calls.runGhWith(answers("[]", { pages: 3 }));
    calls.gh(["api", "--paginate", "repos/o/r/pulls/8/reviews?per_page=100", "--jq", ".[]"]);
    calls.runGhWith(answers());
    calls.gh(["pr", "view", "7", "--repo", "o/r"]);
    calls.gh(["api", `repos/o/r/commits/${"a".repeat(40)}/check-runs`]);
    calls.runGhWith(answers("", { status: 1, said: "gh: Server Error (HTTP 502)\n" }));
    assert.throws(() => calls.gh(["api", "repos/o/r/pulls/9"]), /HTTP 502/);
    const got = calls.takeCalls();
    assert.equal(got.requests, 7, "the paged read's three pages, each one: " + JSON.stringify(got));
    assert.equal(got.calls, 5);
    assert.deepEqual(got.byWho, { app: 1, ambient: 6 });
    assert.deepEqual(got.byKind, { "api repos/:nwo/pulls/:n": 2, "api repos/:nwo/pulls/:n/reviews": 3, "pr view": 1, "api repos/:nwo/commits/:sha/check-runs": 1 });
    assert.equal(calls.takeCalls().requests, 0, "taken, it starts afresh");
  } finally { calls.runGhWith(was); }
});

test("what gh says, failing, reaches the caller as execFileSync gave it, without the lines that say its requests", async () => {
  const calls = await counting();
  const was = calls.runGhWith(answers("", { status: 1, said: "gh: Not Found (HTTP 404)\n" }));
  try {
    /** @type {any} */ let thrown = null;
    try { calls.gh(["api", "repos/o/r/pulls/9"]); } catch (err) { thrown = err; }
    assert.ok(thrown, "it throws, as execFileSync does");
    assert.equal(String(thrown.stderr).trim(), "gh: Not Found (HTTP 404)");
    assert.equal(thrown.status, 1);
    // A timeout comes back as execFileSync's, with its code.
    calls.runGhWith(/** @type {any} */ (() => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "", error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }) })));
    assert.throws(() => calls.gh(["api", "repos/o/r"]), (/** @type {any} */ err) => err.code === "ETIMEDOUT");
    calls.takeCalls();
  } finally { calls.runGhWith(was); }
});

test("reeve's App's calls are counted as the App's, and the login on the machine's as its own", async () => {
  const calls = await counting();
  const was = calls.runGhWith(answers("[]"));
  try {
    const { apiAsInstallation } = await import("../src/github/app.mjs");
    const pr = await import("../src/pr.mjs");
    calls.takeCalls();
    apiAsInstallation("t", ["repos/o/r/pulls/7"]);
    pr.mergeQueueOnBase({ nwo: "o/r", base: `counted-${Date.now()}` });
    const got = calls.takeCalls();
    assert.equal(got.byWho.app, 1, JSON.stringify(got));
    assert.ok((got.byWho.ambient ?? 0) >= 1, JSON.stringify(got));
  } finally { calls.runGhWith(was); }
});

test("every place reeve runs gh runs it through the one place that counts it", () => {
  const files = [];
  const walk = (/** @type {string} */ dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(join(ROOT, "src"));
  files.push(join(ROOT, "bin", "reeve"));
  const direct = files.filter((f) => !f.endsWith(join("github", "calls.mjs")))
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, k) => ({ f, k: k + 1, line })))
    .filter(({ line }) => /\b(execFileSync|execFile|spawnSync|spawn)\(\s*"gh"/.test(line))
    .map(({ f, k }) => `${f.slice(ROOT.length)}:${k}`);
  assert.deepEqual(direct, [], "these run gh on their own, uncounted");
});

test("a tick logs the GitHub calls it made, in all and per pull request, and none it didn't", async () => {
  const calls = await counting();
  const was = calls.runGhWith(answers("[]"));
  /** What a tick logged of its GitHub calls: in all, per pull request, and under each identity. */
  const logged = (/** @type {string} */ log) => {
    const m = /github: (\d+) request\(s\) in \d+ call\(s\) this tick, ([\d.]+) per pull request(?: \(([^)]*)\))?/.exec(log);
    assert.ok(m, "a tick says its GitHub calls: " + log.slice(-1500));
    const who = Object.fromEntries((m[3] ?? "").split(", ").filter(Boolean).map((x) => { const [w, n] = x.split(" "); return [w, Number(n)]; }));
    return { total: Number(m[1]), perPr: m[2], ambient: who.ambient ?? 0, app: who.app ?? 0 };
  };
  try {
    // The tick as the harness runs it, and the same with three more calls of its own, and one before it starts.
    const plain = logged((await run({ openPrs: () => [42], evaluate: () => ({ ...EVAL }) })).log);
    calls.gh(["api", "repos/o/r"]);
    let evaluated = 0;
    const more = logged((await run({
      openPrs: () => { calls.gh(["pr", "list", "--repo", "o/r"]); return [42]; },
      evaluate: () => { evaluated++; calls.gh(["api", "repos/o/r/pulls/42"], {}, { who: "app" }); calls.gh(["api", "repos/o/r/pulls/42/reviews"]); return { ...EVAL }; },
    })).log);
    // The list once, and each evaluation's two: none from before the tick.
    assert.ok(evaluated >= 1);
    assert.equal(more.total - plain.total, 1 + 2 * evaluated, `the tick's own, and not the one before it: ${JSON.stringify({ plain, more, evaluated })}`);
    assert.equal(more.ambient - plain.ambient, 1 + evaluated);
    assert.equal(more.app - plain.app, evaluated);
    assert.equal(more.perPr, more.total.toFixed(1), "one pull request: every call is its");
  } finally { calls.runGhWith(was); }
});

test("every module that runs gh, run against a gh that records each run, counts each one", () => {
  // A gh of its own, first on the child's PATH: it writes down each run, and
  // says one request, as gh does when asked with GH_DEBUG.
  const dir = tempDir("reeve-gh-boundary-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "runs.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${log}"\n[ -n "$GH_DEBUG" ] && echo "* Request to https://api.github.com/x" >&2\necho "[]"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const src = (/** @type {string} */ m) => new URL(`../src/${m}`, import.meta.url).href;
  const script = join(dir, "run.mjs");
  writeFileSync(script, `
    const calls = await import(${JSON.stringify(src("github/calls.mjs"))});
    const tries = [
      async () => (await import(${JSON.stringify(src("github/reconciler.mjs"))})).pinHead("o/r", "main"),
      async () => (await import(${JSON.stringify(src("db/reconcile.mjs"))})).reconcilePrComment({ nwo: "o/r", pr: 1, idemKey: "k" }),
      async () => (await import(${JSON.stringify(src("profile/detect.mjs"))})).detectMergeMethod("o/r"),
      async () => (await import(${JSON.stringify(src("doctor.mjs"))})).checkMergeAuthority("o/r"),
      async () => (await import(${JSON.stringify(src("baseline.mjs"))})).ghApi("repos/o/r"),
      async () => (await import(${JSON.stringify(src("pr.mjs"))})).mergeQueueOnBase({ nwo: "o/r", base: "main" }),
      async () => (await import(${JSON.stringify(src("github/app.mjs"))})).apiAsInstallation("t", ["repos/o/r"]),
      async () => (await import(${JSON.stringify(src("daemon.mjs"))})).openPrs("o/r"),
      async () => (await import(${JSON.stringify(src("trial.mjs"))})).mergedSince("o/r", 0),
    ];
    calls.takeCalls();
    for (const t of tries) { try { await t(); } catch { /* what it makes of "[]" is its own affair */ } }
    process.stdout.write(JSON.stringify(calls.takeCalls()));
  `);
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
  assert.equal(r.status, 0, r.stderr);
  const counted = JSON.parse(r.stdout);
  const ran = readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.ok(ran.length >= 9, `each module ran gh: ${ran.length}`);
  assert.equal(counted.calls, ran.length, `every run of gh counted: ${JSON.stringify({ counted, ran })}`);
  assert.equal(counted.requests, ran.length, "each saying the one request it made");
});

test("a tick that stops early still logs the GitHub calls it made", async () => {
  const calls = await counting();
  const was = calls.runGhWith(answers("[]"));
  try {
    // The open pull requests couldn't be listed: the tick ends there.
    const r = await run({ openPrs: () => { calls.gh(["pr", "list", "--repo", "o/r"]); return null; } });
    assert.match(r.log, /github: 1 request\(s\) in 1 call\(s\) this tick/, r.log.slice(-1200));
  } finally { calls.runGhWith(was); }
});
