// @ts-check
// The shadow trial, reported against its conditions (#291). The trial passes on
// what it covers, not on days (#158): at least 72 hours in which the daemon
// ran; every pull request merged in that time judged at its final head, and
// none merged while the daemon was down; at least 10 of them passed on their
// final head; each kind of case seen; the seeded known-bad cases; and no false
// call on audit. This reads the store and what GitHub says merged, and changes
// nothing. What only a person can judge, a false call, is listed for them,
// every call the daemon made and not only those a merge met, never passed on
// silence. Their audit is kept apart from the store, each one with who made it
// and when (#294), and read back by every report.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { netTimeoutMs, netFailure } from "./net-bound.mjs";
import { syncFolder } from "./signing.mjs";
import { TICK_STARTED, TICK_STOPPED } from "./status.mjs";
import { sameCode } from "./decisions.mjs";
import { decisionOf } from "./db/records.mjs";

/** A gap between ticks longer than this is downtime, as #158 says. */
export const GAP_SECONDS = 15 * 60;
/** A tick longer than this is downtime too: a daemon stopped partway, not one running (#297). */
export const TICK_LIMIT_SECONDS = 60 * 60;
export const FLOOR_HOURS = 72;
export const PASSES_NEEDED = 10;

/** The kinds of case the trial must see at least once, as #158 names them. */
export const CASE_KINDS = Object.freeze([
  "a pull request that passes",
  "failing CI",
  "a conflict with the base",
  "unresolved threads",
  "a new push after a review",
  "a merge through the merge queue",
]);

/**
 * @typedef {{ pr: number, mergedAt: number, head: string, mergeCommit: string | null }} Merged
 * @typedef {"right" | "false pass" | "false block"} Mark
 * @typedef {{ mark: Mark, by: string, at: number, note: string, to: number }} Audited
 * @typedef {{ id: string, where: "head" | "queue", pr: number, head: string, state: string, summary: string, why: string, reasons: { why: string, ticks: number }[],
 *             first: number, last: number, seq: number, ticks: number, record: string | null, final: boolean, audited: Audited | null, again?: boolean, gone?: boolean }} Call
 * @typedef {(seq: number) => { id: string, record: string | null } | null} Judgment
 * @typedef {{ repo: string, by: string, at: number, seq?: number,
 *             calls: { id: string, where: string, pr: number, head: string, state: string, summary: string, record: string | null, mark: Mark, note: string, to: number }[] }} Audit
 * @typedef {{ right: boolean, note: string, to?: number }} Marked
 * @typedef {{ name: string, met: boolean | null, detail: string }} Condition
 */

/**
 * A call's name, for a person's audit to mark it by (#294): what makes it one
 * call, its repository, place, pull request, commit, verdict and the clauses
 * it blocked, not the ticks that repeated it or its latest reason, which can
 * count checks still running. The repository as GitHub names it, case aside:
 * a fork shares its upstream's commits and numbers, and a sheet of one's calls
 * isn't the other's. It starts with a letter, so a spreadsheet keeps it as
 * text rather than reading a number into it.
 * @param {{ repo?: string, where: string, pr: number, head: string, state: string, summary: string }} c
 */
export function callId(c) {
  return "c" + createHash("sha256").update(JSON.stringify([String(c.repo ?? "").toLowerCase(), c.where, c.pr, c.head, c.state, c.summary])).digest("hex").slice(0, 16);
}

/**
 * The call a judgment, a `pr.decided` or `queue.decided` event's payload `p`,
 * is of in `repo`, as `callId` names it.
 * @param {string} repo @param {"head" | "queue"} where @param {number} pr @param {any} p
 */
const callOf = (repo, where, pr, p) => {
  const call = { where, pr, head: String(p.head ?? ""), state: String(p.state ?? ""), summary: String(p.summary ?? "") };
  return { id: callId({ repo, ...call }), ...call };
};

/** How a call reads where a person audits it. @param {{ where: string, pr: number, head: string, state: string }} c */
const callText = (c) => `#${c.pr} ${c.state} ${c.where === "queue" ? "on the queue's commit" : "at"} ${c.head.slice(0, 10)}`;
/**
 * A call's reason as a person reads it: its summary, and what it was judged
 * for, each reason with how many ticks gave it where there was more than one.
 * @param {Call} c
 */
function reasonOf(c) {
  const why = c.reasons.length > 1 ? c.reasons.map((r) => `${r.why || "no reason given"} (${r.ticks} tick${r.ticks === 1 ? "" : "s"})`).join("; ") : c.why;
  return c.summary ? `${c.summary}${why ? `: ${why}` : ""}` : why;
}
/** Up to ten of `list`, said, and how many more. @param {any[]} list @param {(c: any) => string} say */
const some = (list, say) => list.slice(0, 10).map(say).join(", ") + (list.length > 10 ? `, and ${list.length - 10} more` : "");

/** @param {any} db @param {string} op @param {number} since @param {number} now */
const events = (db, op, since, now) => /** @type {any[]} */ (db.prepare(
  `SELECT seq, at, subject, payload FROM event WHERE op = ? AND at >= ? AND at <= ? ORDER BY seq`).all(op, since, now))
  .map((r) => { let p = {}; try { p = JSON.parse(r.payload ?? "{}") ?? {}; } catch { /* a payload that can't be read says nothing */ }
                return { seq: Number(r.seq), at: Number(r.at), pr: Number(String(r.subject ?? "").replace(/^pr:/, "")), p }; });

/**
 * The trial of `repo` from `since` to `now`, both in seconds, against its
 * conditions. `merged` is what GitHub says merged in that time, or `{ why }`
 * where it couldn't be read, and then whether every merge was covered can't be
 * said. `seeded` is how the seeded known-bad cases came out (src/seeded.mjs),
 * or null where they weren't run. Not run, none seeded, or one not as it must
 * be, and that condition isn't met. `audits` is every audit of the calls a
 * person recorded (#294), or `{ why }` where they couldn't be read.
 * @param {any} db
 * @param {{ repo: string, since: number, now: number, merged: Merged[] | { why: string },
 *           seeded?: import("./seeded.mjs").Result[] | null, audits?: Audit[] | { why: string } }} o
 */
