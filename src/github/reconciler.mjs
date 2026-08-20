// reconciler — GitHub is authoritative for PR, head, check, review and merge facts.
//
// Every rule here is a measured failure, not a precaution:
//   · the head is pinned ONCE per tick from ls-remote, because headRefOid reports
//     the MERGED head and a verdict keyed on it judges a revision nobody read;
//   · check-runs and commit statuses are UNIONED, because they disagree: at PR
//     #1119's head the combined status was success while a check run was failure;
//   · liveness matches on status != COMPLETED, never conclusion == null, because
//     GraphQL emits "" not null while a check is in flight;
//   · settled requires the check-NAME set to be stable across polls, because a
//     workflow that has not scheduled its jobs yet looks identical to one that
//     has none.

import { execFileSync } from "node:child_process";

/** Conclusions that do NOT block. Everything else does, including the ones a naive
 *  `conclusion === "failure"` branch would fall straight through. */
const PASSING = new Set(["success", "skipped", "neutral"]);
/** The full space, so an unrecognised value is treated as blocking rather than ignored. */
const KNOWN_CONCLUSIONS = new Set([
  "success", "failure", "neutral", "cancelled", "skipped", "timed_out",
  "action_required", "startup_failure", "stale",
]);
/**
 * Not failures — absences of information. A run is cancelled almost entirely
 * because a newer push superseded it, and a stale check describes a revision
 * nobody is asking about. Calling these RED produced a measured false block on
 * the first shadow tick: main had just moved, its previous run was cancelled, and
 * four PRs escalated "the base branch is red" to the phone.
 *
 * Both still refuse a merge, because UNKNOWN never merges. The difference is the
 * ACTION: RED escalates to a human, UNKNOWN waits for the answer to arrive.
 */
const UNINFORMATIVE = new Set(["cancelled", "stale"]);

function sh(cmd, args) {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (e) { return { ok: false, out: "", err: String(e.stderr || e.message).trim() }; }
}
const gh = (path, jq) => { const a = ["api", path]; if (jq) a.push("--jq", jq); return sh("gh", a); };

/**
 * The one true head for this tick. Read from the ref itself, never from the PR
 * object, and carried unchanged through every read that follows.
 */
export function pinHead(nwo, branch) {
  const r = sh("git", ["ls-remote", `https://github.com/${nwo}.git`, `refs/heads/${branch}`]);
  if (!r.ok || !r.out) return { ok: false, sha: null, why: r.err || `no ref refs/heads/${branch}` };
  const sha = r.out.split("\n")[0].split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, sha: null, why: `unparseable ref line: ${r.out.slice(0, 80)}` };
  return { ok: true, sha };
}

/**
 * Every check at a SHA, from both surfaces. Returns rows normalised to
 * {name, source, state, conclusion, id}. `state` is "completed" or "running".
 */
export function readChecks(nwo, sha) {
  const rows = [];
  // JSON, not TSV. A commit-status description may contain a newline or a tab,
  // and a TSV parse then splits it into a phantom row whose "name" is a fragment
  // of the description and whose conclusion is undefined — which classifies as a
  // failure and reports "failing: undefined" to the fixer.
  const parse = (raw, fn) => {
    if (!raw) return;
    let j; try { j = JSON.parse(raw); } catch { return; }
    for (const item of j) { const r = fn(item); if (r && r.name) rows.push(r); }
  };
  const cr = gh(`repos/${nwo}/commits/${sha}/check-runs?per_page=100&filter=latest`, ".check_runs");
  if (cr.ok) parse(cr.out, c => ({
    name: c.name, source: "check_run",
    state: c.status === "completed" ? "completed" : "running",
    conclusion: c.conclusion || null, id: c.id != null ? String(c.id) : null,
  }));
  const st = gh(`repos/${nwo}/commits/${sha}/status`, ".statuses");
  if (st.ok) parse(st.out, x => ({
    // A StatusContext has .state and no .conclusion. "pending" is in flight.
    name: x.context, source: "status",
    state: x.state === "pending" ? "running" : "completed",
    conclusion: x.state === "pending" ? null : x.state,
    // A rate-limited CodeRabbit reports state=success with the truth relegated
    // here, so the description is carried rather than discarded.
    description: x.description ?? "",
  }));
  return { ok: cr.ok || st.ok, rows, why: cr.ok || st.ok ? null : (cr.err || st.err) };
}

