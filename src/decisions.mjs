// @ts-check
// `reeve why` and `reeve replay`, over the store's decision records (#165).
//
// A decision record names the evidence a verdict was judged from, the policy and
// the code that judged. `why` shows it. `replay` joins the evidence again and
// recomputes the verdict with the code that's running now, then compares the
// state and every clause. A replay that can't be done is never counted as one
// that agreed.

import { computeVerdict } from "./verdict.mjs";
import { joinEvidence, asJson, policyOf } from "./evidence.mjs";
import { createHash } from "node:crypto";
import { canonical } from "./db/ops.mjs";
import { latestDecision, decisionsFor, decisionOf, evidenceBy, policyRecord, storeIdentity, BASELINE_OP, LATEST_OP, FILED } from "./db/records.mjs";
import { checkSignature, checkEnvelope, baselineStatement, baselineFingerprint, latestStatement, entrySeal } from "./signing.mjs";
import { reservedSeal } from "./anchor.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */
/** @typedef {Map<string, { key: import("node:crypto").KeyObject, where: string }>} Keys */
/**
 * The host's anchor for the repository asked about (#274), as read: `anchor` is
 * null when the host has none, and `why` says why it couldn't be read, which
 * vouches for nothing.
 * @typedef {{ anchor: import("./anchor.mjs").Anchor | null, why: string | null }} AnchorRead
 */

/** @param {number} s */
const when = s => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 19);
/** @param {unknown} s */
const short = s => (s ? String(s).slice(0, 12) : "unknown");
/** @param {number} a @param {number} b */
const span = (a, b) => (a === b ? when(a) : `${when(a)} to ${when(b)}`);

/**
 * Whether a store began signing its decision records (#165), and the records its
 * signed baseline vouches for, kept before it did. Only its first baseline: a
 * later one could list a record signed since, and so launder it once stripped.
 * It began once it holds a baseline, a signed record or an entry of a signed
 * order, whether or not these check: a baseline that doesn't vouches for
 * nothing. Or once the host's anchor says so, for a store that no longer shows
 * it (#274); and when that anchor can't be read, it's taken to have begun, so
 * no unsigned record is vouched for on a store that may have been stripped.
 * @param {Db} db
 * @param {Keys} keys
 * @param {AnchorRead | null} [anchor]
 * @returns {{ began: boolean, baseline: Set<string> | null, why: string | null }}
 */
export function signingState(db, keys, anchor = null) {
  /** @type {Set<string> | null} */ let baseline = null;
  let why = null, began = false;
  for (const r of /** @type {any[]} */ (db.prepare(`SELECT payload FROM event WHERE op = ? ORDER BY seq LIMIT 1`).all(BASELINE_OP))) {
    began = true;
    let p;
    try { p = JSON.parse(r.payload); } catch { why = "its baseline can't be read"; continue; }
    const digests = Array.isArray(p?.digests) ? p.digests.map(String) : [];
    const sig = typeof p?.envelope === "string" ? checkEnvelope(p.envelope, baselineStatement(digests), keys, "baseline")
      : { state: "corrupt", why: "its baseline isn't signed" };
    if (sig.state === "signed") baseline = new Set(digests);
    else why = `its baseline doesn't hold: ${"why" in sig ? sig.why : ""}`;
  }
  if (!began) began = Boolean(db.prepare(`SELECT 1 FROM decision WHERE envelope IS NOT NULL LIMIT 1`).get())
                   || Boolean(db.prepare(`SELECT 1 FROM event WHERE op = ? LIMIT 1`).get(LATEST_OP));
  if (!began && anchor?.anchor?.began) {
    began = true;
    why = "the host's anchor says this store began signing, though the store doesn't show it";
  }
  if (anchor?.why) { began = true; why = why ? `${why}, and ${anchor.why}` : anchor.why; }
  return { began, baseline, why };
}

/**
 * A pull request's signed order of decisions (#274), as its store holds it, each
 * entry checked: of this repository and of `store`, the store's own identity
 * where that isn't given, signed by a known key over exactly its pull request,
 * number and records, and numbered from 1 with none missing and none named
 * twice. With no store to check against, none is taken while the store holds any
 * entry. `top` is its highest entry and
 * `digest` the record that names as latest; 0 and null when the store holds
 * none. `digests` is every record it names, as latest or kept, `entries` the
 * record each entry names as latest, by number, `seals` each entry's seal, by
 * number, and `seq` where in the store's sequence its top entry's latest was
 * seen, null where it doesn't say. With `upTo`, the order as it stood at that
 * event of the store's: its entries recorded up to it.
 * @param {Db} db @param {string} repo @param {number} pr @param {Keys} keys @param {string | null} [store] @param {number | null} [upTo]
 * @returns {{ top: number, digest: string | null, digests: Set<string>, entries: Map<number, string>, seals: Map<number, string>, seq: number | null }
 *         | { corrupt: string }}
 */
