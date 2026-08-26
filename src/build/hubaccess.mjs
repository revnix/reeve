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
import { SCHEDULER_MIN_HUB_VERSION, HUB_SCHEMA_VERSION, COLUMNS_AT, TABLES_AT, columnDefectsAt } from "./hubdb.mjs";

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
  // Opens a read-only probe and hands it to `read`, closing it afterwards
  // whatever happens. One connection answers both the version and the column
  // questions: they are two readings of the same store at the same moment, and
  // taking them through separate handles is two moments again.
  const probeRead = (p, read) => {
    let q = null;
    try {
      q = new DatabaseSync(p, { readOnly: true });
      return { ok: true, value: read(q) };
    } catch (err) { return { ok: false, why: err.message }; }
    finally { try { q?.close(); } catch {} }
  };
  return () => {
    const p = hubPath;
    const drop = () => { if (handle) { try { handle.close(); } catch {} handle = null; ident = null; } };
    if (!existsSync(p)) { drop(); return { hub: null, why: null }; }
    // ONE PROBE, BOTH READINGS. The version and the column shape are two facts
    // about the same store at the same moment; taking them through separate
    // handles would be two moments, and a restore between them would have the
    // gate answering about a file that no longer exists.
    // ONE PROBE, BOTH READINGS, BOTH TAKEN INSIDE IT. The version and the column
    // shape are two facts about the same store at the same moment, so they share
    // a handle -- and the values are computed here rather than returned as a
    // closure, because `probeRead` closes the connection on the way out and a
    // closure over it would run against a closed handle. (It did; the control
    // that a healthy hub still opens is what caught it.)
    const v = probeRead(p, q => {
      const version = q.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get().v;
      const defects = [];
      // THE TABLES FIRST, AND THIS WAS THE HALF THAT WAS MISSING. `COLUMNS_AT`
      // describes only what migrations ADD to tables that already exist -- its
      // sole entry is migration 3's two columns -- so a current-version hub that
      // has lost a version-1 table like `provider_state` produced no defects at
      // all. The guest opened, and `claimProvider` threw on its first
      // `SELECT ... FROM provider_state` straight into the fail-open path.
      //
      // `TABLES_AT` is the inventory that answers this, and it already exists.
      // Consulting one inventory and not the other is how a shape check ends up
      // covering exactly the last migration and nothing before it.
      const present = new Set(q.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name));
      for (const t of TABLES_AT[version] ?? [])
        if (!present.has(t)) defects.push(`${t} is missing`);
      for (const n of Object.keys(COLUMNS_AT).map(Number).filter(x => x <= version).sort((a, b) => a - b)) {
        try { defects.push(...columnDefectsAt(q, n)); }
        catch (err) { defects.push(`version ${n}: ${err.message}`); }
      }
      return { version, defects };
    });
    // Could not read is not "not migrated".
    if (!v.ok) { drop(); return { hub: null, why: `the hub at ${p} could not be read: ${v.why}` }; }
    const version = v.value.version;
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
    if (version < 1) { drop(); return { hub: null, why: null }; }
    // AND AN UPPER BOUND. `openHub` refuses a forward schema in three places --
    // migrations are forward-only, and a store a newer binary has migrated is
    // one this binary cannot reason about. The guest had only a floor, so a
    // newer builder migrating the shared hub left this guardian issuing
    // scheduler mutations against a layout it does not know. The moment a future
    // migration changes those statements they throw, and a throwing scheduler
    // takes the documented fail-open path: model work dispatched outside the
    // shared limit, which is the one outcome the whole connection exists to
    // prevent. Refusing is the same answer the privileged opener already gives.
    if (version > HUB_SCHEMA_VERSION) {
      drop();
      return { hub: null, why: `the hub at ${p} is at schema version ${version}; this binary knows ` +
                              `${HUB_SCHEMA_VERSION}. Migrations are forward-only: run the newer binary.` };
    }
    if (version < SCHEDULER_MIN_HUB_VERSION) {
      drop();
      return { hub: null, why: `the hub at ${p} is at schema version ${version}; the provider scheduler needs ` +
                              `${SCHEDULER_MIN_HUB_VERSION}. Run the builder once to migrate it.` };
    }
    // A VERSION IS A CLAIM; THE COLUMNS ARE THE EVIDENCE.
    //
    // A store can record version 3 and have lost `provider_lease.token` -- a
    // damaged table, a hand-edited database, a restore from something that was
    // never quite a hub. The version gate above accepts it, `openHubAsGuest`
    // succeeds, and the first `claimProvider` throws; both dispatch paths answer
    // a throwing scheduler by running model work UNSCHEDULED, which is the one
    // outcome this connection exists to prevent.
    //
    // This is the same lesson `columnDefectsAt` was written for one PR ago -- a
    // name-only inventory cannot see a column that is present and wrong, and a
    // version-only probe cannot see one that is absent. It is reused rather than
    // restated: every declared requirement at or below the store's version, so a
    // future migration's columns are covered the day they are declared.
    const defects = v.value.defects;
    if (defects.length) {
      drop();
      return { hub: null, why: `the hub at ${p} records version ${version} but its scheduler tables do not match it: ` +
                              `${defects.slice(0, 4).join("; ")}` };
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
