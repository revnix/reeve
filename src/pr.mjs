// Gather everything a verdict needs about one PR, then publish it.
//
// Shadow mode is the default and it is not a debug flag. Flipping a gate against
// a baseline you have not measured blocks all work in flight at once, which is
// the moment a bypass gets reopened and the programme dies. In shadow the check
// publishes `neutral`, which GitHub renders but never blocks on, so a week of
// them says exactly what the gate WOULD have refused.

import { pinHead, readChecks, classify, settle, inheritedOrCaused, readTimeline, lastForcePush, suitesComplete } from "./github/reconciler.mjs";
import { loadSettlement, saveSettlement } from "./db/ops.mjs";
import { computeVerdict, renderVerdict, PASS, BLOCK, UNKNOWN } from "./verdict.mjs";
import { authenticate, apiAsInstallation } from "./github/app.mjs";
import { execFileSync } from "node:child_process";

function ghJson(args) {
  try { return { ok: true, out: execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (e) { return { ok: false, out: "", err: String(e.stderr || e.message).trim() }; }
}

const THREADS_QUERY = `query($o:String!,$r:String!,$n:Int!,$c:String){
  repository(owner:$o,name:$r){ pullRequest(number:$n){
    mergeStateStatus
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
export function readThreads(nwo, pr) {
  const [o, r] = nwo.split("/");
  let cursor = null, total = null, seen = 0, unresolved = 0, mergeState = null, pages = 0;
  for (;;) {
    const args = ["graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${o}`, "-F", `r=${r}`, "-F", `n=${pr}`];
    if (cursor) args.push("-F", `c=${cursor}`);
    const res = ghJson(args);
    if (!res.ok) return { readable: false, why: res.err.split("\n")[0], mergeState };
    const pr_ = JSON.parse(res.out).data?.repository?.pullRequest;
    if (!pr_) return { readable: false, why: "no pullRequest in response", mergeState };
    mergeState = pr_.mergeStateStatus;
    const t = pr_.reviewThreads;
    total = t.totalCount;
    seen += t.nodes.length;
    unresolved += t.nodes.filter(n => !n.isResolved).length;
    pages++;
    if (!t.pageInfo.hasNextPage || pages > 20) { cursor = null; break; }
    cursor = t.pageInfo.endCursor;
  }
  // Only claim readability when the count seen matches the count declared.
  return { readable: seen >= total, total, unresolved, seen, mergeState };
}

/**
 * Reviewer state at a head. Four states, never two. A refusal is ABSENT, and a
 * declared-but-never-seen reviewer is NOT_INSTALLED rather than silently clean.
 */
export function readReviewerStates(nwo, pr, head, reviewers) {
  const comments = ghJson([`repos/${nwo}/issues/${pr}/comments?per_page=100`, "--jq",
    '.[] | [.user.login, (.created_at), (.body|gsub("\n";" "))] | @tsv']);
  const reviews = ghJson([`repos/${nwo}/pulls/${pr}/reviews?per_page=100`, "--jq",
    '.[] | [.user.login, (.commit_id // ""), (.state), (.body|gsub("\n";" "))] | @tsv']);
  const cRows = comments.ok ? comments.out.split("\n").filter(Boolean).map(l => l.split("\t")) : [];
  const rRows = reviews.ok ? reviews.out.split("\n").filter(Boolean).map(l => l.split("\t")) : [];

  return reviewers.map(rev => {
    const mine = l => String(l).toLowerCase().includes(rev.login.toLowerCase());
    const myComments = cRows.filter(([l]) => mine(l));
    const myReviews = rRows.filter(([l]) => mine(l));
    if (!myComments.length && !myReviews.length) return { ...rev, state: "NOT_RUN", reviewedHead: null };

    // A refusal is the most recent word if it is the most recent word.
    const last = myComments.at(-1);
    if (rev.refusal && last && new RegExp(rev.refusal, "i").test(last[2])) {
      return { ...rev, state: "REFUSED", reviewedHead: null, detail: "quota or rate limit" };
    }
    // Findings carry the full sha on the review object; a clean pass names an
    // abbreviated sha in the comment body and files no review object at all.
    const withSha = myReviews.filter(([, sha]) => sha);
    if (withSha.length) return { ...rev, state: "VERDICT", reviewedHead: withSha.at(-1)[1] };
    const named = myComments.map(([, , body]) => body.match(/Reviewed commit:\**\s*`?([0-9a-f]{7,40})`?/i)?.[1]).filter(Boolean);
    if (named.length) return { ...rev, state: "CLEAN", reviewedHead: named.at(-1) };
    return { ...rev, state: "NOT_RUN", reviewedHead: null, detail: "commented without naming a revision" };
  });
}

