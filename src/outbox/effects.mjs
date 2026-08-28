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
 * Post a comment on a pull request. AT-LEAST-ONCE, with deduplication that is
 * best-effort by design.
 *
 * The name matters, and an earlier version of this docblock got it wrong by
 * calling the result "at most once". That is a promise this cannot keep, and the
 * repository had already ruled against making it: `docs/2026-08-21-builder-design-
 * audit.md` records the ordinary transactional-outbox contract as at-least-once
 * delivery with idempotent consumers, and never exactly-once. An implementer who
 * reads "at most once" will build on a guarantee that does not exist.
 *
 * What is actually true, in order of strength:
 *
 *  · the outbox's UNIQUE `idem_key` makes double ENQUEUE impossible;
 *  · the fence makes two drainers settling over each other impossible;
 *  · the marker below makes a duplicate COMMENT unlikely.
 *
 * Only the third is about delivery, and "unlikely" is the honest word. A drainer
 * that posts and dies before settling leaves a row recovery returns to pending;
 * the retry's marker read is what stops it posting again, and that read can fail.
 * When it does, this code posts anyway -- see below -- so the duplicate it was
 * meant to prevent happens. That is a deliberate choice about which failure to
 * take, not a gap: a duplicate comment is a nuisance, and a review request that
 * was silently dropped is a pull request that waits forever.
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
 * Create an issue. AT-LEAST-ONCE, with the same best-effort deduplication.
 *
 * This is the first half of a spill: the round cap is reached, the remaining
 * findings have to go somewhere a person will see, and the replies that name the
 * issue depend on its number. See src/outbox/depends.mjs for why that ordering
 * forces two rows rather than one handler.
 *
 * A duplicate ISSUE is a worse nuisance than a duplicate comment — someone has to
 * close it — but the choice is the same one this file already made and for the
 * same reason: findings that were never filed are findings nobody will act on, and
 * an unreadable dedup check is not evidence that no issue exists.
 *
 * The marker is invisible in rendered Markdown, so the issue body carries its own
 * identity without showing it. The AUTHOR is checked alongside it, because the key
 * is derived from public values and anyone who can open an issue could otherwise
 * plant the marker and cause reeve to settle `done` having filed nothing.
 */
export function ghIssueCreate(args, { api, idemKey, actor = null, reconcileOnly = false }) {
  const { nwo, title, body, labels = [] } = args;
  if (!nwo || !title || !body)
    return { ok: false, retryable: false, error: `gh.issue.create needs nwo, title and body; got ${JSON.stringify(args)}` };
  const marker = markerFor(idemKey);

  // Whether GitHub actually ANSWERED, as distinct from whether it said no. On the
  // delivery path both read as "no issue found" and both lead to creating one; the
  // reconciling path turns on the difference exactly.
  let answered = false;
  if (actor) {
    // `state=all`, because a spill issue someone has already closed is still an
    // issue that exists, and re-filing it would be the duplicate this prevents.
    // Filtered in the --jq so a forged marker never reaches this code.
    // BOUNDED, and sorted so the bound is the useful end.
    //
    // `--paginate` over every open and closed issue makes each delivery walk the
    // repository's entire history — on a busy repository that is hundreds of
    // requests before a single POST, on the path that runs on every attempt.
    //
    // Newest first and two pages, because the thing being looked for is an issue
    // THIS effect filed, and an effect is retried within its lease and its backoff
    // rather than months later. The residual is named rather than hidden: an issue
    // pushed past 200 by a flood of newer ones would not be found, and the failure
    // that produces is a duplicate issue — the same failure an unreadable check
    // produces, and the one this file has already ruled is the better direction.
    const seen = api(["-X", "GET", `repos/${nwo}/issues`,
                      "-F", "per_page=100", "-F", "page=1", "-f", "state=all",
                      "-f", "sort=created", "-f", "direction=desc",
                      "--jq", `.[] | select(.user.login == "${actor}") | select(.body // "" | contains("${marker}")) | .number`]);
    if (seen.ok) {
      answered = true;
      const ns = String(seen.out || "").split("\n").map(s => s.trim()).filter(Boolean);
      if (ns.length) return { ok: true, result: { number: Number(ns[0]), alreadyThere: true } };
    }
  }

  if (reconcileOnly)
    return answered
      ? { ok: false, retryable: false,
          error: "the delivery budget is spent and GitHub reports no issue carrying this effect's marker; not filing" }
      : { ok: false, retryable: true,
          error: "the delivery budget is spent and the marker could not be READ, so whether an issue was filed is unknown; not filing" };

  const call = ["-X", "POST", `repos/${nwo}/issues`,
                "-f", `title=${title}`, "-f", `body=${body}\n\n${marker}`];
  for (const l of labels) call.push("-f", `labels[]=${l}`);
  const r = api(call);
  if (!r.ok) return { ok: false, retryable: retryableFrom(r.err), error: r.err };
  let number = null;
  try { number = JSON.parse(r.out).number ?? null; } catch { /* filed; parsing is the convenience */ }
  // The NUMBER is the whole point of this effect: the dependent replies substitute
  // it. A create that succeeded but whose response could not be parsed leaves the
  // dependents with nothing to name, and they would dead-letter on an unresolvable
  // token — which is correct but obscure. Said here instead.
  if (number == null)
    return { ok: false, retryable: true,
             error: "the issue was filed but its number could not be read from the response, and dependent effects need it" };
  return { ok: true, result: { number, alreadyThere: false } };
}

