/**
 * The GitHub effects reeve performs itself, one function per outbox `kind`.
 *
 * These exist because a WORKER cannot perform them. A worker holds no credential
 * by design and its `gh` is shimmed, so a prompt that asks it to comment is asking
 * for something the sandbox refuses -- which is how a finished piece of work gets
 * spent diagnosing its own permissions. reeve holds the credential, so reeve acts.
 *
 * Every handler takes `(args, deps)` and returns `{ ok, result?, error?, retryable? }`.
 * `deps` carries the injected API caller and the row's idempotency key. Nothing
 * here reaches for a credential on its own: the drainer authenticates once and
 * passes the caller in, so a test drives real handler logic without a network.
 */

/** The marker that makes a comment recognisable as one reeve already posted. */
export const markerFor = idemKey => `<!-- reeve:effect:${idemKey} -->`;

/**
 * Post a comment on a pull request, at most once.
 *
 * The outbox's UNIQUE `idem_key` stops the same effect being enqueued twice. It
 * does NOT make delivery exactly-once: a drainer that posts the comment and dies
 * before settling leaves a row that recovery returns to pending, and the retry
 * posts a second comment. The fence prevents two drainers settling over each
 * other; it cannot prevent a crash in the window between the API call and the
 * settle, because that window is on the far side of an effect the API will happily
 * repeat.
 *
 * So the key is carried INTO the effect as an invisible marker and looked for
 * first. That is the ordinary answer for an API with no idempotency key of its own:
 * make the effect self-identifying, and read before writing. The cost is one extra
 * list call per delivery, paid only on the delivery path.
 *
 * The read is bounded to the most recent page. A marker older than that means a
 * repost, which is a duplicate comment rather than a lost one -- the failure the
 * cheaper direction produces is worse.
 */
