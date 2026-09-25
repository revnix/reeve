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
/**
 * Passing, and yet not a pass: a skipped check didn't run, and a neutral one
 * didn't judge. GitHub counts both as passing a required check, so a test job
 * that a broken `if:` skips, or whose `needs:` failed, passes the gate. For a
 * check nothing requires, a path filter's skip is what was meant, and it passes.
 */
const NOT_RUN = new Set(["skipped", "neutral"]);
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
  // A paged read of a busy head runs past the default 1 MiB, and a read cut
  // short there must not be taken for the whole list.
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim() }; }
  catch (e) { return { ok: false, out: "", err: String(e.stderr || e.message).trim() }; }
}
const gh = (path, jq, { paginate = false } = {}) => {
  const a = ["api", ...(paginate ? ["--paginate"] : []), path];
  if (jq) a.push("--jq", jq);
  return sh("gh", a);
};

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
 * reeve's own verdict check, and the App that publishes it. Defined here, at the
 * lowest layer that reads checks, so the exclusion below cannot be forgotten by a
 * caller and every consumer of readChecks inherits it.
 */
export const POLICY_CONTEXT = "ops/merge-policy";
export const POLICY_APP = "merge-policy";

/**
 * What counts as a check, versioned.
 *
 * The settlement floor is a high-water mark of how many checks a revision has
 * reported, and it is only meaningful against a FIXED notion of what a check is.
 * Excluding reeve's own policy row dropped every head's count by exactly one --
 * measured live: five open PRs, every one of them one short of its stored floor
 * -- so no revision could ever reach it again and every pull request would have
 * blocked forever.
 *
 * Bump this whenever the set of things counted changes. A stored floor recorded
 * under an older number is discarded rather than compared against.
 */
export const CHECK_ACCOUNTING = 4;
// 3: reviewer commit-status contexts (ci.reviewerStatusContexts) left the counted
//    set. Measured the moment it shipped -- nextly #1011 read "only 34 checks
//    reported where 35 were expected" against a floor stored under accounting 2,
//    which is the same shape as the policy-exclusion incident this counter was
//    added for. Changing what counts REQUIRES bumping this, and the number is the
//    only thing standing between an exclusion and every PR stuck forever.
// 4: check runs and statuses are read past their first page. Statuses came 30
//    to a page and runs 100, so a head with more counts them all from here on.

/**
 * Remove reeve's own opinion from the evidence.
 *
 * A verdict published at a head is a CONCLUSION about that head, so reading it
 * back as an input makes the gate an input to itself. In shadow the conclusion is
 * `neutral` and classifies as passing, which hides the problem; under --enforce a
 * BLOCK publishes `failure` and the next tick reads it as a red check, so reeve
 * keeps failing the PR long after the original cause has cleared.
 *
 * Matched on the exact name OR on the publishing App, because anything reeve
 * publishes is its own opinion whatever it happens to be called. A check wearing
 * the policy name from some OTHER App is not evidence either, but it is returned
 * separately: something impersonating the gate is worth saying out loud rather
 * than quietly discarding.
 */
export function excludeOwnPolicy(rows, context = POLICY_CONTEXT, app = POLICY_APP) {
  const rest = [], excluded = [], impostors = [];
  for (const r of rows) {
    const mine = r.app === app;
    const named = r.name === context;
    if (!mine && !named) { rest.push(r); continue; }
    excluded.push(r);
    if (named && !mine) impostors.push(r);
  }
  return { rows: rest, excluded, impostors };
}

/**
 * A reviewer's commit status is not CI evidence, whatever it says.
 *
 * CodeRabbit reports state=success with the truth in the description -- measured
 * on 8 of 9 sampled final heads as "Review rate limited", and in a second shape
 * as "Review completed" for a path-filter SKIP that reviewed no file at all. The
 * description was carried here precisely because the truth hides in it, and
 * nothing downstream ever read it, so a rate-limited reviewer counted as a
 * passing check.
 *
 * Reading the description would be a third guess at a string the vendor is free
 * to change. The honest rule is categorical: a reviewer's status belongs to the
 * REVIEW pipeline, which knows how to say "refused" and "absent", and never to
 * check classification, which only knows how to say "passing".
 */
