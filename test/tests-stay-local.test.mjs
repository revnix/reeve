// Tests stay on this machine (#243, #245).
//
// A test never reaches GitHub. The tick reads GitHub in several places, and a
// test that drove it without a stand-in for each one called gh for repositories
// that don't exist. Measured on 2026-09-26: 19 files and about 600 calls a run,
// enough under a stub sweep to spend the account's hourly API budget, and a
// network round trip each for an answer no assertion depended on.
//
// And a test never writes into the real reeve home, where a running daemon
// keeps its state and its canary's results.
//
// So `npm test` and CI run every test file with test/fixtures/offline-gh first
// on PATH, a gh that fails every call and writes it down, and with a home of
// its own: an empty folder, and no REEVE_HOME of the caller's. A file that
// called gh, or wrote a .reeve into that home, fails the run.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tick } from "../src/daemon.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { open } from "../src/db/ops.mjs";
import { OFFLINE_GH_DIR, OFFLINE_IO, OFFLINE_READS, offlineEnv } from "./fixtures/offline-github.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The calls the offline gh wrote down, each as its list of arguments.
const callsIn = (log) => existsSync(log)
  ? readFileSync(log, "utf8").split("\x1e").filter(Boolean).map((call) => call.split("\x1f").slice(0, -1))
  : [];
const offlineGh = (args, log) =>
  spawnSync(join(OFFLINE_GH_DIR, "gh"), args, { encoding: "utf8", env: { ...process.env, REEVE_TEST_GH_LOG: log } });

// Runs `fn` with the offline gh first on this process's PATH, writing down to
// `log`, and puts both back after. The control first: a gh this process runs
// is the offline one, so the silence `fn` is judged by means something.
const withOfflineGh = async (log, fn) => {
  const saved = { PATH: process.env.PATH, log: process.env.REEVE_TEST_GH_LOG };
  process.env.PATH = `${OFFLINE_GH_DIR}${delimiter}${process.env.PATH}`;
  process.env.REEVE_TEST_GH_LOG = log;
  try {
    assert.throws(() => execFileSync("gh", ["api", "repos/o/r"], { stdio: "ignore" }));
    assert.deepEqual(callsIn(log), [["api", "repos/o/r"]], "control: the offline gh didn't see this process's call");
    writeFileSync(log, "");
    return await fn();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.log === undefined) delete process.env.REEVE_TEST_GH_LOG;
    else process.env.REEVE_TEST_GH_LOG = saved.log;
  }
};

test("the offline gh fails a call as a gh with no login does, and writes it down with each argument whole", () => {
  const log = join(tempDir("og-"), "calls");
  const r = offlineGh(["api", "repos/o/r/pulls/1", "--jq", "[.a, .b] | @tsv"], log);
  assert.equal(r.status, 1);
  const query = "query {\n  viewer { login }\n}";
  offlineGh(["api", "graphql", "-f", `query=${query}`], log);
  assert.deepEqual(callsIn(log), [["api", "repos/o/r/pulls/1", "--jq", "[.a, .b] | @tsv"],
                                  ["api", "graphql", "-f", `query=${query}`]]);
});

test("the offline gh answers a version check itself, and writes nothing down", () => {
  const log = join(tempDir("og-"), "calls");
  for (const args of [["--version"], ["version"]]) {
    const r = offlineGh(args, log);
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.stdout, /^gh version /, args.join(" "));
  }
  assert.deepEqual(callsIn(log), []);
});

test("the offline gh treats a subcommand's --version as the call it is, which the real gh rejects", () => {
  // Measured with gh 2.46.0: `gh api --version` exits 1 with "unknown flag".
  const log = join(tempDir("og-"), "calls");
  const r = offlineGh(["api", "--version"], log);
  assert.equal(r.status, 1);
  assert.deepEqual(callsIn(log), [["api", "--version"]]);
});