export function ghPrComment(args, { api, idemKey, actor = null, reconcileOnly = false }) {
  const { nwo, pr, body, head = null } = args;
  if (!nwo || !pr || !body) return { ok: false, retryable: false, error: `gh.pr.comment needs nwo, pr and body; got ${JSON.stringify(args)}` };
  const marker = markerFor(idemKey);

  // Has the request been overtaken while it was in flight?
  //
  // A trigger comment names no revision -- it asks for a review of whatever is
  // current -- so posting one decided for an old head requests a review of the NEW
  // head, and the tick that noticed the new head enqueues its own differently
  // marked effect and asks again. Two requests, neither idempotency check able to
  // see the other, because they are genuinely different effects.
  //
  // Resolved as `ok` rather than as a failure: not posting IS the correct outcome
  // for this effect, so it is finished, not broken. A retry would ask the same
  // question and get the same answer, and a dead letter would summon a person to
  // look at a head that simply moved on.
  //
  // An unreadable head does NOT discard. The whole file's rule: absence of
  // evidence is not evidence of absence, and the cost of a stale comment is much
  // lower than the cost of dropping a review request on a transient read failure.
  if (head) {
    // State AND head, in one read. A closed or merged pull request normally KEEPS
    // its head, so a head check alone lets a request through to a pull request the
    // watcher already treats as finished -- asking for a review of something
    // nobody is going to review, or failing terminally and raising a dead letter
    // that names a pull request that is done.
    const now = api(["-X", "GET", `repos/${nwo}/pulls/${pr}`, "--jq", "[.state, .head.sha] | @tsv"]);
    const [state, current] = now.ok ? String(now.out || "").trim().split("\t") : [null, null];
    if (state && state !== "open")
      return { ok: true, result: { posted: false, superseded: true, reason: `the pull request is ${state}` } };
    if (current && current !== head)
      return { ok: true, result: { posted: false, superseded: true, decidedFor: head, now: current } };
  }

  // The pre-check runs on EVERY attempt, not only on a retry.
  //
  // Gating it on the attempt count was an optimisation and it was wrong. A local
  // counter cannot prove that no external delivery exists: restore the database
  // from a snapshot taken before a delivery and the comment is still on GitHub
  // while the row comes back with `attempts = 0`, so a "first" attempt posts the
  // same trigger again. The state that would have to remember is precisely the
  // state a restore rolls back. Only GitHub knows what is on GitHub.
  //
  // It is affordable because the read is filtered at the source: `--jq` returns
  // matching ids and nothing else, so the output is a handful of digits however
  // long the thread is, and the discussion's length stops being a variable in the
  // answer. `--paginate` because issue comments come OLDEST FIRST, so a fixed
  // first page is the page least likely to hold a comment posted seconds ago.
  //
  // The AUTHOR is checked, not just the marker. The key is derived from public
  // values -- repository, pull request, head, reviewer login -- so anyone who can
  // comment can construct it. Without an author test, a contributor could post the
  // marker during a transient failure and the retry would settle `done` without
  // ever requesting the review: a required reviewer silently never summoned. The
  // check is done in the `--jq` so a forged comment never even reaches this code.
  //
  // A null actor means GitHub did not tell us what reeve writes as. That is
  // "cannot tell", not "matches", so the suppression is skipped entirely and the
  // comment is posted: a duplicate comment is a nuisance, an unrequested review is
  // a pull request that waits forever.
  // Whether GitHub actually ANSWERED, as distinct from whether it said no.
  //
  // Both arrive here as "no marker": a timeout, a truncated buffer, a rate limit
  // and a genuinely absent comment are the same empty result. On the delivery path
  // the difference does not change what happens -- either way it posts -- so it was
  // never recorded. The reconciling path turns on it exactly: a definite "not
  // there" is an answer worth acting on, and a read that never completed is not.
  let answered = false;
  if (actor) {
    const seen = api(["--paginate", "-X", "GET", `repos/${nwo}/issues/${pr}/comments`,
                      "-F", "per_page=100",
                      "--jq", `.[] | select(.user.login == "${actor}") | select(.body | contains("${marker}")) | .id`]);
    if (seen.ok) {
      answered = true;
      const ids = String(seen.out || "").split("\n").map(s => s.trim()).filter(Boolean);
      if (ids.length) return { ok: true, result: { commentId: Number(ids[ids.length - 1]), alreadyThere: true } };
    }
    // A failed read falls THROUGH and posts. Absence of evidence is not evidence
    // of absence, and every failure that lands here -- a timeout, a truncated
    // buffer, a rate limit -- LOOKS exactly like "no marker found".
  }

  // A reconciling attempt may confirm a delivery. It may not make one.
  //
  // This is a lease granted after the delivery budget is spent, so the marker
  // check can find a comment whose settle was lost -- to a crash, or to a response
  // that never came back from a POST GitHub had already accepted. Reaching here
  // means no such comment was found, so posting would deliver on an attempt the
  // budget had already refused, which is the opposite of what the phase is for.
  //
  // Terminal rather than retryable, and that is a statement about THIS answer, not
  // about the phase. The marker read returned a definite "not there", so asking
  // again would ask a question already answered. A read that FAILED does not reach
  // this line: it falls through the block above, which treats an unreadable answer
  // as no answer.
  if (reconcileOnly)
    return answered
      ? { ok: false, retryable: false,
          error: "the delivery budget is spent and GitHub reports no comment carrying this effect's marker; not posting" }
      : { ok: false, retryable: true,
          error: "the delivery budget is spent and the marker could not be READ, so whether a delivery landed is unknown; not posting" };

  const r = api(["-X", "POST", `repos/${nwo}/issues/${pr}/comments`,
                 "-f", `body=${body}\n\n${marker}`]);
  if (!r.ok) return { ok: false, retryable: retryableFrom(r.err), error: r.err };
  let id = null;
  try { id = JSON.parse(r.out).id ?? null; } catch { /* posted; the id is a convenience */ }
  return { ok: true, result: { commentId: id, alreadyThere: false } };
}

/**
 * Whether a GitHub failure is worth trying again.
 *
 * Retrying is the default, because an unrecognised error is more often transient
 * than terminal and a dead-lettered effect needs a person. The exceptions are the
 * ones no amount of waiting fixes: the resource is gone, the request is malformed,
 * or the App cannot act on this repository at all.
 */
export function retryableFrom(err = "") {
  const s = String(err);
  // 403 FIRST, because GitHub overloads it. Primary and secondary rate limits both
  // arrive as 403, and so does a permanent permission failure -- so classifying the
  // status alone dead-letters a durable effect that would have succeeded a minute
  // later, and dead-lettering needs a person. The body is what separates them.
  if (/rate limit|secondary rate|abuse detection|retry.after|too many requests/i.test(s)) return true;
  if (/HTTP 4(01|03|04|22)\b/.test(s)) return false;
  if (/Not Found|Unprocessable|Resource not accessible/i.test(s)) return false;
  return true;
}

/** Every kind this build can perform. A kind absent here is never leased. */
export const HANDLERS = Object.freeze({ "gh.pr.comment": ghPrComment });
