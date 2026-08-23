// backup — the second copy.
//
// reeve's entire memory lived in one file on one laptop. `exportJsonl` existed and
// nothing ever called it, which is a fire extinguisher still in its box: the
// capability was there and the protection was not.
//
// A SNAPSHOT rather than an event replay, deliberately. Replaying reeve's own
// events back into a store would need code that understands every op, and that
// code would be one more thing capable of being subtly wrong on the one day it
// matters. `VACUUM INTO` writes a byte-exact database that restores by being
// copied back, and SQLite takes a read lock while it works, so a snapshot taken
// mid-tick is still consistent.
//
// The JSONL export stays, but for reading and portability rather than for
// recovery. Knowing which of the two is the restore path matters more than having
// both.

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
// `linkSync` is the snapshot PUBLISH: it is atomic AND exclusive, where
// `renameSync` is atomic but REPLACES an existing destination -- so two
// same-second writers would both believe they won.
import { mkdirSync, existsSync, copyFileSync, readdirSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { join } from "node:path";
import { open as openStore, exportJsonl } from "./db/ops.mjs";
// Task 8's subset. `TABLES_AT` and `HUB_TABLES` are what a snapshot's table set
// is validated against; Task 9 adds the locks, replay and hubEvent imports when
// `restoreHub` needs them, and not before -- ESM resolves at instantiation, so
// naming a module that does not exist yet breaks every import of this file.
import { HUB_SCHEMA_VERSION, HUB_TABLES, TABLES_AT } from "./build/hubdb.mjs";

export { openStore as open };

/** A repository name that is safe as one path segment. */
const slug = nwo => String(nwo).replace(/[^A-Za-z0-9._-]/g, "-");

/**
 * Write a consistent copy of the store.
 *
 * `VACUUM INTO` fails if the target exists, which is the behaviour we want: a
 * snapshot never silently overwrites another.
 */
export function snapshot(db, root, nwo, at = Math.floor(Date.now() / 1000), { keep = 14 } = {}) {
  const dir = join(root, slug(nwo));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${at}.db`);
  // The pid is in the name so two processes cannot collide on the TEMP either.
  // The leading dot and the `.tmp` suffix keep it out of every reader's
  // `/^\d+\.db$/` filter, which is what makes the partial file unobservable.
  const temp = join(dir, `.${at}.${process.pid}.tmp`);
  try { rmSync(temp, { force: true }); } catch {}
  try {
    // Quoted and escaped: a path is data here, not syntax.
    db.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
  } catch (e) {
    try { rmSync(temp, { force: true }); } catch {}
    return { ok: false, path: null, mine: false, why: `could not snapshot: ${e.message}` };
  }
  let mine;
  try {
    // ATOMIC and EXCLUSIVE. `renameSync` here would replace a file another
    // process is validating; `linkSync` refuses, which is the whole point.
    linkSync(temp, path);
    mine = true;
  } catch (e) {
    if (e.code !== "EEXIST") {
      try { rmSync(temp, { force: true }); } catch {}
      // NOT a silent fallback to rename. A filesystem that cannot hard-link
      // cannot give this guarantee, and a snapshot that quietly stops being
      // exclusive is worse than one that fails loudly.
      return { ok: false, path: null, mine: false, why: `could not publish snapshot: ${e.message}` };
    }
    mine = false;                                    // someone else published this second
  }
  try { rmSync(temp, { force: true }); } catch {}    // the link owns the data now
  // `prune` stays exactly where it was, and so does its contract: callers that
  // must validate before a file earns a retention slot pass `keep: Infinity` and
  // prune themselves afterwards (`snapshotAll` does). Moving it here would
  // change behaviour for the per-repo `backup` route, which is not this fix.
  prune(dir, keep);
  return { ok: true, path, mine, why: mine ? null : "already taken this second" };
}

/**
 * Keep the newest few. A backup directory that grows without bound fills the disk
 * of the machine that is already the single point of failure.
 */
// `usable` defaults to `() => true`, so every existing caller keeps today's
// behaviour exactly. When supplied, candidates the predicate rejects are DELETED
// first and the newest `keep` of what remains are retained -- a file that fails
// validation is not a recovery point, `latestSnapshot` already refuses it, and
// leaving it on disk means paying to validate it again on every future backup.
function prune(dir, keep, { usable = () => true } = {}) {
  try {
    const files = readdirSync(dir).filter(f => /^\d+\.db$/.test(f))
      .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
    // Unusable candidates are removed FIRST and do not count toward retention.
    // `keep` means "the newest N RECOVERY POINTS", not "the newest N filenames":
    // a snapshot that was valid when written can be unreadable later, and
    // counting it evicts an older GOOD one to make room for a file
    // `latestSnapshot` already refuses to return.
    const kept = [];
    for (const f of files) {
      if (usable(join(dir, f))) kept.push(f);
      else rmSync(join(dir, f), { force: true });
    }
    for (const f of kept.slice(keep)) rmSync(join(dir, f), { force: true });
  } catch { /* pruning must never take the loop down */ }
}

/**
 * Every state store on this machine, watched or not, INCLUDING the hub.
 *
 * The per-repo stores live at state/<owner>/<repo>.db. The hub is one file at
 * state/hub.db, because a task spans projects and a lease is global -- so the
 * directory walk below, which skips non-directories, could not see it. That is
 * the same shape as the miss this function was written for: the store nothing
 * reminds you about is the one with no backups, and the hub is the store that
 * records who approved what.
 */
export function everyStore(home) {
  const root = join(home, "state");
  const out = [];

  const hub = join(root, "hub.db");
  if (existsSync(hub)) out.push({ nwo: "hub", path: hub, kind: "hub" });

  let owners;
  try { owners = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const o of owners) {
    if (!o.isDirectory()) continue;
    let files;
    try { files = readdirSync(join(root, o.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".db")) continue;
      out.push({ nwo: `${o.name}/${f.slice(0, -3)}`, path: join(root, o.name, f), kind: "repo" });
    }
  }
  return out;
}

/**
 * Read a snapshot before trusting it.
 *
 * A file of the right size with the wrong contents restores exactly as easily
 * as a good one, and the moment you find out is the moment you needed it. So a
 * snapshot is opened, integrity-checked, and its schema version compared with
 * the binary that would have to read it back.
 */
/**
 * Two depths, because the callers ask two different questions.
 *
 * CHEAP (the default) answers "would this restore?" -- not a database, wrong
 * schema version, missing marker table, missing authority-bearing tables. Flat
 * cost: it touches the schema and one b-tree root.
 *
 * DEEP adds `PRAGMA integrity_check`, which reads every page. Measured
 * 2026-08-23 at ~1.1 ms per megabyte -- 52 ms on a 47 MB store, against 0.66 ms
 * for the cheap path (docs/measured/2026-08-23-integrity-check-cost.md). That
 * belongs at the two places a full scan earns its cost: verifying a snapshot
 * just written, and verifying one about to replace a live database. It does NOT
 * belong on `latestSnapshot`, which `selfaudit.mjs` calls once per store on
 * every guardian tick -- a repeated full scan of an immutable file.
 */
export function validateSnapshot(path, { expectVersion = null, kind = "repo", deep = false } = {}) {
  let probe = null;
  try {
    probe = new DatabaseSync(path, { readOnly: true });
    let integrity = null;
    if (deep) {
      integrity = Object.values(probe.prepare("PRAGMA integrity_check").get())[0];
      if (integrity !== "ok") return { ok: false, why: `integrity_check says: ${integrity}`, version: null, integrity };
      // AND the declared foreign keys, which integrity_check does not look at.
      // Measured 2026-08-23 on SQLite 3.53.0 (node v24.17.0): a database holding
      // one orphaned child row answers `ok` to integrity_check and returns the
      // violation only from foreign_key_check --
      // docs/measured/2026-08-23-integrity-check-misses-foreign-keys.md, with a
      // positive control showing the same integrity_check does report real page
      // corruption, so the `ok` is an answer and not a broken instrument.
      //
      // It matters here and nowhere else: this snapshot is about to REPLACE a
      // live hub, and restoreHub opens the result with foreign_keys ON. An
      // orphaned authority row -- an `outbox` whose `phase_event` is gone, a
      // `task_territory` whose `task` is gone -- would therefore surface later,
      // as a write failure inside an unrelated transaction, with nothing left to
      // fall back to.
      const fk = probe.prepare("PRAGMA foreign_key_check").all();
      if (fk.length)
        return { ok: false, integrity, version: null,
                 why: `${fk.length} foreign-key violation(s), e.g. ` +
                      fk.slice(0, 3).map(r => `${r.table} rowid ${r.rowid} -> ${r.parent}`).join(", ") };
    }

    // Each store is validated against ITS OWN marker. A guardian per-repo store
    // has no schema_version table -- that is the hub's mechanism -- so querying
    // it unconditionally throws, every repository snapshot is classified
    // unusable, and the caller DELETES it. That would leave the hub as the only
    // backed-up store on the machine, while reporting success for it.
    if (kind === "hub") {
      // The FULL table set, not two markers. A physically valid database holding
      // only `hub_event` and `schema_version` passed every earlier check, and
      // then `restoreHub` called `openHub`, whose `CREATE TABLE IF NOT EXISTS`
      // migration silently recreated `approval`, `outbox`, `merge_decision` and
      // the rest -- EMPTY. The snapshot was reported usable, the restore
      // reported success, and every authority-bearing row was already gone.
      // A missing table is the one corruption that repairs itself into silence.
      const present = new Set(probe.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      // The version FIRST, because it decides which tables are required. An
      // older snapshot legitimately lacks tables a later migration added, and
      // openHub migrates it forward after the copy -- so comparing against this
      // binary's inventory would refuse every pre-migration snapshot, and refuse
      // it as CORRUPT rather than as old, on the one path an operator reaches
      // for when everything else has failed.
      // The same contiguity rule `openHub` applies, applied HERE too. Checking it
      // only at open means a snapshot recording 1 and 3 with 2 absent passes
      // H-2/H-3, is chosen by `latestSnapshot` as the newest usable file, and is
      // refused by the staged `openHub` in the middle of the actual restore --
      // the one moment an operator has nothing to fall back to. A validator that
      // says "usable" about a file the restore will reject is worse than no
      // validator.
      const versions = probe.prepare("SELECT version FROM schema_version ORDER BY version").all().map(r => r.version);
      const version = versions.length ? versions[versions.length - 1] : 0;
      const gaps = [];
      for (let v = 1; v <= version; v++) if (!versions.includes(v)) gaps.push(v);
      if (!versions.length || gaps.length)
        return { ok: false, integrity, version,
                 why: !versions.length
                   ? "the snapshot records no schema version at all"
                   : `the snapshot records version ${version} but is missing migration(s) ${gaps.join(", ")}` };
      if (expectVersion != null && version > expectVersion)
        return { ok: false, why: `snapshot is schema version ${version}; this binary knows ${expectVersion}`, version, integrity };
      const required = TABLES_AT[version] ?? HUB_TABLES;
      const missing = required.filter(t => !present.has(t));
      if (missing.length)
        return { ok: false, why: `snapshot at version ${version} is missing ${missing.length} table(s): ${missing.slice(0, 5).join(", ")}`,
                 version, integrity };
      // schema_version alone is too weak a marker: a physically valid SQLite file
      // carrying only that table passes, is retained as a usable backup, and is
      // discovered to be empty at the moment it is restored. hub_event is the
      // table replay reads and the one migration 1 guarantees, so it is the
      // marker that actually means "this is a hub".
      probe.prepare("SELECT count(*) c FROM hub_event").get();
      return { ok: true, why: null, version, integrity };
    }
    // A repo store's marker is the append-only log the existing restore() probes.
    probe.prepare("SELECT count(*) c FROM event").get();
    return { ok: true, why: null, version: null, integrity };
  } catch (e) {
    return { ok: false, why: `not a usable store: ${e.message}`, version: null, integrity: null };
  } finally { try { probe?.close(); } catch {} }
}

/**
 * Snapshot every store, not only the one this tick is about.
 *
 * Opened read-only and copied with VACUUM INTO, which takes a read lock and is
 * safe against a writer. A store that cannot be opened is reported rather than
 * skipped silently: an unreadable store is the strongest possible reason to want
 * a backup of it.
 */
export function snapshotAll(home, root, { at = Math.floor(Date.now() / 1000), keep = 14, open: openDb = null } = {}) {
  const results = [];
  for (const { nwo, path } of everyStore(home)) {
    let db = null;
    try {
      db = openDb ? openDb(path) : new DatabaseSync(path, { readOnly: true });
      // `keep: Infinity` because `snapshot()` prunes BEFORE it returns
      // (search `prune(dir, keep);` -- `src/backup.mjs:45` on `16769e7`), so a snapshot that later fails validation has
      // already evicted the oldest good one. A run of invalid snapshots would
      // then erase every usable recovery point, one per attempt, while each
      // failure looked like it deleted only itself. Pruning happens below,
      // after the candidate has proved it can be read back.
      // `snapshot()` writes to a UNIQUE temporary path and renames it into
      // place. Without that, two repository daemons running `snapshotAll` for the
      // same store in the same second collide: the second `snapshot()` finds the
      // first process's target already present, returns it `ok` with
      // `why: "already taken this second"`, and this block then deep-validates a
      // file the OTHER process is still writing with VACUUM INTO. A probe that
      // catches it incomplete or locked deletes a snapshot the first process
      // owns -- and that process goes on to report success for a path that no
      // longer exists.
      //
      // Write-temp-then-PUBLISH is the answer, and the publish is `linkSync`,
      // not `renameSync`: `VACUUM INTO <dir>/.<epoch>.<pid>.tmp` followed by
      // `linkSync(temp, "<epoch>.db")`. Both operations are atomic within the
      // directory, so a reader sees the file either absent or complete and never
      // partial -- but only `link` is also EXCLUSIVE. `rename(2)` REPLACES an
      // existing destination on POSIX, so two same-second writers both succeed
      // and both believe they won; `link(2)` fails `EEXIST` for the second, which
      // is the winner/loser this block depends on. `snapshot()` therefore never
      // returns an "already taken" path it did not itself write: on `EEXIST` the
      // losing writer removes its own temp and returns
      // `{ ok: true, path, mine: false, why: "already taken this second" }`
      // WITHOUT this block validating or deleting it -- `taken.mine` is false,
      // and only a snapshot this process wrote is one this process may judge.
      const taken = snapshot(db, root, nwo, at, { keep: Infinity });
      // The LOSER reports neither success nor failure, and this branch exists
      // because it previously fell through to `results.push({ nwo, ...taken })`
      // and reported `ok: true` for a file it never validated and does not own.
      //
      // It cannot vouch for that file. The winner is still deep-validating and
      // will DELETE it if validation fails -- so this process would have
      // reported a successful backup for a path that no longer exists. A winner
      // killed between publish and validation leaves the same file with nobody
      // having checked it. And the loser must not validate-and-delete on the
      // owner's behalf: that is the exact cross-process deletion `mine` was
      // introduced to stop.
      //
      // Reporting `ok: false` is equally untrue: a backup DID happen, by another
      // process, and raising `builder:backup:failed` for a benign same-second
      // race is a false alarm on the one signal that has to stay trustworthy.
      //
      // So the third answer: `deferred`. Validity is the owner's to establish,
      // the operator is told plainly which file and why, and neither the exit
      // status nor any escalation turns on it.
      if (taken.ok && taken.path && !taken.mine) {
        results.push({ nwo, ...taken, ok: false, deferred: true, escalate: null,
          why: `another process published ${taken.path} this second; ` +
               `its validity is that process's to establish, not this one's` });
        continue;
      }
      // A snapshot that cannot be read back is worse than no snapshot: it makes
      // `latestSnapshot` answer with a file that will fail at restore time.
      if (taken.ok && taken.path && taken.mine) {
        // DEEP: this is a snapshot written one line ago, and "can it be read
        // back" is the entire question. Once per store per backup interval.
        const v = nwo === "hub"
          ? validateSnapshot(taken.path, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep: true })
          : validateSnapshot(taken.path, { kind: "repo", deep: true });
        if (!v.ok) {
          try { rmSync(taken.path, { force: true }); } catch {}
          // NOT pruned. The retention window still holds every good snapshot it
          // held before this attempt, which is the whole point of deferring it.
          results.push({ nwo, ok: false, why: `snapshot failed validation and was deleted: ${v.why}`, escalate: "builder:backup:failed" });
          continue;
        }
        // Valid, so it has earned its slot: prune now, with the real `keep` --
        // and with a usability predicate, because `keep` means "keep the newest
        // N RECOVERY POINTS", not "the newest N filenames". A snapshot that was
        // valid when written can be unreadable later (a bad sector, a truncated
        // copy, the future-timestamped corrupt candidate this task's own test
        // deliberately leaves on disk), and counting it toward retention evicts
        // an older GOOD snapshot to make room for a file `latestSnapshot`
        // already refuses to return. Enough of those in a row and every usable
        // recovery point is gone, one per backup, each deletion looking correct
        // on its own.
        //
        // CHEAP validation per candidate, not deep: this runs over every
        // retained file on every backup, and 2026-08-23-integrity-check-cost.md
        // is the measurement that says a full scan does not belong on a repeated
        // path. The marker query is flat at ~0.3 ms, which is what makes doing it
        // per candidate affordable at all.
        prune(join(root, slug(nwo)), keep, {
          usable: (p) => (nwo === "hub"
            ? validateSnapshot(p, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION })
            : validateSnapshot(p, { kind: "repo" })).ok,
        });
      }
      results.push({ nwo, ...taken });
    } catch (e) {
      results.push({ nwo, ok: false, why: `could not open ${path}: ${e.message}` });
    } finally {
      try { db?.close(); } catch { /* a close that fails must not lose the result */ }
    }
  }
  return results;
}

/**
 * The snapshot FILES for a store, newest first, without judging any of them.
 *
 * `latestSnapshot` answers null for two different reasons -- nothing was ever
 * written, or files exist and none of them validate -- and a caller that must
 * tell those apart needs to see the candidates. Exported rather than
 * reimplemented because `slug` is private here, and a second spelling of the
 * path is how the two drift.
 */
export function snapshotCandidates(root, nwo) {
  try {
    return readdirSync(join(root, slug(nwo))).filter(f => /^\d+\.db$/.test(f))
      .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
  } catch { return []; }
}

/**
 * The newest snapshot that would actually restore.
 *
 * Sorting filenames by timestamp answers "which is newest", not "which is
 * usable", and the two differ exactly when it matters: the file an operator
 * reaches for at 2am is the one written by the run that was already failing.
 * A candidate that does not validate is skipped, so `reeve restore` defaults to
 * the newest GOOD snapshot rather than the newest file.
 */
export function latestSnapshot(root, nwo, { deep = false } = {}) {
  const dir = join(root, slug(nwo));
  let files;
  try {
    files = readdirSync(dir).filter(f => /^\d+\.db$/.test(f))
      .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
  } catch { return null; }
  // `deep` is a PARAMETER, and the restore-selection path passes it. Cheap
  // validation reads the markers and the table set; a foreign-key violation or a
  // corrupt data page passes all of it, so `latestSnapshot` returned a file that
  // `restoreHub`'s own deep validation then rejected -- and the CLI stopped
  // there rather than trying the next retained snapshot, which is exactly the
  // fallback it advertises. The per-tick caller keeps the cheap default; only
  // the restore path pays for the scan, and it pays once, on the file it is
  // about to install.
  //
  //   latestSnapshot(root, nwo, { deep: false })   // selfaudit, per tick
  //   latestSnapshot(root, nwo, { deep: true })    // restore --hub's default
  //
  // The parameter is REAL, not described: an earlier revision wrote this comment
  // and left the signature at two arguments, so the restore route could not ask
  // for depth even though the plan said it did. `deep` is forwarded straight to
  // `validateSnapshot`, and a candidate that fails is skipped like any other --
  // the walk continues to the next older file rather than stopping.
  //
  // With `deep`, a candidate that fails is skipped and the walk CONTINUES to the
  // next older one, which is what "the newest snapshot that would actually
  // restore" has always claimed to mean.
  //
  // CHEAP validation, deliberately. This runs on the guardian's per-tick path
  // through selfaudit.mjs (:48 and :56, once per store), and snapshots are
  // immutable -- a full integrity scan here re-reads every page of every
  // retained backup every 90 seconds to learn what it learned last time.
  // The restore path validates deeply before it replaces anything.
  // `deep` is FORWARDED, not merely accepted. The previous revision destructured
  // it in the signature, wrote the comment above, and then built `opts` without
  // it -- so `{ deep: true }` selected exactly the same file `{ deep: false }`
  // did, and the restore path's fallback to an older snapshot never ran.
  const opts = nwo === "hub"
    ? { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep }
    : { kind: "repo", deep };
  for (const f of files) {
    const p = join(dir, f);
    if (validateSnapshot(p, opts).ok) return p;
  }
  return null;
}

export function restore(snapshotPath, dbPath, { overwrite = false, force = false, isDaemonRunning = daemonRunning } = {}) {
  if (!existsSync(snapshotPath)) return { ok: false, why: `no snapshot at ${snapshotPath}` };
  if (existsSync(dbPath) && !overwrite)
    return { ok: false, why: `${dbPath} exists; pass overwrite to replace it, which discards anything newer than the snapshot` };

  // Verify BEFORE replacing anything.
  try {
    const probe = new DatabaseSync(snapshotPath, { readOnly: true });
    const n = probe.prepare("SELECT count(*) c FROM event").get().c;
    probe.close();
    if (typeof n !== "number") throw new Error("event table unreadable");
  } catch (e) { return { ok: false, why: `the snapshot is not a usable store: ${e.message}` }; }

  // Refuse while reeve's own daemon is running.
  //
  // The obvious check — open the store and take an exclusive lock — does NOT work:
  // an idle second connection does not block EXCLUSIVE, so the probe succeeded and
  // the file was replaced underneath a live handle, which then failed much later
  // for a reason nobody had caused. SQLite cannot answer "is this open but idle".
  //
  // The real hazard is answerable though: is the daemon running? That is a process
  // question, not a database one.
  const holder = isDaemonRunning();
  if (holder && !force)
    return { ok: false, why: `the reeve daemon is running (${holder}) — stop it first: touch ~/.reeve/HALT, or pass force if you are certain` };

  try {
    for (const s of ["-wal", "-shm"]) { try { rmSync(dbPath + s, { force: true }); } catch {} }
    copyFileSync(snapshotPath, dbPath);
  } catch (e) { return { ok: false, why: `could not restore: ${e.message}` }; }
  return { ok: true, why: null };
}

/**
 * Is reeve's daemon running? Returns a short description, or null.
 *
 * A process question rather than a database one, because the database cannot
 * answer it: an idle connection does not hold a lock that a probe can see.
 */
function daemonRunning() {
  try {
    const out = execFileSync("pgrep", ["-fl", "bin/reeve run"], { encoding: "utf8" }).trim();
    return out ? out.split("\n")[0].slice(0, 80) : null;
  } catch { return null; }   // pgrep exits 1 when nothing matches
}

/** The event log as JSONL, for reading and for moving between machines. */
export function exportEvents(db, path, { sinceSeq = 0 } = {}) {
  try {
    const text = exportJsonl(db, { sinceSeq });
    writeFileSync(path, text);
    return { ok: true, count: text ? text.trimEnd().split("\n").length : 0, path };
  } catch (e) { return { ok: false, why: e.message }; }
}
