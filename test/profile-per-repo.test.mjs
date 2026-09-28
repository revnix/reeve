// A profile is used only for the repository it names (#264).
//
// `loadProfile` read the working directory's `.ops/profile.json` before the one
// kept for the repository under the reeve home, and used it whatever repository
// it named. So a command naming one repository, run inside another's checkout,
// applied the checkout's rules: `reeve run o/a` would judge o/a by o/b's policy.
// `notify --test` guarded itself; every other command shared the loader.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import { withDefaults } from "../src/profile/schema.mjs";
import { statePathFor } from "../src/paths.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
/** A valid profile naming `key`. */
const profileFor = (key) => JSON.stringify(withDefaults({ schemaVersion: 1, project: { kind: "product" },
  identity: { key, defaultBranch: "main", visibility: "public" },
  authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
  state: { mode: "in-repo" }, units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
  ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] }));
/** `reeve ...args` from `cwd`, with a home of its own, halted so nothing that starts reaches GitHub. */
function reeve(cwd, home, ...args) {
  writeFileSync(join(home, "HALT"), "");
  const r = spawnSync(process.execPath, [REEVE, ...args, "--home", home], { cwd, encoding: "utf8", env: offlineEnv(), timeout: 20_000 });
  return { status: r.status, signal: r.signal, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("a profile in the working directory for another repository is refused, not applied, and the refusal names both", () => {
  const dir = tempDir("reeve-profile-repo-");
  const checkout = join(dir, "b");
  mkdirSync(join(checkout, ".ops"), { recursive: true });
  writeFileSync(join(checkout, ".ops", "profile.json"), profileFor("o/b"));
  const home = join(dir, "home");
  mkdirSync(home);
  const r = reeve(checkout, home, "run", "o/a");
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /"o\/b"/);
  assert.match(r.out, /"o\/a"/);
});

test("a profile kept for a repository that names another is refused too", () => {
  const dir = tempDir("reeve-profile-repo-");
  const home = join(dir, "home");
  mkdirSync(join(home, "profiles", "o"), { recursive: true });
  writeFileSync(join(home, "profiles", "o", "a.json"), profileFor("o/b"));
  const r = reeve(dir, home, "run", "o/a");
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /is for "o\/b", not "o\/a"/);
});

test("a command that goes on without a profile goes on without another repository's, and says so", () => {
  const dir = tempDir("reeve-profile-repo-");
  const checkout = join(dir, "b");
  mkdirSync(join(checkout, ".ops"), { recursive: true });
  writeFileSync(join(checkout, ".ops", "profile.json"), profileFor("o/b"));
  const home = join(dir, "home");
  mkdirSync(home);
  const dbPath = join(dir, "s.db");
  open(dbPath).close();
  const r = reeve(checkout, home, "replay", "o/a", "--db", dbPath);
  assert.match(r.out, /is for "o\/b", not "o\/a", so it isn't used/);
});

test("control: a profile that names the repository is used", () => {
  const dir = tempDir("reeve-profile-repo-");
  const home = join(dir, "home");
  mkdirSync(join(home, "profiles", "o"), { recursive: true });
  writeFileSync(join(home, "profiles", "o", "a.json"), profileFor("o/a"));
  // No store yet: a profile that was used gets as far as asking for one.
  const r = reeve(dir, home, "run", "o/a");
  assert.doesNotMatch(r.out, /isn't used/);
  assert.match(r.out, /reeve init|store/i);
  assert.ok(statePathFor(home, "o/a"));
});