/** Everything, for one PR, at one pinned head. */
export function evaluatePr({ nwo, pr, profile, db = null }) {
  const meta = ghJson([`repos/${nwo}/pulls/${pr}`, "--jq", "[.head.ref,.base.ref,.state,.title]|@tsv"]);
  if (!meta.ok) return { ok: false, why: meta.err.split("\n")[0] };
  const [headRef, baseRef, state, title] = meta.out.split("\t");

  const pin = pinHead(nwo, headRef);
  if (!pin.ok) return { ok: false, why: `could not pin head: ${pin.why}` };

  const { rows } = readChecks(nwo, pin.sha);
  const c = classify(rows, profile.ci?.requiredChecks ?? []);
  // ONE reading, folded into what the previous tick recorded. Settlement is about
  // the check SET being stable ACROSS TIME, so it can only be established by
  // successive ticks -- this used to call settle() three times over the same
  // snapshot, which declared every set stable the first time it was seen.
  // Only asked when a required check is missing, because that is the only branch
  // whose answer depends on it and each call is an extra API round trip.
  const reading = { ...c, sha: pin.sha, rows,
    suitesComplete: c.verdict === "MISSING_REQUIRED"
      ? suitesComplete(nwo, pin.sha, { app: profile.ci?.appSlug ?? "github-actions" })
      : null };
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
    const io = inheritedOrCaused(nwo, baseRef, c.failing.map(f => f.name));
    c.inherited = io.inherited; c.caused = io.caused;
  }

  const baseHead = pinHead(nwo, baseRef);
  const base = baseHead.ok ? classify(readChecks(nwo, baseHead.sha).rows, []) : { verdict: "UNKNOWN" };

  const threads = readThreads(nwo, pr);
  const reviewers = readReviewerStates(nwo, pr, pin.sha, profile.reviewers ?? []);

  const tl = readTimeline(nwo, pr);
  const forcePushedAt = tl.ok ? lastForcePush(tl.events) : null;

  // Rounds: distinct head SHAs a reviewer has actually judged. Derived from the
  // API rather than a local counter, so a restart cannot lose it.
  const judged = new Set(reviewers.filter(r => r.reviewedHead).map(r => r.reviewedHead.slice(0, 10)));
  const rounds = { n: judged.size, softCap: profile.rounds?.softCap ?? 5,
                   hardCap: profile.rounds?.hardCap ?? 10, unspilledCritical: 0 };

  let ledgerBlockers = null;
  if (db) {
    try {
      ledgerBlockers = db.prepare(
        `SELECT count(*) AS c FROM edge e JOIN node n ON n.id = e.src
         WHERE e.dst = ? AND e.type = 'BLOCKS'
           AND n.status NOT IN ('done','decided','cancelled','refuted')`).get(`pr:${pr}`).c;
    } catch { ledgerBlockers = null; }
  }

  const verdict = computeVerdict({
    head: pin.sha,
    checks: { verdict: s.verdict, settled: s.settled, why: s.why, failing: c.failing, inherited: c.inherited },
    base: { verdict: base.verdict },
    reviewers, rounds, threads, ledgerBlockers,
    mergeState: threads.mergeState, profile,
  });

  return { ok: true, pr, title, headRef, baseRef, state, head: pin.sha, verdict,
           reviewers, threads, rounds, forcePushedAt, checks: c, settled: s };
}

/**
 * The id of the policy check already at this head, or null. Read as the App
 * rather than as the user, because the check the App created is the one it is
 * allowed to update; `filter=latest` is exactly right here, since the newest run
 * under that name is the one to supersede.
 *
 * A failure to look is not "there is none": returning null would then create a
 * duplicate rather than lose anything, which is the harmless direction.
 */
function existingPolicyRun(token, nwo, sha, context) {
  const r = apiAsInstallation(token,
    [`repos/${nwo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
     "--jq", `[.check_runs[] | select(.name == "${context}") | .id] | last // empty`]);
  return r.ok && r.out ? r.out.trim() : null;
}

/**
 * Publish. Shadow publishes `neutral`, which GitHub shows and never blocks on.
 * Enforcing publishes the real conclusion.
 */
export async function publishVerdict({ nwo, verdict, shadow = true, context = "ops/merge-policy" }) {
  const auth = await authenticate(nwo);
  if (!auth.ok) return { ok: false, why: auth.why };

  const real = verdict.state === PASS ? "success" : verdict.state === BLOCK ? "failure" : "action_required";
  const conclusion = shadow ? "neutral" : real;
  const title = `${shadow ? "[shadow] " : ""}${verdict.state}: ${verdict.summary}`;
  const body = shadow
    ? `**Shadow mode.** This check reports what the merge policy *would* have decided. It does not block.\n\nIf enforcing, this revision would be: **${real}**\n\n${renderVerdict(verdict)}`
    : renderVerdict(verdict);

  // Update the run already at this head rather than adding another. One head on
  // nextly had accumulated 38 of these in an afternoon: the API's default
  // `filter=latest` hides that from reeve's own reads, but it is real API load and
  // it makes the PR's check list unreadable for the human who has to act on it.
  const fields = [
    "-f", "status=completed", "-f", `conclusion=${conclusion}`,
    "-f", `output[title]=${title.slice(0, 250)}`,
    "-f", `output[summary]=${body.slice(0, 60000)}`,
  ];
  const existing = existingPolicyRun(auth.token, nwo, verdict.head, context);
  const res = existing
    ? apiAsInstallation(auth.token, ["-X", "PATCH", `repos/${nwo}/check-runs/${existing}`, ...fields])
    : apiAsInstallation(auth.token, ["-X", "POST", `repos/${nwo}/check-runs`,
        "-f", `name=${context}`, "-f", `head_sha=${verdict.head}`, ...fields]);
  if (!res.ok) return { ok: false, why: res.err.split("\n")[0] };
  return { ok: true, id: JSON.parse(res.out).id, conclusion, wouldBe: real, shadow,
           updated: Boolean(existing) };
}
