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

/**
 * Rebuild `table` with its DDL transformed, preserving its indexes.
 *
 * The shape a hand-repaired or partially-restored store actually arrives in.
 * BOTH the transform and its effect are asserted: a `replace` whose anchor
 * missed writes nothing and raises nothing, and the fixture would then rebuild
 * the table unchanged -- reporting no defect, which reads as the CHECK failing
 * when it is the FIXTURE that failed.
 */
const rebuild = (db, table, transform) => {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
                .get(table).sql;
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
                .all(table).map(r => r.sql);
  const changed = transform(ddl);
  if (changed === ddl) throw new Error(`fixture: the transform of ${table} changed nothing`);
  const named = changed.replace(new RegExp(`CREATE TABLE (IF NOT EXISTS )?"?${table}"?`), `CREATE TABLE ${table}_new`);
  if (!named.includes(`${table}_new`)) throw new Error(`fixture: could not rename ${table} in its DDL`);
  db.exec(named);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
  for (const sql of idx) db.exec(sql);
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
  const T = shape.tables;
  const tables  = Object.keys(T).length;
  const columns = Object.values(T).reduce((n, t) => n + Object.keys(t.columns).length, 0);
  const indexes = Object.values(T).reduce((n, t) => n + Object.keys(t.indexes).length, 0);
  const fks     = Object.values(T).reduce((n, t) => n + Object.keys(t.foreignKeys).length, 0);
  const checks  = Object.values(T).reduce((n, t) => n + t.checks.length, 0);
  check(tables > 0 && columns > 0 && indexes > 0 && fks > 0 && checks > 0,
    "control: the derived requirement examines tables, columns, indexes, foreign keys AND checks",
    `tables=${tables} columns=${columns} indexes=${indexes} foreignKeys=${fks} checks=${checks}`);
  // Triggers are compared too, and this hub declares NONE -- which makes the
  // set-comparison meaningful rather than vacuous: any trigger at all is
  // unexpected, and that is asserted by fixture below rather than assumed here.
  check(Object.keys(shape.triggers).length === 0,
    "control: the schema declares no triggers, so any trigger in a snapshot is unexpected",
    JSON.stringify(Object.keys(shape.triggers)));
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

// ── class 6: a LOST COLUMN DEFAULT ───────────────────────────────────────────
//
// `task.priority` is `NOT NULL DEFAULT 'p2'` and callers omit it. A snapshot
// that lost the default keeps every existing row valid and passes a deep
// integrity check, then fails the first ordinary insert with a NOT NULL
// violation -- after being certified as restorable.
{
  const d = damaged("no-default", (db) =>
    rebuild(db, "task", (ddl) => ddl.replace(" DEFAULT 'p2'", "")));
  check(d.some(s => s === "task.priority defaults to nothing, want 'p2'"),
    "a snapshot that LOST a column default is refused, naming the default it wants",
    d.slice(0, 3).join("; "));
}

// ── class 7: a CHANGED PARTIAL-INDEX PREDICATE ───────────────────────────────
//
// `one_live_run` is UNIQUE on phase_run(task) WHERE status IN ('live','adopted').
// Recreated with a different WHERE it keeps its name AND its uniqueness flag,
// so a comparison of those two alone sees nothing -- while the single-live-run
// invariant it exists to enforce is simply gone.
{
  const d = damaged("wrong-predicate", (db) => {
    db.exec("DROP INDEX one_live_run");
    db.exec("CREATE UNIQUE INDEX one_live_run ON phase_run(task) WHERE status = 'never'");
  });
  check(d.some(s => s.startsWith("index one_live_run on phase_run is filtered by status = 'never'")),
    "an index whose PREDICATE changed is refused, though its name and uniqueness are intact",
    d.slice(0, 3).join("; "));
}

// ── class 8: a TIGHTENED NULLABLE COLUMN ─────────────────────────────────────
//
// Not an extra: it REFUSES writes the code performs. `task.body` is bound as
// `filing.body ?? null`, so a column tightened to NOT NULL breaks ordinary task
// filing after the snapshot is restored.
{
  const d = damaged("tightened", (db) =>
    rebuild(db, "task", (ddl) => ddl.replace("body           TEXT,", "body           TEXT NOT NULL,")));
  check(d.some(s => s === "task.body is NOT NULL, want nullable"),
    "a snapshot that made a nullable column NOT NULL is refused",
    d.slice(0, 3).join("; "));
}

// ── class 9: an EXTRA FOREIGN KEY ────────────────────────────────────────────
//
// THE ONE PLACE "extra is harmless" DOES NOT HOLD, and it is worth being exact
// about why. An extra column carries data nobody reads. An extra CONSTRAINT
// rejects writes the code performs -- and it does so only once a row exists, so
// `foreign_key_check` over an empty table reports nothing wrong and the
// scheduler's first ordinary insert fails after restore.
{
  const d = damaged("extra-fk", (db) => {
    db.exec("CREATE TABLE reserved_ref (id INTEGER PRIMARY KEY) STRICT");
    rebuild(db, "provider_state", (ddl) =>
      ddl.replace("guardian_reserved INTEGER NOT NULL,",
                  "guardian_reserved INTEGER NOT NULL REFERENCES reserved_ref(id),"));
  });
  check(d.some(s => s.includes("is not in this schema and can refuse writes")),
    "a snapshot carrying an EXTRA foreign key is refused, unlike an extra column",
    d.slice(0, 3).join("; "));
}

// ── class 10: WITHOUT ROWID DROPPED ──────────────────────────────────────────
//
// Invisible to every other check: same columns, same indexes, same constraints.
// Only the storage changes, from a primary-key table to a rowid table plus a
// separate PK index, against a schema that states the invariant deliberately.
{
  const d = damaged("rowid", (db) =>
    rebuild(db, "task_territory", (ddl) => ddl.replace(") STRICT, WITHOUT ROWID", ") STRICT")));
  check(d.some(s => s === "table task_territory is a rowid table, want WITHOUT ROWID"),
    "a WITHOUT ROWID table rebuilt as a rowid table is refused",
    d.slice(0, 3).join("; "));
}

// ── class 11: a TIGHTENED CHECK ──────────────────────────────────────────────
//
// SQLite has no structural pragma for CHECK, so it is the one property read out
// of the DDL -- narrowly, as the balanced group after each CHECK keyword.
// Narrowing `task.priority` to `'p1'` leaves every existing row valid, passes
// the deep integrity check on an empty hub, and then refuses the ordinary insert
// that relies on the `'p2'` default.
{
  const d = damaged("tight-check", (db) =>
    rebuild(db, "task", (ddl) => ddl.replace("priority IN ('p1','p2')", "priority IN ('p1')")));
  check(d.some(s => s.includes("adds CHECK (priority IN ('p1'))")),
    "a snapshot that TIGHTENED a CHECK is refused, naming the constraint it added",
    d.slice(0, 3).join("; "));
}

// ── class 12: an EXTRA UNIQUE INDEX ──────────────────────────────────────────
//
// Worse than failing immediately: it lets the FIRST write through and refuses
// the second, so the damage surfaces long after the restore that caused it.
// An extra NON-unique index stays permitted -- it costs write time, not writes.
{
  const d = damaged("extra-unique", (db) =>
    db.exec("CREATE UNIQUE INDEX surprise_unique ON task(project)"));
  check(d.some(s => s.startsWith("unique index surprise_unique on task(project BINARY) is not in this schema")),
    "an EXTRA unique index is refused, because it rejects writes this schema permits",
    d.slice(0, 3).join("; "));

  const harmless = damaged("extra-plain-index", (db) =>
    db.exec("CREATE INDEX surprise_plain ON task(project)"));
  check(harmless.length === 0,
    "control: an extra NON-unique index is still permitted, so the rule is about refusal not novelty",
    harmless.slice(0, 3).join("; "));
}

// ── class 13: an UNEXPECTED TRIGGER ──────────────────────────────────────────
//
// Identical tables, columns, indexes and constraints. A deep integrity check
// sees nothing. The first ordinary task filing is refused outright.
{
  const d = damaged("trigger", (db) =>
    db.exec("CREATE TRIGGER reject_tasks BEFORE INSERT ON task " +
            "BEGIN SELECT RAISE(ABORT, 'blocked'); END"));
  check(d.some(s => s.startsWith("trigger reject_tasks on task is not in this schema")),
    "an unexpected TRIGGER is refused, though every table and column is intact",
    d.slice(0, 3).join("; "));
}

// ── class 14: an EXTRA NOT NULL COLUMN WITH NO DEFAULT ───────────────────────
//
// The precise boundary of "extra is harmless". Every insert this code performs
// omits a column the schema does not know about, so a NOT NULL column with no
// default refuses all of them -- while the same column nullable, or defaulted,
// is genuinely harmless. Both halves are asserted, because a rule that refused
// every extra column would be the opposite mistake.
{
  const d = damaged("extra-notnull", (db) =>
    db.exec("ALTER TABLE task ADD COLUMN required_by_future TEXT NOT NULL DEFAULT 'x'"));
  check(d.length === 0,
    "control: an extra NOT NULL column WITH a default is harmless, because inserts may omit it",
    d.slice(0, 3).join("; "));

  const e = damaged("extra-notnull-bare", (db) => {
    // SQLite refuses ALTER ADD of a bare NOT NULL column, which is exactly the
    // shape a rebuilt or hand-repaired store arrives in -- so it is rebuilt.
    rebuild(db, "task", (ddl) =>
      ddl.replace("  body           TEXT,", "  body           TEXT,\n  required_by_future TEXT NOT NULL,"));
  });
  check(e.some(s => s.startsWith("task.required_by_future is not in this schema and is NOT NULL with no default")),
    "an extra NOT NULL column with NO default is refused, because every insert omits it",
    e.slice(0, 3).join("; "));
}

// ── class 15: a GENERATED column ─────────────────────────────────────────────
//
// `pragma_table_info` omits generated columns entirely, so a snapshot could
// carry one that refuses ordinary inserts while reading as having no extra
// columns at all -- invisible to the extra-column rule AND to the text
// backstop's exemption for it. Read through `table_xinfo` now.
{
  const d = damaged("generated", (db) =>
    db.exec("ALTER TABLE provider_state ADD COLUMN surprise INTEGER " +
            "GENERATED ALWAYS AS (CASE WHEN guardian_reserved = 1 THEN NULL ELSE 1 END) VIRTUAL NOT NULL"));
  check(d.length > 0,
    "a snapshot carrying a GENERATED NOT NULL column is refused, though table_info cannot see it",
    d.slice(0, 3).join("; "));
  check(d.some(s => s.includes("surprise")),
    "and the offending column is NAMED", d.slice(0, 3).join("; "));
}

// ── class 16: an index key's COLLATION ───────────────────────────────────────
//
// `pragma_index_info` discards collation. `task_idem` recreated as
// `(idempotency_key COLLATE NOCASE)` keeps its name, its column, its uniqueness
// and its predicate, and silently imposes stricter uniqueness: two keys
// differing only by case stop being distinct, and the second insert fails.
{
  const d = damaged("collation", (db) => {
    db.exec("DROP INDEX task_idem");
    db.exec("CREATE UNIQUE INDEX task_idem ON task(idempotency_key COLLATE NOCASE) " +
            "WHERE idempotency_key IS NOT NULL");
  });
  check(d.length > 0,
    "an index whose key COLLATION changed is refused, though name, column, uniqueness and predicate match",
    d.slice(0, 3).join("; "));
  check(d.some(s => s.includes("task_idem")), "and the index is NAMED", d.slice(0, 3).join("; "));
}

// ── class 17: a CHECK containing a parenthesis inside a STRING ───────────────
//
// The scanner counted every parenthesis as syntax, so `'(('` left its depth
// counter positive through the table's closing parenthesis. The constraint was
// dropped, and dropping it made the REMAINING checks compare equal -- the
// scanner's own failure reading as agreement, which is the worst way for an
// instrument to fail.
{
  const d = damaged("check-in-string", (db) =>
    rebuild(db, "task", (ddl) =>
      ddl.replace("  UNIQUE (source_kind, source_key)",
                  "  CHECK (priority = 'p1' OR title = '(('),\n  UNIQUE (source_kind, source_key)")));
  check(d.length > 0,
    "a CHECK containing a parenthesis inside a string literal is still SEEN, not skipped",
    d.slice(0, 3).join("; "));
  check(d.some(s => s.includes("adds CHECK")),
    "and it is reported as an added constraint", d.slice(0, 3).join("; "));
}

// ── class 18: a constraint's ON CONFLICT policy ──────────────────────────────
//
// No pragma exposes it. Every column, index, foreign key, CHECK and table
// property stays identical, so only the text backstop catches this -- which is
// the case the backstop exists for. A plain insert then REPLACES an existing
// task sharing a source identity, deleting an authority-bearing row and its
// dependent state rather than refusing the duplicate.
{
  const d = damaged("on-conflict", (db) =>
    rebuild(db, "task", (ddl) =>
      ddl.replace("UNIQUE (source_kind, source_key)",
                  "UNIQUE (source_kind, source_key) ON CONFLICT REPLACE")));
  check(d.length > 0,
    "a changed ON CONFLICT policy is refused, though no pragma reports it",
    d.slice(0, 3).join("; "));
  check(d.some(s => s.includes("definition differs")),
    "and the backstop is what names it, since the property checks cannot",
    d.slice(0, 3).join("; "));
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
  // AND THE STRUCTURAL PROPERTIES STILL AGREE. This is why the property checks
  // are the ones that NAME a defect: they are immune to how the DDL was
  // written, so their messages can be trusted.
  const structural = (d) => {
    const t = shapeOf(d).tables.t;
    return JSON.stringify({ columns: t.columns, indexes: t.indexes, checks: t.checks,
                            strict: t.strict, withoutRowid: t.withoutRowid,
                            foreignKeys: t.foreignKeys });
  };
  check(structural(alter) === structural(fresh),
    "yet every structural property of the two is identical, which is why those checks name the defects");

  // THE TEXT BACKSTOP IS A DIFFERENT INSTRUMENT WITH A DIFFERENT PRECONDITION.
  // It is complete -- it catches what no pragma exposes -- and it is sound only
  // between stores built from the SAME migration source, which is the case it
  // is applied to. Two hand-written spellings are exactly the case it would get
  // wrong, so the limit is asserted here rather than assumed.
  check(shapeOf(alter).tables.t.ddl !== shapeOf(fresh).tables.t.ddl,
    "while their DDL differs, so the text backstop is sound only between stores built the same way");
  alter.close(); fresh.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
