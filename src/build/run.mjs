// run -- every statement that touches phase_run, and nothing else.
//
// One writer per table is the property; being inside src/build/ is only what
// makes it allowed. The dispatch seam, the tick and the resume path all call
// through here rather than preparing their own statements, so "what can change
// a run row" is answerable by reading one file.
import { join } from "node:path";
import { hubTx, hubEvent, canonicalHub } from "./hubdb.mjs";
import { assertWritable } from "./locks.mjs";
import { isSameProcess } from "../supervisor.mjs";

// WHICH RULE THE DATABASE REFUSED ON, read from the errcode rather than the
// message. Measured on node v24.17.0 against the schema hub.sql ships:
//
//   787   FOREIGN KEY constraint failed
//   1555  UNIQUE constraint failed: phase_run.task, phase_run.generation, ...
//   2067  UNIQUE constraint failed: phase_run.task
//
// The message cannot be matched safely. The plan's branch looked for
// `index 'one_live_run'`, and SQLite never names an index -- it names the
// constrained columns -- so that branch could not fire and a routine refusal
// would have reached the tick as a raw hub error. The repair anyone reaches for
// second is worse: the PRIMARY KEY message CONTAINS `phase_run.task`, so
// matching the column answers "a live run exists" for an attempt that was
// merely recorded twice, and those are opposite remedies -- one means wait or
// revoke, the other means the work is already recorded. The three errcodes do
// not overlap, and they are a stable interface where the text is not.
//
// Re-inserting an attempt whose row is still LIVE violates both rules at once,
// and SQLite reports the partial index: 2067. That needs no special case
// because a live run genuinely does exist and that is the answer to give -- but
// it is asserted on purpose in the suite, because a mapping proven only on
// inputs that break one rule at a time has never seen the overlap.
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const REFUSAL_FOR = new Map([
  [SQLITE_CONSTRAINT_FOREIGNKEY, "no-such-task"],
  [SQLITE_CONSTRAINT_PRIMARYKEY, "duplicate-attempt"],
  [SQLITE_CONSTRAINT_UNIQUE, "live-run-exists"],
]);

// A run is entitled to its process while its row says one of these.
const ENTITLED = new Set(["live", "adopted"]);

const KEY_SQL = "task=? AND generation=? AND phase=? AND slice=? AND attempt=?";
const keyArgs = (k) => [k.task, k.generation, k.phase, k.slice, k.attempt];

/** Where one attempt's durable files live. Stable per attempt, so a resumed
 *  attempt is a NEW file rather than an append to the one being read. */
export function runPathsFor(home, k) {
  const runDir = join(home, "tasks", k.task, "runs");
  const stem = `g${k.generation}-${k.phase}-s${k.slice}-a${k.attempt}`;
  return { runDir, outPath: join(runDir, `${stem}.out`), errPath: join(runDir, `${stem}.err`),
           argvPath: join(runDir, `${stem}.argv.json`) };
}

