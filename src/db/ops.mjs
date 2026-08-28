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
  // The reconciliation budget, kept apart from the delivery budget. Additive and
  // defaulted like the fence: an existing row starts at 0 reconciliations, which
  // is exactly true of every row written before the column existed.
  ["outbox", "reconcile_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["outbox", "max_reconcile", "INTEGER NOT NULL DEFAULT 3"],
  // The head a projection was derived for. Nullable on purpose: an existing row
  // was derived before anyone recorded this, and "we do not know which head"
  // must read as unusable rather than as a match.
  ["projection_meta", "head", "TEXT"],
  // Whether body-finding derivation could have been complete. Defaulted to 0 on
  // purpose: every projection written before this column existed derived no body
  // findings at all, so 0 is not a conservative guess, it is the truth about
  // those rows. The reader treats 0 as "the critical count may be short one".
  ["projection_meta", "body_derived", "INTEGER NOT NULL DEFAULT 0"],
  // A body finding that is really a statement that the body could not be read.
  // Defaulted to 0: every row written before this column existed was a real
  // finding, because sentinels did not exist to be written.
  ["review_body_finding", "unreadable", "INTEGER NOT NULL DEFAULT 0"],
  // How many review objects a projection was folded from. Nullable on purpose:
  // an existing row was derived before anyone recorded this, and "we do not know"
  // must read as not-reported rather than as a matching count.
  ["projection_meta", "review_total", "INTEGER"],
  // The dependency edge. Additive and NULLABLE, which is what makes it safe on a
  // populated table: every row written before this column existed waited for
  // nothing, and null says exactly that rather than guessing.
  //
  // A REFERENCES clause is allowed in ALTER TABLE ADD COLUMN only because the
  // default is null; SQLite refuses one with a non-null default. Measured on this
  // build rather than assumed, because the failure would appear on a populated
  // store at open() time and not in any test that starts from an empty one.
  ["outbox", "depends_on", "INTEGER REFERENCES outbox(id)"],
];

/**
 * Indexes over columns that ADDED_COLUMNS adds.
 *
 * These cannot live in schema.sql. `open()` executes that file BEFORE adding
 * columns, and it has to: the file is what creates a table the columns are then
 * added to. But `CREATE TABLE IF NOT EXISTS` does nothing to a table that already
 * exists, so on a store whose outbox predates the column, an index in schema.sql
 * naming that column throws at open() -- on precisely the databases holding real
 * history, and on none of the fresh ones every test builds.
 *
 * That is not a hypothetical. It was found by opening a COPY of the live store,
 * after a full suite of 5,298 assertions had passed against fresh databases that
 * could not exhibit it. The same trap is already documented in `reshapeTables`.
 */
const ADDED_INDEXES = [
  `CREATE INDEX IF NOT EXISTS outbox_depends ON outbox(depends_on) WHERE depends_on IS NOT NULL`,
];

