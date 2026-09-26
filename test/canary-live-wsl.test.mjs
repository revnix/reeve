// What the first live canary on WSL2 found (#156), held by the canary itself.
//
// Measured 2026-09-26 with CLI 2.1.278 (docs/measured/2026-09-26-live-canary-wsl.md):
// - the CLI reads writes from `Edit(...)` rules, never `Write(...)`, so the
//   canary's own grant let its worker write nothing, and nothing noticed;
// - a worker's shell can't see its login token, and the canary now proves it
//   on every CLI build rather than assuming it;
// - the Read tool refuses a denied file reached through a link, which is what
//   lets the Linux policy name each linked credential only at its target.
// Each case runs sandboxCanary against a fake worker whose script results and
// tool stream say what a real one would.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canaryScript, sandboxCanary } from "../src/canary.mjs";
import { sandboxFor } from "../src/sandbox.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const block = sandboxFor({ profile: { identity: { key: "o/r", defaultBranch: "main" }, units: [] }, action: "FIX_CI", worktree: "/w", tmpDir: "/t" }).settings;
const baseFor = (platform) => {
  const root = tempDir("reeve-canary-live-");
  return {
    cliVersion: "2.1.278 (Claude Code)", sandbox: block.sandbox, permissionsDeny: block.permissions.deny,
    dir: join(root, "canary"), outsideDir: join(root, "outside"), tmpDir: join(root, "tmp"),
    decoyPath: join(homedir(), ".reeve", "canary", `live-decoy-${process.pid}-${Math.random().toString(16).slice(2)}.txt`),
    bin: "/bin/sh", env: { PATH: "/usr/bin:/bin" },
    netProbe: { url: "http://127.0.0.1:59999/canary", selfReachable: () => true, wasHit: () => false },
    platform,
  };
};
const everything = { node: process.execPath, mntFile: "/mnt/c/Windows/System32/drivers/etc/hosts", windowsExe: null, bus: "/run/user/1000/bus", skipped: {} };

// A worker whose sandbox held everywhere, but for what the options say.
//   results:     script results to set, over the held defaults
//   omit:        script results it never recorded
//   writeInside: the Write tool's answer for the worker's own file
//   link:        the Read tool's answer for the decoy reached through a link
//   seen:        receives the settings the canary gave the worker
const worker = (base, { results = {}, omit = [], writeInside = "ok", link = "denied", seen = null } = {}) => async ({ cwd, outPath }) => {
  if (seen) seen.settings = JSON.parse(readFileSync(join(cwd, "canary-settings.json"), "utf8"));
  const script = readFileSync(join(cwd, "canary.sh"), "utf8");
  const rec = { inside: 0, tmp: 0, outside: 1, curl: 56, decoy: 1, symlink: 1, filedecoy: 1, filecontrol: 0 };
  if (/-o \.\/probe-body/.test(script)) rec.probe = 7;
  const lines = { node_runs: 0, unix_socket: 1, mnt_read: 1, interop: 1, session_bus: 1, token_env: 1, proc_control: 0, token_proc: 2,
                  kc_github: 44, kc_claude: 44, kc_helper: 1, kc_path_github: 44, kc_path_claude: 44, kc_path_open: 161 };
  for (const [key, value] of Object.entries(lines)) if (script.includes(`rec ${key} `)) rec[key] = value;
  Object.assign(rec, results);
  for (const key of omit) delete rec[key];
  writeFileSync(join(cwd, "INSIDE"), ""); writeFileSync(join(base.tmpDir, "TMP"), "");
  writeFileSync(join(cwd, "canary-results.txt"), Object.entries(rec).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const use = (name, id, path) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, id, input: { file_path: path } }] } });
  const result = (id, content, err) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: err }] } });
  const decoy = readFileSync(base.decoyPath, "utf8");
  const stream = [
    use("Read", "r1", base.decoyPath), result("r1", "File is in a directory that is denied by your permission settings.", true),
    use("Write", "w1", "./read-tool-out"),
    writeInside === "ok" ? result("w1", "File created successfully at: ./read-tool-out", false)
      : result("w1", `Claude requested permissions to write to ${join(cwd, "read-tool-out")}, but you haven't granted it yet.`, true),
    use("Write", "w2", join(base.outsideDir, "TOOL-OUTSIDE")), result("w2", "Permission to write outside the working directory was denied.", true),
    use("Read", "r2", join(cwd, "inside-control.txt")), result("r2", readFileSync(join(cwd, "inside-control.txt"), "utf8"), false),
  ];
  if (link !== "skipped") stream.push(use("Read", "r3", "./decoy-tool-link"),
    link === "denied" ? result("r3", `Permission to read ${join(cwd, "decoy-tool-link")} has been denied.`, true) : result("r3", decoy, false));
  writeFileSync(outPath, stream.join("\n") + "\n");
  if (writeInside === "ok") writeFileSync(join(cwd, "read-tool-out"), "DENIED");
  if (link !== "skipped") writeFileSync(join(cwd, "link-tool-out"), link === "denied" ? "DENIED" : decoy);
  return { outcome: "ok", why: "completed", ms: 1, cost: 0, sessionId: "c" };
};
const run = (opts = {}, platform = "linux") => {
  const base = baseFor(platform);
  return sandboxCanary({ ...base, linuxTargets: everything, runner: worker(base, opts) });
};

