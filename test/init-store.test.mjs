// The state database is created by `reeve init --write` (#193).
//
// `reeve run` refuses to start without one, and rightly: opening a fresh empty
// store on its own is how real history stops being read without anything
// failing. But nothing created one, so a fresh machine could not start the
// daemon at all. These tests check that init creates the store, never touches
// an existing one, moves a legacy one into place rather than replacing it, and
// that `run` names the step when the store is missing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStore, storeStatus } from "../src/init.mjs";
import { statePathFor, legacyStatePathFor, missingStoreMessage } from "../src/paths.mjs";
import { withDefaults } from "../src/profile/schema.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const tables = (path) => { const db = new DatabaseSync(path); try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name); } finally { db.close(); } };
const marker = (path, write) => {
  const db = new DatabaseSync(path);
  try {
    if (write) { db.exec("CREATE TABLE IF NOT EXISTS test_marker (v TEXT)"); db.prepare("INSERT INTO test_marker VALUES (?)").run(write); return write; }
    return db.prepare("SELECT v FROM test_marker").get()?.v ?? null;
  } catch { return null; } finally { db.close(); }
};
const NWO = "acme/widget";

// ── a fresh machine ───────────────────────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    check(storeStatus(home, NWO).state === "missing", "control: a fresh home has no state database");
    const made = ensureStore(home, NWO);
    const path = statePathFor(home, NWO);
    check(made.changed && existsSync(path) && tables(path).length > 0 && /created/.test(made.line ?? ""),
      "on a fresh machine, init creates the state database", JSON.stringify(made));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── an existing store is left alone ───────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    ensureStore(home, NWO);
    const path = statePathFor(home, NWO);
    marker(path, "real history");
    let opened = 0;
    const again = ensureStore(home, NWO, { openStore: (p) => { opened++; return new DatabaseSync(p); } });
    check(!again.changed && opened === 0 && marker(path, null) === "real history",
      "an existing state database is left alone", JSON.stringify({ again, opened }));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── a legacy store is moved into place, never replaced ────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    const legacy = legacyStatePathFor(home, NWO), path = statePathFor(home, NWO);
    mkdirSync(dirname(legacy), { recursive: true });
    marker(legacy, "history at the old path");
    const planned = storeStatus(home, NWO);
    check(planned.state === "legacy" && existsSync(legacy) && !existsSync(path),
      "control: working out the plan moves nothing", JSON.stringify(planned));
    const made = ensureStore(home, NWO);
    check(made.changed && !existsSync(legacy) && marker(path, null) === "history at the old path",
      "a legacy store is moved into place, never replaced by an empty one", JSON.stringify(made));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── `reeve run` names the step that creates a missing store ───────────────────
{
  check(/reeve init --write/.test(missingStoreMessage("/x/y.db")), "a missing store's message names the step that creates it",
    missingStoreMessage("/x/y.db"));

  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    const profile = withDefaults({ schemaVersion: 1, project: { kind: "product" },
      identity: { key: NWO, defaultBranch: "main", visibility: "public" },
      authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
      state: { mode: "in-repo" }, units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
      ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] });
    mkdirSync(join(home, "profiles", "acme"), { recursive: true });
    writeFileSync(join(home, "profiles", "acme", "widget.json"), JSON.stringify(profile));
    let code = 0, err = "";
    try { execFileSync(process.execPath, [join(ROOT, "bin", "reeve"), "run", NWO], { cwd: home, env: { ...process.env, REEVE_HOME: home }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }); }
    catch (e) { code = e.status; err = String(e.stderr); }
    check(code === 1 && /no state database/.test(err) && /reeve init --write/.test(err) && !existsSync(statePathFor(home, NWO)),
      "control: reeve run still refuses without a store, creates none, and says how to make one", `exit ${code}: ${err.trim()}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
