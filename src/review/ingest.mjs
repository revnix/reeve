// review/ingest — raw review observations, landed append-only.
//
// This is the WRITE half of review ingest. It fetches what reviewers actually
// said and records it verbatim; nothing here interprets, classifies or decides.
// Deriving rounds, severity and coverage from these rows is a separate, pure
// fold (review/derive.mjs) so that improving a classifier re-reads history rather
// than only affecting whatever happens next.
//
// Three measured properties of the source data shape everything here.
//
//   Editors, not appenders. CodeRabbit rewrites its own history: the summary
//   comment is a living document, inline findings are retro-edited to record
//   resolution, and a commit status was edited to "Review rate limited" twenty
//   seconds before a review landed for the same head. Keyed by id alone, every
//   one of those edits is a silent no-op that loses the earlier text. So the key
//   carries a content hash and an edit becomes generation 2.
//
//   No push time. GitHub reports a push event only for FORCE pushes, and
//   committer-date is a trap: PRs 1123 and 1124 were opened fifteen hours after
//   their commits were authored. reeve's own first sighting of a head is the only
//   honest watermark, so every pinned head is recorded as it is seen.
//
//   Reactions carry no revision. Codex's push-triggered clean pass is a +1
//   reaction on the PR issue -- no comment, no review, nothing naming a commit --
//   and reactions are unique per (user, emoji, item), so a second clean pass
//   produces no new event at all. Recorded because it is evidence the reviewer is
//   alive; it can never be coverage.

import { canonical } from "../db/ops.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const THREADS_QUERY = `query($o:String!,$r:String!,$n:Int!,$c:String){
  repository(owner:$o,name:$r){ pullRequest(number:$n){
    reviewThreads(first:100, after:$c){
      totalCount
      pageInfo{ hasNextPage endCursor }
      nodes{
        id isResolved isOutdated isCollapsed
        resolvedBy{ login }
        path line originalLine
        comments(first:1){ nodes{
          databaseId author{ login } body createdAt updatedAt
          pullRequestReview{ databaseId }
        } }
      }
    } } } }`;

function gh(args) {
  try { return { ok: true, out: execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (e) { return { ok: false, out: "", err: String(e.stderr || e.message).trim() }; }
}

const secs = t => (t ? Math.floor(new Date(t).getTime() / 1000) || null : null);

/**
 * One spelling for one reviewer.
 *
 * The same App answers to two names depending on which API you ask: REST reports
 * `coderabbitai[bot]`, GraphQL reports `coderabbitai`. Measured on nextly #1128,
 * where 71 observations of TWO reviewers arrived under four distinct sources --
 * so half the evidence for each would never have matched a profile roster, which
 * spells them the bare way.
 *
 * Unambiguous because a GitHub username cannot contain a bracket, so a trailing
 * `[bot]` is always the App-identity suffix and never part of a name. The raw
 * login stays in the payload; nothing is lost, only the KEY is normalised.
 */
export function normalizeLogin(login) {
  const s = String(login ?? "unknown");
  return s.endsWith("[bot]") ? s.slice(0, -5) : s;
}

/**
 * Everything reeve can see a reviewer having said on one pull request.
 *
 * Returns {ok, observations, incomplete}. `incomplete` is TRUE when any surface
 * failed or a paginated read was truncated -- the caller records it so the
 * derived state can refuse to answer rather than answering from a partial view.
 * A short read that reports success is how "zero unresolved threads" was reported
 * four times in a row while threads were open.
 */
export function observe(nwo, pr, io = {}) {
  const api = io.gh ?? gh;
  const out = [];
  let incomplete = false;

  // Review objects. commit_id is the FULL forty-hex sha for every author -- only
  // comment BODIES abbreviate -- so this is the one surface that binds exactly.
  const reviews = api([`repos/${nwo}/pulls/${pr}/reviews?per_page=100`]);
  if (!reviews.ok) incomplete = true;
  else for (const r of JSON.parse(reviews.out || "[]")) {
    out.push({ source: normalizeLogin(r.user?.login), external_id: `review:${r.id}`,
               kind: "review", head_sha: r.commit_id || null,
               event_at: secs(r.submitted_at), edited_at: null,
               payload: { login: r.user?.login ?? null, state: r.state,
                          commit_id: r.commit_id || null, body: r.body ?? "" } });
  }

  // Issue comments: refusals, clean passes, trigger commands, rate-limit notices.
  const comments = api([`repos/${nwo}/issues/${pr}/comments?per_page=100`]);
  if (!comments.ok) incomplete = true;
  else for (const c of JSON.parse(comments.out || "[]")) {
    out.push({ source: normalizeLogin(c.user?.login), external_id: `comment:${c.id}`,
               kind: "issue_comment", head_sha: null,
               event_at: secs(c.created_at), edited_at: secs(c.updated_at),
               payload: { login: c.user?.login ?? null, body: c.body ?? "" } });
  }

  // Threads, paginated to completion. Thread node ids are stable across pushes
  // AND force pushes -- measured -- which makes them the identity anchor.
  const [owner, repo] = nwo.split("/");
  let cursor = null, pages = 0, seen = 0, total = null;
  for (;;) {
    const args = ["graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${owner}`, "-F", `r=${repo}`, "-F", `n=${pr}`];
    if (cursor) args.push("-F", `c=${cursor}`);
    const res = api(args);
    if (!res.ok) { incomplete = true; break; }
    const node = JSON.parse(res.out).data?.repository?.pullRequest;
    if (!node) { incomplete = true; break; }
    const t = node.reviewThreads;
    total = t.totalCount;
    seen += t.nodes.length;
    for (const th of t.nodes) {
      const first = th.comments?.nodes?.[0] ?? {};
      out.push({ source: normalizeLogin(first.author?.login), external_id: `thread:${th.id}`,
                 kind: "review_thread", head_sha: null,
                 event_at: secs(first.createdAt), edited_at: secs(first.updatedAt),
                 payload: { thread_id: th.id, is_resolved: !!th.isResolved,
                            is_outdated: !!th.isOutdated,
                            resolved_by: th.resolvedBy?.login ?? null,
                            path: th.path ?? null, line: th.line ?? th.originalLine ?? null,
                            author: first.author?.login ?? null, body: first.body ?? "",
                            review_id: first.pullRequestReview?.databaseId ?? null } });
    }
    if (!t.pageInfo?.hasNextPage || ++pages > 20) break;
    cursor = t.pageInfo.endCursor;
  }
  // Only a read that saw everything it was told exists is complete.
  if (total !== null && seen < total) incomplete = true;

  // Reactions on the PR issue: Codex's push-triggered clean pass, and its "eyes"
  // review-in-progress marker.
  const reactions = api([`repos/${nwo}/issues/${pr}/reactions?per_page=100`]);
  if (!reactions.ok) incomplete = true;
  else for (const x of JSON.parse(reactions.out || "[]")) {
    out.push({ source: normalizeLogin(x.user?.login),
               external_id: `reaction:${normalizeLogin(x.user?.login)}:${x.content}`,
               kind: "reaction", head_sha: null,
               event_at: secs(x.created_at), edited_at: null,
               payload: { login: x.user?.login ?? null, content: x.content } });
  }

  return { ok: !incomplete || out.length > 0, observations: out, incomplete };
}