export function trialReport(db, { repo, since, now, merged, seeded = null, audits = [] }) {
  // Running time, from the ticks, recorded as each starts and as it ends
  // (#297). The time inside a tick, from its start to its end, or to now for one
  // still running, is running while the tick has taken no more than
  // TICK_LIMIT_SECONDS from its start, however long that was. A tick that
  // started and never ended, halted, stopped or unable to read GitHub, judged
  // nothing, so the time from its start to the next start is downtime, however
  // short. Every other gap, between one tick and the next, from the start to the
  // first and from the last to now, is running up to GAP_SECONDS, and past it,
  // downtime. So is the time from a tick that stopped without judging, halted,
  // unable to list the pull requests or thrown, to the next start (#301), a
  // report made before it included. A store written before starts were
  // recorded holds only ends, and every gap there is between ticks.
  const ended = events(db, "daemon.tick", since, now);
  const started = events(db, TICK_STARTED, since, now);
  const stopped = events(db, TICK_STOPPED, since, now);
  // A tick under way as the report starts, the last recorded before it began,
  // and when it started, which its limit counts from.
  const before = /** @type {any} */ (db.prepare(`SELECT op, at FROM event WHERE op IN ('daemon.tick', ?, ?) AND at < ? ORDER BY seq DESC LIMIT 1`).get(TICK_STARTED, TICK_STOPPED, since));
  const marks = [{ at: since, from: before?.op === TICK_STARTED ? Number(before.at) : since, start: before?.op === TICK_STARTED, end: false, stopped: before?.op === TICK_STOPPED },
                 ...[...started.map((e) => ({ seq: e.seq, at: e.at, from: e.at, start: true, end: false, stopped: false })),
                     ...ended.map((e) => ({ seq: e.seq, at: e.at, from: e.at, start: false, end: true, stopped: false })),
                     ...stopped.map((e) => ({ seq: e.seq, at: e.at, from: e.at, start: false, end: false, stopped: true }))].sort((a, b) => a.seq - b.seq),
                 { at: now, from: now, start: false, end: true, stopped: false }];
  /** @type {{ from: number, to: number }[]} */ const down = [];
  let running = 0;
  for (let i = 1; i < marks.length; i++) {
    const [a, b] = [marks[i - 1], marks[i]];
    const gap = b.at - a.at;
    const over = a.stopped ? gap > 0
      : a.start && b.end ? b.at - a.from > TICK_LIMIT_SECONDS
      : a.start ? gap > 0
      : gap > GAP_SECONDS;
    // One stretch of downtime, however many marks it spans.
    const last = down.at(-1);
    if (over && last?.to === a.at) last.to = b.at;
    else if (over) down.push({ from: a.at, to: b.at });
    else running += gap;
  }
  // No tick at all is no running, however short the time; one under way as
  // the report starts is a tick.
  if (!ended.length && !started.length && !marks[0].start) running = 0;
  // From the second a stretch begins (#306): a merge then wasn't judged. One in
  // the second it ends is the next tick's to judge.
  const wasDown = (/** @type {number} */ t) => down.some((d) => t >= d.from && t < d.to);

  const decided = events(db, "pr.decided", since, now);
  const queued = events(db, "queue.decided", since, now);

  // Each merged pull request, its final head, and how it was judged there: by
  // the verdict that stood when it merged, so not one kept after it.
  /** @type {(Merged & { judged: boolean, state: string | null, record: string | null, down: boolean, queue: boolean, missed: string | null })[]} */
  const merges = [];
  /** The events that stood when each pull request merged, at its head and in the queue. */
  const standing = new Set();
  if (Array.isArray(merged)) for (const m of merged) {
    const atHead = decided.filter((e) => e.pr === m.pr && e.p.head === m.head && e.at <= m.mergedAt);
    const last = atHead.at(-1);
    // Merged by the queue only where GitHub's merge commit is the queue's
    // commit reeve judged before the merge: a pull request the queue held,
    // then dropped, may have merged another way.
    const inQueue = m.mergeCommit ? queued.filter((e) => e.pr === m.pr && e.p.head === m.mergeCommit && e.at <= m.mergedAt).at(-1) : undefined;
    if (last) standing.add(last.seq);
    if (inQueue) standing.add(inQueue.seq);
    const isDown = wasDown(m.mergedAt);
    merges.push({ ...m, judged: Boolean(last), state: last?.p.state ?? null, record: last?.p.record ?? null, down: isDown,
                  queue: Boolean(inQueue),
                  missed: isDown ? "merged while the daemon was down" : !last ? "its final head was never judged" : null });
  }
  const passedFinal = merges.filter((m) => m.state === "PASS");

  // The kinds of case seen, each with the first pull request that showed it.
  const clause = (/** @type {any} */ p, /** @type {string} */ id) => (Array.isArray(p.clauses) ? p.clauses.find((c) => c?.id === id)?.state : undefined);
  const firstPr = (/** @type {(e: any) => boolean} */ f) => decided.find(f)?.pr ?? null;
  // A new push after a review: a head first seen in the period, after a review
  // round on another head of the same pull request.
  const pushedAfterReview = /** @type {any[]} */ (db.prepare(
    `SELECT DISTINCT h.pr FROM head_seen h JOIN review_round r ON r.pr = h.pr AND r.nwo = h.nwo AND r.head_full <> h.sha
      WHERE h.nwo = ? AND h.first_seen_at >= ? AND h.first_seen_at <= ? AND r.event_at < h.first_seen_at ORDER BY h.pr`).all(repo, since, now)).map((r) => Number(r.pr));
  /** @type {Record<string, number | null>} */
  const kinds = {
    "a pull request that passes": firstPr((e) => e.p.state === "PASS"),
    "failing CI": firstPr((e) => e.p.action === "FIX_CI" || /^failing:/.test(String(e.p.why ?? ""))),
    "a conflict with the base": firstPr((e) => /conflicts with its base/.test(String(e.p.why ?? ""))),
    "unresolved threads": firstPr((e) => clause(e.p, "threads") === "BLOCK"),
    "a new push after a review": pushedAfterReview[0] ?? null,
    "a merge through the merge queue": merges.find((m) => m.queue)?.pr ?? null,
  };

  // What a person must judge: every call the daemon made in the period, at a
  // pull request's head or on the queue's commit, merged or not, since every
  // decision is audited (docs/decisions/2026-09-24-direction.md). A pass that
  // should have stopped, or a block the inputs didn't justify, can't be told
  // from the records alone. A call is one verdict on one commit with the same
  // clauses blocked, however many ticks repeated it, with the latest reason: a
  // reason can count checks still running, which changes tick by tick. Those
  // standing when a pull request merged are marked: they're what a gate would
  // have let through.
  /** @type {Map<string, Call>} */
  const calls = new Map();
  // Each judgment of the period, by its event: the call it's of, and its record.
  /** @type {Map<number, { id: string, record: string | null }>} */
  const judged = new Map();
  for (const [where, list] of /** @type {const} */ ([["head", decided], ["queue", queued]])) for (const e of list) {
    const { id, ...call } = callOf(repo, where, e.pr, e.p);
    const c = calls.get(id) ?? { id, ...call, why: "", reasons: [], first: e.at, last: e.at, seq: e.seq, ticks: 0, record: null, final: false, audited: null, again: false, gone: false };
    c.why = String(e.p.why ?? "");
    // Every reason it was judged for, shown with the call (#314): a mark of it
    // covers each, and an earlier one, judged on other evidence, isn't hidden by
    // the latest.
    const reason = c.reasons.find((r) => r.why === c.why);
    if (reason) reason.ticks++;
    else c.reasons.push({ why: c.why, ticks: 1 });
    c.last = e.at;
    c.seq = e.seq;
    c.ticks++;
    c.record = e.p.record ?? c.record;
    if (standing.has(e.seq)) c.final = true;
    calls.set(id, c);
    judged.set(e.seq, { id, record: e.p.record ?? null });
  }
  const toAudit = [...calls.values()].sort((a, b) => a.pr - b.pr || a.first - b.first);
  // Each call's mark, as a person's latest audit of it gave it: an audit made
  // later counts over one before, so a mark corrected stands corrected: in the
  // order recorded, which a clock set back, or two in one second, doesn't
  // change; by time where that isn't known.
  // A mark holds only while the store holds the judgment it saw, with the
  // record it saw (#314): a store restored from a snapshot gives the event
  // numbers after it out again, and a mark of one judgment would otherwise be
  // taken for a mark of another made under its number. Wherever that judgment
  // is: an audit of a later period, recorded since, covers this one's too.
  /** @type {Judgment} */
  const judgedAt = (seq) => {
    const inPeriod = judged.get(seq);
    if (inPeriod) return inPeriod;
    const e = /** @type {any} */ (db.prepare(`SELECT op, subject, payload FROM event WHERE seq = ? AND op IN ('pr.decided', 'queue.decided')`).get(seq));
    if (!e) return null;
    let p = {};
    try { p = JSON.parse(e.payload ?? "{}") ?? {}; } catch { /* a payload that can't be read says nothing */ }
    return { id: callOf(repo, e.op === "queue.decided" ? "queue" : "head", Number(String(e.subject ?? "").replace(/^pr:/, "")), p).id, record: /** @type {any} */ (p).record ?? null };
  };
  if (Array.isArray(audits)) for (const a of [...audits].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0) || x.at - y.at))
    for (const m of a.calls) {
      const c = calls.get(m.id);
      if (!c) continue;
      const saw = judgedAt(m.to);
      c.audited = { mark: m.mark, by: a.by, at: a.at, note: m.note, to: m.to };
      c.gone = !(saw?.id === m.id && saw.record === (m.record ?? null));
    }
  // A call judged again since it was marked right was judged on what that
  // audit didn't see, so it's for a person to mark again: judged after the
  // event its mark saw it judged to, by the store's order of events, which no
  // clock set back, or two in one second, changes. So is one whose judgment
  // marked is gone. One marked wrong stays a false call, however often it was
  // judged again.
  for (const c of toAudit) c.again = Boolean(c.audited && c.seq > c.audited.to);
  const falseCalls = toAudit.filter((c) => c.audited && c.audited.mark !== "right");
  const notYet = toAudit.filter((c) => !c.audited || c.again || c.gone);
  const prs = new Set(toAudit.map((a) => a.pr)).size;
  /** @type {Omit<Condition, "name">} */
  const audit = !Array.isArray(audits) ? { met: false, detail: `the audits recorded can't be read, so they vouch for nothing: ${audits.why}` }
    : falseCalls.length ? { met: false, detail: `${falseCalls.length} false call(s): ${some(falseCalls, (c) => `${callText(c)} (${c.audited?.mark}, by ${c.audited?.by})`)}` }
    // None audited, or nothing to audit: no audit says there was no false call.
    : notYet.length === toAudit.length ? { met: null, detail: `${toAudit.length} call(s) on ${prs} pull request(s) to audit` }
    : notYet.length ? { met: null, detail: `${toAudit.length - notYet.length} of ${toAudit.length} call(s) audited, none false; not yet: ${some(notYet, (c) => `${callText(c)}${
        c.gone ? " (its audit saw a judgment this store doesn't hold)" : c.again ? " (judged again since its audit)" : ""}`)}` }
    : { met: true, detail: `all ${toAudit.length} call(s) audited right, by ${[...new Set(toAudit.map((c) => c.audited?.by))].join(", ")}` };

  const hours = running / 3600;
  const missed = merges.filter((m) => m.missed);
  const unseen = CASE_KINDS.filter((k) => kinds[k] == null);
  /** @type {Condition[]} */
  const conditions = [
    { name: `at least ${FLOOR_HOURS} hours of running`, met: hours >= FLOOR_HOURS, detail: `${hours.toFixed(1)} hours` },
    { name: "every merge judged at its final head, none while the daemon was down",
      met: Array.isArray(merged) ? missed.length === 0 : false,
      detail: !Array.isArray(merged) ? `what merged couldn't be read: ${merged.why}`
        : missed.length ? `${missed.length} of ${merges.length} missed: ${missed.map((m) => `#${m.pr} (${m.missed})`).join(", ")}` : `${merges.length} merged, none missed` },
    { name: `at least ${PASSES_NEEDED} merged pull requests passed on their final head`, met: passedFinal.length >= PASSES_NEEDED, detail: `${passedFinal.length}` },
    { name: "each kind of case seen", met: unseen.length === 0, detail: unseen.length ? `not yet: ${unseen.join("; ")}` : "all seen" },
    // Each for its own reason, and the good case among them passing.
    { name: "every seeded case got the verdict it must, for its reason",
      met: seeded?.length ? seeded.every((s) => s.ok) : false,
      detail: seeded == null ? "not run: pass --seeded to run them"
        : !seeded.length ? "none seeded yet"
        : `${seeded.filter((s) => s.ok).length} of ${seeded.length}${seeded.some((s) => !s.ok) ? `; not as they must: ${seeded.filter((s) => !s.ok).map((s) => `${s.name} (${s.detail})`).join("; ")}` : ""}` },
    // Only a person's audit says this: met once it marks every call right.
    { name: "no false call on audit", ...audit },
  ];
  // Ready for a person's audit once every condition the records can show holds;
  // passed only once that audit is recorded, every call in it right.
  /** @type {Judgment} */
  const judgment = (seq) => judged.get(seq) ?? null;
  // `judgment`, which call each event of the period judged, and on what record,
  // for an audit to be taken of: a function, so a report written out as JSON
  // leaves it out.
  return { since, now, running: { hours, ticks: ended.length, down }, merges, passedFinal: passedFinal.length, kinds, toAudit, seeded, conditions,
           ready: conditions.every((c) => c.met !== false), passed: conditions.every((c) => c.met === true), judgment };
}