export function excludeReviewerContexts(rows, contexts = []) {
  if (!contexts.length) return { rows, reviewerRows: [] };
  const set = new Set(contexts);
  const rest = [], reviewerRows = [];
  for (const r of rows) (set.has(r.name) ? reviewerRows : rest).push(r);
  return { rows: rest, reviewerRows };
}

/**
 * Every check at a SHA, from both surfaces. Returns rows normalised to
 * {name, source, state, conclusion, id}. `state` is "completed" or "running".
 *
 * `reviewerContexts` comes from the profile. It is applied HERE, beside the
 * own-policy exclusion and for the same reason: the base head is read through
 * this same function, and a caller that forgot would reintroduce the fail-open
 * silently. test/reviewer-status.test.mjs asserts every call site supplies it.
 */
export function readChecks(nwo, sha, { reviewerContexts = [] } = {}) {
  const rows = [];
  // JSON, not TSV. A commit-status description may contain a newline or a tab,
  // and a TSV parse then splits it into a phantom row whose "name" is a fragment
  // of the description and whose conclusion is undefined — which classifies as a
  // failure and reports "failing: undefined" to the fixer.
  //
  // Every page, one JSON value per line. A page holds 100 runs, and statuses
  // came 30 to a page, so a check past the first page went unread. A surface
  // counts as read only when every line of every page was.
  const parse = (r, fn) => {
    if (!r.ok) return false;
    for (const line of r.out.split("\n").filter(Boolean)) {
      let item; try { item = JSON.parse(line); } catch { return false; }
      const row = fn(item); if (row && row.name) rows.push(row);
    }
    return true;
  };
  const cr = gh(`repos/${nwo}/commits/${sha}/check-runs?per_page=100&filter=latest`, ".check_runs[]", { paginate: true });
  const crRead = parse(cr, c => ({
    name: c.name, source: "check_run",
    state: c.status === "completed" ? "completed" : "running",
    conclusion: c.conclusion || null, id: c.id != null ? String(c.id) : null,
    // Carried so reeve can recognise its OWN check and refuse to treat it as
    // evidence. Excluding by name alone would miss anything else it publishes.
    app: c.app?.slug ?? null,
    // And the id, which is what a required check bound to an App names.
    appId: c.app?.id != null ? String(c.app.id) : null,
    // When it finished: GitHub accepts a required check's pass for seven days.
    completedAt: c.completed_at ?? null,
  }));
  const st = gh(`repos/${nwo}/commits/${sha}/status?per_page=100`, ".statuses[]", { paginate: true });
  const stRead = parse(st, x => ({
    // A StatusContext has .state and no .conclusion. "pending" is in flight.
    name: x.context, source: "status",
    state: x.state === "pending" ? "running" : "completed",
    conclusion: x.state === "pending" ? null : x.state,
    // A rate-limited CodeRabbit reports state=success with the truth relegated
    // here, so the description is carried rather than discarded.
    description: x.description ?? "",
    completedAt: x.updated_at ?? x.created_at ?? null,
  }));
  // Filtered HERE rather than by each caller: the base head is read through this
  // same function, and a caller that forgot would reintroduce the latch silently.
  const own = excludeOwnPolicy(rows);
  // Reviewer rows are RETURNED, never dropped: the review pipeline reads them as
  // evidence about the reviewer, and a signal that vanishes cannot be reported.
  const rev = excludeReviewerContexts(own.rows, reviewerContexts);
  // `ok` only when both surfaces were read in full. Every result under a check's
  // name must pass, and a failing one on a surface that went unread would leave
  // the rest passing: with statuses unread, a failing status beside passing
  // check runs read as green.
  const ok = crRead && stRead;
  return { ok, rows: rev.rows, reviewerRows: rev.reviewerRows,
           excluded: own.excluded, impostors: own.impostors,
           why: ok ? null : !crRead ? (cr.err || "check runs couldn't be parsed") : (st.err || "statuses couldn't be parsed") };
}

