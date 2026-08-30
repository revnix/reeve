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
import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { canonical } from "../db/ops.mjs";
// `migrationPlan` hashes each migration's `up` so the freeze test has a stable,
// INERT representation of what migration 1 is. Exporting MIGRATIONS itself would
// hand callers runnable `up` functions.
import { createHash } from "node:crypto";

// ONE module-level schema URL. Both `openHub`'s migration 1 and `HUB_TABLES`
// read it; two spellings of the same path is how they drift.
const SCHEMA_PATH = new URL("./hub.sql", import.meta.url);

// `schema_version` is created by `openHub` directly, BEFORE any migration runs --
// migration 1 needs somewhere to record itself. The scratch builder below has to
// create it the same way, so the DDL is spelled once here rather than twice.
const SCHEMA_VERSION_DDL = `CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT`;

export const HUB_SCHEMA_VERSION = 3;

/**
 * Forward-only. Each entry runs exactly once, in order, in its own transaction,
 * and records itself. Never edit a merged entry -- add the next number.
 */
/**
 * Move a pin's deadline from the LEASE onto the CLAIM, wherever that has not
 * happened yet.
 *
 * A pin is one promise, and its deadline now lives on `task_territory` beside
 * the intent. Anything still carrying the deadline only on `territory_lease`
 * says "pinned" with no end once the lease goes, so the next grant reads "no
 * deadline", treats itself as the first grant, and mints a fresh one --
 * resurrecting a promise that was deliberately time-boxed.
 *
 * TWO CALLERS, ONE STATEMENT, and the second caller is why this is a function.
 * Migration 3 runs it over whatever the store already holds. But `restoreHub`
 * opens the staging database -- which runs the migration -- and only THEN
 * replays the tail, so a task pinned after the snapshot arrives afterwards. A
 * tail written by a v2 binary carries a `task_territory.claimed` image with no
 * `pinned_until` in it, and the `territory_lease.granted` image that follows
 * holds the deadline without ever copying it across. The restore therefore ends
 * in exactly the state the migration exists to remove, having already run.
 * Restore reconciles again after replay.
 *
 * Idempotent and safe to repeat: it touches only a pinned claim with no
 * deadline whose lease has one, so a v3 tail -- whose claim image already
 * carries the value -- matches nothing.
 */
export function backfillPinDeadlines(db) {
  db.exec(`
    UPDATE task_territory AS t
       SET pinned_until = (SELECT l.pinned_until FROM territory_lease l
                            WHERE l.task = t.task AND l.kind = t.kind AND l.path = t.path)
     WHERE t.pinned = 1
       AND t.pinned_until IS NULL
       AND EXISTS (SELECT 1 FROM territory_lease l
                    WHERE l.task = t.task AND l.kind = t.kind AND l.path = t.path
                      AND l.pinned_until IS NOT NULL)`);
}

