// hubdb -- the builder's store, and every statement that touches it.
//
// The guardian repairs its own schema at open(): CREATE TABLE IF NOT EXISTS,
// plus an ADDED_COLUMNS list, plus a RESHAPED list for tables that changed key.
// That grew out of a real failure (settlement.accounting never appeared on the
// live store) and it works for a store whose worst case is a re-poll.
//
// The hub is not that. It records who approved what, at which SHA, under which
// generation, and which merges were allowed. A column that silently fails to
// appear here is an authority question answered from absence. So the hub is
// versioned instead: a numbered, forward-only list, each step in its own
// transaction, and a store recorded above this binary's version does not open.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { canonical } from "../db/ops.mjs";
// `migrationPlan` hashes each migration's `up` so the freeze test has a stable,
// INERT representation of what migration 1 is. Exporting MIGRATIONS itself would
// hand callers runnable `up` functions.
import { createHash } from "node:crypto";

// ONE module-level schema URL. Both `openHub`'s migration 1 and `HUB_TABLES`
// read it; two spellings of the same path is how they drift.
const SCHEMA_PATH = new URL("./hub.sql", import.meta.url);

export const HUB_SCHEMA_VERSION = 1;

/**
 * Forward-only. Each entry runs exactly once, in order, in its own transaction,
 * and records itself. Never edit a merged entry -- add the next number.
 */
const MIGRATIONS = [
  { version: 1, up: (db) => db.exec(readFileSync(SCHEMA_PATH, "utf8")) },
];

/**
 * The highest COMPLETED migration for a hub, or 0.
 *
 * `openHub` commits `schema_version` as plain DDL BEFORE migration 1's
 * transaction, so an interrupted first run leaves a file that opens, answers
 * the version query with 0, and has none of the 31 tables. Existence is not
 * readiness, and neither is openability.
 *
 * This has now been the shape of FIVE findings -- `build run`, `restoreHub`,
 * `build status`, `builder doctor` and `export-events` -- because each site
 * asked the question for itself and the sweep matched where the pattern was
 * remembered rather than everywhere the invariant holds. There is one reader
 * now. Absent, unreadable, and interrupted all answer 0: none of them has a
 * completed migration, and `openHub` gives a far better account of a corrupt
 * store than `no such table: singleton_lease` does.
 */
export function completedVersion(path) {
  if (!existsSync(path)) return 0;
  try {
    const q = new DatabaseSync(path, { readOnly: true });
    // COALESCE, because `schema_version` existing and being EMPTY is the
    // interrupted case this predicate was added for.
    try { return q.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get().v; }
    finally { q.close(); }
  } catch { return 0; }
}

/**
 * Is this SQLite failure the FILE's fault, or the situation's?
 *
 * Three catches asked this question and two answered it differently -- one
 * split BUSY and READONLY out, two called every failure corruption -- which is
 * the same fact resolved in several places, and it drifted immediately.
 *
 * Only codes that are KNOWN to leave the file intact earn "this is not damage":
 *
 *   errcode 5  SQLITE_BUSY      another connection holds it
 *   errcode 8  SQLITE_READONLY  read-only file or directory
 *   errcode 13 SQLITE_FULL      the filesystem or the page limit ran out
 *
 * The last is a RESOURCE the environment ran out of, not a fault in the file:
 * the write is rolled back whole and every byte already on disk is exactly as
 * SQLite left it. Calling it damage told an operator to restore over a healthy
 * authority database when freeing space was the entire remedy.
 *
 * Everything else is treated as damage, and that direction is deliberate. The
 * "do NOT restore" message is a strong claim; making it only for codes proven
 * benign is the conservative reading. An unknown code answered as operational
 * would tell an operator to leave a corrupt hub alone -- `no such table:
 * maintenance_lock` is errcode 1 and is unambiguously damage. Recovery in the
 * other direction is guarded by `--force` and quarantines what it replaces.
 *
 * All four codes measured against node:sqlite, not read from a table.
 */
/**
 * WHICH failure, in the operator's terms -- three answers, not two.
 *
 * `isOperational` answers a yes/no the recovery text cannot render: "not damage"
 * covers both `someone else holds it or a permission is wrong` and `the disk is
 * full`, and those have opposite remedies. Told to stop other processes and
 * check permissions, an operator on a full filesystem follows advice that cannot
 * work and never hears the one instruction that can.
 *
 * Two facts that look alike are not one fact. The classification is the same;
 * only the sentence differs, so the kind travels and the boolean is derived
 * from it rather than the other way round.
 */
export function faultKind(e) {
  if (e?.errcode === 13) return "full";
  return isOperational(e) ? "operational" : "damage";
}

