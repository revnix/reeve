// A canary's pass holds only for the probes it ran (#156).
//
// On Linux the canary probes the host's ways out that the daemon can reach
// itself: a file on a Windows drive, Windows interop and the session bus. One
// the host doesn't have is skipped. A pass taken then is a weaker measurement
// than one taken with the probe, so once the host has the target, the cached
// pass isn't reused: the targets are found before the cache is looked in, and
// what was found is part of the canary's id.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as daemon from "../src/daemon.mjs";
import { measureContainment, revalidateContainment } from "../src/containment.mjs";
import { canaryIdFor } from "../src/canary.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const without = { node: process.execPath, mntFile: null, windowsExe: null, bus: null, skipped: { mnt: "nothing readable", interop: "none", bus: "none" } };
const withMnt = { ...without, mntFile: "/mnt/c/Windows/System32/drivers/etc/hosts", skipped: { interop: "none", bus: "none" } };

test("the canary's id changes with the Linux probes the host lets it run", () => {
  const base = { cliVersion: "2.1.278", sandbox: { enabled: true, filesystem: { denyRead: ["/mnt"] } } };
  const a = canaryIdFor({ ...base, probes: { mnt: false, interop: false, bus: false } });
  const b = canaryIdFor({ ...base, probes: { mnt: true, interop: false, bus: false } });
  assert.notEqual(a, b, "a pass without the /mnt probe has the id of one with it");
  assert.equal(canaryIdFor({ ...base, probes: { mnt: true, interop: false, bus: false } }), b, "control: the same probes give the same id");
});

test("a pass taken when a Linux probe had no target isn't reused once the host has one", async () => {
  const cache = new Map();
  let runs = 0;
  const canary = async () => { runs++; return { ok: true, id: `c${runs}`, why: null, evidence: {} }; };
  const at = (linuxTargets) => measureContainment({ cliVersion: "2.1.278", sandbox: { enabled: true, filesystem: { denyRead: ["/mnt"] } },
    permissionsDeny: [], canaryPaths: { dir: "/w/.reeve-canary/i/run" }, bin: "/bin/sh", env: {}, platform: "linux", isolated: true,
    keychain: { measured: true, items: [], why: null }, canary, cache, linuxTargets, mounts: "" });
  await at(without);
  assert.equal(runs, 1, "control: the first measurement runs the canary");
  await at(without);
  assert.equal(runs, 1, "control: the same targets reuse the pass");
  await at(withMnt);
  assert.equal(runs, 2, "a pass taken without the /mnt probe was reused once /mnt had a file to probe");
});

test("the daemon finds the Linux targets before it looks for a cached pass, and hands them to the canary", async () => {
  const stateDir = tempDir("cc-");
  const found = [without, withMnt];
  const seen = [];
  const ctx = { logPath: join(stateDir, "reeve.log"), platform: "linux", isolationReady: () => true, mounts: "",
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "2.1.278 (Claude Code)",
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    netProbe: { url: "http://127.0.0.1:1/canary", selfReachable: () => true, wasHit: () => false },
    linuxProbeTargets: async () => found.shift() ?? withMnt,
    canary: async (args) => { seen.push(args.linuxTargets); return { ok: true, id: `c${seen.length}`, why: null, evidence: {} }; } };
  const profile = { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: tempDir("cc-wt-") }, worker: { isolation: "scratch-home" }, units: [] };
  const saved = process.env.REEVE_HOME;
  process.env.REEVE_HOME = stateDir;
  try {
    await daemon.measuredContainment(ctx, profile, "o/r", ctx.logPath);
    await daemon.measuredContainment(ctx, profile, "o/r", ctx.logPath);
  } finally { if (saved === undefined) delete process.env.REEVE_HOME; else process.env.REEVE_HOME = saved; }
  assert.equal(seen.length, 2, "the second measurement reused a pass taken without the /mnt probe");
  assert.deepEqual(seen.map((t) => t?.mntFile ?? null), [null, withMnt.mntFile]);
});

test("on Linux the canary's id follows the sandbox runtime, bubblewrap and socat, as well as the CLI", () => {
  const base = { cliVersion: "2.1.278", sandbox: { enabled: true, filesystem: { denyRead: ["/mnt"] } } };
  const a = canaryIdFor({ ...base, runtime: "bwrap=/usr/bin/bwrap@1 socat=/usr/bin/socat@1" });
  const b = canaryIdFor({ ...base, runtime: "bwrap=/usr/bin/bwrap@2 socat=/usr/bin/socat@1" });
  assert.notEqual(a, b, "a pass under one bubblewrap has the id of one under the next");
  assert.equal(canaryIdFor({ ...base, runtime: "bwrap=/usr/bin/bwrap@1 socat=/usr/bin/socat@1" }), a, "control: the same runtime gives the same id");
});

test("a pass taken under one bubblewrap isn't reused once the host has another", async () => {
  const stateDir = tempDir("cr-");
  const runtimes = ["bwrap=/usr/bin/bwrap@1 socat=/usr/bin/socat@1", "bwrap=/usr/bin/bwrap@1 socat=/usr/bin/socat@1", "bwrap=/usr/bin/bwrap@2 socat=/usr/bin/socat@1"];
  let runs = 0;
  const ctx = { logPath: join(stateDir, "reeve.log"), platform: "linux", isolationReady: () => true, mounts: "",
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "2.1.278 (Claude Code)",
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    netProbe: { url: "http://127.0.0.1:1/canary", selfReachable: () => true, wasHit: () => false },
    linuxProbeTargets: async () => without,
    sandboxRuntimeIdentity: () => runtimes.shift(),
    canary: async () => { runs++; return { ok: true, id: `c${runs}`, why: null, evidence: {} }; } };
  const profile = { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: tempDir("cr-wt-") }, worker: { isolation: "scratch-home" }, units: [] };
  const saved = process.env.REEVE_HOME;
  process.env.REEVE_HOME = stateDir;
  try {
    for (let i = 0; i < 3; i++) await daemon.measuredContainment(ctx, profile, "o/r", ctx.logPath);
  } finally { if (saved === undefined) delete process.env.REEVE_HOME; else process.env.REEVE_HOME = saved; }
  assert.equal(runs, 2, "the same runtime reused the pass once, and a new bubblewrap measured again");
});

test("the check before a worker starts refuses a verdict measured under another sandbox runtime", async () => {
  const verdict = { credentialRead: "closed", binaryId: "/cli@1", runtime: "bwrap=/usr/bin/bwrap@1 socat=/usr/bin/socat@1" };
  const at = (now) => revalidateContainment(verdict, { bin: "/cli", binaryIdentity: () => "/cli@1", platform: "linux", pathVar: "/usr/bin",
                                                       runtimeIdentity: () => now });
  assert.equal((await at("bwrap=/usr/bin/bwrap@1 socat=/usr/bin/socat@1")).ok, true, "control: the same runtime starts the worker");
  const moved = await at("bwrap=/usr/bin/bwrap@2 socat=/usr/bin/socat@1");
  assert.equal(moved.ok, false, "a worker started under a bubblewrap the canary never ran under");
  assert.match(moved.why, /sandbox runtime changed/);
});
