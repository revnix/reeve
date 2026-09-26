// The canary on Linux (#156): it probes the host's own ways out, and the gate
// accepts a Linux host only when those probes held.
//
// On macOS the canary proves the login keychain is out of reach. On Linux
// `security` isn't there, and its 127 would read as a closure never measured.
// What decides there is the runtime's seccomp filter, which blocks new Unix
// sockets: measured on WSL2 (docs/measured/2026-09-25-linux-wsl-sandbox.md), it
// is what closes Windows interop, D-Bus and every socket the deny list can't
// name, Docker's among them. So a worker that can create a Unix socket fails
// the canary, and the host is refused. /mnt, a committed Windows binary and the
// session bus are probed too, each only where the daemon reached it first.
//
// The worker is faked here, as in test/canary.test.mjs: it writes the results
// file and the tool stream a real run would leave. What runs under the real
// runtime is measured by test/escape.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canaryIdFor, canaryScript, instrumentHash, linuxProbeTargets, probeShapeOf, sandboxCanary } from "../src/canary.mjs";
import { cheapContainmentReasons, measureContainment } from "../src/containment.mjs";
import { sandboxFor } from "../src/sandbox.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const root = tempDir("reeve-canary-linux-");
const block = sandboxFor({ profile: { identity: { key: "o/r", defaultBranch: "main" }, units: [] }, action: "FIX_CI", worktree: "/w", tmpDir: "/t" }).settings;
const base = {
  cliVersion: "2.1.278 (Claude Code)", sandbox: block.sandbox, permissionsDeny: block.permissions.deny,
  dir: join(root, "canary"), outsideDir: join(root, "outside"), tmpDir: join(root, "tmp"),
  // ~/.reeve is deny-read, so the decoy must sit under it to be measurable. The
  // canary writes it and removes it.
  decoyPath: join(homedir(), ".reeve", "canary", `linux-decoy-${process.pid}.txt`),
  bin: "/bin/sh", env: { PATH: "/usr/bin:/bin" },
  netProbe: { url: "http://127.0.0.1:59999/canary", selfReachable: () => true, wasHit: () => false },
  platform: "linux",
};
const everything = { node: process.execPath, mntFile: "/mnt/c/Windows/System32/drivers/etc/hosts", windowsExe: null, bus: "/run/user/1000/bus", skipped: {} };

// A worker that ran the script under a sandbox that held, but for `leak`: the
// probes named there succeeded, or, for `absent`, never ran.
const worker = ({ leak = [], absent = [], nodeRuns = true } = {}) => async ({ cwd, outPath }) => {
  const script = readFileSync(join(cwd, "canary.sh"), "utf8");
  const rec = { inside: 0, tmp: 0, outside: 1, curl: 56, decoy: 1, symlink: 1, filedecoy: 1, filecontrol: 0 };
  if (/-o \.\/probe-body/.test(script)) rec.probe = 7;
  writeFileSync(join(cwd, "INSIDE"), ""); writeFileSync(join(base.tmpDir, "TMP"), "");
  for (const [key, line] of [["node_runs", "rec node_runs"], ["unix_socket", "rec unix_socket"], ["mnt_read", "rec mnt_read"],
                             ["interop", "rec interop"], ["session_bus", "rec session_bus"]]) {
    if (!script.includes(line) || absent.includes(key)) continue;
    rec[key] = key === "node_runs" ? (nodeRuns ? 0 : 127) : leak.includes(key) ? 0 : 1;
  }
  // The login token isn't in the shell's environment, nor any it can read.
  for (const [key, held] of [["token_env", 1], ["proc_control", 0], ["token_proc", 2]]) if (script.includes(`rec ${key} `)) rec[key] = held;
  writeFileSync(join(cwd, "canary-results.txt"), Object.entries(rec).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  // The tool stream: the Read of the worker's own file returns it; the Read of
  // the decoy and the Write outside are refused.
  const use = (name, id, path) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, id, input: { file_path: path } }] } });
  const result = (id, content, err) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: err }] } });
  // It writes its own file, and the decoy reached through a link is refused.
  writeFileSync(outPath, [use("Read", "r1", base.decoyPath), result("r1", "Permission to read the file was denied.", true),
    use("Write", "w0", "./read-tool-out"), result("w0", "File created successfully at: ./read-tool-out", false),
    use("Write", "w1", join(base.outsideDir, "TOOL-OUTSIDE")), result("w1", "Permission to write outside the working directory was denied.", true),
    use("Read", "r2", join(cwd, "inside-control.txt")), result("r2", readFileSync(join(cwd, "inside-control.txt"), "utf8"), false),
    use("Read", "r3", "./decoy-tool-link"), result("r3", "Permission to read the file has been denied.", true)].join("\n") + "\n");
  writeFileSync(join(cwd, "read-tool-out"), "DENIED");
  writeFileSync(join(cwd, "link-tool-out"), "DENIED");
  return { outcome: "ok", why: "completed", ms: 1, cost: 0, sessionId: "c" };
};
const run = (opts, targets = everything) => sandboxCanary({ ...base, linuxTargets: targets, runner: worker(opts) });

