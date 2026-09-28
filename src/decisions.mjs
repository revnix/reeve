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
import { canonical } from "./db/ops.mjs";
import { latestDecision, decisionsFor, evidenceBy, policyRecord, BASELINE_OP, LATEST_OP } from "./db/records.mjs";
import { checkSignature, checkEnvelope, baselineStatement, latestStatement } from "./signing.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */
/** @typedef {Map<string, { key: import("node:crypto").KeyObject, where: string }>} Keys */
/** @typedef {{ began: Set<string>, latest: Map<string, number> }} Anchor */

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
 * It began once it holds a baseline, a signed record or a signed entry of a
 * latest decision, whether or not these check: a baseline that doesn't vouches
 * for nothing.
 * The host's anchor, when given, says so too, for a store that no longer shows it.
 * @param {Db} db
 * @param {Keys} keys
 * @param {Anchor | null} [anchor]
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
  if (!began && anchor?.began.size)
    began = /** @type {any[]} */ (db.prepare(`SELECT DISTINCT json_extract(record, '$.subject.repo') AS repo FROM decision`).all())
      .some((r) => anchor.began.has(r.repo));
  return { began, baseline, why };
}

/**
 * A record's signature as its store's signing reads it. Unsigned, it's one kept
 * before the store began signing only if the store's signed baseline vouches for
 * it: after that, an unsigned record was left unsigned, or had its signature
 * stripped, and isn't trusted.
 * @param {{ digest: string, record: Record<string, any>, envelope?: string | null, unsigned?: string | null }} row
 * @param {Keys} keys
 * @param {ReturnType<typeof signingState>} state
 * @returns {import("./signing.mjs").Signature}
 */
export function trustOf(row, keys, state) {
  const sig = checkSignature(row, keys);
  if (sig.state !== "unsigned" || !state.began) return sig;
  if (state.baseline?.has(row.digest)) return { state: "unsigned", why: "it was kept before this store began signing" };
  return { state: "corrupt", why: `it's unsigned, though it was kept after this store began signing${row.unsigned ? ` (${row.unsigned})` : ""}` +
                                  (state.why ? `, and ${state.why}` : "") };
}

/**
 * The latest decision for a pull request as its signed order says (#165): the
 * digest its highest entry names, each checked as this repository's. Null when
 * it has none, and `corrupt` when an entry doesn't check, or one is missing or
 * named twice.
 * With the host's anchor, an order that ends below the entry this host signed
 * last was cut short: its newest entries were taken away, or the store restored
 * from before them.
 * @param {Db} db
 * @param {number} pr
 * @param {string} repo
 * @param {Keys} keys
 * @param {Anchor | null} [anchor]
 * @returns {{ digest: string, n: number } | { corrupt: string } | null}
 */
export function signedLatest(db, pr, repo, keys, anchor = null) {
  const anchored = anchor?.latest.get(`${repo}#${pr}`) ?? 0;
  const rows = /** @type {any[]} */ (db.prepare(`SELECT payload FROM event WHERE op = ? AND subject = ? ORDER BY seq`).all(LATEST_OP, `pr:${pr}`));
  if (!rows.length)
    return anchored ? { corrupt: `the store holds no signed order of its decisions, though this host signed up to entry ${anchored}` } : null;
  /** @type {Map<number, string>} */ const byN = new Map();
  for (const r of rows) {
    let p;
    try { p = JSON.parse(r.payload); } catch { return { corrupt: "an entry in the signed order of its decisions can't be read" }; }
    const sig = typeof p?.envelope === "string" ? checkEnvelope(p.envelope, latestStatement({ repo, pr, n: p.n, digest: p.digest }), keys, "order")
      : { state: "corrupt", why: "it isn't signed" };
    if (sig.state !== "signed") return { corrupt: `an entry in the signed order of its decisions doesn't hold: ${"why" in sig ? sig.why : ""}` };
    if (byN.has(p.n)) return { corrupt: `the signed order of its decisions names entry ${p.n} twice` };
    byN.set(p.n, String(p.digest));
  }
  const top = Math.max(...byN.keys());
  for (let n = 1; n <= top; n++) if (!byN.has(n)) return { corrupt: `the signed order of its decisions is missing entry ${n}` };
  if (top < anchored) return { corrupt: `the signed order of its decisions ends at entry ${top}, though this host signed up to entry ${anchored}` };
  return { digest: /** @type {string} */ (byN.get(top)), n: top };
}

