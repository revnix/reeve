// @ts-check
/**
 * Each merge judged as a tick ends (#342). The trial counts a merge's verdict
 * at its final head, and a merge may come between two ticks, or while the
 * daemon is down. So each tick looks for what merged since the last look, and
 * judges each merge once, as it stood at its merge (src/at-merge.mjs).
 *
 * A judgment is kept as its own event, `merge.judged`, and never as a
 * pull request's decision: nothing is published for a merge, and nothing that
 * reads a pull request's latest decision reads it. `merges.looked` keeps how
 * far the look has reached: every merge up to it is judged, and it stays a
 * little behind now.
 */
import { judgeAtMerge } from "./at-merge.mjs";
import { gh as runGh } from "./github/calls.mjs";
import { netTimeoutMs, netFailure } from "./net-bound.mjs";
import { isBuilderPr } from "./pr.mjs";
import { MERGE_JUDGED, MERGES_LOOKED, MERGE_TRIED } from "./status.mjs";

// The events' names live with the tick's own, where what reads them finds them without this module.
export { MERGE_JUDGED, MERGES_LOOKED, MERGE_TRIED };
/**
 * How far back the first look reaches: a day. Every later look starts where the
 * last reached, however long the daemon was down between them, so this is only
 * how much of what merged before reeve first looked it judges.
 */
export const FIRST_LOOK_SECONDS = 86400;
/**
 * How far behind now a look stays. What merged is read from GitHub's own list
 * of closed pull requests, which holds a merge once it's made; staying a
 * little behind costs nothing, as a merge judged is never judged again, and
 * leaves room for a read that answers a moment behind the merge.
 */
export const LISTED_WITHIN_SECONDS = 900;
/** How many pages of closed pull requests, a hundred each, one look reads at most. */
export const PAGES_AT_MOST = 10;
/** How many merges one tick judges: the rest wait for the next, oldest first. */
export const JUDGED_A_TICK = 3;
/**
 * How long a judgment only reading again settles is made again, from when the
 * merge was first tried, before it's kept as it is. From the first try and not
 * from the merge: a merge found hours after it, the daemon down since, is
 * given the same hour.
 */
export const AGAIN_FOR_SECONDS = 3600;

const iso = (/** @type {number} */ t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");

/** `gh`, as the daemon reads GitHub, bounded as every read is (#282). @param {string[]} args */
function gh(args) {
  try { return { ok: true, out: runGh(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: netTimeoutMs(), killSignal: "SIGKILL" }) }; }
  catch (e) { return { ok: false, out: "", err: netFailure(e) }; }
}

/**
 * @typedef {{ pr: number, mergedAt: number, head: string, mergeCommit: string | null, baseRef: string, headRef: string,
 *             author: string | null, title: string }} Merge
 */

/**
 * What merged into `nwo` from `since` to `until`, in seconds, both ends in,
 * the oldest first: each with what judging it needs, its base and head
 * branches, its title, and who opened it, null where GitHub doesn't say.
 *
 * Read from GitHub's list of the repository's closed pull requests, the most
 * lately changed first, and not from its search: the search lists a merge some
 * time after it happens and promises no time, so a look could pass over one
 * for good. A merge changes its pull request, so the list is read page by page
 * until one ends in a pull request last changed before `since`: none merged
 * since lies beyond it.
 *
 * Read over more than one page, a pull request changed meanwhile moves to the
 * top, past what was read. So the first page is read again, and what it holds
 * is taken too; where it holds nothing the reading began with, what moved
 * where can't be told.
 *
 * `why` where a page can't be read or doesn't read whole, where the list
 * changed past telling, or where it runs past PAGES_AT_MOST pages.
 * @param {string} nwo @param {number} since @param {{ until?: number | null, run?: typeof gh }} [o]
 * @returns {Merge[] | { why: string }}
 */
