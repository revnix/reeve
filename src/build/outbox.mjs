// outbox -- what stops one crash from becoming two pull requests.
//
// Nothing here reaches the network. A transition ENQUEUES an effect inside its
// own transaction; the executor leases it, performs it, and settles it. The
// separation is what makes a crash survivable: the durable record of intent is
// written in the same transaction as the decision that caused it, and every
// delivery is revalidated against the state of the world before it goes out.
//
// Three rules, and each has its own way of being wrong:
//
//   1. Keys are unique over LIVE rows only. A re-enqueue after a hold voided the
//      original is ADMITTED, and its reconciler settles it inert against
//      external truth. A blanket UNIQUE either swallows that or refuses it.
//   2. Round- and sha-keyed kinds ALSO consult `done` rows, because for those
//      the key itself is proof the effect happened: a rerun re-derives different
//      bytes and would otherwise push a second time for one round.
//   3. Every row carries a fence -- the `phase_event.seq` that authorised it --
//      revalidated INSIDE the lease transaction. An effect decided under a
//      contract that has since been replaced settles `fenced`, with nothing done.
import { hubTx, hubEvent, canonicalHub } from "./hubdb.mjs";
import { assertWritable } from "./locks.mjs";
import { isSameProcess } from "../supervisor.mjs";
// ONE backoff policy for the whole system. `src/db/ops.mjs` already owns it and
// `src/build/locks.mjs` already imports from there, so a second curve defined
// here would be two answers to one question -- and the one this file needed was
// the one that already existed.
import { backoffSeconds } from "../db/ops.mjs";

/**
 * The kinds whose IDEMPOTENCY KEY identifies the effect exactly enough that a
 * completed one must never be re-derived.
 *
 * A spec push is round-keyed and an implementation push and a merge are
 * sha-keyed (section 3.2), so re-deriving the bytes after a crash produces a
 * DIFFERENT payload for the same logical act -- and admitting it would push or
 * merge a second time for one round. For every other kind the key says nothing
 * about the outside world, so the re-enqueue is admitted and its reconciler
 * decides against external truth.
 */
export const KEY_KINDS = Object.freeze(["git.push.branch", "gh.pr.merge"]);

// The statuses from which no further delivery follows. `settleDrainFor` clears a
// drain row only when its effect reaches one of these: a retryable failure
// returns the row to `pending`, and marking its drain settled there would let a
// task reach CANCELLED with the effect still queued to run again.
const TERMINAL_OUTBOX = Object.freeze(
  ["done", "failed", "dead_letter", "voided", "fenced", "refused", "superseded", "forced"]);

const ROW = `id, idempotency_key, kind, task_id, task_generation, fence, cancellable, args,
             status, worker, lease_token, attempts, max_attempts, not_before, lease_expires_at,
             visibility_repo_id, visibility_result, result, last_error, created_at, updated_at`;

const rowOf = (db, id) => db.prepare(`SELECT ${ROW} FROM outbox WHERE id = ?`).get(id);

// Every outbox mutation appends the ROW IMAGE, in the same transaction as the
// write. `outbox` is a replayed projection keyed on `id`, so a snapshot taken
// before an enqueue loses that effect entirely, and one taken before a
// settlement resurrects the row at its OLD status -- and for a `pending` row
// that means the reconciler performs the external action a second time.
const emitRow = (db, kind, id) => {
  const row = rowOf(db, id);
  hubEvent(db, { kind, task: row.task_id, payload: row });
  return row;
};

/**
 * Clear the `task_drain` row an effect belongs to, once that effect is finished.
 *
 * Called by `settleEffect` AND by `leaseEffect`, because `leaseEffect` settles
 * `fenced` and `refused` itself without going through `settleEffect`. A hook in
 * only one of the two leaves exactly the cancellations that were fenced at lease
 * time stuck in CANCELLING until `builder.cancel.drainMinutes` expires and the
 * founder forces them -- turning the ordinary path into the exceptional one, and
 * recording as `forced` rows whose reconcilers had in fact completed.
 */
export function settleDrainFor(db, outboxId) {
  const status = db.prepare("SELECT status FROM outbox WHERE id = ?").get(outboxId)?.status;
  if (!TERMINAL_OUTBOX.includes(status)) return false;
  const done = db.prepare(
    `UPDATE task_drain SET settled_at = unixepoch()
      WHERE task = (SELECT task_id FROM outbox WHERE id = ?)
        AND outbox_id = ? AND settled_at IS NULL`).run(outboxId, outboxId);
  if (!done.changes) return false;
  const row = db.prepare(
    `SELECT task, outbox_id, recorded_at, settled_at, forced, last_known
       FROM task_drain WHERE outbox_id = ?`).get(outboxId);
  hubEvent(db, { kind: "task_drain.settled", task: row.task, payload: row });
  return true;
}

