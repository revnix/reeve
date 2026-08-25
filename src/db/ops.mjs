import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { CHECK_ACCOUNTING } from "../github/reconciler.mjs";
import { hostname } from "node:os";
import { createHash } from "node:crypto";

export const LEASE_SECONDS = 120;      // short: heartbeat is cheap, reaping should be fast
export const HEARTBEAT_SECONDS = 30;   // renew at 1/4 lease

/**
 * Columns added to tables that already exist.
 *
 * schema.sql is entirely CREATE ... IF NOT EXISTS, which adds a new TABLE to an
 * existing database and does NOTHING for a new column, because the table is
 * already there. That gap was found only when `settlement.accounting` failed to
 * appear on the live store -- the next daemon start would have thrown on a
 * database holding a thousand events of real history.
 *
 * Additive and defaulted only. Anything that rewrites data belongs in a
 * deliberate migration, not in the connection path.
 */
const ADDED_COLUMNS = [
  ["settlement", "accounting", "INTEGER NOT NULL DEFAULT 0"],
  // What the last worker said it needed a human FOR. Carried so the escalation
  // after the retry cap can say why no fix was possible, rather than claiming a
  // fix was tried and survived when the worker never attempted one.
  ["fix_attempt", "note", "TEXT"],
  // The outbox fence. Additive and defaulted, so it lands on a populated table:
  // every existing row starts at 0 and the first lease bumps it to 1, which is
  // correct -- an unleased row has no holder to fence out. `RESHAPED` is for a
  // changed UNIQUE constraint and refuses a non-empty table; this is neither.
  ["outbox", "lease_token", "INTEGER NOT NULL DEFAULT 0"],
];

