// hubsession -- the hub, and the rules for touching it.
//
// The guardian reads its hub dozens of times in one tick and performs a dozen
// scheduler operations on it. Every one of those is governed by the same three
// rules, and before this file they were three helpers and a flag applied by
// whoever remembered to. That is the shape every finding in this area has had:
// a rule that must hold at N call sites, applied at N-1.
//
//   FRESH, ALWAYS            `restoreHub` replaces the hub FILE mid-tick, so a
//                            handle taken earlier can be an unlinked inode -- a
//                            claim then reserves capacity in a database nobody
//                            else can see while the restored scheduler admits
//                            its own. There is no safe old handle. The getter is
//                            a stat and a comparison, so asking often is cheap.
//   NO HANDLE, NO OPERATION  `?? hub` was written as a safety fallback and WAS
//                            the defect. There is a current handle or none.
//   SAID ONCE                an outage is one cause. Raising it per operation
//                            turns a standing failure into a stream of alerts
//                            that each retire the last.
//
// WHY IT IS A FILE RATHER THAN A CONVENTION. `perform` never returns the handle
// it acquires. That is the whole design: a call site cannot hold a stale handle
// because it is never given one, so a new call site cannot skip a rule by being
// written somewhere the author did not read. A session that handed the handle
// back would leave the rules a convention again.
//
// WHAT IT DELIBERATELY DOES NOT OWN. The ARGUMENTS each operation is called
// with, and the ANSWER to "there is no scheduler right now". Those answers are
// not interchangeable -- housekeeping skips, a release DEFERS and carries its
// obligation to the next tick, a claim FAILS OPEN and says so -- and a session
// that chose for them would be deciding policy it cannot see the reason for.
// The caller states its own, beside the operation it governs.
//
// This file performs no I/O of its own and imports nothing. Everything it
// touches arrives as an argument, which is what makes it testable without a
// database and what lets a test observe every handle it ever hands out.

