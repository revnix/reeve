// hubaccess -- the guardian's connection to the hub, and when to reopen it.
//
// Extracted from `bin/reeve` so it can be TESTED. It lived there first, and a
// stub loop showed exactly what that cost: with the logic inside a CLI script
// the only assertions available were structural, so disabling the schema gate
// with `if (false && ...)` left every one of them green. The property was
// asserted and untested at the same time.
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openHubAsGuest } from "./hubguest.mjs";
import { SCHEDULER_MIN_HUB_VERSION } from "./hubdb.mjs";

/**
 * A getter over the hub at `hubPath`, answering three ways. See the notes below.
 */
// The guardian's hub access: a GETTER, and the reasons it is not a handle.
//
// RESTRICTED BY CONSTRUCTION. `openHubAsGuest` returns a facade whose authorizer
// refuses every table outside the guardian's declared surface, and which does not
// carry the methods that could switch that authorizer off. The privileged
// `openHub` appears on the guardian path only in `repoIdOnce` below, for one
// statement, closed immediately.
//
// A GETTER BECAUSE THE FILE MOVES UNDER US. `restoreHub` replaces the hub by
// renaming a new file over the old one, and a SQLite handle opened beforehand
// stays attached to the unlinked inode. A daemon that cached one connection for
// its lifetime would go on claiming and releasing leases in a database nobody
// else can see -- so the guardian and the builder would each admit up to the
// global limit, and the guardian would read holds that stopped being true at the
// restore. The identity is re-checked on every call and the connection reopened
// when it changes.
//
// THREE ANSWERS, NOT TWO, and the earlier version had two. A hub that is absent
// or unmigrated is `{ hub: null, why: null }` -- an ordinary state, since a
// guardian can run on a machine with no builder, and the tick dispatches
// unscheduled. A hub that EXISTS and cannot be opened is
// `{ hub: null, why: "..." }`, which the tick escalates. Collapsing them made a
// corrupt hub look like an absent one: no scheduling, no holds, and nothing said.
export function hubAccess(hubPath) {
  let handle = null, ident = null;
  const identOf = (p) => { try { const st = statSync(p); return `${st.dev}:${st.ino}`; } catch { return null; } };
  // A POSITIVELY READ VERSION, not `completedVersion`. That helper catches every
  // open and query failure and answers 0, so a corrupt, locked or unreadable hub
  // was indistinguishable from an unmigrated one -- and this function then took
  // the benign path and returned `{hub:null, why:null}` BEFORE reaching the
  // three-way logic below it. The daemon dispatched unscheduled, omitted holds,
  // and said nothing. Using an error-collapsing predicate as the readiness gate
  // undid the very distinction this function was rewritten to make.
  const versionOf = (p) => {
    try {
      const q = new DatabaseSync(p, { readOnly: true });
      try { return { ok: true, version: q.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get().v }; }
      finally { q.close(); }
    } catch (err) { return { ok: false, why: err.message }; }
  };
  return () => {
    const p = hubPath;
    const drop = () => { if (handle) { try { handle.close(); } catch {} handle = null; ident = null; } };
    if (!existsSync(p)) { drop(); return { hub: null, why: null }; }
    const v = versionOf(p);
    // Could not read is not "not migrated".
    if (!v.ok) { drop(); return { hub: null, why: `the hub at ${p} could not be read: ${v.why}` }; }
    // "The hub opened" and "the scheduler can be used" are DIFFERENT questions.
    //
    // Below version 1 there is no hub at all: an ordinary state, and the tick
    // dispatches unscheduled because there is nothing to schedule against.
    //
    // Between 1 and the scheduler's floor there IS a hub, and opening it for
    // dispatch is the dangerous answer: `provider_lease.token` arrives with
    // migration 3 and every claim names it, so each claim throws and the
    // guardian's fail-open path runs model work outside the shared limit --
    // beside an older builder that is still using its own. That is an
    // incompatibility and it says so, rather than passing as an absent hub.
    if (v.version < 1) { drop(); return { hub: null, why: null }; }
    if (v.version < SCHEDULER_MIN_HUB_VERSION) {
      drop();
      return { hub: null, why: `the hub at ${p} is at schema version ${v.version}; the provider scheduler needs ` +
                              `${SCHEDULER_MIN_HUB_VERSION}. Run the builder once to migrate it.` };
    }
    const now = identOf(p);
    if (handle && now && now === ident) return { hub: handle, why: null };
    if (handle) { try { handle.close(); } catch {} handle = null; ident = null; }
    try {
      handle = openHubAsGuest(p);
      ident = now;
      return { hub: handle, why: null };
    } catch (err) {
      handle = null; ident = null;
      return { hub: null, why: `the hub at ${p} could not be opened as a guest: ${err.message}` };
    }
  };
}
