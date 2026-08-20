import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export const LEASE_SECONDS = 120;      // short: heartbeat is cheap, reaping should be fast
export const HEARTBEAT_SECONDS = 30;   // renew at 1/4 lease

export function open(path) {
  const db = new DatabaseSync(path, { timeout: 10000 });
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
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
  const r = db.prepare(`SELECT sha, key, streak, floor, first_seen_at, last_seen_at
                        FROM settlement WHERE nwo=? AND pr=?`).get(nwo, pr);
  if (!r) return null;
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
  db.prepare(`INSERT INTO settlement(nwo,pr,sha,key,streak,floor,first_seen_at,last_seen_at)
              VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(nwo,pr) DO UPDATE SET
                sha=excluded.sha, key=excluded.key, streak=excluded.streak,
                floor=excluded.floor, first_seen_at=excluded.first_seen_at,
                last_seen_at=excluded.last_seen_at`)
    .run(nwo, pr, next.sha, next.key, next.streak, next.floor, firstSeen, at);
  return { ...next, firstSeenAt: firstSeen, lastSeenAt: at };
}
