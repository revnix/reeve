// The authority baseline: the live ruleset, branch protection, and profile facts
// as they stood when the builder programme froze authority, compared against
// every later reading.
//
// Drift here is never a bug report, it is an authority change: a required check
// appearing, a bypass actor widening, a capability switch flipping. Each is
// something a person decided or something nobody decided, and doctor must name
// it either way. An unreadable live state is drift, never agreement: not being
// able to look is not the same as having looked and found nothing.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where a repo's checked-in baseline lives: committed under deploy/, never under test/. */
export function baselinePathFor(nwo) {
  return join(PKG_ROOT, "deploy", "baselines", `${nwo.replace("/", "-")}.json`);
}

const ghApi = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

/**
 * Read the live authority facts for a repo. Every failure throws except the
 * one that means "no branch protection configured" (HTTP 404): a reading
 * taken during an auth failure or a rate limit must never become a baseline,
 * and must never be compared as if it were one.
 */
export function readLiveBaseline(nwo, profile, { gh = ghApi, branch = "main" } = {}) {
  const rulesets = gh(`repos/${nwo}/rulesets`);
  const active = rulesets.filter(r => r.enforcement === "active");
  const detail = active.map(r => gh(`repos/${nwo}/rulesets/${r.id}`));
  const rules = detail.flatMap(r => r.rules ?? []);
  const rulesetRequiredChecks = rules.filter(r => r.type === "required_status_checks")
    .flatMap(r => (r.parameters?.required_status_checks ?? []).map(c => `${c.context}@${c.integration_id ?? "any"}`)).sort();
  // Every active ruleset applies; the EFFECTIVE requirement is the strictest
  // across them. Reading only the first rule found would let a later, stricter
  // ruleset appear or vanish without the drift check noticing.
  const prs = rules.filter(r => r.type === "pull_request").map(r => r.parameters ?? {});
  const pr = { required_approving_review_count: Math.max(0, ...prs.map(p => p.required_approving_review_count ?? 0)),
               require_code_owner_review: prs.some(p => p.require_code_owner_review === true) };
  const rulesetBypassActors = detail.flatMap(r => (r.bypass_actors ?? []).map(b => `${b.actor_type}:${b.actor_id ?? ""}:${b.bypass_mode}`)).sort();
  let bp = null;
  try { bp = gh(`repos/${nwo}/branches/${encodeURIComponent(branch)}/protection`); }
  catch (e) { if (!/HTTP 404/.test(String(e.stderr ?? e.message))) throw e; }
  const branchProtectionRequiredChecks = bp === null ? []
    : (bp.required_status_checks?.checks ?? []).map(c => `${c.context}@${c.app_id ?? "any"}`).sort();
  return {
    nwo, rulesetNames: active.map(r => r.name), rulesetRequiredChecks, rulesetBypassActors, branchProtectionRequiredChecks,
    requiredApprovals: pr.required_approving_review_count ?? 0,
    codeOwnerReview: pr.require_code_owner_review ?? false,
    profile: { authorityPolicy: profile.authority?.policy ?? null, mergeEnforcement: profile.merge?.enforcement ?? null,
               capabilities: profile.builder?.capabilities ?? {} },
  };
}

/**
 * Doctor check R-13: the live authority facts against the checked-in baseline.
 * No baseline, or a live state that cannot be read, is UNKNOWN: the check
 * that exists to catch authority widening must never report calm because it
 * could not look.
 */
export function checkBaseline(nwo, profile, io = {}) {
  const path = io.fixturePath ?? baselinePathFor(nwo);
  if (!existsSync(path)) return { id: "R-13", level: "UNKNOWN", title: "authority baseline",
    lines: [`no baseline captured for ${nwo} at ${path}`, "-> node scripts/capture-baseline.mjs " + nwo + " > " + path] };
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  let live;
  try { live = (io.readLive ?? readLiveBaseline)(nwo, profile, io); }
  catch (e) { return { id: "R-13", level: "UNKNOWN", title: "authority baseline", lines: [`could not read the live state: ${String(e.message).split("\n")[0]}`] }; }
  const d = diffBaseline(live, fixture);
  if (d.drifted) return { id: "R-13", level: "DEGRADED", title: "authority baseline",
    lines: [`drift from the baseline captured ${fixture.capturedAt}:`, ...d.lines, "-> decide it, then re-capture; never re-capture to make this quiet"] };
  return { id: "R-13", level: "OK", title: "authority baseline", lines: [`matches the baseline captured ${fixture.capturedAt}`] };
}

const sortedEq = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/** Compare a live reading against the checked fixture. Returns {drifted, lines}. */
export function diffBaseline(live, fixture) {
  if (!live || typeof live !== "object") return { drifted: true, lines: ["could not read the live state; drift is assumed, not excluded"] };
  const lines = [];
  for (const [key, label] of [["rulesetNames", "active rulesets"],
                              ["rulesetRequiredChecks", "required checks (ruleset)"],
                              ["branchProtectionRequiredChecks", "required checks (branch protection)"],
                              ["rulesetBypassActors", "bypass actors"]]) {
    if (!sortedEq(live[key], fixture[key]))
      lines.push(`${label} differ: live ${JSON.stringify(live[key] ?? null)} vs baseline ${JSON.stringify(fixture[key] ?? null)}`);
  }
  if (live.requiredApprovals !== fixture.requiredApprovals)
    lines.push(`required approvals: live ${live.requiredApprovals} vs baseline ${fixture.requiredApprovals}`);
  if (live.codeOwnerReview !== fixture.codeOwnerReview)
    lines.push(`code-owner review: live ${live.codeOwnerReview} vs baseline ${fixture.codeOwnerReview}`);
  for (const k of ["authorityPolicy", "mergeEnforcement"]) {
    if (live.profile?.[k] !== fixture.profile?.[k])
      lines.push(`profile.${k}: live ${live.profile?.[k]} vs baseline ${fixture.profile?.[k]}`);
  }
  const caps = new Set([...Object.keys(live.profile?.capabilities ?? {}), ...Object.keys(fixture.profile?.capabilities ?? {})]);
  for (const c of caps) {
    if (live.profile?.capabilities?.[c] !== fixture.profile?.capabilities?.[c])
      lines.push(`capability ${c}: live ${live.profile?.capabilities?.[c]} vs baseline ${fixture.profile?.capabilities?.[c]}`);
  }
  return { drifted: lines.length > 0, lines };
}