/**
 * Whether a store is `nwo`'s, told by the repository its decision records name:
 * each names the one it was judged for. A store with records of another, named
 * by --db by mistake or copied, would count their ticks, verdicts and cases for
 * this one. One with no record is told only by where it is, so one named by
 * hand (`named`) can't be told at all.
 * @param {any} db @param {string} nwo @param {{ named: boolean }} o
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function storeIsOf(db, nwo, { named }) {
  const repos = /** @type {any[]} */ (db.prepare(
    `SELECT DISTINCT CASE WHEN json_valid(record) THEN json_extract(record, '$.subject.repo') END AS repo FROM decision`).all())
    .map((r) => (typeof r.repo === "string" ? r.repo : null));
  const other = repos.filter((r) => r !== nwo);
  if (other.length)
    return { ok: false, why: `this store holds decision records of ${other.map((r) => r ?? "a repository that can't be read").join(", ")}, not ${nwo}` };
  if (named && !repos.length)
    return { ok: false, why: `this store holds no decision record, so which repository it's of can't be told: without --db, reeve reads the one it keeps for ${nwo}` };
  return { ok: true };
}

/** A time as the report shows it. @param {number} t */
const when = (t) => new Date(t * 1000).toISOString().replace(/:\d\d\.\d+Z$/, "Z").replace("T", " ");

/**
 * Whether the shadow trial lets reeve enforce (#166): only once its report has
 * passed, every condition met and a person's audit of its calls finding none
 * false. Time alone doesn't pass it. With why not, naming each condition short,
 * for `reeve run --enforce` to refuse with.
 * @param {{ passed: boolean, conditions: { name: string, met: boolean | null, detail: string }[] }} report
 * @param {{ since: number }} o
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function trialGate(report, { since }) {
  if (report.passed) return { ok: true };
  const short = report.conditions.filter((c) => c.met !== true).map((c) => `${c.name}: ${c.detail}`);
  return { ok: false, why: `the shadow trial from ${when(since)} hasn't passed: ${short.join("; ")}` };
}

/**
 * Whether every judgment the shadow trial saw, and every tick it ran, from
 * `since` to `until`, was made by `code` under `policy`, the code and policy
 * about to enforce (#166): a trial vouches only for what it watched, so a deploy
 * or a policy changed since begins it again. A judgment is told by the record
 * it was judged from, whole and kept as its own; one without such a record, or
 * a tick that doesn't say, is no proof it's the same. `{ ok }`, or why not, with
 * when the last made otherwise was: the trial would begin again after it.
 * @param {any} db @param {{ since: number, until: number, code: any, policy: string | null }} o
 * @returns {{ ok: true } | { ok: false, why: string, after: number }}
 */
