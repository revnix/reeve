// @ts-check
// Gather everything a verdict needs about one PR, then publish it.
//
// Shadow mode is the default and it is not a debug flag. Flipping a gate against
// a baseline you have not measured blocks all work in flight at once, which is
// the moment a bypass gets reopened and the programme dies. In shadow the check
// publishes `neutral`, which GitHub renders but never blocks on, so a week of
// them says exactly what the gate WOULD have refused.

import { pinHead, readChecks, classify, settle, inheritedOrCaused, readTimeline, lastForcePush, suitesComplete } from "./github/reconciler.mjs";
import { loadSettlement, saveSettlement } from "./db/ops.mjs";
import { rootCause } from "./ci-rootcause.mjs";
import { computeVerdict, renderVerdict, coversHead, PASS, BLOCK, UNKNOWN } from "./verdict.mjs";
// The builder App's name has one home already; the classifier reads it rather
// than restating it.
import { POLICY_APP, POLICY_CONTEXT, LEGACY_CONTEXTS } from "./github/reconciler.mjs";
import { reviewState } from "./review/derive.mjs";
import { compare } from "./review/shadow.mjs";
import { authenticate, apiAsInstallation, loadAppCredentials } from "./github/app.mjs";
import { execFileSync } from "node:child_process";
import { netTimeoutMs, netFailure } from "./net-bound.mjs";
import { evidenceText, readEvidence, evidenceBehind } from "./published.mjs";

/**
 * The profile's CI settings, as far as this module reads them.
 * @typedef {{ ci?: { requiredChecks?: string[], reviewerStatusContexts?: string[], appSlug?: string } }} CiProfile
 */
/**
 * What a test passes to reviewFacts in place of its reads.
 * @typedef {{ reviewState?: typeof reviewState, compare?: typeof compare, foldPrecedesEvaluation?: boolean }} ReviewIo
 */

function ghJson(args) {
  try { return { ok: true, out: execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: netTimeoutMs(), killSignal: "SIGKILL" }).trim() }; }
  catch (e) { return { ok: false, out: "", err: netFailure(e) }; }
}

// The REVIEW surface rides along on the query that was already being made.
//
// `compare` measured threads only, which was right while nothing else gated. Now
// that a review BODY can hold a pull request, a body posted between the fold and
// this evaluation would leave the thread counts agreeing, the projection fresh by
// every clock, and its body facts a tick out of date.
//
// Counts rather than bodies, deliberately. Fetching every review body on every
// tick to hash it would be exact and would move real bandwidth for a window that
// is sub-second; the counts are already carried by this response for free. See
// `reviewsAgree` for what that does and does not catch.
const THREADS_QUERY = `query($o:String!,$r:String!,$n:Int!,$c:String){
  repository(owner:$o,name:$r){ pullRequest(number:$n){
    mergeStateStatus mergeable reviewDecision
    reviews(first:1){ totalCount }
    reviewThreads(first:100, after:$c){
      totalCount
      pageInfo{ hasNextPage endCursor }
      nodes{ isResolved isOutdated }
    } } } }`;

/**
 * Thread state, paginated to completion. A truncated read is NOT zero:
 * reviewThreads(first:100) has produced four consecutive false "zero unresolved"
 * reports, so `readable` is false unless every page was fetched.
 */