/** Classify a set of check rows. Never returns "green" on absence. */
export function classify(allRows, requiredChecks = []) {
  // A row with no name is a PARSE DEFECT, not a check. It cannot be reported to a
  // fixer ("failing: undefined") and it must not block on its own, but it must
  // also not vanish silently, so it is counted and surfaced.
  const rows = allRows.filter(r => r && r.name);
  const malformed = allRows.length - rows.length;
  if (!rows.length) return {
    verdict: "UNKNOWN", failing: [], running: [], malformed,
    why: malformed ? `${malformed} unparseable check row(s) and nothing else` : "no checks reported at this revision",
  };
  const running = rows.filter(r => r.state !== "completed");
  const completed = rows.filter(r => r.state === "completed");
  const uninformative = completed.filter(r => UNINFORMATIVE.has(String(r.conclusion)));
  const failing = completed.filter(r =>
    !UNINFORMATIVE.has(String(r.conclusion)) &&
    (!KNOWN_CONCLUSIONS.has(String(r.conclusion)) || !PASSING.has(String(r.conclusion))));
  const names = new Set(rows.map(r => r.name));
  const missing = requiredChecks.filter(c => !names.has(c));

  if (missing.length) return { verdict: "MISSING_REQUIRED", why: `required check(s) never reported: ${missing.join(", ")}`, failing, running, missing, malformed };
  if (failing.length) return { verdict: "RED", why: `${failing.length} check(s) not passing`, failing, running, malformed };
  if (running.length) return { verdict: "RUNNING", why: `${running.length} check(s) still in flight`, failing, running, malformed };
  if (uninformative.length) return {
    verdict: "UNKNOWN", failing: [], running: [], uninformative,
    why: `${uninformative.length} check(s) cancelled or stale — superseded, not failed`,
  };
  if (malformed) return { verdict: "UNKNOWN", failing: [], running: [], malformed, why: `${malformed} check row(s) could not be parsed, so this revision is not checkable` };
  return { verdict: "GREEN", why: `${rows.length} check(s) all passing`, failing: [], running: [], malformed };
}

/**
 * Settlement across polls. A single green reading is not settlement: a workflow
 * that has not yet scheduled its jobs reports an empty, unfailing set that is
 * byte-identical to a finished clean run.
 *
 * Requires, for the SAME sha: three consecutive readings, an unchanged check-NAME
 * set across them, and a count at or above the floor seen for this PR before.
 */
export function settle(prior, reading) {
  const names = [...new Set(reading.rows.map(r => r.name))].sort();
  const key = names.join("\0");
  const floor = prior?.floor ?? 0;
  const same = prior && prior.sha === reading.sha && prior.key === key;
  const streak = same ? (prior.streak ?? 0) + 1 : 1;
  const next = { sha: reading.sha, key, streak, floor: Math.max(floor, names.length), names };

  // THE cause of a run of "undefined" symptoms: these two returns dropped the
  // reading's `why`, so checks.why was undefined, the verdict's
  // MISSING_REQUIRED branch passed it through as the clause detail, and every
  // consumer downstream rendered the string "undefined". Carry it.
  // A failing check is PRESENT evidence: more looks will not un-fail it, so RED
  // settles at once. A required check that has not appeared is an ABSENCE --
  // GitHub may simply not have created it yet -- so it needs the same
  // corroboration a green set does. Calling it "never reported" on first sight
  // is the same absence-read-as-fact error pointed the other way.
  if (reading.verdict === "RED")
    return { ...next, settled: true, verdict: reading.verdict, why: reading.why };
  if (reading.verdict === "MISSING_REQUIRED")
    return { ...next, settled: streak >= 3, verdict: reading.verdict, why: reading.why };
  if (reading.verdict !== "GREEN") return { ...next, settled: false, verdict: reading.verdict, why: reading.why };
  if (names.length < floor) return { ...next, settled: false, verdict: "UNKNOWN", why: `only ${names.length} checks reported where ${floor} were seen before` };
  if (streak < 3) return { ...next, settled: false, verdict: "SETTLING", why: `green reading ${streak} of 3` };
  return { ...next, settled: true, verdict: "GREEN" };
}

/**
 * One paginated call returns commits, comments, reviews with commit_id,
 * force-pushes and the merge. Replaces three unsynchronised polls that can
 * interleave into a coherent-looking impossible picture.
 */
export function readTimeline(nwo, pr) {
  const r = gh(`repos/${nwo}/issues/${pr}/timeline?per_page=100`,
    '.[] | [(.event // ""), (.created_at // .submitted_at // ""), ((.actor.login // .user.login) // ""), ((.commit_id // .sha) // "")] | @tsv');
  if (!r.ok) return { ok: false, events: [], why: r.err };
  const events = r.out.split("\n").filter(Boolean).map(l => {
    const [event, at, actor, sha] = l.split("\t");
    return { event, at, actor, sha };
  });
  return { ok: true, events };
}

