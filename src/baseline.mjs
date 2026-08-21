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
  // Owner and repository as separate path components: a hyphen join maps
  // `foo-bar/baz` and `foo/bar-baz` to one file.
  const [owner, repo] = nwo.split("/");
  return join(PKG_ROOT, "deploy", "baselines", owner, `${repo}.json`);
}

// Every list endpoint is paginated and slurped, so a repository with more
// rulesets than one page does not lose the later ones from its baseline;
// `--slurp` wraps the pages in one outer array, which is flattened here.
const ghApi = (path, { list = false } = {}) => {
  const args = list ? ["api", "--paginate", "--slurp", path] : ["api", path];
  const out = JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }));
  return list ? out.flat() : out;
};

/**
 * Read the live authority facts for a repo. Every failure throws except the
 * one that means "no branch protection configured" (HTTP 404): a reading
 * taken during an auth failure or a rate limit must never become a baseline,
 * and must never be compared as if it were one.
 */
/**
 * GitHub's ref patterns are fnmatch: `*` matches within one path segment, `**`
 * crosses segments, `?` is one character, `[...]` is a class. Translating every
 * star to `.*` let `release/*` claim `release/team/v1`.
 */
function fnmatchRe(pat) {
  let re = "^";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      if (pat[i + 1] === "*") {
        // `**/` covers zero or more whole segments, so `**/foo` matches `foo`.
        if (pat[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i++; }
      } else re += "[^/]*";
    }
    else if (c === "?") re += "[^/]";
    else if (c === "[") { const j = pat.indexOf("]", i + 1); if (j > i) { re += "[" + pat.slice(i + 1, j).replace(/\\/g, "\\\\") + "]"; i = j; } else re += "\\["; }
    else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

/**
 * Does a ruleset's ref condition cover this branch? GitHub's patterns are
 * `refs/heads/<fnmatch>`, `~DEFAULT_BRANCH`, and `~ALL`; exclude beats include.
 * A ruleset with no ref condition applies to every branch.
 */
export function rulesetCoversBranch(detail, branch, defaultBranch) {
  const cond = detail?.conditions?.ref_name;
  if (!cond) return true;
  const ref = `refs/heads/${branch}`;
  const matches = pat => pat === "~ALL" || (pat === "~DEFAULT_BRANCH" && branch === defaultBranch) || fnmatchRe(pat).test(ref);
  if ((cond.exclude ?? []).some(matches)) return false;
  return (cond.include ?? []).some(matches);
}

export function readLiveBaseline(nwo, profile, { gh = ghApi, branch = null } = {}) {
  const defaultBranch = profile.identity?.defaultBranch ?? "main";
  const target = branch ?? profile.identity?.baseBranch ?? defaultBranch;
  const rulesets = gh(`repos/${nwo}/rulesets`, { list: true });
  // Branch rulesets only: a tag or push ruleset with no ref condition would
  // otherwise read as covering every branch, and its policy changes would be
  // false drift for a branch it never governed.
  const activeAll = rulesets.filter(r => r.enforcement === "active" && (r.target ?? "branch") === "branch");
  // Only rulesets whose ref condition covers the target branch count: a
  // release-branch ruleset must neither protect main on paper nor drift it.
  const detailAll = activeAll.map(r => ({ meta: r, detail: gh(`repos/${nwo}/rulesets/${r.id}`) }));
  const covering = detailAll.filter(({ detail }) => (detail.target ?? "branch") === "branch" && rulesetCoversBranch(detail, target, defaultBranch));
  const active = covering.map(c => c.meta);
  const detail = covering.map(c => c.detail);
  const rules = detail.flatMap(r => r.rules ?? []);
  const checkRules = rules.filter(r => r.type === "required_status_checks");
  const rulesetRequiredChecks = checkRules
    .flatMap(r => (r.parameters?.required_status_checks ?? []).map(c => `${c.context}@${c.integration_id ?? "any"}`)).sort();
  // Strict means the branch must be up to date with its base before merging;
  // dropping it widens what can merge with the same check names.
  const strictRequiredChecks = checkRules.some(r => r.parameters?.strict_required_status_checks_policy === true);
  // Every active ruleset applies; the EFFECTIVE requirement is the strictest
  // across them. Reading only the first rule found would let a later, stricter
  // ruleset appear or vanish without the drift check noticing.
  const prs = rules.filter(r => r.type === "pull_request").map(r => r.parameters ?? {});
  const pr = { required_approving_review_count: Math.max(0, ...prs.map(p => p.required_approving_review_count ?? 0)),
               require_code_owner_review: prs.some(p => p.require_code_owner_review === true),
               // Every other authority-bearing parameter: dropping any of them
               // widens what can merge, and a count that stayed the same must
               // not hide it.
               dismiss_stale_reviews_on_push: prs.some(p => p.dismiss_stale_reviews_on_push === true),
               require_last_push_approval: prs.some(p => p.require_last_push_approval === true),
               required_review_thread_resolution: prs.some(p => p.required_review_thread_resolution === true) };
  const rulesetBypassActors = detail.flatMap(r => (r.bypass_actors ?? []).map(b => `${b.actor_type}:${b.actor_id ?? ""}:${b.bypass_mode}`)).sort();
  let bp = null;
  try { bp = gh(`repos/${nwo}/branches/${encodeURIComponent(target)}/protection`); }
  catch (e) { if (!/HTTP 404/.test(String(e.stderr ?? e.message))) throw e; }
  const branchProtectionRequiredChecks = bp === null ? []
    : (bp.required_status_checks?.checks ?? []).map(c => `${c.context}@${c.app_id ?? "any"}`).sort();
  // Classic protection enforces reviews too; the effective requirement is the
  // strictest across rulesets and classic protection alike.
  const classic = bp?.required_pull_request_reviews ?? null;
  // Who may bypass classic review: as much authority as a ruleset bypass actor.
  const allowances = classic?.bypass_pull_request_allowances ?? {};
  const classicBypassAllowances = [
    ...(allowances.apps ?? []).map(a => `app:${a.slug}`),
    ...(allowances.teams ?? []).map(t => `team:${t.slug}`),
    ...(allowances.users ?? []).map(u => `user:${u.login}`),
  ].sort();
  const requiredApprovals = Math.max(pr.required_approving_review_count ?? 0, classic?.required_approving_review_count ?? 0);
  const codeOwnerReview = (pr.require_code_owner_review ?? false) || (classic?.require_code_owner_reviews ?? false);
  return {
    nwo, branch: target, rulesetNames: active.map(r => r.name), rulesetRequiredChecks, rulesetBypassActors, branchProtectionRequiredChecks,
    classicBypassAllowances,
    strictRequiredChecks: strictRequiredChecks || (bp?.required_status_checks?.strict ?? false),
    requiredApprovals, codeOwnerReview,
    dismissStaleReviews: pr.dismiss_stale_reviews_on_push || (classic?.dismiss_stale_reviews ?? false),
    requireLastPushApproval: pr.require_last_push_approval || (classic?.require_last_push_approval ?? false),
    requireThreadResolution: pr.required_review_thread_resolution || (bp?.required_conversation_resolution?.enabled ?? false),
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
  let fixture;
  try { fixture = JSON.parse(readFileSync(path, "utf8")); if (!fixture || typeof fixture !== "object") throw new Error("not an object"); }
  catch (e) { return { id: "R-13", level: "UNKNOWN", title: "authority baseline", lines: [`the baseline at ${path} could not be read: ${e.message}`] }; }
  // The branch the profile targets now is the one that matters. A baseline
  // captured for another branch is drift in its own right: probing the stale
  // branch would report calm about protections the daemon no longer relies on.
  const target = io.branch ?? profile.identity?.baseBranch ?? profile.identity?.defaultBranch ?? "main";
  if (fixture.branch && fixture.branch !== target)
    return { id: "R-13", level: "DEGRADED", title: "authority baseline",
      lines: [`the baseline was captured for branch ${fixture.branch}; the profile now targets ${target}`, "-> decide it, then re-capture for the profiled branch"] };
  let live;
  try { live = (io.readLive ?? readLiveBaseline)(nwo, profile, { ...io, branch: target }); }
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
                              ["rulesetBypassActors", "bypass actors"],
                              ["classicBypassAllowances", "classic review bypass allowances"]]) {
    if (!sortedEq(live[key], fixture[key]))
      lines.push(`${label} differ: live ${JSON.stringify(live[key] ?? null)} vs baseline ${JSON.stringify(fixture[key] ?? null)}`);
  }
  if (live.requiredApprovals !== fixture.requiredApprovals)
    lines.push(`required approvals: live ${live.requiredApprovals} vs baseline ${fixture.requiredApprovals}`);
  if (live.codeOwnerReview !== fixture.codeOwnerReview)
    lines.push(`code-owner review: live ${live.codeOwnerReview} vs baseline ${fixture.codeOwnerReview}`);
  for (const [key, label] of [["dismissStaleReviews", "stale-review dismissal"], ["requireLastPushApproval", "last-push approval"], ["requireThreadResolution", "review thread resolution"], ["strictRequiredChecks", "strict up-to-date policy on required checks"]]) {
    if ((live[key] ?? false) !== (fixture[key] ?? false))
      lines.push(`${label}: live ${live[key] ?? false} vs baseline ${fixture[key] ?? false}`);
  }
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