export function signedOrder(db, repo, pr, keys, store = storeIdentity(db), upTo = null) {
  // An entry filed under anything but a pull request's own name is found by no
  // pull request's order: its own would read as shorter than it is. So none is
  // taken as checked while one is.
  const stray = strayEntry(db);
  if (stray !== null) return { corrupt: `an entry of a signed order in this store is filed under ${JSON.stringify(stray)}, not a pull request's name` };
  // A store keeps its identity from before its first entry, so one that holds an
  // entry with no store to check it against had its identity taken away: any
  // store's entries would pass for its own, another host's, its key published, say.
  if (store == null && db.prepare(`SELECT 1 FROM event WHERE op = ? LIMIT 1`).get(LATEST_OP))
    return { corrupt: "this store holds entries of signed orders, but no identity to check them against: it was taken away" };
  /** @type {Map<number, string>} */ const byN = new Map();
  /** @type {Map<number, string>} */ const seals = new Map();
  /** @type {Map<number, number | null>} */ const seqs = new Map();
  /** @type {Set<string>} */ const named = new Set();
  for (const r of /** @type {any[]} */ (db.prepare(`SELECT payload FROM event WHERE op = ? AND subject = ? AND (? IS NULL OR seq <= ?) ORDER BY seq`)
    .all(LATEST_OP, `pr:${pr}`, upTo, upTo))) {
    let p;
    try { p = JSON.parse(r.payload); } catch { return { corrupt: "an entry of its signed order can't be read" }; }
    const n = p?.n;
    if (!Number.isInteger(n) || n < 1 || typeof p?.digest !== "string" || typeof p?.repo !== "string"
        || !Array.isArray(p?.records) || p.records.some((/** @type {unknown} */ d) => typeof d !== "string") || !(p.store == null || typeof p.store === "string")
        || !(p.seq == null || (Number.isInteger(p.seq) && p.seq > 0)))
      return { corrupt: "an entry of its signed order isn't one" };
    // GitHub's names don't tell case apart; the entry is checked as it was signed.
    if (p.repo.toLowerCase() !== String(repo).toLowerCase()) return { corrupt: `entry ${n} of its signed order is of ${p.repo}, not of ${repo}` };
    // Another store's, however well signed: another host's, say, whose key is published.
    if (store && p.store !== store) return { corrupt: `entry ${n} of its signed order is another store's` };
    const entry = { repo: p.repo, pr, n, digest: p.digest, records: p.records, store: p.store ?? null, seq: p.seq ?? null };
    const sig = typeof p.envelope === "string" ? checkEnvelope(p.envelope, latestStatement(entry), keys, "entry")
      : { state: "corrupt", why: "it isn't signed" };
    if (sig.state !== "signed") return { corrupt: `entry ${n} of its signed order doesn't hold: ${"why" in sig ? sig.why : ""}` };
    if (byN.has(n)) return { corrupt: `its signed order names entry ${n} twice` };
    byN.set(n, p.digest);
    seals.set(n, entrySeal(entry));
    seqs.set(n, p.seq ?? null);
    named.add(p.digest);
    for (const d of p.records) named.add(d);
  }
  const top = byN.size ? Math.max(...byN.keys()) : 0;
  for (let n = 1; n <= top; n++) if (!byN.has(n)) return { corrupt: `its signed order is missing entry ${n}` };
  return { top, digest: top ? /** @type {string} */ (byN.get(top)) : null, digests: named, entries: byN, seals, seq: top ? seqs.get(top) ?? null : null };
}

/** The store's last event that's an entry of a signed order, 0 where it holds none. @param {Db} db */
export const lastEntrySeq = (db) => Number(/** @type {any} */ (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM event WHERE op = ?`).get(LATEST_OP))?.n ?? 0);

/**
 * A commitment to every signed order the store held at its event `upTo`
 * (#285): sha256 over each pull request's number, top entry and that entry's
 * seal, in number order. Two stores commit alike only where they held the same
 * entries at the top of the same orders, so a copy with one pull request's
 * order taken away, another's swapped in, or its newest entries taken, doesn't
 * commit as the store did, whatever it counts. `corrupt` where an order doesn't
 * hold, or another is filed where no order finds it, and then it commits to
 * nothing.
 * @param {Db} db @param {string} repo @param {Keys} keys @param {string | null} store @param {number} upTo
 * @returns {{ orders: string } | { corrupt: string }}
 */
export function ordersCommitment(db, repo, keys, store, upTo) {
  /** @type {[number, number, string][]} */ const tops = [];
  for (const { subject } of /** @type {any[]} */ (db.prepare(`SELECT DISTINCT subject FROM event WHERE op = ? AND seq <= ?`).all(LATEST_OP, upTo))) {
    const pr = Number(String(subject).slice(3));
    const order = signedOrder(db, repo, pr, keys, store, upTo);
    if ("corrupt" in order) return { corrupt: `#${pr}: ${order.corrupt}` };
    if (order.top) tops.push([pr, order.top, /** @type {string} */ (order.seals.get(order.top))]);
  }
  tops.sort((a, b) => a[0] - b[0]);
  return { orders: createHash("sha256").update(canonical(tops)).digest("hex") };
}

/**
 * The name of an entry of a signed order filed under anything but a pull
 * request's own, `pr:` and its number as reeve writes it, or null where there's
 * none (#274). The name sits outside the entry's signature, and one spelled
 * otherwise, `pr:042` say, is found by no pull request's order.
 * @param {Db} db
 * @returns {string | null}
 */
export function strayEntry(db) {
  const r = /** @type {any} */ (db.prepare(`SELECT COALESCE(subject, '') AS subject FROM event WHERE op = ?
    AND NOT (COALESCE(subject, '') GLOB 'pr:[1-9]*' AND substr(subject, 4) NOT GLOB '*[^0-9]*' AND length(subject) <= 18) LIMIT 1`).get(LATEST_OP));
  return r ? String(r.subject) : null;
}

/**
 * The records the store's signed baseline names, kept before it began signing,
 * that it doesn't hold as they were kept, and no signed order that checks names
 * (#274): taken away, or changed in place, before an order could name them, and
 * found by nothing else, as the baseline says no pull request. Each with why,
 * by digest; none where its baseline doesn't check, which vouches for nothing.
 * `skip` is those checked already, as the records a replay replayed.
 * @param {Db} db @param {string} repo @param {Keys} keys @param {string | null} [store] @param {Set<string>} [skip]
 * @returns {{ digest: string, why: string }[]}
 */
export function baselineLost(db, repo, keys, store = storeIdentity(db), skip = new Set()) {
  const { baseline } = signingState(db, keys);
  if (!baseline?.size) return [];
  const rowOf = db.prepare(`SELECT * FROM decision WHERE digest = ?`);
  /** @type {{ digest: string, why: string }[]} */ const unheld = [];
  for (const digest of [...baseline].sort()) {
    if (skip.has(digest)) continue;
    // Its row, whole: one kept under the digest's name but changed since, its
    // record, pull request or commit, is no more held than one taken away.
    const row = rowOf.get(digest);
    const d = row ? decisionOf(row) : null;
    const lost = !d ? "the store no longer holds it" : d.corrupt ? `the store's copy of it doesn't hold: ${d.corrupt}` : null;
    if (lost) unheld.push({ digest, why: lost });
  }
  if (!unheld.length) return [];
  // One an order names is its order's to report, as replay does.
  /** @type {Set<string>} */ const named = new Set();
  for (const r of /** @type {any[]} */ (db.prepare(`SELECT DISTINCT subject FROM event WHERE op = ? AND subject GLOB 'pr:[1-9]*' AND substr(subject, 4) NOT GLOB '*[^0-9]*' AND length(subject) <= 18`).all(LATEST_OP))) {
    const order = signedOrder(db, repo, Number(String(r.subject).slice(3)), keys, store);
    if ("digests" in order) for (const d of order.digests) named.add(d);
  }
  return unheld.filter((u) => !named.has(u.digest));
}

