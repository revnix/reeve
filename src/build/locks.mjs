// locks -- the three things that stop two writers from believing they are one.
//
// singleton_lease: one builder process, enforced by a row rather than by an OS
// lock, because the service manager's instance and a founder's terminal
// instance do not share a lock namespace on every platform this has to run on.
//
// writer_lease: every CLI command that writes the hub holds one for its
// duration, so restore can answer "is anything writing right now" without
// asking SQLite, which cannot distinguish an open-but-idle connection.
//
// maintenance_lock: taken exclusively by restore. Every writer refuses to begin
// while it is held, which closes the window between restore's check and its
// copy -- a command started a moment after the check would otherwise slip in.
//
// Liveness is pid AND lstart, never pid alone: pids are recycled, and a
// recycled pid inheriting a lease is a second builder with the first one's
// authority.
import { hubTx, hubEvent } from "./hubdb.mjs";
import { LEASE_SECONDS, HEARTBEAT_SECONDS } from "../db/ops.mjs";

export { LEASE_SECONDS, HEARTBEAT_SECONDS };

const now = () => Math.floor(Date.now() / 1000);

function holderOf(row, at) {
  return { pid: row.pid, lstart: row.lstart, command: row.command,
           ageSeconds: at - row.acquired_at, expiresAt: row.expires_at };
}

export function acquireSingleton(db, { name, pid, lstart, command, isAlive, at = now(), takeover = false }) {
  return hubTx(db, () => {
    // Same rule as every provider mutation and every CLI writer: nothing begins
    // a write while a live restore holds the lock. Without it a builder can
    // start after restoreHub's holder scan, take the singleton, and begin
    // ticking against a database that is about to be replaced underneath it.
    // Round 2 applied this to the provider path and stopped there; it is a
    // property of every hub writer, not of that one path.
    assertWritable(db, { isAlive, at, inTx: true });
    const row = db.prepare("SELECT * FROM singleton_lease WHERE name=?").get(name);
    const mine = row && row.pid === pid && row.lstart === lstart;
    const expired = row && row.expires_at <= at;
    const holderDead = row && !isAlive(row.pid, row.lstart);

    // Refuse when someone else holds it and is either unexpired or still alive.
    // "Expired" alone is not enough: a busy process can miss a heartbeat, and
    // killing its authority while it is mid-effect is the race, not the fix.
    //
    // --takeover waives the expiry half and ONLY that half. A dead holder with a
    // live lease is the case it exists for: the process is provably gone, so
    // waiting out two more minutes protects nobody. It never waives holderDead,
    // because that is the half that answers "is anyone still there".
    if (row && !mine && !((expired || takeover) && holderDead)) {
      return { ok: false, holder: holderOf(row, at),
               recovery: `reeve build run --takeover   (only after confirming pid ${row.pid} is dead)` };
    }
    db.prepare(`INSERT INTO singleton_lease(name,pid,lstart,command,acquired_at,expires_at)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(name) DO UPDATE SET pid=excluded.pid, lstart=excluded.lstart,
                  command=excluded.command, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at`)
      .run(name, pid, lstart, command, mine ? (row?.acquired_at ?? at) : at, at + LEASE_SECONDS);
    hubEvent(db, { kind: "lease.singleton.granted", payload: { name, pid, lstart, takeover: Boolean(row && !mine) } });
    return { ok: true };
  });
}

/** False means the row is no longer ours; the caller must stop the loop. */
export function heartbeatSingleton(db, { name, pid, lstart, at = now() }) {
  return hubTx(db, () => {
    const r = db.prepare(`UPDATE singleton_lease SET expires_at=? WHERE name=? AND pid=? AND lstart=?`)
      .run(at + LEASE_SECONDS, name, pid, lstart);
    return r.changes === 1;
  });
}

export function releaseSingleton(db, { name, pid, lstart }) {
  return hubTx(db, () => {
    const r = db.prepare("DELETE FROM singleton_lease WHERE name=? AND pid=? AND lstart=?").run(name, pid, lstart);
    if (r.changes) hubEvent(db, { kind: "lease.singleton.released", payload: { name, pid, lstart } });
    return r.changes === 1;
  });
}

/**
 * Hold a writer lease for one command. Always released, including on a throw:
 * a wedged lease would make restore refuse forever for a command that is long
 * since gone.
 */