export function isOperational(e) {
  // NOT A SQLITE STORAGE ERROR AT ALL. Every failure out of SQLite carries an
  // `errcode`; an error without one came from reeve's own code -- `assertWritable`
  // throwing `a restore is in progress` is the case that matters, and routing it
  // through the damage branch told a concurrent `build run` that its lock tables
  // had failed and sent it at another forced restore, when the correct answer is
  // to wait for the one already running.
  if (e?.errcode === undefined) return true;
  // Access and contention: the file is untouched and the situation is what
  // failed. CANTOPEN is the one this list was missing -- a healthy hub the CLI
  // user simply cannot open answers 14, and was being called corruption.
  return e.errcode === 3      // SQLITE_PERM
      || e.errcode === 5      // SQLITE_BUSY
      || e.errcode === 6      // SQLITE_LOCKED
      || e.errcode === 8      // SQLITE_READONLY
      // A FULL DISK IS THE SITUATION, NOT THE FILE. Measured against
      // node:sqlite via `PRAGMA max_page_count`: the insert throws
      // `database or disk is full` with errcode 13, the transaction is rolled
      // back, and the store reads perfectly afterwards. Classified as damage it
      // sent `build run` and `build status` at `restore --hub --force`, which
      // replaces an intact hub and does not free a single byte.
      || e.errcode === 13     // SQLITE_FULL
      || e.errcode === 14;    // SQLITE_CANTOPEN
}