/**
 * What the store holds besides whole records of `repo`, or null where it holds
 * nothing else (#274): records of another repository, the store of another,
 * named by --db say, or one holding another's beside its own; a record whose
 * repository can't be read, which can't be told to be this one's; one filed
 * under no pull request's number; or one of this repository's that doesn't hold
 * as it was kept, its record changed or its row moved, which can't be told to be
 * this store's own.
 * @param {Db} db @param {string} repo
 * @returns {string | null}
 */
export function otherRepository(db, repo) {
  const r = /** @type {any} */ (db.prepare(`SELECT name FROM (SELECT CASE WHEN json_valid(record) THEN json_extract(record, '$.subject.repo') END AS name FROM decision)
    WHERE name IS NULL OR lower(name) <> lower(?) LIMIT 1`).get(String(repo)));
  if (r) return r.name == null ? "a record whose repository can't be read" : `records of ${r.name}`;
  const unfiled = /** @type {any} */ (db.prepare(`SELECT pr FROM decision WHERE NOT ${FILED} LIMIT 1`).get());
  if (unfiled) return `a record filed under ${unfiled.pr}, which is no pull request's number`;
  for (const row of /** @type {any} */ (db.prepare(`SELECT * FROM decision`)).iterate()) {
    const d = decisionOf(row);
    if (d.corrupt) return `a record of ${repo} that doesn't hold as it was kept (${d.corrupt})`;
  }
  return null;
}

/**
 * The host's anchor as it bears on `db`: as read, where it's this store's or no
 * store's yet, and otherwise one that vouches for nothing here (#274). The
 * anchor is bound to one store per repository, and another store's order and
 * records can't be checked against what that one signed.
 * @param {Db} db @param {AnchorRead | null} anchor @param {string | null} repo
 * @returns {AnchorRead | null}
 */
export function anchorForStore(db, anchor, repo) {
  const bound = anchor?.anchor?.store;
  if (!bound || storeIdentity(db) === bound) return anchor;
  return { anchor: null, why: `the host's anchor for ${repo} is another store's, so this store can't be checked against it` };
}

/**
 * The store whose entries an order of `db` must be: the one the host's anchor is
 * bound to, or, with none, the one the store names itself. Null where neither
 * says, and then no entry is taken, as a store names itself before its first.
 * @param {Db} db @param {AnchorRead | null} anchor
 */
const orderStore = (db, anchor) => anchor?.anchor?.store ?? storeIdentity(db);

/**
 * Whether the store holds a record whole: its row there, reading as the record
 * its digest names. The record names its pull request, so a row moved to
 * another, like one changed, doesn't read whole, and is no more held than one
 * taken away.
 * @param {Db} db @returns {(digest: string) => boolean}
 */
export function holdsWhole(db) {
  const rowOf = db.prepare(`SELECT * FROM decision WHERE digest = ?`);
  return (digest) => {
    const row = rowOf.get(digest);
    return Boolean(row) && !decisionOf(row).corrupt;
  };
}

/**
 * What the host's anchor says of a pull request's signed order besides how far
 * it goes (#279), as why the store isn't current: an entry at its top, or one
 * reserved, that isn't the one the host noted or reserved, naming another
 * record or other records besides, as a copy of the store signed another under
 * that number; an entry reserved that the store's order doesn't hold yet, until
 * a reeve completes it; and each record this host kept and pinned that the
 * store no longer holds and no entry names, taken away though the reeve that
 * kept it stopped before ordering it.
 * @param {{ top: number, digests: Set<string>, entries: Map<number, string>, seals: Map<number, string> }} order
 * @param {number} pr @param {AnchorRead | null} anchor @param {(digest: string) => boolean} held @param {string} repo
 * @returns {string[]}
 */
function anchoredFaults(order, pr, anchor, held, repo) {
  const a = anchor?.anchor;
  if (!a) return [];
  /** @type {string[]} */ const out = [];
  const anchored = a.latest.get(pr) ?? 0;
  const noted = a.named?.get(pr), sealed = a.sealed?.get(pr);
  const another = "a copy of this store signed another entry under that number";
  if (anchored && noted && order.top >= anchored && order.entries.get(anchored) !== noted)
    out.push(`entry ${anchored} of its signed order names record ${short(String(order.entries.get(anchored)))}, though this host noted record ${short(noted)} there: ` +
             "a copy of this store signed another record under that number");
  else if (anchored && sealed && order.top >= anchored && order.seals.get(anchored) !== sealed)
    out.push(`entry ${anchored} of its signed order names record ${short(String(order.entries.get(anchored)))}, as this host noted, but isn't the entry this host noted there: ${another}`);
  const r = a.reserved?.get(pr);
  if (r && order.top >= r.n && order.entries.get(r.n) !== r.digest)
    out.push(`entry ${r.n} of its signed order names record ${short(String(order.entries.get(r.n)))}, though this host reserved it for record ${short(r.digest)}: ` +
             "a copy of this store signed another record under that number");
  else if (r && order.top >= r.n && order.seals.get(r.n) !== reservedSeal(repo, a.store, pr, r))
    out.push(`entry ${r.n} of its signed order names record ${short(r.digest)}, as this host reserved it, but isn't the entry this host reserved: ${another}`);
  else if (r && order.top < r.n)
    out.push(`this host reserved entry ${r.n} of its signed order for record ${short(r.digest)}, which its order doesn't hold yet` +
             `${held(r.digest) ? ", until a reeve completes it" : ", and the store doesn't hold that record: a copy of this store may have signed it"}`);
  const gone = [...(a.pinned?.get(pr) ?? [])].filter((d) => !order.digests.has(d) && !held(d));
  if (gone.length)
    out.push(`this host kept ${gone.length === 1 ? "record" : `${gone.length} records`} ${gone.map(short).join(", ")} for it, which the store no longer holds ` +
             "and no entry of its signed order names: taken away, or a reeve stopped before its store committed it");
  return out;
}

