// @ts-check
// The shadow trial, reported against its conditions (#291). The trial passes on
// what it covers, not on days (#158): at least 72 hours in which the daemon
// ran; every pull request merged in that time judged at its final head, and
// none merged while the daemon was down; at least 10 of them passed on their
// final head; each kind of case seen; the seeded known-bad cases; and no false
// call on audit. This reads the store and what GitHub says merged, and changes
// nothing. What only a person can judge, a false call, is listed for them,
// every call the daemon made and not only those a merge met, never passed on
// silence.

import { execFileSync } from "node:child_process";
import { netTimeoutMs, netFailure } from "./net-bound.mjs";
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
 * @typedef {{ where: "head" | "queue", pr: number, head: string, state: string, summary: string, why: string,
 *             first: number, last: number, ticks: number, record: string | null, final: boolean }} Call
 * @typedef {{ name: string, met: boolean | null, detail: string }} Condition
 */

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
 * be, and that condition isn't met.
 * @param {any} db
 * @param {{ repo: string, since: number, now: number, merged: Merged[] | { why: string },
 *           seeded?: import("./seeded.mjs").Result[] | null }} o
 */
export function trialReport(db, { repo, since, now, merged, seeded = null }) {
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
  const wasDown = (/** @type {number} */ t) => down.some((d) => t > d.from && t < d.to);

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
    const key = JSON.stringify(Object.values(call));
    const c = calls.get(key) ?? { ...call, why: "", first: e.at, last: e.at, ticks: 0, record: null, final: false };
    c.why = String(e.p.why ?? "");
    c.last = e.at;
    c.ticks++;
    c.record = e.p.record ?? c.record;
    if (standing.has(e.seq)) c.final = true;
    calls.set(key, c);
  }
  const toAudit = [...calls.values()].sort((a, b) => a.pr - b.pr || a.first - b.first);

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
    // Only a person's audit says this, so it's never met here.
    { name: "no false call on audit", met: null, detail: `${toAudit.length} call(s) on ${new Set(toAudit.map((a) => a.pr)).size} pull request(s) to audit` },
  ];
  // Ready for a person's audit once every condition the records can show holds;
  // passed only once that audit is recorded, which nothing here does.
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
               `${a.record ? `, record ${a.record.slice(0, 12)}` : ""}`);
  }
  return out.join("\n");
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