test("a process started with offlineEnv meets the offline gh, and its calls aren't written down for the runner", () => {
  const log = join(tempDir("oe-"), "calls");
  const r = spawnSync("sh", ["-c", "gh api repos/o/r"], { encoding: "utf8", env: offlineEnv({ ...process.env, REEVE_TEST_GH_LOG: log }) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /a test never reaches GitHub/, "it wasn't the offline gh that answered");
  assert.deepEqual(callsIn(log), []);
});

test("a tick whose GitHub reads have their stand-ins calls no gh", async () => {
  const dir = tempDir("tick-");
  const log = join(dir, "gh-calls");
  await withOfflineGh(log, async () => {
    const HEAD = "a".repeat(40);
    const anchor = { ok: true, head: HEAD, headRef: "f", updatedAt: "2026-09-26T00:00:00Z" };
    const evaluation = {
      ok: true, pr: 1, title: "t", headRef: "f", baseRef: "main", state: "open", head: HEAD, updatedAt: anchor.updatedAt,
      verdict: { state: "PASS", clauses: [], summary: "x" },
      reviewers: [], threads: { readable: true, total: 0, unresolved: 0, seen: 0 },
      rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: null }, checks: {}, settled: {},
    };
    // Which stand-ins the tick reached, so a tick that stopped reading doesn't
    // pass for one that reads offline.
    const reached = new Set();
    const ctx = {
      ...OFFLINE_READS,
      reconcile: (...a) => { reached.add("reconcile"); return OFFLINE_READS.reconcile(...a); },
      mergeRate: (...a) => { reached.add("mergeRate"); return OFFLINE_READS.mergeRate(...a); },
      nwo: "o/r", db: open(join(dir, "s.db")), dbPath: join(dir, "s.db"), logPath: join(dir, "reeve.log"),
      haltMarker: join(dir, "HALT"), execute: false, shadow: true,
      // A dashboard, so the tick works out the clean-merge rate, a read of its own.
      dashPath: join(dir, "dash.md"), canaryStateDir: dir,
      profile: { rounds: { softCap: 5, hardCap: 10 }, watch: { reviewActions: false, staleSeconds: 900 }, ci: {}, merge: { authority: "propose" } },
      openPrs: () => [1],
      prAnchor: () => anchor,
      ingest: () => ({ inserted: 0, generations: 0 }),
      derivePr: () => ({ rounds: 0, threads: 0 }),
      reviewState: () => ({ readable: false, why: "not derived in this test" }),
      evaluate: () => evaluation,
      // Publishing is a write, not a read, but it's GitHub all the same: on a
      // machine with the App's key, the real one would try it.
      publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
      authenticate: async () => ({ ok: false, why: "not in this test" }),
      drain: false,
      backupFailures: new Map(),
    };
    await tick(ctx);
    assert.deepEqual([...reached].sort(), ["mergeRate", "reconcile"], "the tick didn't reach its reconciliation and its clean-merge rate");
    assert.deepEqual(callsIn(log), [], "the tick called gh");
  });
});

test("the doctor reads GitHub through githubIo, and so calls no gh", async () => {
  const dir = tempDir("doctor-");
  const log = join(dir, "gh-calls");
  await withOfflineGh(log, () => {
    const reached = new Set();
    const githubIo = {
      api: (...a) => { reached.add("api"); return OFFLINE_IO.api(...a); },
      sh: (...a) => { reached.add("sh"); return OFFLINE_IO.sh(...a); },
    };
    const r = runDoctor({ nwo: "o/r", profile: {}, stateDir: dir, githubIo,
                          keychainIo: { probe: () => ({ measured: true, items: [], why: null }), token: () => ({ ok: true, token: "sk-ant-oat01-test", why: null }) },
                          baselineIo: { fixturePath: join(dir, "none.json") } });
    // The merge authority and merge shape read through `api`, the base's health
    // through `sh`.
    assert.ok(["R-01", "R-03"].every((id) => r.checks.some((c) => c.id === id)), r.checks.map((c) => c.id).join(","));
    assert.deepEqual([...reached].sort(), ["api", "sh"], "the doctor didn't read through githubIo");
    assert.deepEqual(callsIn(log), [], "the doctor called gh");
  });
});