/**
 * Classify a set of check rows. Never returns "green" on absence.
 *
 * A required check is a name, or `{ context, app }` when it is bound to an App:
 * then only that App's check runs meet it, and a commit status under the name,
 * which names no App reeve can read, leaves it unknown.
 *
 * `evidence` asks whether the rows show a pass, as a head's must. Then a
 * required check that was skipped or neutral never passed, and a set where
 * nothing ran shows nothing. A base is judged for health instead, which only
 * its failures decide, so it asks without. `requiredKnown` is false when the
 * base's own requirements couldn't be read: then nothing reads green, since a
 * requirement unread may be one no row meets.
 */
export function classify(allRows, requiredChecks = [], { requiredKnown = true, evidence = true } = {}) {
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
  const required = requiredChecks.map(c => (typeof c === "string" ? { context: c, app: null }
    : { context: c.context, app: c.app == null ? null : String(c.app), ...(c.origin ? { origin: c.origin } : {}) }));
  const requiredNames = new Set(required.map(c => c.context));
  const named = (c) => rows.filter(r => r.name === c.context);
  const meeting = (c) => (c.app == null ? named(c) : named(c).filter(r => r.source === "check_run" && String(r.appId) === c.app));
  const label = (c) => (c.app == null ? c.context : `${c.context} from App ${c.app}`);
  const notRun = (results) => results.length > 0 && results.every(r => r.state === "completed" && NOT_RUN.has(String(r.conclusion)));

  // A failure, or a check in flight, comes before what hasn't reported: a
  // required check may be waiting on the very job that failed, or is running.
  if (failing.length) return { verdict: "RED", why: `${failing.length} check(s) not passing`, failing, running, malformed };
  if (running.length) return { verdict: "RUNNING", why: `${running.length} check(s) still in flight`, failing, running, malformed };
  const unreadable = required.filter(c => c.app != null && !meeting(c).length && named(c).some(r => r.source !== "check_run"));
  if (unreadable.length) return { verdict: "UNKNOWN", failing: [], running: [], malformed,
    why: `required check(s) bound to an App and reported only by a commit status, which names no App: ${unreadable.map(label).join(", ")}` };
  const missing = required.filter(c => !meeting(c).length);
  if (missing.length) return { verdict: "MISSING_REQUIRED", why: `required check(s) never reported: ${missing.map(label).join(", ")}`,
    failing, running, missing: missing.map(c => c.context), missingChecks: missing, malformed };
  // A required job skipped because the job it needs failed was RED above, the
  // failure's to fix. One skipped with nothing failing is terminal evidence,
  // and settles at once.
  const skipped = evidence ? required.filter(c => notRun(meeting(c))) : [];
  if (skipped.length) return { verdict: "SKIPPED_REQUIRED", why: `required check(s) skipped or neutral, so they never reported a pass: ${skipped.map(label).join(", ")}`,
    failing, running, skipped: skipped.map(c => c.context), malformed };
  // Green needs the whole required set: a requirement unread may be one no row
  // meets, reeve's own shadow check say, which GitHub passes on reeve's neutral.
  const green = (result) => (evidence && !requiredKnown ? { verdict: "UNKNOWN", failing: [], running: [], malformed,
    why: "the base's required checks couldn't be read, so whether each one passed can't be told" } : result);
  // A head where nothing ran has no evidence at all, however many rows say so.
  if (evidence && rows.every(r => NOT_RUN.has(String(r.conclusion)) || UNINFORMATIVE.has(String(r.conclusion))))
    return { verdict: "UNKNOWN", failing: [], running: [], malformed, why: "no check ran at this revision: every one was skipped, neutral, cancelled or stale" };
  // A cancelled or stale run is a SUPERSEDED run, and superseding is normal: a new
  // push cancels the old workflow. What matters is whether the superseded thing was
  // one the gate requires.
  //
  // Measured live: nextlyhq/nextly main had both required checks green and one
  // non-required job cancelled, and that single row made the whole branch
  // UNKNOWN -- which blocked all five open pull requests for hours through the
  // base clause. An obsolete job nobody requires cannot be allowed to veto forever.
  //
  // Where NO required set is declared, reeve has no basis to call anything
  // ancillary, so every cancellation still refuses. Fail closed where the profile
  // is silent.
  if (uninformative.length) {
    // Only a row that could have met a requirement: its name, and its App where
    // the requirement is bound to one.
    const blocking = requiredNames.size
      ? uninformative.filter(r => required.some(c => c.context === r.name && (c.app == null || (r.source === "check_run" && String(r.appId) === c.app))))
      : uninformative;
    if (blocking.length) return {
      verdict: "UNKNOWN", failing: [], running: [], uninformative: blocking,
      why: `${blocking.length} required check(s) cancelled or stale — superseded, not failed`,
    };
    // Reported rather than dropped: it is still worth seeing that a job was
    // cancelled, it simply is not a reason to refuse a merge.
    if (malformed) return { verdict: "UNKNOWN", failing: [], running: [], malformed, ancillaryUninformative: uninformative,
      why: `${malformed} check row(s) could not be parsed, so this revision is not checkable` };
    return green({ verdict: "GREEN", failing: [], running: [], ancillaryUninformative: uninformative,
      why: `${rows.length - uninformative.length} required and ancillary check(s) passing; ${uninformative.length} ancillary cancelled or stale` });
  }
  if (malformed) return { verdict: "UNKNOWN", failing: [], running: [], malformed, why: `${malformed} check row(s) could not be parsed, so this revision is not checkable` };
  return green({ verdict: "GREEN", why: `${rows.length} check(s) all passing`, failing: [], running: [], malformed });
}