function addMissingIndexes(db) {
  for (const sql of ADDED_INDEXES) db.exec(sql);
}

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
  // AFTER the columns, never before. See ADDED_INDEXES.
  addMissingIndexes(db);
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
export function enqueue(db, { idemKey, kind, runId = null, args, notBefore = 0, dependsOn = null }) {
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
  // A dependency must already exist, and it is checked HERE rather than left to
  // the foreign key. SQLite does not enforce foreign keys unless the pragma is on,
  // so a typo'd parent id would insert cleanly and produce a row that waits for a
  // parent that never finishes, which is indistinguishable from an idle queue.
  if (dependsOn != null && !db.prepare("SELECT 1 FROM outbox WHERE id=?").get(dependsOn))
    throw new Error(`enqueue: depends_on ${dependsOn} names no outbox row; a dependent effect would wait for ever`);
  const r = db.prepare(`
    INSERT INTO outbox(idem_key,kind,run_id,args,not_before,depends_on,created_at,updated_at)
    VALUES(?,?,?,?,?,?,unixepoch(),unixepoch())
    ON CONFLICT(idem_key) DO NOTHING
    RETURNING id`).get(idemKey, kind, runId, canonical(args), notBefore, dependsOn);
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
  // Inside a transaction, for the same reason `enqueue` demands one -- and this
  // needs it more, not less. It performs several deletes and an event insert per
  // delete, and those describe ONE reconciliation: a crash partway leaves some
  // obsolete effects removed without their audit events while others stay queued,
  // and a reader cannot then tell a partial reconciliation from a complete one.
  //
  // It must also commit with the decision that produced it. Reconciling in its own
  // transaction means a crash between the two leaves the queue reconciled against
  // a decision that was never recorded.
  //
  // A guard that lives in the caller is not a guard: `enqueue` learned that in the
  // same file, and this function was written afterwards without it.
  if (!db.isTransaction)
    throw new Error("supersedeEffects: reconciliation must run inside the transaction that decided it, or a crash leaves it half applied");
  const spare = keep instanceof Set ? keep : new Set(keep === undefined ? [] : [keep]);
  // PENDING and DEAD_LETTER, and the second is not an afterthought. A dead letter
  // is permanent and is counted into a standing escalation every tick -- so an
  // old head's request that failed terminally goes on demanding a person's
  // attention after the reviewer has been successfully summoned for the current
  // head. The work it names is not merely late, it must no longer be performed.
  //
  // INFLIGHT is still excluded: a drainer may be mid-delivery, and deleting a row
  // it holds would leave it settling into nothing.
  // `_` and `%` are LIKE wildcards, and a repository name may legitimately contain
  // an underscore -- `my_repo` would also match `myXrepo`, so a prefix could reach
  // into another repository's rows and delete them. Escaped explicitly rather than
  // hoping the input never contains one.
  const esc = prefix.replace(/[\\%_]/g, c => "\\" + c);
  const rows = db.prepare(`SELECT id, idem_key, kind, status FROM outbox
                           WHERE status IN ('pending','dead_letter')
                             AND idem_key LIKE ? ESCAPE '\\'`).all(esc + "%")
                 .filter(r => !spare.has(r.idem_key));

  // DEPENDENTS, and this is not tidiness -- without it the DELETE above throws.
  //
  // `PRAGMA foreign_keys = ON` is set by schema.sql, which open() executes, so the
  // edge is ENFORCED in the product. Deleting a row another row still points at
  // raises SQLITE_CONSTRAINT_FOREIGNKEY, which rolls back the whole reconciliation
  // -- and because reconciliation runs every tick, that is not one lost cleanup
  // but a tick that fails again on the same rows for ever.
  //
  // (The `sqlite3` CLI reports `foreign_keys = 0` on the same file, which is what
  // makes this easy to get wrong: the pragma is per-CONNECTION, and the CLI never
  // runs schema.sql. Only a connection opened by open() answers for the product.)
  //
  // Retiring a parent retires its descendants, because the descendant's work is
  // meaningless once the parent's is: a reply naming an issue that will never be
  // created has nothing to say. But a family is retired only when ALL of it can
  // be, and three things stop it:
  //
  //   · a descendant a drainer is mid-delivery on -- the same reason inflight rows
  //     are excluded above; deleting it leaves the drainer settling into nothing;
  //   · a descendant in `keep`, which is the caller saying it is still wanted;
  //   · a descendant already gone, which cannot be true here but is cheap to state.
  //
  // A blocked family is LEFT QUEUED rather than partially deleted. It is retried
  // on the next tick, by which time the inflight delivery has settled.
  const childrenOf = db.prepare(`SELECT id, idem_key, kind, status FROM outbox WHERE depends_on = ?`);
  const family = id => {
    const out = [];
    const stack = [id];
    // Bounded for the same reason cascadeDeadLetter is: a cycle cannot be built
    // through enqueue, and a queue that never drains is not worth risking on that.
    for (let guard = 0; stack.length && guard < 1024; guard++) {
      const kids = childrenOf.all(stack.pop());
      for (const k of kids) { out.push(k); stack.push(k.id); }
    }
    return out;
  };

  const deletable = [];
  for (const r of rows) {
    const kin = family(r.id);
    const blocker = kin.find(k => k.status === "inflight" || spare.has(k.idem_key));
    if (blocker) {
      emit(db, { actor: "daemon", op: "outbox.supersede_deferred",
                 payload: { id: r.id, key: r.idem_key,
                            because: blocker.status === "inflight" ? "a dependent effect is being delivered" : "a dependent effect is still wanted",
                            dependent: blocker.idem_key } });
      continue;
    }
    // Descendants FIRST, so a parent is never deleted while something points at it.
    // `family` pushes in breadth order, so reversing gives deepest-first.
    deletable.push(...kin.reverse(), r);
  }

  // One row can be reached twice -- as its own candidate and as another's
  // descendant -- and deleting it twice is harmless but emits two events saying
  // different things about the same transition.
  const seen = new Set();
  for (const r of deletable) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    db.prepare(`DELETE FROM outbox WHERE id=? AND status IN ('pending','dead_letter')`).run(r.id);
    emit(db, { actor: "daemon", op: "outbox.superseded",
               payload: { id: r.id, kind: r.kind, was: r.status, key: r.idem_key, kept: [...spare] } });
  }
  // What was actually retired, not what was considered. `rows.length` counted
  // candidates, so a family deferred because a drainer held one of its members
  // would have been reported as superseded -- a caller logging this number would
  // then say cleanup happened on a tick where it was correctly postponed.
  return seen.size;
}