/**
 * What a pull request's signed order, and the host's anchor, say of which
 * record is its latest (#274): why `digest` can't be trusted as that, or null
 * when it can. `order` null is no order read, when the repository isn't known.
 * @param {string} digest  the record the store's own order has as the latest
 * @param {ReturnType<typeof signedOrder> | null} order
 * @param {number} anchored  the highest entry the host signed, 0 for none
 * @param {AnchorRead | null} anchor
 * @param {(digest: string) => boolean} held  whether the store holds a record
 * @param {number} pr
 * @param {(digest: string) => boolean} heldHere  whether it holds a record whole
 * @param {string} repo
 */
function notLatest(digest, order, anchored, anchor, held, pr, heldHere, repo) {
  if (anchor?.why) return anchor.why;
  if (!order) return null;
  if ("corrupt" in order) return order.corrupt;
  if (order.top < anchored)
    return `its signed order ends at entry ${order.top}, though this host signed up to entry ${anchored}: ` +
           "newer records were taken away, or the store restored from before";
  const faults = anchoredFaults(order, pr, anchor, heldHere, repo);
  if (faults.length) return faults.join("; and ");
  if (order.digest && order.digest !== digest)
    return `its signed order ends at record ${short(order.digest)}${held(order.digest) ? "" : ", which the store no longer holds"}`;
  return null;
}

/**
 * A record's signature as its store's signing reads it. Unsigned, it's one kept
 * before the store began signing only if the store's signed baseline vouches for
 * it: after that, an unsigned record was left unsigned, or had its signature
 * stripped, and isn't trusted.
 * @param {{ digest: string, record: Record<string, any>, envelope?: string | null, unsigned?: string | null }} row
 * @param {Keys} keys
 * @param {ReturnType<typeof signingState>} state
 * @param {string | null} [repo]  the repository whose store it is, when known: a record of another isn't trusted
 * @returns {import("./signing.mjs").Signature}
 */
export function trustOf(row, keys, state, repo = null) {
  // Signed by this host, but for another repository: copied into this store, it
  // would pass for one of this repository's own.
  const named = row.record?.subject?.repo;
  if (repo && String(named ?? "").toLowerCase() !== String(repo).toLowerCase())
    return { state: "corrupt", why: `it's a record of ${named ?? "no repository"}, not of ${repo}` };
  const sig = checkSignature(row, keys);
  if (sig.state !== "unsigned" || !state.began) return sig;
  if (state.baseline?.has(row.digest)) return { state: "unsigned", why: "it was kept before this store began signing" };
  return { state: "corrupt", why: `it's unsigned, though it was kept after this store began signing${row.unsigned ? ` (${row.unsigned})` : ""}` +
                                  (state.why ? `, and ${state.why}` : "") };
}

/**
 * The latest decision for a pull request, or for one of its commits, as `reeve
 * why` shows it: the verdict and every clause with its detail, the evidence it
 * was judged from and when that was seen, and the policy and code that judged.
 * With `keys`, whether it's signed, and by which (#165); and, with the
 * repository, which record is latest by its signed order, checked against the
 * host's anchor (#274). Null when the store holds no record for it, and neither
 * its signed order nor the host's anchor says it should.
 * @param {Db} db
 * @param {number} pr
 * @param {{ head?: string | null, keys?: Keys | null, repo?: string | null, anchor?: AnchorRead | null }} [o]
 *        `repo`: the repository asked about; `anchor`: the host's anchor for it
 */
export function explainDecision(db, pr, { head = null, keys = null, repo = null, anchor: read = null } = {}) {
  const anchor = anchorForStore(db, read, repo);
  const d = latestDecision(db, pr, { head });
  // Which record is latest, by the pull request's signed order and the host's
  // anchor: read whether or not the store still holds any record of it.
  const order = keys && repo && head === null ? signedOrder(db, repo, pr, keys, orderStore(db, anchor)) : null;
  const anchored = anchor?.anchor?.latest.get(pr) ?? 0;
  const heldHere = holdsWhole(db);
  if (!d) {
    if (head !== null || !keys) return null;
    // Every record of it gone: taken away, or the store restored from before
    // it had any, where the host's anchor or the signed order says otherwise.
    if (anchor?.why) return `  the store holds no decision record for it, and whether it should can't be told: ${anchor.why}`;
    if (order && "corrupt" in order) return `  the store holds no decision record for it, and ${order.corrupt}`;
    const top = order && "top" in order ? order.top : 0;
    // Where no order or entry says so, the host's anchor may: a record it kept
    // and pinned, or an entry it reserved, that the store no longer holds.
    if (!top && !anchored) {
      const faults = order && "entries" in order ? anchoredFaults(order, pr, anchor, heldHere, String(repo)) : [];
      return faults.length ? `  the store holds no decision record for it, though ${faults.join("; and ")}` : null;
    }
    return `  the store holds no decision record for it, though ` +
           [top ? `its signed order names ${top} entr${top === 1 ? "y" : "ies"}` : "", anchored ? `this host signed up to entry ${anchored} of its order` : ""]
             .filter(Boolean).join(", and ") +
           ": its records were taken away, or the store restored from before";
  }
  const out = [];
  const sig = keys ? trustOf(d, keys, signingState(db, keys, anchor), repo) : null;
  if (d.corrupt) out.push(`  this record can't be trusted: ${d.corrupt} (record ${short(d.digest)}); it was changed after it was kept`);
  else if (sig?.state === "corrupt") out.push(`  this record can't be trusted: ${sig.why} (record ${short(d.digest)})`);
  const held = (/** @type {string} */ digest) => Boolean(db.prepare(`SELECT 1 FROM decision WHERE digest = ? LIMIT 1`).get(digest));
  const notIt = keys && head === null ? notLatest(d.digest, order, anchored, anchor, held, pr, heldHere, String(repo)) : null;
  if (notIt) out.push(`  this record can't be trusted as the latest: ${notIt}`);
  // A record that doesn't hold may not read as one at all, or be none: what
  // can't be shown of it is said, rather than stopping at it (#280).
  try { return [...out, ...shownRecord(db, pr, d, { head, sig, notIt, order })].join("\n"); }
  catch (err) {
    if (!d.corrupt) throw err;
    return [...out, `  nothing more of it can be shown, as it doesn't read as a record`].join("\n");
  }
}