const MIGRATIONS = [
  { version: 1, up: (db) => db.exec(readFileSync(SCHEMA_PATH, "utf8")) },
  // ---------------------------------------------------------------- 2
  // ONE SHAPE FOR EVERY PULL REQUEST A TASK OWNS.
  //
  // Migration 1 put implementation PRs in a table and the spec PR in three
  // columns on `task`, so every question of the form "what is open for this
  // task" had to be asked twice and the two answers merged by hand. Five places
  // ask it. Three learned about the spec PR one review round at a time, and
  // four consecutive rounds produced eight findings of that single shape --
  // rising, not falling. The sites were not the defect: asking one question in
  // two shapes was.
  //
  // A NEW MIGRATION rather than an edit to hub.sql, which is frozen by design
  // and by a recorded hash. Migration 1 has no deployed instance today, so
  // editing it would have worked and taught the wrong habit; a schema whose
  // history can be rewritten cannot be reasoned about the first time it cannot.
  { version: 2, up: (db) => {
      // RE-RUNNABLE, exactly as migration 1 is. `openHub` wraps each migration in
      // BEGIN IMMEDIATE, so an interrupted one rolls back -- but a hub whose
      // `schema_version` rows are lost while its TABLES survive reports version 0
      // and replays every migration over a store that already has them. Migration
      // 1 survives that because it is `CREATE TABLE IF NOT EXISTS` throughout;
      // this one has to earn the same property, and `ALTER TABLE ... DROP COLUMN`
      // has no IF EXISTS to lean on. The suite already had a fixture for this
      // state and it is the one that caught it.
      const hasTable = (t) => db.prepare(
        `SELECT count(*) c FROM sqlite_master WHERE type='table' AND name = ?`).get(t).c > 0;
      const hasColumn = (t, c) => db.prepare(
        `SELECT count(*) c FROM pragma_table_info(?) WHERE name = ?`).get(t, c).c > 0;

      db.exec(`
        CREATE TABLE IF NOT EXISTS task_pr (
          task       TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
          kind       TEXT    NOT NULL CHECK (kind IN ('spec','impl')),
          generation INTEGER,
          slice      INTEGER,
          repo_id    INTEGER NOT NULL,
          pr         INTEGER NOT NULL,
          head_sha   TEXT    NOT NULL,
          created_at INTEGER NOT NULL,
          merged_sha TEXT,
          PRIMARY KEY (repo_id, pr),
          CHECK ((kind = 'impl' AND generation IS NOT NULL AND slice IS NOT NULL)
              OR (kind = 'spec' AND generation IS NULL     AND slice IS NULL))
        ) STRICT, WITHOUT ROWID;
        CREATE UNIQUE INDEX IF NOT EXISTS one_spec_pr ON task_pr(task) WHERE kind = 'spec';
        CREATE UNIQUE INDEX IF NOT EXISTS impl_pr_slice
          ON task_pr(task, generation, slice) WHERE kind = 'impl';
        CREATE INDEX IF NOT EXISTS task_pr_open ON task_pr(task) WHERE merged_sha IS NULL;
      `);

      // Each carry is guarded by the shape it reads FROM, so a second run over an
      // already-migrated store finds nothing to do rather than failing.
      if (hasTable("impl_pr"))
        db.exec(`INSERT OR IGNORE INTO task_pr(task, kind, generation, slice, repo_id, pr,
                                               head_sha, created_at, merged_sha)
                   SELECT task, 'impl', generation, slice, repo_id, pr, head_sha, created_at, merged_sha
                     FROM impl_pr`);
      if (hasColumn("task", "spec_pr"))
        db.exec(`INSERT OR IGNORE INTO task_pr(task, kind, generation, slice, repo_id, pr,
                                               head_sha, created_at)
                   SELECT id, 'spec', NULL, NULL, spec_repo_id, spec_pr,
                          COALESCE(${hasColumn("task", "spec_head") ? "spec_head" : "NULL"}, ''), created_at
                     FROM task
                    WHERE spec_repo_id IS NOT NULL AND spec_pr IS NOT NULL`);

      db.exec("DROP TABLE IF EXISTS impl_pr");
      if (hasColumn("task", "spec_pr"))   db.exec("ALTER TABLE task DROP COLUMN spec_pr");
      if (hasColumn("task", "spec_head")) db.exec("ALTER TABLE task DROP COLUMN spec_head");
    } },
  // ---------------------------------------------------------------- 3
  // TWO FACTS THAT WERE SPLIT ACROSS PLACES WITH DIFFERENT LIFETIMES.
  //
  // Both defects below were found twice each -- once, patched at the site, and
  // then again through a second door the site fix did not cover. That is the
  // signal that the site was never the defect.
  //
  // 1. A PIN IS ONE PROMISE STORED AS TWO FACTS. `task_territory.pinned` records
  //    that the filing ASKED for a pin and is durable; the deadline lived on
  //    `territory_lease.pinned_until`, which dies with the lease row. So every
  //    path that removes a lease loses the deadline and leaves the intent, and
  //    the next resume reads "pinned" with no deadline and mints a fresh one --
  //    resurrecting a pin the founder time-boxed. Found first through
  //    `release-territory`, then again through `grantLease` REPLACING a
  //    non-live holder's row, which never goes near the release path at all.
  //    Putting the deadline beside the intent makes the two inseparable, and
  //    both site patches are deleted.
  //
  // 2. A LEASE HAS NO INCARNATION. `restoreHub` clears `provider_lease` in the
  //    restored file (src/backup.mjs), so SQLite restarts its integer keys and a
  //    re-claim of the same run gets an identical (owner, repo_id, run_ref) AND
  //    an identical id. Nothing distinguishes the new claim from the old, so a
  //    pre-restore mutation replayed afterwards -- which the retry-on-maintenance
  //    loop is exactly the caller to do -- deletes a live lease or corrupts its
  //    liveness data. `outbox.lease_token` already solves this shape in this
  //    codebase; `provider_lease` gets the same treatment.
  { version: 3, up: (db) => {
      // RE-RUNNABLE for the same reason migration 2 is: a store whose
      // `schema_version` rows are lost while its tables survive replays every
      // migration, and `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS.
      const hasColumn = (t, c) => db.prepare(
        `SELECT count(*) c FROM pragma_table_info(?) WHERE name = ?`).get(t, c).c > 0;

      if (!hasColumn("task_territory", "pinned_until"))
        db.exec("ALTER TABLE task_territory ADD COLUMN pinned_until INTEGER");
      // CARRIED FROM THE LEASE, so a hub mid-flight keeps the deadlines it has
      // rather than silently re-minting them. Only live leases have one to give.
      backfillPinDeadlines(db);

      if (!hasColumn("provider_lease", "token"))
        db.exec("ALTER TABLE provider_lease ADD COLUMN token TEXT");
    } },
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
  // REEVE'S OWN DAMAGE VERDICT, which carries no errcode because no SQLite call
  // failed -- `quick_check` ANSWERED, and the answer was that the file is broken.
  // Without this the rule below reads it as "not a storage error, therefore not
  // damage" and every recovery path treats a corrupt hub as a healthy one that
  // was merely busy. The marker is explicit rather than a fabricated errcode: an
  // invented 11 would be a lie about where the verdict came from.
  if (e?.hubDamaged) return false;
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

/**
 * The newest snapshot an operator could restore, named WITHOUT importing
 * `backup.mjs`.
 *
 * `backup.mjs` imports this module, so importing `latestSnapshot` back would be
 * a cycle. This is the cheap half of that function -- list and sort -- and it
 * deliberately validates nothing: the refusal below is the safety property, and
 * naming a file is DX on top of it. A wrong guess about the layout degrades the
 * MESSAGE and never the refusal, so it says what it could not find rather than
 * inventing a path.
 *
 * The layout is the CLI's own default (`join(HOME, "backups")`, `bin/reeve:496`)
 * and `hubPathFor`'s `<home>/state/hub.db`, so the hub's snapshots live in
 * `<home>/backups/hub`.
 */
function newestHubSnapshot(path) {
  try {
    const home = dirname(dirname(path));
    const dir = join(home, "backups", basename(path, ".db"));
    const newest = readdirSync(dir)
      .filter(f => /^\d+\.db$/.test(f))
      .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]))[0];
    return newest ? join(dir, newest) : null;
  } catch { return null; }
}