export function leaseOutbox(db, { worker, leaseSeconds = 300, kinds = null }) {
  // A drainer leases only the kinds it can PERFORM. Without the filter it takes a
  // row it has no handler for and must then decide what to do with it, and both
  // available answers are wrong: dead-lettering discards an effect a later build
  // would have delivered, and settling it back to pending burns an attempt each
  // time around until the budget dead-letters it anyway. Not leasing it leaves it
  // untouched and visible -- `pendingWithNoHandler` counts exactly those.
  if (Array.isArray(kinds) && kinds.length === 0) return undefined;
  // TABLE-QUALIFIED, because the subquery is now aliased. An unqualified `kind`
  // still resolves -- to the alias -- so this is not a correctness fix today; it is
  // written so that adding a second table to the subquery cannot silently make the
  // filter read the wrong one.
  const filter = Array.isArray(kinds) ? ` AND o.kind IN (${kinds.map(() => "?").join(",")})` : "";
  // The lease bumps whichever counter the row's PHASE names, and the phase is read
  // from the row as it stood BEFORE this statement. SQLite evaluates every
  // assignment's right-hand side against the original row, so both CASEs see the
  // same pre-lease `attempts` and exactly one of them can be 1.
  //
  // Deciding the phase from the returned `attempts` instead would be wrong by one:
  // a row leased at `max_attempts - 1` comes back with `attempts = max_attempts`,
  // and a caller testing `attempts >= max_attempts` would refuse to deliver on the
  // very attempt the budget had just granted. `reconcile_attempts > 0` cannot be
  // ambiguous that way -- it is only ever bumped in the reconciling phase.
  return tx(db, () => db.prepare(`
    UPDATE outbox SET status='inflight', lease_token=lease_token+1,
           attempts = attempts + (CASE WHEN attempts >= max_attempts THEN 0 ELSE 1 END),
           reconcile_attempts = reconcile_attempts
                              + (CASE WHEN attempts >= max_attempts THEN 1 ELSE 0 END),
           lease_expires_at=unixepoch()+?, updated_at=unixepoch()
    WHERE id = (SELECT id FROM outbox o
                WHERE o.status='pending' AND o.not_before<=unixepoch()${filter}
                  AND (o.depends_on IS NULL
                       OR EXISTS (SELECT 1 FROM outbox p
                                  WHERE p.id = o.depends_on AND p.status='done'))
                ORDER BY o.id LIMIT 1)
    RETURNING id, idem_key, kind, run_id, args, attempts, max_attempts,
              reconcile_attempts, max_reconcile, lease_token, depends_on`)
    .get(leaseSeconds, ...(Array.isArray(kinds) ? kinds : [])));
}