/**
 * The lines `explainDecision` shows of a record: its verdict and every clause,
 * the evidence it was judged from, and the policy and code that judged it.
 * Thrown where it doesn't read as a record.
 * @param {Db} db @param {number} pr @param {import("./db/records.mjs").Decision} d
 * @param {{ head: string | null, sig: import("./signing.mjs").Signature | null, notIt: string | null,
 *           order: ReturnType<typeof signedOrder> | null }} o
 * @returns {string[]}
 */
function shownRecord(db, pr, d, { head, sig, notIt, order }) {
  const r = /** @type {Record<string, any>} */ (d.record);
  /** @type {{ id: string, state: string, detail?: string, kind?: string, next?: string }[]} */
  const clauses = r.verdict.clauses ?? [];
  const out = [];
  out.push(`${r.verdict.state} at ${short(r.subject.head)}, tree ${short(r.subject.tree)}, judged ${span(d.first_at, d.last_at)} (record ${short(d.digest)})`);
  if (sig?.state === "signed") out.push(`  signed by key ${short(sig.keyid)}, ${sig.where}`);
  else if (sig?.state === "unsigned") out.push(`  unsigned: ${sig.why}`);
  // A signature covers a record, not which record is latest. Where the pull
  // request has a signed order, that says so; otherwise it's the store's own
  // order, and said so when more than one record could be.
  const kept = head === null ? Number(/** @type {any} */ (db.prepare(`SELECT count(*) AS n FROM decision WHERE pr = ?`).get(pr))?.n ?? 0) : 0;
  if (!notIt && order && "top" in order && order.top) out.push(`  the latest by its signed order, entry ${order.top}`);
  else if (sig && !notIt && kept > 1) out.push(`  the latest of its ${kept} records by the store's own order, which isn't signed`);
  if (r.verdict.summary) out.push(`  ${r.verdict.summary}`);
  const w = Math.max(0, ...clauses.map(c => c.id.length));
  // An UNKNOWN clause says what kind it is and what happens next (#165).
  for (const c of clauses) out.push(`  ${c.id.padEnd(w)}  ${c.state.padEnd(7)}  ${c.detail ?? ""}${c.kind ? `  [${c.kind}: ${c.next}]` : ""}`.trimEnd());
  const { found, missing, corrupt } = evidenceBy(db, Object.values(r.evidence));
  out.push("  judged from:");
  for (const e of found) out.push(`    ${e.kind.padEnd(9)}  seen ${span(e.first_seen, e.last_seen)}  ${e.statement.predicate?.from ?? ""}`.trimEnd());
  for (const m of missing) out.push(`    missing    ${short(m)}: the store no longer holds this evidence`);
  for (const m of corrupt) out.push(`    corrupt    ${short(m)}: this evidence doesn't match its digest`);
  const c = r.code ?? {};
  out.push(`  policy ${short(r.policy)}, code ${short(c.commit)} (tree ${short(c.tree)})` +
           (c.dirty === null || c.dirty === undefined ? ", whether it differed from that commit is unknown"
            : c.dirty ? `, with uncommitted changes ${short(c.diff)}` : ""));
  return out;
}

/**
 * @typedef {{ digest: string, pr: number, head: string, recorded: string,
 *             outcome: "same" | "differs" | "unreplayable", why?: string, now?: string,
 *             diffs?: { id: string, was: string, now: string }[],
 *             codeChanged: boolean | null, policyChanged: boolean | null }} Replayed
 */

/**
 * Whether two code versions are the same: null when either can't say, because
 * git couldn't read its commit, or whether it differed from it, or by how much.
 * @param {any} a @param {any} b
 */
const sameCode = (a, b) => {
  const readable = v => Boolean(v?.commit) && Boolean(v?.tree) && typeof v.dirty === "boolean" && (!v.dirty || Boolean(v.diff));
  if (!readable(a) || !readable(b)) return null;
  return a.commit === b.commit && a.tree === b.tree && a.dirty === b.dirty && a.diff === b.diff;
};

/**
 * The hash of the policy a repository applies now, which says whether a replayed
 * decision's policy has changed since. It comes only from a profile that names
 * that repository: a checkout's own profile may be another repository's. Null
 * otherwise, which leaves the question unanswered rather than answered wrongly.
 * @param {Record<string, any> | null | undefined} profile
 * @param {string | null | undefined} nwo
 */
export function policyHashFor(profile, nwo) {
  return profile && nwo && profile.identity?.key === nwo ? policyOf(profile).hash : null;
}

/**
 * A clause as replay shows it: its state and detail, and an UNKNOWN's kind and
 * next action (#165).
 * @param {any} c
 */
const shown = c => (c ? `${c.state}: ${c.detail ?? ""}${c.kind ? ` [${c.kind}: ${c.next ?? ""}]` : ""}` : "absent");

/**
 * What changed between two verdicts, clause by clause.
 * @param {any} was @param {any} now
 */
function clauseDiffs(was, now) {
  /** @param {any} v */
  const byId = v => new Map((v.clauses ?? []).map((/** @type {any} */ c) => [c.id, c]));
  const a = byId(was), b = byId(now);
  const out = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id), y = b.get(id);
    if (canonical(x ?? null) === canonical(y ?? null)) continue;
    // A clause that differs only where it isn't shown is shown whole, so a
    // difference is never reported as two equal lines.
    const plain = shown(x) === shown(y);
    out.push({ id: String(id), was: plain ? canonical(x ?? null) : shown(x), now: plain ? canonical(y ?? null) : shown(y) });
  }
  if (!out.length) out.push({ id: "summary", was: String(was.summary ?? ""), now: String(now.summary ?? "") });
  return out;
}

/**
 * Recompute recorded verdicts with the code that's running, and compare each to
 * what was recorded. A decision whose evidence or policy the store no longer
 * holds, or whose verdict can't be recomputed, is unreplayable: never "same".
 * With `keys`, so is one whose signature doesn't hold (#165).
 * @param {Db} db
 * @param {{ digest?: string | null, pr?: number | null, since?: number | null }} [which]
 * @param {{ code?: Record<string, unknown> | null, profile?: Record<string, any> | null, compute?: typeof computeVerdict,
 *           keys?: Keys | null, repo?: string | null, anchor?: AnchorRead | null }} [now]
 *        `repo`: the repository whose store it is, when known; `anchor`: the host's anchor for it (#274)
 * @returns {Replayed[]}
 */
