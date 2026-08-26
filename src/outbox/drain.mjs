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
 *  · DELIVERY is bounded; CONFIRMING a delivery is bounded separately. A retry
 *    that posts and a retry that only reads have different costs and different
 *    risks, so charging them to one budget made the safe one as scarce as the
 *    dangerous one -- and dead-lettered comments that had actually been posted.
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
const deadline = ms => {
  let timer;
  const promise = new Promise(resolve => {
    // MILLISECONDS, and no one-second floor. Taking seconds and flooring at 1
    // rounded every sub-second deadline up to a full second, so a pass with 100ms
    // left would not abandon a hung handler for ten times its own budget. The
    // floor was protecting against a zero delay; 1ms does that without inventing
    // nine hundred more.
    timer = setTimeout(() => resolve({
      ok: false, retryable: true,
      error: `the handler did not finish within ${Math.round(ms)}ms, which is inside its lease; abandoned before the claim could lapse mid-delivery`,
    }), Math.max(1, ms));
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

/**
 * How long the whole PASS may take, whatever it finds.
 *
 * `max` bounds how many effects a pass performs. It does not bound how long the
 * pass takes, and those are different guarantees -- ten deliveries each given a
 * fresh deadline can spend the sum of ten deadlines, around forty minutes at the
 * defaults. This runs inside a tick that also evaluates pull requests, publishes
 * verdicts, heartbeats workers and raises alerts, and none of that happens while a
 * drain grinds through failing effects. An outbox in trouble would stop the
 * guardian doing everything else it exists for.
 *
 * A pass that runs out of budget stops leasing. What is left stays pending and the
 * next tick continues, which is the same contract as running out of rows.
 */
const PASS_BUDGET_MS = 60_000;

/**
 * Time left until an absolute instant, on the SAME clock the budget was set by.
 *
 * The clock is passed in rather than reached for. Half of this file used the
 * injected `now` and half used `Date.now()`, which agree exactly until a test
 * injects a clock -- and then the pass budget and the delivery deadline are
 * measured against two different notions of the time, and neither reading means
 * what it says.
 */
const remainingMs = (deadlineAt, now) => deadlineAt - now();

export async function drainOutbox({ db, log = () => {}, handlers, api, actor = null,
                                    worker = "drainer", max = 10, leaseSeconds = 300,
                                    budgetMs = PASS_BUDGET_MS, now = () => Date.now() }) {
  const kinds = Object.keys(handlers ?? {});
  // Recovery FIRST, so a row whose drainer died is a candidate in this pass rather
  // than the next one. It returns expired inflight rows to pending; it does not
  // touch the fence, because the next lease bumps it and that is what makes the
  // dead holder's settle stale.
  // BEFORE recovery, not after. Recovery updates every expired inflight row and
  // emits an event per crash-loop dead letter; with a troubled queue that is real
  // work, and starting the clock afterwards meant it cost nothing against the
  // budget and the pass then still got its full sixty seconds. A whole-pass bound
  // that excludes part of the pass is not a whole-pass bound.
  const startedAt = now();
  const recovered = recoverOutbox(db);
  if (recovered.length) log(`  outbox: recovered ${recovered.length} row(s) from a drainer that did not finish`);
  // Said separately, because a crash-loop is a different problem from a crash and
  // needs a person rather than another pass.
  for (const d of recovered.deadLettered ?? [])
    log(`  outbox: ${d.kind} #${d.id} DEAD-LETTERED — ${d.attempts} lease(s) and never once settled; its drainer is crashing`);

  // ONE absolute instant for the pass, computed once and never re-derived.
  //
  // It used to be re-derived per iteration as `Date.now() + leftInPass`, where
  // `leftInPass` had been sampled before the lease. Any wait between the two --
  // `leaseOutbox` can block behind another SQLite writer for up to the ten seconds
  // the connection permits -- was silently REFUNDED to the pass, because the
  // remainder was old and the instant it was added to was new. A one-second pass
  // could wait ten seconds and then hand a delivery another full second. An
  // absolute deadline cannot be refunded: waiting spends it.
  const passDeadlineAt = startedAt + budgetMs;
  // The settle reserve of the BUDGET, not of the lease. I wrote it against the
  // lease first: at the defaults that is 50s of a 60s budget, so the pass would
  // have refused to start a second delivery ever. Same constant, and it has to be
  // applied to the quantity being spent -- reserving a fraction of a number the
  // budget has no relation to reserves the wrong thing.
  const floorMs = Math.max(1, budgetMs * SETTLE_RESERVE);

  const done = [];
  let outOfTime = false;
  for (let i = 0; i < max; i++) {
    // Checked BEFORE leasing. A row leased and then abandoned would have its
    // attempt counted for work never begun, and would sit inflight until its lease
    // expired -- so the budget has to be spent deciding not to start, never
    // deciding to stop partway.
    // The budget bounds the PASS, so it has to bound the delivery inside it too.
    // Checking only before leasing left the first slow delivery free to spend its
    // whole lease -- around 250s against an advertised 60s budget -- and the pass
    // was over by the time the check came round again. A bound that the work
    // inside it does not see is not a bound.
    // Not merely "any time left". A row leased with a sliver remaining is a row
    // whose attempt is spent on a call that cannot finish, and it then sits
    // inflight until its lease expires.
    if (remainingMs(passDeadlineAt, now) < floorMs) { outOfTime = true; break; }
    const job = leaseOutbox(db, { worker, leaseSeconds, kinds });
    if (!job) break;

    // Asked AGAIN, because the lease itself can wait. The check above decides
    // whether to reach for a row; this one decides whether the row it got can
    // still be delivered, and between the two lies a write lock that SQLite will
    // hold a caller on for as long as the connection's busy timeout allows.
    //
    // Settled as UNSTARTED rather than skipped or failed. Skipping would leave the
    // row inflight until its lease lapsed, keeping it out of the next pass; a
    // failure would charge it an attempt for work never begun, and on the last
    // permitted delivery that is enough to move it into reconciliation with no
    // POST ever sent -- where a correct "no marker" then dead-letters an effect
    // that was never delivered. The fence stays bumped, because the lease did
    // happen; the budget does not, because the attempt did not.
    if (remainingMs(passDeadlineAt, now) < floorMs) {
      settleOutbox(db, { id: job.id, leaseToken: job.lease_token, ok: false, unstarted: true,
                         error: "the pass budget was spent while this row was being leased; not started" });
      log(`  outbox: ${job.kind} #${job.id} returned unstarted — the pass budget went while it was being leased`);
      outOfTime = true;
      break;
    }

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
      // The SMALLER of what the lease allows and what the pass has left. The lease
      // protects the row from a second drainer; the pass protects the tick from
      // this one. A delivery has to respect both, and neither implies the other.
      const byLease = now() + Math.max(1, leaseSeconds * (1 - SETTLE_RESERVE)) * 1000;
      const deadlineAt = Math.min(byLease, passDeadlineAt);
      const bounded = (a, opts = {}) => {
        const left = remainingMs(deadlineAt, now);
        if (left <= 0) return { ok: false, out: "", err: "the delivery deadline passed before this call started", timedOut: true };
        // The bound goes LAST, so a handler cannot spread its own over it. The
        // spread order was the other way round: a handler passing a conventional
        // per-call timeout replaced the remaining deadline with its own, and the
        // synchronous `gh` call could then outrun both the pass budget and the
        // lease -- reopening the duplicate-delivery race this wrapper exists to
        // close. Clamped rather than simply overridden, so a handler asking for
        // LESS still gets less.
        // A POSITIVE INTEGER, and both halves of that are load-bearing. Measured on
        // node v24.17.0:
        //
        //   timeout: 8333.333 -> ERR_OUT_OF_RANGE, thrown before the call runs
        //   timeout: 0        -> no bound at all; a 1.5s child ran to completion
        //
        // `left` is fractional whenever the lease binds (`leaseSeconds: 10` gives
        // 8333.333ms), so every GitHub call would have failed without running --
        // and a handler asking for 0 would have removed the bound entirely, which
        // is the one thing the clamp exists to make impossible.
        const asked = opts.timeoutMs;
        const want = Number.isFinite(asked) && asked > 0 ? Math.min(left, asked) : left;
        return api(a, { ...opts, timeoutMs: Math.max(1, Math.floor(want)) });
      };
      const deliver = Promise.resolve(
        handlers[job.kind](args, { api: bounded, idemKey: job.idem_key, actor, log,
          // A reconciling lease exists to CONFIRM, never to deliver. A row that has
          // spent its delivery budget is handed back so the marker pre-check can
          // find a delivery whose settle was lost -- but if the check finds
          // nothing, posting would deliver past the budget the reconciling phase
          // was granted in spite of. A handler that cannot confirm a prior
          // delivery must decline instead.
          // Read from the RECONCILIATION counter, which is only ever bumped in that
          // phase, and never from `attempts` against its budget. The latter is
          // ambiguous by one: a row leased on its last permitted delivery comes
          // back with `attempts === max_attempts`, indistinguishable from a row
          // that has spent them, so the test would refuse to post on the very
          // attempt the budget had granted.
          reconcileOnly: job.reconcile_attempts > 0 }));
      const clock = deadline(remainingMs(deadlineAt, now));
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
      log(`  outbox: ${job.kind} #${job.id} DEAD-LETTERED after ${job.attempts} delivery attempt(s)`
          + `${job.reconcile_attempts ? ` and ${job.reconcile_attempts} reconciliation(s)` : ""}`
          + ` — ${String(outcome.error).slice(0, 200)}`);
    else if (verdict === "stale")
      log(`  outbox: ${job.kind} #${job.id} settle refused — another drainer holds it`);
  }

  // Said every time it is non-zero, not once. A queue holding effects nothing can
  // perform is the failure this line exists to make visible, and it is invisible
  // by construction: the rows are pending, the drainer is healthy, and the only
  // symptom is a comment that never appeared.
  // Said out loud. A pass that stopped early looks exactly like a pass that had
  // nothing to do, and the difference matters: one means the queue is empty, the
  // other means it is moving slower than it fills.
  if (outOfTime)
    log(`  outbox: pass budget of ${Math.round(budgetMs / 1000)}s spent after ${done.length} effect(s); the rest wait for the next tick`);

  // EVERY pass, not only the one that created them. A process that exits after
  // `settleOutbox` commits `dead_letter` and before the line below leaves a row
  // nothing ever mentions again: it is not leaseable, `pendingWithNoHandler` does
  // not include it, and a terminal effect is precisely the one that needs a person.
  // Read from the store so a crash cannot lose the notification.
  const standing = db.prepare(`SELECT kind, count(*) n FROM outbox
                               WHERE status='dead_letter' GROUP BY kind`).all();
  if (standing.length)
    log(`  outbox: ${standing.map(s => `${s.n} ${s.kind}`).join(", ")} DEAD-LETTERED and waiting for a person`);

  const stranded = pendingWithNoHandler(db, kinds);
  if (stranded.length)
    log(`  outbox: ${stranded.map(s => `${s.n} ${s.kind}`).join(", ")} pending with no handler in this build`);

  return { recovered: recovered.length, done, stranded, outOfTime, deadLettered: standing };
}