/** The content hash an edit changes and a re-poll does not. */
export function hashOf(payload) {
  return createHash("sha256").update(canonical(payload)).digest("hex").slice(0, 32);
}

/**
 * Land observations in the inbox, append-only.
 *
 * Re-polling unchanged data writes nothing: the (source, external_id,
 * content_hash) key already holds it. An EDIT lands as a new row with the next
 * generation, so both texts survive and the fold can see that a rewrite happened.
 *
 * One transaction for the whole pull request. A half-landed batch would leave the
 * fold reading a review whose thread is not there yet -- which is exactly the
 * intra-tick race the single-snapshot rule exists to prevent.
 */
export function ingest(db, nwo, pr, observations, { at = Math.floor(Date.now() / 1000) } = {}) {
  const existing = db.prepare(
    `SELECT source, external_id, content_hash, generation FROM inbox WHERE pr_number = ?`).all(pr);
  const byObject = new Map();      // source|external_id -> {hashes:Set, maxGen}
  for (const r of existing) {
    const k = `${r.source}|${r.external_id}`;
    const e = byObject.get(k) ?? { hashes: new Set(), maxGen: 0 };
    e.hashes.add(r.content_hash);
    e.maxGen = Math.max(e.maxGen, r.generation);
    byObject.set(k, e);
  }

  const insert = db.prepare(
    `INSERT INTO inbox (source, external_id, pr_number, head_sha, kind, payload,
                        content_hash, generation, observed_at, event_at, edited_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, external_id, content_hash) DO NOTHING`);

  let inserted = 0, generations = 0, unchanged = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const o of observations) {
      const hash = hashOf(o.payload);
      const k = `${o.source}|${o.external_id}`;
      const e = byObject.get(k);
      if (e?.hashes.has(hash)) { unchanged++; continue; }
      const generation = (e?.maxGen ?? 0) + 1;
      insert.run(o.source, o.external_id, pr, o.head_sha ?? null, o.kind,
                 canonical(o.payload), hash, generation, at,
                 o.event_at ?? null, o.edited_at ?? null);
      if (generation > 1) generations++; else inserted++;
      // Keep the in-memory view current so two observations of the same object in
      // ONE batch do not both claim the same generation.
      byObject.set(k, { hashes: new Set([...(e?.hashes ?? []), hash]), maxGen: generation });
    }
    db.exec("COMMIT");
  } catch (err) { try { db.exec("ROLLBACK"); } catch {} throw err; }

  return { inserted, generations, unchanged, total: observations.length };
}

/**
 * Record that reeve has seen this head, once.
 *
 * first_seen_at is never updated: the watermark is when it was FIRST seen, and
 * refreshing it on every tick would make every head look newly pushed forever.
 */
export function noteHead(db, nwo, pr, sha, at = Math.floor(Date.now() / 1000)) {
  if (!sha || sha.length !== 40) return false;
  const r = db.prepare(
    `INSERT INTO head_seen (nwo, pr, sha, first_seen_at) VALUES (?,?,?,?)
     ON CONFLICT(nwo, pr, sha) DO NOTHING`).run(nwo, pr, sha, at);
  return r.changes > 0;
}

/**
 * Resolve an abbreviated sha from a comment body against heads reeve has seen.
 *
 * Returns the full sha, or null when the prefix is unknown OR matches more than
 * one head. Ambiguous is not "probably the recent one": a review bound to the
 * wrong revision is a stale review counted as covering the current one.
 */
export function resolveAbbrev(db, nwo, pr, abbrev) {
  if (!abbrev || abbrev.length < 7) return null;
  const rows = db.prepare(
    `SELECT sha FROM head_seen WHERE nwo = ? AND pr = ? AND sha LIKE ?`)
    .all(nwo, pr, `${abbrev.toLowerCase()}%`);
  return rows.length === 1 ? rows[0].sha : null;
}