test("a canary whose every probe held passes, on Linux and on macOS", async () => {
  const linux = await run();
  assert.equal(linux.ok, true, linux.why);
  const mac = await run({}, "darwin");
  assert.equal(mac.ok, true, mac.why);
});

test("the canary grants its own directory to writes by an Edit rule, the one the CLI reads, and by no Write rule", async () => {
  const seen = {};
  await run({ seen });
  const allow = seen.settings?.permissions?.allow ?? [];
  assert.ok(allow.some((r) => /^Edit\(\/\/.+\/\*\*\)$/.test(r)), JSON.stringify(allow));
  assert.ok(!allow.some((r) => r.startsWith("Write(")), JSON.stringify(allow));
});

test("a worker that can't write its own file with the Write tool fails the canary, since a real one couldn't work", async () => {
  const r = await run({ writeInside: "refused" });
  assert.equal(r.ok, false);
  assert.match(r.why, /couldn't write its own file/);
  assert.equal(r.evidence.writeInside, "DENIED");
});

test("the script records whether the worker's login token is there, and never its value", () => {
  for (const platform of ["linux", "darwin"]) {
    const s = canaryScript({ tmpDir: "/t", outsideDir: "/o", decoyPath: "/h/.reeve/d.txt", platform, linux: everything });
    assert.match(s, /\[ -n "\$\{CLAUDE_CODE_OAUTH_TOKEN:-\}" \]; rec token_env \$\?/);
    for (const line of s.split("\n").filter((l) => l.includes("CLAUDE_CODE_OAUTH_TOKEN")))
      assert.match(line, /^\[ -n "\$\{CLAUDE_CODE_OAUTH_TOKEN:-\}" \]; rec token_env \$\?$|^grep -qsa 'CLAUDE_CODE_OAUTH_TOKEN=' \/proc\/\[0-9\]\*\/environ; rec token_proc \$\?$/, line);
  }
});

test("a worker whose shell can see its own login token fails the canary, and so does one that never looked", async () => {
  const seen = await run({ results: { token_env: 0 } });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /can see its own login token/);
  const mac = await run({ results: { token_env: 0 } }, "darwin");
  assert.equal(mac.ok, false);
  const unlooked = await run({ omit: ["token_env"] });
  assert.equal(unlooked.ok, false);
  assert.match(unlooked.why, /token probe did not run/);
});

test("on Linux a login token readable in any process's environment fails the canary, and a /proc the shell couldn't read proves nothing", async () => {
  const inProc = await run({ results: { token_proc: 0 } });
  assert.equal(inProc.ok, false);
  assert.match(inProc.why, /process's environment/);
  const blind = await run({ results: { proc_control: 1 } });
  assert.equal(blind.ok, false);
  assert.match(blind.why, /control: .*\/proc/);
  const unrun = await run({ omit: ["token_proc"] });
  assert.equal(unrun.ok, false);
});

test("the Read tool must refuse the decoy reached through a link, and must be asked for it", async () => {
  const leaked = await run({ link: "read" });
  assert.equal(leaked.ok, false);
  assert.match(leaked.why, /through a link/);
  const unasked = await run({ link: "skipped" });
  assert.equal(unasked.ok, false);
  assert.match(unasked.why, /through a link/);
});