export function trialRanOn(db, { since, until, code, policy }) {
  const count = { judgment: { other: 0, untold: 0 }, tick: { other: 0, untold: 0 } };
  let after = 0;
  /** One judgment or tick, at `at`, said to be made by `by` under `under`. @param {"judgment" | "tick"} what @param {number} at @param {any} by @param {any} under */
  const tell = (what, at, by, under) => {
    const same = by ? sameCode(by, code) : null;
    if (same === true && policy != null && under === policy) return;
    if (same === null || policy == null || under == null) count[what].untold++; else count[what].other++;
    after = Math.max(after, at);
  };
  // Each judgment, by its record: the one its event names, kept as that pull
  // request's at that event, and whole.
  const rowOf = db.prepare("SELECT * FROM decision WHERE digest = ?");
  for (const e of [...events(db, "pr.decided", since, until), ...events(db, "queue.decided", since, until)]) {
    const row = typeof e.p.record === "string" ? /** @type {any} */ (rowOf.get(e.p.record)) : null;
    const own = row && Number(row.pr) === e.pr && Number(row.first_seq) <= e.seq && e.seq <= Number(row.last_seq);
    const d = own ? decisionOf(row) : null;
    const record = d && !d.corrupt ? d.record : null;
    tell("judgment", e.at, record?.code, record?.policy);
  }
  // Each tick, its start, end or stop: the time the trial ran is counted from them.
  for (const op of [TICK_STARTED, "daemon.tick", TICK_STOPPED])
    for (const e of events(db, op, since, until)) tell("tick", e.at, e.p.code, e.p.policy);
  const { judgment: j, tick: t } = count;
  if (!j.other && !j.untold && !t.other && !t.untold) return { ok: true };
  const said = [j.other ? `${j.other} judgment(s) made by other code or under another policy than this reeve would enforce with` : "",
                t.other ? `${t.other} tick(s) run by other code or under another policy than this reeve would enforce with` : "",
                j.untold ? `${j.untold} judgment(s) whose code or policy can't be told` : "",
                t.untold ? `${t.untold} tick(s) whose code or policy can't be told` : ""].filter(Boolean).join(", and ");
  return { ok: false, after, why: `the shadow trial from ${when(since)} saw ${said}` };
}

/**
 * Whether `reeve run --enforce` may enforce on the shadow trial in the store
 * `db`, read with its lock held (#166): the reasons it may not, each with what
 * would fix it. The store must be `nwo`'s; hold no record dated after `now`, the
 * trial's end, as then the clock has gone back and the trial can't be read
 * across it; and its trial must have passed, by the code and under the policy
 * about to enforce. `audits` reads the audits recorded: once for the report,
 * and again once all of it's read, as one recorded meanwhile may say a call the
 * report took as right was false.
 * @param {any} db
 * @param {{ nwo: string, store: string, named: boolean, since: number, now: number, trialSince: string,
 *           merged: any, seeded: any, code: any, policy: string | null, audits: () => any }} o
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function trialForEnforcing(db, { nwo, store, named, since, now, trialSince, merged, seeded, code, policy, audits }) {
  const bound = storeIsOf(db, nwo, { named });
  if ("why" in bound) return { ok: false, reasons: [`${store} isn't ${nwo}'s to read its shadow trial from: ${bound.why}`] };
  const newest = Number(/** @type {any} */ (db.prepare("SELECT MAX(at) AS at FROM event").get())?.at) || 0;
  if (newest > now)
    return { ok: false, reasons: [`${store} holds a record dated ${when(newest)}, after now: the clock has gone back since it was written, and a shadow trial can't be read across that. To enforce, run this again once the clock has passed it`] };
  const reasons = [];
  const first = audits();
  const passed = trialGate(trialReport(db, { repo: nwo, since, now, merged, seeded, audits: first.ok ? first.audits : { why: first.why } }), { since });
  if ("why" in passed) reasons.push(`${passed.why}. To enforce, run the trial until it passes: reeve trial ${nwo} --since ${trialSince} --seeded says what's short`);
  const ranOn = trialRanOn(db, { since, until: now, code, policy });
  if ("why" in ranOn) reasons.push(`${ranOn.why}. To enforce, run the trial again on this code and policy, from after ${when(ranOn.after)}`);
  if (JSON.stringify(audits()) !== JSON.stringify(first))
    reasons.push("an audit was recorded while the shadow trial was read, so what it says may not be what was read. To enforce, run this again");
  return { ok: !reasons.length, reasons };
}

/**
 * The report, for a person to read.
 * @param {ReturnType<typeof trialReport>} r @param {string} nwo
 */