// ONE HOME FOR THE CONTENTION BUDGET.
//
// Every hub connection has to wait the same amount for the write lock, and the
// number had grown four copies across two files. A guest that waited a
// different amount from `openHub` is a second answer to the same question, and
// the copies drift silently because nothing compares them. Exported so the
// guardian's restricted connection reads it rather than repeating it.
export const HUB_BUSY_TIMEOUT_MS = 10000;

export function openHub(path, { skipIntegrity = false } = {}) {
  // state/ may not exist yet: on a fresh REEVE_HOME no guardian store has
  // created it, and DatabaseSync will not create a missing parent. Without this
  // the very first hub-writing command fails before migration 1 can run.
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: HUB_BUSY_TIMEOUT_MS });

  // CLOSED EXACTLY ONCE, from whichever path exits first.
  //
  // Seven places in this function close the handle and two of them already
  // carried an ad-hoc try/catch, which was the warning. A third then fell
  // through: the corruption branch closed, converted the exception into a
  // verdict, and the common damage branch closed AGAIN. `DatabaseSync.close()`
  // throws `database is not open` on a closed handle, so that error REPLACED the
  // hubDamaged verdict and its recovery guidance -- and it carries no errcode,
  // which `isOperational` reads as "not a storage error", so a genuinely corrupt
  // hub was classified as merely operational. The exact misclassification the
  // three-answer split was added to prevent, reintroduced by the split itself.
  //
  // Guarded here rather than by ordering, because ordering is what failed.
  let closed = false;
  const closeHub = () => { if (closed) return; closed = true; db.close(); };

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
    db.exec(`PRAGMA busy_timeout = ${HUB_BUSY_TIMEOUT_MS}`);
    // AND THE SCHEMA PROBE, inside the same guard. Corruption confined to the
    // `schema_version` PAGE rather than the header lets all four pragmas
    // succeed, so the first version read threw outside this catch and `build
    // run` printed a bare `database disk image is malformed` with none of the
    // recovery this guard exists to give. The guard has to reach as far as the
    // first read that can find damage, not stop at the first write.
    db.exec(SCHEMA_VERSION_DDL);
    db.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get();
  } catch (e) {
    closeHub();
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

  // AND THE FILE ITSELF IS CHECKED, not merely opened.
  //
  // SQLite opens a database with damage in an index or an unrelated table
  // perfectly happily, and every probe above can succeed against exactly that
  // file -- so a refusal built on "the open threw" hands the caller a corrupt hub
  // and calls it healthy. The guard above catches damage in the pages it happens
  // to touch; this catches the rest.
  //
  // `quick_check(1)`, not `integrity_check`. This runs on EVERY command and every
  // tick, and the full check is measured at ~1.1 ms/MB -- 52 ms on a 47 MB hub,
  // per open. `quick_check` skips the index cross-references, which is the
  // expensive half, and still refuses the page-level damage that matters here.
  // The deep check stays where it already is: `snapshotAll`, `restoreHub` and
  // `builder doctor`, each of which runs once and on purpose. Moving a full scan
  // onto the hot path to fix this would be the same mistake as the earlier
  // `latestSnapshot` repair, in the other direction.
  //
  // `1` is the row limit, not a depth: it stops after the first problem, which
  // is all a refusal needs.
  //
  // ONE CALLER IS EXEMPT, and it is the one whose job is to replace the file.
  // `restoreHub` opens the hub to take the maintenance lock IN it -- that is the
  // only exclusion a bootstrapping builder honours -- and then quarantines it and
  // installs a snapshot. Refusing there would make `restore --hub --force`
  // unable to recover exactly the hubs it exists for: measured, adding this check
  // turned five of that command's own recovery assertions red, including "names
  // the table it could not read" and "force carries it through". The check is for
  // callers about to USE the hub; the restore is about to REPLACE it, and it
  // validates the SNAPSHOT it installs rather than the wreck it is removing.
  if (!skipIntegrity) {
    // THREE ANSWERS, because a check that could not RUN has not answered.
    //
    // "not ok" and "could not tell" are different facts with different remedies:
    // one is restore-from-backup, the other is find out why the check would not
    // run — a locked file, an odd page size, SQLite unhappy for a reason that is
    // not corruption. Collapsing them sends an operator to replace a database
    // that may be perfectly intact, which is the strongest claim this file makes
    // and the one that must not be made on a guess. `rawOpen` and the admission
    // probe in `backup.mjs` each had to learn this separately; it is the same
    // shape a third time.
    let verdict = null, checkFailed = null;
    try { verdict = Object.values(db.prepare("PRAGMA quick_check(1)").get() ?? {})[0]; }
    catch (e) { checkFailed = e; }

    if (checkFailed) {
      closeHub();
      // A CHECK THAT THREW *CORRUPTION* HAS ANSWERED. SQLITE_CORRUPT and
      // SQLITE_NOTADB out of `quick_check` are not "could not tell": they are the
      // file saying so through a different door, and calling that unknown would
      // leave an operator with no remedy for a hub that is genuinely broken. Any
      // other errcode -- BUSY, READONLY, PERM, CANTOPEN, IOERR -- is the
      // situation failing rather than the file.
      if (checkFailed.errcode === 11 || checkFailed.errcode === 26)
        verdict = `the check failed with ${checkFailed.message}`;
      else {
        // NOT marked `hubDamaged`: nothing here established damage. The errcode
        // is carried ONTO this error rather than left only on `cause`, so
        // `isOperational` classifies it on the evidence it actually has instead
        // of on the wrapper happening to have no errcode of its own.
        throw Object.assign(new Error(
          `the hub at ${path} could not be checked (${checkFailed.message}).\n` +
          `  This is NOT a verdict on the file: the integrity check itself did not run, so the hub ` +
          `may be perfectly intact.\n` +
          `  recover  find out why the check could not run — another process may hold the file, or ` +
          `its permissions may be wrong — and re-run. Do NOT restore over it on this evidence.`,
          { cause: checkFailed }),
          checkFailed.errcode === undefined ? {} : { errcode: checkFailed.errcode });
      }
    }

    if (verdict !== "ok") {
      closeHub();
      const newest = newestHubSnapshot(path);
      throw Object.assign(new Error(
        // `quick_check(1)` stops at the FIRST problem, which is what makes it
        // cheap enough for every open — and it means this line is a sample, not
        // a census. Saying so stops an operator reading one reported error as
        // one actual problem.
        `the hub at ${path} is damaged. The first problem found is: ${verdict}\n` +
        `  (the check stops at the first problem, so there may be more; ` +
        `reeve builder doctor runs the full integrity_check)\n` +
        (newest
          ? `  recover  reeve restore --hub --force --from ${newest}\n` +
            `           pass --tail from a durable export-events --hub to carry history forward`
          : `  recover  no snapshot was found under ${join(dirname(dirname(path)), "backups", basename(path, ".db"))}; ` +
            `if one exists elsewhere, pass it with --from`)),
        // The marker `isOperational` reads. This verdict is reeve's, not
        // SQLite's, so it has no errcode to classify by.
        { hubDamaged: true });
    }
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
      closeHub();
      throw new Error(
        `hub store at ${path} records schema version ${seen} but is missing migration(s) ` +
        `${gaps.join(", ")}. The history has holes, so the store's real shape is unknown and the ` +
        `missing migrations cannot be re-run beneath the ones above them. Restore a snapshot.`);
    }
  }
  if (seen > HUB_SCHEMA_VERSION) {
    closeHub();
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
        db.exec("ROLLBACK"); closeHub();
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
      closeHub();
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
 * it -- an approval, a gate request, a notice receipt, a task_pr, an attested
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
 * A scratch hub, in memory, migrated to `version`.
 *
 * THIS IS THE WHOLE IDEA. The tables, columns, indexes and constraints a version
 * requires are not declared anywhere any more -- they are whatever running the
 * migrations to that version actually produces. A migration that adds an index,
 * a foreign key or a table is covered the day it lands, with nothing to
 * remember and no list to update.
 *
 * It replaces `TABLES_AT` and `COLUMNS_AT`, which were a restatement of what the
 * migrations already said. A restatement drifts, and the drift is invisible
 * exactly where it matters: `openHub` reads the version as completed, skips the
 * migration, and the first write fails AFTER the snapshot was chosen for
 * recovery.
 *
 * It applies the migrations the same way `openHub` does -- same `MIGRATIONS`
 * array, same `SCHEMA_VERSION_DDL` -- without the transaction, race and
 * corruption handling, which are about a file being shared and this store is
 * private and discarded. Copying the apply loop's DECISIONS would be a second
 * inventory of the migration order, so only the ceremony is dropped.
 */
function scratchAt(version) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_VERSION_DDL);
  for (const m of MIGRATIONS) {
    if (m.version > version) break;
    m.up(db);
    db.prepare("INSERT INTO schema_version(version, applied_at) VALUES(?, unixepoch())").run(m.version);
  }
  return db;
}

