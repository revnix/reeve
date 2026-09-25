// The state database is created by `reeve init --write` (#193).
//
// `reeve run` refuses to start without one, and rightly: opening a fresh empty
// store on its own is how real history stops being read without anything
// failing. But nothing created one, so a fresh machine could not start the
// daemon at all. These tests check that init creates the store, never touches
// an existing one, moves a legacy one into place rather than replacing it, and
// that `run` names the step when the store is missing.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
// adoptLegacyStore likewise: the path it returns, or what it threw.
const adopt = (next, legacy, opts = {}) => { try { return adoptLegacyStore(next, legacy, { log: () => {}, ...opts }); } catch (e) { return { threw: e.message, code: e.code }; } };
// The CLI, run from a scratch home. Returns the exit code, stdout and stderr.
const reeve = (home, args) => {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
      { cwd: home, env: { ...process.env, REEVE_HOME: home }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return { code: 0, out, err: "" };
  } catch (e) { return { code: e.status, out: String(e.stdout ?? ""), err: String(e.stderr) }; }
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
      const used = adopt(next, legacy, { rename });
      const atLegacy = rowsAt(legacy), atNext = existsSync(next) ? rowsAt(next) : null;
      const whole = (rows) => Array.isArray(rows) && rows.includes("committed, in the wal");
      check(failed && used === legacy && whole(atLegacy) && !existsSync(next) && !existsSync(next + "-wal"),
        `a move that fails on ${failOn || "the main file"} leaves the store whole at one path, never split`,
        JSON.stringify({ used: used === legacy ? "legacy" : used === next ? "next" : used, atLegacy, atNext, next: readdirSync(dirname(next)) }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}

// A process that dies partway runs no rollback, so what matters then is the
// ORDER: the next run must find a state it can finish. The rename below dies
// after k moves and refuses every later call, the rollback's included, which
// leaves the disk exactly as a killed process would.
{
  const rowsAt = (path) => { try { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT v FROM t").all().map((r) => r.v); } finally { db.close(); } } catch { return null; } };
  const results = [];
  for (const k of [0, 1, 2]) {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const legacy = legacyStatePathFor(home, NWO), next = statePathFor(home, NWO);
      mkdirSync(dirname(legacy), { recursive: true });
      const live = join(home, "live.db"), w = new DatabaseSync(live);
      w.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v TEXT)");
      w.prepare("INSERT INTO t VALUES (?)").run("committed, in the wal");
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(live + suffix)) copyFileSync(live + suffix, legacy + suffix);
      w.close();
      let n = 0;
      const dies = (from, to) => { if (n++ >= k) throw new Error("the process died here"); return renameSync(from, to); };
      const first = adopt(next, legacy, { rename: dies });   // refuses both paths once the store is split
      const used = adopt(next, legacy, { timeoutMs: 1000 });   // the next run
      const other = used === next ? legacy : next;
      results.push({ k, first: first.code ?? "returned", used: used === next ? "next" : used === legacy ? "legacy" : used, rows: rowsAt(used), strayMain: existsSync(other) });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  check(results.every((r) => Array.isArray(r.rows) && r.rows.includes("committed, in the wal") && !r.strayMain),
    "a move killed after any file is finished by the next run, with every committed row", JSON.stringify(results));
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

// ── one process moves a legacy store at a time ───────────────────────────────
//
// Two commands started together both saw the main file missing and moved each
// other's sidecars. The holder of the lock beside the new path moves; another
// waits and uses what it made, and a live holder that never finishes is refused
// loudly, touching nothing. The movers here are real processes, because what is
// being tested is what one process sees of another: a holder part way through a
// move, and one killed there.
{
  const legacyStore = (home) => {
    const legacy = legacyStatePathFor(home, NWO), next = statePathFor(home, NWO);
    mkdirSync(dirname(legacy), { recursive: true }); mkdirSync(dirname(next), { recursive: true });
    const live = join(home, "live.db"), w = new DatabaseSync(live);
    w.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v TEXT)");
    w.prepare("INSERT INTO t VALUES (?)").run("committed, in the wal");
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(live + suffix)) copyFileSync(live + suffix, legacy + suffix);
    w.close();
    return { legacy, next };
  };
  const rowsAt = (path) => { try { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT v FROM t").all().map((r) => r.v); } finally { db.close(); } } catch { return null; } };
  const whole = (path) => (rowsAt(path) ?? []).includes("committed, in the wal");
  const renamesBy = () => { const calls = []; return { calls, rename: (a, b) => { calls.push(a); renameSync(a, b); } }; };
  // Another process moving the store. It stops once the file `at` names has
  // moved, its -wal by default, the point where the two paths each hold part of
  // the store, and there either waits `pause` milliseconds and finishes, or is
  // killed.
  const MOVER = `
    import { renameSync } from "node:fs";
    import { adoptLegacyStore } from ${JSON.stringify(new URL("../src/paths.mjs", import.meta.url).href)};
    const { MOVE_NEXT: next, MOVE_LEGACY: legacy, MOVE_PAUSE: pause, MOVE_AT: at } = process.env;
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    adoptLegacyStore(next, legacy, { log: () => {}, rename: (from, to) => {
      renameSync(from, to);
      if (from !== legacy + at) return;
      console.log("part way");
      if (pause === "killed") process.kill(process.pid, "SIGKILL");
      sleep(Number(pause));
    } });
    console.log("done");`;
  const mover = async (next, legacy, pause, at = "-wal") => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", MOVER],
      { env: { ...process.env, MOVE_NEXT: next, MOVE_LEGACY: legacy, MOVE_PAUSE: String(pause), MOVE_AT: at }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, out })));
    const partWay = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      child.stdout.on("data", (d) => { out += d; if (out.includes("part way")) { clearTimeout(timer); resolve(true); } });
      child.on("exit", () => { clearTimeout(timer); resolve(out.includes("part way")); });
    });
    return { partWay, ended, stop: () => child.kill("SIGKILL") };
  };
  {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const { legacy, next } = legacyStore(home);
      const other = await mover(next, legacy, 800);
      const ours = renamesBy();
      // Called while the other process is part way through; it finishes and lets go.
      const used = adopt(next, legacy, { rename: ours.rename });
      const theirs = await other.ended;
      check(other.partWay && used === next && ours.calls.length === 0 && whole(next) && !existsSync(legacy),
        "while another process moves the store, this one waits and uses what it made, moving nothing itself",
        JSON.stringify({ partWay: other.partWay, used, ours: ours.calls, theirs }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    let other = null;
    try {
      const { legacy, next } = legacyStore(home);
      other = await mover(next, legacy, 3000);
      // Empty whatever lock file sits beside the store. A holder that has made
      // its lock but not yet written into it leaves exactly this, and a lock
      // judged by what its file says was taken from its live holder then.
      for (const f of readdirSync(dirname(next))) if (f.startsWith(`${basename(next)}.`)) writeFileSync(join(dirname(next), f), "");
      const ours = renamesBy();
      const used = adopt(next, legacy, { rename: ours.rename, timeoutMs: 300 });
      check(other.partWay && used.code === "STORE_BUSY" && /being moved/.test(used.threw ?? "") && ours.calls.length === 0 && existsSync(legacy),
        "a holder part way through a move is never taken for dead, whatever its lock file says, and one that doesn't finish in time is refused, touching nothing",
        JSON.stringify({ partWay: other.partWay, used, ours: ours.calls, legacy: existsSync(legacy) }));
      const theirs = await other.ended;
      check(theirs.code === 0 && whole(next) && !existsSync(legacy), "control: the holder then finishes its move, with every committed row", JSON.stringify(theirs));
    } finally { other?.stop(); rmSync(home, { recursive: true, force: true }); }
  }
  {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const { legacy, next } = legacyStore(home);
      const other = await mover(next, legacy, "killed");
      const theirs = await other.ended;
      // An earlier build's lock file named its holder's pid. Reused by a live
      // process, that pid held a dead holder's lock for ever.
      writeFileSync(`${next}.moving`, String(process.pid));
      const used = adopt(next, legacy, { timeoutMs: 1000 });
      check(other.partWay && theirs.signal === "SIGKILL" && used === next && whole(next) && !existsSync(legacy),
        "a move stopped by a killed process is finished by the next run, whatever pid a lock file names",
        JSON.stringify({ partWay: other.partWay, theirs, used }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const leftBeside = (next) => readdirSync(dirname(next)).filter((f) => ![basename(next), `${basename(next)}-wal`, `${basename(next)}-shm`].includes(f));
  {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const { legacy, next } = legacyStore(home);
      const used = adopt(next, legacy);
      const left = leftBeside(next);
      check(used === next && whole(next) && left.length === 0, "nothing but the store is left beside it once the move is done", JSON.stringify({ used, left }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const { legacy, next } = legacyStore(home);
      // Killed after its last rename, before it let go of the lock.
      const other = await mover(next, legacy, "killed", "");
      const theirs = await other.ended;
      const used = adopt(next, legacy, { timeoutMs: 1000 });
      const left = leftBeside(next);
      check(other.partWay && theirs.signal === "SIGKILL" && used === next && whole(next) && left.length === 0,
        "a mover killed after its last rename leaves nothing behind once the next run finds the store", JSON.stringify({ theirs, used, left }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const { legacy, next } = legacyStore(home);
      const other = await mover(next, legacy, "killed", "");
      const theirs = await other.ended;
      // The next thing run is init, which finds the store in place and moves nothing.
      const made = ensure(home);
      const left = leftBeside(next);
      check(other.partWay && theirs.signal === "SIGKILL" && !made.changed && !made.failed && !made.threw && whole(next) && left.length === 0,
        "and so does reeve init --write, which finds the store in place", JSON.stringify({ made, left }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  // ── a move that leaves the store split refuses both paths ──────────────────
  //
  // The legacy main file, opened without the WAL that sits at the new path,
  // hides every committed write still in that WAL. So while any of the store's
  // files are at the new path, neither path is used; the next run finishes the
  // move, because the main file always moves last.
  {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const { legacy, next } = legacyStore(home);
      // The main file won't move, and the WAL won't move back.
      const rename = (from, to) => {
        if (from === legacy) throw new Error("EIO: the main file failed to move");
        if (from === `${next}-wal`) throw new Error("EIO: the WAL failed to move back");
        return renameSync(from, to);
      };
      const used = adopt(next, legacy, { rename });
      check(used.code === "STORE_SPLIT" && (used.threw ?? "").includes(`${next}-wal`) && /main file failed/.test(used.threw ?? ""),
        "a move whose rollback also fails refuses both paths, and says which files are where", JSON.stringify(used));
      const again = adopt(next, legacy, { timeoutMs: 1000 });
      check(again === next && whole(next) && !existsSync(legacy), "and the next run finishes the move, with every committed row", JSON.stringify({ again }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const { legacy, next } = legacyStore(home);
      renameSync(`${legacy}-wal`, `${next}-wal`);   // where a killed run left it
      const refused = () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); };
      const used = adopt(next, legacy, { rename: refused });
      check(used.code === "STORE_SPLIT" && (used.threw ?? "").includes(`${next}-wal`),
        "a move that can't run is refused while an earlier run left part of the store at the new path, not answered with the legacy path",
        JSON.stringify(used));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  {
    const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
    try {
      const { legacy, next } = legacyStore(home);
      renameSync(`${legacy}-wal`, `${next}-wal`);
      mkdirSync(`${next}.move-lock`);   // so the move can't start
      const json = reeve(home, ["status", NWO, "--json"]);
      let doc = null; try { doc = JSON.parse(json.out); } catch { /* stays null */ }
      const prose = reeve(home, ["status", NWO]);
      check(json.code === 1 && doc?.ok === false && doc?.kind === "store_unusable" && doc?.retryable === false && /split/.test(doc?.message ?? "")
        && prose.code === 1 && /reeve status: .*split/.test(prose.err) && !/^\s+at /m.test(prose.err),
        "a command given a store it can't use refuses it with a reason, not a stack trace",
        JSON.stringify({ json: json.code, doc, prose: prose.err.slice(0, 400) }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}

// ── two inits at once, and a state folder that can't be made ─────────────────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    const path = statePathFor(home, NWO);
    // While this init builds its store, another publishes one first.
    const made = ensure(home, { openStore: (p) => { const db = new DatabaseSync(p); writeFileSync(path, "the other init's store"); return db; } });
    check(!made.failed && !made.changed && readFileSync(path, "utf8") === "the other init's store"
      && readdirSync(dirname(path)).every((f) => !f.includes(".init-")),
      "an init that loses to another publishes nothing over the store it made, and cleans up", JSON.stringify({ made, left: readdirSync(dirname(path)) }));
  } finally { rmSync(home, { recursive: true, force: true }); }
}
{
  const home = mkdtempSync(join(tmpdir(), "reeve-store-"));
  try {
    writeFileSync(join(home, "state"), "a file where the state folder belongs\n");
    const made = ensure(home);
    check(made.failed === true && /could not create the state database/.test(made.line ?? "") && !made.threw,
      "a state folder that can't be made is a failure that says why, not a crash", JSON.stringify(made));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
