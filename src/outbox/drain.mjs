/**
 * The drainer: the single place an enqueued effect becomes a real one.
 *
 * The outbox exists so that a decision and the side effect it implies are written
 * in ONE transaction. Without that, reeve decides to request a review, crashes
 * before the comment goes out, and comes back with a state that says the round
 * happened. With it, the effect is durable the moment the decision is, and this
 * loop is what carries it out afterwards.
 *
 * Three properties it has to hold, and the reason each one is here:
 *
 *  · ONE holder at a time. `leaseOutbox` takes a row and bumps its fence;
 *    `settleOutbox` refuses a settle from anyone else. A stalled drainer therefore
 *    cannot mark done a delivery that a live one is in the middle of making.
 *  · BOUNDED per call. This runs inside a tick that also has pull requests to
 *    read; a queue that grew faster than a tick could drain would otherwise starve
 *    everything else. What is left stays pending and the next tick continues.
 *  · It never leases a kind it cannot perform, and it SAYS how many such rows are
 *    waiting. A row nothing can deliver looks exactly like an empty queue.
 */
import { leaseOutbox, settleOutbox, recoverOutbox, pendingWithNoHandler } from "../db/ops.mjs";

export async function drainOutbox({ db, log = () => {}, handlers, api,
                                    worker = "drainer", max = 10, leaseSeconds = 300 }) {
  const kinds = Object.keys(handlers ?? {});
  // Recovery FIRST, so a row whose drainer died is a candidate in this pass rather
  // than the next one. It returns expired inflight rows to pending; it does not
  // touch the fence, because the next lease bumps it and that is what makes the
  // dead holder's settle stale.
  const recovered = recoverOutbox(db);
  if (recovered.length) log(`  outbox: recovered ${recovered.length} row(s) from a drainer that did not finish`);

  const done = [];
  for (let i = 0; i < max; i++) {
    const job = leaseOutbox(db, { worker, leaseSeconds, kinds });
    if (!job) break;

    let outcome;
    try {
      const args = JSON.parse(job.args);
      // A handler is awaited whether or not it is async, so one of each composes.
      outcome = await handlers[job.kind](args, { api, idemKey: job.idem_key, log });
    } catch (e) {
      // A throw is the handler failing, not the drainer. Retryable by default: an
      // unrecognised fault is more often transient than terminal, and the budget
      // dead-letters it soon enough if it is not.
      outcome = { ok: false, retryable: true, error: `handler threw: ${e.message}` };
    }
    if (!outcome || typeof outcome.ok !== "boolean")
      outcome = { ok: false, retryable: false, error: `handler for ${job.kind} returned ${JSON.stringify(outcome)}` };

    const verdict = settleOutbox(db, {
      id: job.id, leaseToken: job.lease_token, ok: outcome.ok,
      result: outcome.result, error: outcome.error, retryable: outcome.retryable !== false,
    });
    done.push({ id: job.id, kind: job.kind, verdict });
    if (verdict === "dead_letter")
      log(`  outbox: ${job.kind} #${job.id} DEAD-LETTERED after ${job.attempts} attempt(s) — ${String(outcome.error).slice(0, 200)}`);
    else if (verdict === "stale")
      log(`  outbox: ${job.kind} #${job.id} settle refused — another drainer holds it`);
  }

  // Said every time it is non-zero, not once. A queue holding effects nothing can
  // perform is the failure this line exists to make visible, and it is invisible
  // by construction: the rows are pending, the drainer is healthy, and the only
  // symptom is a comment that never appeared.
  const stranded = pendingWithNoHandler(db, kinds);
  if (stranded.length)
    log(`  outbox: ${stranded.map(s => `${s.n} ${s.kind}`).join(", ")} pending with no handler in this build`);

  return { recovered: recovered.length, done, stranded };
}
