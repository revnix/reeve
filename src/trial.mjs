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
 * @typedef {{ id: string, where: "head" | "queue", pr: number, head: string, state: string, summary: string, why: string,
 *             first: number, last: number, seq: number, ticks: number, record: string | null, final: boolean, audited: Audited | null, again?: boolean }} Call
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

/** How a call reads where a person audits it. @param {{ where: string, pr: number, head: string, state: string }} c */
const callText = (c) => `#${c.pr} ${c.state} ${c.where === "queue" ? "on the queue's commit" : "at"} ${c.head.slice(0, 10)}`;
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
  for (const [where, list] of /** @type {const} */ ([["head", decided], ["queue", queued]])) for (const e of list) {
    const call = { where, pr: e.pr, head: String(e.p.head ?? ""), state: String(e.p.state ?? ""), summary: String(e.p.summary ?? "") };
    const id = callId({ repo, ...call });
    const c = calls.get(id) ?? { id, ...call, why: "", first: e.at, last: e.at, seq: e.seq, ticks: 0, record: null, final: false, audited: null, again: false };
    c.why = String(e.p.why ?? "");
    c.last = e.at;
    c.seq = e.seq;
    c.ticks++;
    c.record = e.p.record ?? c.record;
    if (standing.has(e.seq)) c.final = true;
    calls.set(id, c);
  }
  const toAudit = [...calls.values()].sort((a, b) => a.pr - b.pr || a.first - b.first);
  // Each call's mark, as a person's latest audit of it gave it: an audit made
  // later counts over one before, so a mark corrected stands corrected: in the
  // order recorded, which a clock set back, or two in one second, doesn't
  // change; by time where that isn't known.
  if (Array.isArray(audits)) for (const a of [...audits].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0) || x.at - y.at))
    for (const m of a.calls) { const c = calls.get(m.id); if (c) c.audited = { mark: m.mark, by: a.by, at: a.at, note: m.note, to: m.to }; }
  // A call judged again since it was marked right was judged on what that
  // audit didn't see, so it's for a person to mark again: judged after the
  // event its mark saw it judged to, by the store's order of events, which no
  // clock set back, or two in one second, changes. One marked wrong stays a
  // false call, however often it was judged again.
  for (const c of toAudit) c.again = Boolean(c.audited && c.seq > c.audited.to);
  const falseCalls = toAudit.filter((c) => c.audited && c.audited.mark !== "right");
  const notYet = toAudit.filter((c) => !c.audited || c.again);
  const prs = new Set(toAudit.map((a) => a.pr)).size;
  /** @type {Omit<Condition, "name">} */
  const audit = !Array.isArray(audits) ? { met: false, detail: `the audits recorded can't be read, so they vouch for nothing: ${audits.why}` }
    : falseCalls.length ? { met: false, detail: `${falseCalls.length} false call(s): ${some(falseCalls, (c) => `${callText(c)} (${c.audited?.mark}, by ${c.audited?.by})`)}` }
    // None audited, or nothing to audit: no audit says there was no false call.
    : notYet.length === toAudit.length ? { met: null, detail: `${toAudit.length} call(s) on ${prs} pull request(s) to audit` }
    : notYet.length ? { met: null, detail: `${toAudit.length - notYet.length} of ${toAudit.length} call(s) audited, none false; not yet: ${some(notYet, (c) => `${callText(c)}${c.again ? " (judged again since its audit)" : ""}`)}` }
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
  return { since, now, running: { hours, ticks: ended.length, down }, merges, passedFinal: passedFinal.length, kinds, toAudit, seeded, conditions,
           ready: conditions.every((c) => c.met !== false), passed: conditions.every((c) => c.met === true) };
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
    for (const a of r.toAudit)
      out.push(`  #${a.pr} ${a.state} ${a.where === "queue" ? "on the queue's commit" : "at"} ${a.head.slice(0, 10)}` +
               `${a.summary ? ` (${a.summary}${a.why ? `: ${a.why}` : ""})` : a.why ? ` (${a.why})` : ""}, ${a.ticks} tick(s)${a.final ? ", standing when it merged" : ""}` +
               `${a.record ? `, record ${a.record.slice(0, 12)}` : ""}` +
               `${a.audited ? `, audited: ${a.audited.mark}, by ${a.audited.by}${a.again ? ", judged again since" : ""}` : ""}`);
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
    c.summary ? `${c.summary}${c.why ? `: ${c.why}` : ""}` : c.why, c.final ? "yes" : "", c.ticks, when(c.first), c.seq,
    ...marked(c), c.audited?.note ?? ""]);
  // Marked as UTF-8, and lines ended as CSV ends them, for a spreadsheet to read it so.
  return "\uFEFF" + [SHEET_COLUMNS, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/**
 * A call's mark when the sheet is made: how it was marked before, and the mark
 * it carries. One judged again since it was marked right carries none, to be
 * marked again; what it was marked is in the first.
 * @param {Call} c @returns {[string, string]}
 */
function marked(c) {
  if (!c.audited) return ["", ""];
  const was = c.audited.mark === "right" ? "yes" : "no";
  return c.again && c.audited.mark === "right" ? [`${was}, judged again since`, ""] : [was, was];
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
  const d = [",", ";", "\t"].find((x) => { const h = (csvRows(body, x)[0] ?? []).map(norm); return h.includes("call") && h.includes(MARK_COLUMN) && h.includes(SEQ_COLUMN); });
  if (!d) return { ok: false, why: `it isn't an audit sheet: its first row doesn't name the columns "call", "${SEQ_COLUMN}" and "${MARK_COLUMN}"` };
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
    if (beforeAt >= 0 && MARKS.get(norm(r[beforeAt] ?? "")) === right) continue;
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
 * marks nothing, or names no one.
 * @param {Call[]} calls @param {Map<string, Marked>} marks
 * @param {{ repo: string, by: string, at: number }} o
 * @returns {{ ok: true, audit: Audit } | { ok: false, why: string }}
 */
export function auditOf(calls, marks, { repo, by, at }) {
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
    if (m) audited.push({ id: c.id, where: c.where, pr: c.pr, head: c.head, state: c.state, summary: c.summary, record: c.record,
                          mark: m.right ? "right" : c.state === "PASS" ? "false pass" : "false block", note: m.note, to: m.to ?? c.seq });
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
 * otherwise what failed says which step, as `stage`. Its own file is gone
 * afterwards, whatever failed.
 * @template T @param {string} sheetPath @param {string} text @param {() => T} record
 * @param {{ write?: (fd: number, text: string) => void, syncDir?: (dir: string) => void }} [io] @returns {T}
 */
export function sheetThenRecord(sheetPath, text, record, { write = writeFileSync, syncDir = syncFolder } = {}) {
  const temp = join(dirname(sheetPath), `.${basename(sheetPath)}.${process.pid}.${randomBytes(4).toString("hex")}.part`);
  let placed = false, kept = false;
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
  } finally {
    try { unlinkSync(temp); } catch { /* gone */ }
    if (placed && !kept) rmSync(sheetPath, { force: true });
  }
}

/** The name of the audit recorded `n`th. @param {number} n */
const numbered = (n) => `${String(n).padStart(6, "0")}.json`;

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
 * @param {string} dir @param {Audit} audit
 * @param {{ link?: typeof linkSync, fsync?: typeof fsyncSync, syncDir?: (dir: string) => void }} [io]
 * @returns {{ path: string, unsynced: string | null }}
 */
export function recordAudit(dir, audit, { link = linkSync, fsync = fsyncSync, syncDir = syncFolder } = {}) {
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
  /** @type {string[]} */ const folders = [];
  for (let f = dir; ; f = dirname(f)) { folders.push(f); if (!made || f === dirname(made) || f === dirname(f)) break; }
  const temp = join(dir, `.${process.pid}.${randomBytes(4).toString("hex")}.part`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(audit, null, 2) + "\n"); fsync(fd); } finally { closeSync(fd); }
    for (let n = 1 + Math.max(0, ...readdirSync(dir).map((f) => Number(/^(\d+)\.json$/.exec(f)?.[1] ?? 0))); ; n++) {
      const path = join(dir, numbered(n));
      try { link(temp, path); }
      catch (err) { if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") continue; throw err; }
      /** @type {string | null} */ let unsynced = null;
      for (const f of folders) {
        try { syncDir(f); }
        catch (err) { unsynced ??= `${f}: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}`; }
      }
      return { path, unsynced };
    }
  } finally { try { unlinkSync(temp); } catch { /* gone */ } }
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
 * @param {string} dir @param {string} repo
 * @returns {{ ok: true, audits: Audit[] } | { ok: false, why: string }}
 */
export function readAudits(dir, repo) {
  if (!existsSync(dir)) return { ok: true, audits: [] };
  let names;
  try { names = readdirSync(dir); }
  catch (err) { return { ok: false, why: `the audits recorded in ${dir} can't be listed: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}` }; }
  /** @type {Audit[]} */ const audits = [];
  for (const f of names.filter((x) => x.endsWith(".json")).sort()) {
    const seq = Number(/^(\d+)\.json$/.exec(f)?.[1]);
    if (!Number.isSafeInteger(seq) || seq < 1 || f !== numbered(seq)) return { ok: false, why: `${f}, among the audits recorded, isn't one reeve recorded` };
    let a;
    try { a = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return { ok: false, why: `the audit recorded in ${f} can't be read` }; }
    if (!auditWhole(a)) return { ok: false, why: `the audit recorded in ${f} doesn't read whole` };
    const twice = a.calls.find((/** @type {any} */ c, /** @type {number} */ i) => a.calls.findIndex((/** @type {any} */ d) => d.id === c.id) !== i);
    if (twice) return { ok: false, why: `the audit recorded in ${f} marks call ${twice.id} twice` };
    if (a.repo !== repo) return { ok: false, why: `the audit recorded in ${f} is of ${a.repo}, not ${repo}` };
    audits.push({ ...a, seq });
  }
  // Numbered from one with none missing: an audit taken away from among them
  // may have corrected a mark one before it gave, which would stand again.
  const gap = audits.findIndex((a, i) => a.seq !== i + 1);
  if (gap >= 0)
    return { ok: false, why: `the audits recorded go to ${numbered(/** @type {number} */ (audits.at(-1)?.seq))}, but ${numbered(gap + 1)} is missing, so what it marked can't be told` };
  return { ok: true, audits };
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
  const from = new Date(since * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const r = run(["pr", "list", "--repo", nwo, "--state", "merged", "--search", `merged:>=${from}`,
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