function addMissingColumns(db) {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    let names;
    try { names = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
    catch { continue; }
    // No rows means the table does not exist; schema.sql has just created it with
    // the column already present, so there is nothing to add.
    if (!names.length || names.includes(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/**
 * Tables whose SHAPE changed, not just their columns.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, and ALTER cannot
 * change a UNIQUE constraint, so a table that gained a new key needs rebuilding.
 * inbox went from UNIQUE(source, external_id) to UNIQUE(source, external_id,
 * content_hash) so an edited comment appends a generation instead of silently
 * doing nothing.
 *
 * Rebuilt ONLY when empty. Every live store held zero inbox rows when this
 * shipped -- the table had been designed and never written to -- so this is free
 * today. If some future store has rows, it REFUSES rather than copying between
 * shapes it cannot reason about: a migration nobody has thought about is not
 * something to invent silently at open() time.
 */
const RESHAPED = [
  { table: "inbox", requires: "content_hash" },
];

function reshapeTables(db) {
  for (const { table, requires } of RESHAPED) {
    let cols;
    try { cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
    catch { continue; }
    if (!cols.length || cols.includes(requires)) continue;   // absent or already right
    const n = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    if (n > 0) {
      throw new Error(
        `${table} has the old shape and ${n} row(s). Refusing to rebuild it at open(): ` +
        `export them, drop the table, and reopen. Silently copying between shapes ` +
        `loses whatever the new key was added to distinguish.`);
    }
    // Dropped only. schema.sql runs immediately after and rebuilds it, indexes
    // and all -- which is also WHY this runs first: the new index names a column
    // the old table lacks, so applying the schema over the old shape throws
    // before anything gets a chance to fix it.
    db.exec(`DROP TABLE ${table}`);
  }
}

export function open(path) {
  const db = new DatabaseSync(path, { timeout: 10000 });
  reshapeTables(db);
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  addMissingColumns(db);
  return db;
}

// One helper so every mutation is BEGIN IMMEDIATE + event + projection.
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

export function emit(db, { actor, op, subject = null, run_id = null, payload = {} }) {
  db.prepare(`INSERT INTO event(at,actor,op,subject,run_id,payload)
              VALUES(unixepoch(),?,?,?,?,?)`)
    .run(actor, op, subject, run_id, canonical(payload));
}

// deterministic JSON: sorted keys, no whitespace
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

// ------------------------------------------------------------------ claim
// Single-statement compare-and-set. The UPDATE picks exactly one row via a
// scalar subquery, so `.get()` reading one row can never leave extra rows
// silently updated.
const CLAIM_SQL = `
INSERT INTO run (id, task_id, profile, lane, status, attempt,
                 lease_expires_at, heartbeat_at, owner_pid, owner_boot, owner_host,
                 step, cursor, started_at)
SELECT ?, v.id, v.profile, ?, 'leased', COALESCE(v.attempts,0)+1,
       unixepoch()+?, unixepoch(), ?, ?, ?,
       NULL, '{}', unixepoch()
FROM v_ready v
WHERE (? IS NULL OR v.territory GLOB ?)
ORDER BY v.priority DESC, v.updated_at ASC
LIMIT 1
RETURNING id AS run_id, task_id, attempt`;

export function claim(db, { lane, actor = lane, territory = null, pid = process.pid, boot = "", runId }) {
  return tx(db, () => {
    let row;
    try {
      row = db.prepare(CLAIM_SQL)
        .get(runId, lane, LEASE_SECONDS, pid, boot, hostname(), territory, territory);
    } catch (e) {
      // 2067 = SQLITE_CONSTRAINT_UNIQUE: someone else won the race for this task.
      if (e.errcode === 2067 || e.errcode === 1555) return null;
      throw e;
    }
    if (!row) return null;
    db.prepare(`INSERT INTO task_exec(task_id,attempts) VALUES(?,1)
                ON CONFLICT(task_id) DO UPDATE SET attempts=attempts+1`).run(row.task_id);
    db.prepare(`UPDATE node SET status='running', updated_at=unixepoch(), version=version+1
                WHERE id=?`).run(row.task_id);
    emit(db, { actor, op: "run.claim", subject: row.task_id, run_id: row.run_id,
               payload: { attempt: row.attempt, lane } });
    return row;
  });
}

// ------------------------------------------------------------- heartbeat
// Returns false when the lease was lost (reaped) or cancellation was requested:
// the caller must then stop, because another run may already own the task.
/** The statuses in which a run can still be holding its lease. Shared by
 * `heartbeat` and `checkpoint` deliberately: two copies of this list would drift,
 * and the drift would show up as the two disagreeing about who owns a run. */
const LEASE_HOLDING_STATES = ['leased','running','blocked_on_ci','blocked_on_review','awaiting_founder'];

export function heartbeat(db, { runId, actor = "lane" }) {
  return tx(db, () => {
    // An expired lease is not renewed by a late heartbeat: a daemon that stalled
    // past the deadline while its worker kept running has already lost the
    // claim, and reviving it here would let that worker finish and publish
    // under a lease that had lapsed.
    const r = db.prepare(`
      UPDATE run SET heartbeat_at=unixepoch(), lease_expires_at=unixepoch()+?
      WHERE id=? AND status IN (${LEASE_HOLDING_STATES.map(() => "?").join(",")})
        AND lease_expires_at > unixepoch()
      RETURNING task_id`).get(LEASE_SECONDS, runId, ...LEASE_HOLDING_STATES);
    if (!r) {
      const row = db.prepare(`SELECT status, lease_expires_at FROM run WHERE id=?`).get(runId);
      const expired = row && row.lease_expires_at <= Math.floor(Date.now() / 1000)
        && LEASE_HOLDING_STATES.includes(row.status);
      return { alive: false, reason: expired ? "lease-expired" : "lease-lost" };
    }
    const c = db.prepare(`SELECT cancel_requested FROM task_exec WHERE task_id=?`).get(r.task_id);
    if (c?.cancel_requested) return { alive: false, reason: "cancelled" };
    return { alive: true };
  });
}

// ------------------------------------------------------------------ reap
// Backoff: min(cap, base * 2^attempt) with deterministic-ish jitter.
export function backoffSeconds(attempt, base = 30, cap = 3600) {
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

export function reap(db, { actor = "daemon", isAlive = () => false } = {}) {
  const expired = db.prepare(`
    SELECT id, task_id, attempt, owner_pid, owner_boot, owner_host FROM run
    WHERE lease_expires_at < unixepoch()
      AND status IN ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder')`).all();
  const out = [];
  for (const r of expired) {
    // grace: if the process is demonstrably alive on this host, extend instead of reap
    if (r.owner_host === hostname() && isAlive(r.owner_pid, r.owner_boot)) {
      tx(db, () => db.prepare(`UPDATE run SET lease_expires_at=unixepoch()+? WHERE id=?`)
                     .run(LEASE_SECONDS, r.id));
      out.push({ run: r.id, action: "extended" });
      continue;
    }
    tx(db, () => {
      db.prepare(`UPDATE run SET status='abandoned', ended_at=unixepoch(),
                  error_class='transient', error='lease expired' WHERE id=?`).run(r.id);
      const x = db.prepare(`SELECT attempts, max_attempts FROM task_exec WHERE task_id=?`).get(r.task_id);
      const dead = x && x.attempts >= x.max_attempts;
      if (dead) {
        db.prepare(`UPDATE node SET status='dead_letter', updated_at=unixepoch(), version=version+1
                    WHERE id=?`).run(r.task_id);
      } else {
        db.prepare(`UPDATE task_exec SET not_before=unixepoch()+? WHERE task_id=?`)
          .run(backoffSeconds(r.attempt), r.task_id);
        db.prepare(`UPDATE node SET status='ready', updated_at=unixepoch(), version=version+1
                    WHERE id=?`).run(r.task_id);
      }
      emit(db, { actor, op: dead ? "run.dead_letter" : "run.reap",
                 subject: r.task_id, run_id: r.id, payload: { attempt: r.attempt } });
    });
    out.push({ run: r.id, action: "reaped" });
  }
  return out;
}

// --------------------------------------------------------------- checkpoint
/**
 * Record progress within a run — only while the run still holds its lease.
 *
 * Returns `{ ok: false, reason }` and writes NOTHING when it does not. Callers
 * carry the same contract as `heartbeat`: a false here means another run may
 * already own this task, and the caller has to stop.
 *
 * The guard is the same one `heartbeat` states three functions above, and it is
 * here because this function used to walk straight around it. `heartbeat`
 * deliberately refuses to renew a lapsed lease -- "reviving it here would let that
 * worker finish and publish under a lease that had lapsed" -- and `checkpoint`
 * then set `lease_expires_at` forward with no status and no expiry check at all.
 * Measured 2026-08-24: a run 60 seconds past its deadline was refused by
 * `heartbeat`, checkpointed once, and `heartbeat` reported it alive again.
 *
 * That made a documented boundary decorative, and the run's own step and cursor
 * were written into a record `reap` may already have abandoned and handed on.
 *
 * The shape is the one the outbox fence closes, one layer up: matching on `id`
 * asked "does this row exist", when the fact needed was "do I still own it". An id
 * is not an identity while a row can be re-leased.
 */
export function checkpoint(db, { runId, step, seq, state, actor = "lane" }) {
  return tx(db, () => {
    // Every reason to refuse is decided BEFORE anything is written.
    //
    // The first version claimed first and then checked, on the reasoning that a
    // claim and a check taken apart could disagree. Inside one IMMEDIATE
    // transaction they cannot, so the ordering bought nothing and cost the
    // property that matters: the claiming UPDATE also sets `step`, json-patches
    // `cursor` and refreshes `heartbeat_at`, so a REFUSED checkpoint still left
    // progress behind. `resume` would then read a step the run never successfully
    // recorded and carry on from work a cancelled worker did not do. Putting
    // `lease_expires_at` back covered one field of four, and `cursor` is not
    // trivially reversible once patched at all -- which is the tell that restoring
    // was the wrong shape and not-writing was the right one.
    const row = db.prepare(`SELECT r.status, r.lease_expires_at, x.cancel_requested
                            FROM run r LEFT JOIN task_exec x ON x.task_id = r.task_id
                            WHERE r.id=?`).get(runId);
    const refuse = reason => {
      emit(db, { actor, op: "run.checkpoint.refused", run_id: runId, payload: { step, seq, reason } });
      return { ok: false, reason };
    };
    if (!row) return refuse("no-such-run");
    // Classified the way `heartbeat` classifies. A run `reap` has ABANDONED keeps
    // its old `lease_expires_at`, so reading the timestamp alone reports that the
    // lease merely timed out -- when in fact ownership was taken and the task
    // handed to another run. Expiry is the reason only while the status is one a
    // holder could still hold.
    if (!LEASE_HOLDING_STATES.includes(row.status)) return refuse("lease-lost");
    if (row.lease_expires_at <= Math.floor(Date.now() / 1000)) return refuse("lease-expired");
    // `heartbeat` reports `cancelled` for this, and a checkpoint that returned ok
    // would let a worker told to stop keep checkpointing -- renewing its lease on
    // every step, indefinitely, under the stop contract this function advertises.
    if (row.cancel_requested) return refuse("cancelled");

    // The claim is taken with the guard IN the statement, and its result decides
    // whether anything else is written.
    //
    // The reads above classify the refusal; they cannot be the guard. `BEGIN
    // IMMEDIATE` stops competing writers, it does not stop the clock -- so a
    // process descheduled near the deadline could pass the JavaScript check and
    // then renew an already-lapsed lease, which is the revival this whole function
    // exists to prevent, reintroduced by the fix for it. SQLite evaluates the
    // predicate at execution, so putting it here closes the window that the two
    // statements would otherwise leave open between them.
    const held = db.prepare(`UPDATE run SET step=?, cursor=json_patch(cursor, ?), heartbeat_at=unixepoch(),
                lease_expires_at=unixepoch()+?
                WHERE id=? AND status IN (${LEASE_HOLDING_STATES.map(() => "?").join(",")})
                  AND lease_expires_at > unixepoch()
                RETURNING id`).get(step, canonical(state), LEASE_SECONDS, runId, ...LEASE_HOLDING_STATES);
    // Nothing was written when this misses, so there is nothing to undo.
    if (!held) return refuse("lease-expired");
    db.prepare(`INSERT INTO checkpoint(run_id,step,seq,state,at)
                VALUES(?,?,?,?,unixepoch())
                ON CONFLICT(run_id,step) DO UPDATE SET state=excluded.state, at=excluded.at`)
      .run(runId, step, seq, canonical(state));
    emit(db, { actor, op: "run.checkpoint", run_id: runId, payload: { step, seq } });
    return { ok: true };
  });
}

export function resume(db, runId) {
  const run = db.prepare(`SELECT * FROM run WHERE id=?`).get(runId);
  if (!run) return null;
  const steps = db.prepare(`SELECT step, seq, state FROM checkpoint WHERE run_id=? ORDER BY seq`).all(runId);
  return { run, cursor: JSON.parse(run.cursor), done: steps.map(s => s.step), steps };
}

// ------------------------------------------------------------------ outbox
export function enqueue(db, { idemKey, kind, runId = null, args, notBefore = 0 }) {
  // The outbox's whole invariant, ENFORCED rather than requested.
  //
  // "Must be called inside the same transaction as the state change that decided
  // it" was a comment, which means the rule lived in every caller and in none of
  // them. A bare `enqueue(db, …)` is a perfectly ordinary-looking line that
  // silently produces the failure the table exists to prevent: a decision durable
  // without its effect, or an effect durable without its decision.
  //
  // A guard that lives in the caller is not a guard. This cannot prove the
  // transaction is the RIGHT one -- that a state change is in it too -- but it
  // closes the case that needs no mistake to reach, only forgetting.
  if (!db.isTransaction)
    throw new Error("enqueue: an effect must be enqueued inside the transaction that decided it, or a crash between the two loses one of them");
  const r = db.prepare(`
    INSERT INTO outbox(idem_key,kind,run_id,args,not_before,created_at,updated_at)
    VALUES(?,?,?,?,?,unixepoch(),unixepoch())
    ON CONFLICT(idem_key) DO NOTHING
    RETURNING id`).get(idemKey, kind, runId, canonical(args), notBefore);
  return r ? r.id : null;   // null = already enqueued; caller treats as success
}

/**
 * Take the next due effect, and return the FENCE with it.
 *
 * `lease_token` is bumped in the same statement that takes the row, so a holder's
 * token is the row's token only until someone else leases it. The caller must
 * carry it back to `settleOutbox`; a settle without it is refused.
 *
 * `attempts` is bumped here too and that is deliberate: an attempt begins when the
 * row is taken, because a drainer that dies mid-delivery has still consumed one of
 * the tries the budget allows. The two counters move together on this path and
 * apart on others, which is exactly why they are two columns.
 */
/**
 * Withdraw pending effects that a newer one has made obsolete.
 *
 * A transient failure leaves a row pending with a backoff. If the pull request
 * gets a new commit before that retry comes due, the new head enqueues its own
 * effect under a different key -- and both are now pending. They carry different
 * markers, so the idempotency pre-check cannot see one from the other, and the
 * reviewer is asked twice for what is now the same head.
 *
 * The old row is DELETED rather than settled. There is no status meaning "was
 * never going to happen": `done` would claim a comment that was never posted, and
 * `dead_letter` means a person must look at it, which turns an ordinary
 * supersession into an alarm. The event is emitted so the withdrawal is still on
 * the record.
 *
 * Only PENDING rows. An inflight one may already be mid-delivery, and deleting a
 * row a drainer holds would leave it settling into nothing.
 */
export function supersedeEffects(db, { prefix, keep }) {
  // `keep` is a SET of keys, not one key. Cleanup used to happen while enqueuing a
  // replacement, so it could only ever spare the row being created -- and when the
  // desired set became EMPTY, nothing was enqueued, the loop never ran, and the
  // obsolete rows were left to fire. A reviewer removed from the profile would
  // still be summoned; a dead letter for one would still escalate forever.
  //
  // Taking the whole desired set makes the operation "reconcile what is queued
  // against what is wanted" rather than "make room for this one", which is the
  // shape that works when what is wanted is nothing at all.
  const spare = keep instanceof Set ? keep : new Set(keep === undefined ? [] : [keep]);
  // PENDING and DEAD_LETTER, and the second is not an afterthought. A dead letter
  // is permanent and is counted into a standing escalation every tick -- so an
  // old head's request that failed terminally goes on demanding a person's
  // attention after the reviewer has been successfully summoned for the current
  // head. The work it names is not merely late, it must no longer be performed.
  //
  // INFLIGHT is still excluded: a drainer may be mid-delivery, and deleting a row
  // it holds would leave it settling into nothing.
  const rows = db.prepare(`SELECT id, idem_key, kind, status FROM outbox
                           WHERE status IN ('pending','dead_letter')
                             AND idem_key LIKE ?`).all(prefix + "%")
                 .filter(r => !spare.has(r.idem_key));
  for (const r of rows) {
    db.prepare(`DELETE FROM outbox WHERE id=? AND status IN ('pending','dead_letter')`).run(r.id);
    emit(db, { actor: "daemon", op: "outbox.superseded",
               payload: { id: r.id, kind: r.kind, was: r.status, key: r.idem_key, kept: [...spare] } });
  }
  return rows.length;
}

export function leaseOutbox(db, { worker, leaseSeconds = 300, kinds = null }) {
  // A drainer leases only the kinds it can PERFORM. Without the filter it takes a
  // row it has no handler for and must then decide what to do with it, and both
  // available answers are wrong: dead-lettering discards an effect a later build
  // would have delivered, and settling it back to pending burns an attempt each
  // time around until the budget dead-letters it anyway. Not leasing it leaves it
  // untouched and visible -- `pendingWithNoHandler` counts exactly those.
  if (Array.isArray(kinds) && kinds.length === 0) return undefined;
  const filter = Array.isArray(kinds) ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  return tx(db, () => db.prepare(`
    UPDATE outbox SET status='inflight', attempts=attempts+1, lease_token=lease_token+1,
           lease_expires_at=unixepoch()+?, updated_at=unixepoch()
    WHERE id = (SELECT id FROM outbox
                WHERE status='pending' AND not_before<=unixepoch()${filter}
                ORDER BY id LIMIT 1)
    RETURNING id, idem_key, kind, run_id, args, attempts, max_attempts, lease_token`)
    .get(leaseSeconds, ...(Array.isArray(kinds) ? kinds : [])));
}

/**
 * Effects waiting for a handler that does not exist in this build.
 *
 * Read rather than inferred. A row nothing can perform sits pending forever and
 * looks exactly like an idle queue, so the count is surfaced instead of being left
 * for someone to notice a missing comment.
 */
export function pendingWithNoHandler(db, kinds) {
  if (!Array.isArray(kinds) || !kinds.length)
    return db.prepare(`SELECT kind, count(*) n FROM outbox WHERE status='pending' GROUP BY kind`).all();
  return db.prepare(`SELECT kind, count(*) n FROM outbox
                     WHERE status='pending' AND kind NOT IN (${kinds.map(() => "?").join(",")})
                     GROUP BY kind`).all(...kinds);
}

/**
 * Record what happened to a leased effect — only if the caller still holds it.
 *
 * Returns `"stale"`, having written NOTHING, when the row has been leased by
 * someone else since. That is the whole point: the previous version matched on
 * `id` alone, so a drainer whose lease had expired could mark done a delivery
 * another drainer was in the middle of making, overwriting its status and result.
 *
 * A missing `leaseToken` THROWS rather than settling. It is a programming error,
 * and the failure it produces -- an unfenced settle -- is the exact defect this
 * argument exists to prevent, so it must not be possible to reach it by omission.
 */
export function settleOutbox(db, { id, leaseToken, ok, result, error, retryable = true, actor = "drainer" }) {
  if (!Number.isInteger(leaseToken))
    throw new Error("settleOutbox: leaseToken is required; an unfenced settle can overwrite another drainer's live delivery");
  return tx(db, () => {
    const row = db.prepare(`SELECT attempts, max_attempts, kind, lease_token, status FROM outbox WHERE id=?`).get(id);
    // A row that is gone, or one whose fence has moved on, is not this caller's to
    // settle. Reported rather than thrown: a drainer losing a race is an ordinary
    // event, and the loser's job is to stop touching the row, not to crash.
    if (!row || row.lease_token !== leaseToken) {
      emit(db, { actor, op: "outbox.stale", payload: { id, held: leaseToken, now: row?.lease_token ?? null } });
      return "stale";
    }
    if (ok) {
      db.prepare(`UPDATE outbox SET status='done', result=?, lease_expires_at=0, updated_at=unixepoch()
                  WHERE id=? AND lease_token=?`).run(canonical(result ?? {}), id, leaseToken);
      emit(db, { actor, op: "outbox.done", payload: { id, kind: row.kind } });
      return "done";
    }
    const dead = !retryable || row.attempts >= row.max_attempts;
    db.prepare(`UPDATE outbox SET status=?, last_error=?, not_before=unixepoch()+?,
                lease_expires_at=0, updated_at=unixepoch() WHERE id=? AND lease_token=?`)
      .run(dead ? "dead_letter" : "pending", String(error).slice(0, 2000),
           dead ? 0 : backoffSeconds(row.attempts), id, leaseToken);
    emit(db, { actor, op: dead ? "outbox.dead_letter" : "outbox.retry",
               payload: { id, kind: row.kind, attempts: row.attempts } });
    return dead ? "dead_letter" : "retry";
  });
}

/**
 * Return rows whose drainer died mid-flight — and dead-letter the ones that have
 * exhausted their budget on the way.
 *
 * The budget is checked in `settleOutbox`, which a hard crash never reaches. So a
 * process that dies after leasing and before settling bumps `attempts` every time
 * and is handed back every time: an effect that crashes its drainer could be
 * retried forever, and `max_attempts` would never once be consulted. Recovery is
 * the only place that failure mode passes through, so it is where the budget has
 * to be enforced.
 *
 * Returns the rows made pending. A dead-lettered one is NOT among them — it is not
 * a candidate any more — and is reported separately so a queue that stopped moving
 * says why rather than going quiet.
 */
export function recoverOutbox(db) {
  return tx(db, () => {
    // `>` and not `>=`, which buys exactly one reconciliation pass.
    //
    // The final allowed lease can post the comment and then crash before settling.
    // At that point `attempts` equals `max_attempts`, so dead-lettering here
    // records a delivered effect as one reeve "could not perform" -- and escalates
    // it -- while GitHub already contains it. The handler's marker pre-check is the
    // only thing that can tell the difference, and it needs a lease to run.
    //
    // So an exhausted row goes back to pending once. Its next lease bumps
    // `attempts` past the budget, the pre-check either finds the marker and settles
    // `done` without posting, or it does not and `settleOutbox` dead-letters on the
    // budget it has now exceeded. One extra pass, and it still terminates.
    const dead = db.prepare(`
      UPDATE outbox SET status='dead_letter', lease_expires_at=0, updated_at=unixepoch(),
             last_error=coalesce(last_error,'') || ' | recovered past max_attempts without ever settling'
      WHERE status='inflight' AND lease_expires_at < unixepoch() AND attempts > max_attempts
      RETURNING id, kind, attempts`).all();
    for (const d of dead)
      emit(db, { actor: "drainer", op: "outbox.dead_letter",
                 payload: { id: d.id, kind: d.kind, attempts: d.attempts, why: "crash-loop" } });
    const back = db.prepare(`
      UPDATE outbox SET status='pending', updated_at=unixepoch()
      WHERE status='inflight' AND lease_expires_at < unixepoch() RETURNING id`).all();
    back.deadLettered = dead;
    return back;
  });
}

// ------------------------------------------------------------------ export
// Deterministic, append-only, byte-stable JSONL derived from `event`.
export function exportJsonl(db, { sinceSeq = 0 } = {}) {
  const rows = db.prepare(`SELECT seq,at,actor,op,subject,run_id,payload FROM event
                           WHERE seq>? ORDER BY seq`).all(sinceSeq);
  return rows.map(r => canonical({
    seq: r.seq, at: r.at, actor: r.actor, op: r.op,
    subject: r.subject, run: r.run_id, payload: JSON.parse(r.payload),
  })).join("\n") + (rows.length ? "\n" : "");
}

/**
 * The settlement state this PR was left in by the previous tick, in the shape
 * settle() expects as its `prior`. Returns null when nothing has been recorded,
 * which settle() reads as a first observation.
 */
export function loadSettlement(db, nwo, pr) {
  const r = db.prepare(`SELECT sha, key, streak, floor, first_seen_at, last_seen_at, accounting
                        FROM settlement WHERE nwo=? AND pr=?`).get(nwo, pr);
  if (!r) return null;
  // A floor recorded under a different notion of what counts as a check is not
  // comparable. Treating it as a first observation costs three ticks of
  // re-corroboration; comparing against it costs a PR that can never settle.
  if (r.accounting !== CHECK_ACCOUNTING) return null;
  return {
    sha: r.sha, key: r.key, streak: r.streak, floor: r.floor,
    // Rebuilt from the key rather than stored twice, so the two cannot disagree.
    // An empty key is no checks at all, not one check named "".
    names: r.key ? r.key.split("\0") : [],
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
  };
}

/** Record what this tick observed. `first_seen_at` restarts when the head moves. */
export function saveSettlement(db, nwo, pr, next, at = Math.floor(Date.now() / 1000)) {
  const prior = db.prepare("SELECT sha, first_seen_at FROM settlement WHERE nwo=? AND pr=?").get(nwo, pr);
  const firstSeen = prior && prior.sha === next.sha ? prior.first_seen_at : at;
  db.prepare(`INSERT INTO settlement(nwo,pr,sha,key,streak,floor,first_seen_at,last_seen_at,accounting)
              VALUES(?,?,?,?,?,?,?,?,?)
              ON CONFLICT(nwo,pr) DO UPDATE SET
                sha=excluded.sha, key=excluded.key, streak=excluded.streak,
                floor=excluded.floor, first_seen_at=excluded.first_seen_at,
                last_seen_at=excluded.last_seen_at, accounting=excluded.accounting`)
    .run(nwo, pr, next.sha, next.key, next.streak, next.floor, firstSeen, at, CHECK_ACCOUNTING);
  return { ...next, firstSeenAt: firstSeen, lastSeenAt: at };
}

/** How many times this cause has already been attempted on this PR. */
export function countFixAttempts(db, nwo, pr, cause) {
  const r = db.prepare("SELECT attempts FROM fix_attempt WHERE nwo=? AND pr=? AND cause=?").get(nwo, pr, cause);
  return r ? r.attempts : 0;
}

/**
 * Record an attempt. Keyed by cause rather than by revision, while still storing
 * the head it was last seen at -- the count answers "has this survived a fix?",
 * the head answers "where do I go and look?".
 */
export function recordFixAttempt(db, nwo, pr, cause, sha, at = Math.floor(Date.now() / 1000), note = null) {
  db.prepare(`INSERT INTO fix_attempt(nwo,pr,cause,attempts,first_at,last_at,last_sha,note)
              VALUES(?,?,?,1,?,?,?,?)
              ON CONFLICT(nwo,pr,cause) DO UPDATE SET
                attempts = attempts + 1, last_at = excluded.last_at, last_sha = excluded.last_sha,
                -- An attempt that said nothing must not erase what the last one said.
                note = COALESCE(excluded.note, fix_attempt.note)`)
    .run(nwo, pr, cause, at, at, sha ?? null, note);
  return countFixAttempts(db, nwo, pr, cause);
}

/**
 * Attach the reason a worker gave for stopping, after the fact.
 *
 * The attempt itself is spent at DISPATCH -- before any worker exists -- so the
 * reason cannot be written with it. Reading a not-yet-assigned result there threw
 * a ReferenceError on every FIX_CI, which is the same shape as the cause/fp bug
 * the dispatch end-to-end test was written for, and the same test caught it.
 */
export function noteFixAttempt(db, nwo, pr, cause, note) {
  if (!note) return;
  try {
    db.prepare("UPDATE fix_attempt SET note=? WHERE nwo=? AND pr=? AND cause=?").run(note, nwo, pr, cause);
  } catch { /* a note is an explanation, never a reason to fail a tick */ }
}

/** What the last worker on this cause said it needed a human for, or null. */
export function fixAttemptNote(db, nwo, pr, cause) {
  try {
    const r = db.prepare("SELECT note FROM fix_attempt WHERE nwo=? AND pr=? AND cause=?").get(nwo, pr, cause);
    return r?.note ?? null;
  } catch { return null; }
}

// ------------------------------------------------------------- runs for a PR
// `claim` answers "what should I work on next?" by pulling from v_ready. The
// daemon asks a different question: it already knows the pull request and the
// action, and needs the exclusive right to act on it. Binding the run to the PR
// node makes the schema's one-live-run-per-task index do that work, so duplicate
// dispatch becomes impossible rather than merely unlikely -- the service log
// shows the same fix dispatched twice, ten minutes apart, for want of this.

const LIVE = "('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder')";

/** The live run for this PR, or null. */
export function liveRunFor(db, nwo, pr) {
  return db.prepare(`SELECT id, status, attempt, owner_pid, owner_boot, lease_expires_at
                     FROM run WHERE task_id=? AND status IN ${LIVE}`).get(`pr:${pr}`) ?? null;
}

/**
 * Take the exclusive right to act on a pull request.
 *
 * Returns {ok:false} when another run already holds it, which is the answer a
 * restarted daemon needs. The PR node is created if absent, because a run must
 * reference one and the decision log only ever wrote events.
 */
// The lease length is LEASE_SECONDS, the same value heartbeat() renews to.
// Choosing a longer one here would be silently undone by the first heartbeat,
// and a long lease defeats the point anyway: a dead worker should be reapable
// in lease-time, not in half an hour.
export function startRun(db, { nwo, pr, action, head, lane = "fixer", cause = null, leaseSeconds = LEASE_SECONDS }) {
  const taskId = `pr:${pr}`;
  // Sortable and collision-resistant without needing Math.random: the clock gives
  // ordering, the monotonic counter separates two runs started in the same ms.
  const runId = `${Date.now().toString(36)}-${(process.hrtime.bigint() % 1000000n).toString(36)}`;
  try {
    return tx(db, () => {
      db.prepare(`INSERT INTO node(id,kind,title,status,created_at,updated_at)
                  VALUES(?,'pr',?,'running',unixepoch(),unixepoch())
                  ON CONFLICT(id) DO UPDATE SET status='running', updated_at=unixepoch()`)
        .run(taskId, `${nwo}#${pr}`);
      const prior = db.prepare("SELECT COALESCE(MAX(attempt),0) a FROM run WHERE task_id=?").get(taskId).a;
      db.prepare(`INSERT INTO run(id,task_id,lane,status,attempt,lease_expires_at,heartbeat_at,
                                  owner_host,cursor,started_at)
                  VALUES(?,?,?,'leased',?,unixepoch()+?,unixepoch(),?,?,unixepoch())`)
        .run(runId, taskId, lane, prior + 1, leaseSeconds, hostname(),
             canonical({ nwo, pr, action, head, cause: cause?.job ?? null }));
      emit(db, { actor: "daemon", op: "run.start", subject: taskId, run_id: runId,
                 payload: { action, head, attempt: prior + 1, lane } });
      return { ok: true, runId, attempt: prior + 1 };
    });
  } catch (e) {
    // 2067/1555 = the one-live-run index refused: someone already holds this PR.
    if (e.errcode === 2067 || e.errcode === 1555)
      return { ok: false, why: `a run is already live for ${nwo}#${pr}` };
    return { ok: false, why: `could not record the run: ${e.message}` };
  }
}

/**
 * Bind the operating-system process to the run, the moment it exists.
 *
 * The pid alone is not identity: pids churn here at roughly 963 a second and a
 * genuine wrap-around was forced in 192 seconds, so the process start time is
 * stored beside it. Written before the worker can touch anything, so a crash
 * leaves a run that can be probed rather than a mystery.
 */
/**
 * Bind a worker to its run, revalidating the claim in the same transaction: a
 * cancel or an expiry that landed between startRun and this call withholds
 * the gate (the caller's onSpawn throws), instead of releasing a worker that
 * then runs until the next heartbeat notices. Throws when the claim is gone.
 */
export function bindRun(db, { runId, pid, boot }) {
  return tx(db, () => {
    const r = db.prepare(`SELECT r.task_id, r.lease_expires_at, COALESCE(x.cancel_requested, 0) AS cancel_requested
                            FROM run r LEFT JOIN task_exec x ON x.task_id = r.task_id
                           WHERE r.id=? AND r.status IN ('leased','running')`).get(runId);
    if (!r) throw new Error("the run is no longer leased; the worker is not bound");
    if (r.cancel_requested) throw new Error("a cancel was requested before the worker was bound");
    if (r.lease_expires_at <= Math.floor(Date.now() / 1000)) throw new Error("the run's lease expired before the worker was bound");
    db.prepare(`UPDATE run SET owner_pid=?, owner_boot=?, status='running', heartbeat_at=unixepoch() WHERE id=?`).run(pid, boot ?? "", runId);
    emit(db, { actor: "daemon", op: "run.spawned", run_id: runId, payload: { pid, boot } });
  });
}

/** Has a cooperative cancel been requested for this run's task? Cheap enough to ask every poll. */
export function cancelRequested(db, runId) {
  const r = db.prepare(`SELECT COALESCE(x.cancel_requested, 0) AS c FROM run r LEFT JOIN task_exec x ON x.task_id = r.task_id WHERE r.id=?`).get(runId);
  return !!r?.c;
}

export function notePid(db, { runId, pid, boot }) {
  return tx(db, () => {
    db.prepare(`UPDATE run SET owner_pid=?, owner_boot=?, status='running',
                heartbeat_at=unixepoch() WHERE id=?`).run(pid, boot ?? "", runId);
    emit(db, { actor: "daemon", op: "run.spawned", run_id: runId, payload: { pid, boot } });
  });
}

/** Close a run. An outcome that is not "ok" is a failure with its reason kept. */
export function finishRun(db, { runId, outcome, why = null, ms = null, cost = null, sessionId = null }) {
  // A cancelled run was stopped on request and a lease-lost run was stopped by
  // the infrastructure: both are abandoned, with the node returned to ready,
  // because nothing was learned about the PR and neither is the worker's fault.
  const status = outcome === "ok" ? "succeeded" : (outcome === "cancelled" || outcome === "lease_lost" || outcome === "unbound") ? "abandoned" : "failed";
  return tx(db, () => {
    // Only a run this process still owns may be finished. A run another actor
    // reaped or abandoned has moved on; a stale worker's verdict must not
    // overwrite that state or flip the PR node under a replacement run. The
    // claim is revalidated HERE, atomically: a worker that exits after its
    // lease lapsed, or after a cancel was requested, between two heartbeats
    // is not accepted on the strength of the last heartbeat it got.
    const r = db.prepare(`SELECT r.task_id, r.lease_expires_at, COALESCE(x.cancel_requested, 0) AS cancel_requested
                            FROM run r LEFT JOIN task_exec x ON x.task_id = r.task_id
                           WHERE r.id=? AND r.status IN
                            ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder')`).get(runId);
    if (!r) return { applied: false, why: "the run is no longer live under this process" };
    // A refused outcome still retires the run: nothing else will (no reaper
    // runs in production), and a row left live would block every later
    // dispatch for the PR through the one-live-run index. The node returns to
    // ready and a consumed cancellation is cleared, so the next run is neither
    // blocked nor refused as already cancelled.
    const retire = why => {
      db.prepare(`UPDATE run SET status='abandoned', ended_at=unixepoch(), error=? WHERE id=?`).run(why, runId);
      db.prepare(`UPDATE node SET status='ready', updated_at=unixepoch(), version=version+1 WHERE id=?`).run(r.task_id);
      db.prepare(`UPDATE task_exec SET cancel_requested=0 WHERE task_id=?`).run(r.task_id);
      emit(db, { actor: "daemon", op: "run.refused", subject: r.task_id, run_id: runId, payload: { outcome, why } });
      return { applied: false, why };
    };
    if (outcome !== "cancelled" && r.cancel_requested) return retire("a cancel was requested for the run; its outcome is not accepted");
    // Every outcome but a cancellation is refused after expiry: a success could
    // publish under a lapsed claim, and a failure would be recorded as the
    // worker's when the claim, not the worker, was what lapsed.
    if (outcome !== "cancelled" && outcome !== "lease_lost" && r.lease_expires_at <= Math.floor(Date.now() / 1000))
      return retire("the run's lease expired before it finished; its outcome is not accepted");
    db.prepare(`UPDATE run SET status=?, ended_at=unixepoch(), error=? WHERE id=?`)
      .run(status, why, runId);
    // A cancelled run leaves its node re-dispatchable (`ready`, the reaper's own
    // convention), never `running` for a run that no longer exists and never
    // `blocked` for a failure that did not happen.
    db.prepare(`UPDATE node SET status=?, updated_at=unixepoch(), version=version+1 WHERE id=?`)
      .run(status === "succeeded" ? "done" : status === "abandoned" ? "ready" : "blocked", r.task_id);
    // The cancellation has been honoured; it must not refuse the next run.
    if (status === "abandoned") db.prepare(`UPDATE task_exec SET cancel_requested=0 WHERE task_id=?`).run(r.task_id);
    emit(db, { actor: "daemon", op: "run.finish", subject: r?.task_id ?? null, run_id: runId,
               payload: { outcome, why, ms, cost, sessionId } });
    return { ok: true, applied: true, status };
  });
}

/**
 * Give back an attempt the worker was never allowed to make.
 *
 * The cap exists to stop a fixer guessing at the same failure forever. A DENIED
 * outcome is not a guess: the sandbox refused the worker's tools, so nothing was
 * attempted and nothing was learned. Charging it means one misconfiguration on
 * reeve's side permanently consumes a pull request's only repair -- which is
 * exactly what happened on the first real dispatch.
 *
 * Safe against looping because DENIED escalates on the spot: a persistently wrong
 * sandbox reaches a human rather than a retry.
 */
export function refundFixAttempt(db, nwo, pr, cause) {
  db.prepare(`UPDATE fix_attempt SET attempts = MAX(0, attempts - 1)
              WHERE nwo=? AND pr=? AND cause=?`).run(nwo, pr, cause);
  return countFixAttempts(db, nwo, pr, cause);
}

// ------------------------------------------------------------------ worker contracts
export const sha256 = s => createHash("sha256").update(String(s)).digest("hex");

/** Record the contract a worker is about to run under. Written before spawn, beside the run. */
export function recordWorkerContract(db, { runId, cliVersion, modelRequested = null, effort = null, argvHash, promptHash,
                                           settingsHash, envHash = null, toolContract = null, agentsHash = null, maxTurns = null,
                                           maxBudgetUsd = null, canaryId = null, outPath, errPath, pid = null, lstart = null,
                                           contractDrift = null }) {
  return tx(db, () => {
    db.prepare(`INSERT INTO worker_run (run_id,cli_version,model_requested,effort,argv_hash,prompt_hash,settings_hash,env_hash,
                  tool_contract,agents_hash,max_turns,max_budget_usd,canary_id,out_path,err_path,pid,lstart,contract_drift,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())`)
      .run(runId, cliVersion, modelRequested, effort, argvHash, promptHash, settingsHash, envHash, toolContract, agentsHash,
           maxTurns, maxBudgetUsd, canaryId, outPath, errPath, pid, lstart, contractDrift == null ? null : canonical(contractDrift));
    emit(db, { actor: "daemon", op: "worker.contract", run_id: runId, payload: { cliVersion, modelRequested, argvHash, settingsHash } });
  });
}

/** The process identity, written the instant the fail-closed binding succeeds. */
export function noteWorkerBinding(db, { runId, pid, lstart }) {
  db.prepare(`UPDATE worker_run SET pid=?, lstart=? WHERE run_id=?`).run(pid, lstart, runId);
}

/** What the worker announced it ran as, and whether its durable record is whole. */
export function noteWorkerResult(db, { runId, modelResolved = null, truncated = false, stdoutBytes = null }) {
  db.prepare(`UPDATE worker_run SET model_resolved=COALESCE(?, model_resolved), truncated=?, stdout_bytes=? WHERE run_id=?`)
    .run(modelResolved, truncated ? 1 : 0, stdoutBytes, runId);
}

export function workerContractFor(db, runId) {
  return db.prepare(`SELECT * FROM worker_run WHERE run_id=?`).get(runId) ?? null;
}