export function readThreads(nwo, pr, io = null) {
  // Injected for tests. The counts this returns feed the live cross-check, and
  // without a seam the only way to exercise them is a real GitHub — which is how
  // the review surface came to be carried by this function and asserted by
  // nothing.
  const call = io?.gh ?? ghJson;
  const [o, r] = nwo.split("/");
  let cursor = null, total = null, seen = 0, unresolved = 0, mergeState = null, pages = 0;
  let reviewTotal = null, mergeable = null, reviewDecision = null, partsReadable = true;
  for (;;) {
    const args = ["graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${o}`, "-F", `r=${r}`, "-F", `n=${pr}`];
    if (cursor) args.push("-F", `c=${cursor}`);
    const res = call(args);
    if (!res.ok) return { readable: false, why: res.err.split("\n")[0], mergeState };
    const parsed = JSON.parse(res.out);
    // An HTTP 200 can still carry errors for single fields, which then read as
    // null. A null review decision reads as "no review outstanding", so any error
    // makes the mergeability parts unknown rather than clear.
    if (parsed.errors?.length) partsReadable = false;
    const pr_ = parsed.data?.repository?.pullRequest;
    if (!pr_) return { readable: false, why: "no pullRequest in response", mergeState };
    mergeState = pr_.mergeStateStatus;
    mergeable = pr_.mergeable ?? null;
    reviewDecision = pr_.reviewDecision ?? null;
    // Read from the FIRST page only: it is a totalCount, identical on every page,
    // and re-reading it per page would just be the same number again.
    if (reviewTotal === null) reviewTotal = pr_.reviews?.totalCount ?? null;
    const t = pr_.reviewThreads;
    total = t.totalCount;
    seen += t.nodes.length;
    unresolved += t.nodes.filter(n => !n.isResolved).length;
    pages++;
    if (!t.pageInfo.hasNextPage || pages > 20) { cursor = null; break; }
    cursor = t.pageInfo.endCursor;
  }
  // Only claim readability when the count seen matches the count declared.
  return { readable: seen >= total, total, unresolved, seen, mergeState, reviewTotal, mergeable, reviewDecision, partsReadable };
}

/**
 * The pull requests queued to merge into `branch`, each with the commit the
 * queue built for it, which is the commit that merges. Measured in
 * docs/measured/2026-09-27-merge-queue.md. `sha` is null until the queue has
 * built the commit, and `prHead` is the pull request's head as this read found
 * it. `queue` is false for a branch with no queue. Not ok when the queue can't
 * be read.
 */
export function readMergeQueue(nwo, branch, { gh = ghJson } = {}) {
  const [owner, name] = String(nwo).split("/");
  const query = "query($owner:String!,$name:String!,$branch:String!,$after:String){repository(owner:$owner,name:$name){" +
    "mergeQueue(branch:$branch){entries(first:100,after:$after){pageInfo{hasNextPage endCursor} " +
    "nodes{state headCommit{oid} baseCommit{oid} pullRequest{number headRefOid}}}}}}";
  const entries = [];
  // Every page: an entry past the first hundred would go unanswered until the
  // queue dropped it at its timeout.
  for (let after = null, pages = 0; ; pages++) {
    if (pages >= 50) return { ok: false, why: "the merge queue ran past 50 pages" };
    const r = gh(["graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `branch=${branch}`,
                  ...(after ? ["-f", `after=${after}`] : [])]);
    if (!r.ok) return { ok: false, why: r.err || "the merge queue couldn't be read" };
    let got;
    try { got = JSON.parse(r.out); } catch { return { ok: false, why: "the merge queue's answer couldn't be parsed" }; }
    // An HTTP 200 can carry errors for single fields, which then read as null, as
    // in readThreads. A queue that read as null that way would look like none.
    if (got?.errors?.length) return { ok: false, why: `the merge queue's answer carried errors: ${got.errors[0]?.message ?? "unnamed"}` };
    const queue = got?.data?.repository?.mergeQueue;
    if (queue === undefined) return { ok: false, why: "the merge queue's answer had no repository in it" };
    if (queue === null) return { ok: true, queue: false, entries: [] };
    const nodes = queue.entries?.nodes;
    if (!Array.isArray(nodes)) return { ok: false, why: "the merge queue's answer had no entries" };
    for (const n of nodes) if (Number.isInteger(n?.pullRequest?.number))
      entries.push({ pr: n.pullRequest.number, sha: n.headCommit?.oid ?? null, baseSha: n.baseCommit?.oid ?? null, state: n.state ?? null,
                     prHead: n.pullRequest.headRefOid ?? null });
    const info = queue.entries.pageInfo;
    if (!info?.hasNextPage) break;
    if (!info.endCursor) return { ok: false, why: "the merge queue said there was more, and gave no cursor to read it" };
    after = info.endCursor;
  }
  return { ok: true, queue: true, entries };
}

/**
 * The verdict on the commit a merge queue built for a pull request (#163). The
 * queue merges that commit, not the pull request's head, and waits for its
 * required checks there, so a verdict at the head counts for nothing in the
 * queue.
 *
 * The pull request's own facts carry over from its evaluation this tick
 * (`input`): its reviews, threads, findings, hold and merge state. CI is read on
 * the queue's commit and settled apart from the head, under the queue's own key,
 * so neither resets the other. The base is judged at the queue's base commit.
 * Those facts carry over only while the queue holds the pull request at the head
 * they were read at: a push between the two reads would carry one revision's
 * reviews onto a commit built from another.
 */
export function evaluateQueueEntry({ nwo, entry, input, baseRef, profile, db = null,
                                     read = readChecks, requirements = requiredChecksOf, contains = baseContainedIn }) {
  if (!entry?.sha) return { ok: false, why: "the queue hasn't built its commit yet" };
  if (!input) return { ok: false, why: "the pull request wasn't evaluated this tick, so its facts can't carry over" };
  if (!entry.prHead || entry.prHead !== input.head)
    return { ok: false, why: entry.prHead ? `the queue holds the pull request at ${entry.prHead.slice(0, 10)}, not at ${String(input.head).slice(0, 10)}, which this tick judged`
                                          : "the queue didn't say which head of the pull request it holds" };
  const reviewerContexts = profile.ci?.reviewerStatusContexts ?? [];
  const got = read(nwo, entry.sha, { reviewerContexts });
  const req = requirements({ nwo, baseRef, profile });
  const c = classifyRead(got, req);
  const reading = { ...c, sha: entry.sha, rows: got?.rows ?? [],
    suitesComplete: c.verdict === "MISSING_REQUIRED" ? missingSettled(nwo, entry.sha, c.missingChecks, profile) : null };
  const key = `${nwo}@merge-queue`;
  const s = db ? saveSettlement(db, key, entry.pr, settle(loadSettlement(db, key, entry.pr), reading))
    : { ...settle(null, reading), settled: false, why: "settlement needs a state store to compare readings across ticks" };
  // For health, as evaluatePr judges the base: only failures on it count, of the checks that gate merges (#288).
  const health = { required: profile.ci?.requiredChecks ?? [], failuresOf: gatingOf(req) };
  const baseRead = entry.baseSha ? read(nwo, entry.baseSha, { reviewerContexts }) : null;
  const base = baseRead ? classifyRead(baseRead, health, { evidence: false })
    : { verdict: "UNKNOWN", readable: false, why: "the queue's base commit isn't known" };
  // Read, not assumed from how a queue builds its commit: only then can the queue's
  // commit repair a red base (#286). Asked only of a red one.
  const inHead = base.verdict === "RED" ? contains({ nwo, base: entry.baseSha, head: entry.sha }) : null;
  // A review of the pull request's head covers its queue commit, which carries
  // exactly that change onto the base: the queue builds the commit, no one
  // reviews it. Carried explicitly, with the commit the review covered, so the
  // record says what was reviewed. A review of any other commit still doesn't
  // count.
  const reviewers = (input.reviewers ?? []).map((r) => (coversHead(r.reviewedHead, input.head)
    ? { ...r, reviewedHead: entry.sha, coveredAt: r.reviewedHead } : r));
  const queued = { ...input, reviewers, head: entry.sha,
    checks: { verdict: s.verdict, settled: s.settled, why: s.why, readable: c.readable !== false, failing: c.failing, inherited: [],
              impostors: got?.impostors ?? [], shadowRequired: req.shadowRequired, legacyRequired: req.legacyRequired,
              passed: passedChecks(got?.rows) },
    base: baseHealthOf(base, { complete: baseRead?.ok === true, inHead }) };
  return { ok: true, input: queued, verdict: computeVerdict(queued) };
}

/**
 * The parts of GitHub's mergeability that reeve can read, for when
 * mergeStateStatus is BLOCKED and the verdict has to take it apart: whether the
 * branch conflicts, the review decision, whether reeve's own check is required on
 * the base, and everything else the base requires. The base is read only when
 * BLOCKED, the one state it explains, since it costs calls:
 *   others            each other required check, with its state at this head in
 *                     `rows`: passing, failing, running, superseded, expired,
 *                     missing, or unknown
 *   unresolvedBlocks  whether the base requires resolved conversations and one
 *                     isn't
 *   strict, behind    whether the base requires branches up to date, and how
 *                     many commits this head is behind it
 *   unevaluated       what the base requires that reeve doesn't evaluate
 *   settlesAlone      those of them a run settles without anyone
 * Each is null when it couldn't be told.
 */
export function readMergeParts(nwo, baseRef, threads, { gh = ghJson, context = POLICY_CONTEXT, appId = ownAppId(), rows = null, head = null } = {}) {
  const parts = { readable: threads?.partsReadable !== false, mergeable: threads?.mergeable ?? null,
                  reviewDecision: threads?.reviewDecision ?? null, ownCheckRequired: null,
                  others: null, unresolvedBlocks: null, strict: null, behind: null, unevaluated: null, settlesAlone: null };
  if (String(threads?.mergeState ?? "").toUpperCase() !== "BLOCKED" || !baseRef) return parts;
  const req = requirementsOnBase({ nwo, base: baseRef, context, gh, appId });
  parts.ownCheckRequired = req.own;
  parts.others = req.others && Array.isArray(rows) ? req.others.map((r) => ({ ...r, state: requiredCheckState(rows, r) })) : null;
  parts.unresolvedBlocks = req.threadResolution === null ? null
    : !req.threadResolution ? false
    : threads?.readable === false || !Number.isInteger(threads?.unresolved) ? null : threads.unresolved > 0;
  parts.unevaluated = req.unevaluated;
  parts.settlesAlone = req.settlesAlone;
  // A base that wants branches up to date blocks one that is behind, and
  // BLOCKED says nothing of which. How far behind is read only then.
  parts.strict = req.strict;
  if (req.strict && head) {
    const c = gh([`repos/${nwo}/compare/${encodeURIComponent(baseRef)}...${head}`, "--jq", ".behind_by"]);
    const n = c.ok ? Number(c.out.trim()) : NaN;
    parts.behind = Number.isInteger(n) && n >= 0 ? n : null;
  }
  return parts;
}

/**
 * The head's check rows for judging the base's other required checks: CI, the
 * reviewers' statuses, and other Apps' runs under reeve's name, since a
 * required check is met by whichever carries its name. Null unless both check
 * runs and statuses were read in full: every result under a name must pass, and
 * a failing one on a surface that went unread would leave the rest passing.
 */
export const mergeRows = (read) => (read?.ok ? [...read.rows, ...read.reviewerRows, ...read.impostors] : null);

// What passes a required check, as GitHub counts it.
const PASSING_RUN = new Set(["success", "neutral", "skipped"]);
// A run a newer one replaces: no answer yet, rather than a failure, as the CI
// clause reads it too.
const SUPERSEDED_RUN = new Set(["cancelled", "stale"]);
// GitHub accepts a required check's passing result for seven days after it
// completed, and holds the merge for a rerun after that.
const REQUIRED_RESULT_MS = 7 * 24 * 3600 * 1000;

/**
 * A required check's state among a head's check runs and statuses. One bound to
 * an App is met only by that App's run; a commit status names no App reeve can
 * read, so one standing in for a bound check is unknown. Every result under the
 * name must pass, since GitHub holds the merge for any of them: a passing status
 * beside a failing check run of the same name is failing.
 */
function requiredCheckState(rows, { context, app, besideOwn = false }, now = Date.now()) {
  const named = rows.filter((r) => r?.name === context);
  const candidates = app == null ? named : named.filter((r) => r.source === "check_run" && String(r.appId) === app);
  const passes = (r) => r.source === "status" ? r.conclusion === "success" : PASSING_RUN.has(r.conclusion);
  // Beside reeve's own check, no other result under its name is nothing more
  // outstanding; reeve's own results are never among the rows.
  if (!candidates.length) return besideOwn ? "passing" : app != null && named.some((r) => r.source !== "check_run") ? "unknown" : "missing";
  const superseded = (r) => r.source === "check_run" && SUPERSEDED_RUN.has(r.conclusion);
  if (candidates.some((r) => r.state === "completed" && !passes(r) && !superseded(r))) return "failing";
  if (candidates.some((r) => r.state !== "completed")) return "running";
  if (candidates.some(superseded)) return "superseded";
  // Passing, but too long ago to count, or at a time that can't be read.
  if (candidates.some((r) => !(now - Date.parse(r.completedAt) <= REQUIRED_RESULT_MS))) return "expired";
  return "passing";
}

/**
 * The checks a pull request's CI must include, as `{ context, app, origin }`:
 * those the profile names, and those its base's rules and protection require,
 * each with the App it's bound to and where it came from. Of the base's, reeve's
 * own check is aside, since its
 * rows are never evidence, and so are reviewers' statuses, which the review
 * clauses read. `known` is false when the base's couldn't be read.
 *
 * `legacyRequired` says the base requires a name reeve published under before
 * (`ops/merge-policy`), bound where reeve's App could meet it: its old results
 * there pass the rule whatever reeve finds now, so that's a rule to change, not
 * a check to meet (#242).
 *
 * `shadowRequired` says the base requires reeve's shadow check where reeve's
 * own result could meet the rule. That's no requirement to meet but one to
 * refuse: a shadow result never fails, so it passes the rule whatever reeve
 * found. A rule that binds the shadow check to another App is met only by that
 * App's run, and is required like any other check. `appId` is reeve's App, or
 * null when it can't be told, and then any binding may be reeve's.
 */
export function requiredChecksOf({ nwo, baseRef, profile = /** @type {CiProfile} */ ({}), requirements = requiredChecksOnBase, gh = ghJson,
                                 appId = ownAppId() }) {
  const base = baseRef ? requirements({ nwo, base: baseRef, gh }) : null;
  const shadow = shadowContextOf(POLICY_CONTEXT);
  const reviewers = new Set(profile.ci?.reviewerStatusContexts ?? []);
  const reeveCould = (c) => c.app == null || appId == null || String(c.app) === String(appId);
  const reeveMeets = (c) => c.context === shadow && reeveCould(c);
  const legacyMeets = (c) => LEGACY_CONTEXTS.includes(c.context) && reeveCould(c);
  // A reviewer's status is aside, but a check bound to an App under the same
  // name is a check run, and required like any other.
  const aside = (c) => c.context === POLICY_CONTEXT || reeveMeets(c) || legacyMeets(c) || (c.app == null && reviewers.has(c.context));
  // One entry per check. Where the profile and the base both name it, the base
  // wins: its requirement may be any App's, or bound to one, and settles only
  // when it reports. The profile's, bound to no App, is left out, as beside a
  // bound one it would take any App's run of that name for the base's (#290).
  const fromBase = (base ?? []).filter((c) => !aside(c)).map((c) => ({ ...c, origin: "base" }));
  const all = [...(profile.ci?.requiredChecks ?? []).flatMap((context) => {
                 const b = fromBase.filter((c) => c.context === context);
                 return b.length ? b : [{ context, app: null, origin: "profile" }];
               }),
               ...fromBase];
  const required = all.filter((c, i) => all.findIndex((d) => d.context === c.context && d.app === c.app) === i);
  return { required, known: Array.isArray(base), shadowRequired: (base ?? []).some(reeveMeets), legacyRequired: (base ?? []).some(legacyMeets) };
}

/**
 * A check read, classified against the required set. A read that isn't whole
 * passes nothing, since the surface that went unread may hold a failure, and
 * says so with `readable: false`; but a failure it did read is one, and stays RED.
 */
export function classifyRead(read, { required = [], known = true, queueOnly = [], failuresOf = null } = {}, { evidence = true } = {}) {
  const c = classify(read?.rows ?? [], required, { requiredKnown: known, evidence, queueOnly, failuresOf });
  // Checks judged while the base's requirements couldn't be read are read again,
  // whatever else left them unknown, no check reported yet say: only reading
  // the requirements again settles them.
  if (read?.ok && evidence && !known && c.verdict === "UNKNOWN") return { ...c, readable: false };
  if (read?.ok || c.verdict === "RED") return c;
  return { verdict: "UNKNOWN", readable: false, failing: [], running: [], why: `the checks couldn't be read in full: ${read?.why ?? "nothing was read"}` };
}

/**
 * Whether the Apps that a head's missing required checks wait on have finished
 * there: the App a requirement is bound to, or the profile's CI provider for one
 * that isn't. True only when every one has, and null when one couldn't be
 * asked. A third-party App that hasn't scheduled its run yet isn't finished
 * because GitHub Actions is.
 */
export function missingSettled(nwo, sha, missing = [], profile = /** @type {CiProfile} */ ({}), suites = suitesComplete) {
  // An unbound check the base requires may come from any App, or be a commit
  // status from none, so no suite can say it has finished: its absence stays
  // unsettled until it reports.
  if (missing.some((c) => c?.app == null && c?.origin === "base")) return false;
  let all = true;
  for (const app of new Set(missing.length ? missing.map((c) => c?.app ?? null) : [null])) {
    const done = app == null ? suites(nwo, sha, { app: profile.ci?.appSlug ?? "github-actions" }) : suites(nwo, sha, { appId: app });
    if (done === null) return null;
    if (!done) all = false;
  }
  return all;
}

/** reeve's own App id, from its credentials, or null when there are none. */
function ownAppId() {
  const c = loadAppCredentials();
  return c.ok ? c.appId : null;
}

/**
 * Reviewer state at a head. Four states, never two. A refusal is ABSENT, and a
 * declared-but-never-seen reviewer is NOT_INSTALLED rather than silently clean.
 */
/**
 * The revision a clean-pass comment names, when the profile declares no pattern.
 * Codex-shaped, and a DEFAULT rather than a rule: a reviewer whose wording differs
 * sets `commitPattern`. Named here so the core carries one reviewer-shaped string
 * in one place instead of inline in a matcher.
 */
const CLEAN_COMMIT = "Reviewed commit:\\**\\s*`?([0-9a-f]{7,40})`?";

export function readReviewerStates(nwo, pr, head, reviewers, io = null) {
  // Injected for tests: classifying a reviewer is pure once the rows are in hand,
  // and every branch here was previously reachable only with a live GitHub.
  let cRows, rRows;
  // `io.rows` supplies parsed rows and skips the network entirely, which is how
  // the CLASSIFICATION is tested. `io.gh` replaces only the runner, which is how
  // the READ is tested — the two need different seams because they are different
  // questions, and the pagination defect lived in the half the first one skips.
  const run = io?.gh ?? ghJson;
  if (io && !io.gh) {
    cRows = io.comments ?? [];
    rRows = io.reviews ?? [];
  } else {
    // `--paginate`, because `per_page=100` is a page SIZE and not a promise that
    // one page is all of it. A pull request passes 100 review objects easily:
    // every inline reply mints a 0-byte COMMENTED review, nine at one commit on
    // nextly #1124, so review objects outrun real rounds by an order of magnitude.
    //
    // Without it the fold could see and apply a current-head clean round from page
    // two while this read still showed coverage as stale — so reeve would ask for
    // a review it had already received and could never observe, for ever.
    //
    // `--jq` is applied per page and the results concatenate, which is exactly
    // right for line-oriented tsv. gh has no page cap, so this is unbounded where
    // the ingest reader stops at twenty; that difference is recorded rather than
    // reconciled here, because two pagination mechanisms is a design question and
    // not a line in this function.
    const comments = run(["--paginate", `repos/${nwo}/issues/${pr}/comments?per_page=100`, "--jq",
      '.[] | [.user.login, (.created_at), (.body|gsub("\n";" "))] | @tsv']);
    const reviews = run(["--paginate", `repos/${nwo}/pulls/${pr}/reviews?per_page=100`, "--jq",
      '.[] | [.user.login, (.commit_id // ""), (.state), (.body|gsub("\n";" "))] | @tsv']);
    cRows = comments.ok ? comments.out.split("\n").filter(Boolean).map(l => l.split("\t")) : [];
    rRows = reviews.ok ? reviews.out.split("\n").filter(Boolean).map(l => l.split("\t")) : [];
  }

  return reviewers.map(rev => {
    const mine = l => String(l).toLowerCase().includes(rev.login.toLowerCase());
    const myComments = cRows.filter(([l]) => mine(l));
    const myReviews = rRows.filter(([l]) => mine(l));
    // NOT_INSTALLED, which the verdict consumes and this function never produced:
    // a rostered reviewer that has said NOTHING on a PR with review activity from
    // others is not "not yet run", it is absent, and absent must reach
    // REVIEWERS_DOWN rather than wait forever. Silence on a PR nobody has reviewed
    // is genuinely just early, so the distinction is whether ANYONE answered.
    if (!myComments.length && !myReviews.length) {
      const anyoneAnswered = rRows.length > 0 || cRows.length > 0;
      return anyoneAnswered
        ? { ...rev, state: "NOT_INSTALLED", reviewedHead: null,
            detail: "rostered but silent while other reviewers answered" }
        : { ...rev, state: "NOT_RUN", reviewedHead: null };
    }

    // A refusal anywhere in the window counts, not only as the last word. Reading
    // only the most recent comment made a refusal invisible the moment the same
    // reviewer said anything after it -- and both bots comment constantly. A
    // refusal is superseded only by a SUBSTANTIVE answer: one that names a
    // revision, which is the same evidence coverage requires.
    if (rev.refusal) {
      const rx = new RegExp(rev.refusal, "i");
      const lastRefusalAt = myComments.reduce((at, c, i) => (rx.test(c[2]) ? i : at), -1);
      if (lastRefusalAt >= 0) {
        const namedAfter = myComments.slice(lastRefusalAt + 1)
          .some(([, , body]) => new RegExp(rev.commitPattern ?? CLEAN_COMMIT, "i").test(body));
        const reviewedAfter = myReviews.some(([, sha]) => sha);
        if (!namedAfter && !reviewedAfter) {
          return { ...rev, state: "REFUSED", reviewedHead: null, detail: "quota or rate limit" };
        }
      }
    }
    // Findings carry the full sha on the review object; a clean pass names an
    // abbreviated sha in the comment body and files no review object at all.
    const withSha = myReviews.filter(([, sha]) => sha);
    if (withSha.length) return { ...rev, state: "VERDICT", reviewedHead: withSha.at(-1)[1] };
    const rx = new RegExp(rev.commitPattern ?? CLEAN_COMMIT, "i");
    const named = myComments.map(([, , body]) => body.match(rx)?.[1]).filter(Boolean);
    if (named.length) return { ...rev, state: "CLEAN", reviewedHead: named.at(-1) };
    return { ...rev, state: "NOT_RUN", reviewedHead: null, detail: "commented without naming a revision" };
  });
}

/** Everything, for one PR, at one pinned head. */
/**
 * What the derived review projection says about ONE revision, or nothing at all.
 *
 * Extracted so the rule can be exercised without a network. `evaluatePr` reaches
 * GitHub half a dozen times before it gets here, and a decision this consequential
 * -- it is what licenses spilling a finding, and what a worker is handed when it
 * is sent at review threads -- should not be reachable in a test only through six
 * mocked API calls. A test that expensive to write is a test that does not get
 * written for the branches that matter.
 *
 * Every failure is UNKNOWN and never an empty answer, because the two are read
 * differently downstream: the watcher spills only on a KNOWN zero, so null is
 * refusal and 0 is permission. No store, an unreadable store, a projection that
 * is stale, incomplete, differently classified or derived for another revision --
 * all of them null.
 */
export function reviewFacts({ db, nwo, pr, profile, head, live = null,
                             at = Math.floor(Date.now() / 1000), io = /** @type {ReviewIo} */ ({}) }) {
  // NOBODY TO GATE means nothing to be unknown about. With no blocking reviewer
  // configured, no uncleared thread can hold a pull request -- so a transient
  // projection failure must not produce an UNKNOWN clearance clause and stop an
  // otherwise passing pull request. The scoping that decides whose silence counts
  // has to apply to the unreadable path too, or it is only half applied.
  const gating = (profile?.reviewers ?? []).some(r => r.kind === "blocking");
  const unknown = why => ({ unspilledCritical: null, rounds: null, threadDetails: null,
                            cleared: gating ? { readable: false, why }
                                            : { readable: true, uncleared: 0, reviewers: [] },
                            blockingCritical: null,
                            bodyFindings: gating ? { readable: false, why }
                                                 : { readable: true, open: 0, reviewers: [] },
                            // NOT gated on there being a blocking reviewer. Whether
                            // reeve could read what a reviewer wrote is not a
                            // question about whose opinion counts, so an
                            // unreadable projection leaves it unknown either way.
                            unreadableBodies: { readable: false, why },
                            projection: { readable: false, why } });
  if (!db) return unknown("no state database");
  let st;
  // A store that THROWS is the case most likely to be handled by accident. It
  // arrives here as an exception rather than a false `readable`, so without this
  // it would leave `unspilledCritical` at whatever the caller had -- and the
  // caller's convenient default is the number that licenses a spill.
  // The clock is passed IN. Staleness is decided here, so a caller that freezes
  // time to test the honest-versus-convenient answer has to be able to reach it --
  // and the tick that reads this already has one clock of its own.
  try { st = (io.reviewState ?? reviewState)(db, nwo, pr, profile, { head, at }); }
  catch (e) { return unknown(`projection could not be read — ${e.message}`); }
  if (!st?.readable) return unknown(st?.why ?? "not derived");

  // AGREEMENT WITH THE LIVE READ, and the head check is not a substitute for it.
  //
  // The daemon evaluates a pull request BEFORE it observes, ingests and folds, so
  // the projection read here was derived from the previous tick's observation.
  // When review activity changes without the head changing -- a reviewer opens a
  // new thread on the same revision, which is the ordinary case -- the head check
  // passes, the projection is fresh by every clock, and its content is a tick out
  // of date. A newly filed critical would then sit behind `unspilledCritical: 0`.
  //
  // The live thread read this evaluation already holds is the cross-check, and
  // `compare` is the same function the review shadow has been running against
  // this projection for days. The shadow was measuring exactly this and the
  // decision path was not consulting it.
  //
  // An unreadable live read is not agreement. It is another way of not knowing,
  // and the honest answer to not knowing is the same as everywhere else here.
  const agreement = (io.compare ?? compare)(live, { ...st, readable: true });
  if (!agreement.comparable) return unknown(`no live read to check the projection against: ${agreement.why}`);
  if (!agreement.agree) return unknown(`the projection disagrees with the live read: ${agreement.why}`);

  // The ROUND COUNT comes from the projection too, and dropping it made the rest
  // pointless. `judged.size` counts distinct heads across the LATEST state per
  // reviewer, so a single-reviewer pull request stays at one however many rounds
  // it has had -- and with a soft cap of five, no decision gated on the cap could
  // ever be reached. Carrying the count without carrying the criticals, or the
  // other way round, wires up half a rule.
  // WHAT IS HANDED ON, and what is withheld until it can be trusted.
  //
  // Three things could come out of the projection, each gated on a different
  // precondition. Stating them separately is the point: an answer withheld for a
  // written reason is a different thing from one that is simply absent, which is
  // what the hard-coded null used to be.
  //
  // ROUNDS is safe now. It counts distinct reviewed revisions and depends on no
  // thread's content, so a tick of lag cannot make it wrong in a direction that
  // matters -- it lags DOWNWARD, and a cap not yet reached is the conservative
  // side of every decision it feeds.
  //
  // THE CRITICAL COUNT waits on the fold learning to classify review BODIES. The
  // fold reads severity from thread rows only, so a P0 stated in a body with no
  // inline thread is invisible, and a known zero is precisely what licenses SPILL.
  // Spilling a critical is the single thing the standing ruling forbids outright,
  // so a zero that might be missing one is worse than no answer.
  //
  // THE THREAD DETAILS wait on the tick being REORDERED. The daemon evaluates
  // before it observes and folds, so these are a tick old -- and the count
  // cross-check above cannot see the difference, because a reviewer EDITING a
  // thread in place changes no total, no resolved count and no open count. A
  // worker dispatched with a superseded excerpt would modify code against a
  // request that has been withdrawn, and that is worse than the empty list it
  // gets today: an empty list makes a worker go and look, a stale one makes it
  // act. Comparing aggregates catches things appearing and disappearing, never
  // things changing in place, and no amount of further counting fixes that.
  const bodies = st.bodyFindingsDerived === true;
  const fresh = io.foldPrecedesEvaluation === true;
  // UNCLEARED THREADS, scoped to the reviewers whose opinion gates a merge.
  //
  // "Resolved" and "cleared" answer different questions and the difference is the
  // reason the fold exists. Resolved is a CLAIM: the bot resolves its own threads
  // -- measured, eight on one pull request with nobody replying -- and
  // `@coderabbitai resolve` is author-invokable and bulk-resolves. Cleared is
  // EVIDENCE: a later substantive round by the same reviewer, at this head, has
  // been and gone. The verdict has been reading the claim.
  //
  // Scoped to BLOCKING reviewers, and that is not a detail. An advisory reviewer
  // that files a thread and never returns leaves it uncleared forever, so gating
  // on every reviewer would block every pull request permanently the first time
  // one of them went quiet. Blocking-ness is what says whose silence counts,
  // which is the same rule the `review` clause already applies to coverage.
  const blockingLogins = new Set((profile?.reviewers ?? [])
    .filter(r => r.kind === "blocking").map(r => r.login));
  // THREADS only. A body finding has no thread, so counting one here would answer
  // "has a reviewer come back to what it filed" with a population that has nothing
  // to come back TO -- and it would put the two kinds behind one number again,
  // which is the conflation the clause below exists to undo.
  const uncleared = (st.threads ?? []).filter(t => t.anchor !== "body" && blockingLogins.has(t.reviewer));
  // FINDINGS STATED IN A REVIEW BODY, as their own fact.
  //
  // They cannot travel through the `threads` clause: that clause reads the LIVE
  // count of unresolved GitHub threads, and a body finding is not one, so a
  // body-only finding left it passing. `cleared` did block on them, but the
  // watcher answers `cleared` by asking the reviewer for another round -- correct
  // for a thread nobody has returned to, and wrong here, because the reviewer HAS
  // spoken and what is missing is the fix. So a body finding was derived, counted,
  // and then acted on by nothing.
  //
  // Scoped to BLOCKING reviewers for the same reason `cleared` is: clearing one
  // requires THAT reviewer to review again, so an advisory reviewer going quiet
  // would hold a pull request for ever. The residual is deliberate and named: an
  // advisory reviewer's body finding still reaches `unspilledCritical`, so it can
  // stop a spill, but it does not block a merge.
  const bodyOpen = (st.threads ?? []).filter(t => t.anchor === "body" && blockingLogins.has(t.reviewer));

  return {
    rounds: st.rounds,
    // HANDED ON, because a body reeve cannot read is now counted rather than
    // omitted: the fold projects one `unknown` finding for it, and `unknown`
    // blocks. Withholding the number was the silent option -- `computeVerdict`
    // reads a null count as no reason to stop, so an unreadable body left every
    // clause passing. A number that includes an admission of ignorance is a
    // better answer than no number, and it is the same answer this codebase
    // already gives for a thread whose severity nobody can read.
    unspilledCritical: st.unspilledCritical,
    // What the ROUND CAP reads. Blocking-scoped, for the same reason `cleared`
    // and `bodyFindings` are: blocking-ness says whose opinion gates a merge. The
    // universal count above keeps its own job, which is refusing to spill.
    blockingCritical: st.blockingCritical,
    // Each item says whether it can GATE, because two readers want different
    // things from this one list. The prompt wants everything worth showing a
    // worker; the retry identity wants only what can actually cause a repair.
    //
    // An advisory reviewer's body finding is in neither `bodyOpen` nor
    // `dispatchable`, so it is never dispatched and never blocks — but it was
    // still in the fingerprint, so an advisory reviewer posting or withdrawing one
    // minted a fresh key with zero attempts and handed the brake's budget back
    // against an unchanged set of blocking findings. Advisory churn could restart
    // the repair loop indefinitely.
    threadDetails: fresh
      ? st.threads.map(t => ({ ...t, gates: t.anchor !== "body" || blockingLogins.has(t.reviewer) }))
      : null,
    // Readable independently of `fresh`: a tick-old list of WHICH threads are
    // uncleared is not safe to dispatch a worker against, but the COUNT is safe
    // to block on -- being one tick behind can only mean blocking slightly too
    // long, never merging something a reviewer has not returned to.
    cleared: { readable: true, uncleared: uncleared.length,
               reviewers: [...new Set(uncleared.map(t => t.reviewer))] },
    bodyFindings: { readable: true, open: bodyOpen.length,
                    reviewers: [...new Set(bodyOpen.map(t => t.reviewer))] },
    // Bodies reeve could not read. Every author counts, rostered or not: this is
    // not an opinion whose weight depends on who holds it, it is reeve reporting
    // that it does not know what was said. The founder's ruling of 2026-08-27 is
    // that this stops a merge AND fetches a person, rather than blocking silently
    // on something only the operator can clear.
    unreadableBodies: { readable: true, open: (st.unreadableBodies ?? []).length,
                        reviewers: [...new Set((st.unreadableBodies ?? []).map(b => b.reviewer))] },
    projection: {
      readable: true,
      ...(bodies ? {} : { undeclaredBodyAuthor: "a reviewer wrote a review body without declaring how its bodies carry findings — counted as one unknown finding, and worth declaring so it can be read properly" }),
      ...(fresh ? {} : { detailsUnknown: "the fold runs after this evaluation, so a thread edited in place would not be seen" }),
    },
  };
}

/**
 * The two facts everything else about a pull request is decided AGAINST: the
 * revision under judgement, and when GitHub last saw it change.
 *
 * Extracted so the caller can establish them BEFORE folding review data rather
 * than as a side effect of evaluating. The fold needs the head -- clearing is
 * computed against it -- and the ingest needs `updatedAt` to decide whether the
 * pull request has moved. While these were produced by `evaluatePr`, the only
 * possible order was evaluate-then-fold, so every decision read a projection
 * derived from the PREVIOUS tick.
 *
 * `evaluatePr` takes the result back so the pin is paid for once. Pinning twice
 * would be worse than the ordering it fixes: the two reads could return different
 * revisions, and the evaluation would then judge a head the fold did not describe.
 */
/**
 * Is this pull request the builder's?
 *
 * TWO SIGNALS, EITHER SUFFICIENT, and the second is the one that gets missed.
 * The builder pushes `mp/*` branches, so the branch alone looks like enough --
 * but a task's PR can be opened by the App on an ordinary branch, and a
 * classifier that recognises only the branch treats that as a stranger's PR,
 * skips `pr_hold` entirely, and leaves a cancelled or blocked task's pull
 * request green and mergeable. That is the exact failure the hold clause exists
 * to prevent.
 *
 * The second signal is the App's LOGIN and not "is a bot": widening it to every
 * bot account is the opposite error, and pulls every dependency and review bot
 * into a table that has no row for any of them.
 *
 * A SEGMENT PREFIX, not a string one. `mpx/not-ours` starts with `mp` and is
 * nobody's builder branch; matching on the string would claim it.
 */
export function isBuilderPr({ headRef = null, authorLogin = null } = {}) {
  // THE APP, not any bot. `user.type` is `Bot` for dependency bots, review bots
  // and every other integration in the repository, so testing it marked every
  // automated pull request as the builder's -- and during a hub or repository-id
  // fault those PRs would take an UNKNOWN hold clause and an action-required
  // policy result over `pr_hold` rows that can never exist for them. The
  // identity is the App's login, and `POLICY_APP` is where that name already
  // lives.
  if (typeof authorLogin === "string" &&
      authorLogin.toLowerCase() === `${POLICY_APP}[bot]`.toLowerCase()) return true;
  return typeof headRef === "string" && /^mp\//.test(headRef);
}

// A commit's tree, for the subject of the evidence a verdict is recorded with
// (#165). A commit never changes, so each is read once per process. One that
// can't be read is null, which the record shows as unknown, and is read again
// next time.
const TREES = new Map();
export function treeOf(nwo, sha) {
  const key = `${nwo}@${sha}`;
  if (TREES.has(key)) return TREES.get(key);
  const r = ghJson([`repos/${nwo}/git/commits/${sha}`, "--jq", ".tree.sha"]);
  const tree = r.ok && /^[0-9a-f]{40}$/.test(r.out) ? r.out : null;
  if (tree) {
    if (TREES.size >= 1000) TREES.delete(TREES.keys().next().value);
    TREES.set(key, tree);
  }
  return tree;
}

export function prAnchor({ nwo, pr }) {
  // updated_at rides along so ingest can skip a pull request that has not moved.
  // It is GitHub's timestamp, so a change reeve has not seen yet still triggers a
  // read -- unlike a local clock, which would skip whatever it slept through.
  // `.user.login` rides along for the builder classification below. Appended
  // rather than inserted: the destructuring below is positional, so a new field
  // in the middle silently shifts every one after it.
  const meta = ghJson([`repos/${nwo}/pulls/${pr}`, "--jq", "[.head.ref,.base.ref,.state,.title,.updated_at,.user.login]|@tsv"]);
  if (!meta.ok) return { ok: false, why: meta.err.split("\n")[0] };
  const [headRef, baseRef, state, title, updatedAt, authorLogin] = meta.out.split("\t");

  const pin = pinHead(nwo, headRef);
  if (!pin.ok) return { ok: false, why: `could not pin head: ${pin.why}` };
  return { ok: true, headRef, baseRef, state, title, updatedAt, head: pin.sha, pin,
           authorLogin };
}

/**
 * A check as the verdict names it: its name, and the App it came from, null for
 * a commit status. Two checks of one name from different Apps are different
 * checks, and one can't stand in for the other (#286).
 * @param {{ name?: string, source?: string, appId?: string | number | null }} r
 */
const checkOf = (r) => ({ name: String(r.name), app: r.source === "check_run" && r.appId != null ? String(r.appId) : null });
/** Each check once, by name and App. @param {{ name: string, app: string | null }[]} list */
const eachOnce = (list) => list.filter((c, i) => list.findIndex((d) => d.name === c.name && d.app === c.app) === i);

/**
 * A base's health as a verdict reads it: its verdict, whether it could be read,
 * whether its checks were read whole, whether the commit judged contains the
 * base's, and the checks failing there. So the pull request that repairs a red
 * base can be told from one that would hide its next failure (#286).
 * @param {{ verdict: string, readable?: boolean, failing?: any[] }} base
 * @param {{ complete?: boolean, inHead?: boolean | null }} [o]
 */
export const baseHealthOf = (base, { complete = false, inHead = null } = {}) => ({
  verdict: base.verdict, readable: base.readable !== false, complete, inHead,
  failing: eachOnce((base.failing ?? []).filter((r) => r?.name).map(checkOf)),
  // Named, so a base passed with a workflow failing there says so (#288).
  ancillaryFailing: [.../** @type {any} */ (base).ancillaryFailing ?? []] });

/**
 * The checks that gate merges into a base, whose failures alone make it red
 * (#288): the required ones, where they're known and there are any. Null where
 * they aren't, and then every check on the base counts.
 * @param {{ required?: { context: string, app: string | null }[], known?: boolean }} req
 */
export const gatingOf = (req) => (req?.known === true && (req.required ?? []).length ? req.required ?? null : null);

/**
 * The checks that passed at a commit: completed with success, not merely skipped
 * or neutral, as only a run that passed shows a failure fixed.
 * @param {{ name?: string, state?: string, conclusion?: string, source?: string, appId?: any }[] | undefined} rows
 */
export const passedChecks = (rows) => eachOnce((rows ?? []).filter((r) => r?.name && r.state === "completed" && r.conclusion === "success").map(checkOf));

/**
 * Whether commit `head` contains commit `base`, by GitHub's comparison of the
 * two: true where the head is ahead of it or the same, false where it's behind
 * or has diverged, null where that couldn't be read. A head from before its base
 * went red can't show the base's failure repaired (#286).
 * @param {{ nwo: string, base: string, head: string, gh?: typeof ghJson }} o
 */
export function baseContainedIn({ nwo, base, head, gh = ghJson }) {
  const r = gh([`repos/${nwo}/compare/${base}...${head}`, "--jq", ".status"]);
  if (!r.ok) return null;
  const status = String(r.out ?? "").trim();
  return status === "ahead" || status === "identical" ? true : status === "behind" || status === "diverged" ? false : null;
}

/**
 * What a pull request's head is judged against: the required checks, and those
 * the profile says run only in the merge queue, which are skipped at a head by
 * design and judged at the queue's commit instead (#286). Only where `queued`,
 * the base's rules sending every merge through a merge queue: otherwise nothing
 * would judge a queue's commit, and the check would be skipped for good. Only a
 * head's: the queue's commit is judged against the required checks alone.
 * @param {{ required?: any[], known?: boolean }} req @param {any} profile @param {boolean | null} [queued]
 */
export const headCheckRequirements = (req, profile, queued = null) => ({ ...req, queueOnly: queued === true ? (profile?.ci?.queueOnlyChecks ?? []) : [] });

export function evaluatePr({ nwo, pr, profile, db = null, anchor = null, io = {}, hold = null }) {
  // Reuses the caller's anchor when it has one, so the head is pinned ONCE per
  // pull request per tick and the fold and the evaluation cannot disagree about
  // which revision they are talking about.
  const a = anchor ?? prAnchor({ nwo, pr });
  if (!a.ok) return { ok: false, why: a.why };
  const { headRef, baseRef, state, title, updatedAt, pin } = a;

  // A reviewer's commit status is never CI evidence: a rate-limited CodeRabbit
  // reports success. Excluded at the read, for the head AND the base alike.
  const reviewerContexts = profile.ci?.reviewerStatusContexts ?? [];
  const read = readChecks(nwo, pin.sha, { reviewerContexts });
  const { rows } = read;
  // Required: what the profile names and what the base requires. A skipped
  // required check didn't run, and a read that isn't whole is UNKNOWN. Except
  // one that runs only in the merge queue, skipped here by design (#286).
  const req = requiredChecksOf({ nwo, baseRef, profile });
  // Asked only of a profile that names queue-only checks: they're left to the
  // queue's commit only where the base's rules send every merge through one.
  const queued = profile.ci?.queueOnlyChecks?.length ? mergeQueueOnBase({ nwo, base: baseRef }) : null;
  const c = classifyRead(read, headCheckRequirements(req, profile, queued));
  // ONE reading, folded into what the previous tick recorded. Settlement is about
  // the check SET being stable ACROSS TIME, so it can only be established by
  // successive ticks -- this used to call settle() three times over the same
  // snapshot, which declared every set stable the first time it was seen.
  // Only asked when a required check is missing, because that is the only branch
  // whose answer depends on it and each call is an extra API round trip.
  const reading = { ...c, sha: pin.sha, rows,
    suitesComplete: c.verdict === "MISSING_REQUIRED" ? missingSettled(nwo, pin.sha, c.missingChecks, profile) : null };
  let s;
  if (db) {
    s = saveSettlement(db, nwo, pr, settle(loadSettlement(db, nwo, pr), reading));
  } else {
    // No store means no memory of previous readings, and an unrememberable
    // observation cannot be corroborated. Fail closed rather than pretend.
    s = { ...settle(null, reading), settled: false,
          why: "settlement needs a state store to compare readings across ticks" };
  }
  if (c.failing.length) {
    // Rows, not names, so causes can be compared; and the resolver is handed in
    // because a shared job name is not a shared failure.
    const io = inheritedOrCaused(nwo, baseRef, c.failing, { resolveCause: rootCause, reviewerContexts });
    c.inherited = io.inherited; c.caused = io.caused; c.unverified = io.unverified;
  }

  const baseHead = pinHead(nwo, baseRef);
  // Judged against the profile's required set. Passing an empty list here meant
  // every check on the base counted equally, so one cancelled ancillary job made
  // the branch uncheckable and every open PR waited on it.
  //
  // For health, not for evidence of a pass, and that is deliberate: anything but
  // green holds every open pull request. A check the base's rules require may run
  // only on pull requests, and a push its path filters skip is a healthy one, so
  // neither the base's own requirements nor the head's rules about skipped checks
  // apply. Only a partial read does: it can hide a failure.
  const baseRead = baseHead.ok ? readChecks(nwo, baseHead.sha, { reviewerContexts }) : null;
  const base = baseRead
    ? classifyRead(baseRead, { required: profile.ci?.requiredChecks ?? [], failuresOf: gatingOf(req) }, { evidence: false })
    : { verdict: "UNKNOWN", readable: false };
  // Whether the head contains the base's commit, asked only of a red base: a head
  // from before it went red can't show the failure repaired (#286).
  const inHead = base.verdict === "RED" && baseHead.ok ? baseContainedIn({ nwo, base: baseHead.sha, head: pin.sha }) : null;

  const threads = readThreads(nwo, pr);
  const reviewers = readReviewerStates(nwo, pr, pin.sha, profile.reviewers ?? []);

  const tl = readTimeline(nwo, pr);
  const forcePushedAt = tl.ok ? lastForcePush(tl.events) : null;

  // Rounds: distinct head SHAs a reviewer has actually judged. Derived from the
  // API rather than a local counter, so a restart cannot lose it.
  const judged = new Set(reviewers.filter(r => r.reviewedHead).map(r => r.reviewedHead.slice(0, 10)));
  // The derived review projection, read for THIS head or not read at all.
  //
  // Everything below was already being computed -- `derivePr` classifies every
  // thread by severity and clears the ones a later round covers, and `reviewState`
  // counts them. It fed a shadow log and nothing else, so two decisions were made
  // against facts that existed a few lines away in the same database:
  //
  //   · `unspilledCritical` was hard-coded null, and SPILL requires a known zero,
  //     so SPILL was unreachable code -- a branch that could never be taken;
  //   · `threadDetails` was read by FIX_FINDINGS and SPILL and written by nothing,
  //     so a worker dispatched at review findings was handed an empty list.
  //
  // Still null when the projection cannot be trusted, and that is the whole point
  // of reading it this way. `reviewState` returns UNKNOWN for a projection that is
  // absent, stale, incomplete, classified by another version, or derived for a
  // different revision -- and null flows through to a watcher that refuses to
  // spill on anything but a known zero. The unsafe direction stays impossible.
  const facts = reviewFacts({ db, nwo, pr, profile, head: pin.sha, live: threads, io });

  // The DERIVED round count when there is one. `judged.size` counts distinct heads
  // across the latest state per reviewer, so a single-reviewer pull request stays
  // at one however many rounds it has had -- and every decision gated on the soft
  // cap was therefore unreachable for the commonest shape there is.
  // WHY the critical count is missing, because two reasons need two answers.
  //
  //   · the projection is unreadable -- transient, this pull request, this tick.
  //     reeve genuinely cannot tell, and saying UNKNOWN is honest.
  //   · review-body findings are not derived at all -- permanent, global, and
  //     already recorded. Nothing about this pull request is uncertain; a
  //     capability is unbuilt.
  //
  // Collapsing them made every pull request past the soft cap UNKNOWN, and the
  // watcher handles UNKNOWN before BLOCK findings -- so the cap stopped ALL
  // remediation rather than stopping a spill. A permanent gap must not present
  // as a per-pull-request uncertainty.
  // A missing count now means exactly one thing: the projection could not be read
  // on this tick. The other reason it used to be missing -- review-body findings
  // not being derived at all -- is closed, and the branch that distinguished them
  // went with it. A permanent gap needed a PASS so the cap could not stop all
  // remediation; a transient one is honestly UNKNOWN and clears itself.
  const criticalGap = facts.unspilledCritical != null ? null : "unreadable";
  const rounds = { n: facts.rounds ?? judged.size, softCap: profile.rounds?.softCap ?? 5,
                   criticalGap, blockingCritical: facts.blockingCritical,
                   // A number when the projection is readable AT THIS HEAD, and null
                   // otherwise. Claiming "no criticals open" is a fact reeve may only
                   // state when it has it -- the alternative licenses spilling a P0.
                   hardCap: profile.rounds?.hardCap ?? 10,
                   unspilledCritical: facts.unspilledCritical };

  let ledgerBlockers = null, ledgerBlockerIds = null;
  if (db) {
    try {
      // The IDS as well as the count. The count is what the verdict clause reads;
      // the ids are what makes a repair of them identifiable, so a second attempt
      // at the same blockers can be recognised as the same problem.
      ledgerBlockerIds = db.prepare(
        `SELECT n.id AS id FROM edge e JOIN node n ON n.id = e.src
         WHERE e.dst = ? AND e.type = 'BLOCKS'
           AND n.status NOT IN ('done','decided','cancelled','refuted')`).all(`pr:${pr}`).map(r => r.id);
      ledgerBlockers = ledgerBlockerIds.length;
    } catch { ledgerBlockers = null; ledgerBlockerIds = null; }
  }

  // Everything the verdict is judged from, kept whole and returned, so the tick
  // can record it as evidence and a past verdict can be replayed from it (#165).
  // `computeVerdict` reads nothing else.
  const input = {
    head: pin.sha,
    // `readable` false when the read failed, which reading again settles, and
    // waiting for the checks to settle never does.
    checks: { verdict: s.verdict, settled: s.settled, why: s.why, readable: c.readable !== false, failing: c.failing, inherited: c.inherited,
              // Another App's check under reeve's own name: kept, never dropped.
              impostors: read.impostors ?? [], shadowRequired: req.shadowRequired, legacyRequired: req.legacyRequired,
              queueOnly: c.queueOnly ?? [], passed: passedChecks(rows) },
    base: baseHealthOf(base, { complete: baseRead?.ok === true, inHead }),
    reviewers, rounds, threads, cleared: facts.cleared,
    bodyFindings: facts.bodyFindings, unreadableBodies: facts.unreadableBodies,
    ledgerBlockers,
    mergeState: threads.mergeState, profile,
    mergeParts: readMergeParts(nwo, baseRef, threads, { rows: mergeRows(read), head: pin.sha }),
    // Passed through, never read here. `pr_hold` is a HUB row and this function
    // holds the per-repository state database, so the reading is taken by the
    // caller that has the hub connection and handed in. Null when the caller has
    // no hub, which `computeVerdict` renders as no clause at all rather than as
    // an UNKNOWN one -- a guardian that was never asked about holds must not
    // drag every verdict to UNKNOWN.
    hold,
  };
  const verdict = computeVerdict(input);

  return { ok: true, pr, title, headRef, baseRef, state, head: pin.sha, verdict, input,
           reviewers, threads, rounds, forcePushedAt, updatedAt, checks: c, settled: s,
           // The open threads themselves, for the actions that act ON them. An
           // empty array and an unreadable projection are different facts, so the
           // second is null: a caller must be able to tell "nothing is open" from
           // "reeve cannot say what is open".
           threadDetails: facts.threadDetails, reviewProjection: facts.projection,
           // Carried out so the dispatcher can identify a ledger-driven repair.
           // `FIX_FINDINGS` fires on this clause too, and a fingerprint built only
           // from review threads is null when the ledger is the only blocker — so
           // the retry brake never engaged for exactly that case.
           ledgerBlockerIds,
           cleared: facts.cleared };
}

/**
 * The name shadow results publish under. Never the enforcement check's, so a
 * shadow result can't satisfy a rule that requires the real check, whatever the
 * rules become after it was published: a pull request retargeted to a protected
 * branch, or a check made required between two ticks.
 */
export const shadowContextOf = (context) => `${context} (shadow)`;

/**
 * The check runs at this head under these names, read in one pass: reeve's own
 * latest under each, as `mine: { [name]: { id, conclusion, app } | null }`, and
 * every other App's under any of them, as `others`. Null when the runs couldn't
 * be read. Read as the App, because a run the App created is one it may update.
 * Only the App's own runs are its to update: taking another App's for reeve's
 * own left reeve's passing run under the enforcement name standing. A failure to
 * look is not "there are none": returning null then creates a duplicate rather
 * than losing anything, which is the harmless direction.
 */
function existingRuns(token, nwo, sha, names, api = apiAsInstallation) {
  const r = api(token, ["--paginate", `repos/${nwo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
    "--jq", ".check_runs[] | {name, id, conclusion, app: .app.slug, summary: .output.summary}"]);
  if (!r.ok) return null;
  const rows = [];
  for (const line of (r.out ?? "").split("\n").filter(Boolean)) { try { rows.push(JSON.parse(line)); } catch { return null; } }
  return { mine: Object.fromEntries(names.map((n) => [n, rows.filter((c) => c.name === n && c.app === POLICY_APP).at(-1) ?? null])),
           others: rows.filter((c) => names.includes(c.name) && c.app !== POLICY_APP) };
}

/**
 * Whether the results other than reeve's own under `context` at this head,
 * other Apps' check runs and commit statuses, would pass it: there is one, and
 * every one passes, as GitHub requires of every result under a name. True,
 * false, or null when the runs or the statuses couldn't be read.
 */
function othersPassUnder(token, nwo, sha, context, runs, api) {
  if (!runs) return null;
  const st = api(token, ["--paginate", `repos/${nwo}/commits/${sha}/status?per_page=100`,
    "--jq", `.statuses[] | select(.context == ${JSON.stringify(context)}) | {state}`]);
  if (!st.ok) return null;
  let states;
  try { states = (st.out ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l).state); } catch { return null; }
  const results = [...runs.others.filter((c) => c.name === context).map((c) => PASSING_RUN.has(c.conclusion)),
                   ...states.map((state) => state === "success")];
  return results.length > 0 && results.every(Boolean);
}

// Rule types that can't stop a pull request merging into a branch that already
// exists: they govern creating, deleting and force-pushing the branch. Linear
// history rules out merge commits, and squash and rebase merges still merge. A
// merge queue is where a pull request merges, not a reason it can't: measured
// (docs/measured/2026-09-27-merge-queue.md), GitHub reports one whose required
// checks pass as CLEAN under a required queue, so the queue is never why it's
// BLOCKED. Its own commit is judged apart, in the queue (#163).
const HARMLESS_RULES = new Set(["creation", "deletion", "non_fast_forward", "required_linear_history", "merge_queue"]);
// Rule types reeve doesn't evaluate either, but that a run settles without
// anyone: a deployment, a required workflow, a code scan, an automatic review.
// Waiting settles them, where the rest need a person.
const SETTLES_ALONE = new Set(["required_deployments", "workflows", "code_scanning", "copilot_code_review"]);

/**
 * What a branch requires before a pull request merges into it, as far as reeve
 * can tell:
 *   own               whether `context` is required from reeve's own App
 *   others            every other required status check, as { context, app }
 *   threadResolution  whether every conversation must be resolved
 *   strict            whether a branch must be up to date with the base first
 *   unevaluated       what can stop a merge that reeve doesn't evaluate: deployments,
 *                     signatures, a merge queue, a locked branch, and any rule it
 *                     doesn't know, named
 *   settlesAlone      those of them a run settles without anyone, a deployment say
 *   checks            every required status check, reeve's own included, as
 *                     { context, app }, with the App it is bound to or null:
 *                     known once the rules and the branch are read, whatever
 *                     else of protection could be
 *
 * GitHub requires things in two places, and both are read: the rules that apply to
 * the branch (every ruleset, the organisation's included, every page), and classic
 * branch protection. The branch reports protection's required checks to anyone
 * who can read it; the rest of protection is `protection`, which needs an
 * administrator's read. A requirement bound to another App isn't reeve's: GitHub
 * waits for that App.
 *
 * `own` is true, false, or null when it can't be told; the others are null when
 * they can't be told. Null is never taken for "nothing required".
 */
export function requirementsOn({ rules, branch, protection = null }, context, { appId = null } = {}) {
  // Every page of the rules arrives as one object per line; a single array is
  // read too.
  const entries = (r) => {
    const text = (r.out ?? "").trim();
    if (!text) return [];
    try { const v = JSON.parse(text); return Array.isArray(v) ? v : [v]; }
    catch { try { return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return undefined; } }
  };
  // Ours when unbound, or bound to reeve's App; unknown when bound and reeve's
  // App id isn't known.
  const ours = (bound) => (bound == null || Number(bound) === -1 ? true : appId == null ? null : String(bound) === String(appId));
  const verdictOf = (answers) => (answers.includes(true) ? true : answers.includes(null) ? null : false);
  const others = [], unevaluated = [], every = [];
  const settlesAlone = [];
  let byRules = null, byProtection = null, threadResolution = false, strict = false, whole = true, mergeQueue = false;
  // A required check is reeve's, another App's, or, bound to an App reeve can't
  // name, both: GitHub waits for whichever App it is.
  const required = (answers, c, bound) => {
    if (typeof c === "string" && c) every.push({ context: c, app: bound == null || Number(bound) === -1 ? null : String(bound) });
    if (c !== context) { others.push({ context: c, app: bound == null || Number(bound) === -1 ? null : String(bound) }); return; }
    const mine = ours(bound);
    answers.push(mine);
    if (mine !== true) others.push({ context: c, app: String(bound) });
    // Unbound, the requirement takes every result under the name, so another's
    // result under reeve's name must pass beside reeve's own.
    else if (bound == null || Number(bound) === -1) others.push({ context: c, app: null, besideOwn: true });
  };

  const list = rules?.ok ? entries(rules) : undefined;
  if (Array.isArray(list)) {
    const answers = [];
    for (const r of list) {
      // Every merge goes through the queue: only rules can require one.
      if (r?.type === "merge_queue") mergeQueue = true;
      if (r?.type === "required_status_checks") {
        for (const c of r.parameters?.required_status_checks ?? []) required(answers, c?.context, c?.integration_id);
        strict ||= r.parameters?.strict_required_status_checks_policy === true;
      }
      // Reviews are GitHub's review decision, which the verdict reads.
      else if (r?.type === "pull_request") threadResolution ||= r.parameters?.required_review_thread_resolution === true;
      else if (SETTLES_ALONE.has(r?.type)) { unevaluated.push(`rule ${r.type}`); settlesAlone.push(`rule ${r.type}`); }
      else if (!HARMLESS_RULES.has(r?.type)) unevaluated.push(`rule ${r?.type ?? "of no type"}`);
    }
    byRules = verdictOf(answers);
  } else whole = false;

  const b = parsed(branch);
  // The branch is the one place classic protection's required checks are read,
  // so without it they are unknown, even when the rest of protection was read.
  if (!b) whole = false;
  const branchChecks = b?.protection?.required_status_checks;
  if (b?.protected === false) byProtection = false;
  else if (branchChecks && typeof branchChecks === "object") {
    const answers = [];
    for (const c of branchChecks.checks ?? []) required(answers, c?.context, c?.app_id);
    if (!(branchChecks.checks ?? []).length) for (const c of branchChecks.contexts ?? []) required(answers, c, null);
    byProtection = verdictOf(answers);
  }
  if (classicProtection(b) !== false) {
    // The rest of classic protection. Its endpoint answers "Branch not protected"
    // when there is none, which is an answer; any other failure isn't.
    const p = parsed(protection);
    if (p) {
      // Reviews are the review decision again, and linear history, force pushes,
      // deletions and creations can't stop a merge.
      if (p.required_conversation_resolution?.enabled) threadResolution = true;
      if (p.required_status_checks?.strict) strict = true;
      if (p.required_signatures?.enabled) unevaluated.push("protection required_signatures");
      if (p.lock_branch?.enabled) unevaluated.push("protection lock_branch");
      if (p.restrictions) unevaluated.push("protection restrictions");
    } else if (!/Branch not protected/.test(protection?.err ?? "")) whole = false;
  }

  const own = byRules === true || byProtection === true ? true : byRules === null || byProtection === null ? null : false;
  const checks = Array.isArray(list) && b
    ? every.filter((c, i) => every.findIndex((d) => d.context === c.context && d.app === c.app) === i) : null;
  // Whether every merge goes through a merge queue, from the rules alone, as
  // classic protection can't require one: null where they couldn't be read.
  const queue = Array.isArray(list) ? mergeQueue : null;
  return whole ? { own, others, threadResolution, strict, unevaluated, settlesAlone, checks, mergeQueue: queue }
    : { own, others: null, threadResolution: null, strict: null, unevaluated: null, settlesAlone: null, checks, mergeQueue: queue };
}

const parsed = (r) => { try { return r?.ok ? JSON.parse(r.out || "{}") : undefined; } catch { return undefined; } };
// Whether a branch has classic protection, as the branch reports it: false for
// none, null when the branch couldn't be read. A branch that only rulesets
// protect reports itself protected, with its classic protection disabled.
const classicProtection = (b) => (!b ? null : b.protected === false || b.protection?.enabled === false ? false : true);

/** Is `context` a required status check on a branch, from reeve's own App? requirementsOn's `own`. */
export const requiredOn = (read, context, options) => requirementsOn(read, context, options).own;

// One reading per base and check, kept for the daemon's tick, and for a minute
// at most: every pull request that targets the same branch asks the same
// question, and the daemon asks it for each one on every tick.
const REQUIRED = new Map();
const REQUIRED_TTL_MS = 60_000;

/** Drop every kept reading, so the next question reads the base afresh. The daemon calls this as each tick starts. */
export function clearRequirements() { REQUIRED.clear(); REQUIRED_CHECKS.clear(); }

/** requirementsOn for a base branch, read with `gh` and cached for a minute. */
export function requirementsOnBase({ nwo, base, context, gh, appId = null, now = Date.now() }) {
  const key = `${nwo}\u0000${base}\u0000${context}\u0000${appId ?? ""}`;
  const hit = REQUIRED.get(key);
  if (hit && now - hit.at < REQUIRED_TTL_MS) return hit.value;
  const path = `repos/${nwo}/branches/${encodeURIComponent(base)}`;
  const branch = gh([path]);
  const value = requirementsOn({
    rules: gh(["--paginate", `repos/${nwo}/rules/branches/${encodeURIComponent(base)}`, "--jq", ".[]"]),
    branch,
    // The rest of classic protection only where the branch has some.
    protection: classicProtection(parsed(branch)) === false ? null : gh([`${path}/protection`]),
  }, context, { appId });
  // Kept only when whole. A reading that came back partial, a token without
  // the reads it needed, say, is read again by the next caller, which may be
  // one that can: reeve's App reads what the ambient token couldn't.
  if (REQUIRED.size > 256) REQUIRED.clear();
  if (value.own !== null && value.others !== null) REQUIRED.set(key, { at: now, value });
  return value;
}

const REQUIRED_CHECKS = new Map();
/**
 * requirementsOn's `checks` for a base branch: every status check its rules and
 * branch protection require. Read from the rules and the branch alone, so a
 * token that can't read the rest of protection still gets it, and kept for a
 * minute. Null when either couldn't be read.
 */
export function requiredChecksOnBase({ nwo, base, gh = ghJson, now = Date.now() }) {
  return baseRequirements({ nwo, base, gh, now }).checks;
}

/**
 * Whether the base's rules send every merge through a merge queue: true, false,
 * or null where they couldn't be read (#286). Read with its required checks.
 * @param {{ nwo: string, base: string, gh?: typeof ghJson, now?: number }} o
 */
export function mergeQueueOnBase({ nwo, base, gh = ghJson, now = Date.now() }) {
  return baseRequirements({ nwo, base, gh, now }).mergeQueue;
}

/** A base's required checks and whether it requires a merge queue, read together and kept for a minute. */
function baseRequirements({ nwo, base, gh = ghJson, now = Date.now() }) {
  const key = `${nwo}\u0000${base}`;
  const hit = REQUIRED_CHECKS.get(key);
  if (hit && now - hit.at < REQUIRED_TTL_MS) return hit;
  const { checks, mergeQueue } = requirementsOn({
    rules: gh(["--paginate", `repos/${nwo}/rules/branches/${encodeURIComponent(base)}`, "--jq", ".[]"]),
    branch: gh([`repos/${nwo}/branches/${encodeURIComponent(base)}`]),
  }, POLICY_CONTEXT);
  if (REQUIRED_CHECKS.size > 256) REQUIRED_CHECKS.clear();
  const got = { at: now, checks, mergeQueue };
  if (checks !== null) REQUIRED_CHECKS.set(key, got);
  return got;
}

/** Whether reeve's check is required on a base: requirementsOnBase's `own`. */
export const requiredOnBase = (args) => requirementsOnBase(args).own;

/**
 * Publish. Enforcing publishes the real conclusion under the policy's name.
 * Shadow publishes `neutral` under its own name, which shows the verdict and can
 * never pass a rule that requires the real check.
 *
 * Two things more in shadow mode. A passing result an earlier version published
 * under the enforcement name at this head would still pass that check if a rule
 * came to require it, so it is marked superseded. And when a rule already
 * requires the enforcement check, every pull request is blocked until reeve
 * enforces: that comes back as `held`, for the daemon to raise.
 *
 * `evidence`, where given, is written after the verdict: the record kept for it
 * and where the pull request's signed order stood (#274), for a copy of the
 * store to be checked against away from the host. What's published there only
 * moves forward: evidence behind what a head already carries, under either of
 * reeve's names, or none, never replaces it, and `behind` says so, for the
 * daemon to raise. `entryAt` gives the record the store's order names at an
 * entry, so a fork signed under a number already published is behind too, and
 * `commitAt` the store's commitment to its orders up to an event, so a store
 * whose orders to a published event aren't those published is behind (#285).
 */
export async function publishVerdict({ nwo, verdict, shadow = true, context = POLICY_CONTEXT, base = null, queue = false, evidence = null, entryAt = null, commitAt = null,
                                      auth: authenticateAs = authenticate, api = apiAsInstallation }) {
  const auth = await authenticateAs(nwo);
  if (!auth.ok) return { ok: false, why: auth.why };

  const real = verdict.state === PASS ? "success" : verdict.state === BLOCK ? "failure" : "action_required";
  const name = shadow ? shadowContextOf(context) : context;
  const conclusion = shadow ? "neutral" : real;
  const title = `${shadow ? "[shadow] " : ""}${verdict.state}: ${verdict.summary}`;
  const body = shadow
    ? `**Shadow mode.** This check reports what the merge policy *would* have decided. It does not block, and it is published as \`${name}\`, so it can never stand in for \`${context}\`.\n\nIf enforcing, this revision would be: **${real}**\n\n${renderVerdict(verdict)}`
    : renderVerdict(verdict);

  // Update the run already at this head rather than adding another. One head on
  // nextly had accumulated 38 of these in an afternoon: the API's default
  // `filter=latest` hides that from reeve's own reads, but it is real API load and
  // it makes the PR's check list unreadable for the human who has to act on it.
  // A merge queue reads any settled result but success as a failure, and drops
  // the entry (measured: `failed_checks` 31 s after an `action_required`). So on
  // a queue's commit, an UNKNOWN that waiting or reading again settles is
  // published as still running, which the queue waits for. A block, a pass, and
  // an UNKNOWN only a person can settle are settled there as anywhere: the last
  // lets the queue go on rather than hold every entry behind it to its timeout.
  const running = queue && !shadow && verdict.state === UNKNOWN && verdict.kind !== "person";
  const runs = existingRuns(auth.token, nwo, verdict.head, [name, context], api);
  const existing = runs?.mine[name]?.id ?? null;
  // The evidence already published at this head is GitHub's witness of the
  // store, kept out of reach of whoever can change it (#274). So it only moves
  // forward: a store behind it, rolled back or restored onto a host without its
  // anchor, never writes older evidence, or none, over it, and would otherwise
  // leave a copy as far behind to pass. Evidence of another pull request, at a
  // commit both are at, is that one's, and is written over. Under either of
  // reeve's names: an enforcing result's evidence is as much a witness as a
  // shadow one's, and a switch between them doesn't drop it.
  const priors = [...new Set([name, context])].map((n) => readEvidence(runs?.mine[n]?.summary))
    .filter((w) => w && !("garbled" in w) && (!evidence || w.pr === evidence.pr));
  const prior = /** @type {import("./published.mjs").Evidence | null} */
    (priors.find((p) => priors.every((q) => q === p || !evidenceBehind(/** @type {any} */ (p), /** @type {any} */ (q)))) ?? priors[0] ?? null);
  const short = prior && evidence ? evidenceBehind(evidence, prior, entryAt, commitAt) : null;
  const behind = short ? `at ${verdict.head.slice(0, 8)}, ${short}, so what was published there is kept` : null;
  const tail = prior && (!evidence || short) ? evidenceText(prior) : evidence ? evidenceText(evidence) : "";
  const fields = [
    ...(running ? ["-f", "status=in_progress"] : ["-f", "status=completed", "-f", `conclusion=${conclusion}`]),
    "-f", `output[title]=${title.slice(0, 250)}`,
    // The evidence is kept whole, however long the verdict, as the check reads it back whole or not at all.
    "-f", `output[summary]=${body.slice(0, 60000 - tail.length)}${tail}`,
  ];

  // Shadow mode supersedes first. A passing result an earlier version left under
  // the enforcement name passes that check for as long as it stands, so it is
  // cancelled before anything else is written, and a run stopped in between
  // leaves the gate safe. One that can't be superseded, or can't be looked for,
  // fails the publication: the daemon says so, and the next tick tries again.
  let superseded = false, left = null, stale = null;
  if (shadow) {
    stale = runs?.mine[context];
    if (!runs) left = `the check runs at ${verdict.head.slice(0, 8)} couldn't be read, so a passing result an earlier version may have left there under ${context} couldn't be superseded`;
    else if (stale && stale.app === POLICY_APP && PASSING_RUN.has(stale.conclusion)) {
      // Superseded, it keeps the evidence it carried: GitHub's witness of the store stays where it was (#274).
      const carried = readEvidence(stale.summary);
      const kept = carried && !("garbled" in carried) ? evidenceText(carried) : "";
      const s = api(auth.token, ["-X", "PATCH", `repos/${nwo}/check-runs/${stale.id}`, "-f", "status=completed", "-f", "conclusion=cancelled",
        "-f", `output[title]=Superseded: shadow results now publish as ${name}`,
        "-f", `output[summary]=This result was published in shadow mode under the enforcement check's name, where it could pass that check if a rule came to require it. Shadow results now publish as \`${name}\`.${kept}`]);
      superseded = s.ok;
      if (!s.ok) left = `the passing result an earlier version left under ${context} at ${verdict.head.slice(0, 8)} couldn't be superseded (${(s.err ?? "").split("\n")[0]})`;
    }
  }

  const res = existing
    ? api(auth.token, ["-X", "PATCH", `repos/${nwo}/check-runs/${existing}`, ...fields])
    : api(auth.token, ["-X", "POST", `repos/${nwo}/check-runs`,
        "-f", `name=${name}`, "-f", `head_sha=${verdict.head}`, ...fields]);
  // Enforcing, a failed write is the whole story. In shadow mode it isn't: a
  // rule requiring the enforcement name still needs saying, or one failed write
  // would leave it unseen.
  if (!res.ok && !shadow) return { ok: false, why: res.err.split("\n")[0], behind };
  const unwritten = res.ok ? null : `couldn't publish as ${name} (${res.err.split("\n")[0]})`;

  let held = null;
  if (shadow) {
    const req = base ? requirementsOnBase({ nwo, base, context, gh: (args) => api(auth.token, args), appId: auth.appId ?? null }) : null;
    const required = req?.own ?? null;
    // Bound to reeve's App, only reeve's run can pass the requirement. With no
    // App bound, or the binding unread, anyone's result under the name can.
    const unbound = required === true && !(Array.isArray(req.others) && !req.others.some((o) => o.context === context && o.besideOwn));
    // Required, the check isn't blocked while such a result stands: it passes,
    // and the pull request can merge unjudged. So too, maybe, when the rules
    // couldn't be read to say. That is for a person to know now, and so is a
    // head whose runs couldn't be read to rule such a result out: "every pull
    // request is blocked" would say the opposite of what may be true.
    const blocked = `a rule requires ${context} on ${base}, and reeve publishes it only when enforcing, so every pull request there is blocked until it enforces or the rule stops requiring it`;
    if (left && required !== false)
      held = `a rule ${required ? "requires" : "may require"} ${context} on ${base ?? "the base"}, and ${left}, so pull request head ${verdict.head.slice(0, 8)} ${stale && required ? "can" : "may"} pass that check unjudged`;
    else if (unbound) {
      // Not blocked, then, if another App or a commit status has put a passing
      // result under the name, and that is for a person to know now.
      const passing = othersPassUnder(auth.token, nwo, verdict.head, context, runs, api);
      held = passing === false
        ? `${blocked}; with no App bound to the rule, any passing result under ${context} would pass it, so bind the rule to reeve's App`
        : `a rule requires ${context} on ${base} with no App bound, and ${passing ? "a passing result of another's stands under that name" : "whether a passing result of another's stands under that name couldn't be read"} at ${verdict.head.slice(0, 8)}, so pull request head ${verdict.head.slice(0, 8)} ${passing ? "can" : "may"} pass that check unjudged`;
    }
    else if (required === true) held = blocked;
  }
  const id = res.ok ? JSON.parse(res.out).id : null;
  if (unwritten || left)
    return { ok: false, why: [unwritten, left && (res.ok ? `published as ${name}, but ${left}` : left)].filter(Boolean).join("; "),
             id, conclusion, name, wouldBe: real, shadow, updated: Boolean(existing), superseded, held, behind };
  return { ok: true, id, conclusion, name, wouldBe: real, shadow, updated: Boolean(existing), superseded, held, behind };
}

/**
 * Take a PASS back (#161). reeve's own run under `name` at `head` is marked
 * cancelled, which a required check reads as not passed, until the next publish
 * writes over it. Cancelled rather than in progress: GitHub takes it on a
 * completed run, as the shadow supersede above does, and the run keeps its
 * identity, so the next publish finds it again. A second run left in progress
 * might not be the one that publish updates, and would hold the check for ever.
 * The run cancelled is reeve's LATEST under the name at the head, looked up
 * each time, which is the one a required check reads. The one on record may
 * not be it: a publication that couldn't read the runs made a new one, and its
 * record may not have been written. When the runs can't be read, the one on
 * record is cancelled all the same, and it isn't reported as done.
 *
 * The run's text shows on the watched repository's pull requests, so it names
 * the merge policy, never reeve.
 */
export async function withdrawVerdict({ nwo, head, name, id = null, why,
                                        auth: authenticateAs = authenticate, api = apiAsInstallation }) {
  const auth = await authenticateAs(nwo);
  if (!auth.ok) return { ok: false, why: auth.why };
  const cancel = (run) => api(auth.token, ["-X", "PATCH", `repos/${nwo}/check-runs/${run}`, "-f", "status=completed", "-f", "conclusion=cancelled",
    "-f", `output[title]=${`Withdrawn: ${why}`.slice(0, 250)}`,
    "-f", `output[summary]=The merge policy withdrew its result here: ${why}. A withdrawn result doesn't pass. It publishes a new one once it can check this pull request again.`]);
  const runs = existingRuns(auth.token, nwo, head, [name], api);
  if (!runs) {
    const unread = `the check runs at ${head.slice(0, 8)} couldn't be read`;
    if (id == null) return { ok: false, why: unread };
    const res = cancel(id);
    return { ok: false, why: res.ok ? `${unread}, so a later run of reeve's there may still pass` : String(res.err ?? "").split("\n")[0] };
  }
  const run = runs.mine[name]?.id ?? null;
  // Nothing of reeve's stands there, so there is nothing to take back.
  if (run == null) return { ok: true, id: null };
  const res = cancel(run);
  if (!res.ok) return { ok: false, why: String(res.err ?? "").split("\n")[0] };
  return { ok: true, id: run };
}
