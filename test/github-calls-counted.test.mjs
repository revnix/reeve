// Every call reeve makes to GitHub, counted (#168), so the calls a tick makes,
// in all and per pull request, are measured before they're cut. Each place that
// runs `gh` runs it through src/github/calls.mjs, under the identity it reads as;
// the daemon takes the count as each tick starts and logs it as it ends.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, EVAL } from "./fixtures/tick-harness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The counting module, or why it can't be had. */
const counting = async () => { try { return await import("../src/github/calls.mjs"); } catch (err) { return assert.fail(`src/github/calls.mjs: ${err}`); } };
/** A stand-in for `gh`, as execFileSync answers: no call leaves the machine. */
const answers = (/** @type {string} */ out = "{}") => /** @type {any} */ (() => out);

test("each call to GitHub is counted under the identity it reads as and its kind, refused or not, and the count starts afresh once taken", async () => {
  const calls = await counting();
  const was = calls.runGhWith(answers());
  try {
    calls.takeCalls();
    calls.gh(["api", "repos/o/r/pulls/7"], {}, { who: "app" });
    calls.gh(["api", "--paginate", "repos/o/r/pulls/8/reviews?per_page=100", "--jq", ".[]"]);
    calls.gh(["pr", "view", "7", "--repo", "o/r"]);
    calls.gh(["api", `repos/o/r/commits/${"a".repeat(40)}/check-runs`]);
    calls.runGhWith(/** @type {any} */ (() => { throw new Error("HTTP 502"); }));
    assert.throws(() => calls.gh(["api", "repos/o/r/pulls/9"]), /HTTP 502/);
    const got = calls.takeCalls();
    assert.equal(got.total, 5, JSON.stringify(got));
    assert.deepEqual(got.byWho, { app: 1, ambient: 4 });
    assert.deepEqual(got.byKind, { "api repos/:nwo/pulls/:n": 2, "api repos/:nwo/pulls/:n/reviews": 1, "pr view": 1, "api repos/:nwo/commits/:sha/check-runs": 1 });
    assert.equal(calls.takeCalls().total, 0, "taken, it starts afresh");
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
    const m = /github: (\d+) call\(s\) this tick, ([\d.]+) per pull request(?: \(([^)]*)\))?/.exec(log);
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
