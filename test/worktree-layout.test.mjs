// A worktree root under a path the Linux policy closes is a layout it can't
// serve (#156). /mnt is denied to every worker, the Read tool included, and a
// deny beats an allow, so a checkout under /mnt/c would be refused its own
// files and containment could never close. It's named as the configuration
// error it is, before a worker or the canary runs, and before anything is
// written under the root.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as daemon from "../src/daemon.mjs";
import { sandboxFor } from "../src/sandbox.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const linux = { skip: process.platform !== "linux" && "Linux only" };
// Under /mnt, but not a drive: only root can make it, so code that wrote under
// the root before refusing fails here rather than writing to a Windows drive.
const UNDER_MNT = "/mnt/reeve-layout-test";

test("on Linux a worktree under /mnt is named as a layout the policy can't serve", linux, () => {
  const s = sandboxFor({ profile: { identity: { key: "o/r", defaultBranch: "main" }, units: [] }, action: "FIX_CI", worktree: join(UNDER_MNT, "o-r-42"), tmpDir: "/tmp/t" });
  assert.ok(s.stateHomeContainsWorktree.includes("/mnt"), JSON.stringify(s.stateHomeContainsWorktree));
});

test("the canary refuses a worktree root under /mnt before it runs, and says what to change", linux, async () => {
  const stateDir = tempDir("rc-");
  let ran = false;
  const ctx = { logPath: join(stateDir, "reeve.log"), platform: "linux", isolationReady: () => true,
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "2.1.278 (Claude Code)",
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    netProbe: { url: "http://127.0.0.1:1/canary", selfReachable: () => true, wasHit: () => false },
    canary: async () => { ran = true; return { ok: true, id: "t", why: null, evidence: {} }; } };
  const profile = { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: UNDER_MNT }, worker: { isolation: "scratch-home" }, units: [] };
  const v = await daemon.measuredContainment(ctx, profile, "o/r", ctx.logPath);
  assert.equal(ran, false, "the canary ran");
  assert.equal(v.credentialRead, "open");
  assert.match(v.why, /\/mnt[^\n]*worktreeRoot/);
  assert.match(v.why, /out of \/mnt/, "it doesn't say where the root can't be");
});

test("a worker whose checkout is under /mnt isn't started, and the refusal says what to change", linux, async () => {
  const stateDir = tempDir("rl-");
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
  let spawned = 0;
  mkdirSync(stateDir, { recursive: true });
  const ctx = {
    nwo: "o/r", db: open(join(stateDir, "e.db")), logPath: join(stateDir, "reeve.log"), dbPath: join(stateDir, "e.db"),
    profile: { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: UNDER_MNT, checkout: clone },
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
    prepareCheckout: () => ({ ok: true, path: join(UNDER_MNT, "o-r-42"), why: null, deps: { ok: true, cow: false } }),
    spawnWorker: async () => { spawned++; return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s1" }; },
  };
  await daemon.tick(ctx);
  const logged = readFileSync(ctx.logPath, "utf8");
  assert.equal(spawned, 0, "the worker started");
  assert.match(logged, /a denied path \(\/mnt\) contains the checkout[^\n]*out of \/mnt/, logged.slice(-1500));
});
