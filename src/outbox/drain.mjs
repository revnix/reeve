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
 * How long a single effect may take, as a fraction of its lease.
 *
 * A handler that outruns its lease is the one failure the fence cannot repair. The
 * lease lapses mid-delivery, recovery hands the row to a second drainer, and if
 * that one's pre-check runs before the first one's POST lands, BOTH post. The
 * fence then correctly refuses the first drainer's settle -- and the duplicate
 * comment is already on the pull request, because a fence orders writes to the
 * DATABASE and has no authority over GitHub.
 *
 * **This race is what the SUBPROCESS timeout closes, not this one.** The real
 * handler chain is synchronous: `apiAsInstallation` uses `execFileSync`, so while
 * a call is in flight nothing else in this process runs -- no timer fires and no
 * promise settles. The race below cannot even create its timer until the handler
 * has returned. An earlier version of this comment claimed the race bounded
 * delivery; it did not, and the test that "proved" it used an async handler that
 * never resolved, which is a shape the production path cannot take. That fixture
 * could not exhibit the defect it was written for.
 *
 * What actually bounds a hung GitHub call is `timeoutMs` on the subprocess, which
 * kills `gh` and returns. What this race still buys is the ASYNC case -- a handler
 * that awaits something and never settles -- so it stays, described honestly:
 * defence for one shape, and not the shape that matters most.
 */
const HANDLER_DEADLINE = 2 / 3;

/**
 * How long a single GitHub call may run, given the lease it must finish inside.
 *
 * Half the lease, so a slow pre-check and the POST that follows it both fit with
 * room for the settle. Passed to the handler and on to the subprocess, because a
 * bound the caller cannot enforce is not a bound.
 */
const callTimeoutMs = leaseSeconds => Math.max(5, Math.floor(leaseSeconds / 2)) * 1000;

export async function drainOutbox({ db, log = () => {}, handlers, api,
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
      // The timeout travels WITH the caller, so a handler cannot make an unbounded
      // call even by accident: there is one `api` and it is already bounded.
      const timeoutMs = callTimeoutMs(leaseSeconds);
      const bounded = (a, opts = {}) => api(a, { timeoutMs, ...opts });
      const deliver = Promise.resolve(
        handlers[job.kind](args, { api: bounded, idemKey: job.idem_key, attempt: job.attempts, log }));
      const clock = deadline(leaseSeconds * HANDLER_DEADLINE);
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
