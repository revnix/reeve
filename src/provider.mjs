// provider -- who is allowed to talk to the model, and when.
//
// The subscription is the real choke point. Observation after the fact cannot
// reserve shared quota: two daemons can both see free capacity and both launch
// before either exit is recorded, and the second one discovers the limit by
// being throttled. So admission is a TRANSACTION -- `BEGIN IMMEDIATE`, decide,
// write, commit -- and a claim either holds a slot or does not.
//
// This file holds POLICY only: the admission rule, the reservation arithmetic,
// the cooldown comparison. Every statement lives in `src/build/providerdb.mjs`,
// because this module sits at the top level -- both daemons import it -- and
// that is outside the two directories allowed to contain raw SQL. The guardian
// therefore imports a policy function rather than a query builder.
//
// THE ASYMMETRY BETWEEN THE TWO OWNERS IS THE POINT. The guardian is the
// watchman; the builder is the thing being restrained. A slot is reserved for
// the guardian, and a guardian that cannot be admitted is QUEUED rather than
// refused -- its queued row is what stops the next builder taking the slot it is
// waiting for. Refusing it instead would let a steady stream of builder work
// starve the watchman indefinitely, which inverts the priority the reservation
// exists to give it.
import { isSameProcess } from "./supervisor.mjs";
import {
  providerTx, providerState, heldCount, heldCountBy, queuedGuardianCount,
  queuedGuardianRequests, liveRequest, youngestHeldBuilder, requestPreemption,
  insertLease, promoteToHeld, renewQueued, oldestQueuedGuardian, nowSeconds, newToken,
  bindLease, touchLease, deleteLease, deleteLeaseById,
  deleteQueued, expiredLeases, recordRateLimit,
  DEFAULT_LIMIT, DEFAULT_RESERVED,
} from "./build/providerdb.mjs";

// How long a lease survives without a heartbeat. A held lease is renewed by the
// run loop while its worker works; expiry is what makes a crashed holder's slot
// recoverable at all, and the reaper still asks whether the process is dead
// before taking it -- a busy process may simply have missed a beat.
export const LEASE_SECONDS = 300;

// Re-exported so the daemon never needs `providerdb` directly: its sweep asks
// for one repository's queued guardian requests, and that is a policy-shaped
// question even though its body is a single SELECT.
export { queuedGuardianRequests };

const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// `assertWritable` is the only thing that throws out of a provider transaction
// in normal operation, and its message is the contract. Everything else is a
// genuine defect and must keep propagating -- a bare catch here would turn a
// constraint violation or a null dereference into a tidy "maintenance".
const isRestoreRefusal = (e) => /a restore is in progress/i.test(e?.message ?? "");

/**
 * Run a scheduler mutation, converting the restore refusal into a return value.
 *
 * Every caller of every mutation here handles `{ ok: false }` already, and a
 * restore is an operator action rather than a fault: the guardian treats it
 * exactly as it treats `at-limit` -- it does not dispatch, and it does not
 * escalate. Making that path an exception would force each of seven call sites
 * to grow a try/catch that all mean the same thing.
 */
const guarded = (db, { isAlive, now }, fn) => {
  try {
    return providerTx(db, { isAlive, at: now }, fn);
  } catch (e) {
    if (isRestoreRefusal(e)) return refuse("maintenance");
    throw e;
  }
};

/**
 * Ask the youngest builder to give its slot back at its next phase boundary.
 *
 * A REQUEST, not a revocation. Preemption happens at a phase boundary and never
 * mid-phase: killing a worker mid-flight is exactly the behaviour this flag
 * exists to avoid, because the work already paid for is lost and the effects it
 * has half-issued still have to be drained.
 *
 * The YOUNGEST, because it has done the least work, so releasing it discards the
 * least. Only when EVERY held slot is builder-held and the limit is actually
 * reached: a guardian queued behind a cooldown is not waiting for a slot, and
 * flagging a builder would ask it to surrender capacity that would then sit idle.
 */
