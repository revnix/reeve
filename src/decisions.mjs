// @ts-check
// `reeve why` and `reeve replay`, over the store's decision records (#165).
//
// A decision record names the evidence a verdict was judged from, the policy and
// the code that judged. `why` shows it. `replay` joins the evidence again and
// recomputes the verdict with the code that's running now, then compares the
// state and every clause. A replay that can't be done is never counted as one
// that agreed.

import { computeVerdict } from "./verdict.mjs";
import { joinEvidence, asJson } from "./evidence.mjs";
import { canonical } from "./db/ops.mjs";
import { latestDecision, decisionsFor, evidenceBy, policyBody } from "./db/records.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */

/** @param {number} s */
const when = s => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 19);
/** @param {unknown} s */
const short = s => (s ? String(s).slice(0, 12) : "unknown");
/** @param {number} a @param {number} b */
const span = (a, b) => (a === b ? when(a) : `${when(a)} to ${when(b)}`);

/**
 * The latest decision for a pull request, or for one of its commits, as `reeve
 * why` shows it: the verdict and every clause with its detail, the evidence it
 * was judged from and when that was seen, and the policy and code that judged.
 * Null when the store holds no record for it.
 * @param {Db} db
 * @param {number} pr
 * @param {{ head?: string | null }} [o]
 */
export function explainDecision(db, pr, { head = null } = {}) {
  const d = latestDecision(db, pr, { head });
  if (!d) return null;
  const r = d.record;
  /** @type {{ id: string, state: string, detail?: string }[]} */
  const clauses = r.verdict.clauses ?? [];
  const out = [`${r.verdict.state} at ${short(r.subject.head)}, tree ${short(r.subject.tree)}, judged ${span(d.first_at, d.last_at)} (record ${short(d.digest)})`];
  if (r.verdict.summary) out.push(`  ${r.verdict.summary}`);
  const w = Math.max(0, ...clauses.map(c => c.id.length));
  for (const c of clauses) out.push(`  ${c.id.padEnd(w)}  ${c.state.padEnd(7)}  ${c.detail ?? ""}`.trimEnd());
  const { found, missing } = evidenceBy(db, Object.values(r.evidence));
  out.push("  judged from:");
  for (const e of found) out.push(`    ${e.kind.padEnd(9)}  seen ${span(e.first_seen, e.last_seen)}  ${e.statement.predicate?.from ?? ""}`.trimEnd());
  for (const m of missing) out.push(`    missing    ${short(m)}: the store no longer holds this evidence`);
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

/** @param {any} a @param {any} b */
const sameCode = (a, b) => a?.commit === b?.commit && a?.tree === b?.tree && a?.dirty === b?.dirty && a?.diff === b?.diff;

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
    out.push({ id: String(id), was: x ? `${x.state}: ${x.detail ?? ""}` : "absent", now: y ? `${y.state}: ${y.detail ?? ""}` : "absent" });
  }
  if (!out.length) out.push({ id: "summary", was: String(was.summary ?? ""), now: String(now.summary ?? "") });
  return out;
}

/**
 * Recompute recorded verdicts with the code that's running, and compare each to
 * what was recorded. A decision whose evidence or policy the store no longer
 * holds, or whose verdict can't be recomputed, is unreplayable: never "same".
 * @param {Db} db
 * @param {{ digest?: string | null, pr?: number | null, since?: number | null }} [which]
 * @param {{ code?: Record<string, unknown> | null, policyHash?: string | null, compute?: typeof computeVerdict }} [now]
 * @returns {Replayed[]}
 */
export function replayDecisions(db, which = {}, { code = null, policyHash = null, compute = computeVerdict } = {}) {
  /** @type {Replayed[]} */
  const results = [];
  for (const d of decisionsFor(db, which)) {
    const r = d.record;
    const base = { digest: d.digest, pr: d.pr, head: d.head, recorded: r.verdict.state,
                   codeChanged: code ? !sameCode(r.code, code) : null,
                   policyChanged: policyHash ? r.policy !== policyHash : null };
    const { found, missing } = evidenceBy(db, Object.values(r.evidence));
    const profile = policyBody(db, r.policy);
    if (missing.length || !profile) {
      results.push({ ...base, outcome: "unreplayable",
                     why: missing.length ? `${missing.length} piece(s) of its evidence are missing` : "its policy is missing" });
      continue;
    }
    let now;
    try {
      const v = compute(/** @type {any} */ (joinEvidence(found.map(e => e.statement), profile)));
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
    const since = [r.codeChanged ? "the code" : null, r.policyChanged ? "the policy" : null].filter(Boolean);
    out.push(since.length ? `    ${since.join(" and ")} changed since it was judged` : "    with the code and policy it was judged with");
  }
  const n = (/** @type {string} */ k) => results.filter(r => r.outcome === k).length;
  out.push(`${results.length} decision(s): ${n("same")} replayed to the same verdict, ${n("differs")} differ, ${n("unreplayable")} could not be replayed`);
  return out.join("\n");
}