export function replayDecisions(db, which = {}, { code = null, profile = null, compute = computeVerdict, keys = null, repo = null, anchor: read = null } = {}) {
  const anchor = anchorForStore(db, read, repo);
  /** @type {Replayed[]} */
  const results = [];
  const state = keys ? signingState(db, keys, anchor) : null;
  for (const d of decisionsFor(db, which)) {
    // A record, evidence or policy that doesn't match its digest is not the one
    // its key names, so what it would replay to proves nothing either way. Nor
    // what it says it was: it may not read as a record at all (#280).
    if (d.corrupt) {
      const was = /** @type {any} */ (d.record)?.verdict?.state;
      results.push({ digest: d.digest, pr: d.pr, head: d.head, recorded: typeof was === "string" ? was : "unknown",
                     codeChanged: null, policyChanged: null, outcome: "unreplayable", why: d.corrupt });
      continue;
    }
    const r = /** @type {Record<string, any>} */ (d.record);
    const base = { digest: d.digest, pr: d.pr, head: d.head, recorded: r.verdict.state,
                   codeChanged: code ? ((same) => (same === null ? null : !same))(sameCode(r.code, code)) : null,
                   // Per decision, against a profile only for the repository its
                   // record names: a store chosen with --db may be another's.
                   policyChanged: ((current) => (current === null ? null : r.policy !== current))(policyHashFor(profile, r.subject?.repo)) };
    const sig = keys && state ? trustOf(d, keys, state, repo) : null;
    if (sig?.state === "corrupt") { results.push({ ...base, outcome: "unreplayable", why: sig.why }); continue; }
    const { found, missing, corrupt } = evidenceBy(db, Object.values(r.evidence));
    const policy = policyRecord(db, r.policy);
    const why = missing.length ? `${missing.length} piece(s) of its evidence are missing`
      : corrupt.length ? `${corrupt.length} piece(s) of its evidence don't match their digests`
      : !policy ? "its policy is missing"
      : policy.corrupt ? "its policy doesn't match its hash" : null;
    if (why) { results.push({ ...base, outcome: "unreplayable", why }); continue; }
    const recordedPolicy = /** @type {{ body: Record<string, unknown> }} */ (policy).body;
    let now;
    try {
      const v = compute(/** @type {any} */ (joinEvidence(found.map(e => e.statement), recordedPolicy)));
      now = asJson({ state: v.state, summary: v.summary, clauses: v.clauses });
    } catch (err) {
      results.push({ ...base, outcome: "unreplayable", why: `the verdict could not be recomputed: ${/** @type {Error} */ (err).message}` });
      continue;
    }
    if (canonical(now) === canonical(r.verdict)) results.push({ ...base, outcome: "same" });
    else results.push({ ...base, outcome: "differs", now: now.state, diffs: clauseDiffs(r.verdict, now) });
  }
  // Replaying one record, its pull request's order is checked, as a record
  // that survived a rollback replays as the same.
  if (keys && repo && (which.digest == null || results.length))
    results.push(...orderReplayed(db, results, which.digest == null ? which : { pr: results[0].pr }, keys, repo, anchor));
  return results;
}

/**
 * What a store's orders, or what was published of them, say it should hold and
 * it doesn't, as a replay result: of no commit, and never passed over (#274).
 * @param {number} pr @param {string} digest @param {string} why @returns {Replayed}
 */
const fault = (pr, digest, why) => ({ digest, pr, head: "", recorded: "unknown", outcome: "unreplayable", why, codeChanged: null, policyChanged: null });

/**
 * What each pull request's signed order says the store should hold, and the
 * host's anchor (#274), as replay results: an order that doesn't hold, one cut
 * short of what the host signed, and each record it names that the store no
 * longer holds as it was kept, a record taken away, changed or moved to another
 * pull request, adverse perhaps. Never passed over.
 * Every pull request with records replayed, an order or an anchor entry is
 * read, whatever `since` says, or only the one asked for; and, unless one is
 * asked for, each record the store's baseline names that no order names.
 * @param {Db} db @param {Replayed[]} replayed
 * @param {{ pr?: number | null, since?: number | null }} which
 * @param {Keys} keys @param {string} repo @param {AnchorRead | null} anchor
 * @returns {Replayed[]}
 */
