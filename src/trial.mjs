// @ts-check
// The shadow trial, reported against its conditions (#291). The trial passes on
// what it covers, not on days (#158): at least 72 hours in which the daemon
// ran; every pull request merged in that time judged at its final head, and
// none merged while the daemon was down; at least 10 of them passed on their
// final head; each kind of case seen; the seeded known-bad cases; and no false
// call on audit. This reads the store and what GitHub says merged, and changes
// nothing. What only a person can judge, a false call, is listed for them,
// never passed on silence.

import { execFileSync } from "node:child_process";
import { netTimeoutMs, netFailure } from "./net-bound.mjs";

/** A gap between ticks longer than this is downtime, as #158 says. */
export const GAP_SECONDS = 15 * 60;
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
 * @typedef {{ pr: number, mergedAt: number, head: string }} Merged
 * @typedef {{ pr: number, head: string, state: string, record: string | null, at: number }} Final
 * @typedef {{ name: string, met: boolean | null, detail: string }} Condition
 */

/** @param {any} db @param {string} op @param {number} since @param {number} now */
const events = (db, op, since, now) => /** @type {any[]} */ (db.prepare(
  `SELECT seq, at, subject, payload FROM event WHERE op = ? AND at >= ? AND at <= ? ORDER BY seq`).all(op, since, now))
  .map((r) => { let p = {}; try { p = JSON.parse(r.payload ?? "{}") ?? {}; } catch { /* a payload that can't be read says nothing */ }
                return { seq: Number(r.seq), at: Number(r.at), pr: Number(String(r.subject ?? "").replace(/^pr:/, "")), p }; });

/**
 * The trial from `since` to `now`, both in seconds, against its conditions.
 * `merged` is what GitHub says merged in that time, or `{ why }` where it
 * couldn't be read, and then whether every merge was covered can't be said.
 * `seeded` is the known-bad cases seeded, each with the verdict it must get and
 * got; none seeded is a condition not yet met.
 * @param {any} db
 * @param {{ since: number, now: number, merged: Merged[] | { why: string },
 *           seeded?: { name: string, must: string, got: string | null }[] }} o
 */
