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
export function heartbeat(db, { runId, actor = "lane" }) {
  return tx(db, () => {
    const r = db.prepare(`
      UPDATE run SET heartbeat_at=unixepoch(), lease_expires_at=unixepoch()+?
      WHERE id=? AND status IN ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder')
      RETURNING task_id`).get(LEASE_SECONDS, runId);
    if (!r) return { alive: false, reason: "lease-lost" };
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
export function checkpoint(db, { runId, step, seq, state, actor = "lane" }) {
  return tx(db, () => {
    db.prepare(`INSERT INTO checkpoint(run_id,step,seq,state,at)
                VALUES(?,?,?,?,unixepoch())
                ON CONFLICT(run_id,step) DO UPDATE SET state=excluded.state, at=excluded.at`)
      .run(runId, step, seq, canonical(state));
    db.prepare(`UPDATE run SET step=?, cursor=json_patch(cursor, ?), heartbeat_at=unixepoch(),
                lease_expires_at=unixepoch()+? WHERE id=?`)
      .run(step, canonical(state), LEASE_SECONDS, runId);
    emit(db, { actor, op: "run.checkpoint", run_id: runId, payload: { step, seq } });
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
  // MUST be called inside the same tx as the state change that decided it.
  const r = db.prepare(`
    INSERT INTO outbox(idem_key,kind,run_id,args,not_before,created_at,updated_at)
    VALUES(?,?,?,?,?,unixepoch(),unixepoch())
    ON CONFLICT(idem_key) DO NOTHING
    RETURNING id`).get(idemKey, kind, runId, canonical(args), notBefore);
  return r ? r.id : null;   // null = already enqueued; caller treats as success
}

export function leaseOutbox(db, { worker, leaseSeconds = 300 }) {
  return tx(db, () => db.prepare(`
    UPDATE outbox SET status='inflight', attempts=attempts+1,
           lease_expires_at=unixepoch()+?, updated_at=unixepoch()
    WHERE id = (SELECT id FROM outbox
                WHERE status='pending' AND not_before<=unixepoch()
                ORDER BY id LIMIT 1)
    RETURNING id, idem_key, kind, run_id, args, attempts, max_attempts`).get(leaseSeconds));
}

export function settleOutbox(db, { id, ok, result, error, retryable = true, actor = "drainer" }) {
  return tx(db, () => {
    const row = db.prepare(`SELECT attempts, max_attempts, kind FROM outbox WHERE id=?`).get(id);
    if (ok) {
      db.prepare(`UPDATE outbox SET status='done', result=?, lease_expires_at=0, updated_at=unixepoch()
                  WHERE id=?`).run(canonical(result ?? {}), id);
      emit(db, { actor, op: "outbox.done", payload: { id, kind: row.kind } });
      return "done";
    }
    const dead = !retryable || row.attempts >= row.max_attempts;
    db.prepare(`UPDATE outbox SET status=?, last_error=?, not_before=unixepoch()+?,
                lease_expires_at=0, updated_at=unixepoch() WHERE id=?`)
      .run(dead ? "dead_letter" : "pending", String(error).slice(0, 2000),
           dead ? 0 : backoffSeconds(row.attempts), id);
    emit(db, { actor, op: dead ? "outbox.dead_letter" : "outbox.retry",
               payload: { id, kind: row.kind, attempts: row.attempts } });
    return dead ? "dead_letter" : "retry";
  });
}

// recover outbox rows whose drainer died mid-flight
export function recoverOutbox(db) {
  return tx(db, () => db.prepare(`
    UPDATE outbox SET status='pending', updated_at=unixepoch()
    WHERE status='inflight' AND lease_expires_at < unixepoch() RETURNING id`).all());
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
export function notePid(db, { runId, pid, boot }) {
  return tx(db, () => {
    db.prepare(`UPDATE run SET owner_pid=?, owner_boot=?, status='running',
                heartbeat_at=unixepoch() WHERE id=?`).run(pid, boot ?? "", runId);
    emit(db, { actor: "daemon", op: "run.spawned", run_id: runId, payload: { pid, boot } });
  });
}

/** Close a run. An outcome that is not "ok" is a failure with its reason kept. */
export function finishRun(db, { runId, outcome, why = null, ms = null, cost = null, sessionId = null }) {
  const status = outcome === "ok" ? "succeeded" : "failed";
  return tx(db, () => {
    // Only a run this process still owns may be finished. A run another actor
    // reaped or abandoned has moved on; a stale worker's verdict must not
    // overwrite that state or flip the PR node under a replacement run.
    const r = db.prepare(`SELECT task_id FROM run WHERE id=? AND status IN
                            ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder')`).get(runId);
    if (!r) return { applied: false, why: "the run is no longer live under this process" };
    db.prepare(`UPDATE run SET status=?, ended_at=unixepoch(), error=? WHERE id=?`)
      .run(status, why, runId);
    db.prepare(`UPDATE node SET status=?, updated_at=unixepoch(), version=version+1 WHERE id=?`)
      .run(status === "succeeded" ? "done" : "blocked", r.task_id);
    emit(db, { actor: "daemon", op: "run.finish", subject: r?.task_id ?? null, run_id: runId,
               payload: { outcome, why, ms, cost, sessionId } });
    return { ok: true, status };
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
                                           settingsHash, toolContract = null, agentsHash = null, maxTurns = null,
                                           maxBudgetUsd = null, canaryId = null, outPath, errPath, pid = null, lstart = null,
                                           contractDrift = null }) {
  return tx(db, () => {
    db.prepare(`INSERT INTO worker_run (run_id,cli_version,model_requested,effort,argv_hash,prompt_hash,settings_hash,
                  tool_contract,agents_hash,max_turns,max_budget_usd,canary_id,out_path,err_path,pid,lstart,contract_drift,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())`)
      .run(runId, cliVersion, modelRequested, effort, argvHash, promptHash, settingsHash, toolContract, agentsHash,
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