test("the doctor reads reviewer supply through githubIo too, when the profile names reviewers", async () => {
  const dir = tempDir("doctor-rev-");
  const log = join(dir, "gh-calls");
  await withOfflineGh(log, () => {
    const reached = new Set();
    // Two merged pull requests, so the check goes on to read their comments.
    const githubIo = {
      api: (...a) => { reached.add("api"); return OFFLINE_IO.api(...a); },
      sh: (cmd, args) => {
        if (args?.[0] === "pr" && args?.[1] === "list") { reached.add("pr list"); return { ok: true, out: "5\n6" }; }
        return OFFLINE_IO.sh(cmd, args);
      },
    };
    const r = runDoctor({ nwo: "o/r", profile: { reviewers: [{ login: "someone", refusal: "can't review" }] }, stateDir: dir, githubIo,
                          keychainIo: { probe: () => ({ measured: true, items: [], why: null }), token: () => ({ ok: true, token: "sk-ant-oat01-test", why: null }) },
                          baselineIo: { fixturePath: join(dir, "none.json") } });
    assert.ok(r.checks.some((c) => c.id === "R-05"), r.checks.map((c) => c.id).join(","));
    assert.ok(reached.has("pr list"), "the reviewer check didn't list merged pull requests through githubIo");
    assert.deepEqual(callsIn(log), [], "the doctor called gh");
  });
});

// A folder of test files for the runner, each written from its source.
const suite = (files) => {
  const dir = tempDir("suite-");
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  return dir;
};
const runSuite = (dir, env = {}) =>
  spawnSync(process.execPath, [join(ROOT, "scripts", "test.mjs"), dir], { encoding: "utf8", env: { ...process.env, ...env } });

test("the runner fails a test file that called gh, and names the call", () => {
  const dir = suite({ "a.test.mjs": `import { spawnSync } from "node:child_process";\nspawnSync("gh", ["api", "repos/o/r/pulls/7"]);\n` });
  const r = runSuite(dir);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /a\.test\.mjs called gh/, r.stderr);
  assert.match(r.stderr, /gh api repos\/o\/r\/pulls\/7/, r.stderr);
});

test("the runner lets a test file ask gh for its version", () => {
  const dir = suite({ "a.test.mjs": `import { execFileSync } from "node:child_process";\nexecFileSync("gh", ["--version"]);\n` });
  const r = runSuite(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the runner fails a test file that wrote a .reeve into its home, and the real home is left alone", () => {
  const marker = `runner-probe-${process.pid}.txt`;
  const dir = suite({
    "a.test.mjs": `import { mkdirSync, writeFileSync } from "node:fs";\nimport { homedir } from "node:os";\nimport { join } from "node:path";\n` +
                  `mkdirSync(join(homedir(), ".reeve"), { recursive: true });\nwriteFileSync(join(homedir(), ".reeve", ${JSON.stringify(marker)}), "x");\n`,
  });
  // Removed whatever happens: if the runner ever gave the test this process's
  // home, the marker is in it.
  try {
    const r = runSuite(dir);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /a\.test\.mjs wrote into its home's \.reeve/, r.stderr);
    assert.equal(existsSync(join(homedir(), ".reeve", marker)), false, "it wrote into this process's home");
  } finally {
    rmSync(join(homedir(), ".reeve", marker), { force: true });
  }
});

test("the runner gives each test file an empty home of its own, and not the caller's REEVE_HOME", () => {
  const dir = suite({
    "a.test.mjs": `import { readdirSync } from "node:fs";\nimport { homedir } from "node:os";\n` +
                  `console.log("HOME-PROBE " + JSON.stringify({ home: homedir(), entries: readdirSync(homedir()), reeveHome: process.env.REEVE_HOME ?? null }));\n`,
  });
  const r = runSuite(dir, { REEVE_HOME: "/nonexistent/the-callers-reeve-home" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = r.stdout.match(/^HOME-PROBE (.*)$/m);
  assert.ok(line, r.stdout);
  const probe = JSON.parse(line[1]);
  assert.notEqual(probe.home, homedir());
  assert.deepEqual(probe.entries, []);
  assert.equal(probe.reeveHome, null);
});

test("the canary tests put their decoy under a reeve home of their own, and write nothing into the home", () => {
  for (const file of ["canary.test.mjs", "canary-linux.test.mjs", "canary-live-wsl.test.mjs"]) {
    const home = tempDir("canary-home-");
    const env = { ...process.env, HOME: home };
    delete env.REEVE_HOME;
    const r = spawnSync(process.execPath, [join(ROOT, "test", file)], { encoding: "utf8", env });
    // Still passing, so its silence isn't a file that stopped early.
    assert.equal(r.status, 0, `${file} failed: ${(r.stdout + r.stderr).slice(-800)}`);
    assert.equal(existsSync(join(home, ".reeve")), false, `${file} wrote into the home's .reeve`);
  }
});
