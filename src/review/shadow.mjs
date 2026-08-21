// review/shadow — is the derived view telling the same story as the live read?
//
// PR-5 lets the verdict consume projections instead of reading GitHub directly on
// every tick. Before that, the two must be shown to agree over real time on real
// pull requests, the same way CI settlement was proven: observe, compare against
// what is already trusted, and only then switch the gate over.
//
// The one thing that makes this instrument honest is knowing what SHOULD match.
//
//   readThreads reports UNRESOLVED. The projection reports UNCLEARED. Those differ
//   deliberately and permanently: a thread the bot resolved by itself is resolved
//   and NOT cleared, because clearing needs a later round by that reviewer at the
//   head under judgement. Comparing those two numbers directly would show a
//   divergence on every tick that is not a divergence at all -- and an instrument
//   that cries wolf on correct behaviour teaches its reader to ignore it.
//
// So the comparison is:
//
//   total          MUST match. Both count the same threads, and a mismatch means
//                  ingest lost one or invented one.
//   resolved       MUST match. Both read GitHub's isResolved, one now and one via
//                  the inbox, so a mismatch means the projection is stale.
//   uncleared      is EXPECTED to be >= unresolved, and the gap is exactly the
//                  threads resolved but not confirmed by a later round. Reported,
//                  never counted as disagreement -- but a gap in the OTHER
//                  direction is impossible and is a real defect.

const day = at => new Date(at * 1000).toISOString().slice(0, 10);

/**
 * Compare one pull request's derived view against a live read.
 *
 * Returns {comparable, agree, why, ...counts}. `comparable` is false when either
 * side could not answer -- a truncated live read or an unreadable projection is
 * not evidence of agreement OR of disagreement, and counting it either way would
 * be absence rendered as a result.
 */
export function compare(live, projected) {
  const out = {
    live_total: live?.total ?? null, live_unresolved: live?.unresolved ?? null,
    proj_total: projected?.total ?? null, proj_open: projected?.open ?? null,
    proj_resolved: projected?.resolved ?? null,
  };

  if (!live || live.readable === false) {
    return { ...out, comparable: false, agree: false, why: "the live read was truncated or failed" };
  }
  if (!projected || projected.readable !== true) {
    return { ...out, comparable: false, agree: false, why: `no usable projection: ${projected?.why ?? "absent"}` };
  }

  const liveResolved = live.total - live.unresolved;
  const projResolved = projected.resolved;

  const problems = [];
  if (live.total !== projected.total) {
    problems.push(`thread count differs: live ${live.total}, derived ${projected.total}`);
  }
  if (liveResolved !== projResolved) {
    problems.push(`resolved differs: live ${liveResolved}, derived ${projResolved}`);
  }
  // Uncleared can only ever exceed unresolved. The reverse would mean the fold
  // cleared a thread GitHub still calls unresolved, which no rule permits.
  if (projected.open < live.unresolved) {
    problems.push(`derived cleared a thread GitHub still calls unresolved: ` +
                  `uncleared ${projected.open} < unresolved ${live.unresolved}`);
  }

  const heldBack = projected.open - live.unresolved;
  return {
    ...out, comparable: true, agree: problems.length === 0,
    why: problems.join("; ") || null,
    // Not a disagreement: the whole point of the clearing rule.
    note: heldBack > 0 ? `${heldBack} resolved thread(s) not yet confirmed by a later round` : null,
  };
}

/**
 * Record one comparison against the day it happened.
 *
 * A daily rollup rather than a row per tick, because the question this answers is
 * "how many consecutive DAYS has it agreed", and twenty rows an hour of the same
 * answer would bury the divergences that matter.
 */
export function record(db, nwo, pr, result, at = Math.floor(Date.now() / 1000)) {
  if (!result.comparable) {
    // Not counted as either. An incomparable tick is one where nothing was
    // learned, and a streak built from those would be a streak of not looking.
    db.prepare(`INSERT INTO review_shadow (nwo,pr,day,comparisons,agreements,incomparable,last_at)
                VALUES (?,?,?,0,0,1,?)
                ON CONFLICT(nwo,pr,day) DO UPDATE SET
                  incomparable = review_shadow.incomparable + 1, last_at = excluded.last_at`)
      .run(nwo, pr, day(at), at);
    return;
  }
  db.prepare(`INSERT INTO review_shadow (nwo,pr,day,comparisons,agreements,incomparable,last_divergence,last_at)
              VALUES (?,?,?,1,?,0,?,?)
              ON CONFLICT(nwo,pr,day) DO UPDATE SET
                comparisons = review_shadow.comparisons + 1,
                agreements  = review_shadow.agreements + excluded.agreements,
                last_divergence = COALESCE(excluded.last_divergence, review_shadow.last_divergence),
                last_at = excluded.last_at`)
    .run(nwo, pr, day(at), result.agree ? 1 : 0, result.why ?? null, at);
}

/**
 * How many consecutive days, ending today, every comparison agreed.
 *
 * A day counts only if something was actually compared on it. A quiet day -- no
 * open pull requests, or every read truncated -- neither extends the streak nor
 * breaks it, because nothing was learned either way. Rendering it as a day of
 * agreement is exactly the absence-as-success this system exists to refuse.
 */
export function streak(db, nwo, at = Math.floor(Date.now() / 1000)) {
  const rows = db.prepare(
    `SELECT day, SUM(comparisons) c, SUM(agreements) a, SUM(incomparable) i
       FROM review_shadow WHERE nwo = ? GROUP BY day ORDER BY day DESC`).all(nwo);
  let days = 0, examined = 0, divergent = null;
  for (const r of rows) {
    if (!r.c) continue;                 // nothing compared: skipped, not counted
    if (r.a !== r.c) {
      divergent = { day: r.day, of: r.c, agreed: r.a };
      break;
    }
    days++; examined += r.c;
  }
  return { days, comparisons: examined, firstDivergence: divergent, today: day(at) };
}

/** Every divergence still on record, newest first — the list to explain in writing. */
export function divergences(db, nwo, limit = 20) {
  return db.prepare(
    `SELECT day, pr, comparisons, agreements, last_divergence FROM review_shadow
      WHERE nwo = ? AND agreements < comparisons ORDER BY day DESC, pr LIMIT ?`).all(nwo, limit);
}
