// hubaccess -- the guardian's connection to the hub, and when to reopen it.
//
// Extracted from `bin/reeve` so it can be TESTED. It lived there first, and a
// stub loop showed exactly what that cost: with the logic inside a CLI script
// the only assertions available were structural, so disabling the schema gate
// with `if (false && ...)` left every one of them green. The property was
// asserted and untested at the same time.
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openHubAsGuest, ALLOWED } from "./hubguest.mjs";
import { SCHEDULER_MIN_HUB_VERSION, HUB_SCHEMA_VERSION, HUB_BUSY_TIMEOUT_MS } from "./hubdb.mjs";
import { SCHEDULER_COLUMNS } from "./providerdb.mjs";
import { HOLD_COLUMNS } from "./holds.mjs";
import { LOCK_COLUMNS } from "./locks.mjs";

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
      // THE SAME CONTENTION BUDGET AS EVERY OTHER HUB CONNECTION. On SQLite's
      // default of zero this probe fails the instant a builder or a restore
      // holds the lock for a moment -- and its failure is read as "the scheduler
      // is unreadable", which dispatches a worker UNSCHEDULED. A ten-second wait
      // is what `openHub` and `openHubAsGuest` both take; a probe that decides
      // whether the quota applies must not be the one connection that refuses to
      // wait.
      q = new DatabaseSync(p, { readOnly: true, timeout: HUB_BUSY_TIMEOUT_MS });
      return { ok: true, value: read(q) };
    } catch (err) { return { ok: false, why: err.message }; }
    finally { try { q?.close(); } catch {} }
  };
  return () => {
    const p = hubPath;
    const drop = () => { if (handle) { try { handle.close(); } catch {} handle = null; ident = null; } };
    // ABSENT, OR UNREACHABLE? `existsSync` answers false for both -- it swallows
    // EACCES, ELOOP and every other stat failure alongside ENOENT. So a hub whose
    // directory lost its permissions read as an ordinary machine with no builder:
    // the guardian omitted the hold clause AND dispatched unscheduled, turning a
    // permissions outage into a merge-policy fail-open and a quota fail-open at
    // once, silently. Only ENOENT is genuinely absent.
    try {
      statSync(p);
    } catch (err) {
      if (err?.code === "ENOENT") { drop(); return { hub: null, why: null }; }
      drop();
      return { hub: null, why: `the hub at ${p} could not be reached: ${err?.code ?? ""} ${err?.message ?? err}`.trim() };
    }
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
      // THE GUARDIAN'S OWN SURFACE, and neither of the two inventories I reached
      // for first is that.
      //
      // The column inventory described only what later migrations ADD, so a hub
      // missing a column created in migration 1 -- `provider_state.cooldown_until`
      // -- passed, and `claimProvider` threw into the fail-open path. (Snapshot
      // validation no longer has that horizon: it derives the whole shape by
      // running the migrations, so a baseline column is required like any other.
      // The guardian's own surface below is still narrower on purpose.) The table
      // inventory was the whole hub, so losing an unrelated builder projection like
      // `approval` reported the SCHEDULER unusable, and the resulting null hub
      // dispatched an ordinary pull request unscheduled. Too narrow and too wide
      // are the same mistake: reading an inventory as an answer to a question it
      // was not built for.
      //
      // The surface is `ALLOWED` -- the guest connection's own allowlist, which
      // is where "what the guardian may touch" is already defined -- and the
      // columns are the ones the scheduler's SQL names. One home each.
      const present = new Set(q.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name));
      const needCols = { ...SCHEDULER_COLUMNS, pr_hold: HOLD_COLUMNS, maintenance_lock: LOCK_COLUMNS };
      // NAME AND DECLARED TYPE. Reducing `pragma_table_info` to names made this
      // gate a fail-open: every one of these tables is STRICT, so a column whose
      // declared type is wrong passes the check and then REFUSES THE WRITE. A hub
      // carrying `provider_lease.token INTEGER` was reported usable, `claimProvider`
      // threw "cannot store TEXT value in INTEGER column", and the daemon took its
      // documented fail-open route and dispatched model work outside the shared
      // limit -- the exact outcome this gate exists to prevent, reached by passing
      // it rather than by failing it.
      //
      // The defect names the column AND both types, because this is read at a
      // recovery: "provider_lease.token is INTEGER, want TEXT" is actionable and
      // "the scheduler is unusable" is not.
      for (const t of Object.keys(ALLOWED)) {
        if (!present.has(t)) { defects.push(`${t} is missing`); continue; }
        const have = new Map(q.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(t)
          .map(r => [r.name, String(r.type ?? "").toUpperCase()]));
        for (const [c, want] of Object.entries(needCols[t] ?? {})) {
          if (!have.has(c)) { defects.push(`${t}.${c} is missing`); continue; }
          const got = have.get(c);
          if (got !== want) defects.push(`${t}.${c} is ${got || "untyped"}, want ${want}`);
        }
      }
      // The hub-wide schema requirement is deliberately NOT consulted here:
      // `task_territory.pinned_until` is the builder's, not the guardian's, and
      // `provider_lease.token` is already named by `LEASE_COLS` above. Snapshot
      // validation does use it -- that question IS about the whole hub.
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
    // This is the same lesson snapshot validation's column check was written for
    // -- a name-only inventory cannot see a column that is present and wrong, and a
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