const requestPreemptionIfStarved = (db, state) => {
  const held = heldCount(db);
  if (held === 0 || held < state.limit) return;
  if (heldCountBy(db, "builder") !== held) return;
  const victim = youngestHeldBuilder(db);
  if (victim && !victim.preempt_requested) requestPreemption(db, victim.id);
};

/**
 * Claim a slot on the shared subscription.
 *
 * Returns `{ ok: true, id, owner, repoId, runRef }` -- the identity travels back
 * with the id deliberately, so the caller can fence its later heartbeat and
 * release on it rather than on an integer that a restore can renumber.
 *
 * Refusals: `queued` (a request is recorded and will be served in turn),
 * `cooldown` (with `until`), `at-limit`, `maintenance`, `no-identity`.
 */
export function claimProvider(db, { owner, repoId, runRef, pid, lstart, priority = 0,
                                    budgetUsd = null, isAlive = isSameProcess, now = null } = {}) {
  return guarded(db, { isAlive, now }, () => {
    // IDENTITY FIRST, and `lstart` counts. `provider_lease.repo_id` is NOT NULL
    // because the live-request unique index spans (owner, repo_id, run_ref) and
    // SQLite does not deduplicate keys containing a NULL -- so a caller that
    // cannot resolve the numeric id would insert a live request the index cannot
    // see, and insert another on every tick. And a lease whose holder has no
    // start time can never be reaped: `isAlive(pid, lstart)` is how a dead
    // holder is recognised, and a pid alone is reused.
    if (owner !== "guardian" && owner !== "builder") return refuse("no-identity");
    if (repoId == null || runRef == null || pid == null || lstart == null)
      return refuse("no-identity");

    const at = now ?? nowSeconds(db);
    const state = providerState(db);
    const cooling = state.cooldownUntil != null && state.cooldownUntil > at;
    const existing = liveRequest(db, { owner, repoId, runRef });
    // ALREADY HOLDING -- BUT ONLY FOR THE PROCESS THAT HOLDS IT.
    //
    // A re-ask for a run this caller already has admitted is the same answer,
    // not a second slot, and the live-request unique index would refuse the
    // insert anyway. But answering that to ANY caller naming the same
    // (owner, repoId, runRef) hands out an admission nobody counted: two
    // guardian daemons watching one repository, or a daemon that restarted while
    // its detached worker survived, both proceed to spawn while a single lease
    // exists. The later bind then overwrites the row's process identity, so one
    // of the two workers is invisible to both admission and reaping -- it holds
    // no slot the scheduler knows about and no reaper can ever free it.
    //
    // Identity is pid AND lstart, never pid alone: pids are reused, and lstart is
    // what distinguishes this process from whatever inherited its number.
    if (existing?.status === "held") {
      if (existing.pid === pid && existing.lstart === lstart)
        return { ok: true, id: existing.id, token: existing.token, owner, repoId, runRef };
      // Not an at-limit and not a queue: the run itself is already in flight
      // somewhere, and the answer is neither "wait" nor "try later" but "this is
      // not yours". A caller that treats every refusal as "do not dispatch"
      // behaves correctly on it either way.
      return refuse("held-elsewhere", { id: existing.id });
    }

    const granted = () => {
      const expiresAt = at + LEASE_SECONDS;
      if (existing) {
        promoteToHeld(db, { id: existing.id, pid, lstart, at, expiresAt });
        return { ok: true, id: existing.id, token: existing.token, owner, repoId, runRef };
      }
      const row = insertLease(db, { owner, repoId, runRef, pid, lstart, priority,
                                    budgetUsd, status: "held", at, expiresAt, token: newToken() });
      return { ok: true, id: row.id, token: row.token, owner, repoId, runRef };
    };

    if (owner === "guardian") {
      // AND THE QUEUE IS SERVED IN ORDER. Admitting whichever guardian asks next
      // lets a newer request from another watched repository take the slot an
      // older one is waiting for, and a steady stream of new guardian work
      // starves it indefinitely -- while the API's whole promise for a queued
      // request is that it will be served in turn.
      const oldest = oldestQueuedGuardian(db);
      const ourTurn = !oldest || (existing != null && oldest.id === existing.id);
      if (!cooling && ourTurn && heldCount(db) < state.limit) return granted();
      // QUEUED, NOT DROPPED -- including under a cooldown. The queued row is what
      // holds the next slot for the watchman; dropping the request during a
      // cooldown would let the builder take the slot the moment the cooldown
      // lifted, which is the priority inverted at exactly the busiest moment.
      // A RE-ASK REFRESHES THE QUEUED ROW, it does not merely find it.
      //
      // Reusing the id and leaving the old pid, lstart and expiry behind means a
      // guardian that RESTARTED while queued is represented by its dead
      // predecessor: once the original expiry passes, `reapProviderLeases` sees a
      // dead holder and deletes the queue entry while the replacement daemon is
      // still polling for it -- and a builder takes the next opening ahead of a
      // guardian that never stopped asking. A queued row holds no slot, so
      // refreshing its claimant transfers nothing; it records who is waiting now.
      let id;
      if (existing) {
        id = existing.id;
        renewQueued(db, { id, pid, lstart, at, expiresAt: at + LEASE_SECONDS });
      } else {
        id = insertLease(db, { owner, repoId, runRef, pid, lstart, priority, budgetUsd,
                               status: "queued", at, expiresAt: at + LEASE_SECONDS,
                               token: newToken() }).id;
      }
      // NOT WHILE COOLING. A guardian queued behind a cooldown is not waiting
      // for a SLOT, so asking a builder to surrender one suspends running work
      // to produce capacity that then sits idle until the cooldown lifts. The
      // helper says so in its own contract and this call site ignored it, which
      // is a documented invariant enforced nowhere.
      if (!cooling) requestPreemptionIfStarved(db, state);
      return refuse("queued", { id });
    }

    // THE BUILDER, in the order the refusals matter.
    //
    // A cooldown is a statement about the provider and outranks everything: no
    // admission of any kind helps while the subscription is throttled.
    if (cooling) return refuse("cooldown", { until: state.cooldownUntil });
    // Then the queued watchman. This is the whole reason a guardian queues
    // rather than being refused, and it is checked BEFORE capacity: a freed slot
    // must not be taken by the next builder to ask while a guardian is waiting.
    if (queuedGuardianCount(db) > 0) return refuse("queued");
    // And only then the reservation, which is TWO bounds and not one.
    //
    // The builder's ceiling is on BUILDER-OWNED leases; the overall limit is on
    // everything. Testing the total against `limit - reserved` conflates them and
    // makes usable capacity depend on arrival order: under the documented 2/1, a
    // guardian admitted first put the total at 1 and the builder was then refused
    // although the unreserved slot was free -- while the reverse order admitted
    // both. Same two requests, same limits, different answer depending on who
    // asked first, and a slot left idle whenever guardians arrive first.
    //
    // The reservation still holds, and holds better: capping builders at
    // `limit - reserved` means at least `reserved` slots can never be
    // builder-held, so the guardian's slot is kept by construction rather than
    // by arithmetic that happens to work when the order is convenient.
    if (heldCountBy(db, "builder") >= state.limit - state.reserved) return refuse("at-limit");
    if (heldCount(db) >= state.limit) return refuse("at-limit");
    return granted();
  });
}