/**
 * Resolve a review thread.
 *
 * Naturally idempotent, and that is why it carries no marker: resolving a thread
 * that is already resolved is not a second effect, it is the same state. So the
 * state is READ first and an already-resolved thread settles `ok` without a write.
 *
 * That read is not an optimisation. `resolveReviewThread` on a thread nobody may
 * resolve fails, and without the read a spill whose threads a human had already
 * tidied would dead-letter — summoning a person to look at work that is done.
 */
export function ghThreadResolve(args, { api, reconcileOnly = false }) {
  // `api` is invoked as `gh api <args>` — the "api" word is supplied by the caller
  // in src/github/app.mjs, not here. Passing it again produces `gh api api graphql`,
  // which fails at run time and in no test that mocks the seam.
  const { threadId } = args;
  if (!threadId)
    return { ok: false, retryable: false, error: `gh.thread.resolve needs threadId; got ${JSON.stringify(args)}` };

  const read = api(["graphql", "-f",
    `query=query($id:ID!){ node(id:$id) { ... on PullRequestReviewThread { isResolved } } }`,
    "-f", `id=${threadId}`, "--jq", ".data.node.isResolved"]);
  if (read.ok && String(read.out).trim() === "true")
    return { ok: true, result: { resolved: true, alreadyThere: true } };

  // A reconciling attempt may CONFIRM, never act. Reaching here means the thread
  // did not read as resolved, so resolving now would act on an attempt the budget
  // had already refused.
  if (reconcileOnly)
    return read.ok
      ? { ok: false, retryable: false, error: "the delivery budget is spent and the thread reads as unresolved; not resolving" }
      : { ok: false, retryable: true, error: "the delivery budget is spent and the thread's state could not be READ; not resolving" };

  const r = api(["graphql", "-f",
    `query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}) { thread { isResolved } } }`,
    "-f", `id=${threadId}`]);
  if (!r.ok) return { ok: false, retryable: retryableFrom(r.err), error: r.err };
  return { ok: true, result: { resolved: true, alreadyThere: false } };
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

/**
 * Kinds the review switch does NOT gate, declared as an exemption list.
 *
 * The gate used to be written the other way round — a list of kinds that ARE
 * gated, with everything else permitted — and that is fail-open by construction:
 * adding a handler silently added an ungated externally-visible effect. It was
 * found exactly that way. `gh.issue.create` was added to HANDLERS, became
 * drainable, and took the unconditional branch, so an operator turning the review
 * switch off would still have had a spill issue filed on their repository from a
 * row queued earlier.
 *
 * Declared HERE, beside the handlers, so adding a handler and deciding whether the
 * switch governs it are the same edit rather than two, the second of which is in
 * another file and easy to miss.
 *
 * Empty today, and that is correct rather than a placeholder: every effect reeve
 * currently performs is a review action.
 */
const UNGATED = Object.freeze([]);

/**
 * Whether the review switch leaves this kind alone.
 *
 * A FUNCTION over a frozen array, not a frozen Set. `Object.freeze` does not
 * freeze a Set's entries — any importer can still call `.add()`, and the gate
 * would then permit that kind with the switch off, from anywhere in the process.
 * An exemption has to be a source-level decision that a reviewer sees, not
 * something a module can grant itself at run time.
 */
export function isUngatedByReviewActions(kind) { return UNGATED.includes(kind); }

/** The exemptions, as data, for a test that asserts there are none. */
export const UNGATED_BY_REVIEW_ACTIONS = UNGATED;

/**
 * The handlers a drainer may use, given whether review actions are permitted.
 *
 * A FUNCTION rather than a filter expression at the call site, because the call
 * site was where the rule went wrong and a rule written at its only call site is
 * indistinguishable from a rule nobody stated. Here it can be exercised directly:
 * a test asserting the exemption set is empty proves the DECLARATION and nothing
 * about whether anything reads it, which is how the first version of this shipped
 * with the daemon still using its own inline allowlist.
 *
 * Expressed as a filter over handlers rather than a condition around the drain, so
 * a kind reeve may not perform is unleaseable rather than merely skipped — the
 * drainer never takes the row, and the "pending with no handler" count says so.
 */
export function permittedHandlers(handlers, reviewActionsAllowed) {
  return Object.fromEntries(Object.entries(handlers ?? {})
    .filter(([kind]) => isUngatedByReviewActions(kind) ? true : Boolean(reviewActionsAllowed)));
}

/** Every kind this build can perform. A kind absent here is never leased. */
export const HANDLERS = Object.freeze({
  "gh.pr.comment": ghPrComment,
  "gh.issue.create": ghIssueCreate,
  "gh.thread.resolve": ghThreadResolve,
});