export function renderTrial(r, nwo) {
  const out = [`shadow trial  ${nwo}  from ${when(r.since)} to ${when(r.now)}`, ""];
  const mark = (/** @type {boolean | null} */ m) => (m === true ? "met   " : m === false ? "short " : "person");
  out.push("conditions:");
  for (const c of r.conditions) out.push(`  ${mark(c.met)}  ${c.name}: ${c.detail}`);
  out.push("", r.passed ? "the trial has passed"
    : r.ready ? "every condition the records show holds: it passes once a person's audit finds no false call"
    : "the trial hasn't passed yet");
  out.push("", `running: ${r.running.hours.toFixed(1)} hours over ${r.running.ticks} tick(s)`);
  for (const d of r.running.down) out.push(`  down ${when(d.from)} to ${when(d.to)} (${((d.to - d.from) / 3600).toFixed(1)} hours)`);
  out.push("", "kinds of case:");
  for (const k of CASE_KINDS) out.push(`  ${r.kinds[k] != null ? `seen  #${r.kinds[k]}` : "not yet"}  ${k}`);
  if (r.seeded?.length) {
    out.push("", "seeded cases:");
    for (const s of r.seeded) out.push(`  ${s.ok ? "ok " : "NOT"}  ${(s.got ?? "not run").padEnd(7)}  ${s.name}: ${s.detail}`);
  }
  out.push("", `merged: ${r.merges.length}`);
  for (const m of r.merges)
    out.push(`  #${m.pr} at ${m.head.slice(0, 10)}: ${m.missed ? `MISSED, ${m.missed}` : `${m.state}${m.queue ? ", through the queue" : ""}`}`);
  if (r.toAudit.length) {
    out.push("", "to audit (was each call right?):");
    for (const a of r.toAudit) {
      const why = reasonOf(a);
      out.push(`  #${a.pr} ${a.state} ${a.where === "queue" ? "on the queue's commit" : "at"} ${a.head.slice(0, 10)}` +
               `${why ? ` (${why})` : ""}, ${a.ticks} tick(s)${a.final ? ", standing when it merged" : ""}` +
               `${a.record ? `, record ${a.record.slice(0, 12)}` : ""}` +
               `${a.audited ? `, audited: ${a.audited.mark}, by ${a.audited.by}${a.gone ? ", of a judgment this store doesn't hold" : a.again ? ", judged again since" : ""}` : ""}`);
    }
  }
  return out.join("\n");
}

// ── a person's audit of the calls (#294) ────────────────────────────────────

/** The sheet's column a person marks each call in. */
export const MARK_COLUMN = "was reeve right? (yes/no)";
/** How a call was marked when the sheet was made: what a mark left as it was is, and not a mark given anew. */
const BEFORE_COLUMN = "marked before";
/** The store's event a call was last judged at when the sheet was made: its mark covers it to there, and no further. */
const SEQ_COLUMN = "judged to";
const SHEET_COLUMNS = ["call", "pull request", "link", "where", "verdict", "reason", "standing when it merged", "ticks", "first seen", SEQ_COLUMN, BEFORE_COLUMN, MARK_COLUMN, "note"];
/** What a person may write in that column, and what it says. Left empty, the call isn't audited. */
const MARKS = new Map([["yes", true], ["right", true], ["no", false], ["wrong", false]]);

/**
 * One cell of the sheet. A cell starting as a formula does is written with a
 * quote mark first, so a spreadsheet shows it as text: a reason can carry a
 * check's name, and anyone opening a pull request can name a check.
 * @param {unknown} v
 */
function cell(v) {
  const s = /^[=+\-@\t\r]/.test(String(v ?? "")) ? `'${v}` : String(v ?? "");
  return /[",;\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The sheet a person audits the calls on, as CSV a spreadsheet opens: a row for
 * each call with its reason and a link to its pull request, and a column to
 * mark it right or not, filled in where an audit already marked it.
 * @param {Call[]} calls @param {string} nwo
 */
export function auditSheet(calls, nwo) {
  const rows = calls.map((c) => [c.id, c.pr, `https://github.com/${nwo}/pull/${c.pr}`, c.where, c.state,
    reasonOf(c), c.final ? "yes" : "", c.ticks, when(c.first), c.seq,
    ...marked(c), c.audited?.note ?? ""]);
  // Marked as UTF-8, and lines ended as CSV ends them, for a spreadsheet to read it so.
  return "\uFEFF" + [SHEET_COLUMNS, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/**
 * A call's mark when the sheet is made: how it was marked before, and the mark
 * it carries. One judged again since it was marked right carries none, to be
 * marked again, nor one whose judgment marked this store doesn't hold; what it
 * was marked is in the first.
 * @param {Call} c @returns {[string, string]}
 */
function marked(c) {
  if (!c.audited) return ["", ""];
  const was = c.audited.mark === "right" ? "yes" : "no";
  if (c.audited.mark !== "right") return [was, was];
  return c.gone ? [`${was}, of a judgment this store doesn't hold`, ""] : c.again ? [`${was}, judged again since`, ""] : [was, was];
}

/** CSV's rows, cells split at `d`, a quoted cell taken whole. @param {string} text @param {string} d */
function csvRows(text, d) {
  /** @type {string[][]} */ const rows = [];
  /** @type {string[]} */ let row = [];
  let at = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { at += '"'; i++; }
      else if (ch === '"') quoted = false;
      else at += ch;
    } else if (ch === '"' && at === "") quoted = true;
    else if (ch === d) { row.push(at); at = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(at); rows.push(row); row = []; at = "";
    } else at += ch;
  }
  if (at !== "" || row.length) { row.push(at); rows.push(row); }
  return rows;
}

/**
 * The marks a filled sheet gives, by call, however a spreadsheet saved it:
 * comma, semicolon or tab between cells, with or without a byte-order mark,
 * either line ending. A row with no mark is a call not audited. A mark that
 * isn't yes or no is refused, naming its call, rather than read as either; so
 * is a call marked twice two ways.
 * @param {string} text
 * @returns {{ ok: true, marks: Map<string, Marked> } | { ok: false, why: string }}
 */
export function readSheet(text) {
  const body = String(text);
  // Trimmed, a cell loses a byte-order mark too.
  const norm = (/** @type {string} */ s) => s.trim().toLowerCase();
  // Each column a mark is read with (#314): without "marked before", a mark the
  // sheet carried would read as one given, and a stale copy undo a correction.
  const d = [",", ";", "\t"].find((x) => { const h = (csvRows(body, x)[0] ?? []).map(norm); return ["call", SEQ_COLUMN, BEFORE_COLUMN, MARK_COLUMN].every((n) => h.includes(n)); });
  if (!d) return { ok: false, why: `it isn't an audit sheet: its first row doesn't name the columns "call", "${SEQ_COLUMN}", "${BEFORE_COLUMN}" and "${MARK_COLUMN}"` };
  const [head, ...rows] = csvRows(body, d);
  const [idAt, markAt, noteAt, beforeAt, seqAt] = ["call", MARK_COLUMN, "note", BEFORE_COLUMN, SEQ_COLUMN].map((n) => head.map(norm).indexOf(n));
  /** @type {Map<string, Marked>} */ const marks = new Map();
  for (const r of rows) {
    const id = (r[idAt] ?? "").trim(), mark = norm(r[markAt] ?? ""), note = noteAt < 0 ? "" : (r[noteAt] ?? "").trim();
    if (!id || !mark) continue;
    const right = MARKS.get(mark);
    if (right === undefined) return { ok: false, why: `call ${id} is marked ${JSON.stringify(r[markAt].trim())}: mark each call yes or no, or leave it empty` };
    // A mark the sheet carried from an audit, left as it was, is that audit's,
    // not this one's: recorded again, it would undo a correction recorded
    // since the sheet was made.
    if (MARKS.get(norm(r[beforeAt] ?? "")) === right) continue;
    // Only as far as the call was judged when the sheet was made.
    const to = Number((r[seqAt] ?? "").trim());
    if (!Number.isSafeInteger(to) || to < 1) return { ok: false, why: `call ${id}'s "${SEQ_COLUMN}" isn't an event of the store: the sheet's columns were changed` };
    const was = marks.get(id);
    if (was && was.right !== right) return { ok: false, why: `call ${id} is marked twice, yes and no` };
    marks.set(id, { right, note: was?.note || note, to: Math.min(was?.to ?? to, to) });
  }
  return { ok: true, marks };
}

/**
 * An audit of `calls`, the trial's as reported, from the marks a person gave:
 * each call as the report lists it, whatever else the sheet says, marked right,
 * a false pass where it passed, or a false block where it didn't, with who
 * made it and when. A mark for a call the trial doesn't list, from a sheet made
 * for another repository or another start, isn't taken; nor an audit that
 * marks nothing, or names no one. Each mark covers its call to the judgment
 * the sheet showed it judged to, which must be one of its own in the report's
 * `judgment` (#314), and keeps that judgment's record.
 * @param {Call[]} calls @param {Map<string, Marked>} marks
 * @param {{ repo: string, by: string, at: number, judgment: Judgment }} o
 * @returns {{ ok: true, audit: Audit } | { ok: false, why: string }}
 */
export function auditOf(calls, marks, { repo, by, at, judgment }) {
  const who = String(by ?? "").trim();
  if (!who) return { ok: false, why: "an audit names who made it: pass --by with their name" };
  const of = new Map(calls.map((c) => [c.id, c]));
  const stray = [...marks.keys()].filter((id) => !of.has(id));
  if (stray.length)
    return { ok: false, why: `the sheet marks ${stray.length} call(s) this trial doesn't list (${stray.slice(0, 3).join(", ")}): was it made for another repository, or with another --since?` };
  if (!marks.size) return { ok: false, why: `the sheet marks no call, but for marks it carried from audits recorded: write yes or no in its "${MARK_COLUMN}" column` };
  /** @type {Audit["calls"]} */ const audited = [];
  for (const c of calls) {
    const m = marks.get(c.id);
    if (!m) continue;
    // A "judged to" changed on the sheet, past the call's last judgment say,
    // would make the mark cover judgments the sheet didn't show.
    const to = m.to ?? c.seq, saw = judgment(to);
    if (saw?.id !== c.id)
      return { ok: false, why: `call ${c.id}'s "${SEQ_COLUMN}", ${to}, isn't one of its judgments in this trial: the sheet's columns were changed, or it was made for another period` };
    audited.push({ id: c.id, where: c.where, pr: c.pr, head: c.head, state: c.state, summary: c.summary, record: saw.record,
                   mark: m.right ? "right" : c.state === "PASS" ? "false pass" : "false block", note: m.note, to });
  }
  return { ok: true, audit: { repo, by: who, at, calls: audited } };
}

/**
 * Puts the sheet `text` at `sheetPath`, where nothing may be yet, and only then
 * runs `record`, recording the audit the sheet carries. The sheet is written
 * whole to a file of its own and synced, linked into place, which fails where
 * anything is there, and its folder synced: nothing is at its name until it's
 * whole, so a stop partway leaves no sheet to refuse a retry. A sheet that
 * can't be put in place records nothing, and one whose audit can't be
 * recorded is taken away. A file already there is left as it was, `EEXIST`;
 * otherwise what failed says which step, as `stage`, and, where a sheet taken
 * away couldn't have its folder synced, why, as `unsynced`: a power loss could
 * bring it back. Its own file is gone afterwards, whatever failed.
 * @template T @param {string} sheetPath @param {string} text @param {() => T} record
 * @param {{ write?: (fd: number, text: string) => void, syncDir?: (dir: string) => void }} [io] @returns {T}
 */
export function sheetThenRecord(sheetPath, text, record, { write = writeFileSync, syncDir = syncFolder } = {}) {
  const temp = join(dirname(sheetPath), `.${basename(sheetPath)}.${process.pid}.${randomBytes(4).toString("hex")}.part`);
  let placed = false, kept = false;
  /** @type {any} */ let failed = null;
  try {
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { write(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (err) { throw Object.assign(/** @type {Error} */ (err), { stage: "sheet" }); }
    linkSync(temp, sheetPath);
    placed = true;
    try { syncDir(dirname(sheetPath)); } catch (err) { throw Object.assign(/** @type {Error} */ (err), { stage: "sheet" }); }
    /** @type {T} */ let r;
    try { r = record(); } catch (err) { throw Object.assign(/** @type {Error} */ (err), { stage: "record" }); }
    kept = true;
    return r;
  } catch (err) { failed = err; throw err; }
  finally {
    try { unlinkSync(temp); } catch { /* gone */ }
    // Taken away, and its folder synced again (#314): a power loss could
    // otherwise bring the sheet back, to refuse a retry. Where it can't be,
    // that's said with what failed.
    if (placed && !kept) {
      rmSync(sheetPath, { force: true });
      try { syncDir(dirname(sheetPath)); }
      catch (err) { if (failed) failed.unsynced = `${dirname(sheetPath)}: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}`; }
    }
  }
}

/** The name of the audit recorded `n`th. @param {number} n */
const numbered = (n) => `${String(n).padStart(6, "0")}.json`;
/** The name of the host's note of the audit recorded `n`th. @param {number} n */
const noteName = (n) => `${String(n).padStart(6, "0")}.sha256`;
/** The digest an audit's note holds: of its file's bytes. @param {string | Buffer} bytes */
const digestOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * `dir`, and each folder above it to the one that holds the first folder
 * `made` on the way to it, as `mkdirSync` answers: each holds a name made
 * there, which only syncing it makes outlast a power loss.
 * @param {string} dir @param {string | undefined} made
 */
function holding(dir, made) {
  /** @type {string[]} */ const folders = [];
  for (let f = dir; ; f = dirname(f)) { folders.push(f); if (!made || f === dirname(made) || f === dirname(f)) break; }
  return folders;
}

/**
 * The host's notes of the audits recorded (#314), kept in `notes` in its
 * credentials folder, apart from the audits: each audit's number, and the
 * digest of what was recorded under it. None where none were noted. Why where
 * they can't be read, or one isn't a note reeve made: a note can't be told
 * from one of an audit since lost.
 * @param {string} notes
 * @returns {{ ok: true, noted: Map<number, string> } | { ok: false, why: string }}
 */
function readNotes(notes) {
  /** @type {Map<number, string>} */ const noted = new Map();
  if (!existsSync(notes)) return { ok: true, noted };
  try {
    // Its own file, while it's written, starts with a dot.
    for (const f of readdirSync(notes).filter((x) => !x.startsWith("."))) {
      const n = Number(/^(\d+)\.sha256$/.exec(f)?.[1]);
      if (!Number.isSafeInteger(n) || n < 1 || f !== noteName(n)) return { ok: false, why: `${f}, among the host's notes of the audits recorded, isn't one reeve noted` };
      noted.set(n, readFileSync(join(notes, f), "utf8").trim());
    }
  } catch (err) {
    return { ok: false, why: `the host's notes of the audits recorded, in ${notes}, can't be read: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}` };
  }
  return { ok: true, noted };
}

/**
 * Notes on the host, in `notes`, that the audit recorded `n`th has `digest`:
 * written whole to a file of its own and synced, linked into place, then its
 * folder synced, and each made for it with the one that holds it. Why it
 * couldn't be, or null.
 * @param {string} notes @param {number} n @param {string} digest
 * @param {{ link: typeof linkSync, fsync: typeof fsyncSync, syncDir: (dir: string) => void }} io
 * @returns {string | null}
 */
function note(notes, n, digest, { link, fsync, syncDir }) {
  try {
    const made = mkdirSync(notes, { recursive: true, mode: 0o700 });
    const temp = join(notes, `.${process.pid}.${randomBytes(4).toString("hex")}.part`);
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, digest + "\n"); fsync(fd); } finally { closeSync(fd); }
      link(temp, join(notes, noteName(n)));
    } finally { try { unlinkSync(temp); } catch { /* gone */ } }
    for (const f of holding(notes, made)) syncDir(f);
    return null;
  } catch (err) { return `${notes}: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}`; }
}

/**
 * Keeps `audit` in `dir` as the next of the audits there, numbered in the
 * order they were recorded, so the one recorded after counts. Written whole to
 * a file of its own and synced, then linked into place, which fails where
 * another took that number first, and the next is tried; its own file is gone
 * afterwards, whatever failed. Then its folder is synced, and each folder made
 * for it with the one that holds it, so an audit said to be recorded outlasts
 * a power loss. Where, and, once it's in place, a folder that couldn't be
 * synced as `unsynced`: it's recorded, read by every report, and recording it
 * again would make two.
 *
 * With `notes`, the host's notes in its credentials folder (#314): numbered
 * after the highest noted too, so one lost is never filled by another, and
 * noted there once it's in place, with the digest of what was recorded; any
 * found there without its note is noted first, and the notes' folders are
 * synced again, to the credentials folder. Notes that can't be read
 * record nothing; one that can't be made is said as `unnoted`: the audit is
 * recorded, but its loss couldn't be told.
 * @param {string} dir @param {Audit} audit
 * @param {{ notes?: string | null, link?: typeof linkSync, fsync?: typeof fsyncSync, syncDir?: (dir: string) => void }} [io]
 * @returns {{ path: string, unsynced: string | null, unnoted: string | null }}
 */
export function recordAudit(dir, audit, { notes = null, link = linkSync, fsync = fsyncSync, syncDir = syncFolder } = {}) {
  const known = notes == null ? { ok: true, noted: new Map() } : readNotes(notes);
  if ("why" in known) throw new Error(known.why);
  /** @type {string | null} */ let behind = null;
  // The notes there synced again, each folder to the credentials folder: one
  // whose sync failed when it was made is whole only once one succeeds.
  if (notes != null && existsSync(notes))
    for (const f of [notes, dirname(notes), dirname(dirname(notes)), dirname(dirname(dirname(notes)))]) {
      try { syncDir(f); } catch (err) { behind ??= `${f}: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}`; }
    }
  // An audit found without its note, one whose recording stopped before it was
  // noted, or one recorded before the host noted them, is noted now: its loss
  // can be told from here on.
  if (notes != null && existsSync(dir))
    for (const f of readdirSync(dir)) {
      const n = Number(/^(\d+)\.json$/.exec(f)?.[1]);
      if (f !== numbered(n) || known.noted.has(n)) continue;
      let digest;
      try { digest = digestOf(readFileSync(join(dir, f))); } catch { continue; }
      const why = note(notes, n, digest, { link, fsync, syncDir });
      if (why) behind ??= why;
      else known.noted.set(n, digest);
    }
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
  const folders = holding(dir, made);
  const temp = join(dir, `.${process.pid}.${randomBytes(4).toString("hex")}.part`);
  const text = JSON.stringify(audit, null, 2) + "\n";
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, text); fsync(fd); } finally { closeSync(fd); }
    const highest = Math.max(0, ...readdirSync(dir).map((f) => Number(/^(\d+)\.json$/.exec(f)?.[1] ?? 0)), ...known.noted.keys());
    for (let n = 1 + highest; ; n++) {
      const path = join(dir, numbered(n));
      try { link(temp, path); }
      catch (err) { if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") continue; throw err; }
      /** @type {string | null} */ let unsynced = null;
      for (const f of folders) {
        try { syncDir(f); }
        catch (err) { unsynced ??= `${f}: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}`; }
      }
      return { path, unsynced, unnoted: notes == null ? null : note(notes, n, digestOf(text), { link, fsync, syncDir }) ?? behind };
    }
  } finally { try { unlinkSync(temp); } catch { /* gone */ } }
}