/**
 * A store's structure, read STRUCTURALLY rather than as DDL text.
 *
 * NOT a comparison of `sqlite_master.sql`, and not a hash of it. Two databases
 * with the same logical schema routinely carry different DDL text: `hub.sql`
 * writes its tables across several lines, and the same table written on one line
 * produces different stored text even after whitespace is collapsed. A text or
 * fingerprint comparison reports "the schema differs" without saying HOW, at the
 * one moment a readable answer matters most.
 *
 * (The issue that asked for this named `ALTER TABLE ADD COLUMN` as the reason.
 * Measured on SQLite 3.53, that is not it: an altered table and a freshly
 * created one produce byte-identical DDL, with and without `NOT NULL DEFAULT`.
 * The divergence that does occur is authoring format. The conclusion stands and
 * the stated reason does not, which is worth writing down -- someone who
 * measures only the ALTER case will conclude a text comparison is safe.)
 *
 * CHECK constraints are NOT covered. SQLite exposes no structural pragma for
 * them, and recovering them from the DDL text would reintroduce exactly the
 * text-parsing this function avoids. Said plainly here rather than left for a
 * reader to assume, because an unstated gap in a check reads as coverage.
 */
export function shapeOf(db) {
  const tables = {};
  // TRIGGERS ARE PART OF THE SCHEMA AND CAN REFUSE A WRITE OUTRIGHT. A hub
  // carrying `CREATE TRIGGER ... BEFORE INSERT ON task BEGIN SELECT RAISE(ABORT,
  // ...); END` has identical tables, columns, indexes and constraints, passes a
  // deep integrity check, and rejects the first ordinary task filing.
  const triggers = {};
  for (const r of db.prepare(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'`).all())
    triggers[r.name] = { table: r.tbl_name, sql: String(r.sql ?? "").replace(/\s+/g, " ").trim() };
  // `wr` is WITHOUT ROWID. Thirteen hub tables declare it, and rebuilding one
  // without it is invisible to every other check: the columns, indexes and
  // constraints are identical, and only the storage changes -- a primary-key
  // table becomes a rowid table plus a separate PK index.
  const propsOf = new Map(
    db.prepare(`SELECT name, strict, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table'`)
      .all().map(r => [r.name, { strict: Number(r.strict) === 1, withoutRowid: Number(r.wr) === 1 }]));
  const names = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all().map(r => r.name);

  for (const t of names) {
    const columns = {};
    // `dflt_value` is part of the writable contract, not decoration. `task.priority`
    // is `NOT NULL DEFAULT 'p2'` and callers omit it; a snapshot that lost the
    // default keeps every row valid and passes an integrity check, then fails the
    // first ordinary insert with a NOT NULL violation after being restored.
    for (const c of db.prepare(
      `SELECT name, type, "notnull", pk, dflt_value FROM pragma_table_info(?)`).all(t))
      columns[c.name] = { type: String(c.type ?? "").toUpperCase(),
                          notNull: Number(c.notnull) === 1, pk: Number(c.pk) > 0,
                          dflt: c.dflt_value == null ? null : String(c.dflt_value) };

    const indexes = {};
    for (const i of db.prepare(`SELECT name, "unique", origin FROM pragma_index_list(?)`).all(t)) {
      const cols = db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`)
                     .all(i.name).map(r => r.name);
      // AN IMPLICIT INDEX IS KEYED BY ITS COLUMNS, NOT ITS NAME. SQLite names the
      // indexes it creates for PRIMARY KEY and UNIQUE `sqlite_autoindex_<table>_<n>`,
      // and the number is positional -- so dropping an unrelated constraint
      // renumbers the survivors and a name-keyed comparison reports a defect
      // where the schema is identical.
      // THE PREDICATE OF A PARTIAL INDEX IS PART OF WHAT IT ENFORCES.
      // `one_live_run` is `UNIQUE ON phase_run(task) WHERE status IN
      // ('live','adopted')`. Recreated with a different WHERE it keeps its name
      // and its uniqueness flag and stops enforcing the single-live-run
      // invariant entirely. Taken from the WHERE clause specifically rather than
      // by comparing whole DDL, so authoring format cannot raise a false defect.
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
                    .get(i.name)?.sql ?? null;
      const where = ddl ? (ddl.match(/\bWHERE\b([\s\S]*)$/i)?.[1] ?? "").replace(/\s+/g, " ").trim() : "";
      const key = i.origin === "c" ? `name:${i.name}` : `cols:${cols.join(",")}`;
      indexes[key] = { unique: Number(i.unique) === 1, columns: cols, explicit: i.origin === "c",
                       name: i.name, where };
    }

    const foreignKeys = {};
    for (const f of db.prepare(
      `SELECT "table", "from", "to", on_delete, on_update FROM pragma_foreign_key_list(?)`).all(t))
      foreignKeys[`${f.from}->${f.table}.${f.to}`] =
        { onDelete: f.on_delete, onUpdate: f.on_update };

    const props = propsOf.get(t) ?? { strict: false, withoutRowid: false };
    tables[t] = { columns, indexes, foreignKeys, strict: props.strict,
                  withoutRowid: props.withoutRowid, checks: checksOf(db, t) };
  }
  return { tables, triggers };
}

/**
 * The CHECK constraints on a table, as normalised text.
 *
 * SQLite exposes no structural pragma for CHECK, so this is the one place the
 * DDL must be read -- and it is read NARROWLY: the balanced parenthesis group
 * after each `CHECK` keyword, whitespace collapsed, rather than the whole
 * statement. Comparing whole DDL is what this module exists to avoid, because
 * authoring format differs between a fresh store and a rebuilt one and would
 * raise a defect where the schema is identical.
 *
 * A tightened CHECK is not decoration: narrowing `task.priority` to `'p1'` alone
 * leaves existing rows valid and every integrity check clean, then refuses the
 * ordinary insert that relies on the `'p2'` default.
 */
function checksOf(db, table) {
  const ddl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? "";
  const out = [];
  const re = /\bCHECK\s*\(/gi;
  let m;
  while ((m = re.exec(ddl))) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < ddl.length && depth > 0; i++) {
      if (ddl[i] === "(") depth++;
      else if (ddl[i] === ")") depth--;
    }
    // An unbalanced tail means the scan lost its place; recording a truncated
    // constraint would compare two different wrong things.
    if (depth !== 0) continue;
    out.push(ddl.slice(m.index + m[0].length, i - 1).replace(/\s+/g, " ").trim());
  }
  return out.sort();
}

// Building a scratch store runs every migration, so the shape for a version is
// computed once per process rather than per snapshot examined.
const SHAPE_CACHE = new Map();
/** The structure the migrations produce at `version`. Exported so tests can ask
 *  what a version REQUIRES without restating it. */
export function shapeAt(version) {
  if (!SHAPE_CACHE.has(version)) {
    const db = scratchAt(version);
    try { SHAPE_CACHE.set(version, shapeOf(db)); } finally { db.close(); }
  }
  return SHAPE_CACHE.get(version);
}

/** The tables a snapshot at `version` must carry, derived by running the migrations. */
export function tablesAt(version) {
  return Object.freeze(Object.keys(shapeAt(version).tables).sort());
}

/**
 * The lowest hub schema the PROVIDER SCHEDULER can be used against.
 *
 * Migration 3 adds `provider_lease.token`, and every claim names that column --
 * so against a v1 or v2 hub the first `claimProvider` throws. The guardian's
 * documented response to a throwing scheduler is to dispatch UNSCHEDULED, which
 * means a newer guardian beside an older builder would quietly run model work
 * outside the shared limit. "The hub opened" is therefore not the same question
 * as "the scheduler can be used", and only the second one gates dispatch.
 *
 * Checked against the DERIVED shape rather than trusted: the test asserts this
 * is the version that introduces `provider_lease.token`, so moving the column
 * without moving this constant fails rather than drifting.
 */
export const SCHEDULER_MIN_HUB_VERSION = 3;

/**
 * How a store fails `version`'s requirements, one readable string each. Empty
 * means it satisfies them.
 *
 * ONE-DIRECTIONAL, DELIBERATELY. Missing and wrong are defects; EXTRA tables,
 * columns and indexes are not. A snapshot taken by a newer binary can carry more
 * than this version requires and still restore correctly, and refusing it would
 * turn a compatible snapshot into an unrecoverable one at the worst moment.
 *
 * NAMES ARE NOT ENOUGH, and the difference is not academic. Every hub table is
 * STRICT, so a column of the wrong declared type does not coerce -- it refuses
 * the write. A snapshot carrying `provider_lease.token INTEGER` has the column,
 * passes a name-only inventory, is selected for recovery, and then fails the
 * first `claimProvider` with `cannot store TEXT value in INTEGER column`. That
 * is the same failure as the missing column, arriving at the same worst moment,
 * so it is the same check.
 *
 * The message names the specific defect -- `provider_lease.token is INTEGER,
 * want TEXT` -- rather than reporting that the schema differs. That is the
 * property worth preserving from the inventories this replaces.
 */
export function schemaDefectsAt(db, version) {
  const want = shapeAt(version);
  const have = shapeOf(db);
  const bad = [];

  for (const [t, wantTable] of Object.entries(want.tables)) {
    const haveTable = have.tables[t];
    if (!haveTable) { bad.push(`table ${t} is missing`); continue; }

    for (const [c, w] of Object.entries(wantTable.columns)) {
      const h = haveTable.columns[c];
      if (!h) { bad.push(`${t}.${c} is missing`); continue; }
      if (h.type !== w.type) bad.push(`${t}.${c} is ${h.type || "untyped"}, want ${w.type}`);
      if (w.notNull !== h.notNull)
        bad.push(`${t}.${c} is ${h.notNull ? "NOT NULL" : "nullable"}, want ${w.notNull ? "NOT NULL" : "nullable"}`);
      if (w.pk && !h.pk) bad.push(`${t}.${c} is not part of the primary key, want it to be`);
      if (h.dflt !== w.dflt)
        bad.push(`${t}.${c} defaults to ${h.dflt ?? "nothing"}, want ${w.dflt ?? "no default"}`);
    }

    // AN EXTRA COLUMN IS ONLY HARMLESS IF AN INSERT CAN OMIT IT. `NOT NULL` with
    // no default refuses every write the code performs, because every insert
    // omits a column this schema does not know about.
    for (const [c, h] of Object.entries(haveTable.columns))
      if (!(c in wantTable.columns) && h.notNull && h.dflt === null)
        bad.push(`${t}.${c} is not in this schema and is NOT NULL with no default, ` +
                 `so every insert that omits it fails`);

    for (const [key, w] of Object.entries(wantTable.indexes)) {
      const h = haveTable.indexes[key];
      const label = w.explicit ? `index ${w.name} on ${t}` : `${t}(${w.columns.join(", ")})`;
      if (!h) { bad.push(`${label} is missing`); continue; }
      if (w.unique !== h.unique)
        bad.push(`${label} is ${h.unique ? "UNIQUE" : "not UNIQUE"}, want ${w.unique ? "UNIQUE" : "not UNIQUE"}`);
      if (w.columns.join(",") !== h.columns.join(","))
        bad.push(`${label} covers (${h.columns.join(", ")}), want (${w.columns.join(", ")})`);
      if (w.where !== h.where)
        bad.push(`${label} is filtered by ${h.where || "nothing"}, want ${w.where || "no filter"}`);
    }

    // AN EXTRA UNIQUE INDEX REFUSES WRITES; an extra non-unique one only costs
    // write time. A unique index on `task(project)` lets the first task through
    // and fails the second, which is worse than failing immediately.
    for (const [key, h] of Object.entries(haveTable.indexes))
      if (!(key in wantTable.indexes) && h.unique)
        bad.push(`unique index ${h.name} on ${t}(${h.columns.join(", ")}) is not in this schema ` +
                 `and can refuse writes`);

    for (const [key, w] of Object.entries(wantTable.foreignKeys)) {
      const h = haveTable.foreignKeys[key];
      if (!h) { bad.push(`foreign key ${t}.${key} is missing`); continue; }
      if (h.onDelete !== w.onDelete)
        bad.push(`foreign key ${t}.${key} is ON DELETE ${h.onDelete}, want ${w.onDelete}`);
      if (h.onUpdate !== w.onUpdate)
        bad.push(`foreign key ${t}.${key} is ON UPDATE ${h.onUpdate}, want ${w.onUpdate}`);
    }
    for (const key of Object.keys(haveTable.foreignKeys))
      if (!(key in wantTable.foreignKeys))
        bad.push(`foreign key ${t}.${key} is not in this schema and can refuse writes`);

    // CHECK CONSTRAINTS, BOTH WAYS. A tightened CHECK leaves existing rows valid
    // and refuses new ones: narrowing `task.priority` to `'p1'` passes every
    // integrity check on an empty hub and then rejects the ordinary insert that
    // relies on the `'p2'` default.
    const wantChecks = wantTable.checks.join(" ;; ");
    const haveChecks = haveTable.checks.join(" ;; ");
    if (wantChecks !== haveChecks) {
      const added   = haveTable.checks.filter((c) => !wantTable.checks.includes(c));
      const removed = wantTable.checks.filter((c) => !haveTable.checks.includes(c));
      if (added.length)   bad.push(`table ${t} adds CHECK (${added[0]}), which can refuse writes`);
      if (removed.length) bad.push(`table ${t} is missing CHECK (${removed[0]})`);
    }

    if (wantTable.strict && !haveTable.strict) bad.push(`table ${t} is not STRICT`);
    if (wantTable.withoutRowid !== haveTable.withoutRowid)
      bad.push(`table ${t} is ${haveTable.withoutRowid ? "WITHOUT ROWID" : "a rowid table"}, ` +
               `want ${wantTable.withoutRowid ? "WITHOUT ROWID" : "a rowid table"}`);
  }

  // TRIGGERS ARE COMPARED AS A WHOLE-SCHEMA SET, not per table, because a
  // trigger on an EXTRA table can still refuse a write to an expected one.
  for (const [name, h] of Object.entries(have.triggers)) {
    const w = want.triggers[name];
    if (!w) { bad.push(`trigger ${name} on ${h.table} is not in this schema and can refuse or alter writes`); continue; }
    if (w.sql !== h.sql) bad.push(`trigger ${name} on ${h.table} does not match this schema`);
  }
  for (const name of Object.keys(want.triggers))
    if (!(name in have.triggers)) bad.push(`trigger ${name} is missing`);

  return bad;
}

/**
 * The CURRENT schema's tables: what snapshot validation compares a same-version
 * snapshot against, and what Task 11 compares the live database to.
 *
 * Derived by running the migrations, NOT read from `hub.sql`. hub.sql is frozen
 * as migration 1 by design and its freeze test enforces that, so a constant read
 * straight from it can never discover a table migration 2 creates -- it would
 * sit at the v1 inventory forever, Task 11's live-set equality would fail the
 * moment migration 2 landed, and the fallback validation would omit exactly the
 * new authority-bearing table.
 */
export const HUB_TABLES = tablesAt(HUB_SCHEMA_VERSION);
// LOUD, at module load. A version whose migrations produce nothing would make
// every `HUB_TABLES.filter(...)` in the backup path answer empty, and a snapshot
// missing every table would validate clean.
if (!HUB_TABLES.length)
  throw new Error(`the migrations produce no tables at schema version ${HUB_SCHEMA_VERSION}; ` +
                  `snapshot validation would accept anything`);