/**
 * Give a slot back.
 *
 * The id is a FAST PATH, never an identity. A restore replaces the database,
 * clears `provider_lease` and lets SQLite renumber it, so an integer key can come
 * back pointing at somebody else's request -- and a cleanup running in a `finally`
 * after that has happened would delete an unrelated LIVE lease and admit work
 * past the limit. So when both an id and an identity are given, BOTH must match;
 * the identity alone is sufficient; and `force` is the explicit, named way to
 * delete by id alone for a caller that has genuinely lost the identity.
 */
export function releaseProvider(db, { id = null, token = null, owner = null, repoId = null,
                                      runRef = null, force = false,
                                      isAlive = isSameProcess, now = null } = {}) {
  return guarded(db, { isAlive, now }, () => {
    const hasIdentity = owner != null && repoId != null && runRef != null;
    // AN ID ALONE IS NOT AN IDENTITY, and defaulting to one silently undid the
    // fence this function documents. A restore clears `provider_lease` and lets
    // SQLite reuse the integer, so a cleanup running in a `finally` after that
    // has happened deletes an unrelated LIVE lease -- and the scheduler then
    // undercounts held capacity and admits work past the provider limit. The
    // dangerous call is the easy one to write, which is why it has to be refused
    // rather than merely discouraged.
    //
    // `force` is the named way to say it anyway. It is for a caller that has
    // genuinely lost the identity, and it has to be TYPED at the call site so it
    // appears in review rather than being reached by omission.
    if (!hasIdentity && !force) return refuse("no-identity");
    if (!hasIdentity && id == null) return refuse("no-identity");
    // A release with an identity must carry the token too. `force` remains the
    // one named way past the fence, and it deletes by id alone -- typed at the
    // call site so it shows up in review rather than being reached by omission.
    if (hasIdentity && !force && token == null) return refuse("no-identity");
    const released = (!hasIdentity || (force && id != null))
      ? deleteLeaseById(db, id).changes
      : deleteLease(db, { id, token, owner, repoId, runRef }).changes;
    return { ok: true, released };
  });
}