/**
 * Effects waiting for a handler that does not exist in this build.
 *
 * Read rather than inferred. A row nothing can perform sits pending forever and
 * looks exactly like an idle queue, so the count is surfaced instead of being left
 * for someone to notice a missing comment.
 */
/**
 * Effects waiting for a parent that will never finish.
 *
 * A dead-lettered parent has already summoned a person, and its child cannot
 * proceed: the value it was going to substitute does not exist and no amount of
 * retrying will produce it. Left alone the child sits pending for ever, which
 * looks exactly like an idle queue -- the same failure `pendingWithNoHandler`
 * exists to make visible, arriving by a different route.
 *
 * So the edge is FAILED FORWARD rather than left dangling, and it is done in one
 * statement per generation so a chain longer than two collapses in full.
 *
 * `failed` counts as terminal here alongside `dead_letter`. Both mean the parent
 * stopped without a result; only the reason differs, and a child cares about the
 * result rather than about why there is none.
 */
export function cascadeDeadLetter(db, { batch = 100, deadlineAt = Infinity, now = () => Date.now() } = {}) {
  if (db.isTransaction)
    throw new Error("cascadeDeadLetter: opens its own transaction per batch; it must not be called inside one");
  const cascaded = [];
  // Bounded rather than `while (true)`: a cycle is impossible through `enqueue`,
  // which requires the parent to exist before the child, but a bound costs
  // nothing and a queue that never drains because two rows point at each other
  // is not a failure worth risking on an argument.
  for (let depth = 0; depth < 32; depth++) {
    // The PASS budget bounds this too, and it has to.
    //
    // The drainer awaits this before it leases anything, and the daemon's tick
    // awaits the drainer -- so an unbounded cascade over a large dependent tree
    // runs past the advertised budget and delays evaluation, heartbeats and
    // alerts. A bound the work inside it cannot see is not a bound; this file
    // already learned that about the delivery loop.
    //
    // Checked BEFORE each batch rather than after, so the budget is spent deciding
    // not to start. Whatever is left stays pending and the next pass continues it:
    // the cascade is idempotent, because it only ever selects rows that are still
    // `pending` under a parent that is already terminal.
    // The bounded SELECT comes FIRST, and the clock is consulted only when there
    // is work. Reading `now()` unconditionally made this a consumer of the
    // caller's clock even on an empty queue, which is almost every pass -- and in
    // a test driving a synthetic clock it spent the pass budget before the drainer
    // had leased anything, so a row that should have been leased never was. Work
    // the budget is meant to bound must not be charged for deciding there is none.
    const rows = db.prepare(`
      SELECT o.id, o.kind, o.depends_on, p.status AS parent_status
      FROM outbox o JOIN outbox p ON p.id = o.depends_on
      WHERE o.status='pending' AND p.status IN ('dead_letter','failed')
      LIMIT ?`).all(batch);
    if (!rows.length) break;
    // Checked before the batch is written, so the budget is spent deciding not to
    // start. Whatever is left stays pending and the next pass continues it.
    if (now() >= deadlineAt) break;
    // ONE TRANSACTION per batch, so a status change and the event explaining it
    // commit together or not at all.
    //
    // They were separate autocommit statements: a crash between them left a
    // dead-lettered row with no immutable event, which is the exact divergence
    // between projection and trail that emitting the event was meant to close.
    // Writing the event was necessary and was not sufficient.
    tx(db, () => {
      const mark = db.prepare(`
        UPDATE outbox SET status='dead_letter', last_error=?, updated_at=unixepoch()
        WHERE id=? AND status='pending'`);
      for (const r of rows) {
        const why = `the effect this one depends on (#${r.depends_on}) ended ${r.parent_status}; its result will never exist`;
        // ONLY the transaction that actually moved the row may speak for it.
        //
        // The batch is selected outside this transaction, so two drainers can pick
        // the same pending child before either commits. The second one's UPDATE
        // matches nothing -- the guard is `AND status='pending'` -- and without
        // this test it would still emit a second `outbox.dead_letter` for one
        // transition and report the row as cascaded. An immutable trail with two
        // events for one status change is worse than one with none, because it
        // reads as two things having happened.
        if (mark.run(why, r.id).changes !== 1) continue;
        // The SAME op `settleOutbox` and `recoverOutbox` emit, because this is the
        // same transition arriving by a third route. Without it the event trail has
        // no record of a real status change and stops agreeing with the projection
        // it is supposed to explain -- and a dead letter is precisely the transition
        // someone reads the trail to understand.
        emit(db, { actor: "drainer", op: "outbox.dead_letter",
                   payload: { id: r.id, kind: r.kind, cascadedFrom: r.depends_on, error: why } });
        cascaded.push(r);
      }
    });
  }
  return cascaded;
}

