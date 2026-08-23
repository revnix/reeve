// selfaudit — reeve checking whether reeve is still working.
//
// Everything else in this system watches pull requests. Nothing watched the
// watcher, and the ways it stops being useful are all SILENT: a snapshot loop
// that quietly stops, a store that corrupts, a lease that outlives its worker and
// wedges a PR forever, a notification channel that has been refusing pushes for a
// week. Each of those leaves a daemon that is ticking, logging, and useless.
//
// Two rules shape what is here.
//
// The checks are LOCAL and cheap -- a stat, a pragma, one indexed query -- so
// this runs on every tick. An audit on its own slower cadence would be absent
// from most ticks, and absence within a tick is what the escalation layer reads
// as "resolved". That defect has been fixed twice in this codebase already;
// running every tick means it cannot arise here at all.
//
// The `why` string is an IDENTITY, not a report. "no backup for 3h" changes every
// tick and would announce itself as a new problem each time, which is how a
// channel earns being muted. Durations, paths and counts belong in the log; the
// key says only WHICH thing is wrong.
//
// What is deliberately NOT here: `doctor`. Its checks are about a repository's
// merge authority, they cost many API calls, and on nextly the answer is stably
// BROKEN until the ruleset is repaired. Escalating that hourly would report a
// known, accepted condition forever. doctor stays a command a human runs.

import { latestSnapshot, everyStore, snapshotCandidates } from "./backup.mjs";
import { statSync, existsSync } from "node:fs";
import { hubPathFor } from "./paths.mjs";
import { DatabaseSync } from "node:sqlite";

export const OK = "OK";
export const DEGRADED = "DEGRADED";
export const BROKEN = "BROKEN";

const HOUR = 3600;

/** Is the newest snapshot recent enough, and is it actually a database? */
function checkBackups(nwo, { backupRoot, interval, at, io, home }) {
  if (!backupRoot) return null;   // backups disabled for this run; not a fault

  // Every store, not just the one this tick is about. Measured: reeve's own
  // store -- the whole dispatch ledger -- had zero backups while the repository
  // the daemon watches had fourteen, and the audit could not see it because it
  // only ever looked at the repository it was running for. An unwatched store is
  // unaudited AND unbacked, which is the pair that loses data.
  if (home) {
    const stores = (io.everyStore ?? everyStore)(home);
    const unbacked = stores.filter(st => !(io.latestSnapshot ?? latestSnapshot)(backupRoot, st.nwo));
    // Split for the same reason as below: "never backed up" and "every snapshot
    // is corrupt" both surface as a null from `latestSnapshot`, and only one of
    // them is a scheduling problem.
    const corrupt = unbacked.filter(st => (io.snapshotCandidates ?? snapshotCandidates)(backupRoot, st.nwo).length);
    const missing = unbacked.filter(st => !corrupt.includes(st));
    if (corrupt.length) {
      return { id: "backup.unreadable", level: BROKEN,
               why: "a state store on this machine has backups and none of them can be restored",
               detail: corrupt.map(m => m.nwo).join(", ") };
    }
    if (missing.length) {
      return { id: "backup.missing", level: BROKEN,
               why: "a state store on this machine has never been backed up",
               detail: missing.map(m => m.nwo).join(", ") };
    }
  }

  const newest = (io.latestSnapshot ?? latestSnapshot)(backupRoot, nwo);
  if (!newest) {
    // A null here has TWO causes and they are different operator problems.
    // `latestSnapshot` now skips candidates that fail validation, so a store
    // whose every snapshot is corrupt answers null exactly like one that was
    // never backed up. Reporting the second as "has never been backed up" is
    // FALSE, and it sends an operator to check a schedule that is working
    // perfectly -- the backups are running and producing rubbish, which is both
    // the more urgent fault and the one this line named before validation moved
    // into the read path.
    const present = (io.snapshotCandidates ?? snapshotCandidates)(backupRoot, nwo);
    if (present.length)
      return { id: "backup.unreadable", level: BROKEN,
               why: `none of reeve's backups of ${nwo} can be restored`,
               detail: `${present.length} snapshot(s) under ${backupRoot}, and every one fails validation` };
    return { id: "backup.missing", level: BROKEN,
             why: `reeve has never backed up ${nwo}`,
             detail: `nothing under ${backupRoot}` };
  }

  let mtime = null;
  try { mtime = Math.floor(((io.statSync ?? statSync)(newest).mtimeMs) / 1000); } catch { /* handled below */ }
  if (mtime === null) {
    return { id: "backup.unreadable", level: BROKEN,
             why: `reeve's newest backup of ${nwo} cannot be read`, detail: newest };
  }

  // Twice the interval: one missed snapshot is a slow tick, two is a stopped loop.
  const age = at - mtime;
  if (age > interval * 2) {
    return { id: "backup.stale", level: BROKEN,
             why: `reeve's scheduled backup of ${nwo} has stopped`,
             detail: `newest is ${newest}, ${Math.round(age / HOUR * 10) / 10}h old, interval is ${Math.round(interval / 60)}m` };
  }

  // A file of the right age that is not a usable store is worse than none, because
  // it is the one a restore would reach for. Opening it is the only way to know.
  try {
    const probe = new (io.Database ?? DatabaseSync)(newest, { readOnly: true });
    const n = probe.prepare("SELECT COUNT(*) n FROM event").get().n;
    probe.close();
    if (!n) {
      return { id: "backup.empty", level: BROKEN,
               why: `reeve's newest backup of ${nwo} holds no events`, detail: newest };
    }
  } catch (e) {
    return { id: "backup.unreadable", level: BROKEN,
             why: `reeve's newest backup of ${nwo} cannot be opened`,
             detail: `${newest}: ${e.message}` };
  }
  return null;
}