/**
 * Record an effect. **Must be called inside the caller's transaction**, so the
 * intent is durable in the same commit as the decision that produced it.
 */
export function enqueueEffect(db, { idempotencyKey, kind, taskId, generation, fence,
                                    cancellable = true, args, notBefore = 0,
                                    isAlive = isSameProcess }) {
  // IT TOO. This function opens no transaction of its own -- it runs inside the
  // caller's -- and it was left out of the exclusion rule on the grounds that
  // `applyTransition` checks before calling it. That reasoning covers one caller.
  // It is a hub WRITER, the rule is "every hub writer calls it", and a rule with
  // a remembered exception is a rule honoured by whoever remembered it: a bare
  // `hubTx(db, () => enqueueEffect(...))` is a legitimate call shape, and it
  // admitted an effect while a restore was replacing the file underneath it.
  assertWritable(db, { isAlive, inTx: true });
  // LIVE rows only. The partial unique index is over `pending` and `inflight`,
  // and that is deliberate: a hold voids the original, and the resume must be
  // able to re-enqueue the same key beside its own history.
  const live = db.prepare(
    `SELECT id, status FROM outbox WHERE idempotency_key = ? AND status IN ('pending','inflight')`)
    .get(idempotencyKey);
  // Inert, and it appends NOTHING: no row changed, so there is no row image to
  // log. An event here would replay as a mutation that never happened.
  if (live) return { id: live.id, status: "duplicate" };

  // The key is the proof, for these kinds only. A completed round- or sha-keyed
  // effect must not be performed again under a re-derived payload.
  //
  // AND WHAT IT DOES NOT SURVIVE, said out loud so the next reader does not take
  // this for more than it is: the proof consulted here is THIS HUB'S OWN ROW, and
  // a restore rolls that row back. Install a snapshot taken before a push or a
  // merge settled and the external act still exists while the record of it does
  // not -- so this check passes and the effect is admitted a second time. The
  // state that would have to remember is precisely the state a restore
  // rewinds, so no local counter or status can close it; only asking GitHub can.
  // Nothing in S2 performs an effect, so there is no live re-delivery today. The
  // executor that does must re-verify a KEY_KIND against external truth before
  // its first delivery rather than trusting an absent row, and `recoverEffects`
  // is not that check -- it reconciles rows already `inflight`, and a restored
  // row comes back `pending`.
  if (KEY_KINDS.includes(kind)) {
    const done = db.prepare(
      `SELECT id FROM outbox WHERE idempotency_key = ? AND status = 'done' ORDER BY id DESC LIMIT 1`)
      .get(idempotencyKey);
    if (done) return { id: done.id, status: "superseded" };
  }

  const { id } = db.prepare(
    `INSERT INTO outbox(idempotency_key, kind, task_id, task_generation, fence, cancellable,
                        args, status, not_before, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,'pending',?,unixepoch(),unixepoch()) RETURNING id`)
    .get(idempotencyKey, kind, taskId, generation, fence, cancellable ? 1 : 0,
         canonicalHub(args ?? {}), notBefore);
  emitRow(db, "outbox.enqueued", id);
  return { id, status: "pending" };
}

// Which capability switch governs a kind, by the SURFACE it touches.
//
// Section 1.4 gives the spec repository its own switch: `draftSpec` governs
// spec-repo effects and `publishPr` governs project-repo ones. Consulting one
// switch for everything would leave the spec repo ungated the moment `publishPr`
// was turned on, which is the opposite of a staged rollout.
const NEVER_GATED = Object.freeze(["notify", "gate.clean_notice", "ledger.claim", "ledger.release"]);
const capabilityFor = (row) => {
  if (NEVER_GATED.includes(row.kind)) return null;
  // MERGING HAS ITS OWN SWITCH, and it is default-off INDEPENDENTLY of
  // `publishPr`. Classifying `gh.pr.merge` as an ordinary project-repo effect
  // made `mergeBuilderPr` govern nothing at all: the profile declares it, the
  // validator accepts it, and no code ever read it -- so a founder who turned
  // publishing on had merging on too, and a merge row already pending when merge
  // authority was withdrawn would still be leased and delivered. Withdrawing a
  // capability has to stop the effects that were already decided under it, which
  // is the entire reason the lease revalidates capabilities rather than trusting
  // enqueue time.
  if (row.kind === "gh.pr.merge") return "builder.capabilities.mergeBuilderPr";
  let args = {};
  try { args = JSON.parse(row.args); } catch { args = {}; }
  return args?.repo === "spec"
    ? "builder.capabilities.draftSpec"
    : "builder.capabilities.publishPr";
};