export function openHub(path) {
  // state/ may not exist yet: on a fresh REEVE_HOME no guardian store has
  // created it, and DatabaseSync will not create a missing parent. Without this
  // the very first hub-writing command fails before migration 1 can run.
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 10000 });

  // AN UNREADABLE FILE IS REFUSED HERE, ONCE, FOR EVERY CALLER.
  //
  // Opening a corrupt database SUCCEEDS -- SQLite reads nothing until it is
  // asked to -- so the failure surfaced on the first pragma below, as a raw
  // `file is not a database` with a stack trace naming a line in hubdb.mjs.
  // `build run` and `build status` both died that way, from the two commands an
  // operator reaches for WHEN SOMETHING IS ALREADY WRONG.
  //
  // Guarding each caller is what produced six previous findings of this class,
  // each one declaring it swept. There is one guard, and it is where the damage
  // is first touched rather than in the routes that touch it.
  try {
    // Set before anything else: foreign_keys cannot be changed inside a
    // transaction, and a migration is a transaction.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");   // authority-bearing and low-volume; NORMAL is not inherited
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 10000");
    // AND THE SCHEMA PROBE, inside the same guard. Corruption confined to the
    // `schema_version` PAGE rather than the header lets all four pragmas
    // succeed, so the first version read threw outside this catch and `build
    // run` printed a bare `database disk image is malformed` with none of the
    // recovery this guard exists to give. The guard has to reach as far as the
    // first read that can find damage, not stop at the first write.
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
               version    INTEGER PRIMARY KEY,
               applied_at INTEGER NOT NULL
             ) STRICT`);
    db.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get();
  } catch (e) {
    try { db.close(); } catch { /* the throw below is the answer either way */ }
    // WHICH FAILURE, not merely that one happened. These pragmas WRITE, so they
    // fail for reasons that have nothing to do with the file being damaged:
    //
    //   errcode 26  SQLITE_NOTADB   file is not a database
    //   errcode 11  SQLITE_CORRUPT  disk image is malformed
    //   errcode  5  SQLITE_BUSY     another connection holds a read txn (DELETE mode)
    //   errcode  8  SQLITE_READONLY read-only file or directory
    //
    // (all four measured against node:sqlite). Telling an operator to restore
    // over a BUSY or READ-ONLY hub points them at replacing a healthy authority
    // database because someone else was reading it, or because a permission is
    // wrong. That is worse than the crash this guard replaced.
    //
    // Same mistake as the maintenance-lock catch: a failed operation is not
    // evidence of a damaged file. Only corruption earns the recovery advice.
    const kind = faultKind(e);
    throw new Error(
      kind === "damage"
        ? `the hub at ${path} cannot be read (${e.message}).\n` +
          `  recover  reeve restore --hub --force installs the newest usable snapshot\n` +
          `           pass --tail from a durable export-events --hub to carry history forward`
        : kind === "full"
        ? `the hub at ${path} could not be written because the store is full (${e.message}).\n` +
          `  the file itself answered, so this is not damage: it ran out of room.\n` +
          `  recover  TWO causes answer 13, and only one of them is the disk.\n` +
          `           1. the filesystem is full -- free space on the one holding ${path} and re-run.\n` +
          `              Old snapshot files under the backup root are usually the largest thing safe\n` +
          `              to remove, and they have to be removed DIRECTLY: reeve backup --hub --keep N\n` +
          `              writes a whole new snapshot with VACUUM INTO and prunes only after publishing\n` +
          `              it, so it needs more room before it frees any.\n` +
          `           2. the database has hit its own page limit -- check PRAGMA max_page_count\n` +
          `              against PRAGMA page_count; if they meet, no amount of free space helps and\n` +
          `              the limit is what has to change.\n` +
          `           Do NOT restore over it in either case: there is nothing wrong with the file, ` +
          `and a restore needs more room rather than less.`
        : `the hub at ${path} could not be opened for writing (${e.message}).\n` +
          `  the file itself answered, so this is not damage: another process may hold it, or the ` +
          `file or its directory may be read-only.\n` +
          `  recover  stop any running builder or reeve CLI and re-run; check the permissions on ` +
          `${path} and its directory. Do NOT restore over it -- there is no evidence it is broken.`,
      { cause: e });
  }

  // `schema_version` was created and first read INSIDE the guard above, so it
  // is not repeated here -- two copies of one statement is the duplication this
  // file keeps having to remove elsewhere.
  //
  // Read once here only to refuse a NEWER store early with a clear message.
  const seen = db.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get().v;
  // And the history has to be CONTIGUOUS, not merely tall. `max(version)` alone
  // reads a store recording versions 1 and 3 with 2 missing as fully migrated,
  // so the loop below skips every `m.version <= seen` and the store is used with
  // migration 2's columns and data transformations absent -- while reporting
  // version 3. A damaged or hand-repaired `schema_version` produces exactly that,
  // and it is the table an operator is most likely to have touched by hand after
  // a bad restore. Refusing is the only safe answer: the missing migration
  // cannot be re-run, because the ones above it have already been applied.
  {
    const rows = db.prepare("SELECT version FROM schema_version ORDER BY version").all().map(r => r.version);
    const gaps = [];
    for (let v = 1; v <= seen; v++) if (!rows.includes(v)) gaps.push(v);
    if (gaps.length) {
      db.close();
      throw new Error(
        `hub store at ${path} records schema version ${seen} but is missing migration(s) ` +
        `${gaps.join(", ")}. The history has holes, so the store's real shape is unknown and the ` +
        `missing migrations cannot be re-run beneath the ones above them. Restore a snapshot.`);
    }
  }
  if (seen > HUB_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `hub store at ${path} is schema version ${seen}; this binary knows ${HUB_SCHEMA_VERSION}. ` +
      `Migrations are forward-only: run the newer binary, or restore a snapshot taken at ${HUB_SCHEMA_VERSION}.`);
  }

  // A FINAL recheck under the lock, even when nothing is pending. When this
  // binary has already applied every migration it knows, every iteration below
  // takes the `continue` and the locked `applied > HUB_SCHEMA_VERSION` recheck
  // never runs -- so a newer binary can migrate the store between the unlocked
  // read above and this function's return, and `openHub` hands back a handle to
  // a schema it has just promised to refuse. The refusal is only worth what its
  // last read is worth.
  if (!MIGRATIONS.some(m => m.version > seen)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = db.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get().v;
      if (now > HUB_SCHEMA_VERSION) {
        db.exec("ROLLBACK"); db.close();
        throw new Error(
          `hub store at ${path} is schema version ${now}; this binary knows ${HUB_SCHEMA_VERSION}. ` +
          `It was migrated by a newer reeve while this one was opening it.`);
      }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  }

  for (const m of MIGRATIONS) {
    if (m.version <= seen) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read INSIDE the lock. Two processes opening a store that needs
      // migrating both read the same old version before either reaches
      // BEGIN IMMEDIATE; the first commits, the second then takes the lock and
      // re-runs a migration that has already been applied -- colliding on
      // schema_version at best, and corrupting a non-idempotent future
      // migration at worst. The decision to apply has to be made under the same
      // lock that applies it.
      const applied = db.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get().v;
      // Two rechecks, not one. Idempotence is the easy half.
      //
      // The FORWARD refusal has to be re-made here as well: a binary at version
      // N and one at N+1 can both open a store below N, both read the same old
      // `seen`, and the older one then waits on this lock while the newer one
      // migrates past it. It wakes to `applied === N+1`, finds nothing to do,
      // and RETURNS THE STORE -- having skipped its migration rather than
      // refusing a database it cannot read. The early check above is only a
      // fast, clear message; this is the one that holds under a race.
      if (applied > HUB_SCHEMA_VERSION) {
        db.exec("ROLLBACK");
        // NO close here. The catch below closes and rethrows, and
        // `DatabaseSync.close()` throws when the handle is already closed -- so
        // closing twice replaces the message that names BOTH schema versions
        // with `database is not open`, which tells an operator nothing about
        // what actually happened. One owner for cleanup, and it is the catch.
        throw new Error(
          `hub store at ${path} was migrated to schema version ${applied} while this binary waited; ` +
          `this binary knows ${HUB_SCHEMA_VERSION}. Run the newer binary.`);
      }
      if (m.version <= applied) { db.exec("COMMIT"); continue; }
      m.up(db);
      db.prepare("INSERT INTO schema_version(version, applied_at) VALUES(?, unixepoch())").run(m.version);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      try { db.close(); } catch {}
      // The version-race error is RETHROWN verbatim. Wrapping it as "migration N
      // failed" is wrong twice: no migration was attempted, and the wrapper hides
      // the two version numbers an operator needs to know which binary to run.
      if (/was migrated to schema version/.test(e.message)) throw e;
      // THE CAUSE TRAVELS. Without it this wrapper carries no `errcode`, so every
      // caller's classifier reads a corrupt store as "not a SQLite storage error"
      // and answers operational -- the one direction that tells an operator to
      // leave a damaged hub alone.
      throw new Error(`hub migration ${m.version} failed, store unchanged: ${e.message}`, { cause: e });
    }
  }
  return db;
}

