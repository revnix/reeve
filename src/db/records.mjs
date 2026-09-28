// @ts-check
// The store's evidence and decision records (#165). They are written with the
// decision they explain, in the tick's transaction, and read by `reeve why` and
// `reeve replay`.
//
// Each record is kept under the digest of what it says, and is checked against
// that digest whenever it's read: a row changed in place, by a repair or by
// corruption that still parses, would otherwise be trusted as the record its key
// names.

import { canonical } from "./ops.mjs";
import { digestOf, evidenceDigestOf } from "../evidence.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */

/** A commit or record named by a start that is not hexadecimal, or that more than one shares. */
export class SelectorError extends Error {}

/**
 * The start of a commit or a digest as it was typed: hexadecimal only, and
 * compared as text, never read as a pattern.
 * @param {string} typed @param {string} what @param {number} max
 */
function hexStart(typed, what, max) {
  const s = String(typed).toLowerCase();
  if (!/^[0-9a-f]+$/.test(s) || s.length < 4 || s.length > max)
    throw new SelectorError(`${what} must be 4 to ${max} hexadecimal characters, got ${JSON.stringify(String(typed))}`);
  return s;
}

/**
 * Save a decision with its evidence and its policy, under the seq of the
 * `pr.decided` event that names it. Call it inside that event's transaction, so
 * neither stands without the other. A record already held is seen again: its
 * first sighting stays, and its last moves on.
 *
 * `signed` is its signature (#165), or why it has none. A record held unsigned
 * that is signed when seen again keeps that signature, which is over exactly
 * what it says; one held signed keeps the signature it has.
 * @param {Db} db
 * @param {{ at: number, seq: number, pr: number, head: string, policy: { hash: string, body: unknown },
 *           evidence: { kind: string, digest: string, statement: unknown }[],
 *           decision: { digest: string, record: unknown },
 *           signed?: { envelope?: string, unsigned?: string } }} r
 */
export function saveDecision(db, { at, seq, pr, head, policy, evidence, decision, signed = {} }) {
  db.prepare(`INSERT INTO policy(hash, body, first_seen) VALUES(?,?,?) ON CONFLICT(hash) DO NOTHING`)
    .run(policy.hash, canonical(policy.body), at);
  const put = db.prepare(`INSERT INTO evidence(digest, kind, statement, first_seen, last_seen) VALUES(?,?,?,?,?)
                          ON CONFLICT(digest) DO UPDATE SET last_seen = excluded.last_seen`);
  for (const e of evidence) put.run(e.digest, e.kind, canonical(e.statement), at, at);
  const envelope = signed.envelope ?? null;
  const unsigned = envelope ? null : (signed.unsigned ?? "no signature was made for it");
  db.prepare(`INSERT INTO decision(digest, pr, head, record, first_at, last_at, first_seq, last_seq, envelope, unsigned) VALUES(?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(digest) DO UPDATE SET last_at = excluded.last_at, last_seq = excluded.last_seq,
                envelope = COALESCE(decision.envelope, excluded.envelope),
                unsigned = CASE WHEN COALESCE(decision.envelope, excluded.envelope) IS NULL THEN excluded.unsigned END`)
    .run(decision.digest, pr, head, canonical(decision.record), at, at, seq, seq, envelope, unsigned);
}

/** The event that says a store began signing, with its baseline (#165). */
export const BASELINE_OP = "signing.baseline";

/**
 * @typedef {{ digest: string, pr: number, head: string, record: Record<string, any>, corrupt: string | null,
 *             first_at: number, last_at: number, first_seq: number, last_seq: number,
 *             envelope: string | null, unsigned: string | null }} Decision
 */

/**
 * A decision row, and why it can't be trusted, if it can't. Its record must match
 * its digest, and the pull request and commit the row is found by, which sit
 * outside the digest, must be the ones its record names.
 * @param {any} row @returns {Decision}
 */
const decisionOf = row => {
  const record = JSON.parse(row.record);
  const subject = record?.subject ?? {};
  const corrupt = digestOf(record) !== row.digest ? "its record doesn't match its digest"
    : subject.pr !== row.pr ? `its row names pull request ${row.pr}, but its record ${subject.pr}`
    : subject.head !== row.head ? `its row names commit ${String(row.head).slice(0, 8)}, but its record ${String(subject.head).slice(0, 8)}`
    : null;
  return { ...row, record, corrupt };
};

