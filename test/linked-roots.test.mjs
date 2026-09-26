// On Linux reeve's own roots are used at their targets (#156).
//
// Bubblewrap can't mount a deny over a link, and a grant through a link names a
// path the deny doesn't. So a worktree root, a REEVE_HOME or a state folder
// reached through a link is resolved where reeve reads it, and every path built
// under it is then the target's: the sibling deny, the canary's folders and its
// decoy, a dispatched checkout, and a worker's TMPDIR.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import * as daemon from "../src/daemon.mjs";
import { sandboxFor, siblingRootsOf } from "../src/sandbox.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const linux = { skip: process.platform !== "linux" && "Linux only" };
const under = (p, d) => p === d || p.startsWith(d + "/");

// A folder and a link to it, side by side.
const linked = (prefix) => {
  const base = realpathSync(tempDir(prefix));
  const target = join(base, "real");
  mkdirSync(target);
  symlinkSync(target, join(base, "link"));
  return { link: join(base, "link"), target };
};

// The canary, measured with a stub that records what it was handed.
const canaryCtx = (stateDir) => {
  const seen = {};
  const ctx = { logPath: join(stateDir, "reeve.log"), platform: "linux", isolationReady: () => true,
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "2.1.278 (Claude Code)",
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    netProbe: { url: "http://127.0.0.1:1/canary", selfReachable: () => true, wasHit: () => false },
    linuxProbeTargets: async () => ({ node: process.execPath, mntFile: null, windowsExe: null, bus: null, skipped: {} }),
    canary: async (args) => { Object.assign(seen, args); return { ok: true, id: "t", why: null, evidence: {} }; } };
  return { ctx, seen };
};
const withReeveHome = async (home, fn) => {
  const saved = process.env.REEVE_HOME;
  process.env.REEVE_HOME = home;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.REEVE_HOME; else process.env.REEVE_HOME = saved; }
};

test("on Linux a worktree root reached through a link is denied to workers at its target, never through the link", linux, () => {
  const { link, target } = linked("rl-root-");
  const profile = { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: link }, units: [] };
  assert.deepEqual(siblingRootsOf(profile), [target]);
  const denyRead = sandboxFor({ profile, action: "FIX_CI", worktree: join(target, "o-r-42"), tmpDir: "/tmp/t" }).settings.sandbox.filesystem.denyRead;
  assert.ok(denyRead.includes(target) && !denyRead.includes(link), JSON.stringify(denyRead.filter((d) => d.startsWith(link) || d.startsWith(target))));
});

test("the canary under a linked worktree root runs at its target", linux, async () => {
  const { link, target } = linked("rl-canary-");
  const stateDir = tempDir("rl-state-");
  const { ctx, seen } = canaryCtx(stateDir);
  const profile = { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: link }, worker: { isolation: "scratch-home" }, units: [] };
  await withReeveHome(stateDir, () => daemon.measuredContainment(ctx, profile, "o/r", ctx.logPath));
  assert.ok(seen.dir && under(seen.dir, target), `the canary's folder: ${seen.dir}`);
});

test("a dispatched checkout under a linked worktree root is made at its target", linux, async () => {
  const { link, target } = linked("rl-dispatch-");
  const stateDir = tempDir("rl-dstate-");
  const clone = tempDir("rl-clone-");
  execFileSync("git", ["-C", clone, "init", "-q"]);
  const HEAD = "a".repeat(40);
  const cl = (id, state, detail = "") => ({ id, state, detail });
  const evaluation = { ok: true, pr: 42, state: "open", head: HEAD, title: "t", headRef: "f", baseRef: "main",
    verdict: { state: "BLOCK", summary: "ci is red",
               clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"].map((id) => (id === "ci" ? cl("ci", "BLOCK", "failing: CI Gate") : cl(id, "PASS"))) },
    rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate", id: "99" }] },
    reviewers: [], threads: {}, settled: { settled: true } };
  const seen = {};
  const ctx = {
    nwo: "o/r", db: open(join(stateDir, "e.db")), logPath: join(stateDir, "reeve.log"), dbPath: join(stateDir, "e.db"),
    profile: { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: link, checkout: clone },
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
    prepareCheckout: ({ root }) => { seen.root = root; mkdirSync(join(root, "o-r-42"), { recursive: true }); return { ok: true, path: join(root, "o-r-42"), why: null, deps: { ok: true, cow: false } }; },
    spawnWorker: async (args) => { seen.home = args.env?.HOME; return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s1" }; },
  };
  await daemon.tick(ctx);
  assert.equal(seen.root, target, "the checkout's root");
});

test("a canary under a linked REEVE_HOME keeps its decoy under a denied path, at its target", linux, async () => {
  const { link, target } = linked("rl-home-");
  const stateDir = tempDir("rl-hstate-");
  const { ctx, seen } = canaryCtx(stateDir);
  const profile = { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: tempDir("rl-hwt-") }, worker: { isolation: "scratch-home" }, units: [] };
  await withReeveHome(link, () => daemon.measuredContainment(ctx, profile, "o/r", ctx.logPath));
  assert.ok(seen.decoyPath && under(seen.decoyPath, target), `the decoy: ${seen.decoyPath}`);
  const denied = seen.sandbox?.filesystem?.denyRead ?? [];
  assert.ok(denied.some((d) => under(seen.decoyPath, d)), `no deny covers ${seen.decoyPath}: ${JSON.stringify(denied.filter((d) => d.startsWith(target) || d.startsWith(link)))}`);
});

test("a worker's TMPDIR under a linked state folder is at its target", linux, async () => {
  const { link, target } = linked("rl-log-");
  const { ctx, seen } = canaryCtx(link);
  const profile = { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: tempDir("rl-lwt-") }, worker: { isolation: "scratch-home" }, units: [] };
  await withReeveHome(tempDir("rl-lhome-"), () => daemon.measuredContainment(ctx, profile, "o/r", ctx.logPath));
  assert.ok(seen.tmpDir && under(seen.tmpDir, join(target, "t")), `the TMPDIR: ${seen.tmpDir}`);
});