const INSERT_SQL =
  // `resume_seq` IS WRITTEN, not defaulted. A plain resume leaves the generation
  // unchanged on purpose and resets the bounded attempt budget by counting runs
  // under the NEW resume sequence -- so a row that defaults to 0 after a resume
  // is counted with the attempts from before it. The budget then either
  // re-exhausts immediately or never sees the new attempts at all, and the
  // column exists for exactly this and was reading 0 on every row.
  `INSERT INTO phase_run(task,generation,phase,slice,attempt,status,resume_seq,started_at,heartbeat_at,
     lease_expires_at,out_path,err_path,cli_version,model_id,effort,argv_hash,prompt_hash,
     settings_hash,tools_hash,agents_hash,max_turns,max_budget_usd,canary_id,snapshot_hash,contract_drift)
   VALUES(?,?,?,?,?,'live',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export function insertRun(db, { task, generation, phase, slice = 0, attempt, outPath, errPath,
                                snapshot, drift = null, startedAt, leaseSeconds,
                                isAlive = isSameProcess }) {
  return hubTx(db, () => {
    assertWritable(db, { isAlive, inTx: true });
    const k = { task, generation, phase, slice, attempt };
    // THE TASK'S EPOCH, READ INSIDE THIS TRANSACTION. The foreign key says the
    // task exists; it says nothing about the task still being at the phase and
    // generation this run was chosen for. A tick selects a task, a founder
    // cancel commits before this insert, and the stale (generation, phase) is
    // admitted anyway -- the cancel saw no live run to terminate, so nothing
    // revoked it, and `revocationProbe` then reads the NEW row as perfectly
    // entitled. The worker runs after the cancellation, which is the one thing
    // the whole revocation path exists to prevent.
    //
    // Read here rather than by the caller, because a check outside this
    // transaction is a read followed by a write with the same window in it.
    const epoch = db.prepare("SELECT generation, phase, resume_seq FROM task WHERE id=?").get(task);
    if (!epoch) return { ok: false, reason: "no-such-task" };
    if (epoch.generation !== generation || epoch.phase !== phase)
      return { ok: false, reason: "stale-epoch",
               detail: `the task is at generation ${epoch.generation} phase ${epoch.phase}, ` +
                       `and this run was chosen for generation ${generation} phase ${phase}` };
    try {
      db.prepare(INSERT_SQL)
        .run(task, generation, phase, slice, attempt, epoch.resume_seq,
             startedAt, startedAt, startedAt + leaseSeconds,
             outPath, errPath, snapshot.cliVersion, snapshot.modelId, snapshot.effort,
             snapshot.argvHash, snapshot.promptHash, snapshot.settingsHash, snapshot.toolsHash,
             snapshot.agentsHash, snapshot.maxTurns, snapshot.maxBudgetUsd, snapshot.canaryId,
             // THE SAME CANONICALISER THE EVENT LOG USES, imported rather than
             // written again. The plan defined a local one as
             // `JSON.stringify(v, Object.keys(v).sort())`, and a replacer ARRAY
             // is a key WHITELIST applied at every level rather than an
             // ordering: measured, it turns {modelId:{was,now}} into
             // {"modelId":{}}, so contract_drift would have recorded WHICH
             // fields drifted and destroyed what they drifted to -- the only
             // thing the column is for. A second copy would also have to agree
             // byte for byte with hubEvent's for the replay drill to compare,
             // and two implementations of one rule is the divergence this
             // codebase keeps having to remove.
             snapshot.snapshotHash, drift == null ? null : canonicalHub(drift));
    } catch (e) {
      // THE DATABASE IS THE AUTHORITY on all three of these, not a SELECT above
      // it. A read-then-write is two statements, and two ticks interleave
      // between them -- which is exactly the shape that put two workers on one
      // subscription slot before the provider scheduler existed. `one_live_run`
      // holds against two transactions that both read before either wrote;
      // asking first and inserting after does not.
      const reason = REFUSAL_FOR.get(e.errcode);
      if (reason) return { ok: false, reason };
      throw e;
    }
    hubEvent(db, { kind: "phase_run.started", task,
      payload: db.prepare(`SELECT * FROM phase_run WHERE ${KEY_SQL}`).get(...keyArgs(k)) });
    return { ok: true, key: k };
  });
}

/** THROWS, and that is the contract. This is what the dispatch seam hands to
 *  the supervisor as `onSpawn`, where S1 turns a throw into a killed process
 *  group -- so a binding that cannot be recorded must fail closed rather than
 *  leave a running worker no row can name. */
export function bindRun(db, { task, generation, phase, slice = 0, attempt, pid, lstart,
                              sessionId = null, isAlive = isSameProcess }) {
  return hubTx(db, () => {
    assertWritable(db, { isAlive, inTx: true });
    const k = { task, generation, phase, slice, attempt };
    const r = db.prepare(
      `UPDATE phase_run SET pid=?, lstart=?, session_id=? WHERE ${KEY_SQL} AND status='live'`)
      .run(pid, lstart, sessionId, ...keyArgs(k));
    if (r.changes !== 1)
      throw new Error(`cannot bind a process to ${JSON.stringify(k)}: no live run row to bind it to`);
    // THE WHOLE ROW, for the same reason the other two carry it: the payload is
    // replayed as a row image, and `sessionId` is not a column -- `session_id`
    // is. A camelCase key cannot be upserted, and a partial image could not
    // recreate a row that the snapshot predates.
    hubEvent(db, { kind: "phase_run.bound", task,
      payload: db.prepare(`SELECT * FROM phase_run WHERE ${KEY_SQL}`).get(...keyArgs(k)) });
    return k;
  });
}

export function heartbeatRun(db, { task, generation, phase, slice = 0, attempt, at, leaseSeconds,
                                   isAlive = isSameProcess }) {
  return hubTx(db, () => {
    assertWritable(db, { isAlive, inTx: true });
    const k = { task, generation, phase, slice, attempt };
    // FROM NOW, not from the run's start. A lease extended from `started_at`
    // shrinks with every beat and expires under a worker that is answering.
    const expiresAt = at + leaseSeconds;
    const r = db.prepare(
      // AND THE OLD EXPIRY MUST STILL BE IN THE FUTURE. A blocked or suspended
      // event loop delivers a beat whose `at` is already past the lease it is
      // renewing -- and renewing it converts a lost lease back into an
      // apparently valid one, before runWorker's poll ever observes the expiry.
      // Another actor may have adopted the run by then, so the worker would
      // continue against a claim someone else holds.
      //
      // Fenced IN the statement rather than checked before it: a read then a
      // write is two moments, and the whole point of a lease is that it can
      // lapse between them. The refusal falls through to the dispatcher's
      // failed-heartbeat path, which terminates the worker.
      `UPDATE phase_run SET heartbeat_at=?, lease_expires_at=?
        WHERE ${KEY_SQL} AND status IN ('live','adopted') AND lease_expires_at > ?`)
      .run(at, expiresAt, ...keyArgs(k), at);
    // A BEAT FOR NOTHING IS A REFUSAL, never a silent no-op: the caller is a
    // loop that would otherwise go on beating for a run that has been settled
    // or killed, and never learn it is no longer entitled to its process.
    if (r.changes !== 1) return { ok: false, reason: "no-such-run" };
    // DERIVED, not configured twice. A cadence written down beside the lease is
    // a second number that has to be kept in agreement with it, and the pair
    // silently disagrees the moment either moves.
    return { ok: true, expiresAt, beatEvery: leaseSeconds / 4 };
  });
}

export function settleRun(db, { task, generation, phase, slice = 0, attempt, status, outcome = null,
                                evidence = null, truncated = 0, sessionId = null,
                                isAlive = isSameProcess }) {
  return hubTx(db, () => {
    assertWritable(db, { isAlive, inTx: true });
    const k = { task, generation, phase, slice, attempt };
    const r = db.prepare(
      // COALESCE, so a settle that was not told the session leaves the binding's
      // value alone. The id is learned from the worker's init event and comes
      // back on the RESULT, long after `onSpawn` bound a null -- so every real
      // row lost the session that `--resume` needs for the permitted timeout,
      // rate-limit and BAD_REPORT retries, and lost it hardest across a daemon
      // restart, which is exactly when resuming matters.
      `UPDATE phase_run SET status=?, outcome=?, evidence=?, truncated=?, session_id=COALESCE(?, session_id)
        WHERE ${KEY_SQL} AND status IN ('live','adopted')`)
      .run(status, outcome, evidence == null ? null : canonicalHub(evidence), truncated ? 1 : 0,
           sessionId, ...keyArgs(k));
    if (r.changes !== 1) return { ok: false, reason: "no-such-run" };
    // THE WHOLE ROW, READ BACK. Replay is a primary-key upsert, and
    // `phase_run.started` is deliberately not replayed -- so when a snapshot
    // predates a completed run, this event is the ONLY thing that can recreate
    // it. A partial payload then reaches an INSERT and dies on
    // `NOT NULL constraint failed: phase_run.started_at`, taking the whole
    // replay with it. `insertRun` already emits the full row for the same
    // reason; a settle that emits less is the half of the pair that was missed.
    hubEvent(db, { kind: "phase_run.settled", task,
      payload: db.prepare(`SELECT * FROM phase_run WHERE ${KEY_SQL}`).get(...keyArgs(k)) });
    return { ok: true, reason: null };
  });
}

export function runStatus(db, k) {
  const r = db.prepare(`SELECT status FROM phase_run WHERE ${KEY_SQL}`).get(...keyArgs(k));
  return r ? r.status : null;
}

export function liveRuns(db) {
  return db.prepare("SELECT * FROM phase_run WHERE status IN ('live','adopted') ORDER BY task").all();
}

/**
 * The reason this run is no longer entitled to its process, or null.
 *
 * Handed to the supervisor as `isRevoked`, so it is asked repeatedly while a
 * worker runs and its answer ends the process.
 */
export function revocationProbe(db, k, { at = Math.floor(Date.now() / 1000) } = {}) {
  const r = db.prepare(`SELECT status, lease_expires_at FROM phase_run WHERE ${KEY_SQL}`)
    .get(...keyArgs(k));
  // ABSENT AND LIVE ARE NOT THE SAME FACT, and only one of them entitles a
  // process to keep running. Reading a missing row as "nothing revoked it"
  // leaves a worker running against a hub that has been restored from a
  // snapshot taken before its run existed -- the row is gone precisely because
  // the authority for it is gone.
  if (!r) return "the run row is gone: a restore or a purge removed the record this process runs under";
  // `cancelled` FIRST, and the prefix is load-bearing: it is how the supervisor
  // tells a deliberate cancel from a lease it merely failed to renew, which are
  // the same stop with different follow-ups.
  if (r.status === "killed") return "cancelled: the run row was killed";
  if (!ENTITLED.has(r.status)) return `the run is already ${r.status}`;
  if (r.lease_expires_at <= at)
    return `the lease expired at ${r.lease_expires_at}: another process may already have adopted this run`;
  return null;
}