/**
 * Take the next due effect, revalidating everything that could have changed
 * since it was decided. Returns the leased row, or null when nothing is due.
 */
export function leaseEffect(db, { worker, leaseSeconds = 300, capabilities = {}, now,
                                  isAlive = isSameProcess } = {}) {
  return hubTx(db, () => {
    // The executor runs on a loop and never stops on its own, so without this it
    // can lease and settle rows -- performing real external actions -- while a
    // restore replaces the file underneath it.
    assertWritable(db, { isAlive, inTx: true });
    const at = now ?? db.prepare("SELECT unixepoch() n").get().n;

    // `not_before` is a SCHEDULE, not decoration: every delayed notification and
    // every backoff retry rides on it, and ignoring the column fires them all at
    // once. The boundary is inclusive -- a row due at exactly `now` is due.
    const due = db.prepare(
      `SELECT ${ROW} FROM outbox
        WHERE status = 'pending' AND not_before <= ?
        ORDER BY id`).all(at);

    for (const row of due) {
      // THE FENCE, revalidated here rather than trusted from enqueue time. An
      // effect decided under generation 3 must not be delivered once a redesign
      // has moved the task to generation 4: the contract it was decided under no
      // longer exists.
      const task = row.task_id
        ? db.prepare("SELECT generation FROM task WHERE id = ?").get(row.task_id) : null;
      if (task && task.generation !== row.task_generation) {
        db.prepare(
          `UPDATE outbox SET status='fenced', worker=NULL, updated_at=unixepoch() WHERE id=?`).run(row.id);
        emitRow(db, "outbox.fenced", row.id);
        settleDrainFor(db, row.id);
        continue;
      }

      // A switch the founder has not turned on is CONFIGURATION, not a fault: it
      // burns no attempt and raises no escalation, and it is terminal, because
      // retrying a decision the operator made is not recovery.
      const cap = capabilityFor(row);
      if (cap && capabilities[cap] === false) {
        db.prepare(
          `UPDATE outbox SET status='refused', worker=NULL,
                             last_error=?, updated_at=unixepoch() WHERE id=?`)
          .run(`${cap} is off`, row.id);
        emitRow(db, "outbox.settled", row.id);
        settleDrainFor(db, row.id);
        continue;
      }

      // The lease, and its TOKEN. `lease_token` is bumped on every lease, so it
      // is monotonic per row and survives a restart because it lives in the row
      // rather than in a process -- which is what lets `settleEffect` refuse a
      // worker whose lease has already been handed on.
      db.prepare(
        `UPDATE outbox SET status='inflight', worker=?, lease_token=lease_token+1,
                           attempts=attempts+1, lease_expires_at=?, updated_at=unixepoch()
          WHERE id=?`).run(worker, at + leaseSeconds, row.id);
      // The lease WRITES `inflight`, and replay must not lose that: a restored
      // `pending` row is handed out again and the external action happens twice.
      return emitRow(db, "outbox.settled", row.id);
    }
    return null;
  });
}

/**
 * Settle a delivery, FENCED ON THE ACTIVE LEASE rather than on the id.
 *
 * An id is not an identity while a row can be re-leased. Worker A stalls past
 * its expiry, `recoverEffects` returns the row to `pending`, worker B leases it
 * and begins delivering -- and A, still running, settles B's live delivery,
 * overwriting its status and result mid-flight. Both writes look legitimate at
 * their own call sites, so the row itself has to refuse the older one.
 */