/**
 * Re-bind a held lease from the daemon that claimed it to the worker it spawned.
 *
 * `claimProvider` records the DAEMON's pid and lstart, because at request time
 * the worker does not exist yet. If the row is left that way, liveness is asked
 * about a long-lived daemon that is always alive -- so a worker that dies takes
 * its slot with it until expiry, and the reaper, whose whole basis is
 * pid-and-lstart death, can never fire for it.
 *
 * The identity fences the write, for the reason given on `releaseProvider`: a
 * rebind keyed on a renumbered id overwrites the NEW holder's pid and lstart,
 * and then neither row can ever be matched again.
 */
export function bindProviderLease(db, { id = null, token = null, owner = null, repoId = null, runRef = null,
                                        pid, lstart, isAlive = isSameProcess, now = null } = {}) {
  return guarded(db, { isAlive, now }, () => {
    // THE FULL IDENTITY, REQUIRED. The predicate this builds always names owner,
    // repo_id and run_ref, so an id-only call matched nothing and returned
    // `{ ok: true, bound: 0 }` -- a silent no-op wearing a success. The lease
    // then stays bound to the long-lived daemon that claimed it, liveness is
    // asked about a process that is always alive, and a detached worker that
    // dies takes its slot with it until expiry.
    if (owner == null || repoId == null || runRef == null) return refuse("no-identity");
    if (token == null) return refuse("no-identity");
    if (pid == null || lstart == null) return refuse("no-identity");
    const at = now ?? nowSeconds(db);
    const bound = bindLease(db, { id, token, owner, repoId, runRef, pid, lstart, at }).changes;
    return { ok: true, bound };
  });
}

/**
 * Renew a held lease while its worker works.
 *
 * The expiry is taken from the HEARTBEAT's clock, not the claim's.
 *
 * NOT the only thing that makes a long run survive its own lease -- that claim
 * was here and was false. `heldCount` counts a held row whatever its expiry, and
 * `reapProviderLeases` spares an expired lease whose holder is still alive, so a
 * run outliving `LEASE_SECONDS` is admitted and reaped correctly with no
 * heartbeat at all. What this actually buys is that `expires_at` keeps
 * describing reality: without it a 20-minute worker spends 15 minutes holding an
 * expired lease, and every query that reads expiry -- `expiredLeases` is one --
 * is then one liveness misread away from acting on a lease that is perfectly
 * healthy.
 */
