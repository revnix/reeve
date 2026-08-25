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

/**
 * Resolves to a retryable failure once `seconds` have passed. Never rejects.
 *
 * Cancelled explicitly by the winner rather than `unref`d. An unref'd timer does
 * not hold the event loop open, which sounds like the tidy choice and is the wrong
 * one: with nothing else pending the process exits while the race is unsettled, so
 * the deadline never fires and a hung handler hangs forever instead of being
 * abandoned. Measured -- the first version did exactly that and the test warned
 * about an unsettled await rather than failing.
 */
const deadline = seconds => {
  let timer;
  const promise = new Promise(resolve => {
    timer = setTimeout(() => resolve({
      ok: false, retryable: true,
      error: `the handler did not finish within ${Math.round(seconds)}s, which is inside its lease; abandoned before the claim could lapse mid-delivery`,
    }), Math.max(1, seconds) * 1000);
  });
  promise.cancel = () => clearTimeout(timer);
  return promise;
};

/**
 * Why the async race below still exists, given the subprocess timeout.
 *
 * A handler that outruns its lease is the one failure the fence cannot repair: the
 * lease lapses mid-delivery, recovery hands the row to a second drainer, and if
 * that one's pre-check runs before the first one's POST lands, BOTH post. The
 * fence then correctly refuses the first drainer's settle -- and the duplicate is
 * already on the pull request, because a fence orders writes to the DATABASE and
 * has no authority over GitHub.
 *
 * **The subprocess timeout is what closes that race, not the race below.** The
 * real handler chain is synchronous -- `apiAsInstallation` uses `execFileSync` --
 * so while a call is in flight nothing else in this process runs: no timer fires
 * and no promise settles. An earlier version of this comment claimed the race
 * bounded delivery. It did not, and the test that "proved" it used an async
 * handler that never resolves, a shape the production path cannot take.
 *
 * The race stays for the genuinely async case -- a handler that awaits something
 * and never settles -- and it shares the same deadline, so the two bounds cannot
 * disagree about when a delivery has run out of time.
 */

/**
 * One deadline for the whole delivery, shared across however many calls it makes.
 *
 * A per-call bound is not a delivery bound. `gh.pr.comment` makes two sequential
 * calls -- the marker pre-check, then the POST -- so giving each half the lease
 * lets the pair consume all of it, and the row can be recovered by another drainer
 * while the first POST is still in flight. That is the duplicate-delivery race
 * again, reached through the fix for it.
 *
 * So the drainer computes ONE deadline and each call gets what is left of it, less
 * a reserve for the settle that has to follow. A call with no time left is refused
 * before it starts rather than started with a one-millisecond timeout.
 */
const SETTLE_RESERVE = 1 / 6;   // of the lease, kept back so the settle can happen

const remainingMs = (deadlineAt) => deadlineAt - Date.now();

export async function drainOutbox({ db, log = () => {}, handlers, api, actor = null,
                                    worker = "drainer", max = 10, leaseSeconds = 300 }) {
  const kinds = Object.keys(handlers ?? {});
  // Recovery FIRST, so a row whose drainer died is a candidate in this pass rather
  // than the next one. It returns expired inflight rows to pending; it does not
  // touch the fence, because the next lease bumps it and that is what makes the
  // dead holder's settle stale.
  const recovered = recoverOutbox(db);
  if (recovered.length) log(`  outbox: recovered ${recovered.length} row(s) from a drainer that did not finish`);
  // Said separately, because a crash-loop is a different problem from a crash and
  // needs a person rather than another pass.
  for (const d of recovered.deadLettered ?? [])
    log(`  outbox: ${d.kind} #${d.id} DEAD-LETTERED — ${d.attempts} lease(s) and never once settled; its drainer is crashing`);

  const done = [];
  for (let i = 0; i < max; i++) {
    const job = leaseOutbox(db, { worker, leaseSeconds, kinds });
    if (!job) break;

    let outcome;
    try {
      const args = JSON.parse(job.args);
      // A handler is awaited whether or not it is async, so one of each composes.
      // `attempt` reaches the handler because idempotency depends on it: only a
      // retry can find a previous delivery, and a first attempt that looked would
      // be paying for an answer it already has.
      // The deadline travels WITH the caller, so a handler cannot make an unbounded
      // call even by accident, and cannot make TWO calls that each fit the lease
      // while the pair does not. There is one `api`, it is already bounded, and the
      // bound shrinks as the delivery spends it.
      const deadlineAt = Date.now() + Math.max(1, leaseSeconds * (1 - SETTLE_RESERVE)) * 1000;
      const bounded = (a, opts = {}) => {
        const left = remainingMs(deadlineAt);
        if (left <= 0) return { ok: false, out: "", err: "the delivery deadline passed before this call started", timedOut: true };
        return api(a, { timeoutMs: left, ...opts });
      };
      const deliver = Promise.resolve(
        handlers[job.kind](args, { api: bounded, idemKey: job.idem_key, actor, log }));
      const clock = deadline(Math.max(1, remainingMs(deadlineAt) / 1000));
      try { outcome = await Promise.race([deliver, clock]); }
      finally { clock.cancel(); }   // the loser's timer must not outlive the race
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