/**
 * Has the CI provider finished everything it was going to do at this revision?
 *
 * Scoped to the provider's own App on purpose. Measured at one live head: all 13
 * `github-actions` suites reached `completed`, while the `coderabbitai`,
 * `greptile-apps` and `vercel` suites sat at `queued` with zero runs
 * indefinitely. Waiting for every suite therefore never terminates, and a gate
 * that never terminates is a gate that blocks forever.
 *
 * Returns null when the question cannot be asked. Null is not false and it is not
 * true: it means the caller has no basis to conclude anything.
 */
export function suitesComplete(nwo, sha, { app = "github-actions", appId = null } = {}) {
  const r = gh(`repos/${nwo}/commits/${sha}/check-suites?per_page=100`, ".check_suites");
  if (!r.ok || !r.out) return null;
  let suites; try { suites = JSON.parse(r.out); } catch { return null; }
  // By the App's id where a requirement is bound to one, and otherwise by the
  // provider's name.
  const mine = suites.filter(s => (appId != null ? String(s.app?.id) === String(appId) : (s.app?.slug ?? null) === app));
  // No suite at all from the provider is not "finished": on a repository with CI
  // it means nothing has been created yet, which is the very state being waited on.
  if (!mine.length) return false;
  return mine.every(s => s.status === "completed");
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
  // The floor guards against a set that has not finished SCHEDULING: within one
  // revision, jobs are added and never removed, so a count below the highest seen
  // means something has yet to report. Across revisions it means nothing -- path
  // filters make a different head run a legitimately different set -- and
  // carrying it made a PR whose new head runs fewer workflows permanently
  // unsettleable. It resets with the head.
  const sameHead = Boolean(prior) && prior.sha === reading.sha;
  const floor = sameHead ? (prior.floor ?? 0) : 0;
  const same = sameHead && prior.key === key;
  // The streak counts green readings in a row, and only those: a red or
  // skipped reading, or one below the floor, starts it again. A job rerun after
  // a skip then needs its own three green looks, not the skip's.
  const counted = reading.verdict === "GREEN" && names.length >= floor;
  const streak = counted ? (same ? (prior.streak ?? 0) + 1 : 1) : 0;
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
  // A required check that was skipped is present evidence too: it ran to its
  // end, and waiting on the provider's other suites won't change it.
  if (reading.verdict === "RED" || reading.verdict === "SKIPPED_REQUIRED")
    return { ...next, settled: true, verdict: reading.verdict, why: reading.why };
  // A required check that has not appeared is an ABSENCE, and an absence needs a
  // REASON to be believed rather than a number of looks. Counting was measured to
  // be wrong on the one real case: #1127's checks arrived 698 seconds after the
  // first reading, while three observations settle at 352 -- so a count still
  // pages a human almost six minutes early.
  //
  // What terminates is the CI provider's own check-suites. `suitesComplete` is
  // true only when every suite belonging to the provider has completed, and it is
  // null when the question could not be asked -- which is not an answer, so it
  // does not settle either. Terminal evidence needs no corroboration, so one
  // reading of a finished provider is enough.
  if (reading.verdict === "MISSING_REQUIRED")
    return { ...next, settled: reading.suitesComplete === true, verdict: reading.verdict, why: reading.why };
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
export function inheritedOrCaused(nwo, baseBranch, failingRows, io = {}) {
  const { maxProbes = 3 } = io;
  const pinBase = io.pinBase ?? (() => pinHead(nwo, baseBranch));
  const readBase = io.readBase ?? (sha => readChecks(nwo, sha, { reviewerContexts: io.reviewerContexts ?? [] }));
  // Injected rather than imported: ci-rootcause imports from here, and resolving
  // a cause is the expensive half, so it must be substitutable in a test.
  const resolveCause = io.resolveCause ?? null;

  // Accepts rows; a bare name still works, it simply cannot be cause-compared.
  const rows = (failingRows ?? []).map(x => (typeof x === "string" ? { name: x, id: null } : x));
  // A falsy name cannot be reported to a fixer and must not travel further. This
  // surfaced twice as a decision reading "failing: undefined", and patching where
  // it appeared did not stop it, so the read itself is removed here.
  const named = rows.filter(r => r && typeof r.name === "string" && r.name.length > 0);
  const dropped = rows.length - named.length;

  const base = pinBase();
  if (!base.ok) return { verdict: "UNKNOWN", why: base.why, dropped };
  const read = readBase(base.sha);
  // A read that isn't whole still shows the base failures it did read, and a
  // failure seen there is one. What it didn't read may hold the rest, so a head
  // failure with no twin among them stays unverified rather than caused.
  if (!read.ok && !(read.rows ?? []).length) return { verdict: "UNKNOWN", why: "could not read base checks", dropped };
  const partial = !read.ok;

  const baseFailing = new Map();
  for (const r of read.rows ?? [])
    if (r.state === "completed" && !PASSING.has(String(r.conclusion))) baseFailing.set(r.name, r);

  const inherited = [], caused = [], unverified = [];
  let probes = 0;

  for (const row of named) {
    const twin = baseFailing.get(row.name);
    // The cheap filter: a name that is not failing on the base at all cannot have
    // been inherited from it, and needs no probe.
    if (!twin) { (partial ? unverified : caused).push(row.name); continue; }

    // A shared NAME is not a shared failure. One job runs many tests, so the same
    // job can fail on the base and on the PR for entirely unrelated reasons —
    // and calling that "inherited" leaves a real regression unfixed.
    if (!resolveCause || probes >= maxProbes) { unverified.push(row.name); continue; }
    probes++;
    const a = resolveCause(nwo, row), b = resolveCause(nwo, twin);
    if (!a?.ok || !b?.ok) { unverified.push(row.name); continue; }
    (sameCause(a, b) ? inherited : caused).push(row.name);
  }

  // Neither guess is safe: a false INHERITED leaves a regression unfixed, and a
  // false CAUSED sends a worker to repair the base's problem inside a feature PR,
  // which hides where it came from. Anything unverified is reported as that.
  const verdict = unverified.length ? "UNVERIFIED" : caused.length ? "CAUSED" : "INHERITED";
  return { verdict, inherited, caused, unverified, baseSha: base.sha, dropped, probes };
}

/** Two failures are the same when the job, the step and the first messages agree. */
function sameCause(a, b) {
  const key = c => [c.job, c.step, ...(c.cause ?? []).slice(0, 2)
    .map(x => `${x.where ?? ""}|${String(x.message ?? "").slice(0, 120)}`)].join("::");
  return key(a) === key(b);
}