/**
 * The latest decision for a pull request, or for one of its commits, as `reeve
 * why` shows it: the verdict and every clause with its detail, the evidence it
 * was judged from and when that was seen, and the policy and code that judged.
 * With `keys`, whether it's signed, and by which (#165). Null when the store
 * holds no record for it.
 * @param {Db} db
 * @param {number} pr
 * @param {{ head?: string | null, keys?: Keys | null, anchor?: Anchor | null }} [o]
 */
export function explainDecision(db, pr, { head = null, keys = null, anchor = null } = {}) {
  const d = latestDecision(db, pr, { head });
  if (!d) return null;
  const r = d.record;
  /** @type {{ id: string, state: string, detail?: string, kind?: string, next?: string }[]} */
  const clauses = r.verdict.clauses ?? [];
  const out = [];
  const sig = keys ? trustOf(d, keys, signingState(db, keys, anchor)) : null;
  if (d.corrupt) out.push(`  this record can't be trusted: ${d.corrupt} (record ${short(d.digest)}); it was changed after it was kept`);
  else if (sig?.state === "corrupt") out.push(`  this record can't be trusted: ${sig.why} (record ${short(d.digest)})`);
  // Which is latest, against the signed order, when no commit was named.
  const order = keys && head === null ? signedLatest(db, pr, r.subject?.repo, keys, anchor) : null;
  if (order && "corrupt" in order) out.push(`  this record can't be trusted as the latest: ${order.corrupt}`);
  else if (order && "digest" in order && order.digest !== d.digest)
    out.push(`  this record can't be trusted as the latest: the signed order of this pull request's decisions ends at record ${short(order.digest)}`);
  out.push(`${r.verdict.state} at ${short(r.subject.head)}, tree ${short(r.subject.tree)}, judged ${span(d.first_at, d.last_at)} (record ${short(d.digest)})`);
  if (sig?.state === "signed") out.push(`  signed by key ${short(sig.keyid)}, ${sig.where}`);
  else if (sig?.state === "unsigned") out.push(`  unsigned: ${sig.why}`);
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
  return out.join("\n");
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
 *           keys?: Keys | null, anchor?: Anchor | null }} [now]
 * @returns {Replayed[]}
 */
export function replayDecisions(db, which = {}, { code = null, profile = null, compute = computeVerdict, keys = null, anchor = null } = {}) {
  /** @type {Replayed[]} */
  const results = [];
  const state = keys ? signingState(db, keys, anchor) : null;
  for (const d of decisionsFor(db, which)) {
    const r = d.record;
    const base = { digest: d.digest, pr: d.pr, head: d.head, recorded: r.verdict.state,
                   codeChanged: code ? ((same) => (same === null ? null : !same))(sameCode(r.code, code)) : null,
                   // Per decision, against a profile only for the repository its
                   // record names: a store chosen with --db may be another's.
                   policyChanged: ((current) => (current === null ? null : r.policy !== current))(policyHashFor(profile, r.subject?.repo)) };
    // A record, evidence or policy that doesn't match its digest is not the one
    // its key names, so what it would replay to proves nothing either way.
    if (d.corrupt) { results.push({ ...base, outcome: "unreplayable", why: d.corrupt }); continue; }
    const sig = keys && state ? trustOf(d, keys, state) : null;
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
  return results;
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
    const at = `#${r.pr} at ${short(r.head)} (record ${short(r.digest)})`;
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
