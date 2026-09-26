// On Linux the Read tool's denies name no path through a link (#156).
//
// The CLI mounts its Read denies in the sandbox, as it does the sandbox's own,
// and bubblewrap can't mount over a link. Measured 2026-09-26 with CLI 2.1.278
// on WSL2, where ~/.aws links into the Windows profile: "bwrap: Can't mount
// tmpfs on /newroot/home/<you>/.aws", and the sandbox didn't start. Measured the
// same day: the Read tool refuses a denied file reached through a link, so
// denying the target covers the link too (docs/measured/2026-09-26-live-canary-wsl.md).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxFor } from "../src/sandbox.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const profile = { identity: { key: "o/r", defaultBranch: "main" }, units: [] };

// A home where ~/.aws and ~/.npmrc are links, as WSL makes them.
const linkedHome = () => {
  const home = realpathSync(tempDir("reeve-linked-read-"));
  mkdirSync(join(home, "elsewhere", "aws"), { recursive: true });
  symlinkSync(join(home, "elsewhere", "aws"), join(home, ".aws"));
  writeFileSync(join(home, "elsewhere", "npmrc"), "decoy\n");
  symlinkSync(join(home, "elsewhere", "npmrc"), join(home, ".npmrc"));
  return home;
};
const withHome = (home, fn) => {
  const saved = process.env.HOME, savedReeve = process.env.REEVE_HOME;
  process.env.HOME = home; delete process.env.REEVE_HOME;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    if (savedReeve !== undefined) process.env.REEVE_HOME = savedReeve;
  }
};
const readPaths = (deny) => deny.map((r) => /^Read\(\/(\/[^)]*?)(\/\*\*)?\)$/.exec(r)?.[1]).filter(Boolean);

test("on Linux the Read tool is denied a linked credential at its target only, a file as a file", { skip: process.platform !== "linux" && "Linux only" }, () => {
  const home = linkedHome();
  const deny = withHome(home, () => sandboxFor({ profile, action: "FIX_CI", worktree: "/tmp/wt", tmpDir: "/tmp/t" }).settings.permissions.deny);
  assert.ok(deny.includes(`Read(/${join(home, "elsewhere", "aws")}/**)`), JSON.stringify(deny.filter((d) => d.includes(home))));
  assert.ok(deny.includes(`Read(/${join(home, "elsewhere", "npmrc")})`), JSON.stringify(deny.filter((d) => d.includes(home))));
  assert.ok(!deny.some((d) => d.includes(join(home, ".aws")) || d.includes(join(home, ".npmrc"))), JSON.stringify(deny.filter((d) => d.includes(home))));
});

test("on Linux no path the Read tool is denied runs through a link", { skip: process.platform !== "linux" && "Linux only" }, () => {
  const home = linkedHome();
  const deny = withHome(home, () => sandboxFor({ profile, action: "FIX_CI", worktree: "/tmp/wt", tmpDir: "/tmp/t" }).settings.permissions.deny);
  const linked = readPaths(deny).filter((p) => existsSync(p) && realpathSync(p) !== p);
  assert.deepEqual(linked, []);
});