export function settleEffect(db, { id, worker, leaseToken, ok, result = null,
                                   error = null, retryable = false,
                                   isAlive = isSameProcess }) {
  return hubTx(db, () => {
    assertWritable(db, { isAlive, inTx: true });
    const row = rowOf(db, id);
    if (!row) return { status: "no-such-row" };
    // The CAS. Both halves, because either alone is defeatable: worker names
    // repeat across restarts, and a token without an owner cannot tell two
    // holders apart if the counter is ever reset.
    if (row.status !== "inflight" || row.worker !== worker || row.lease_token !== leaseToken)
      return { status: "stale", id };

    let status;
    if (ok) status = "done";
    else if (retryable && row.attempts < row.max_attempts) status = "pending";
    else status = row.attempts >= row.max_attempts ? "dead_letter" : "failed";

    // A RETRY IS SCHEDULED, NOT MERELY ALLOWED. Returning the row to `pending`
    // without advancing `not_before` left it due immediately, and `leaseEffect`
    // takes every pending row whose schedule is due -- so the executor leased the
    // same failing delivery again on the very next iteration and burned all eight
    // attempts in a tight burst against whatever was failing. The backoff was
    // promised by the column and never written to it. `not_before` is only
    // advanced when the row is going back to the queue; a terminal status leaves
    // the schedule alone, because nothing will read it again.
    const notBefore = status === "pending" ? backoffSeconds(row.attempts + 1) : null;
    db.prepare(
      `UPDATE outbox SET status=?, worker=NULL, result=?, last_error=?,
                         not_before=CASE WHEN ? IS NULL THEN not_before ELSE unixepoch() + ? END,
                         updated_at=unixepoch()
        WHERE id=?`)
      .run(status, result === null ? null : canonicalHub(result), error, notBefore, notBefore, id);
    emitRow(db, "outbox.settled", id);
    // Only a TERMINAL status clears the drain; `settleDrainFor` enforces that
    // itself, so a retryable failure that returned the row to `pending` leaves
    // the task's drain outstanding, which is what keeps CANCELLING honest.
    settleDrainFor(db, id);
    return { status, id };
  });
}

/**
 * Reconcile deliveries whose lease expired, against EXTERNAL TRUTH.
 *
 * The half of re-delivery that matters: a worker performed the effect and died
 * before settling. The row is inflight, the action has happened, and the hub
 * does not know. Returning it to `pending` is what turns one crash into two pull
 * requests -- so the reconciler is asked first, and only an effect it cannot
 * observe goes back into the queue.
 */
