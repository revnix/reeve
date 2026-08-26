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
import { ACTIVE } from "./phases.mjs";
// ONE backoff policy for the whole system. `src/db/ops.mjs` already owns it and
// `src/build/locks.mjs` already imports from there, so a second curve defined
// here would be two answers to one question -- and the one this file needed was
// the one that already existed.
import { backoffSeconds } from "../db/ops.mjs";

// MEASURED, and it does NOT do what it first appears to.
//
// node:sqlite's behaviour depends on ARITY. A single object argument is read as
// a named-parameter bag, so an Error passed alone binds nothing and the column
// takes NULL -- which is what a one-parameter probe shows, and what the review
// finding described. Every statement here binds POSITIONALLY with several
// arguments, and in that shape an Error is not a bindable type: `run` throws
// ERR_INVALID_ARG_TYPE.
//
// So the real failure is louder and worse than a lost message. An executor
// passing the caught error -- the natural failure-call shape -- makes
// `settleEffect` THROW, `hubTx` rolls the settle back, and the effect stays
// `inflight` with its result discarded. The delivery happened, the hub does not
// know, and the row waits for its lease to expire so it can be reconciled or
// re-delivered. The conversion is the fix either way; the reason it matters is
// not the one it looked like.
const errText = (e) =>
  e == null ? null
  : typeof e === "string" ? e
  : (e instanceof Error ? (e.message || String(e)) : String(e));

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
/**
 * May this effect still be DELIVERED?
 *
 * The generation fence answers a different question. A redesign bumps the
 * generation, so an effect decided under the old contract is fenced -- but a
 * HOLD, a CANCELLATION, an infeasibility and a lost claim all leave the
 * generation ALONE, deliberately: they stop the task without redefining its
 * contract. So `leaseEffect`'s generation check passes for an effect enqueued
 * before the stop, and a task the founder has stopped could still push, comment
 * or merge.
 *
 * `void-pending` was supposed to cover this and cannot reach the whole set: it
 * marks `pending` rows, and an effect INFLIGHT when the stop commits is not one.
 * When its worker reports a retryable failure the row went back to `pending` and
 * became deliverable again -- so the gap was not a missed row, it was a row that
 * came back.
 *
 * CANCELLABLE ONLY, which is the column's existing meaning: a push mid-transport
 * is `cancellable = 0` because the bytes may already be on the wire, and
 * abandoning it is not a compensation. Those still finish. Everything the task
 * could safely abandon stops being deliverable the moment the task stops.
 *
 * ACTIVE is the whole of it -- HELD, DRAINING and TERMINAL are every other
 * phase -- so this cannot drift as phases are added.
 */
const stillDeliverable = (db, row) => {
  if (!row.cancellable) return true;
  if (!row.task_id) return true;                 // not a task's effect
  const t = db.prepare("SELECT phase FROM task WHERE id = ?").get(row.task_id);
  if (!t) return true;                           // no task row: the FK decides, not this
  if (ACTIVE.includes(t.phase)) return true;

  // THE STOP'S OWN EFFECTS ARE NOT WHAT IT STOPS.
  //
  // A hold enqueues the comment that EXPLAINS the hold; a cancellation enqueues
  // the close and its notice. Those are the compensations of the very transition
  // that stopped the task, and suppressing them would silence the explanation
  // the stop exists to give -- the first version of this predicate did exactly
  // that, and it was found by the hold-then-resume test rather than by reading.
  //
  // `fence` is the phase_event seq that enqueued the row, and the stop's own
  // compensations carry the stopping transition's seq. So an effect enqueued AT
  // OR AFTER the moment the task stopped belongs to the stop; anything earlier
  // is work the task was doing, and that is what must not continue.
  const stoppedAt = db.prepare(
    `SELECT max(seq) s FROM phase_event
      WHERE task = ? AND to_phase NOT IN (${ACTIVE.map(p => `'${p}'`).join(",")})`)
    .get(row.task_id)?.s ?? null;
  return stoppedAt === null ? true : row.fence >= stoppedAt;
};

/**
 * The conversation an effect speaks into, or null if it does not speak.
 *
 * `(repo_id, pr)` is the identity, because that pair is `task_pr`'s primary key:
 * a pull request number is unique inside its repository and nowhere else. It is
 * read from `args` rather than from a column because that is where the enqueue
 * already puts it, and inventing a second home for the same fact is how the two
 * PR shapes drifted apart before migration 2 merged them.
 */
const COMMENT_KIND = "gh.pr.comment";
const conversationOf = (row) => {
  if (row.kind !== COMMENT_KIND) return null;
  let a;
  try { a = JSON.parse(row.args); } catch { return null; }
  return (a?.repo_id == null || a?.pr == null) ? null : `${a.repo_id}:${a.pr}`;
};

/**
 * Is an EARLIER comment on the same pull request still unsettled?
 *
 * `id` is the enqueue order, and only `pending` and `inflight` rows are still
 * going to be delivered -- a fenced, voided or dead-lettered predecessor never
 * arrives, so it must not hold the queue for ever.
 */
