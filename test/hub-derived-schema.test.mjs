// Snapshot schema validation is DERIVED from the migrations, and this is where
// that derivation is proved to have teeth.
//
// WHY A DERIVED CHECK NEEDS THIS TEST MORE THAN A DECLARED ONE DID. The lists it
// replaces (`TABLES_AT`, `COLUMNS_AT`) were wrong in a way you could read: the
// declaration was there, and it either named a thing or it did not. A derived
// check has no declaration to read. It is a comparison between two stores, and a
// comparison that examines nothing passes everything -- silently, and over
// exactly the damaged snapshot it exists to refuse.
//
// So each defect class gets a fixture that EXHIBITS it. A derived check that
// passes on all of them proves nothing at all, which is the issue's own words
// and the reason this file is not just a control and a happy path.

import { openHub, HUB_SCHEMA_VERSION, shapeAt, shapeOf, schemaDefectsAt, tablesAt }
  from "../src/build/hubdb.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-derived-"));
const pristine = join(dir, "pristine.db");
openHub(pristine).close();

/** A fresh copy of an intact current hub, damaged by `damage`, then examined. */
const damaged = (name, damage) => {
  const p = join(dir, `${name}.db`);
  copyFileSync(pristine, p);
  const db = new DatabaseSync(p);
  db.exec("PRAGMA foreign_keys = OFF");   // damaging is not a migration
  damage(db);
  db.close();
  const probe = new DatabaseSync(p, { readOnly: true });
  try { return schemaDefectsAt(probe, HUB_SCHEMA_VERSION); } finally { probe.close(); }
};

// ── THE CONTROL COMES FIRST ──────────────────────────────────────────────────
//
// An intact store must produce NO defects. Without this every assertion below is
// satisfied by a check that reports damage unconditionally, which would refuse
// every healthy snapshot and make the hub unrecoverable -- worse than the gap
// being closed.
{
  const probe = new DatabaseSync(pristine, { readOnly: true });
  const clean = schemaDefectsAt(probe, HUB_SCHEMA_VERSION);
  probe.close();
  check(clean.length === 0,
    "control: an intact hub at the current version has NO schema defects",
    clean.slice(0, 5).join("; "));

  // AND THE COMPARISON IS NOT EMPTY. A check that examines nothing also reports
  // no defects, and is indistinguishable from the line above. So: the derived
  // requirement has to actually contain tables, columns, indexes and foreign
  // keys, or "no defects" means "nothing was looked at".
  const shape = shapeAt(HUB_SCHEMA_VERSION);
  const tables  = Object.keys(shape).length;
  const columns = Object.values(shape).reduce((n, t) => n + Object.keys(t.columns).length, 0);
  const indexes = Object.values(shape).reduce((n, t) => n + Object.keys(t.indexes).length, 0);
  const fks     = Object.values(shape).reduce((n, t) => n + Object.keys(t.foreignKeys).length, 0);
  check(tables > 0 && columns > 0 && indexes > 0 && fks > 0,
    "control: the derived requirement examines tables, columns, indexes AND foreign keys",
    `tables=${tables} columns=${columns} indexes=${indexes} foreignKeys=${fks}`);
  check(tablesAt(HUB_SCHEMA_VERSION).length === tables,
    "control: and the table list agrees with the shape it is derived from");
}

// ── class 1: a MISSING TABLE ─────────────────────────────────────────────────
{
  const d = damaged("no-table", (db) => db.exec("DROP TABLE approval"));
  check(d.some(s => s === "table approval is missing"),
    "a snapshot missing a table is refused, and the table is NAMED", d.slice(0, 3).join("; "));
}

// ── class 2: a MISSING COLUMN ────────────────────────────────────────────────
//
// The case migration 3 made possible: it adds no tables, so a snapshot recording
// version 3 without its columns satisfies every table-name check ever written.
{
  const d = damaged("no-column", (db) =>
    db.exec("ALTER TABLE task_territory DROP COLUMN pinned_until"));
  check(d.some(s => s === "task_territory.pinned_until is missing"),
    "a snapshot missing a column is refused, and the column is NAMED", d.slice(0, 3).join("; "));
}

// ── class 3: a WRONG-TYPED COLUMN ────────────────────────────────────────────
//
// Present, so it passes any presence check; and every hub table is STRICT, so it
// does not coerce -- the first write refuses with `cannot store TEXT value in
// INTEGER column`, after the snapshot was chosen for recovery.
{
  const d = damaged("wrong-type", (db) => {
    db.exec("ALTER TABLE provider_lease DROP COLUMN token");
    db.exec("ALTER TABLE provider_lease ADD COLUMN token INTEGER");
  });
  check(d.some(s => s === "provider_lease.token is INTEGER, want TEXT"),
    "a wrong-typed column is refused, naming BOTH the type it has and the type it needs",
    d.slice(0, 3).join("; "));
}

