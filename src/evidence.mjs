// @ts-check
// Evidence records and decision records (#165).
//
// `computeVerdict` is pure: it reads only the object `evaluatePr` builds for it.
// So a verdict can be audited and replayed exactly if that object is kept. It is
// kept as evidence records, one per source, each in the in-toto Statement v1
// shape and unsigned for now, and a decision record that names them with the
// policy that was applied and the code that judged.
//
// A record's digest covers what it says, never when it was seen: a reading that
// doesn't change between ticks is one record, seen again.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { canonical } from "./db/ops.mjs";
import { GIT_NEUTRALISE } from "./gitguard.mjs";

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const EVIDENCE_PREDICATE = "https://revnix.com/reeve/evidence/v1";
export const DECISION_VERSION = 1;

/**
 * Which parts of the verdict's input each source supplies, and where the source
 * read them. A key no source claims goes to `other`, so nothing the verdict read
 * is left out of its evidence.
 * @type {Readonly<Record<string, { keys: readonly string[], from: string }>>}
 */
export const SOURCES = Object.freeze({
  head: { keys: ["head"], from: "the pull request and its branch, read from GitHub" },
  checks: { keys: ["checks"], from: "check runs and statuses at the head, read from GitHub and settled across ticks" },
  base: { keys: ["base"], from: "the base branch's own checks, read from GitHub" },
  reviewers: { keys: ["reviewers"], from: "reviews and comments, read from GitHub" },
  reviews: { keys: ["rounds", "threads", "cleared", "bodyFindings", "unreadableBodies"],
             from: "review threads read from GitHub, and the store's review projection" },
  ledger: { keys: ["ledgerBlockers"], from: "the store's ledger of findings" },
  merge: { keys: ["mergeState", "mergeParts"], from: "merge state, the base's rules and the head's distance, read from GitHub" },
  hold: { keys: ["hold"], from: "the hub's holds" },
});

/** The input key the policy travels under. It is recorded once, by hash, not as evidence. */
const POLICY_KEY = "profile";

/**
 * A value as stored JSON holds it: an undefined key gone, a date as its string.
 * @param {unknown} v
 */
export const asJson = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * The sha256 of a value's canonical JSON.
 * @param {unknown} v
 */
export function digestOf(v) {
  return createHash("sha256").update(canonical(asJson(v) ?? null)).digest("hex");
}

/**
 * The policy applied: the validated profile, without the path it was read from,
 * which says where the policy lives and not what it is.
 * @param {Record<string, unknown>} profile
 */
export function policyOf(profile) {
  const body = /** @type {Record<string, unknown>} */ (asJson(profile ?? {}));
  delete body.path;
  return { hash: digestOf(body), body };
}

/**
 * @param {Record<string, unknown>} input
 * @param {readonly string[]} keys
 */
const pick = (input, keys) => Object.fromEntries(keys.filter(k => k in input).map(k => [k, input[k]]));

/**
 * Split the verdict's input into evidence statements, one per source that
 * supplied anything. Each digest leaves out `observedAt`.
 * @param {Record<string, unknown>} input  what computeVerdict was given
 * @param {{ nwo: string, pr: number, head: string, tree?: string | null,
 *           producer: { name: string, version: string | null }, observedAt: string }} at
 * @returns {{ kind: string, digest: string, statement: Record<string, any> }[]}
 */
export function splitEvidence(input, { nwo, pr, head, tree = null, producer, observedAt }) {
  const claimed = new Set(Object.values(SOURCES).flatMap(s => s.keys));
  const parts = Object.entries(SOURCES).map(([kind, s]) => [kind, pick(input, s.keys), s.from]);
  parts.push(["other", pick(input, Object.keys(input).filter(k => !claimed.has(k) && k !== POLICY_KEY)),
              "parts of the input no source above claims"]);
  const subject = [{ name: `${nwo}#${pr}`, digest: tree ? { gitCommit: head, gitTree: tree } : { gitCommit: head } }];
  const out = [];
  for (const [kind, raw, from] of parts) {
    const claim = asJson(raw);
    if (!claim || !Object.keys(claim).length) continue;
    const statement = { _type: STATEMENT_TYPE, subject, predicateType: EVIDENCE_PREDICATE,
                        predicate: { kind, from, claim, producer } };
    const kept = { ...statement, predicate: { ...statement.predicate, observedAt } };
    out.push({ kind: String(kind), digest: evidenceDigestOf(kept), statement: kept });
  }
  return out;
}

