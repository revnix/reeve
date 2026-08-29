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
export const hubSession = ({ getter, onFault, overrides }) => {
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
  });
};