const blockedByEarlierComment = (db, row) => {
  const conv = conversationOf(row);
  if (!conv) return false;
  return db.prepare(
    `SELECT id, kind, args FROM outbox
      WHERE kind = ? AND status IN ('pending','inflight') AND id < ? ORDER BY id`)
    .all(COMMENT_KIND, row.id)
    .some(earlier => conversationOf(earlier) === conv);
};

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

      // A TASK THAT HAS STOPPED DELIVERS NOTHING IT COULD ABANDON. The
      // generation fence above cannot answer this: a hold, a cancellation, an
      // infeasibility and a lost claim all leave the generation alone, so an
      // effect enqueued before the stop still matches it.
      if (!stillDeliverable(db, row)) {
        db.prepare(
          `UPDATE outbox SET status='fenced', worker=NULL,
                             last_error=?, updated_at=unixepoch() WHERE id=?`)
          .run("the task is no longer active; a cancellable effect is not delivered after it stops",
               row.id);
        emitRow(db, "outbox.fenced", row.id);
        settleDrainFor(db, row.id);
        continue;
      }

      // ONE CONVERSATION, ONE ORDER. Comments on a pull request are a running
      // commentary on the task's status, and the LAST one to arrive is the one a
      // reader believes -- so their order is part of their meaning in a way a
      // push's is not.
      //
      // Nothing made them ordered. A hold enqueues "held" and a resume enqueues
      // "resumed"; the resume neither waits for the first nor voids it -- and it
      // must not, because a founder's resume blocking on a comment is how
      // hold-then-resume deadlocked once already. So both sat deliverable at
      // once: `stillDeliverable` re-admits the older row the moment the task is
      // ACTIVE again, two executors lease them independently, and the transports
      // race. "held" landing second leaves an ACTIVE task whose pull request says
      // it is stopped, with nothing to correct it until the next transition.
      //
      // Ordering is a DELIVERY property, so it belongs here rather than in a
      // guard on the resume: an older unsettled comment for the same pull request
      // means this one is not due yet. Skipped, not fenced -- the row keeps its
      // place and the next pass reconsiders it.
      //
      // Fail-closed, and deliberately: if that older row is stuck `inflight`
      // because its reconciler cannot reach GitHub, later comments on that pull
      // request wait behind it. Silence is recoverable; a status line that
      // contradicts the task is not.
      if (blockedByEarlierComment(db, row)) continue;

      // A switch the founder has not turned on is CONFIGURATION, not a fault: it
      // burns no attempt and raises no escalation, and it is terminal, because
      // retrying a decision the operator made is not recovery.
      // FAIL CLOSED ON ABSENCE, not only on an explicit false. Every builder
      // capability in the profile schema defaults to FALSE, so an omitted entry
      // means "off" everywhere else in the system -- and here `undefined === false`
      // is false, so a partially populated map, or the `capabilities = {}` this
      // function defaults to, authorised the effect. That is a real push, PR
      // operation or merge performed because a key was missing from an object,
      // and it silently undid the merge switch added earlier in this branch.
      // The switch has to be present AND true.
      const cap = capabilityFor(row);
      if (cap && capabilities[cap] !== true) {
        db.prepare(
          `UPDATE outbox SET status='refused', worker=NULL,
                             last_error=?, updated_at=unixepoch() WHERE id=?`)
          .run(capabilities[cap] === undefined
                 ? `${cap} is not set; every builder capability defaults to off`
                 : `${cap} is off`, row.id);
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
    // NOT BACK INTO THE QUEUE FOR A STOPPED TASK. `void-pending` marks `pending`
    // rows and cannot reach one that was INFLIGHT when the stop committed -- so
    // the gap was never a missed row, it was a row that came BACK. Fenced here
    // rather than left pending for `leaseEffect` to catch, because a pending row
    // keeps its task's drain outstanding and `fenced` is terminal for a drain.
    else if (retryable && !stillDeliverable(db, row)) status = "fenced";
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
      .run(status, result === null ? null : canonicalHub(result), errText(error), notBefore, notBefore, id);
    emitRow(db, "outbox.settled", id);
    // Only a TERMINAL status clears the drain; `settleDrainFor` enforces that
    // itself, so a retryable failure that returned the row to `pending` leaves
    // the task's drain outstanding, which is what keeps CANCELLING honest.
    settleDrainFor(db, id);
    return { status, id };
  });
}