/**
 * Why the text of the audit kept as `f` vouches for nothing to a report of
 * `repo`, or null: it doesn't read, doesn't read whole, marks a call twice, or
 * is another repository's.
 * @param {string} text @param {string} f @param {string} repo
 */
function auditFault(text, f, repo) {
  let a;
  try { a = JSON.parse(text); } catch { return `the audit recorded in ${f} can't be read`; }
  if (!auditWhole(a)) return `the audit recorded in ${f} doesn't read whole`;
  const twice = a.calls.find((/** @type {any} */ c, /** @type {number} */ i) => a.calls.findIndex((/** @type {any} */ d) => d.id === c.id) !== i);
  if (twice) return `the audit recorded in ${f} marks call ${twice.id} twice`;
  if (a.repo !== repo) return `the audit recorded in ${f} is of ${a.repo}, not ${repo}`;
  return null;
}

/** Whether `a` reads whole as an audit kept. @param {any} a */
function auditWhole(a) {
  const marks = ["right", "false pass", "false block"];
  return typeof a?.repo === "string" && typeof a.by === "string" && a.by.trim() !== "" && Number.isFinite(a.at) && Array.isArray(a.calls)
    && a.calls.every((/** @type {any} */ c) => typeof c?.id === "string" && marks.includes(c.mark) && typeof c.note === "string" && Number.isSafeInteger(c.to) && c.to >= 1);
}