export function mergedList(nwo, since, { until = null, run = gh } = {}) {
  /** One page of the list. @param {number} n @returns {{ why: string } | { rows: any[] }} */
  const page = (n) => {
    const r = run(["api", `repos/${nwo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${n}`, "--jq",
                   ".[] | {number, merged_at, updated_at, head: .head.sha, mergeCommit: .merge_commit_sha, baseRef: .base.ref, headRef: .head.ref, author: .user.login, title} | @json"]);
    if (!r.ok) return { why: r.err || "gh failed" };
    /** @type {any[]} */ const rows = [];
    for (const line of r.out.split("\n").filter(Boolean)) {
      let x; try { x = JSON.parse(line); } catch { return { why: "GitHub's list of closed pull requests doesn't read" }; }
      const changed = Date.parse(x?.updated_at) / 1000, at = x?.merged_at == null ? null : Date.parse(x.merged_at) / 1000;
      // Each row's own time says where the list ends; a merged one must name what it merged.
      const whole = Number.isSafeInteger(x?.number) && Number.isFinite(changed) && (at === null
        || (Number.isFinite(at) && /^[0-9a-f]{40}$/.test(String(x.head)) && typeof x.baseRef === "string" && x.baseRef !== ""
            && (x.mergeCommit == null || /^[0-9a-f]{40}$/.test(String(x.mergeCommit)))));
      if (!whole) return { why: `GitHub's list holds a closed pull request that doesn't read whole: ${JSON.stringify(x).slice(0, 120)}` };
      rows.push({ ...x, changed, at });
    }
    return { rows };
  };
  /** @type {Map<number, Merge>} */ const merged = new Map();
  const take = (/** @type {any[]} */ rows) => {
    for (const x of rows) if (x.at !== null && x.at >= since && (until == null || x.at <= until))
      merged.set(x.number, { pr: x.number, mergedAt: Math.floor(x.at), head: x.head, mergeCommit: x.mergeCommit ?? null, baseRef: x.baseRef,
                             headRef: typeof x.headRef === "string" ? x.headRef : "", author: typeof x.author === "string" ? x.author : null,
                             title: typeof x.title === "string" ? x.title : "" });
  };
  /** @type {number | null} */ let top = null;
  for (let n = 1; n <= PAGES_AT_MOST; n++) {
    const got = page(n);
    if ("why" in got) return got;
    if (n === 1) top = got.rows[0]?.number ?? null;
    take(got.rows);
    if (got.rows.length === 100 && got.rows[99].changed >= since) continue;
    if (n > 1) {
      const again = page(1);
      if ("why" in again) return again;
      if (!again.rows.some((x) => x.number === top)) return { why: "GitHub's list of closed pull requests changed while it was read, past telling what moved" };
      take(again.rows);
    }
    return [...merged.values()].sort((a, b) => a.mergedAt - b.mergedAt || a.pr - b.pr);
  }
  return { why: `more than ${PAGES_AT_MOST * 100} pull requests changed since the last look, more than one look reads` };
}

/**
 * Judge what merged into `nwo` since the last look, up to `now`, in seconds:
 * the oldest `limit` not yet judged, each as it stood at its merge, and each
 * kept as a `merge.judged` event with what judged it, `ran`. A judgment only
 * reading again settles, or one that couldn't be made, is made again next tick
 * for AGAIN_FOR_SECONDS from when the merge was first tried, kept as a
 * `merge.tried` event, and kept as it is after.
 * A builder's pull request is judged with its hold unreadable: a hold isn't
 * kept as it stood at the merge. So is one whose author GitHub doesn't give,
 * as it may be a builder's.
 * A halt stops this work as it stops the rest: once `halted` says so, nothing
 * more is read or judged, and no look is kept, so what's left waits for the
 * next.
 * @param {{ nwo: string, profile: any, db: any, now: number, ran?: { code?: any, policy?: string | null } | null,
 *           merged?: typeof mergedList, judge?: typeof judgeAtMerge, limit?: number, log?: (line: string) => void,
 *           halted?: () => boolean }} o
 * @returns {{ ok: true, judged: number, waiting: number } | { ok: false, why: string }}
 */