// How long before a row whose reconciler FAILED is asked again.
//
// It has to escalate, or an unreachable reconciler is polled at a fixed rate for
// as long as the outage lasts. `backoffSeconds` cannot be used as it stands:
// its curve is driven by `attempts`, which counts DELIVERIES and by design does
// not move on this path -- so it would return the same interval for ever.
//
// So the previous interval is read from the CLOCK instead of a counter: the gap
// since the row was last touched IS the last wait, and doubling it walks the
// same curve up to the same ceiling without storing anything. A durable
// reconcile-attempt column is the fuller answer and needs a migration; this is
// the half that does not, and it is bounded either way.
const REASK_MIN = 30, REASK_MAX = 3600;
const reaskSeconds = (at, row) =>
  Math.min(REASK_MAX, Math.max(REASK_MIN, 2 * Math.max(0, at - row.updated_at)));

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
  if (!expired.length) return { settled: 0, returned: 0, dead: 0, stale: 0, unobserved: 0 };

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
    let settled = 0, returned = 0, dead = 0, stale = 0, unobserved = 0;
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
               errText(verdict.error), row.id);
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
      // A STOPPED TASK'S EFFECT IS FENCED HERE TOO, for the same reason as the
      // settle path: this is the other way a row leaves `inflight`.
      if (!stillDeliverable(db, row)) {
        db.prepare(
          `UPDATE outbox SET status='fenced', worker=NULL, lease_expires_at=0,
                             last_error=?, updated_at=unixepoch() WHERE id=?`)
          .run("the task is no longer active; a cancellable effect is not delivered after it stops",
               row.id);
        emitRow(db, "outbox.fenced", row.id);
        settleDrainFor(db, row.id);
        stale++;                      // counted, not silently dropped
        continue;
      }

      // THE DELIVERY BUDGET DOES NOT RATION THE READ THAT COULD SAVE US.
      //
      // `attempts` counts DELIVERIES -- each one a POST that could duplicate an
      // external act. A reconciler that could not LOOK has performed no delivery
      // and can only ever conclude "still cannot tell", so charging it to that
      // budget makes the safe act as scarce as the dangerous one. Spending it
      // dead-letters the row and settles its drain, and the task then proceeds
      // as though nothing happened -- while the effect may have landed on one of
      // those attempts and nobody will ever look again. CANCELLED becomes
      // reachable with a push or a merge outstanding, which is the single thing
      // the drain exists to prevent.
      //
      // So a reconcile that ERRORED never spends the budget. It is unbounded on
      // purpose: the alternative is discarding a possibly-delivered effect, and a
      // task whose drain will not settle is FAIL-CLOSED and visible in
      // `task why`, while a dead-lettered one is fail-open and silent.
      //
      // BUT NOT BACK INTO THE DELIVERY QUEUE. `pending` is not a holding area,
      // it is the queue `leaseEffect` takes from -- and that scan filters on the
      // schedule alone, never on the attempt limit. So a row kept for further
      // OBSERVATION was leased for another DELIVERY the moment its backoff
      // expired, and a prolonged reconciler outage turned into an unbounded run
      // of duplicate pushes, merges and PR operations: exactly the harm not
      // spending the budget was meant to avoid, arrived at by the other road.
      //
      // Retention has to be a state the deliverer cannot see. `inflight` already
      // is one: `leaseEffect` reads `pending` only, the reconcile sweep reads
      // expired `inflight` rows, and `outbox_live_key` keeps the idempotency key
      // reserved while the effect's fate is unknown -- which is right, because it
      // may have landed. So the row simply stays where it is, with its lease
      // deadline pushed out, and the next sweep ASKS AGAIN rather than acts. The
      // CAS on (worker, lease_token) still matches, because neither changes here.
      if (verdict?.reconcileError) {
        db.prepare(
          `UPDATE outbox SET lease_expires_at=?, last_error=?, updated_at=unixepoch()
            WHERE id=?`)
          .run(at + reaskSeconds(at, row), `reconcile failed: ${verdict.reconcileError}`, row.id);
        emitRow(db, "outbox.unobserved", row.id);
        unobserved++;
        continue;
      }
      const spent = row.attempts >= row.max_attempts;
      // BACKED OFF LIKE ANY OTHER RETRY. A row returned here is due immediately,
      // and `leaseEffect` takes every pending row whose schedule is due -- so an
      // effect requeued because the external service was UNREACHABLE was leased
      // again on the next pass and the externally ambiguous action attempted
      // straight back at the service that just failed. `settleEffect` learned
      // this in the previous round and this path did not: two ways out of
      // inflight, one of them honouring the schedule.
      const backoff = spent ? null : backoffSeconds(row.attempts + 1);
      db.prepare(
        `UPDATE outbox SET status=?, worker=NULL, lease_expires_at=0,
                           not_before=CASE WHEN ? IS NULL THEN not_before ELSE unixepoch() + ? END,
                           last_error=COALESCE(?, last_error), updated_at=unixepoch()
          WHERE id=?`)
        .run(spent ? "dead_letter" : "pending", backoff, backoff,
             spent ? `unobserved after ${row.attempts} of ${row.max_attempts} attempts` : null,
             row.id);
      emitRow(db, "outbox.settled", row.id);
      if (spent) { settleDrainFor(db, row.id); dead++; } else returned++;
    }
    return { settled, returned, dead, stale, unobserved };
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
