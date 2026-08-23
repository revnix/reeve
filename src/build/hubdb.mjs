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
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonical } from "../db/ops.mjs";
// `migrationPlan` hashes each migration's `up` so the freeze test has a stable,
// INERT representation of what migration 1 is. Exporting MIGRATIONS itself would
// hand callers runnable `up` functions.
import { createHash } from "node:crypto";

export const HUB_SCHEMA_VERSION = 1;

/**
 * Forward-only. Each entry runs exactly once, in order, in its own transaction,
 * and records itself. Never edit a merged entry -- add the next number.
 */
const MIGRATIONS = [
  { version: 1, up: (db) => db.exec(readFileSync(new URL("./hub.sql", import.meta.url), "utf8")) },
];

export function openHub(path) {
  // state/ may not exist yet: on a fresh REEVE_HOME no guardian store has
  // created it, and DatabaseSync will not create a missing parent. Without this
  // the very first hub-writing command fails before migration 1 can run.
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 10000 });

  // Set before anything else: foreign_keys cannot be changed inside a
  // transaction, and a migration is a transaction.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");     // authority-bearing and low-volume; NORMAL is not inherited
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 10000");

  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
             version    INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
           ) STRICT`);

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
      throw new Error(`hub migration ${m.version} failed, store unchanged: ${e.message}`);
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
