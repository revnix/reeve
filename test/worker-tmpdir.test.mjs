// A worker's TMPDIR leaves room for the sandbox's sockets (#156).
//
// On Linux the CLI's sandbox makes its network bridges as two Unix sockets in
// TMPDIR, the longer named claude-socks-<16 hex>.sock, and a socket's path has
// room for 107 characters. Measured 2026-09-26 with CLI 2.1.278 on WSL2: a
// 90-character TMPDIR stopped the sandbox from starting, and every command the
// canary's worker ran was refused (docs/measured/2026-09-26-live-canary-wsl.md).
// A real worker's TMPDIR sat inside its run's folder, longer still.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as daemon from "../src/daemon.mjs";
import * as workerenv from "../src/workerenv.mjs";
import { runWorker } from "../src/supervisor.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

// reeve's home, then t/<12 hex>: its shape, whatever this host's temp paths.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const underHome = (stateDir) => new RegExp(`^${escape(join(stateDir, "t"))}/[0-9a-f]{12}$`);

test("a worker's TMPDIR leaves room for the sandbox's sockets: 72 characters at most, under reeve's home", () => {
  assert.equal(workerenv.TMPDIR_MAX, 107 - "/claude-socks-0123456789abcdef.sock".length);
  assert.equal(workerenv.TMPDIR_MAX, 72);
  const t = workerenv.workerTmpDir("/home/someone/.reeve");
  assert.match(t, underHome("/home/someone/.reeve"));
  assert.ok(t.length <= workerenv.TMPDIR_MAX, t);
  assert.notEqual(workerenv.workerTmpDir("/home/someone/.reeve"), t, "two runs share a TMPDIR");
});

// A tick that dispatches one fixer for a red pull request, with the worker stubbed.
const dispatch = ({ stateDir }) => {
  const dir = tempDir("rt-wt-");
  const clone = tempDir("rt-clone-");
  execFileSync("git", ["-C", clone, "init", "-q"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "Founder"]);
  execFileSync("git", ["-C", clone, "config", "user.email", "founder@example.invalid"]);
  const HEAD = "a".repeat(40);
  const cl = (id, state, detail = "") => ({ id, state, detail });
  const evaluation = { ok: true, pr: 42, state: "open", head: HEAD, title: "t", headRef: "f", baseRef: "main",
    verdict: { state: "BLOCK", summary: "ci is red",
               clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"].map((id) => (id === "ci" ? cl("ci", "BLOCK", "failing: CI Gate") : cl(id, "PASS"))) },
    rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate", id: "99" }] },
    reviewers: [], threads: {}, settled: { settled: true } };
  const seen = { spawned: [] };
  mkdirSync(stateDir, { recursive: true });
  const ctx = {
    nwo: "o/r", db: open(join(stateDir, "e.db")), logPath: join(stateDir, "reeve.log"), dbPath: join(stateDir, "e.db"),
    profile: { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: clone },
               authority: { policy: "propose_and_merge" }, rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
               ci: { provider: "github-actions", requiredChecks: [] }, watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 } },
    execute: true, shadow: true, running: 0,
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    containment: { credentialRead: "closed", why: "test" }, keychain: { measured: true, items: [], why: null },
    claudeBin: "/bin/sh", cliVersion: "test",
    openPrs: () => [42], evaluate: () => evaluation, publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    resolveCause: () => ({ ok: true, job: "CI Gate", step: "Test", cause: [{ where: "src/x.ts:1", message: "boom" }] }),
    observe: () => ({ ok: false, observations: [], incomplete: true, threads: { readable: false, total: null, unresolved: 0, seen: 0 } }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
    spawnWorker: async (args) => {
      seen.spawned.push({ TMPDIR: args.env?.TMPDIR, existed: existsSync(args.env?.TMPDIR ?? "/nonexistent") });
      return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s1" };
    },
  };
  return { ctx, seen };
};

test("a dispatched worker gets a short TMPDIR under reeve's home, not inside its run's folder, and it's gone once the run ends", async () => {
  const stateDir = tempDir("rt-");
  const { ctx, seen } = dispatch({ stateDir });
  await daemon.tick(ctx);
  assert.equal(seen.spawned.length, 1, readFileSync(ctx.logPath, "utf8").slice(-1500));
  const { TMPDIR, existed } = seen.spawned[0];
  assert.match(TMPDIR, underHome(stateDir));
  assert.equal(existed, true, "control: it existed while the worker ran");
  assert.equal(existsSync(TMPDIR), false, "the run's TMPDIR is left behind");
});