// ── class 2b: a column created in MIGRATION 1 ────────────────────────────────
//
// THE CASE THE OLD LISTS COULD NOT SEE, and it is not hypothetical: a hub
// missing `provider_state.cooldown_until` -- created in migration 1 -- passed
// snapshot validation, because `COLUMNS_AT` described only what LATER migrations
// add. `claimProvider` then threw into the guardian's fail-open path.
//
// A derived shape has no such horizon: it is the whole store at that version, so
// a baseline column is required exactly like a migration-3 one.
{
  const d = damaged("no-baseline-column", (db) =>
    db.exec("ALTER TABLE provider_state DROP COLUMN cooldown_until"));
  check(d.some(s => s === "provider_state.cooldown_until is missing"),
    "a column created in MIGRATION 1 is required too, which no ADD-only inventory could express",
    d.slice(0, 3).join("; "));
}

// ── class 4: a MISSING INDEX ─────────────────────────────────────────────────
//
// The class no inventory here could EVER describe: neither list carried indexes
// at all, so a migration adding one was invisible to snapshot validation from
// the day it landed.
{
  const d = damaged("no-index", (db) => db.exec("DROP INDEX approval_task"));
  check(d.some(s => s === "index approval_task on approval is missing"),
    "a snapshot missing an index is refused, and the index is NAMED", d.slice(0, 3).join("; "));
}

// ── class 5: a MISSING FOREIGN KEY ───────────────────────────────────────────
//
// Also invisible to both lists. Rebuilt without the constraint rather than
// dropped, because that is the shape a hand-repaired or partially-restored store
// actually arrives in.
{
  const d = damaged("no-fk", (db) => {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'approval'").get().sql;
    // sqlite_master stores the statement WITHOUT `IF NOT EXISTS`, which is why
    // the name is rewritten by regex rather than by the literal from hub.sql.
    const without = ddl
      .replace(/CREATE TABLE (IF NOT EXISTS )?"?approval"?/, "CREATE TABLE approval_nofk")
      .replace(" REFERENCES task(id) ON DELETE CASCADE", "");
    // BOTH REWRITES ASSERTED. A text patch whose anchor missed writes nothing
    // and raises nothing, and this fixture would then rebuild the table WITH its
    // foreign key -- reporting no defect, which reads as the check failing when
    // it is the fixture that failed.
    if (!/CREATE TABLE approval_nofk/.test(without))
      throw new Error("fixture: the table-name rewrite did not match the stored DDL");
    if (/REFERENCES task\(id\)/.test(without))
      throw new Error("fixture: the foreign-key removal did not match the stored DDL");
    db.exec(without);
    db.exec("DROP TABLE approval");
    db.exec("ALTER TABLE approval_nofk RENAME TO approval");
  });
  check(d.some(s => s.startsWith("foreign key approval.task->task.id is missing")),
    "a snapshot whose table lost a foreign key is refused, and the key is NAMED",
    d.slice(0, 3).join("; "));
}

// ── each fixture really is a DIFFERENT store ─────────────────────────────────
//
// Every damage above is applied to a fresh copy, so a fixture that silently
// failed to apply would report the pristine store's zero defects and read as a
// green control rather than as a broken fixture. Each class asserted a SPECIFIC
// string, which is what stops that -- but the pristine store is asserted clean
// once more here, after all the damage, to prove the copies were copies.
{
  const probe = new DatabaseSync(pristine, { readOnly: true });
  const clean = schemaDefectsAt(probe, HUB_SCHEMA_VERSION);
  probe.close();
  check(clean.length === 0,
    "control: the pristine store is STILL clean after every fixture ran, so the copies were copies",
    clean.slice(0, 3).join("; "));
}

// ── extra is not a defect ────────────────────────────────────────────────────
//
// One-directional deliberately. A snapshot taken by a NEWER binary carries more
// than this version requires; refusing it would turn a restorable snapshot into
// an unrecoverable one at the moment it is needed.
{
  const d = damaged("extra", (db) => {
    db.exec("CREATE TABLE a_future_table (x TEXT) STRICT");
    db.exec("ALTER TABLE task_territory ADD COLUMN a_future_column TEXT");
  });
  check(d.length === 0,
    "a snapshot carrying EXTRA tables and columns is still usable at this version",
    d.slice(0, 3).join("; "));
}

// ── the shape is read structurally, not as DDL text ──────────────────────────
//
// The issue named `ALTER TABLE ADD COLUMN` as the reason a text comparison
// fails. Measured here rather than inherited: on this SQLite an altered table
// and a freshly created one produce IDENTICAL DDL, so that is not the reason.
// The divergence that does occur is authoring format, and this asserts the
// reader is immune to it either way.
{
  const alter = new DatabaseSync(":memory:");
  alter.exec("CREATE TABLE t (a TEXT) STRICT");
  alter.exec("ALTER TABLE t ADD COLUMN b INTEGER");
  const fresh = new DatabaseSync(":memory:");
  fresh.exec("CREATE TABLE t (\n  a TEXT,\n  b INTEGER\n) STRICT");

  const sqlOf = (d) => d.prepare("SELECT sql FROM sqlite_master WHERE name = 't'").get().sql;
  check(sqlOf(alter).replace(/\s+/g, " ") !== sqlOf(fresh).replace(/\s+/g, " "),
    "control: the same logical table written two ways really does store different DDL text",
    `${JSON.stringify(sqlOf(alter))} vs ${JSON.stringify(sqlOf(fresh))}`);
  check(JSON.stringify(shapeOf(alter)) === JSON.stringify(shapeOf(fresh)),
    "yet the STRUCTURAL shape of the two is identical, which is why the text is not compared");
  alter.close(); fresh.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