/**
 * Effects held back by a parent that has not finished YET.
 *
 * Distinct from `cascadeDeadLetter`, and the distinction is the point: this is the
 * healthy case -- a child correctly waiting its turn -- and it is surfaced only so
 * that "the queue is idle" and "the queue is waiting on an edge" can be told
 * apart. Reading a pending count alone cannot tell them apart, and this repository
 * has already paid once for a row that sat pending looking exactly like nothing.
 */
export function blockedOnDependency(db) {
  return db.prepare(`
    SELECT o.id, o.kind, o.depends_on, p.status AS parent_status
    FROM outbox o JOIN outbox p ON p.id = o.depends_on
    WHERE o.status='pending' AND p.status NOT IN ('done','dead_letter','failed')
    ORDER BY o.id`).all();
}

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
export function settleOutbox(db, { id, leaseToken, ok, result, error, retryable = true,
                                   unstarted = false, unattempted = false, actor = "drainer" }) {
  if (!Number.isInteger(leaseToken))
    throw new Error("settleOutbox: leaseToken is required; an unfenced settle can overwrite another drainer's live delivery");
  return tx(db, () => {
    const row = db.prepare(`SELECT attempts, max_attempts, reconcile_attempts, max_reconcile,
                                   kind, lease_token, status FROM outbox WHERE id=?`).get(id);
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
    // A retryable failure in the DELIVERY phase never ends here, however many
    // attempts it has spent. Spending the delivery budget moves the row on to
    // reconciliation; it does not condemn it.
    //
    // It used to. `attempts >= max_attempts` meant the final POST reaching GitHub
    // and losing only its response -- a `gh` timeout after the comment was created
    // -- was recorded as an effect reeve could not perform, and escalated, while
    // the comment sat on the pull request. Nothing was ever going to look again,
    // because looking is what the reconciling phase is for and the row never
    // reached it. Only the reconciliation budget is a reason to give up on a
    // retryable failure, because only reconciliation has already asked GitHub what
    // happened and been unable to find out.
    const reconciling = row.reconcile_attempts > 0;

    // A lease that never reached the handler REFUNDS the budget it charged.
    //
    // The fence and the budget are separate facts and this is where the
    // difference bites. The lease really happened, so `lease_token` stays bumped
    // and a stalled holder is still fenced out. But no attempt was made, and
    // charging one for work never begun is not merely untidy: on the LAST
    // permitted delivery it moves the row into reconciliation without a single
    // POST ever having been sent, and reconciliation then correctly finds no
    // marker and dead-letters an effect that was never delivered. A review
    // request silently never made, escalated as one reeve could not perform.
    //
    // I first wrote this as "the attempt is spent and stays spent", reasoning
    // that un-bumping would deny a lease that really happened. That conflated the
    // two counters the schema keeps apart on purpose: the fence counts leases,
    // the budget counts attempts, and this is a lease that was not an attempt.
    if (unstarted) {
      db.prepare(`UPDATE outbox SET status='pending', last_error=?, not_before=unixepoch()+?,
                  attempts = attempts - (CASE WHEN ? THEN 0 ELSE 1 END),
                  reconcile_attempts = reconcile_attempts - (CASE WHEN ? THEN 1 ELSE 0 END),
                  lease_expires_at=0, updated_at=unixepoch() WHERE id=? AND lease_token=?`)
        .run(String(error).slice(0, 2000), backoffSeconds(0),
             reconciling ? 1 : 0, reconciling ? 1 : 0, id, leaseToken);
      emit(db, { actor, op: "outbox.unstarted",
                 payload: { id, kind: row.kind, phase: reconciling ? "reconcile" : "deliver" } });
      return "unstarted";
    }

    const dead = !retryable || (reconciling && row.reconcile_attempts >= row.max_reconcile);
    // A lease that never reached the handler REFUNDS its attempt even when the
    // outcome is terminal, and that combination did not exist before.
    //
    // `unstarted` already refunds, but it returns the row to pending, which is
    // right for a budget that ran out and wrong for a failure that will never
    // resolve. A dependency whose parent recorded no usable value is terminal --
    // asking again re-reads a finished result -- and yet no delivery was attempted,
    // so charging one makes the durable row and its event report an attempt that
    // never happened. The counters are separate precisely so this can be said
    // accurately, and this path was the one place saying it wrongly.
    //
    // The FENCE is untouched, as everywhere else: the lease really did happen.
    if (unattempted) {
      db.prepare(`UPDATE outbox SET attempts = attempts - (CASE WHEN ? THEN 0 ELSE 1 END),
                         reconcile_attempts = reconcile_attempts - (CASE WHEN ? THEN 1 ELSE 0 END)
                  WHERE id=? AND lease_token=?`)
        .run(reconciling ? 1 : 0, reconciling ? 1 : 0, id, leaseToken);
      row.attempts -= reconciling ? 0 : 1;
      row.reconcile_attempts -= reconciling ? 1 : 0;
    }
    db.prepare(`UPDATE outbox SET status=?, last_error=?, not_before=unixepoch()+?,
                lease_expires_at=0, updated_at=unixepoch() WHERE id=? AND lease_token=?`)
      .run(dead ? "dead_letter" : "pending", String(error).slice(0, 2000),
           dead ? 0 : backoffSeconds(reconciling ? row.reconcile_attempts : row.attempts),
           id, leaseToken);
    emit(db, { actor, op: dead ? "outbox.dead_letter" : "outbox.retry",
               payload: { id, kind: row.kind, attempts: row.attempts,
                          reconcileAttempts: row.reconcile_attempts,
                          phase: reconciling ? "reconcile" : "deliver" } });
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
    // Judged on the RECONCILIATION budget, never on the delivery one.
    //
    // The final allowed delivery can post the comment and then crash before
    // settling. Dead-lettering on `attempts` at that point records a delivered
    // effect as one reeve "could not perform" -- and escalates it -- while GitHub
    // already contains the comment. The handler's marker pre-check is the only
    // thing that can tell the difference, and it needs a lease to run.
    //
    // A single extra lease was the first answer to that and it was one short: the
    // reconciling lease can itself crash, after confirming the marker and before
    // settling, and the next recovery then condemned a confirmed delivery on an
    // unrelated process failure. So reconciliation has a budget of its own and is
    // retried like anything else. It still terminates -- `reconcile_attempts` only
    // rises, and no lease is granted once it reaches `max_reconcile` -- and it is
    // bounded work in any case, because a reconciling lease reads and never posts.
    const dead = db.prepare(`
      UPDATE outbox SET status='dead_letter', lease_expires_at=0, updated_at=unixepoch(),
             last_error=coalesce(last_error,'') || ' | recovered with the reconciliation budget spent and no delivery ever confirmed'
      WHERE status='inflight' AND lease_expires_at < unixepoch()
        AND reconcile_attempts >= max_reconcile
      RETURNING id, kind, attempts, reconcile_attempts`).all();
    for (const d of dead)
      emit(db, { actor: "drainer", op: "outbox.dead_letter",
                 payload: { id: d.id, kind: d.kind, attempts: d.attempts,
                            reconcileAttempts: d.reconcile_attempts, why: "crash-loop" } });
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