export async function recoverEffects(db, { reconcile, now = null, isAlive = isSameProcess } = {}) {
  // REFUSED BEFORE ANY OBSERVATION, not only before the write. A restore holding
  // the maintenance lock must stop this call at the door: reaching the reconciler
  // first would send it to GitHub, git remotes and receipts on behalf of a hub
  // that is about to be replaced, and those are real external reads made under a
  // state that no longer exists by the time the verdict lands.
  hubTx(db, () => assertWritable(db, { isAlive, inTx: true }));

  // ── 1. READ. No transaction, so no lock is held while the world is consulted.
  const at = now ?? db.prepare("SELECT unixepoch() n").get().n;
  const expired = db.prepare(
    `SELECT ${ROW} FROM outbox WHERE status='inflight' AND lease_expires_at <= ? ORDER BY id`).all(at);
  if (!expired.length) return { settled: 0, returned: 0, dead: 0, stale: 0 };

  // ── 2. ASK, OUTSIDE the write transaction, and AWAIT the answer.
  //
  // Two defects lived here, and the second hid inside the first. A reconciler
  // that checks GitHub, a git remote, a notification receipt or ledger truth was
  // being called inside `BEGIN IMMEDIATE`, so the hub's SOLE writer was held for
  // the length of a network call -- every transition, lease and settle in the
  // process queued behind an HTTP timeout. And an ASYNC reconciler was worse
  // than slow: its Promise is an object, `verdict?.settled` on it is `undefined`,
  // so every effect was read as unobservable and returned to the queue. The
  // system's one defence against re-delivering an action that already happened
  // answered "could not tell" for every asynchronous reconciler ever passed to
  // it, and did so silently.
  // PER ROW, and a failure is that ROW's answer rather than the pass's.
  //
  // One reconciler throwing aborted the whole loop before the apply
  // transaction, so verdicts already obtained were discarded and every later
  // expired row was skipped -- and since the scan is `ORDER BY id`, a single
  // permanently malformed or unsupported row at the front stopped the entire
  // outbox from recovering, on every pass, for ever. The reconciler consults the
  // outside world, which is the part of this system most entitled to fail.
  //
  // A failure is "could not tell", which is what an unsettled verdict already
  // means, so the row goes back to the queue exactly as an unobservable one does
  // -- and its reason is carried so `last_error` says why rather than leaving a
  // row that quietly cycles.
  const verdicts = [];
  for (const row of expired) {
    if (!reconcile) { verdicts.push([row, { settled: false }]); continue; }
    try { verdicts.push([row, await reconcile(row)]); }
    catch (e) { verdicts.push([row, { settled: false, reconcileError: e?.message ?? String(e) }]); }
  }

  // ── 3. APPLY, under a short write transaction, each row CAS'd on the state it
  // was read in. The lease may have been handed on, settled or voided while the
  // reconciler was out; a verdict about a row that has moved is stale, and
  // applying it would overwrite whoever holds it now.
  return hubTx(db, () => {
    assertWritable(db, { isAlive, inTx: true });
    let settled = 0, returned = 0, dead = 0, stale = 0;
    for (const [row, verdict] of verdicts) {
      const cur = db.prepare("SELECT status, worker, lease_token FROM outbox WHERE id = ?").get(row.id);
      if (!cur || cur.status !== "inflight" || cur.worker !== row.worker
          || cur.lease_token !== row.lease_token) { stale++; continue; }

      if (verdict?.settled) {
        db.prepare(
          `UPDATE outbox SET status=?, worker=NULL, result=?, last_error=?, updated_at=unixepoch()
            WHERE id=?`)
          .run(verdict.ok === false ? "failed" : "done",
               verdict.result == null ? null : canonicalHub(verdict.result),
               verdict.error ?? null, row.id);
        emitRow(db, "outbox.settled", row.id);
        settleDrainFor(db, row.id);
        settled++;
        continue;
      }

      // THE RETRY BOUND APPLIES HERE TOO. `settleEffect` dead-letters an effect
      // whose attempts are spent; this path returned it to `pending` regardless,
      // and `leaseEffect` does not filter exhausted rows -- so an effect nobody
      // could observe was leased, expired and requeued for ever, performing an
      // externally ambiguous action every round. The bound is on the ROW, so
      // every path that writes `pending` has to honour it.
      const spent = row.attempts >= row.max_attempts;
      db.prepare(
        `UPDATE outbox SET status=?, worker=NULL, lease_expires_at=0,
                           last_error=COALESCE(?, last_error), updated_at=unixepoch()
          WHERE id=?`)
        .run(spent ? "dead_letter" : "pending",
             spent ? `unobserved after ${row.attempts} of ${row.max_attempts} attempts` +
                     (verdict?.reconcileError ? `; last reconcile failed: ${verdict.reconcileError}` : "")
                   : (verdict?.reconcileError ? `reconcile failed: ${verdict.reconcileError}` : null),
             row.id);
      emitRow(db, "outbox.settled", row.id);
      if (spent) { settleDrainFor(db, row.id); dead++; } else returned++;
    }
    return { settled, returned, dead, stale };
  });
}

/**
 * Void a task's pending, cancellable effects.
 *
 * CANCELLABLE ONLY. Voiding a push mid-transport is not a compensation: the
 * bytes may already be on the wire, and the row is the only record that they
 * were. Opens its OWN transaction, so callers must not nest it.
 */
export function voidPending(db, taskId, { isAlive = isSameProcess } = {}) {
  return hubTx(db, () => {
    assertWritable(db, { isAlive, inTx: true });
    return voidPendingIn(db, taskId);
  });
}

/**
 * The same voiding, WITHOUT opening a transaction.
 *
 * `applyCompensation` runs inside the transition's own `BEGIN IMMEDIATE`, and
 * `void-pending` is the first compensation it applies -- so calling the wrapper
 * above from there attempts a second transaction and throws before a single row
 * is voided. The caller that already holds the write lock uses this; everyone
 * else uses `voidPending`. One body either way, so the two cannot drift.
 */
export function voidPendingIn(db, taskId) {
  const doomed = db.prepare(
    `SELECT id FROM outbox WHERE task_id = ? AND cancellable = 1 AND status = 'pending'`)
    .all(taskId).map(r => r.id);
  for (const id of doomed) {
    db.prepare(`UPDATE outbox SET status='voided', worker=NULL, updated_at=unixepoch() WHERE id=?`).run(id);
    // ONE PER ROW, never one for the batch. Replay is a primary-key upsert on
    // `id`, so a single batch event restores one row and leaves every other
    // voided effect at its old `pending` status -- to be performed again.
    emitRow(db, "outbox.voided", id);
    settleDrainFor(db, id);
  }
  return { voided: doomed.length };
}
