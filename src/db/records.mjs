// @ts-check
// The store's evidence and decision records (#165). They are written with the
// decision they explain, in the tick's transaction, and read by `reeve why` and
// `reeve replay`.

import { canonical } from "./ops.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */

/**
 * Save a decision with its evidence and its policy. Call it inside the
 * transaction that writes the `pr.decided` event naming the decision, so neither
 * stands without the other. A record already held is seen again: its first
 * sighting stays, and its last moves on.
 * @param {Db} db
 * @param {{ at: number, pr: number, head: string, policy: { hash: string, body: unknown },
 *           evidence: { kind: string, digest: string, statement: unknown }[],
 *           decision: { digest: string, record: unknown } }} r
 */
export function saveDecision(db, { at, pr, head, policy, evidence, decision }) {
  db.prepare(`INSERT INTO policy(hash, body, first_seen) VALUES(?,?,?) ON CONFLICT(hash) DO NOTHING`)
    .run(policy.hash, canonical(policy.body), at);
  const put = db.prepare(`INSERT INTO evidence(digest, kind, statement, first_seen, last_seen) VALUES(?,?,?,?,?)
                          ON CONFLICT(digest) DO UPDATE SET last_seen = excluded.last_seen`);
  for (const e of evidence) put.run(e.digest, e.kind, canonical(e.statement), at, at);
  db.prepare(`INSERT INTO decision(digest, pr, head, record, first_at, last_at) VALUES(?,?,?,?,?,?)
              ON CONFLICT(digest) DO UPDATE SET last_at = excluded.last_at`)
    .run(decision.digest, pr, head, canonical(decision.record), at, at);
}

/**
 * @typedef {{ digest: string, pr: number, head: string, record: Record<string, any>, first_at: number, last_at: number }} Decision
 */

/** @param {any} row @returns {Decision} */
const decisionOf = row => ({ ...row, record: JSON.parse(row.record) });

/**
 * The latest decision for a pull request, or for one of its commits.
 * @param {Db} db
 * @param {number} pr
 * @param {{ head?: string | null }} [o]  a commit, or the start of one
 * @returns {Decision | null}
 */
export function latestDecision(db, pr, { head = null } = {}) {
  const row = head
    ? db.prepare(`SELECT * FROM decision WHERE pr = ? AND head LIKE ? ORDER BY last_at DESC, first_at DESC LIMIT 1`).get(pr, `${head}%`)
    : db.prepare(`SELECT * FROM decision WHERE pr = ? ORDER BY last_at DESC, first_at DESC LIMIT 1`).get(pr);
  return row ? decisionOf(row) : null;
}

/**
 * Decisions to replay, oldest first: one by its digest (or the start of it), a
 * pull request's, or every one still being judged at or after a time.
 * @param {Db} db
 * @param {{ digest?: string | null, pr?: number | null, since?: number | null }} [o]
 * @returns {Decision[]}
 */
export function decisionsFor(db, { digest = null, pr = null, since = null } = {}) {
  /** @type {string[]} */ const where = [];
  /** @type {(string | number)[]} */ const args = [];
  if (digest) { where.push("digest LIKE ?"); args.push(`${digest}%`); }
  if (pr !== null) { where.push("pr = ?"); args.push(pr); }
  if (since !== null) { where.push("last_at >= ?"); args.push(since); }
  const sql = `SELECT * FROM decision ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY first_at, digest`;
  return db.prepare(sql).all(...args).map(decisionOf);
}

/**
 * Evidence statements by digest. A digest the store doesn't hold is listed as
 * missing, never skipped: a replay without all its evidence proves nothing.
 * @param {Db} db
 * @param {string[]} digests
 */
export function evidenceBy(db, digests) {
  const get = db.prepare(`SELECT * FROM evidence WHERE digest = ?`);
  /** @type {{ digest: string, kind: string, statement: Record<string, any>, first_seen: number, last_seen: number }[]} */
  const found = [];
  /** @type {string[]} */ const missing = [];
  for (const d of digests) {
    const r = /** @type {any} */ (get.get(d));
    if (r) found.push({ ...r, statement: JSON.parse(r.statement) });
    else missing.push(d);
  }
  return { found, missing };
}

/**
 * The policy recorded under a hash, or null when the store doesn't hold it.
 * @param {Db} db
 * @param {string} hash
 * @returns {Record<string, unknown> | null}
 */
export function policyBody(db, hash) {
  const r = /** @type {any} */ (db.prepare(`SELECT body FROM policy WHERE hash = ?`).get(hash));
  return r ? JSON.parse(r.body) : null;
}