/**
 * Every audit kept in `dir` for `repo`, in the order recorded, or why they
 * can't be read: a folder that can't be listed, a file that isn't one reeve
 * recorded, one that doesn't read whole or marks a call twice, or one of
 * another repository, vouches for nothing, and may have marked a call false.
 * With `notes`, the host's notes of them (#314): one noted and missing, the
 * newest say, which would leave those before it numbered whole, or one that
 * isn't what was noted under its number, vouches for nothing too.
 * @param {string} dir @param {string} repo @param {{ notes?: string | null }} [o]
 * @returns {{ ok: true, audits: Audit[] } | { ok: false, why: string }}
 */
export function readAudits(dir, repo, o = {}) {
  const read = auditsKept(dir, repo, o);
  return "why" in read ? read : { ok: true, audits: read.audits };
}

/**
 * The audits kept in `dir` as `readAudits` reads them, and each one's text as
 * it was recorded.
 * @param {string} dir @param {string} repo @param {{ notes?: string | null }} [o]
 * @returns {{ ok: true, audits: Audit[], texts: string[] } | { ok: false, why: string }}
 */
function auditsKept(dir, repo, { notes = null } = {}) {
  const known = notes == null ? { ok: true, noted: new Map() } : readNotes(notes);
  if ("why" in known) return { ok: false, why: known.why };
  /** @type {string[]} */ let names = [];
  try { if (existsSync(dir)) names = readdirSync(dir); }
  catch (err) { return { ok: false, why: `the audits recorded in ${dir} can't be listed: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}` }; }
  /** @type {Audit[]} */ const audits = [];
  /** @type {string[]} */ const texts = [];
  /** @type {Map<number, string>} */ const digests = new Map();
  for (const f of names.filter((x) => x.endsWith(".json")).sort()) {
    const seq = Number(/^(\d+)\.json$/.exec(f)?.[1]);
    if (!Number.isSafeInteger(seq) || seq < 1 || f !== numbered(seq)) return { ok: false, why: `${f}, among the audits recorded, isn't one reeve recorded` };
    let text;
    try { const bytes = readFileSync(join(dir, f)); digests.set(seq, digestOf(bytes)); text = bytes.toString("utf8"); }
    catch { return { ok: false, why: `the audit recorded in ${f} can't be read` }; }
    const fault = auditFault(text, f, repo);
    if (fault) return { ok: false, why: fault };
    texts.push(text);
    audits.push({ ...JSON.parse(text), seq });
  }
  // Numbered from one with none missing: an audit taken away from among them
  // may have corrected a mark one before it gave, which would stand again.
  const gap = audits.findIndex((a, i) => a.seq !== i + 1);
  if (gap >= 0)
    return { ok: false, why: `the audits recorded go to ${numbered(/** @type {number} */ (audits.at(-1)?.seq))}, but ${numbered(gap + 1)} is missing, so what it marked can't be told` };
  for (const [n, digest] of [...known.noted].sort((x, y) => x[0] - y[0])) {
    if (!digests.has(n))
      return { ok: false, why: `${numbered(n)}, noted on the host as recorded, is missing from ${dir}, so what it marked can't be told: a snapshot of the store that holds it puts it back, as reeve restore does` };
    if (digests.get(n) !== digest) return { ok: false, why: `${numbered(n)} isn't the audit the host noted under that number, so what it marked can't be told` };
  }
  return { ok: true, audits, texts };
}

/**
 * A copy of the audits of `repo` kept in `dir`, each as it was recorded, for a
 * snapshot of the store to carry (#311): none where none were recorded. Only
 * audits a report would read, by the host's `notes` too: why where they can't
 * be, as one put back from the copy would vouch for nothing either.
 * @param {string} dir @param {string} repo @param {{ notes?: string | null }} [o]
 * @returns {{ ok: true, audits: { name: string, text: string }[] } | { ok: false, why: string }}
 */
