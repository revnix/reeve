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
import { mkdirSync, existsSync, copyFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { open as openStore, exportJsonl } from "./db/ops.mjs";

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
  if (existsSync(path)) return { ok: true, path, why: "already taken this second" };
  try {
    // Quoted and escaped: a path is data here, not syntax.
    db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  } catch (e) { return { ok: false, path: null, why: `could not snapshot: ${e.message}` }; }

  prune(dir, keep);
  return { ok: true, path, why: null };
}

/**
 * Keep the newest few. A backup directory that grows without bound fills the disk
 * of the machine that is already the single point of failure.
 */
function prune(dir, keep) {
  try {
    const files = readdirSync(dir).filter(f => /^\d+\.db$/.test(f))
      .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
    for (const f of files.slice(keep)) rmSync(join(dir, f), { force: true });
  } catch { /* pruning must never take the loop down */ }
}

/** The newest snapshot for a repository, or null. */
export function latestSnapshot(root, nwo) {
  const dir = join(root, slug(nwo));
  try {
    const files = readdirSync(dir).filter(f => /^\d+\.db$/.test(f))
      .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
    return files.length ? join(dir, files[0]) : null;
  } catch { return null; }
}

/**
 * Put a snapshot back.
 *
 * Refuses to overwrite an existing store unless told to: restoring over a live
 * database silently discards whatever it learned since the snapshot, and that is
 * exactly the mistake someone makes at 2am while trying to fix something else.
 *
 * The snapshot is opened and read before it is trusted, because a file that is
 * the right size and the wrong contents restores just as easily as a good one.
 */
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