function orderReplayed(db, replayed, which, keys, repo, anchor) {
  if (anchor?.why) return [fault(which.pr ?? 0, "", anchor.why)];
  const stray = strayEntry(db);
  if (stray !== null) return [fault(which.pr ?? 0, "", `an entry of a signed order in this store is filed under ${JSON.stringify(stray)}, not a pull request's name`)];
  /** @type {Set<number>} */ const prs = new Set();
  if (which.pr != null) prs.add(which.pr);
  else {
    for (const r of replayed) prs.add(r.pr);
    // Every pull request an order or the host's anchor names, whatever the date:
    // a rollback takes the very records the date would have matched.
    for (const r of /** @type {any[]} */ (db.prepare(`SELECT DISTINCT subject FROM event WHERE op = ? AND subject GLOB 'pr:[1-9]*' AND substr(subject, 4) NOT GLOB '*[^0-9]*' AND length(subject) <= 18`).all(LATEST_OP))) prs.add(Number(String(r.subject).slice(3)));
    for (const pr of anchor?.anchor?.latest.keys() ?? []) prs.add(pr);
    // And every one the anchor reserved an entry of, or pinned a record for (#279).
    for (const pr of anchor?.anchor?.reserved?.keys() ?? []) prs.add(pr);
    for (const pr of anchor?.anchor?.pinned?.keys() ?? []) prs.add(pr);
  }
  // Each record an order names, as the store holds it: a row that isn't that
  // record, or is another pull request's, is no more held than one taken away,
  // though what was asked for left it out of the replay. One replayed above as
  // this pull request's was checked whole there.
  const rowOf = db.prepare(`SELECT * FROM decision WHERE digest = ?`);
  const whole = holdsWhole(db);
  const checked = new Set(replayed.map((r) => `${r.pr} ${r.digest}`));
  /** @type {Replayed[]} */ const out = [];
  const store = orderStore(db, anchor);
  for (const pr of [...prs].sort((a, b) => a - b)) {
    const order = signedOrder(db, repo, pr, keys, store);
    if ("corrupt" in order) { out.push(fault(pr, "", order.corrupt)); continue; }
    const anchored = anchor?.anchor?.latest.get(pr) ?? 0;
    if (order.top < anchored)
      out.push(fault(pr, order.digest ?? "", `its signed order ends at entry ${order.top}, though this host signed up to entry ${anchored}: ` +
                                             "newer records were taken away, or the store restored from before"));
    for (const why of anchoredFaults(order, pr, anchor, whole, repo)) out.push(fault(pr, order.digest ?? "", why));
    for (const digest of order.digests) {
      if (checked.has(`${pr} ${digest}`)) continue;
      const row = rowOf.get(digest);
      const d = row ? decisionOf(row) : null;
      const why = !d ? "the store no longer holds it"
        : d.corrupt ? `the store's copy of it doesn't hold: ${d.corrupt}`
        : d.pr !== pr ? `the store holds it as pull request ${d.pr}'s`
        : null;
      if (why) out.push(fault(pr, digest, `its signed order names this record, but ${why}`));
    }
  }
  // And each record the store's signed baseline names that it doesn't hold as it
  // was kept, and no order names: taken away or changed before its first entry,
  // it's found by nothing else, unless replayed above. The baseline says no pull
  // request, so it's read replaying the whole store, or since a date.
  // And a binding the host's anchor began for this store (#281): its baseline
  // must be the one it was begun with, signed by a key this host knows, or where
  // there's none, the store must hold every record it was begun with. A store
  // stripped of its baseline and some of those records would otherwise read as
  // one that never began signing.
  const begun = which.pr == null ? bindingDiffers(db, anchor, keys) : null;
  if (begun) out.push(fault(0, "", begun));
  if (which.pr == null) for (const lost of baselineLost(db, repo, keys, store, new Set(replayed.map((r) => r.digest))))
    out.push(fault(0, lost.digest, `the store's baseline names this record, kept before it began signing, and no signed order names it, but ${lost.why}`));
  return out;
}

/**
 * A copy of a store checked against what the merge policy published of it
 * (#274). Each result it posts on a pull request's head names the record kept
 * for its verdict, where the pull request's signed order stood, and a
 * commitment to every order the store held up to an event of its own (#285);
 * GitHub keeps that out of reach of whoever can change the store. So a copy
 * checked away from the host, with no anchor to check it against, still shows
 * as cut short, restored from before or edited: each published record must be
 * held whole, as its pull request's; each published entry reached, naming the
 * published record; and the copy's orders up to each published event must
 * commit as the store's did, so a pull request whose orders were taken away,
 * or swapped for others, shows in what was published for any other. The pull
 * requests read are every one the copy holds records or an order of, and every
 * one GitHub lists, as `listed` reads them, so one the copy no longer names is
 * read all the same; or the one asked for. `published` and `listed` read
 * GitHub, and one that can't be read is a fault, never a pass; so is a copy
 * nothing published could be checked against. `results` counts the published
 * results checked, `prs` the pull requests read, and `unchecked` names those
 * of the copy's with nothing published to check against, judged before it
 * began say.
 * @param {Db} db
 * @param {{ pr?: number | null, digest?: string | null }} which
 * @param {{ keys: Keys, repo: string, anchor?: AnchorRead | null,
 *           published: (pr: number, heads: string[]) => { evidence: (import("./published.mjs").Evidence & { head: string })[] } | { why: string },
 *           listed?: (() => number[] | { why: string }) | null }} o
 * @returns {{ faults: Replayed[], results: number, prs: number, unchecked: number[] }}
 */
