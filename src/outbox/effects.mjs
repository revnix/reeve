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
export function ghPrComment(args, { api, idemKey }) {
  const { nwo, pr, body } = args;
  if (!nwo || !pr || !body) return { ok: false, retryable: false, error: `gh.pr.comment needs nwo, pr and body; got ${JSON.stringify(args)}` };
  const marker = markerFor(idemKey);

  const seen = api(["-X", "GET", `repos/${nwo}/issues/${pr}/comments`,
                    "-F", "per_page=100", "-F", "page=1"]);
  if (seen.ok) {
    let already = null;
    try {
      for (const c of JSON.parse(seen.out || "[]"))
        if (typeof c?.body === "string" && c.body.includes(marker)) already = c.id;
    } catch { /* an unreadable list is not evidence of absence; fall through and post */ }
    if (already !== null) return { ok: true, result: { commentId: already, reposted: false, alreadyThere: true } };
  }

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
  if (/HTTP 4(01|03|04|22)\b/.test(s)) return false;
  if (/Not Found|Unprocessable|Resource not accessible/i.test(s)) return false;
  return true;
}

/** Every kind this build can perform. A kind absent here is never leased. */
export const HANDLERS = Object.freeze({ "gh.pr.comment": ghPrComment });
