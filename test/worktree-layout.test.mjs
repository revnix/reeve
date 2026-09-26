// A worktree root under a path the Linux policy closes is a layout it can't
// serve (#156). /mnt is denied to every worker, the Read tool included, and a
// deny beats an allow, so a checkout under /mnt/c would be refused its own
// files and containment could never close. It's named as the configuration
// error it is, before a worker or the canary runs.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as daemon from "../src/daemon.mjs";
import { sandboxFor } from "../src/sandbox.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const linux = { skip: process.platform !== "linux" && "Linux only" };

test("on Linux a worktree under /mnt is named as a layout the policy can't serve", linux, () => {
  const s = sandboxFor({ profile: { identity: { key: "o/r", defaultBranch: "main" }, units: [] }, action: "FIX_CI", worktree: "/mnt/c/reeve-wt/o-r-42", tmpDir: "/tmp/t" });
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
  const profile = { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: "/mnt/c/reeve-wt" }, worker: { isolation: "scratch-home" }, units: [] };
  const v = await daemon.measuredContainment(ctx, profile, "o/r", ctx.logPath);
  assert.equal(ran, false, "the canary ran");
  assert.equal(v.credentialRead, "open");
  assert.match(v.why, /\/mnt[^\n]*worktreeRoot/);
});