export function publishedChecked(db, which, { keys, repo, anchor: read = null, published, listed = null }) {
  const anchor = anchorForStore(db, read, repo);
  /** @type {Set<number>} */ const prs = new Set();
  /** @type {Set<number>} */ const own = new Set();
  /** @type {Replayed[]} */ const faults = [];
  if (which.pr != null) own.add(which.pr);
  else if (which.digest != null) for (const d of decisionsFor(db, { digest: which.digest })) own.add(d.pr);
  else {
    // Each it holds records of, and each it holds an order of, its records taken away or not.
    for (const { pr } of /** @type {any[]} */ (db.prepare(`SELECT DISTINCT pr FROM decision WHERE ${FILED}`).all())) own.add(Number(pr));
    for (const { subject } of /** @type {any[]} */ (db.prepare(`SELECT DISTINCT subject FROM event WHERE op = ? AND subject GLOB 'pr:[1-9]*' AND substr(subject, 4) NOT GLOB '*[^0-9]*' AND length(subject) <= 18`).all(LATEST_OP))) own.add(Number(String(subject).slice(3)));
    // And each GitHub lists: one the copy no longer names, taken away with every
    // record and entry of it, is read all the same (#285).
    const got = listed ? listed() : [];
    if ("why" in got) faults.push(fault(0, "", `the repository's pull requests couldn't be listed from GitHub, so one this copy no longer names may be missed: ${got.why}`));
    else for (const n of got) prs.add(n);
  }
  for (const n of own) prs.add(n);
  const rowOf = db.prepare(`SELECT * FROM decision WHERE digest = ?`);
  const headsOf = db.prepare(`SELECT DISTINCT head FROM decision WHERE pr = ? ORDER BY head`);
  const store = orderStore(db, anchor);
  // The same result is often published at more than one head, and said once.
  const said = new Set();
  const say = (/** @type {number} */ pr, /** @type {string} */ digest, /** @type {string} */ why) => {
    if (!said.has(`${pr} ${digest} ${why}`)) { said.add(`${pr} ${digest} ${why}`); faults.push(fault(pr, digest, why)); }
  };
  let results = 0;
  /** @type {number[]} */ const unchecked = [];
  // Each commitment published, to the event it covers, and where it was first read.
  /** @type {Map<string, { to: number, orders: string, head: string, pr: number }>} */ const commitments = new Map();
  for (const pr of [...prs].sort((a, b) => a - b)) {
    const heads = /** @type {any[]} */ (headsOf.all(pr)).map((r) => String(r.head)).filter((h) => /^[0-9a-f]{40}$/.test(h));
    const got = published(pr, heads);
    if ("why" in got) { say(pr, "", `what the merge policy published for it couldn't be read, so this copy wasn't checked against it: ${got.why}`); continue; }
    const order = signedOrder(db, repo, pr, keys, store);
    if (!got.evidence.length && own.has(pr)) unchecked.push(pr);
    for (const e of got.evidence) {
      results++;
      const key = `${e.store.to} ${e.store.orders}`;
      if (!commitments.has(key)) commitments.set(key, { ...e.store, head: e.head, pr });
      const at = e.head.slice(0, 8);
      const row = rowOf.get(e.record);
      const d = row ? decisionOf(row) : null;
      const why = !d ? "this copy doesn't hold it"
        : d.corrupt ? `this copy's doesn't hold: ${d.corrupt}`
        : d.pr !== pr ? `this copy holds it as pull request ${d.pr}'s`
        : null;
      if (why) say(pr, e.record, `the merge policy published this record for it at ${at}, but ${why}`);
      // An order that doesn't hold is the replay's to report.
      if (!e.order || "corrupt" in order) continue;
      const named = order.entries.get(e.order.n);
      if (order.top < e.order.n)
        say(pr, e.order.names, `the merge policy published entry ${e.order.n} of its signed order at ${at}, but this copy's ends at entry ${order.top}: ` +
                               "newer records were taken away, or the copy is from before");
      else if (named !== e.order.names)
        say(pr, e.order.names, `the merge policy published entry ${e.order.n} of its signed order at ${at} naming ${short(e.order.names)}, but this copy's entry ${e.order.n} names ${short(named)}`);
    }
  }
  if (!results && !faults.length)
    faults.push(fault(which.pr ?? 0, "", "no result the merge policy published names a record of these pull requests, so this copy wasn't checked against GitHub"));
  // Every order the copy held up to each event a result published, committed as
  // that result committed the store's (#285): an order taken away, swapped in,
  // or cut short shows, whichever pull request's result carried it. One that
  // doesn't hold is the replay's to report, and commits to nothing here.
  for (const c of [...commitments.values()].sort((a, b) => a.to - b.to)) {
    const mine = ordersCommitment(db, repo, keys, store, c.to);
    if ("corrupt" in mine) continue;
    if (mine.orders !== c.orders)
      faults.push(fault(0, "", `the merge policy published with #${c.pr}'s result at ${c.head.slice(0, 8)} the signed orders this store held to its event ${c.to}, ` +
                               "but this copy's orders to that event aren't those: an order was taken away, changed or swapped in, or the copy is from before"));
  }
  return { faults, results, prs: prs.size, unchecked };
}

/**
 * Why a binding the host's anchor began for this store (#281) doesn't hold, or
 * null: the store's baseline isn't the one the binding was begun with, signed
 * by a key this host knows, as binding reads it; or where it has none, the
 * store doesn't hold exactly the records the binding was begun with, each as it
 * was kept, as no record is kept while its baseline waits. A binding begun for
 * another store isn't this one's to say.
 * @param {Db} db @param {AnchorRead | null} anchor @param {Keys} keys @returns {string | null}
 */
function bindingDiffers(db, anchor, keys) {
  const p = anchor?.anchor?.pending;
  if (!p) return null;
  const id = storeIdentity(db);
  if (id && id !== p.store) return null;
  const begun = "the host's anchor was being bound to this store";
  const other = `${begun}, holding other records than it holds now: records were taken away, or the store restored from before`;
  if (db.prepare(`SELECT 1 FROM event WHERE op = ? LIMIT 1`).get(BASELINE_OP)) {
    // The first, as the store's signing reads it.
    const { baseline, why } = signingState(db, keys);
    if (!baseline) return `${begun}, and ${why ?? "its baseline doesn't hold"}`;
    return baselineFingerprint([...baseline]) === p.baseline ? null : other;
  }
  const whole = holdsWhole(db);
  const held = /** @type {any[]} */ (db.prepare(`SELECT digest FROM decision`).all()).map((r) => String(r.digest));
  return baselineFingerprint(held) === p.baseline && p.digests.every((d) => whole(d)) ? null : other;
}

/**
 * The replay's report: every decision that didn't replay to the same verdict,
 * with why, then the counts.
 * @param {Replayed[]} results
 */
export function renderReplay(results) {
  const out = [];
  for (const r of results) {
    if (r.outcome === "same") continue;
    // What the signed order says the store should hold names no commit (#274).
    const at = r.head ? `#${r.pr} at ${short(r.head)} (record ${short(r.digest)})`
      : r.pr ? `#${r.pr}${r.digest ? ` (record ${short(r.digest)})` : ""}` : `the store${r.digest ? ` (record ${short(r.digest)})` : ""}`;
    if (r.outcome === "unreplayable") { out.push(`${at}: could not be replayed: ${r.why}`); continue; }
    out.push(`${at}: was ${r.recorded}, now ${r.now}`);
    for (const x of r.diffs ?? []) out.push(`    ${x.id}: was ${x.was}`, `    ${" ".repeat(x.id.length)}  now ${x.now}`);
    // What changed since it was judged, and what can't be told: a comparison
    // that couldn't be made is never reported as nothing having changed.
    const changed = [r.codeChanged ? "the code" : null, r.policyChanged ? "the policy" : null].filter(Boolean);
    const unknown = [r.codeChanged === null ? "the code" : null, r.policyChanged === null ? "the policy" : null].filter(Boolean);
    if (changed.length) out.push(`    ${changed.join(" and ")} changed since it was judged`);
    for (const u of unknown) out.push(`    whether ${u} changed since is unknown`);
    if (!changed.length && !unknown.length) out.push("    with the code and policy it was judged with");
  }
  const n = (/** @type {string} */ k) => results.filter(r => r.outcome === k).length;
  out.push(`${results.length} decision(s): ${n("same")} replayed to the same verdict, ${n("differs")} differ, ${n("unreplayable")} could not be replayed`);
  return out.join("\n");
}
