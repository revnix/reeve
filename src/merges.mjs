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
 * far the look has reached: every merge up to it is judged.
 */
import { judgeAtMerge } from "./at-merge.mjs";
import { isBuilderPr } from "./pr.mjs";
import { mergedSince } from "./trial.mjs";

/** The event a merge's judgment is kept as: subject `pr:N`, its payload the merge and the verdict on it. */
export const MERGE_JUDGED = "merge.judged";
/** The event a look is kept as: `upTo`, in seconds, the time every merge up to which is judged. */
export const MERGES_LOOKED = "merges.looked";
/** How far back the first look reaches. */
export const FIRST_LOOK_SECONDS = 7 * 86400;
/** How many merges one tick judges: the rest wait for the next, oldest first. */
export const JUDGED_A_TICK = 3;
/** How long after its merge a judgment only reading again settles is made again, before it's kept as it is. */
export const AGAIN_FOR_SECONDS = 3600;

const iso = (/** @type {number} */ t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * Judge what merged into `nwo` since the last look, up to `now`, in seconds:
 * the oldest `limit` not yet judged, each as it stood at its merge, and each
 * kept as a `merge.judged` event with what judged it, `ran`. A judgment only
 * reading again settles, or one that couldn't be made, is made again next tick
 * while the merge is younger than AGAIN_FOR_SECONDS, and kept as it is after.
 * A builder's pull request is judged with its hold unreadable: a hold isn't
 * kept as it stood at the merge.
 * @param {{ nwo: string, profile: any, db: any, now: number, ran?: { code?: any, policy?: string | null } | null,
 *           merged?: typeof mergedSince, judge?: typeof judgeAtMerge, limit?: number, log?: (line: string) => void }} o
 * @returns {{ ok: true, judged: number, waiting: number } | { ok: false, why: string }}
 */
export function judgeMerges({ nwo, profile, db, now, ran = null, merged = mergedSince, judge = judgeAtMerge, limit = JUDGED_A_TICK, log = () => {} }) {
  let from = now - FIRST_LOOK_SECONDS;
  const last = /** @type {any} */ (db.prepare("SELECT payload FROM event WHERE op = ? ORDER BY seq DESC LIMIT 1").get(MERGES_LOOKED));
  try { const upTo = JSON.parse(last?.payload ?? "null")?.upTo; if (Number.isSafeInteger(upTo)) from = upTo; } catch { /* a look that doesn't read is no look */ }
  const list = merged(nwo, from, { until: now, whole: true });
  if (!Array.isArray(list)) {
    log(`merges: what merged since ${iso(from)} couldn't be read, so none is judged this tick — ${list.why}`);
    return { ok: false, why: list.why };
  }
  const kept = db.prepare("SELECT payload FROM event WHERE op = ? AND subject = ?");
  const isJudged = (/** @type {import("./trial.mjs").Merged} */ m) => /** @type {any[]} */ (kept.all(MERGE_JUDGED, `pr:${m.pr}`)).some((r) => {
    try { const p = JSON.parse(r.payload); return p?.head === m.head && p?.mergedAt === m.mergedAt; } catch { return false; }
  });
  const keep = db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)");
  const waiting = list.filter((m) => !isJudged(m));
  /** When each merge left unjudged this tick merged. @type {number[]} */ const left = [];
  let judged = 0;
  for (const [i, m] of waiting.entries()) {
    if (i >= limit) { left.push(m.mergedAt); continue; }
    /** @type {any} */ let e;
    try {
      e = m.mergeCommit
        ? judge({ nwo, merge: { pr: m.pr, head: m.head, mergedAt: m.mergedAt, mergeCommit: m.mergeCommit, baseRef: String(m.baseRef), headRef: m.headRef, title: m.title }, profile, db, now,
                  hold: isBuilderPr({ headRef: m.headRef, authorLogin: m.author }) ? { readable: false, why: "a builder's hold on it isn't kept as it stood at the merge" } : null })
        : { ok: false, why: "GitHub names no commit it merged as" };
    } catch (err) { e = { ok: false, why: `judging it threw: ${/** @type {Error} */ (err).message}` }; }
    const v = e.ok ? e.verdict : { state: "UNKNOWN", kind: "retry", summary: `it couldn't be judged: ${e.why}`, clauses: [] };
    const again = v.state === "UNKNOWN" && (v.kind === "retry" || v.kind === "waiting");
    if (again && now - m.mergedAt < AGAIN_FOR_SECONDS) {
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
  // Every merge up to here is judged: up to now, or to just before the earliest left.
  keep.run(now, "daemon", MERGES_LOOKED, null, JSON.stringify({ upTo: left.length ? Math.max(from, Math.min(...left) - 1) : now }));
  if (judged || left.length) log(`merges: ${judged} judged as they stood at their merge${left.length ? `, ${left.length} left for the next tick` : ""}`);
  return { ok: true, judged, waiting: left.length };
}