/** A force-push invalidates every outstanding review round at the old head. */
export function lastForcePush(events) {
  const fp = events.filter(e => e.event === "head_ref_force_pushed").at(-1);
  return fp ? fp.at : null;
}

/**
 * Bring one PR's facts into the store. Returns what changed, so divergence
 * between what we believed and what GitHub says is measurable rather than
 * silently corrected.
 */
export function reconcilePr(db, { nwo, pr, profile = {} }) {
  const meta = gh(`repos/${nwo}/pulls/${pr}`, '[.state, .merged, .head.ref, .base.ref, (.merge_commit_sha // ""), .title] | @tsv');
  if (!meta.ok) return { ok: false, why: meta.err };
  const [state, merged, headRef, baseRef, mergeSha, title] = meta.out.split("\t");
  const isMerged = merged === "true";

  const pin = pinHead(nwo, headRef);
  const head = pin.ok ? pin.sha : null;

  const id = `pr:${pr}`;
  const now = Math.floor(Date.now() / 1000);
  const before = db.prepare("SELECT id, status FROM node WHERE id = ?").get(id);
  const status = isMerged ? "done" : state === "closed" ? "cancelled" : "review";

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!before) {
      db.prepare(`INSERT INTO node(id,kind,title,status,profile,created_at,updated_at)
                  VALUES(?,?,?,?,?,?,?)`)
        .run(id, "pr", title || `PR #${pr}`, status, profile.identity?.key ?? "default", now, now);
    } else if (before.status !== status) {
      db.prepare("UPDATE node SET status=?, updated_at=?, version=version+1 WHERE id=?").run(status, now, id);
    }
    db.prepare(`INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)`)
      .run(now, "reconciler", "pr.observed", id, JSON.stringify({ state, merged: isMerged, head, headRef, baseRef, mergeSha }));

    // A merged PR releases every lease held for it. Nothing else does this today,
    // which is why two claims sat on PRs that had merged twelve hours earlier.
    let released = 0;
    if (isMerged) {
      const runs = db.prepare(
        `SELECT r.id, r.task_id FROM run r
         WHERE r.status IN ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder')
           AND json_extract(r.cursor,'$.pr') = ?`).all(Number(pr));
      for (const run of runs) {
        db.prepare("UPDATE run SET status='succeeded', ended_at=? WHERE id=?").run(now, run.id);
        db.prepare("UPDATE node SET status='done', updated_at=?, version=version+1 WHERE id=?").run(now, run.task_id);
        db.prepare(`INSERT INTO event(at,actor,op,subject,run_id,payload) VALUES(?,?,?,?,?,?)`)
          .run(now, "reconciler", "lease.released", run.task_id, run.id, JSON.stringify({ because: `pr:${pr} merged` }));
        released++;
      }
    }
    db.exec("COMMIT");
    return { ok: true, id, state, merged: isMerged, head, headRef, baseRef, released,
             changed: !before || before.status !== status, previous: before?.status ?? null, status };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { ok: false, why: e.message };
  }
}

/**
 * Is this red inherited from the base, or caused here? A gate that cannot tell
 * either blocks forever or merges over everything.
 */
export function inheritedOrCaused(nwo, baseBranch, rawNames) {
  // A falsy name cannot be reported to a fixer and must not travel further. This
  // surfaced twice as a decision reading "failing: undefined", and patching where
  // it appeared did not stop it, so the read itself is removed here.
  const failingNames = (rawNames ?? []).filter(n => typeof n === "string" && n.length > 0);
  const dropped = (rawNames ?? []).length - failingNames.length;
  const base = pinHead(nwo, baseBranch);
  if (!base.ok) return { verdict: "UNKNOWN", why: base.why };
  const { rows, ok } = readChecks(nwo, base.sha);
  if (!ok) return { verdict: "UNKNOWN", why: "could not read base checks" };
  const baseFailing = new Set(rows.filter(r => r.state === "completed" && !PASSING.has(String(r.conclusion))).map(r => r.name));
  const inherited = failingNames.filter(n => baseFailing.has(n));
  const caused = failingNames.filter(n => !baseFailing.has(n));
  return { verdict: caused.length ? "CAUSED" : "INHERITED", inherited, caused, baseSha: base.sha, dropped };
}