test("on Linux the canary script probes the socket filter and the host's own paths, and leaves the macOS keychain out", () => {
  const s = canaryScript({ tmpDir: "/t", outsideDir: "/o", decoyPath: "/h/.reeve/d.txt", platform: "linux", linux: { ...everything, windowsExe: "/mnt/c/cmd.exe" } });
  assert.match(s, /rec node_runs/);
  assert.match(s, /listen\("\.\/canary\.sock"/);
  assert.match(s, /rec unix_socket/);
  assert.match(s, /cp '\/mnt\/c\/Windows\/System32\/drivers\/etc\/hosts' \.\/mnt-copy/);
  assert.match(s, /\.\/committed\.exe \/c exit 0/);
  assert.match(s, /rec session_bus/);
  assert.doesNotMatch(s, /\/usr\/bin\/security/);
  assert.doesNotMatch(s, /\bcat /);
});

test("on macOS the canary script keeps the keychain probes and has no Linux ones", () => {
  const s = canaryScript({ tmpDir: "/t", outsideDir: "/o", decoyPath: "/h/.reeve/d.txt", platform: "darwin", linux: everything });
  assert.match(s, /\/usr\/bin\/security show-keychain-info/);
  assert.doesNotMatch(s, /rec unix_socket|rec node_runs|rec mnt_read|rec session_bus/);
});

test("a Linux canary passes when every probe held and each control ran", async () => {
  const r = await run();
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.evidence.linux.targets, { mntFile: everything.mntFile, windowsExe: null, bus: everything.bus });
});

test("a Linux canary records the id its cache is looked in under, with the probes it ran in both", async () => {
  // measureContainment builds its cache key from the targets it found, and the
  // canary records its id from the targets it ran. They must be one value, or a
  // pass is stored under an id nothing looks for (#156).
  const r = await run();
  assert.equal(r.ok, true, r.why);
  const key = canaryIdFor({ cliVersion: base.cliVersion, sandbox: base.sandbox, worktree: base.dir, permissionsDeny: base.permissionsDeny,
                            instrument: instrumentHash({ hasNet: true }), probes: probeShapeOf(everything) });
  assert.equal(r.id, key);
  // And under the sandbox runtime it was measured with, which the key has too.
  const runtime = "bwrap=/usr/bin/bwrap@1 socat=/usr/bin/socat@1";
  const rr = await sandboxCanary({ ...base, linuxTargets: everything, runner: worker(), runtime });
  assert.equal(rr.ok, true, rr.why);
  assert.equal(rr.id, canaryIdFor({ cliVersion: base.cliVersion, sandbox: base.sandbox, worktree: base.dir, permissionsDeny: base.permissionsDeny,
                                    instrument: instrumentHash({ hasNet: true }), probes: probeShapeOf(everything), runtime }));
});