test("a worker whose TMPDIR leaves no room for the sandbox's sockets isn't started, and nothing is spent", { skip: process.platform !== "linux" && "Linux only" }, async () => {
  const dir = tempDir("rw-");
  const marker = join(dir, "started");
  const run = (TMPDIR, n) => runWorker({ bin: "/bin/sh", args: ["-c", `touch ${marker}`], cwd: dir, env: { PATH: "/usr/bin:/bin", TMPDIR },
                                         outPath: join(dir, `out${n}`), errPath: join(dir, `err${n}`) });
  const r = await run("/" + "t".repeat(workerenv.TMPDIR_MAX), 1);
  assert.equal(r.outcome, "unbound", JSON.stringify(r));
  assert.match(r.why, /TMPDIR[^\n]*bytes/);
  assert.equal(existsSync(marker), false, "the worker started");
  // A TMPDIR within the room starts it.
  const ok = await run("/tmp", 2);
  assert.equal(existsSync(marker), true, `control: ${JSON.stringify(ok)}`);
});

test("the canary's worker gets a short TMPDIR under reeve's home too", async () => {
  const stateDir = tempDir("rc-");
  const seen = {};
  const ctx = { logPath: join(stateDir, "reeve.log"), platform: "linux", isolationReady: () => true, mounts: "",
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "2.1.278 (Claude Code)",
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    netProbe: { url: "http://127.0.0.1:1/canary", selfReachable: () => true, wasHit: () => false },
    canary: async (args) => { seen.tmpDir = args.tmpDir; seen.TMPDIR = args.env?.TMPDIR; return { ok: true, id: "t", why: null, evidence: {} }; } };
  const profile = { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: tempDir("rc-wt-") },
                    worker: { isolation: "scratch-home" }, units: [] };
  await daemon.measuredContainment(ctx, profile, "o/r", ctx.logPath);
  assert.match(seen.tmpDir ?? "", underHome(stateDir));
  assert.equal(seen.TMPDIR, seen.tmpDir);
});

test("a TMPDIR's room is counted in bytes, as the kernel counts a socket's path", () => {
  // 41 characters, 81 bytes: past the room, though not by a count of characters.
  const wide = "/" + "é".repeat(40);
  assert.ok(workerenv.tmpDirTooLong(wide, "linux"), "a TMPDIR over the room in bytes was let through");
  assert.match(workerenv.tmpDirTooLong(wide, "linux"), /81 bytes/);
  assert.equal(workerenv.tmpDirTooLong("/" + "e".repeat(40), "linux"), null, "control: the same length in plain characters fits");
});

test("a TMPDIR with no room names the state folder it sits under, which --log can put outside REEVE_HOME", () => {
  const state = "/" + "s".repeat(70);
  const why = workerenv.tmpDirTooLong(join(state, "t", "0123456789ab"), "linux");
  assert.ok(why, "control: it's past the room");
  assert.ok(why.includes(state), `it doesn't name the state folder: ${why}`);
  assert.match(why, /--log/, "it names only REEVE_HOME, which --log can make beside the point");
});

test("a run's TMPDIR is removed even when the run can't be closed", async () => {
  const stateDir = tempDir("rt-");
  const { ctx, seen } = dispatch({ stateDir });
  // Closing the run fails: its read of the run's lease throws, as a locked or broken store would.
  const real = ctx.db;
  ctx.db = new Proxy(real, { get: (t, k) => k !== "prepare" ? (typeof t[k] === "function" ? t[k].bind(t) : t[k])
    : (sql) => { if (/COALESCE\(x\.cancel_requested, 0\) AS cancel_requested/.test(sql)) throw new Error("database is locked"); return t.prepare(sql); } });
  try { await daemon.tick(ctx); } catch { /* the tick may throw with it */ }
  assert.equal(seen.spawned.length, 1, "control: the worker ran");
  assert.equal(existsSync(seen.spawned[0].TMPDIR), false, "the run's TMPDIR is left behind");
});

test("the shared TMPDIR root is denied to workers wherever reeve's state lives, not only under its home", () => {
  const roots = daemon.stateRootsFor("/srv/reeve-state", "/srv/reeve-state/reeve.log", "/w/x");
  assert.ok(roots.includes("/srv/reeve-state/t"), JSON.stringify(roots));
});