/** The store reeve reasons from. A corrupt one is silent until something reads it. */
function checkStore(db, { io }) {
  try {
    const r = (io.quickCheck ?? (d => d.prepare("PRAGMA quick_check").get()))(db);
    const verdict = r?.quick_check ?? r?.integrity_check ?? null;
    if (verdict !== "ok") {
      return { id: "store.integrity", level: BROKEN,
               why: "reeve's own store failed its integrity check",
               detail: String(verdict) };
    }
  } catch (e) {
    return { id: "store.unreadable", level: BROKEN,
             why: "reeve's own store could not be checked", detail: e.message };
  }
  return null;
}

/**
 * A lease that outlives its worker holds a task nothing is working.
 *
 * The count IS part of the signal here, so it is carried separately rather than
 * in the key: the escalation layer re-announces when a shared cause's count
 * changes, which is exactly right when one wedged run becomes three.
 */
function checkLeases(db, { at }) {
  try {
    const rows = db.prepare(
      `SELECT id, task_id, lane FROM run
        WHERE lease_expires_at < ?
          AND status IN ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder')`
    ).all(at);
    if (!rows.length) return null;
    return { id: "lease.expired", level: DEGRADED, count: rows.length,
             why: "a run is past its lease and nothing is working it",
             detail: rows.slice(0, 5).map(r => `${r.id} (${r.lane})`).join(", ") };
  } catch (e) {
    return { id: "lease.unreadable", level: DEGRADED,
             why: "reeve could not read its own leases", detail: e.message };
  }
}

/**
 * Can reeve still reach the person it escalates to?
 *
 * Read from the event log rather than from memory, so a restart does not forget
 * that the channel has been refusing for a week. Note the shape of this one: when
 * it fires, the finding itself cannot be pushed either. It reaches `reeve status`
 * and the log, which is why both exist.
 */
function checkNotify(db, { profile }) {
  const configured = profile?.notify?.provider === "ntfy";
  try {
    const last = db.prepare(
      "SELECT op, payload FROM event WHERE op IN ('notify.sent','notify.failed') ORDER BY seq DESC LIMIT 1"
    ).get();
    if (last?.op === "notify.failed") {
      let why = "";
      try { why = JSON.parse(last.payload)?.why ?? ""; } catch { /* the reason is a nicety */ }
      return { id: "notify.unreachable", level: BROKEN,
               why: "reeve cannot reach the notification channel",
               detail: why || "the last push was refused" };
    }
  } catch { /* no event table reading is not itself a notify fault */ }

  if (!configured) {
    return { id: "notify.unconfigured", level: DEGRADED,
             why: "reeve has no notification channel, so escalations reach a log only",
             detail: "set notify.provider, notify.url and notify.topic in the profile" };
  }
  return null;
}

/**
 * Everything reeve can check about itself, cheaply, right now.
 *
 * @returns {{id, level, why, detail?, count?}[]} worst first; empty when healthy.
 */
export function selfAudit(db, opts = {}) {
  const { nwo, profile = {}, backupRoot = null, at = Math.floor(Date.now() / 1000), io = {} } = opts;
  const interval = profile.watch?.backupIntervalSeconds ?? HOUR;
  const findings = [
    checkStore(db, { io }),
    checkBackups(nwo, { backupRoot, interval, at, io, home: opts.home ?? null }),
    checkLeases(db, { at }),
    checkNotify(db, { profile }),
  ].filter(Boolean);

  const home = opts.home ?? null;
  const hub = home ? hubPathFor(home) : null;
  if (hub && existsSync(hub)) {
    // CHEAP on the tick path. `selfAudit` runs on every guardian tick, once per
    // repository daemon, against a SHARED hub -- so a full-page integrity_check
    // here re-scans a growing database every 90 seconds per daemon, which is the
    // cost this plan measured OUT of `latestSnapshot` two rounds ago
    // (~1.1 ms/MB; docs/measured/2026-08-23-integrity-check-cost.md). Moving it
    // off one caller and onto a busier one is not a fix.
    //
    // `quick_check` walks the b-trees without the full page sweep, and the `(1)`
    // argument stops at the first fault -- the audit reports "the hub is broken",
    // not a catalogue. The deep scan stays where it earns its cost: `snapshotAll`
    // on what it just wrote, `restoreHub` before it replaces anything, and
    // `builder doctor` when an operator asks.
    let integrity = null;
    try {
      const d = new DatabaseSync(hub, { readOnly: true });
      try { integrity = Object.values(d.prepare("PRAGMA quick_check(1)").get())[0]; }
      finally { d.close(); }
    } catch (e) { integrity = `unreadable: ${e.message}`; }
    // A hub that cannot be OPENED is also a fault, and lands here rather than
    // throwing out of selfAudit and taking the whole per-repo audit with it.
    if (integrity !== "ok")
      findings.push({ id: "hub.integrity", level: BROKEN,
                      why: "reeve's hub database fails its integrity check",
                      detail: `${hub}: ${integrity}` });
  }

  const rank = { [BROKEN]: 0, [DEGRADED]: 1, [OK]: 2 };
  return findings.sort((a, b) => rank[a.level] - rank[b.level]);
}