/**
 * An evidence statement's digest: what it says, without when it was seen. The
 * one computation for keeping a record and for checking it when it's read.
 * @param {Record<string, any>} statement
 */
export function evidenceDigestOf(statement) {
  const { observedAt: _seen, ...predicate } = statement?.predicate ?? {};
  return digestOf({ ...statement, predicate });
}

/**
 * Join evidence statements back into the input computeVerdict got, with the
 * policy put back under its key.
 * @param {Record<string, any>[]} statements
 * @param {Record<string, unknown> | null} [profile]
 */
export function joinEvidence(statements, profile = null) {
  /** @type {Record<string, unknown>} */
  const input = {};
  for (const s of statements) Object.assign(input, s.predicate.claim);
  if (profile) input[POLICY_KEY] = profile;
  return input;
}

/**
 * The decision record. Its digest covers what was decided and from what, never
 * when, so a tick that decides the same thing from the same evidence finds it.
 * @param {{ nwo: string, pr: number, head: string, tree?: string | null, policy: string,
 *           code: Record<string, unknown>, evidence: { kind: string, digest: string }[],
 *           verdict: { state: string, summary?: string, clauses: unknown[] } }} d
 */
export function decisionRecord({ nwo, pr, head, tree = null, policy, code, evidence, verdict }) {
  const record = {
    version: DECISION_VERSION,
    subject: { repo: nwo, pr, head, tree },
    policy,
    code,
    evidence: Object.fromEntries(evidence.map(e => [e.kind, e.digest])),
    verdict: asJson({ state: verdict.state, summary: verdict.summary, clauses: verdict.clauses }),
  };
  return { digest: digestOf(record), record };
}

/**
 * The code that's running: its commit and tree, and whether the checkout differs
 * from them, with a digest of the difference. Each part is null when git can't
 * say, which is not the same as clean.
 * @param {string} dir  the checkout reeve runs from
 */
export function codeVersion(dir) {
  const git = (/** @type {string[]} */ args) => {
    try {
      return execFileSync("git", ["-C", dir, ...GIT_NEUTRALISE, ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    } catch { return null; }
  };
  const commit = git(["rev-parse", "HEAD"])?.trim() ?? null;
  const tree = git(["rev-parse", "HEAD^{tree}"])?.trim() ?? null;
  const status = git(["status", "--porcelain"]);
  const dirty = status === null ? null : status.trim() !== "";
  let diff = null;
  if (dirty) {
    // Tracked changes, and each untracked file by name and content: a new file a
    // module imports changes what runs as surely as an edit does.
    const tracked = git(["diff", "--no-ext-diff", "HEAD", "--binary"]);
    const others = (git(["ls-files", "--others", "--exclude-standard", "-z"]) ?? "").split("\0").filter(Boolean)
      .map(f => `${f}\0${git(["hash-object", "--", f])?.trim() ?? "unreadable"}`);
    diff = tracked === null ? null : createHash("sha256").update(tracked).update("\0").update(others.join("\n")).digest("hex");
  }
  return { commit, tree, dirty, diff };
}

/**
 * Everything to keep for one verdict: its evidence, the policy applied and the
 * decision that names them. The producer is reeve at the commit that's running.
 * @param {{ nwo: string, pr: number, head: string, tree?: string | null, input: Record<string, unknown>,
 *           verdict: { state: string, summary?: string, clauses: unknown[] },
 *           policy: { hash: string, body: Record<string, unknown> },
 *           code: { commit: string | null } & Record<string, unknown>, observedAt: string }} v
 */
export function recordsFor({ nwo, pr, head, tree = null, input, verdict, policy, code, observedAt }) {
  const evidence = splitEvidence(input, { nwo, pr, head, tree, producer: { name: "reeve", version: code.commit }, observedAt });
  const decision = decisionRecord({ nwo, pr, head, tree, policy: policy.hash, code, evidence, verdict });
  return { policy, evidence, decision };
}