test("a worker that can create a Unix socket fails the Linux canary: the socket filter is not in force", async () => {
  const r = await run({ leak: ["unix_socket"] });
  assert.equal(r.ok, false);
  assert.match(r.why, /created a Unix socket/);
});

test("the socket probe proves nothing if node can't run in the sandbox", async () => {
  const r = await run({ nodeRuns: false });
  assert.equal(r.ok, false);
  assert.match(r.why, /control: node could not run/);
});

test("a Linux canary whose socket probe didn't run fails", async () => {
  const r = await run({ absent: ["unix_socket"] });
  assert.equal(r.ok, false);
  assert.match(r.why, /socket probe did not run/);
});

test("reading under /mnt, running a committed Windows binary or reaching the session bus fails the Linux canary", async () => {
  const exe = join(root, "fake-cmd.exe");
  writeFileSync(exe, "");
  const targets = { ...everything, windowsExe: exe };
  // One after another: each canary owns the same directories while it runs.
  const seen = [];
  for (const [key, want] of [["mnt_read", /under \/mnt/], ["interop", /Windows binary/], ["session_bus", /session bus/]]) {
    const r = await run({ leak: [key] }, targets);
    seen.push([key, r.ok, want.test(r.why ?? "")]);
  }
  assert.deepEqual(seen, [["mnt_read", false, true], ["interop", false, true], ["session_bus", false, true]]);
});

test("a probe the host has but the script didn't run fails the canary", async () => {
  const r = await run({ absent: ["mnt_read"] });
  assert.equal(r.ok, false);
  assert.match(r.why, /mnt_read probe did not run/);
});

test("a shape the host doesn't have isn't probed, and the evidence says why", async () => {
  const none = { node: process.execPath, mntFile: null, windowsExe: null, bus: null, skipped: { mnt: "nothing under /mnt is readable on this host" } };
  const r = await run({}, none);
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.evidence.linux.skipped, none.skipped);
});

test("the gate accepts Linux as it does macOS, and still refuses a platform never measured", () => {
  // A mount table of its own, so the simulated Linux host doesn't need /proc.
  const reasons = (platform) => cheapContainmentReasons({ platform, isolated: true, keychain: { measured: false, items: [] }, mounts: "" }).reasons;
  assert.deepEqual(reasons("linux"), []);
  assert.deepEqual(reasons("darwin"), []);
  assert.match(reasons("win32").join(" "), /unmeasured on win32/);
});

test("a closed Linux verdict doesn't claim a keychain it never measured", async () => {
  // The keychain probe is macOS only, so on Linux it answers unmeasured. A
  // verdict that says the keychain holds no GitHub credential would be stating
  // evidence nobody gathered.
  const ask = (platform, keychain) => measureContainment({ cliVersion: base.cliVersion, sandbox: base.sandbox, permissionsDeny: base.permissionsDeny,
    canaryPaths: { dir: base.dir }, bin: base.bin, env: base.env, platform, isolated: true, keychain, mounts: "", linuxTargets: everything,
    canary: { ok: true, id: "c1", why: null } });
  const linuxV = await ask("linux", { measured: false, items: [], why: "keychain probe is only measured on macOS (this is linux)" });
  assert.equal(linuxV.credentialRead, "closed", linuxV.why);
  assert.doesNotMatch(linuxV.why, /holds no GitHub credential/);
  assert.match(linuxV.why, /keychain wasn't measured/);
  const macV = await ask("darwin", { measured: true, items: [], why: null });
  assert.match(macV.why, /holds no GitHub credential/, "control: a measured, empty keychain is still reported so");
});

test("the daemon finds the Linux targets it can reach itself, and names the ones it can't", { skip: process.platform !== "linux" && "Linux only" }, async () => {
  const t = await linuxProbeTargets();
  assert.equal(t.node, process.execPath);
  for (const [key, skip] of [["mntFile", "mnt"], ["windowsExe", "interop"], ["bus", "bus"]])
    assert.ok(t[key] ? existsSync(t[key]) : typeof t.skipped[skip] === "string", `${key}: ${JSON.stringify(t)}`);
});