export function judgeMerges({ nwo, profile, db, now, ran = null, merged = mergedList, judge = judgeAtMerge, limit = JUDGED_A_TICK, log = () => {}, halted = () => false }) {
  const stopped = { ok: /** @type {const} */ (false), why: "the merge policy is halted" };
  if (halted()) return stopped;
  let from = now - FIRST_LOOK_SECONDS;
  const last = /** @type {any} */ (db.prepare("SELECT payload FROM event WHERE op = ? ORDER BY seq DESC LIMIT 1").get(MERGES_LOOKED));
  try { const upTo = JSON.parse(last?.payload ?? "null")?.upTo; if (Number.isSafeInteger(upTo)) from = upTo; } catch { /* a look that doesn't read is no look */ }
  const list = merged(nwo, from, { until: now });
  if (!Array.isArray(list)) {
    log(`merges: what merged since ${iso(from)} couldn't be read, so none is judged this tick — ${list.why}`);
    return { ok: false, why: list.why };
  }
  const kept = db.prepare("SELECT at, payload FROM event WHERE op = ? AND subject = ? ORDER BY seq");
  /** The first event `op` of this merge: its pull request's, at its head, merged when it did. */
  const eventOf = (/** @type {string} */ op, /** @type {Merge} */ m) => /** @type {any[]} */ (kept.all(op, `pr:${m.pr}`)).find((r) => {
    try { const p = JSON.parse(r.payload); return p?.head === m.head && p?.mergedAt === m.mergedAt; } catch { return false; }
  });
  const isJudged = (/** @type {Merge} */ m) => Boolean(eventOf(MERGE_JUDGED, m));
  const keep = db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)");
  const waiting = list.filter((m) => !isJudged(m));
  /** When each merge left unjudged this tick merged. @type {number[]} */ const left = [];
  let judged = 0;
  for (const [i, m] of waiting.entries()) {
    if (i >= limit) { left.push(m.mergedAt); continue; }
    // Seen between two merges: those judged are kept, and no look is, as it would say the rest were reached.
    if (halted()) return stopped;
    /** @type {any} */ let e;
    try {
      e = m.mergeCommit
        ? judge({ nwo, merge: { pr: m.pr, head: m.head, mergedAt: m.mergedAt, mergeCommit: m.mergeCommit, baseRef: m.baseRef, headRef: m.headRef, title: m.title }, profile, db, now,
                  hold: isBuilderPr({ headRef: m.headRef, authorLogin: m.author }) ? { readable: false, why: "a builder's hold on it isn't kept as it stood at the merge" }
                    // Who opened it is half of what tells a builder's: unread, it's no evidence a builder didn't.
                    : m.author === null ? { readable: false, why: "who opened it couldn't be read, so whether a builder holds it can't be told" } : null })
        : { ok: false, why: "GitHub names no commit it merged as" };
    } catch (err) { e = { ok: false, why: `judging it threw: ${/** @type {Error} */ (err).message}` }; }
    const v = e.ok ? e.verdict : { state: "UNKNOWN", kind: "retry", summary: `it couldn't be judged: ${e.why}`, clauses: [] };
    const again = v.state === "UNKNOWN" && (v.kind === "retry" || v.kind === "waiting");
    // When it was first tried: kept the first time a judgment doesn't settle.
    const tried = !again ? null : eventOf(MERGE_TRIED, m)?.at
      ?? (keep.run(now, "daemon", MERGE_TRIED, `pr:${m.pr}`, JSON.stringify({ head: m.head, mergedAt: m.mergedAt })), now);
    if (tried !== null && now - tried < AGAIN_FOR_SECONDS) {
      left.push(m.mergedAt);
      log(`  merged #${m.pr}: not judged yet, and read again next tick — ${v.summary}`);
      continue;
    }
    keep.run(now, "daemon", MERGE_JUDGED, `pr:${m.pr}`, JSON.stringify({
      head: m.head, mergedAt: m.mergedAt, mergeCommit: m.mergeCommit, baseRef: m.baseRef ?? null,
      state: v.state, ...(v.kind ? { kind: v.kind } : {}), summary: v.summary, clauses: v.clauses, ...(ran ?? {}) }));
    judged++;
    log(`  merged #${m.pr}: judged as it stood at its merge, ${iso(m.mergedAt)} — ${v.state}${v.state === "PASS" ? "" : ` (${v.summary})`}`);
  }
  // Every merge up to here is judged: to a little before now, as GitHub may not
  // have listed the latest yet, and to just before the earliest left.
  keep.run(now, "daemon", MERGES_LOOKED, null, JSON.stringify({ upTo: Math.max(from, Math.min(now - LISTED_WITHIN_SECONDS, ...left.map((t) => t - 1))) }));
  if (judged || left.length) log(`merges: ${judged} judged as they stood at their merge${left.length ? `, ${left.length} left for the next tick` : ""}`);
  return { ok: true, judged, waiting: left.length };
}
