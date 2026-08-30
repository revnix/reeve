// The guardian's hub connection answers THREE ways, and the difference between
// them is what decides whether model work runs scheduled.
//
// This file exists because the logic lived in `bin/reeve`, where the only
// assertions available were structural -- and a stub loop proved what that was
// worth: disabling the schema gate with `if (false && ...)` left the source text
// intact and every assertion green. The property was asserted and untested at
// the same time. It is exercised here instead.
import { hubAccess } from "../src/build/hubaccess.mjs";
import { openHub, SCHEDULER_MIN_HUB_VERSION, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
import { SCHEDULER_COLUMNS, LEASE_COLS } from "../src/build/providerdb.mjs";
import { HOLD_COLUMNS } from "../src/build/holds.mjs";
import { LOCK_COLUMNS } from "../src/build/locks.mjs";
import { mkdtempSync, rmSync, writeFileSync, renameSync, copyFileSync, chmodSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-hubaccess-"));

// ── absent is an ORDINARY state ───────────────────────────────────────────
// A guardian can run on a machine with no builder. That must not read as a
// fault, or every such machine escalates for ever.
{
  const a = hubAccess(join(dir, "nope.db"))();
  check(a.hub === null && a.why === null,
    "an absent hub is no hub and no complaint", JSON.stringify(a));
}

// ── a healthy hub opens, and opens RESTRICTED ─────────────────────────────
{
  const p = join(dir, "good.db");
  openHub(p).close();
  const get = hubAccess(p);
  const a = get();
  check(a.hub != null && a.why === null, "a current hub opens", JSON.stringify({ why: a.why }));
  // It is the GUEST: the allowlist refuses the builder's work table.
  let why = null;
  try { a.hub.prepare("SELECT 1 FROM task"); } catch (err) { why = err.message; }
  check(why != null && /not authorized|prohibited|not permitted/i.test(why),
    "and it is the restricted connection, not a privileged one", String(why));
  // The same handle comes back while the file is unchanged, or every call would
  // pay a reopen.
  check(get().hub === a.hub, "the handle is reused while the file is unchanged");
  a.hub.close();
}

// ── a hub BELOW the scheduler's floor is refused, WITH a reason ───────────
// Every claim names `provider_lease.token`, which arrives with migration 3. On
// an older hub each claim throws, and the guardian's fail-open path then runs
// model work outside the shared limit -- beside an older builder still using its
// own. Passing this off as an absent hub is the dangerous answer.
{
  const p = join(dir, "old.db");
  openHub(p).close();
  // Wind the recorded version back: the tables are current, the STATED version
  // is not, which is exactly the shape a newer guardian meets beside an older
  // builder.
  const w = new DatabaseSync(p);
  w.exec(`DELETE FROM schema_version WHERE version >= ${SCHEDULER_MIN_HUB_VERSION}`);
  w.close();
  const a = hubAccess(p)();
  check(a.hub === null, "a hub below the scheduler's floor does NOT open for dispatch", JSON.stringify(a));
  check(typeof a.why === "string" && a.why.length > 0,
    "and it says so rather than passing as absent — silence here is unscheduled work", JSON.stringify(a));
  check(/schema version/.test(a.why ?? "") && new RegExp(String(SCHEDULER_MIN_HUB_VERSION)).test(a.why ?? ""),
    "naming the version it found and the one it needs", String(a.why));

  // CONTROL: the same file at the current version DOES open, or this check has
  // become "refuse everything" and no guardian could ever schedule.
  const q = join(dir, "old-control.db");
  openHub(q).close();
  check(hubAccess(q)().hub != null, "control: the same store at the current version still opens");
}

// ── a hub NEWER than this binary is refused too ───────────────────────────
// `openHub` refuses a forward schema in three places: migrations are
// forward-only and a store a newer binary migrated is one this one cannot
// reason about. The guest had only a floor, so a newer builder migrating the
// shared hub left this guardian issuing scheduler mutations against a layout it
// does not know -- and the moment a future migration changes those statements
// they throw, which takes the fail-open path and dispatches outside the limit.
{
  const p = join(dir, "future.db");
  openHub(p).close();
  const w = new DatabaseSync(p);
  w.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${HUB_SCHEMA_VERSION + 1}, unixepoch())`);
  w.close();
  const a = hubAccess(p)();
  check(a.hub === null, "a hub newer than this binary does NOT open for dispatch", JSON.stringify(a));
  check(/forward-only|newer binary/.test(a.why ?? ""),
    "and says the schema is ahead of this binary", String(a.why));
  // CONTROL: one version lower is the current schema and still opens, so the
  // bound is an upper bound and not an off-by-one that refuses everything.
  const q = join(dir, "future-control.db");
  openHub(q).close();
  check(hubAccess(q)().hub != null, "control: the current version still opens");
}

// ── a version is a CLAIM; the columns are the evidence ────────────────────
// A store can record the current version and have lost `provider_lease.token`.
// The version gate accepts it, the guest opens, and the first claim throws --
// and a throwing scheduler dispatches UNSCHEDULED. Same lesson snapshot
// validation's schema check was written for: a version-only probe cannot see a
// column that is absent, just as a name-only inventory could not see one that
// was wrong.
{
  const p = join(dir, "hollow.db");
  openHub(p).close();
  const w = new DatabaseSync(p);
  w.exec("ALTER TABLE provider_lease DROP COLUMN token");
  w.close();
  const a = hubAccess(p)();
  check(a.hub === null,
    "a hub whose version is current but whose scheduler column is gone does NOT open", JSON.stringify(a));
  check(/token/.test(a.why ?? ""),
    "and the refusal names the column that is missing", String(a.why));

  // CONTROL: the same store with the column intact opens, so this is a shape
  // check and not "refuse everything with a provider_lease".
  const q = join(dir, "hollow-control.db");
  openHub(q).close();
  check(hubAccess(q)().hub != null, "control: an intact store at the same version still opens");
}

// ── the GUARDIAN's surface, not the whole hub and not only the last migration
// Too narrow and too wide were the same mistake. The column inventory described
// only what later migrations ADD, so a hub missing a migration-1 column passed
// and the first claim threw into the fail-open path. The table inventory was the
// whole hub, so losing an unrelated builder table reported the SCHEDULER
// unusable and an ordinary pull request was dispatched unscheduled. The surface
// is the guest connection's own allowlist.
//
// (Snapshot validation has since stopped declaring either list and derives the
// shape by running the migrations, which removes the ADD-only horizon there.
// This surface stays narrow deliberately: it is a different question.)
{
  // A table the guardian needs.
  const a = join(dir, "notable.db");
  openHub(a).close();
  const wa = new DatabaseSync(a); wa.exec("DROP TABLE provider_state"); wa.close();
  const ra = hubAccess(a)();
  check(ra.hub === null && /provider_state/.test(ra.why ?? ""),
    "a hub that has lost a scheduler TABLE does not open, and the refusal names it", JSON.stringify(ra));

  // A BASELINE column, created in migration 1 -- the case the old column
  // inventory could not see, because it only described what later migrations
  // added.
  const b = join(dir, "nocol.db");
  openHub(b).close();
  const wb = new DatabaseSync(b); wb.exec("ALTER TABLE provider_state DROP COLUMN cooldown_until"); wb.close();
  const rb = hubAccess(b)();
  check(rb.hub === null && /cooldown_until/.test(rb.why ?? ""),
    "nor one that has lost a column the scheduler reads, whatever migration made it",
    JSON.stringify(rb));

  // AND THE OTHER DIRECTION. A builder projection the guardian never touches is
  // none of its business: refusing here dispatches ordinary pull requests
  // unscheduled over a table that has no bearing on the quota.
  const c = join(dir, "unrelated.db");
  openHub(c).close();
  const wc = new DatabaseSync(c); wc.exec("PRAGMA foreign_keys=OFF"); wc.exec("DROP TABLE approval"); wc.close();
  const rc = hubAccess(c)();
  check(rc.hub != null,
    "but a builder table outside the guardian's surface does NOT stop it scheduling",
    JSON.stringify({ why: rc.why }));
  rc.hub?.close?.();

  // CONTROL: an intact store still opens, so none of the above has become
  // "refuse everything".
  const d = join(dir, "surface-control.db");
  openHub(d).close();
  const rd = hubAccess(d)();
  check(rd.hub != null, "control: an intact store at the same version still opens");
  rd.hub?.close?.();
}

// ── the MAINTENANCE LOCK is part of the guardian's surface too ────────────
// Every provider mutation calls `assertWritable`, which reads `name`, `pid` and
// `lstart`. A hub missing `name` makes every claim throw into the unscheduled
// fail-open path. Missing `pid` or `lstart` is quieter and worse:
// `isAlive(undefined, undefined)` answers false, so a LIVE restore's lock reads
// as dead and is reaped, and a mutation proceeds against a hub being replaced
// underneath it.
{
  // REBUILT WITHOUT THE COLUMN rather than altered: `name` is the primary key
  // and SQLite refuses to drop it, and a table that exists in the wrong shape is
  // the case being modelled anyway.
  const without = {
    name:   "CREATE TABLE maintenance_lock (pid INTEGER, lstart TEXT)",
    pid:    "CREATE TABLE maintenance_lock (name TEXT PRIMARY KEY, lstart TEXT)",
    lstart: "CREATE TABLE maintenance_lock (name TEXT PRIMARY KEY, pid INTEGER)",
  };
  for (const [col, ddl] of Object.entries(without)) {
    const p = join(dir, `lock-${col}.db`);
    openHub(p).close();
    const w = new DatabaseSync(p);
    w.exec("DROP TABLE maintenance_lock");
    w.exec(ddl);
    w.close();
    const a = hubAccess(p)();
    check(a.hub === null && new RegExp(col).test(a.why ?? ""),
      `a hub missing maintenance_lock.${col} does not open, and the refusal names it`,
      JSON.stringify(a));
  }
  // CONTROL: intact, and it opens.
  const ok = join(dir, "lock-control.db");
  openHub(ok).close();
  const r = hubAccess(ok)();
  check(r.hub != null, "control: an intact lock table still opens");
  r.hub?.close?.();
}

// ── a column of the WRONG TYPE is unusable, not usable ────────────────────
// The gate reduced `pragma_table_info` to names. Every one of these tables is
// STRICT, so a column whose declared type is wrong passes a name comparison and
// then refuses the write: measured against node:sqlite, an insert of the
// generated text token into `provider_lease.token INTEGER` throws "cannot store
// TEXT value in INTEGER column", with a control on the correct schema accepting
// the identical statement. The guardian then took its documented fail-open route
// and dispatched model work outside the shared limit — reaching the fail-open by
// PASSING the gate, which is the worst way to arrive there.
{
  const p = join(dir, "mistyped.db");
  openHub(p).close();
  // Rebuild `provider_lease` with one column's type changed and nothing else,
  // so the only thing separating this hub from a healthy one is the type.
  const w = new DatabaseSync(p);
  const ddl = w.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get("provider_lease").sql;
  w.exec("PRAGMA foreign_keys=OFF");
  w.exec("DROP TABLE provider_lease");
  w.exec(ddl.replace(/token\s+TEXT/, "token INTEGER"));
  w.close();

  const a = hubAccess(p)();
  check(a.hub === null,
    "a hub whose scheduler column has the wrong declared type is REFUSED", JSON.stringify({ why: a.why }));
  check(/provider_lease\.token is INTEGER, want TEXT/.test(a.why ?? ""),
    "and the reason names the column and BOTH types, because it is read at a recovery",
    String(a.why));
}

// ── the declared shape matches a freshly migrated hub ─────────────────────
// These maps are hand-written, so they can drift from the schema in either
// direction: demanding a column that does not exist refuses every healthy hub,
// and omitting one leaves a hole in the gate. Both directions are checked, and
// TYPES are checked too — a name-only comparison was itself the defect, because
// these tables are STRICT and a wrong declared type passes a name check and then
// refuses the write.
{
  const p = join(dir, "drift.db");
  const db = openHub(p);
  const declared = { ...SCHEDULER_COLUMNS, pr_hold: HOLD_COLUMNS, maintenance_lock: LOCK_COLUMNS };
  const missing = [], mistyped = [];
  for (const [t, cols] of Object.entries(declared)) {
    const have = new Map(db.prepare("SELECT name, type FROM pragma_table_info(?)").all(t)
      .map(r => [r.name, String(r.type ?? "").toUpperCase()]));
    for (const [c, want] of Object.entries(cols)) {
      if (!have.has(c)) { missing.push(`${t}.${c}`); continue; }
      if (have.get(c) !== want) mistyped.push(`${t}.${c} declared ${want}, hub has ${have.get(c)}`);
    }
  }
  db.close();
  check(missing.length === 0,
    "every column the scheduler declares it needs exists in a freshly migrated hub", missing.join(", "));
  check(mistyped.length === 0,
    "and every declared TYPE is the type the migrations actually build", mistyped.join(" | "));
  const counts = Object.fromEntries(Object.entries(declared).map(([t, c]) => [t, Object.keys(c).length]));
  check(counts.provider_lease > 5 && counts.provider_state > 3 && counts.pr_hold > 3 && counts.maintenance_lock > 2,
    "fixture: the declarations are non-empty, so the checks above compare something",
    JSON.stringify(counts));
}

// ── the lease shape and the lease SQL name the same columns ───────────────
// `SCHEDULER_COLUMNS.provider_lease` used to be DERIVED from `LEASE_COLS`, which
// made drift impossible but carried no types. Adding types forced the two apart,
// so the derivation is replaced by an asserted AGREEMENT in both directions: a
// column added to the SQL without a type here would otherwise leave exactly the
// silent hole in the gate that this round's finding came through.
{
  const sql = new Set(LEASE_COLS.split(",").map(c => c.trim()).filter(Boolean));
  const shape = new Set(Object.keys(SCHEDULER_COLUMNS.provider_lease));
  const onlySql = [...sql].filter(c => !shape.has(c));
  const onlyShape = [...shape].filter(c => !sql.has(c));
  check(onlySql.length === 0,
    "every column the lease SQL selects is in the declared shape, with a type", onlySql.join(", "));
  check(onlyShape.length === 0,
    "and the declared shape names nothing the lease SQL does not", onlyShape.join(", "));
  check(sql.size > 5, "fixture: LEASE_COLS is non-empty, so the comparison compares something", String(sql.size));
}

// ── an existing hub that cannot be READ is a fault, not an absence ────────
{
  const p = join(dir, "corrupt.db");
  writeFileSync(p, "this is not a sqlite database at all, but it does exist");
  const a = hubAccess(p)();
  check(a.hub === null && typeof a.why === "string",
    "a corrupt hub is refused WITH a reason", JSON.stringify(a));
  check(/could not be read/.test(a.why ?? ""),
    "and the reason says the read failed, not that nothing was there", String(a.why));
}

// ── a restore replaces the file, and the connection follows it ────────────
// `restoreHub` renames a new database over the old path. A handle opened before
// that keeps its descriptor on the UNLINKED inode -- so the guardian would go on
// scheduling in a database nobody else can see while the builder used the new
// one, and both would admit up to the global limit.
{
  const p = join(dir, "restored.db");
  openHub(p).close();
  const get = hubAccess(p);
  const first = get();
  check(first.hub != null, "fixture: the connection is open before the restore");
  // A DIFFERENT inode at the same path, which is what a rename installs.
  const replacement = join(dir, "replacement.db");
  openHub(replacement).close();
  renameSync(replacement, p);
  const second = get();
  check(second.hub != null && second.hub !== first.hub,
    "the connection is REOPENED after the file is replaced, not reused",
    JSON.stringify({ same: second.hub === first.hub, why: second.why }));
  second.hub.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
