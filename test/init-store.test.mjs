// The state database is created by `reeve init --write` (#193).
//
// `reeve run` refuses to start without one, and rightly: opening a fresh empty
// store on its own is how real history stops being read without anything
// failing. But nothing created one, so a fresh machine could not start the
// daemon at all. These tests check that init creates the store, never touches
// an existing one, moves a legacy one into place rather than replacing it, and
// that `run` names the step when the store is missing.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyInit, ensureStore, storeStatus } from "../src/init.mjs";
import { statePathFor, legacyStatePathFor, missingStoreMessage, adoptLegacyStore } from "../src/paths.mjs";
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
// ensureStore, with a throw recorded rather than raised: a stubbed rule can make
// it throw, and a file that dies there leaves every later assertion unrun.
const ensure = (home, opts) => { try { return ensureStore(home, NWO, opts); } catch (e) { return { threw: e.message }; } };
// The CLI, run from a scratch home. Returns the exit code and stderr.
const reeve = (home, args) => {
  try {
    execFileSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
      { cwd: home, env: { ...process.env, REEVE_HOME: home }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return { code: 0, err: "" };
  } catch (e) { return { code: e.status, err: String(e.stderr) }; }
};

// ── a fresh machine ───────────────────────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    check(storeStatus(home, NWO).state === "missing", "control: a fresh home has no state database");
    const made = ensure(home);
    const path = statePathFor(home, NWO);
    check(made.changed && existsSync(path) && tables(path).length > 0 && /created/.test(made.line ?? ""),
      "on a fresh machine, init creates the state database", JSON.stringify(made));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── an existing store is left alone ───────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    ensure(home);
    const path = statePathFor(home, NWO);
    marker(path, "real history");
    let opened = 0;
    const again = ensure(home, { openStore: (p) => { opened++; return new DatabaseSync(p); } });
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
    const made = ensure(home);
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
    const { code, err } = reeve(home, ["run", NWO]);
    check(code === 1 && /no state database/.test(err) && /reeve init --write/.test(err) && !existsSync(statePathFor(home, NWO)),
      "control: reeve run still refuses without a store, creates none, and says how to make one", `exit ${code}: ${err.trim()}`);
    // init reads the repository from the directory it runs in, and a service runs
    // `reeve run owner/repo` from anywhere, so the step names the checkout.
    check(err.includes(`a checkout of ${NWO}`), "the step names the repository whose checkout to run it in", err.trim());

    // init creates the store at the default path, not wherever --db points, so
    // naming it there would send the reader to a step that doesn't help.
    const elsewhere = join(home, "elsewhere.db");
    const withDb = reeve(home, ["run", NWO, "--db", elsewhere]);
    check(withDb.code === 1 && withDb.err.includes(`no state database at ${elsewhere}`) && !/reeve init/.test(withDb.err) && !existsSync(elsewhere),
      "a --db that names a missing file isn't answered with init, which wouldn't create it", `exit ${withDb.code}: ${withDb.err.trim()}`);

    // Every command that needs the store names the step that creates it.
    const said = ["backup", "shadow", "status"].map((cmd) => ({ cmd, ...reeve(home, [cmd, NWO]) }));
    check(said.every((r) => r.code !== 0 && /no state database/.test(r.err) && /reeve init --write/.test(r.err)),
      "every command that needs the state database names the step that creates it",
      said.map((r) => `${r.cmd}: exit ${r.code}: ${r.err.trim()}`).join(" | "));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── a legacy store that can't be moved says why, and stays where it was ───────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    const legacy = legacyStatePathFor(home, NWO);
    mkdirSync(dirname(legacy), { recursive: true });
    marker(legacy, "history at the old path");
    // A file where the owner's directory belongs, so the move can't happen.
    writeFileSync(join(dirname(legacy), "acme"), "not a directory\n");
    const made = ensure(home);
    check(!made.changed && /could not move/.test(made.line ?? "") && /\bE[A-Z]{3,}\b/.test(made.line ?? "") && marker(legacy, null) === "history at the old path",
      "a legacy store that can't be moved says why, and stays where it was", JSON.stringify(made));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── a legacy store in WAL mode is never split by a failed move ────────────────
//
// A WAL store keeps recent committed writes in its -wal file. Moving the main
// file first and failing before the -wal left the canonical store without them,
// and every later run took the canonical file for the whole store. Whatever file
// the move fails on, the rows must stay readable at exactly one path.
{
  const rowsAt = (path) => { try { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT v FROM t").all().map((r) => r.v); } finally { db.close(); } } catch { return null; } };
  for (const failOn of ["-wal", "-shm", ""]) {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const legacy = legacyStatePathFor(home, NWO), next = statePathFor(home, NWO);
      mkdirSync(dirname(legacy), { recursive: true });
      // Rows that live only in the WAL: the file set copied while its writer holds it.
      const live = join(home, "live.db"), w = new DatabaseSync(live);
      w.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v TEXT)");
      w.prepare("INSERT INTO t VALUES (?)").run("committed, in the wal");
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(live + suffix)) copyFileSync(live + suffix, legacy + suffix);
      w.close();
      if (failOn === "-wal") check(existsSync(legacy + "-wal"), "control: the legacy store's rows are in its -wal file", readdirSync(dirname(legacy)).join(","));
      let failed = false;
      const rename = (from, to) => { if (from === legacy + failOn && !failed) { failed = true; throw new Error("simulated failure"); } return renameSync(from, to); };
      const used = adoptLegacyStore(next, legacy, { log: () => {}, rename });
      const atLegacy = rowsAt(legacy), atNext = existsSync(next) ? rowsAt(next) : null;
      const whole = (rows) => Array.isArray(rows) && rows.includes("committed, in the wal");
      check(failed && used === legacy && whole(atLegacy) && !existsSync(next) && !existsSync(next + "-wal"),
        `a move that fails on ${failOn || "the main file"} leaves the store whole at one path, never split`,
        JSON.stringify({ used: used === legacy ? "legacy" : "next", atLegacy, atNext, next: readdirSync(dirname(next)) }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}

// ── an interrupted create leaves nothing that reads as a store ───────────────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    const path = statePathFor(home, NWO);
    // A create that stops partway: the file exists and the schema never finished.
    const made = ensure(home, { openStore: (p) => { const db = new DatabaseSync(p); db.exec("CREATE TABLE half (x)"); throw new Error("stopped partway"); } });
    check(made.failed === true && !existsSync(path) && storeStatus(home, NWO).state === "missing",
      "an interrupted create leaves no store at the canonical path, so the next init makes it again", JSON.stringify({ made, exists: existsSync(path) }));
    check(readdirSync(dirname(path)).every((f) => !f.includes(".init-")), "and leaves no temporary file behind", readdirSync(dirname(path)).join(","));
    // One an init killed outright left: its process is gone, so the next init clears it.
    writeFileSync(`${path}.init-999999`, "half made");
    const again = ensure(home);
    check(again.changed && existsSync(path) && tables(path).length > 0 && !existsSync(`${path}.init-999999`),
      "the next init creates the store and clears what a killed init left", JSON.stringify({ again, left: readdirSync(dirname(path)) }));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── a store that couldn't be made or moved is an error, not "applied" ────────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    const args = { path: join(home, "profile.json"), after: "{}\n", profileChanged: true, home, nwo: NWO, output: "plan" };
    const failedRun = applyInit({ ...args, ensure: () => ({ changed: false, failed: true, line: "could not move the legacy store" }) });
    const madeRun = applyInit({ ...args, ensure: () => ({ changed: true, line: "created the state database" }) });
    check(failedRun.code === 1 && /could not move/.test(failedRun.output) && madeRun.code === 2,
      "init exits 1 when the store couldn't be made or moved, and 2 only when everything was applied", JSON.stringify({ failed: failedRun.code, made: madeRun.code }));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
