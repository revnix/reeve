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
import { mkdirSync, existsSync, copyFileSync, readdirSync, rmSync, writeFileSync, linkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { open as openStore, exportJsonl } from "./db/ops.mjs";
// Task 8's subset. `TABLES_AT` and `HUB_TABLES` are what a snapshot's table set
// is validated against; Task 9 adds the locks, replay and hubEvent imports when
// `restoreHub` needs them, and not before -- ESM resolves at instantiation, so
// naming a module that does not exist yet breaks every import of this file.
import { openHub, HUB_SCHEMA_VERSION, HUB_TABLES, TABLES_AT } from "./build/hubdb.mjs";
// Task 9's additions. `restoreHub` takes the maintenance lock before it refuses,
// enumerates live writers to name them, and replays the tail -- and it needs
// `replayableKinds`/`NON_REPLAYED_KINDS` to refuse a tail exported by a NEWER
// binary rather than silently rebuilding a log without its projection.
import { acquireMaintenanceLock, releaseMaintenanceLock, liveWriters } from "./build/locks.mjs";
import { replayHub, replayableKinds, NON_REPLAYED_KINDS } from "./build/replay.mjs";

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
  // ABANDONED temporaries, from a process killed between `VACUUM INTO` and the
  // publish. Each is a full database copy, and nothing else will ever remove
  // one: `prune` and every candidate reader filter on `/^\d+\.db$/` precisely
  // so a partial file is invisible, and the line above only removes THIS
  // process's own `(epoch, pid)` path. So each interrupted backup leaked a
  // database-sized file for ever, on the disk whose job is holding the backups.
  //
  // The owning pid is in the name, so liveness decides rather than age: a temp
  // whose process is gone is abandoned, and one whose process is running might
  // be mid-VACUUM. `kill(pid, 0)` only asks whether the pid exists, and a
  // REUSED pid simply means the file is not reaped this time -- leaking is the
  // safe direction, deleting a live writer's temp is not.
  try {
    for (const f of readdirSync(dir)) {
      const m = /^\.(\d+)\.(\d+)\.tmp$/.exec(f);
      if (!m) continue;
      const owner = Number(m[2]);
      if (owner === process.pid) continue;              // ours, handled above
      try { process.kill(owner, 0); continue; }          // still running: leave it
      catch (e) { if (e.code === "EPERM") continue; }    // exists, not ours to judge
      rmSync(join(dir, f), { force: true });
    }
  } catch { /* reaping is housekeeping and must never fail a backup */ }
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
        // `ok: true`, and this REVERSES an earlier choice in this PR.
        //
        // It was `ok: false` on the reasoning that a loser cannot vouch for a
        // file it did not write -- which is true, and is not the question `ok`
        // is asked. Every programmatic consumer asks `ok` one thing: "is this a
        // failure I should act on". Two independent callers then got it wrong
        // the same way: `bin/reeve` exited non-zero on a benign same-second
        // race, and `src/daemon.mjs:1314` logged `backup FAILED` for it on the
        // automatic path -- a false alert on the one signal that has to stay
        // trustworthy.
        //
        // Two callers making the same mistake is not two bugs, it is a field
        // whose meaning does not match its use. So `ok` now means "not a
        // failure", which is safe by DEFAULT for a caller that checks nothing
        // else, and the distinction moves to `outcome` for anyone who wants it.
        results.push({ nwo, ...taken, ok: true, outcome: "deferred", deferred: true, escalate: null,
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
          results.push({ nwo, ok: false, outcome: "failed", escalate: "builder:backup:failed",
                         why: `snapshot failed validation and was deleted: ${v.why}` });
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
      results.push({ nwo, outcome: taken.ok ? "taken" : "failed", ...taken });
    } catch (e) {
      results.push({ nwo, ok: false, outcome: "failed", escalate: "builder:backup:failed",
                     why: `could not open ${path}: ${e.message}` });
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

/**
 * Put a hub snapshot back.
 *
 * The existing restore() asks a process question -- is `bin/reeve run` alive --
 * because for a per-repo store the daemon is the only writer. The hub has
 * three kinds of writer and pgrep can see none of them properly: the builder
 * holds a singleton lease row, every hub-writing CLI command holds a writer
 * lease for its duration, and a GUARDIAN holds a provider lease whenever it is
 * dispatching a worker. So the refusal is asked of the database.
 *
 * The maintenance lock is taken FIRST and released last. Without it there is a
 * window between the check and the copy, and a command started inside that
 * window writes into a file that is about to be replaced underneath it.
 */
export function restoreHub(snapshotPath, dbPath, { isAlive, pid, lstart, force = false, tail: suppliedTail = null } = {}) {
  if (!existsSync(snapshotPath)) return { ok: false, why: `no snapshot at ${snapshotPath}`, holders: [] };

  // DEEP, and worth every millisecond: this file is about to replace the live
  // hub, and a page-level fault found afterwards is found with nothing to fall
  // back to.
  const v = validateSnapshot(snapshotPath, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep: true });
  if (!v.ok) return { ok: false, why: `the snapshot is not restorable: ${v.why}`, holders: [] };

  const snapSeq = (() => {
    const p = new DatabaseSync(snapshotPath, { readOnly: true });
    try { return p.prepare("SELECT COALESCE(max(seq),0) s FROM hub_event").get().s; } finally { p.close(); }
  })();

  let live = null, locked = false, lockDb = null, quarantined = null, synthetic = false, swapped = false;
  const staging = dbPath + ".restoring";
  // The raw open AND the first query, together. Either can throw on a file that
  // is corrupt enough, and the branch below used to do them as two statements
  // with nothing between -- so the throw escaped to the outer catch and the
  // command reported a failure instead of performing the recovery it exists for.
  const rawOpen = (p) => {
    let d = null;
    try {
      d = new DatabaseSync(p, { timeout: 10000 });
      const v = d.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
      // A store with NO COMPLETED MIGRATION is not readable for this command's
      // purposes, whatever the version query says. `openHub` creates
      // `schema_version` as plain DDL, committed before migration 1's
      // transaction, so an interrupted first run leaves a file where that query
      // succeeds and returns 0 -- while `maintenance_lock`, `singleton_lease`
      // and every other table this function goes on to query do not exist.
      // Classified as readable, `restore --hub` then dies with
      // `no such table: maintenance_lock` instead of installing a snapshot it
      // has already validated, which is the exact state this command exists to
      // recover from.
      //
      // Same invariant as `build run`'s bootstrap test: existence is not
      // readiness, and neither is openability.
      if (v < 1) { try { d.close(); } catch {} return null; }
      return d;
    } catch { try { d?.close(); } catch {} return null; }
  };
  // PRESERVE THE SIDECARS BEFORE ANY OPEN ATTEMPT, because the open is what
  // destroys them.
  //
  // Measured: `new DatabaseSync(corruptFile)` fails with `file is not a
  // database`, and CLOSING that failed handle deletes `-wal` and `-shm`. So by
  // the time this function has established the hub is unreadable, the WAL it
  // most wants to keep is already gone -- and nothing here removed it. SQLite
  // did, on close, inside `rawOpen`'s own cleanup.
  //
  // That matters because a WAL holds committed pages that were never
  // checkpointed into the main file, so after the crash that made this recovery
  // necessary it can be the ONLY copy of the newest events. "The unreadable
  // database is kept at <path>" was a half-truth: the main file was kept and the
  // rest was destroyed a few statements earlier.
  //
  // Copied aside first, then either promoted into the quarantine or discarded
  // once the store proves readable. Only the sidecars are copied, never the
  // database, so a healthy restore pays almost nothing for this.
  const preservedSidecars = [];
  for (const ext of ["-wal", "-shm"]) {
    if (!existsSync(dbPath + ext)) continue;
    const aside = `${dbPath}${ext}.preserved-${pid}`;
    try { copyFileSync(dbPath + ext, aside); preservedSidecars.push([ext, aside]); } catch {}
  }
  try {
    // When dbPath is ABSENT -- the destructive drill's case, and a real total
    // loss -- the holder scan is skipped and NO lock exists at the canonical
    // path while the snapshot is copied and replayed into staging. A
    // service-manager restart or a CLI write landing in that window creates a
    // fresh hub at dbPath which the rename then silently destroys. So an absent
    // hub gets a minimal one created first, purely to hold the lock.
    if (!existsSync(dbPath)) {
      // SYNTHETIC, and tracked as such. This file exists only to carry the
      // maintenance lock while the real one is staged; nothing has restored
      // into it. If staging or replay then fails -- a malformed supplied tail
      // is the likely case, and this is the total-loss path where an operator
      // supplies one by hand -- the function returns failure, releases the
      // lock, and used to leave a fully migrated EMPTY hub at the canonical
      // path. A restarted builder finds a healthy-looking store with no state
      // in it, which is worse than finding nothing: nothing is obviously wrong.
      synthetic = true;
      live = openHub(dbPath);
      // The result is CHECKED here too. Two restores started after a total loss
      // both pass the existsSync above, both race through openHub, and one of
      // them loses the lock -- and an ignored `{ ok: false }` let the loser mark
      // itself `locked` and stage a replacement against the same path as the
      // winner. This branch is where a race is MOST likely, because "the hub is
      // gone" is exactly when two people start a restore.
      const got = acquireMaintenanceLock(live, { pid, lstart, isAlive });
      if (!got.ok) {
        // `synthetic` AUTHORISES DELETION in the finally, and a loser has no
        // such authority. Both restores observed `dbPath` absent and both got
        // here, but only one holds the lock -- and it holds it IN THIS FILE,
        // with the file open. Leaving the flag set made the loser unlink the
        // winner's database: on POSIX the winner keeps writing to an inode with
        // no name while the canonical path sits empty, so a builder starting in
        // that window creates a fresh hub there and the winner's eventual swap
        // silently discards it.
        //
        // The flag means "this invocation created it AND owns it", which is what
        // the finally assumes. Winning the lock is the only proof of ownership
        // available, so it is the thing that sets it.
        synthetic = false;
        return { ok: false, why: `another restore is running (pid ${got.holder.pid})`, holders: [got.holder] };
      }
      locked = true;
    } else if ((live = rawOpen(dbPath)) === null) {
      // EXISTS, and UNREADABLE. This is the state the route's own description
      // names -- recovering a hub "too corrupt to open" -- and the readable
      // branch below could never reach it: its first act is to query
      // `schema_version`, so a file too damaged to answer threw straight past
      // every recovery path to the outer catch. `restore --hub --tail <export>`,
      // the one command for exactly this situation, could not run.
      //
      // Three things the readable path takes from the live file are unavailable
      // here, and each needs an answer rather than a silent skip:
      //
      // 1. EXCLUSION. `maintenance_lock` lives INSIDE the hub. So the lock moves
      //    to a sibling at a CANONICAL path -- `<dbPath>.restore-lock`, a fixed
      //    name, not a temporary -- opened as its own store and taken with the
      //    same `acquireMaintenanceLock` call, so two concurrent restores of an
      //    unreadable hub still contend for one row.
      // 2. THE HOLDER SCAN. `singleton_lease`, `liveWriters` and `provider_lease`
      //    are all unreadable, so no holder can be enumerated and none can be
      //    ruled out. The command therefore REFUSES unless `force` is passed.
      //    Note this INVERTS the readable path's rule, deliberately: there,
      //    `force` is refused while a holder is provably alive, because the
      //    evidence exists; here it is REQUIRED, because it cannot, and the
      //    operator is the only one who can say the daemons are stopped.
      // 3. THE FORWARD-VERSION REFUSAL. Unreadable means the version is UNKNOWN,
      //    not that it is old, so that check cannot be evaluated at all. The
      //    snapshot's version was already checked against HUB_SCHEMA_VERSION at
      //    the top of this function, which is the store about to be installed
      //    and is readable -- that is the guarantee that survives here.
      if (!force)
        return { ok: false, holders: [],
                 why: `the hub at ${dbPath} exists but cannot be read, so its live writers cannot be ` +
                      `enumerated and none can be ruled out. Stop the builder and any reeve CLI, then ` +
                      `re-run with force. Pass --tail from a durable export-events --hub to carry ` +
                      `forward everything after the snapshot; without one, events since ${snapSeq} are lost.` };
      lockDb = openHub(dbPath + ".restore-lock");
      const got = acquireMaintenanceLock(lockDb, { pid, lstart, isAlive });
      if (!got.ok) return { ok: false, why: `another restore is running (pid ${got.holder.pid})`, holders: [got.holder] };
      locked = true;
      // QUARANTINE, never delete: the unreadable file is the only evidence of
      // what went wrong, and a recovery that destroys it leaves nothing to
      // diagnose. But the NAME is chosen here and the move happens later, one
      // step before the staged copy takes the path.
      //
      // Renaming now would vacate the canonical path for the whole of staging --
      // the copy, the open, the migration and the replay. Any failure in that
      // window (a malformed supplied tail makes `replayHub` throw, and the
      // operator on this path is supplying one by hand) returns through the
      // catch, the finally deletes staging, and NOTHING moves the quarantine
      // back: `dbPath` is simply absent, and the next writer to start creates a
      // fresh empty hub there. Losing a corrupt database to a failed recovery is
      // bad; replacing it with an empty one that looks healthy is worse.
      quarantined = `${dbPath}.corrupt-${Math.floor(Date.now() / 1000)}`;
      // `live` stays null, which the tail read below already handles: with no
      // readable hub, `suppliedTail` is the ONLY source of post-snapshot events.
    } else {
      // RAW DatabaseSync, not openHub. openHub applies forward migrations, and
      // migrating a database is a write -- so opening that way would upgrade a
      // hub that a builder or a CLI is actively using, before this command has
      // established it is allowed to touch it at all. The exclusion has to come
      // before any write, including a well-intentioned one.
      // (already opened by `rawOpen` above, which is also what proved it readable)
      // A RAW open skips openHub's forward-version refusal, so this command must
      // repeat it before it touches anything. Without it an older binary can
      // restore beside a hub a newer binary already migrated: it collects event
      // kinds it does not recognise, `replayHub` counts them as skipped, and the
      // newer database is replaced by one built only through the old binary's
      // migrations -- state lost, exit status 0.
      //
      // Before the lock and before staging: refusing after either has already
      // interfered with a database this binary has just established it must not
      // touch.
      const liveVersion = live.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
      if (liveVersion > HUB_SCHEMA_VERSION) {
        try { live.close(); } catch {}
        return { ok: false, holders: [],
                 why: `the live hub is at schema version ${liveVersion} and this reeve knows ` +
                      `${HUB_SCHEMA_VERSION}; restoring would replace it with an older store. Upgrade reeve.` };
      }
      const got = acquireMaintenanceLock(live, { pid, lstart, isAlive });
      if (!got.ok) return { ok: false, why: `another restore is running (pid ${got.holder.pid})`, holders: [got.holder] };
      locked = true;

      // The SAME refusal again, now that the lock is held. The read above is a
      // fast, clear message; this is the one that holds under a race, and it is
      // the same two-check shape `openHub` uses for exactly the same reason.
      //
      // Once migration 2 exists, an older restore can read version 1 here, then
      // wait on this lock while a newer builder takes the singleton and migrates
      // the hub. If that builder then exits -- cleanly or not -- the holder scan
      // below finds nothing alive, the restore proceeds, and a version-2 hub is
      // replaced by a version-1 snapshot. Every check passed; the state is gone.
      // A pre-lock read cannot close that window, because the window is exactly
      // the wait for the lock.
      const lockedVersion = live.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
      if (lockedVersion > HUB_SCHEMA_VERSION)
        return { ok: false, holders: [],
                 why: `the live hub was migrated to schema version ${lockedVersion} while this restore ` +
                      `waited for the maintenance lock; this reeve knows ${HUB_SCHEMA_VERSION}. ` +
                      `Restoring would replace it with an older store. Upgrade reeve.` };

      const holders = [];
      for (const r of live.prepare("SELECT * FROM singleton_lease").all())
        if (isAlive(r.pid, r.lstart)) holders.push({ what: "builder", pid: r.pid, lstart: r.lstart, command: r.command });
      for (const r of liveWriters(live, { isAlive }))
        holders.push({ what: "cli", pid: r.pid, lstart: r.lstart, command: r.command });
      for (const r of live.prepare("SELECT * FROM provider_lease WHERE status='held'").all())
        if (isAlive(r.pid, r.lstart)) holders.push({ what: r.owner, pid: r.pid, lstart: r.lstart, command: r.run_ref });

      // `force` overrides the operator-judgement half of this check, never the
      // safety half. A live builder or CLI writer holds a descriptor to the file
      // being replaced and carries on issuing external effects against a
      // database that no longer exists; no flag makes that safe, and the whole
      // point of the maintenance lock is that no writer is running here. So
      // force is refused outright while anything is provably alive — it is for
      // clearing holders whose processes are already gone.
      if (holders.length && force)
        return { ok: false, holders,
          why: `force does not override a LIVE holder; it only clears dead ones. Still running:\n` +
               holders.map(h => `  ${h.what.padEnd(8)} pid ${h.pid} (started ${h.lstart})  ${h.command}`).join("\n") +
               `\n  stop them, then re-run.` };
      if (holders.length && !force) {
        return { ok: false, holders,
          why: `the hub has live writers; stop them first:\n` +
               holders.map(h => `  ${h.what.padEnd(8)} pid ${h.pid} (started ${h.lstart})  ${h.command}`).join("\n") +
               `\n  a guardian holds a provider lease whenever it is dispatching a worker, so a busy ` +
               `guardian is a normal reason to see this. STOP the processes above and re-run.` +
               // NOT "or pass force". The branch immediately above refuses every
               // forced restore while any holder is provably alive, so an
               // operator following that advice got a second refusal and no way
               // forward -- a recovery instruction that cannot recover. `force`
               // is for holders whose processes are already gone, and for the
               // unreadable-hub path where liveness cannot be established at all.
               `\n  force does not override a live holder; it only clears dead ones.` };
      }
    }

    // The tail arrives two ways and both are real: read from the live file when
    // it is still readable, or supplied from a durable `export-events --hub`
    // when it is gone -- which is what "destructive" means. Either way it is
    // FILTERED to events after the snapshot's own max seq: the export command
    // writes the whole log from seq 1, and replaying pre-snapshot rows would
    // re-apply row images the snapshot already contains, in an order the
    // snapshot has already superseded.
    // CAPTURED HERE, before anything clears `live`. Computing it at the return
    // read a handle that the sidecar cleanup below sets to null on every
    // successful restore, so the flag was false on the readable path too -- and
    // the CLI printed the data-loss warning after a recovery that had inspected
    // and replayed the live tail perfectly.
    const liveTailRead = suppliedTail == null && live != null;
    const rawTail = suppliedTail ?? (live
      ? live.prepare("SELECT seq, at, kind, task, payload FROM hub_event WHERE seq > ? ORDER BY seq").all(snapSeq)
      : []);
    const tail = rawTail.filter(e => e.seq > snapSeq).sort((a, b) => a.seq - b.seq);
    // A SUPPLIED tail is checked for holes and duplicates before anything is
    // replayed. The live-read tail cannot have either -- it comes straight off
    // `hub_event`, whose seq is a primary key -- but `--tail` is a file an
    // operator hands over, and the likely damage to a JSONL export is a partial
    // copy. Two failures, both silent:
    //
    //   a MISSING seq drops whatever projection row it carried, and the restore
    //   reports success, so an authority-bearing row is gone with nothing saying
    //   so;
    //
    //   a DUPLICATE seq replays two payloads into the projection while
    //   `INSERT ... ON CONFLICT(seq) DO NOTHING` keeps only the first in
    //   `hub_event` -- so the log and the tables disagree afterwards, and the log
    //   is what every later audit reads.
    //
    // Contiguity is checkable without a manifest because the tail's own first
    // seq must follow the snapshot's max.
    if (suppliedTail) {
      // The FOOTER first. Contiguity finds holes in the middle and cannot see a
      // file that simply stops early -- the remaining run is gapless, so every
      // check below passes on a tail missing its newest records. The manifest is
      // written last by `export-events --hub`, so its absence IS the truncation
      // signal, and its `count`/`sha256` catch the rarer case of a file that was
      // truncated and then had a footer appended by something else.
      const manifest = suppliedTail.manifest ?? null;
      if (!manifest)
        return { ok: false, holders: [],
                 why: `the supplied tail has no manifest footer, so it cannot be distinguished from ` +
                      `a partial copy that lost its newest events. Re-export it with export-events --hub.` };
      if (manifest.count !== rawTail.length)
        return { ok: false, holders: [],
                 why: `the supplied tail claims ${manifest.count} events and carries ${rawTail.length}; ` +
                      `it is truncated or was edited.` };
      // The DIGEST, which is the check the count cannot make: a file that lost
      // its last event and had its `count` edited to match passes the line above
      // and fails here. `suppliedTail.sha256` is what the READER observed over
      // the raw bytes; `manifest.sha256` is what the exporter CLAIMED. This
      // function never sees the bytes -- by the time it holds parsed events they
      // are gone -- so the two have to arrive separately and be compared here.
      if (typeof suppliedTail.sha256 !== "string")
        return { ok: false, holders: [],
                 why: `the supplied tail carries a manifest but no observed digest, so the manifest cannot ` +
                      `be checked against the bytes it describes. Re-export it with export-events --hub.` };
      if (manifest.sha256 !== suppliedTail.sha256)
        return { ok: false, holders: [],
                 why: `the supplied tail's manifest claims digest ${String(manifest.sha256).slice(0, 12)} and its ` +
                      `own bytes hash to ${suppliedTail.sha256.slice(0, 12)}; it was edited or corrupted in transit.` };
      // `first` and `last` are DECLARED in the footer, so they are CHECKED. A
      // manifest carrying fields nothing reads is a manifest whose other fields
      // nobody has reason to trust either -- and this pair catches a tail that
      // was truncated at the FRONT, which the contiguity walk below reports as a
      // hole against the snapshot rather than as the edit it is.
      if (rawTail.length && (manifest.first !== rawTail[0].seq ||
                             manifest.last !== rawTail[rawTail.length - 1].seq))
        return { ok: false, holders: [],
                 why: `the supplied tail claims seq ${manifest.first}..${manifest.last} and carries ` +
                      `${rawTail[0].seq}..${rawTail[rawTail.length - 1].seq}; it is not the export it says it is.` };
      const seqs = tail.map(e => e.seq);
      const dupes = seqs.filter((s, i) => i > 0 && s === seqs[i - 1]);
      const holes = [];
      for (let i = 1; i < seqs.length; i++)
        for (let v = seqs[i - 1] + 1; v < seqs[i]; v++) holes.push(v);
      if (seqs.length && seqs[0] !== snapSeq + 1)
        holes.push(...Array.from({ length: seqs[0] - snapSeq - 1 }, (_, k) => snapSeq + 1 + k));
      if (dupes.length || holes.length)
        return { ok: false, holders: [],
                 why: `the supplied tail is not a complete run after the snapshot: ` +
                      `${holes.length} missing (${holes.slice(0, 5).join(", ")})` +
                      `${dupes.length ? `, ${dupes.length} duplicated (${dupes.slice(0, 5).join(", ")})` : ""}. ` +
                      `Re-export it; a partial copy restores silently and leaves the log and the ` +
                      `projection disagreeing.` };
    }

    // Build the restored database BESIDE the live one, then move it into place
    // in a single rename. A copy directly over dbPath leaves a window in which
    // the file at the real path is a fresh database carrying the SNAPSHOT's lock
    // state -- which is none -- so any writer starting in that window sees an
    // unlocked hub and writes into it while the replay is still running. There
    // is no such window here: the live file keeps its maintenance lock right up
    // until the instant it is replaced, and rename is atomic.
    // Remove the staging file AND its WAL sidecars. A restore killed after
    // opening the staging database in WAL mode leaves -wal/-shm behind; the next
    // attempt copies a fresh main file over the same path and the stale sidecar
    // is replayed into it on open, which is a silent merge of two restores.
    for (const ext of ["", "-wal", "-shm"]) { try { rmSync(staging + ext, { force: true }); } catch {} }
    copyFileSync(snapshotPath, staging);
    let replayed = 0;
    {
      const back = openHub(staging);
      try {
        // The SNAPSHOT's own maintenance_lock goes first, before this restore
        // tries to take one. A snapshot is taken by a running daemon, so it can
        // contain a lock row whose pid was alive at VACUUM INTO time --
        // `acquireMaintenanceLock` then sees a live-looking foreign holder,
        // returns { ok: false } and writes nothing. That result was ignored, and
        // `maintenance_lock` is deliberately excluded from the clearing below on
        // the grounds that "this restore holds it" -- which it does not. So the
        // staged database was installed carrying a stranger's lock, the release
        // names this restore's pid and cannot remove it, and every subsequent hub
        // writer is refused by a holder that never existed on this machine.
        //
        // Clearing first makes the acquire meaningful, and the result is CHECKED:
        // a lock that cannot be taken on a private staging file this function
        // just created is not a race, it is a broken invariant, and continuing
        // past it replays into a database nothing is protecting.
        back.exec("DELETE FROM maintenance_lock");
        const staged = acquireMaintenanceLock(back, { pid, lstart, isAlive });
        if (!staged.ok)
          return { ok: false, holders: [],
                   why: `could not take the maintenance lock on the staging copy at ${staging}; ` +
                        `refusing to replay into a database this restore does not hold` };

        // Snapshots are taken by the running daemon, so a normal one CONTAINS
        // live-looking process rows: a singleton lease held by a pid that was
        // alive when VACUUM INTO ran, provider leases mid-dispatch, worktree
        // leases. Restoring them resurrects authority that belongs to processes
        // which no longer exist -- the next `build run` is refused by a ghost,
        // and the reaper cannot help because pid+lstart may since have been
        // reused by something unrelated. They are excluded from the comparison
        // set for the same reason; they must be cleared from the restored file
        // as well, not merely ignored when comparing.
        for (const t of ["singleton_lease","writer_lease","directory_lease","provider_lease"])
          back.exec(`DELETE FROM ${t}`);
        // `maintenance_lock` is absent from that list because it was cleared and
        // re-taken ABOVE, before the replay -- so the row present now is this
        // restore's own, and it is released below. The previous version skipped
        // it here while never having acquired it, which is how a stranger's lock
        // reached the installed file.

        // phase_run is NOT a lease table and is not process-scoped as a whole:
        // its SETTLED rows are the attempt history the retry budget counts, so
        // they have to survive. But a normal snapshot is taken by a RUNNING
        // daemon, so it can contain rows still marked `live` or `adopted` whose
        // processes are long gone. Left alone, `one_live_run` refuses the task
        // a replacement attempt forever, and adopt-or-kill reads a dead pid's
        // heartbeat as if it meant something.
        //
        // Settled terminally rather than deleted: deleting them would return an
        // attempt to the budget, so a task that had burned its retries would
        // quietly get them back -- a restore handing out free retries.
        // `killed`, and no `ended_at`. Migration 1 declares neither `lost` nor
        // that column -- statuses are ('live','succeeded','failed','adopted',
        // 'killed') -- and SQLite validates the statement at PREPARE time even
        // when no rows match, so the previous version made EVERY restore fail
        // with `no such column: ended_at` before it replaced anything.
        //
        // `killed` is also the honest reading: adopt-or-kill uses it for a run
        // whose process is gone, and a run that did not survive a restore is
        // exactly that. `outcome` records why, since a killed run with no
        // outcome is indistinguishable from one the reaper ended.
        back.exec(`UPDATE phase_run
                      SET status = 'killed',
                          outcome = COALESCE(outcome, 'lost to a hub restore')
                    WHERE status IN ('live','adopted')`);

        if (tail.length) {
          const r = replayHub(back, tail);
          // `skipped` is CHECKED, not discarded. On the readable-live path an
          // unknown kind cannot appear -- the forward-version refusal above has
          // already established this binary is not older than the store. The
          // unreadable and absent paths have no such guarantee: their tail comes
          // from an `export-events --hub` file that may have been written by a
          // NEWER binary, and every kind it carries that this one does not handle
          // is a projection row that is never rebuilt. The restored `hub_event`
          // log would then describe state the tables do not contain, and the
          // command would exit 0.
          //
          // Declared-unreplayed kinds are not skips: `replayHub` counts them as
          // skipped because it has no handler, and that is exactly right for
          // them. So the refusal is over kinds that are neither handled NOR in
          // NON_REPLAYED_KINDS -- the same predicate Task 11's cross-check uses,
          // and the reason that constant is exported rather than internal.
          const known = new Set([...replayableKinds(), ...NON_REPLAYED_KINDS]);
          const unknown = [...new Set(tail.map(e => e.kind))].filter(k => !known.has(k));
          if (unknown.length)
            return { ok: false, holders: [],
                     why: `the tail carries ${unknown.length} event kind(s) this reeve does not know ` +
                          `(${unknown.slice(0, 5).join(", ")}); it was exported by a newer binary and ` +
                          `replaying it would rebuild the log without the projection. Upgrade reeve.` };
          replayed = r.applied;
        }
        releaseMaintenanceLock(back, { pid, lstart });
      } finally { back.close(); }
    }

    // Close the live handle BEFORE removing its sidecars, and treat a failed
    // removal as fatal rather than swallowing it: a -wal left beside a replaced
    // main file is replayed into the new database on the next open, which is a
    // silent merge of two unrelated stores.
    // QUARANTINE FIRST, and WITH its sidecars. The removal below deletes
    // `-wal`/`-shm`, and the copy used to happen after it -- so the quarantine
    // an operator was handed was the main file alone.
    //
    // That is worst on exactly the path that produces a quarantine. A WAL holds
    // committed pages that have not been checkpointed into the main file yet,
    // so after the crash that made this recovery necessary it can be the ONLY
    // copy of the newest events. Deleting it first turned "the damaged database
    // is kept at <path>" into a half-truth and destroyed history that a
    // determined operator could otherwise have read out.
    //
    // On the unreadable path `live` is already null, so there is no handle to
    // close before copying; the copy is forensic either way.
    if (quarantined) {
      copyFileSync(dbPath, quarantined);
      // From the ASIDE copies, not from `dbPath + ext`: those are gone by now,
      // deleted by SQLite when the failed open was closed.
      for (const [ext, aside] of preservedSidecars)
        try { copyFileSync(aside, quarantined + ext); } catch {}
    }
    try { live?.close(); live = null; locked = false; } catch {}
    for (const ext of ["-wal", "-shm"]) {
      try { rmSync(dbPath + ext, { force: true }); }
      catch (e) { return { ok: false, holders: [],
        why: `could not remove ${dbPath}${ext} (${e.message}); refusing to replace the database, ` +
             `because a stale write-ahead log beside a restored file is replayed into it on the next open` }; }
    }
    // COPY to quarantine, then let the staging rename REPLACE the original. The
    // path is never unoccupied at all.
    //
    // Two adjacent renames still leave a window, and it is not benign: hub
    // writers check `maintenance_lock` in the CANONICAL database and know
    // nothing about the sibling `.restore-lock`. A service restart or a CLI
    // landing between them finds `dbPath` absent, creates a fresh hub, opens it,
    // and goes on writing to that inode after the second rename has replaced its
    // pathname -- split brain, with both halves reporting success. The lock
    // cannot close it, because the lock lives in the file that is missing.
    //
    // Copying costs one file's worth of I/O on a path that has already copied a
    // whole snapshot, and it removes the window rather than narrowing it. The
    // rename that follows is atomic, so a writer either has the corrupt original
    // or the restored replacement and never neither.
    // (the quarantine copy happened above, before the sidecars were removed)
    renameSync(staging, dbPath);
    swapped = true;                    // past here the file at dbPath is the restored one
    // `quarantined` is REPORTED, not merely done. When the live hub was
    // unreadable it was moved aside rather than deleted, and this result is the
    // only place its path is ever named -- an operator who is not told where the
    // broken file went cannot diagnose what happened, and the next restore's
    // quarantine will not overwrite it either, so copies accumulate in silence.
    // Null on every ordinary restore.
    // `liveTailRead` is REPORTED, not inferred by the caller. Whether a live tail
    // could be read is something only this function knows -- the CLI was left
    // guessing at it from `quarantined` and a lock file, which is two proxies for
    // one fact and both wrong when the hub was simply absent.
    return { ok: true, why: null, holders: [], replayed, tail: tail.length, quarantined,
             liveTailRead };
  } catch (e) {
    return { ok: false, why: `could not restore: ${e.message}`, holders: [] };
  } finally {
    // The lock lives in ONE of two places: inside the live hub on the ordinary
    // path, or in the sibling `.restore-lock` store when the hub was unreadable.
    // Releasing only the first leaves an unreadable-hub restore holding its lock
    // forever -- and because that lock sits at a CANONICAL path, every later
    // attempt then refuses with "another restore is running", naming a pid that
    // exited long ago.
    if (locked && live)   { try { releaseMaintenanceLock(live,   { pid, lstart }); } catch {} }
    if (locked && lockDb) { try { releaseMaintenanceLock(lockDb, { pid, lstart }); } catch {} }
    try { live?.close(); } catch {}
    try { lockDb?.close(); } catch {}
    try { rmSync(staging, { force: true }); } catch {}
    // The aside copies are housekeeping: promoted into the quarantine above when
    // there was one, and discarded either way so a healthy restore leaves no
    // litter beside the hub.
    for (const [, aside] of preservedSidecars) { try { rmSync(aside, { force: true }); } catch {} }
    // The synthetic hub goes with the failure that stranded it. Only when it was
    // synthetic AND the swap never happened: a successful restore replaced it,
    // and a real pre-existing hub is never this function's to delete.
    if (synthetic && !swapped) {
      for (const ext of ["", "-wal", "-shm"]) { try { rmSync(dbPath + ext, { force: true }); } catch {} }
    }
    // The quarantine is a COPY, made one step before the swap, so a failure
    // before that point never created one and there is nothing to undo. A
    // failure AFTER it means the swap succeeded, and the copy is the evidence an
    // operator was promised. Neither case deletes it -- which is why copying is
    // also simpler than moving: there is no rollback to get wrong.
  }
}
