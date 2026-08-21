// Capture the live authority baseline for a repo: what the ruleset requires,
// who may bypass it, and what the profile's merge-related fields say. Written
// once per programme freeze and checked in; doctor compares every later
// reading against it so authority cannot widen without a decision.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withDefaults } from "../src/profile/schema.mjs";

const nwo = process.argv[2];
if (!nwo) { console.error("usage: capture-baseline.mjs <owner/repo>"); process.exit(2); }
const [owner, repo] = nwo.split("/");
// Every failure is fatal except the one that means "none configured": a
// baseline captured during an auth failure or a rate limit would record an
// empty protection set as fact and hide a required check.
const gh = (path, { noneOn404 = false } = {}) => {
  try { return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch (e) {
    const err = String(e.stderr ?? e.message);
    if (noneOn404 && /HTTP 404/.test(err)) return null;
    console.error(`capture-baseline: ${path} failed: ${err.trim().split("\n")[0]}`);
    process.exit(1);
  }
};

const rulesets = gh(`repos/${nwo}/rulesets`);
const active = rulesets.filter(r => r.enforcement === "active");
const detail = active.map(r => gh(`repos/${nwo}/rulesets/${r.id}`));
const rules = detail.flatMap(r => r.rules ?? []);
const requiredChecks = rules.filter(r => r.type === "required_status_checks")
  .flatMap(r => (r.parameters?.required_status_checks ?? []).map(c => `${c.context}@${c.integration_id ?? "any"}`));
const pr = rules.find(r => r.type === "pull_request")?.parameters ?? {};
const bypass = detail.flatMap(r => (r.bypass_actors ?? []).map(b => `${b.actor_type}:${b.actor_id ?? ""}:${b.bypass_mode}`));

// Classic branch protection is a SEPARATE mechanism from rulesets, and today it
// is where the only required check lives; a baseline that read rulesets alone
// would call the branch unprotected. 404 means none is configured.
const bp = gh(`repos/${nwo}/branches/${encodeURIComponent(process.argv[3] ?? "main")}/protection`, { noneOn404: true });
const branchProtectionRequiredChecks = bp === null ? []
  : (bp.required_status_checks?.checks ?? []).map(c => `${c.context}@${c.app_id ?? "any"}`).sort();

const profile = withDefaults(JSON.parse(readFileSync(join(homedir(), ".reeve", "profiles", owner, `${repo}.json`), "utf8")));

const out = {
  capturedAt: new Date().toISOString(),
  nwo,
  rulesetNames: active.map(r => r.name),
  rulesetRequiredChecks: requiredChecks.sort(),
  rulesetBypassActors: bypass.sort(),
  branchProtectionRequiredChecks,
  requiredApprovals: pr.required_approving_review_count ?? 0,
  codeOwnerReview: pr.require_code_owner_review ?? false,
  profile: {
    authorityPolicy: profile.authority.policy,
    mergeEnforcement: profile.merge.enforcement,
    capabilities: profile.builder.capabilities,
  },
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