/** One helper so every hub mutation is BEGIN IMMEDIATE and nothing else. */
export function hubTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

/** Both stores serialize payloads identically, so a replay compares byte for byte. */
export const canonicalHub = canonical;

/**
 * Append one row to the append-only log, IN THE CALLER'S TRANSACTION.
 *
 * This function deliberately does not open a transaction. Every
 * authority-bearing write appends one of these in the same tx that performs
 * it -- an approval, a gate request, a notice receipt, an impl_pr, an attested
 * push, a guardian receipt, a harness acceptance, a gate run, a pr_hold create
 * or clear, a hold reason, a project authority grant, a merge decision, a
 * territory or singleton lease grant or release, and every outbox enqueue,
 * void, fence or settle. That is what makes the projection replayable from
 * this table plus artifacts and external receipts, and it is why the
 * destructive restore drill has anything to compare against.
 *
 * If this opened its own transaction, a transition that rolled back would
 * leave its event behind and the replay would rebuild a fact that never
 * happened.
 */
export function hubEvent(db, { kind, task = null, payload = {} }) {
  const r = db.prepare(
    `INSERT INTO hub_event(at, kind, task, payload) VALUES(unixepoch(), ?, ?, ?) RETURNING seq`)
    .get(kind, task, canonical(payload));
  return r.seq;
}

/** The migration list, for the invariant test. Versions are 1..N, no gaps. */
export function migrationPlan() {
  // `implHash` travels beside the version because the freeze test needs a stable
  // representation of what migration 1 IS, and `MIGRATIONS` stays module-private
  // on purpose: exporting the array hands callers the `up` functions themselves,
  // which are runnable against any handle. A hash is comparable and inert.
  //
  // Two call sites referenced the bare `MIGRATIONS` constant from outside this
  // module -- the fixture-writing command and the freeze test -- and both would
  // have thrown ReferenceError, so the freeze the test advertises never existed.
  return MIGRATIONS.map(m => ({
    version: m.version,
    implHash: createHash("sha256").update(String(m.up)).digest("hex"),
  }));
}

/**
 * The tables a snapshot at a given schema version is required to carry.
 *
 * Migration 1's inventory is derived from `hub.sql`, plus `schema_version` --
 * which is NOT in that file and cannot be, because `openHub` creates it directly
 * before any migration runs, migration 1 needing somewhere to record itself.
 * hub.sql declares 31 tables and a live database has 32.
 *
 * **Every later migration adds its own entry**, built from the previous version
 * plus whatever it creates. That is the whole maintenance burden, and it is
 * mechanical.
 */
const V1 = Object.freeze([
  "schema_version",
  ...[...readFileSync(SCHEMA_PATH, "utf8")
        .matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)\s*\(/g)].map(m => m[1]),
]);
export const TABLES_AT = Object.freeze({ 1: V1 });

/**
 * The CURRENT schema's tables: what snapshot validation compares a
 * same-version snapshot against, and what Task 11 compares the live database to.
 *
 * Derived from `TABLES_AT`, NOT from `hub.sql`. hub.sql is frozen as migration 1
 * by design and its freeze test enforces that, so a constant read straight from
 * it can never discover a table migration 2 creates -- it would sit at the v1
 * inventory forever, Task 11's live-set equality would fail the moment migration
 * 2 landed, and the fallback validation would omit exactly the new
 * authority-bearing table.
 */
export const HUB_TABLES = TABLES_AT[HUB_SCHEMA_VERSION];
// LOUD, at module load. A migration added without its inventory would otherwise
// make HUB_TABLES undefined, and every `HUB_TABLES.filter(...)` in the backup
// path would throw somewhere far away from the omission that caused it.
if (!HUB_TABLES)
  throw new Error(`TABLES_AT has no inventory for schema version ${HUB_SCHEMA_VERSION}; ` +
                  `every migration that adds a table adds its entry there`);
