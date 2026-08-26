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
import { computeVerdict, renderVerdict, PASS, BLOCK, UNKNOWN } from "./verdict.mjs";
import { reviewState } from "./review/derive.mjs";
import { compare } from "./review/shadow.mjs";
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
  if (io) {
    cRows = io.comments ?? [];
    rRows = io.reviews ?? [];
  } else {
    const comments = ghJson([`repos/${nwo}/issues/${pr}/comments?per_page=100`, "--jq",
      '.[] | [.user.login, (.created_at), (.body|gsub("\n";" "))] | @tsv']);
    const reviews = ghJson([`repos/${nwo}/pulls/${pr}/reviews?per_page=100`, "--jq",
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
                             at = Math.floor(Date.now() / 1000), io = {} }) {
  const unknown = why => ({ unspilledCritical: null, rounds: null, threadDetails: null,
                            cleared: { readable: false, why },
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
  const uncleared = (st.threads ?? []).filter(t => blockingLogins.has(t.reviewer));

  return {
    rounds: st.rounds,
    unspilledCritical: bodies ? st.unspilledCritical : null,
    threadDetails: fresh ? st.threads : null,
    // Readable independently of `fresh`: a tick-old list of WHICH threads are
    // uncleared is not safe to dispatch a worker against, but the COUNT is safe
    // to block on -- being one tick behind can only mean blocking slightly too
    // long, never merging something a reviewer has not returned to.
    cleared: { readable: true, uncleared: uncleared.length,
               reviewers: [...new Set(uncleared.map(t => t.reviewer))] },
    projection: {
      readable: true,
      ...(bodies ? {} : { countUnknown: "review-body findings are not derived yet, so a zero could be missing a body-only critical" }),
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
export function prAnchor({ nwo, pr }) {
  // updated_at rides along so ingest can skip a pull request that has not moved.
  // It is GitHub's timestamp, so a change reeve has not seen yet still triggers a
  // read -- unlike a local clock, which would skip whatever it slept through.
  const meta = ghJson([`repos/${nwo}/pulls/${pr}`, "--jq", "[.head.ref,.base.ref,.state,.title,.updated_at]|@tsv"]);
  if (!meta.ok) return { ok: false, why: meta.err.split("\n")[0] };
  const [headRef, baseRef, state, title, updatedAt] = meta.out.split("\t");

  const pin = pinHead(nwo, headRef);
  if (!pin.ok) return { ok: false, why: `could not pin head: ${pin.why}` };
  return { ok: true, headRef, baseRef, state, title, updatedAt, head: pin.sha, pin };
}

export function evaluatePr({ nwo, pr, profile, db = null, anchor = null, io = {} }) {
  // Reuses the caller's anchor when it has one, so the head is pinned ONCE per
  // pull request per tick and the fold and the evaluation cannot disagree about
  // which revision they are talking about.
  const a = anchor ?? prAnchor({ nwo, pr });
  if (!a.ok) return { ok: false, why: a.why };
  const { headRef, baseRef, state, title, updatedAt, pin } = a;

  // A reviewer's commit status is never CI evidence: a rate-limited CodeRabbit
  // reports success. Excluded at the read, for the head AND the base alike.
  const reviewerContexts = profile.ci?.reviewerStatusContexts ?? [];
  const { rows } = readChecks(nwo, pin.sha, { reviewerContexts });
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
    // Rows, not names, so causes can be compared; and the resolver is handed in
    // because a shared job name is not a shared failure.
    const io = inheritedOrCaused(nwo, baseRef, c.failing, { resolveCause: rootCause, reviewerContexts });
    c.inherited = io.inherited; c.caused = io.caused; c.unverified = io.unverified;
  }

  const baseHead = pinHead(nwo, baseRef);
  // Judged against the SAME required set as the head. Passing an empty list here
  // meant every check on the base counted equally, so one cancelled ancillary job
  // made the branch uncheckable and every open PR waited on it.
  const base = baseHead.ok
    ? classify(readChecks(nwo, baseHead.sha, { reviewerContexts }).rows, profile.ci?.requiredChecks ?? [])
    : { verdict: "UNKNOWN" };

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
  const rounds = { n: facts.rounds ?? judged.size, softCap: profile.rounds?.softCap ?? 5,
                   // A number when the projection is readable AT THIS HEAD, and null
                   // otherwise. Claiming "no criticals open" is a fact reeve may only
                   // state when it has it -- the alternative licenses spilling a P0.
                   hardCap: profile.rounds?.hardCap ?? 10,
                   unspilledCritical: facts.unspilledCritical };

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
    reviewers, rounds, threads, cleared: facts.cleared, ledgerBlockers,
    mergeState: threads.mergeState, profile,
  });

  return { ok: true, pr, title, headRef, baseRef, state, head: pin.sha, verdict,
           reviewers, threads, rounds, forcePushedAt, updatedAt, checks: c, settled: s,
           // The open threads themselves, for the actions that act ON them. An
           // empty array and an unreadable projection are different facts, so the
           // second is null: a caller must be able to tell "nothing is open" from
           // "reeve cannot say what is open".
           threadDetails: facts.threadDetails, reviewProjection: facts.projection,
           cleared: facts.cleared };
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