export function auditsCopy(dir, repo, o = {}) {
  const read = auditsKept(dir, repo, o);
  return "why" in read ? read : { ok: true, audits: read.texts.map((text, i) => ({ name: numbered(i + 1), text })) };
}

/**
 * Puts back in `dir` each audit of `repo` that `copy`, a snapshot's copy of
 * them as `auditsCopy` made it, holds and `dir` is missing, as it was recorded
 * (#311). Where an audit there isn't the one the copy holds under its number,
 * which of the two was recorded can't be told, and none is put back; nor from
 * a copy that doesn't read as one, is another repository's, or misses one.
 * Those recorded since the snapshot are left. Each is written whole to a file
 * of its own and synced, then linked into place, and its folders synced.
 * Each must read as a report reads it: one that doesn't, changed in the
 * snapshot since, puts none back. With the host's `notes`, each must be the
 * one noted under its number, and any not noted is noted, as on a host that
 * lost its notes with its audits; `unnoted` where one couldn't be. `where` is
 * what the copy is in, as a person reads it.
 * @param {unknown} copy @param {string} where @param {string} dir @param {string} repo
 * @param {{ notes?: string | null, fsync?: typeof fsyncSync, syncDir?: (dir: string) => void }} [io]
 * @returns {{ ok: true, put: number, unsynced?: string, unnoted?: string } | { ok: false, why: string }}
 */
export function putBackAudits(copy, where, dir, repo, { notes = null, fsync = fsyncSync, syncDir = syncFolder } = {}) {
  const c = /** @type {any} */ (copy);
  if (typeof c?.repo !== "string" || !Array.isArray(c.audits) || !c.audits.every((/** @type {any} */ a) => typeof a?.name === "string" && typeof a.text === "string"))
    return { ok: false, why: `the copy of the audits in ${where} can't be read` };
  if (c.repo !== repo) return { ok: false, why: `the copy of the audits in ${where} is of ${c.repo}, not ${repo}` };
  /** @type {{ name: string, text: string }[]} */ const audits = c.audits;
  const gap = audits.findIndex((a, i) => a.name !== numbered(i + 1));
  if (gap >= 0) return { ok: false, why: `${numbered(gap + 1)} is missing from the copy of the audits in ${where}` };
  for (const a of audits) {
    const fault = auditFault(a.text, a.name, repo);
    if (fault) return { ok: false, why: `in the copy of the audits in ${where}, ${fault}` };
  }
  const known = notes == null ? { ok: true, noted: new Map() } : readNotes(notes);
  if ("why" in known) return { ok: false, why: `${known.why}, so none is put back` };
  const unlike = audits.find((a, i) => known.noted.has(i + 1) && known.noted.get(i + 1) !== digestOf(a.text));
  if (unlike) return { ok: false, why: `${unlike.name} in the copy of the audits in ${where} isn't the audit the host noted under that number, so which was recorded can't be told` };
  /** @type {{ name: string, text: string }[]} */ const missing = [];
  for (const a of audits) {
    let there = null;
    try { there = readFileSync(join(dir, a.name), "utf8"); }
    catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== "ENOENT") return { ok: false, why: `${a.name} in ${dir} can't be read: ${code ?? /** @type {Error} */ (err).message}` };
    }
    if (there === null) missing.push(a);
    else if (there !== a.text) return { ok: false, why: `${a.name} in ${dir} isn't the audit the snapshot holds under that number, so which was recorded can't be told` };
  }
  // Those there already synced again too: a put back whose folder's sync
  // failed is whole only once one succeeds.
  if (!audits.length) return { ok: true, put: 0 };
  /** @type {string | undefined} */ let made;
  try {
    made = mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const a of missing) {
      const temp = join(dir, `.${process.pid}.${randomBytes(4).toString("hex")}.part`);
      try {
        const fd = openSync(temp, "wx", 0o600);
        try { writeFileSync(fd, a.text); fsync(fd); } finally { closeSync(fd); }
        linkSync(temp, join(dir, a.name));
      } finally { try { unlinkSync(temp); } catch { /* gone */ } }
    }
  } catch (err) {
    return { ok: false, why: `the audits couldn't be put back in ${dir}: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}` };
  }
  /** @type {{ ok: true, put: number, unsynced?: string, unnoted?: string }} */ const done = { ok: true, put: missing.length };
  for (const f of holding(dir, made)) {
    try { syncDir(f); }
    catch (err) { done.unsynced = `${f}: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}`; break; }
  }
  // Each noted on the host where it isn't, so the loss of one, the newest
  // say, can be told again after a host lost its notes with its audits.
  if (notes != null)
    for (const [i, a] of audits.entries()) {
      if (known.noted.has(i + 1)) continue;
      const why = note(notes, i + 1, digestOf(a.text), { link: linkSync, fsync, syncDir });
      if (why) { done.unnoted = why; break; }
    }
  return done;
}

/** `gh`, as the person running this reads GitHub, bounded as every read is (#282). @param {string[]} args */
function gh(args) {
  try { return { ok: true, out: execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
                                                            timeout: netTimeoutMs(), killSignal: "SIGKILL" }) }; }
  catch (e) { return { ok: false, out: "", err: netFailure(e) }; }
}

/**
 * What merged into `nwo` since `since`, in seconds, as GitHub says: each pull
 * request, when, its final head, and the commit it merged as, which is the
 * queue's commit where the queue merged it, up to `until`, the report's own
 * time: one merged while the report was made belongs to the next, as the
 * store's decisions are read only up to that time (#295). `why` where it
 * couldn't be read, which vouches for nothing, or where there may be more than
 * one read holds.
 * @param {string} nwo @param {number} since @param {{ run?: typeof gh, limit?: number, until?: number | null }} [o]
 * @returns {Merged[] | { why: string }}
 */
export function mergedSince(nwo, since, { run = gh, limit = 1000, until = null } = {}) {
  const iso = (/** @type {number} */ t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  // Bounded at `until` in the search too, so merges after the period don't
  // fill the one read the period's own merges must fit in.
  const r = run(["pr", "list", "--repo", nwo, "--state", "merged", "--search", until == null ? `merged:>=${iso(since)}` : `merged:${iso(since)}..${iso(until)}`,
                 "--json", "number,mergedAt,headRefOid,mergeCommit", "--limit", String(limit)]);
  if (!r.ok) return { why: r.err || "gh failed" };
  let rows;
  try { rows = JSON.parse(r.out); } catch { return { why: "GitHub's answer doesn't read as a list of pull requests" }; }
  if (!Array.isArray(rows)) return { why: "GitHub's answer doesn't read as a list of pull requests" };
  // A full page may not be all of them.
  if (rows.length >= limit) return { why: `more than ${limit} pull requests merged, more than one read holds` };
  /** @type {Merged[]} */ const out = [];
  for (const x of rows) {
    const at = Date.parse(x?.mergedAt);
    const mergeCommit = x?.mergeCommit == null ? null : x.mergeCommit.oid;
    if (!Number.isSafeInteger(x?.number) || !Number.isFinite(at) || typeof x?.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(x.headRefOid) ||
        (mergeCommit !== null && !/^[0-9a-f]{40}$/.test(String(mergeCommit))))
      return { why: `GitHub's answer holds a pull request that doesn't read whole: ${JSON.stringify(x).slice(0, 120)}` };
    if (at / 1000 >= since && (until == null || at / 1000 <= until)) out.push({ pr: x.number, mergedAt: Math.floor(at / 1000), head: x.headRefOid, mergeCommit });
  }
  return out.sort((a, b) => a.mergedAt - b.mergedAt);
}