// A VALUE NO SCHEDULER CAN RETURN, so "there was no scheduler" is never
// mistaken for something the scheduler said.
export const NO_HUB = Symbol("no-hub");
export const hubSession = ({ getter, onFault, overrides, log, raise, isAlive, retries, ops }) => {
  const now = () => (typeof getter === "function" ? getter() : { hub: getter ?? null, why: null });
  let faultSaid = false;
  // SAID ONCE, wherever the reading came from. A caller that reads the hub
  // itself -- because it needs to tell an ABSENT hub from an unreadable one --
  // must still be able to report the fault under the same once-only rule, or
  // that rule holds at every site but one.
  const sayFault = (why) => { if (why && !faultSaid) { faultSaid = true; onFault(why); } };
  const handle = (fallback) => {
    const a = now();
    sayFault(a.why);
    return a.why ? fallback(a.why) : a.hub;
  };
  /**
   * Perform ONE scheduler operation on a CURRENT handle.
   *
   * This is what makes the rules unskippable rather than merely gathered. A
   * session that hands a handle back leaves every caller free to keep it, and
   * "adding a new call site must not be able to skip a rule" is a convention
   * again -- the thing #50 exists to stop it being.
   *
   * The handle is acquired here, used once, and never returned, so a stale
   * handle is not something a new site can obtain by accident; it would have
   * to be smuggled out deliberately.
   *
   * `whenAbsent` is the caller's own answer to "there is no scheduler right
   * now", and those answers are NOT interchangeable: housekeeping skips, a
   * release DEFERS and carries its obligation to the next tick, a claim fails
   * open and says so. The session owns the handle; the policy stays beside the
   * operation it governs.
   *
   * `overrides` is read at CALL time, not at construction, because the daemon
   * has always resolved these as `(ctx.NAME ?? fallback)` and a test that
   * replaces a seam must still be honoured.
   */
  const perform = (name, fallbackFn, args, whenAbsent) => {
    const h = handle(() => null);
    if (!h) return whenAbsent === undefined ? undefined : whenAbsent();
    return (overrides?.[name] ?? fallbackFn)(h, args);
  };
  // ── THE TWO OBLIGATIONS THAT OUTLIVE A TICK ────────────────────────────────
  //
  // A release and a cooldown are the only scheduler operations whose failure
  // must be REMEMBERED. Everything else is fire-and-forget: a reap that could
  // not run is simply not run, and the next tick reaps. These two are not.
  //
  //   A LEASE NOT GIVEN BACK stays bound to the guardian's always-alive pid, so
  //   the liveness-aware reaper preserves it and the slot is held against the
  //   global limit until it expires. Dropping the obligation costs real capacity.
  //
  //   A COOLDOWN NOT RECORDED means the next tick admits work straight back into
  //   an exhausted provider window -- and the builder, admitting against the same
  //   `provider_state`, does too.
  //
  // They lived in the caller, next to each other, each with its own copy of
  // "defer on a refusal, defer on a throw, delete on success". That is the rule
  // this whole module exists to stop being a convention: the release had the
  // retry and the cooldown did not, and nothing failed when one was missing.
  //
  // The maps are the CALLER'S, passed in, because they must survive the tick
  // that created them -- the session is built fresh per tick and the obligation
  // is not.

  /** Defer, and say why. The one shape both obligations share. */
  const defer = (map, key, value, why) => { map.set(key, value); log(why); };

  /**
   * Give a lease back, or carry the obligation to the next tick.
   *
   * THREE ROUTES OUT, and all three must retain. A hub that is momentarily
   * UNREADABLE, an operation that REFUSES because a restore holds the hub, and
   * one that THROWS are different events with the same consequence, and an
   * earlier version handled two of the three -- the third dropped the identity
   * and lost the slot for good.
   *
   * A hub that is genuinely ABSENT is the exception, and the only one: there is
   * no scheduler, so there is no lease and nothing to give back.
   */
  const release = (key, identity) => {
    const a = now();
    if (!a.hub) {
      // ABSENT drops it; UNREADABLE keeps it. `read` is what tells them apart,
      // and a handle cannot: both are "no handle".
      if (a.why) {
        sayFault(a.why);
        defer(retries.releases, key, identity,
              `provider: release deferred — the hub could not be reached; retrying next tick (${key})`);
      }
      return;
    }
    let r;
    try {
      r = perform("providerRelease", ops.providerRelease, { ...identity, isAlive },
                  () => { defer(retries.releases, key, identity,
                                `provider: release deferred — the hub could not be reached; retrying next tick (${key})`);
                          return NO_HUB; });
      if (r === NO_HUB) return;
    } catch (err) {
      defer(retries.releases, key, identity,
            `provider: release THREW — ${err.message}; retrying next tick (${key})`);
      raise("the provider scheduler is unreadable; dispatching unscheduled");
      return;
    }
    if (r?.ok === false && r.reason === "maintenance")
      defer(retries.releases, key, identity,
            `provider: release deferred — a restore holds the hub; retrying next tick (${key})`);
    else retries.releases.delete(key);
  };

  /**
   * Record a rate limit, or carry it.
   *
   * THE WINDOW STARTED WHEN THE 429 WAS SEEN, not when we managed to write it.
   * A deferred note carrying only a DURATION restarts the whole cooldown at
   * retry time, so an outage longer than the cooldown recovers and then imposes
   * a fresh block on every admission for a window that had already passed. The
   * absolute expiry is stamped once, at observation, and carried.
   *
   * AND THE OBSERVATION TIME TRAVELS WITH IT. `recordRateLimit` keeps whichever
   * metadata is latest by timestamp, so a note re-derived from the RETRY time
   * looks newer than a 429 seen after it, and the older signature overwrites the
   * newer one. Both facts are stamped together and neither is re-derived.
   */
  const noteCooldown = (key, note) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const stamped = note.expiresAt != null ? note
      : { ...note, observedAt: nowSec, expiresAt: nowSec + (note.cooldownSeconds ?? 0) };
    const left = stamped.expiresAt - nowSec;
    // Already elapsed while we could not write it. Recording a zero or negative
    // cooldown would be recording a fact that has stopped being true.
    if (left <= 0) { retries.cooldowns.delete(key); return; }
    const send = { signature: stamped.signature, cooldownSeconds: left,
                   observedAt: stamped.observedAt ?? null, expiresAt: stamped.expiresAt };
    let r;
    try {
      r = perform("noteRateLimit", ops.noteRateLimit, { ...send, isAlive },
                  () => { retries.cooldowns.set(key, stamped); return NO_HUB; });
      if (r === NO_HUB) return;
    } catch (err) {
      defer(retries.cooldowns, key, stamped,
            `provider: could not record the rate limit — ${err.message}; retrying next tick`);
      raise("the provider scheduler is unreadable; dispatching unscheduled");
      return;
    }
    if (r?.ok === false && r.reason === "maintenance")
      defer(retries.cooldowns, key, stamped,
            `provider: cooldown deferred — a restore holds the hub; retrying next tick (${key})`);
    else retries.cooldowns.delete(key);
  };

  /**
   * Replay what earlier ticks could not finish.
   *
   * COOLDOWNS FIRST, and the order is the point: a cooldown records that the
   * provider's window is exhausted, and a release hands a slot back. Replaying
   * the releases first would return capacity that the cooldown is about to
   * declare unusable, and a tick in between could spend it.
   */
  const drainRetries = () => {
    for (const [key, note] of [...retries.cooldowns]) noteCooldown(key, note);
    for (const [key, identity] of [...retries.releases]) release(key, identity);
  };

  // FROZEN, because the guarantee is about what a CALLER cannot do.
  //
  // Everything above is enforced by construction: a call site cannot hold a
  // stale handle because it is never handed one. That reasoning survives only
  // while the surface is the surface -- `session.perform = (...) => raw` would
  // reinstate the whole defect class in one line, from anywhere holding a
  // reference, and nothing else here would notice.
  //
  // Freezing does not stop a determined caller reaching the closure; nothing in
  // JavaScript does. It stops the ACCIDENT: the debugging patch left in, the
  // well-meant wrapper, the test double installed on a shared object. Those are
  // what actually happen.
  return Object.freeze({
    // The raw reading, for the two callers that need to tell an ABSENT hub
    // from an unreadable one -- a fact the handle alone cannot carry.
    read: now,
    // For the callers that read directly: the once-only report, unbundled.
    sayFault,
    // IS THERE A SCHEDULER? For the sites that ask only that. It takes the
    // same reading at the same moment an operation would, and answers yes or
    // no WITHOUT handing the handle back -- so asking the question cannot
    // leave a handle in scope for a later line to use.
    available: () => Boolean(handle(() => null)),
    perform,
    release,
    noteCooldown,
    drainRetries,
  });
};