/**
 * The latest decision for a pull request, or for one of its commits, named by
 * its start. A start that more than one of its commits shares is refused.
 * @param {Db} db
 * @param {number} pr
 * @param {{ head?: string | null }} [o]
 * @returns {Decision | null}
 */
export function latestDecision(db, pr, { head = null } = {}) {
  let at = null;
  if (head !== null) {
    const s = hexStart(head, "a commit", 40);
    const heads = db.prepare(`SELECT DISTINCT head FROM decision WHERE pr = ? AND substr(head, 1, ?) = ?`).all(pr, s.length, s);
    if (heads.length > 1) throw new SelectorError(`${head} is ambiguous: it starts ${heads.length} commits this pull request was judged at`);
    if (!heads.length) return null;
    at = /** @type {any} */ (heads[0]).head;
  }
  const row = at
    ? db.prepare(`SELECT * FROM decision WHERE pr = ? AND head = ? ORDER BY last_seq DESC LIMIT 1`).get(pr, at)
    : db.prepare(`SELECT * FROM decision WHERE pr = ? ORDER BY last_seq DESC LIMIT 1`).get(pr);
  return row ? decisionOf(row) : null;
}

/**
 * Decisions to replay, oldest first: one by the start of its digest, a pull
 * request's, or every one still being judged at or after a time. A start that
 * more than one record shares is refused.
 * @param {Db} db
 * @param {{ digest?: string | null, pr?: number | null, since?: number | null }} [o]
 * @returns {Decision[]}
 */
export function decisionsFor(db, { digest = null, pr = null, since = null } = {}) {
  /** @type {string[]} */ const where = [];
  /** @type {(string | number)[]} */ const args = [];
  if (digest !== null) {
    const s = hexStart(digest, "a record", 64);
    where.push("substr(digest, 1, ?) = ?"); args.push(s.length, s);
  }
  if (pr !== null) { where.push("pr = ?"); args.push(pr); }
  if (since !== null) { where.push("last_at >= ?"); args.push(since); }
  const sql = `SELECT * FROM decision ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY first_seq, digest`;
  const rows = db.prepare(sql).all(...args);
  if (digest !== null && rows.length > 1) throw new SelectorError(`${digest} is ambiguous: it starts ${rows.length} records`);
  return rows.map(decisionOf);
}

/**
 * Evidence statements by digest. A digest the store doesn't hold is missing, and
 * one whose statement no longer matches it is corrupt: neither is skipped, since
 * a replay without all its evidence, as recorded, proves nothing.
 * @param {Db} db
 * @param {string[]} digests
 */
export function evidenceBy(db, digests) {
  const get = db.prepare(`SELECT * FROM evidence WHERE digest = ?`);
  /** @type {{ digest: string, kind: string, statement: Record<string, any>, first_seen: number, last_seen: number }[]} */
  const found = [];
  /** @type {string[]} */ const missing = [];
  /** @type {string[]} */ const corrupt = [];
  for (const d of digests) {
    const r = /** @type {any} */ (get.get(d));
    if (!r) { missing.push(d); continue; }
    const statement = JSON.parse(r.statement);
    if (evidenceDigestOf(statement) !== d) { corrupt.push(d); continue; }
    found.push({ ...r, statement });
  }
  return { found, missing, corrupt };
}

/**
 * The policy recorded under a hash, and whether it still matches it; null when
 * the store doesn't hold it.
 * @param {Db} db
 * @param {string} hash
 * @returns {{ body: Record<string, unknown>, corrupt: boolean } | null}
 */
export function policyRecord(db, hash) {
  const r = /** @type {any} */ (db.prepare(`SELECT body FROM policy WHERE hash = ?`).get(hash));
  if (!r) return null;
  const body = JSON.parse(r.body);
  return { body, corrupt: digestOf(body) !== hash };
}

/**
 * The policy recorded under a hash, or null when the store doesn't hold it or it
 * no longer matches the hash.
 * @param {Db} db
 * @param {string} hash
 * @returns {Record<string, unknown> | null}
 */
export function policyBody(db, hash) {
  const p = policyRecord(db, hash);
  return p && !p.corrupt ? p.body : null;
}