export function heartbeatProvider(db, { id = null, token = null, owner = null, repoId = null, runRef = null,
                                        isAlive = isSameProcess, now = null } = {}) {
  return guarded(db, { isAlive, now }, () => {
    // The same requirement, for the same reason: an id-only heartbeat matched
    // nothing and reported a successful renewal of a lease it never touched, so
    // the row expired under a worker that was still running. The token is
    // required too -- a restore reproduces the identity exactly, so identity
    // alone renews whatever inherited the name.
    if (owner == null || repoId == null || runRef == null) return refuse("no-identity");
    if (token == null) return refuse("no-identity");
    const at = now ?? nowSeconds(db);
    const beat = touchLease(db, { id, token, owner, repoId, runRef, at,
                                  expiresAt: at + LEASE_SECONDS }).changes;
    return { ok: true, beat };
  });
}

/**
 * Drop a QUEUED request whose dispatch is no longer going to happen.
 *
 * A queued guardian request blocks the next builder admission by design, so one
 * left behind blocks it for ever. Held rows are deliberately out of scope: a held
 * lease is released, not cancelled.
 */
export function cancelQueued(db, { owner, repoId, runRef,
                                   isAlive = isSameProcess, now = null } = {}) {
  return guarded(db, { isAlive, now }, () => {
    if (owner == null || repoId == null || runRef == null) return refuse("no-identity");
    // The withdrawal of any satisfied preemption request is `providerTx`'s job
    // now, on the way out of EVERY provider transaction -- this path, the
    // promotion, and the reaper alike. Three sites learning the same rule one
    // round at a time is the sign the rule was in the wrong place.
    return { ok: true, cancelled: deleteQueued(db, { owner, repoId, runRef }).changes };
  });
}

/**
 * Record a throttling signature and start a cooldown.
 *
 * The signature is kept because "we were throttled" and "we were throttled for
 * THIS reason" are different operational facts, and only the second one tells a
 * founder whether the limit is concurrency, spend, or a per-model cap.
 */
export function noteRateLimit(db, { signature, cooldownSeconds, provider = "claude",
                                    isAlive = isSameProcess, now = null,
                                    observedAt = null, expiresAt = null } = {}) {
  return guarded(db, { isAlive, now }, () => {
    // WHEN IT WAS SEEN AND WHEN THE WINDOW ENDS ARE TWO FACTS, and carrying them
    // through one number made a deferred observation corrupt a newer one.
    //
    // `recordRateLimit` keeps the metadata that is latest BY TIMESTAMP, precisely
    // so observations committing out of order cannot walk `last_429_at`
    // backwards. A caller retrying a 429 it could not write earlier has to say
    // two things: this was observed THEN, and the window still ends THEN+n. With
    // only a duration it could say neither -- it re-derived both from the retry
    // time, so an older observation retried after a newer one had landed looked
    // like the newest and replaced `last_signature` with the stale one. The
    // cooldown stayed right; the diagnostic naming what threw last did not, and
    // that is the whole reason the signature is stored.
    const at = observedAt ?? now ?? nowSeconds(db);
    const until = expiresAt ?? at + (cooldownSeconds ?? 0);
    const state = providerState(db);
    // The limits are carried through on the INSERT half of the upsert so a first
    // 429 against a hub that has never been measured does not silently install
    // limits of zero and refuse everything for ever.
    recordRateLimit(db, { provider, signature, at, until,
                          limit: state.seeded ? state.limit : DEFAULT_LIMIT,
                          reserved: state.seeded ? state.reserved : DEFAULT_RESERVED });
    return { ok: true, until };
  });
}

/**
 * Free the slots of holders that are gone.
 *
 * EXPIRY AND DEATH, both. An expired lease whose holder is still alive is left
 * alone: a busy process may simply have missed a heartbeat, and taking its slot
 * would put two workers on one subscription slot -- the exact thing admission
 * exists to prevent. Death alone is not enough either, because a live claim's
 * holder can be checked before it has had time to beat.
 */
export function reapProviderLeases(db, { isAlive = isSameProcess, now = null } = {}) {
  return guarded(db, { isAlive, now }, () => {
    const at = now ?? nowSeconds(db);
    let reaped = 0;
    for (const lease of expiredLeases(db, at)) {
      if (isAlive(lease.pid, lease.lstart)) continue;
      deleteLeaseById(db, lease.id);
      reaped++;
    }
    return { ok: true, reaped };
  });
}
