/**
 * The SPILL producer: what reeve enqueues instead of asking a worker to do it.
 *
 * A pull request that reaches its review-round cap with non-critical findings still
 * open has them moved to ONE follow-up issue, so they are not lost when the parent
 * merges. That used to be a worker prompt; this builds the same outcome as durable
 * effects, which is the difference between "a worker was asked" and "reeve will do
 * it, and will still do it after a crash".
 *
 * PURE. It returns the effects and enqueues nothing, so every shape below is
 * reachable in a test without a database or a network.
 *
 * THE DEPENDENCY EDGE IS THE WHOLE DESIGN. `idem_key` is fixed at enqueue time --
 * that is what makes a double enqueue impossible -- while a reply must name an issue
 * number that does not exist until the create has delivered. One compound handler
 * would put both writes under one key and one retry budget, so re-running after a
 * successful create and a failed reply would file a SECOND issue. Two rows joined by
 * `depends_on`, with the number substituted at delivery, cannot.
 */

/** A finding stated in a review body has no thread to reply to or resolve. */
export const isBodyFinding = f => f?.anchor === "body";

const text = f => String(f?.body ?? f?.text ?? "").trim();

/**
 * One line per finding, with a permalink PINNED TO THE HEAD.
 *
 * Pinned because the issue outlives the parent: a link to a branch resolves to
 * whatever that branch becomes, so after the merge it points at code the finding was
 * never about. No path means no line to point at, and a permalink built from one
 * anyway is a link to the repository root dressed up as evidence.
 */
export function issueBody({ nwo, pr, head, findings }) {
  const lines = findings.map((f, i) => {
    const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ""} — ` : "";
    const tag = isBodyFinding(f) ? "(stated in the review body, no thread) " : "";
    const link = f.path
      ? `\n   permalink: https://github.com/${nwo}/blob/${head}/${f.path}${f.line ? `#L${f.line}` : ""}`
      : "";
    return `${i + 1}. ${tag}${where}${text(f)}${link}`;
  });
  return `Deferred from #${pr}, which reached its review round cap with these findings still open.\n\n` +
         `${lines.join("\n")}\n\n` +
         `Pinned to ${head}, so the permalinks still resolve after #${pr} merges.`;
}

/**
 * The effects for one spill: the issue, then a reply and a resolve per THREAD.
 *
 * `fingerprint` keys the whole set. Keying on the head would file a fresh issue on
 * every push; keying on the pull request alone would never file a second one even
 * after the findings changed. The fingerprint is the set of findings itself, which is
 * the thing the issue is about.
 *
 * Body findings are carried into the issue and given NO reply and NO resolve: there
 * is no thread, and inventing one would be a comment posted at nothing.
 */
export function spillEffects({ nwo, pr, head, findings = [], fingerprint }) {
  if (!nwo || !pr || !head || !fingerprint)
    throw new Error("spillEffects needs nwo, pr, head and fingerprint");
  const key = `spill:${nwo}#${pr}:${fingerprint}`;
  const parent = {
    idemKey: `${key}:issue`,
    kind: "gh.issue.create",
    args: { nwo, title: `Follow-up from #${pr}: deferred review findings`,
            body: issueBody({ nwo, pr, head, findings }) },
  };
  const threaded = findings.filter(f => !isBodyFinding(f) && f?.thread_id);
  const dependants = [];
  for (const f of threaded) {
    dependants.push({
      idemKey: `${key}:comment:${f.thread_id}`,
      kind: "gh.pr.comment",
      // The token is resolved from the PARENT's result at delivery, so this text is
      // never sent with a placeholder in it: `resolveDependencyArgs` refuses to
      // deliver args whose token could not be filled.
      args: { nwo, pr, body: `Deferred to #\${dep.number}, so it is not lost when this merges.` },
    });
    dependants.push({
      idemKey: `${key}:resolve:${f.thread_id}`,
      kind: "gh.thread.resolve",
      args: { threadId: f.thread_id },
    });
  }
  return { parent, dependants, threaded: threaded.length, carried: findings.length };
}