export function trialReport(db, { since, now, merged, seeded = [] }) {
  // Running time, from the ticks: each gap between ticks, and from the start to
  // the first and from the last to now, is running up to GAP_SECONDS, and past
  // it, downtime.
  const ticks = events(db, "daemon.tick", since, now).map((e) => e.at);
  const marks = [since, ...ticks, now];
  /** @type {{ from: number, to: number }[]} */ const down = [];
  let running = 0;
  for (let i = 1; i < marks.length; i++) {
    const gap = marks[i] - marks[i - 1];
    if (gap > GAP_SECONDS) down.push({ from: marks[i - 1], to: marks[i] });
    else running += gap;
  }
  // No tick at all is no running, however short the time.
  if (!ticks.length) running = 0;
  const wasDown = (/** @type {number} */ t) => down.some((d) => t > d.from && t < d.to);

  const decided = events(db, "pr.decided", since, now);
  const queued = events(db, "queue.decided", since, now);

  // Each merged pull request, its final head, and how it was judged there.
  /** @type {(Merged & { judged: boolean, state: string | null, record: string | null, down: boolean, queue: boolean, missed: string | null })[]} */
  const merges = [];
  if (Array.isArray(merged)) for (const m of merged) {
    const atHead = decided.filter((e) => e.pr === m.pr && e.p.head === m.head);
    const last = atHead.at(-1);
    const isDown = wasDown(m.mergedAt);
    merges.push({ ...m, judged: Boolean(last), state: last?.p.state ?? null, record: last?.p.record ?? null, down: isDown,
                  queue: queued.some((e) => e.pr === m.pr),
                  missed: isDown ? "merged while the daemon was down" : !last ? "its final head was never judged" : null });
  }
  const passedFinal = merges.filter((m) => m.state === "PASS");

  // The kinds of case seen, each with the first pull request that showed it.
  const clause = (/** @type {any} */ p, /** @type {string} */ id) => (Array.isArray(p.clauses) ? p.clauses.find((c) => c?.id === id)?.state : undefined);
  const firstPr = (/** @type {(e: any) => boolean} */ f) => decided.find(f)?.pr ?? null;
  // A new push after a review: a head first seen in the period, after a review
  // round on another head of the same pull request.
  const pushedAfterReview = /** @type {any[]} */ (db.prepare(
    `SELECT DISTINCT h.pr FROM head_seen h JOIN review_round r ON r.pr = h.pr AND r.head_full <> h.sha
      WHERE h.first_seen_at >= ? AND h.first_seen_at <= ? AND r.event_at < h.first_seen_at ORDER BY h.pr`).all(since, now)).map((r) => Number(r.pr));
  /** @type {Record<string, number | null>} */
  const kinds = {
    "a pull request that passes": firstPr((e) => e.p.state === "PASS"),
    "failing CI": firstPr((e) => e.p.action === "FIX_CI" || /^failing:/.test(String(e.p.why ?? ""))),
    "a conflict with the base": firstPr((e) => /conflicts with its base/.test(String(e.p.why ?? ""))),
    "unresolved threads": firstPr((e) => clause(e.p, "threads") === "BLOCK"),
    "a new push after a review": pushedAfterReview[0] ?? null,
    "a merge through the merge queue": merges.find((m) => m.queue)?.pr ?? null,
  };

  // What a person must judge: every final verdict on a merged pull request. A
  // pass that should have stopped, or a block the inputs didn't justify, can't
  // be told from the records alone.
  const toAudit = merges.filter((m) => m.state).map((m) => ({ pr: m.pr, head: m.head, state: /** @type {string} */ (m.state), record: m.record }));

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
    { name: "every seeded known-bad case got the verdict it must",
      met: seeded.length ? seeded.every((s) => s.got === s.must) : false,
      detail: seeded.length ? `${seeded.filter((s) => s.got === s.must).length} of ${seeded.length}` : "none seeded yet" },
    // Only a person's audit says this, so it's never met here.
    { name: "no false call on audit", met: null, detail: `${toAudit.length} final verdict(s) to audit` },
  ];
  // Ready for a person's audit once every condition the records can show holds;
  // passed only once that audit is recorded, which nothing here does.
  return { since, now, running: { hours, ticks: ticks.length, down }, merges, passedFinal: passedFinal.length, kinds, toAudit, seeded, conditions,
           ready: conditions.every((c) => c.met !== false), passed: conditions.every((c) => c.met === true) };
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
  out.push("", `merged: ${r.merges.length}`);
  for (const m of r.merges)
    out.push(`  #${m.pr} at ${m.head.slice(0, 10)}: ${m.missed ? `MISSED, ${m.missed}` : `${m.state}${m.queue ? ", through the queue" : ""}`}`);
  if (r.toAudit.length) {
    out.push("", "to audit (was each final verdict right?):");
    for (const a of r.toAudit) out.push(`  #${a.pr} ${a.state} at ${a.head.slice(0, 10)}${a.record ? ` (record ${a.record.slice(0, 12)})` : ""}`);
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
 * request, when, and its final head. `why` where it couldn't be read, which
 * vouches for nothing, or where there may be more than one read holds.
 * @param {string} nwo @param {number} since @param {{ run?: typeof gh, limit?: number }} [o]
 * @returns {Merged[] | { why: string }}
 */
export function mergedSince(nwo, since, { run = gh, limit = 1000 } = {}) {
  const from = new Date(since * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const r = run(["pr", "list", "--repo", nwo, "--state", "merged", "--search", `merged:>=${from}`,
                 "--json", "number,mergedAt,headRefOid", "--limit", String(limit)]);
  if (!r.ok) return { why: r.err || "gh failed" };
  let rows;
  try { rows = JSON.parse(r.out); } catch { return { why: "GitHub's answer doesn't read as a list of pull requests" }; }
  if (!Array.isArray(rows)) return { why: "GitHub's answer doesn't read as a list of pull requests" };
  // A full page may not be all of them.
  if (rows.length >= limit) return { why: `more than ${limit} pull requests merged, more than one read holds` };
  /** @type {Merged[]} */ const out = [];
  for (const x of rows) {
    const at = Date.parse(x?.mergedAt);
    if (!Number.isSafeInteger(x?.number) || !Number.isFinite(at) || typeof x?.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(x.headRefOid))
      return { why: `GitHub's answer holds a pull request that doesn't read whole: ${JSON.stringify(x).slice(0, 120)}` };
    if (at / 1000 >= since) out.push({ pr: x.number, mergedAt: Math.floor(at / 1000), head: x.headRefOid });
  }
  return out.sort((a, b) => a.mergedAt - b.mergedAt);
}