export function withWriterLease(db, { command, pid, lstart, isAlive, at = now() }, fn) {
  const id = `${pid}:${lstart}:${at}:${Math.trunc(at * 1000) % 1000}`;
  // The check and the insert are ONE transaction. Split across two, a restore can
  // take maintenance_lock in the gap: this command sees a writable hub, the
  // restore sees no writer lease, and both proceed -- the file is replaced under
  // a command that is mid-write. BEGIN IMMEDIATE holds the write lock across both
  // halves, so whichever arrives first makes the other wait and then fail.
  hubTx(db, () => {
    assertWritable(db, { isAlive, at, inTx: true });
    db.prepare(`INSERT INTO writer_lease(id,pid,lstart,command,acquired_at,expires_at) VALUES(?,?,?,?,?,?)`)
      .run(id, pid, lstart, command, at, at + LEASE_SECONDS);
  });
  try { return fn(); }
  finally { hubTx(db, () => db.prepare("DELETE FROM writer_lease WHERE id=?").run(id)); }
}

/** Live writers, for restore's refusal message. Dead ones are reaped as seen. */
export function liveWriters(db, { isAlive, at = now() }) {
  return hubTx(db, () => {
    const live = [];
    for (const r of db.prepare("SELECT * FROM writer_lease").all()) {
      if (isAlive(r.pid, r.lstart)) live.push(r);
      else db.prepare("DELETE FROM writer_lease WHERE id=?").run(r.id);
    }
    return live;
  });
}

export function acquireMaintenanceLock(db, { pid, lstart, isAlive, at = now() }) {
  return hubTx(db, () => {
    const row = db.prepare("SELECT * FROM maintenance_lock WHERE name='restore'").get();
    if (row && isAlive(row.pid, row.lstart) && !(row.pid === pid && row.lstart === lstart))
      return { ok: false, holder: { pid: row.pid, lstart: row.lstart } };
    db.prepare(`INSERT INTO maintenance_lock(name,pid,lstart,acquired_at) VALUES('restore',?,?,?)
                ON CONFLICT(name) DO UPDATE SET pid=excluded.pid, lstart=excluded.lstart, acquired_at=excluded.acquired_at`)
      .run(pid, lstart, at);
    return { ok: true };
  });
}

export function releaseMaintenanceLock(db, { pid, lstart }) {
  return hubTx(db, () => db.prepare("DELETE FROM maintenance_lock WHERE name='restore' AND pid=? AND lstart=?").run(pid, lstart).changes === 1);
}

/**
 * Throws while a LIVE restore holds the lock. A lock left by a crashed restore
 * is reaped exactly like any lease -- honouring it forever would turn one
 * crashed command into a permanently read-only hub.
 *
 * `inTx` is passed by callers already inside a transaction, so the reap below
 * joins theirs rather than opening a nested one (node:sqlite throws on a nested
 * BEGIN). It is not an optional safety switch -- the check runs identically
 * either way; only the transaction it runs in differs.
 */
/**
 * The columns `assertWritable` reads. Part of the guardian's required surface.
 *
 * A hub missing `name` makes every provider mutation throw -- into the daemon's
 * unscheduled fail-open path. Missing `pid` or `lstart` is worse and quieter:
 * `isAlive(undefined, undefined)` answers false, so a LIVE restore's lock reads
 * as dead, is reaped, and a concurrent mutation proceeds against a hub that is
 * being replaced underneath it.
 */
// COLUMN TO DECLARED TYPE, for the same reason as the scheduler's own tables:
// `maintenance_lock` is STRICT, so a wrong declared type passes a name check and
// refuses the write.
export const LOCK_COLUMNS = Object.freeze({ name: "TEXT", pid: "INTEGER", lstart: "TEXT" });

export function assertWritable(db, { isAlive, at = now(), inTx = false }) {
  const row = db.prepare("SELECT * FROM maintenance_lock WHERE name='restore'").get();
  if (!row) return;
  if (!isAlive(row.pid, row.lstart)) {
    const reap = () => db.prepare("DELETE FROM maintenance_lock WHERE name='restore'").run();
    if (inTx) reap(); else hubTx(db, reap);
    return;
  }
  throw new Error(`a restore is in progress (pid ${row.pid}, started ${row.lstart}); the hub is read-only until it finishes`);
}
