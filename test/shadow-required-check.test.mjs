// Shadow mode must never satisfy a required check (#160).
//
// In shadow mode reeve publishes `neutral`, which reports what the policy would
// decide without deciding it. GitHub counts `neutral` as passing a required
// check, so with ops/merge-policy required and reeve in shadow mode, every pull
// request passed the gate unjudged. These tests drive publishVerdict against a
// fake GitHub that records what would be published, for each state the check can
// be in, and a daemon tick with a publish stub, for what the daemon does with it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishVerdict, requiredOn, shadowConclusion } from "../src/pr.mjs";
import { tick } from "../src/daemon.mjs";
import { open } from "../src/db/ops.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// The conclusions GitHub counts as passing a required check.
const PASSING = new Set(["success", "neutral", "skipped"]);
const NWO = "o/r", CONTEXT = "ops/merge-policy";
const verdict = { state: "BLOCK", summary: "ci: failing", head: "a".repeat(40), clauses: [] };

// A fake GitHub: the rules and protection it reports, and what was published.
const github = ({ rules, branch }) => {
  const published = [];
  const api = (_token, args) => {
    const path = args.find((a) => typeof a === "string" && a.startsWith("repos/"));
    if (path.includes("/rules/branches/")) return rules;
    if (/\/branches\/[^/]+$/.test(path) && !path.includes("/rules/")) return branch;
    if (path.includes("/check-runs?")) return { ok: true, out: "" };   // no run at this head yet
    if (args.includes("POST")) {
      const field = (k) => (args[args.indexOf(args.find((a) => a.startsWith(`${k}=`)))] ?? "").slice(k.length + 1);
      published.push({ conclusion: field("conclusion"), title: field("output[title]"), summary: field("output[summary]") });
      return { ok: true, out: JSON.stringify({ id: 99 }) };
    }
    return { ok: false, err: `unexpected call ${path}` };
  };
  return { api, published, auth: async () => ({ ok: true, token: "t" }) };
};
const rulesRequiring = (context) => ({ ok: true, out: JSON.stringify([{ type: "required_status_checks",
  parameters: { required_status_checks: [{ context, integration_id: 1 }] } }, { type: "deletion" }]) });
const RULES_NONE = { ok: true, out: JSON.stringify([{ type: "deletion" }]) };
// A branch as GitHub reports it: classic protection off, as on a branch that
// only rulesets protect, or never protected at all.
const NOT_PROTECTED = { ok: true, out: JSON.stringify({ protected: true, protection: { enabled: false,
  required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } }) };
const PROTECTED_REQUIRING = (context) => ({ ok: true, out: JSON.stringify({ protected: true, protection: { enabled: true,
  required_status_checks: { enforcement_level: "non_admins", contexts: [context], checks: [{ context, app_id: 1 }] } } }) });
const FORBIDDEN = { ok: false, err: "gh: Resource not accessible by integration (HTTP 403)" };
const publish = async (gh, over = {}) => {
  const r = await publishVerdict({ nwo: NWO, verdict, shadow: true, context: CONTEXT, base: "main", auth: gh.auth, api: gh.api, ...over });
  return { r, sent: gh.published[0] ?? null };
};

// ── what shadow mode publishes ────────────────────────────────────────────────
{
  const { r, sent } = await publish(github({ rules: rulesRequiring(CONTEXT), branch: NOT_PROTECTED }));
  check(sent && !PASSING.has(sent.conclusion) && /required on main/.test(r.held ?? "") && /^\[shadow\] not passing/.test(sent.title),
    "with the check required by a ruleset, shadow mode publishes a conclusion that doesn't pass, and says why", JSON.stringify({ r, sent }));
  check(/stop requiring/.test(sent?.summary ?? "") && /would be: \*\*failure\*\*/.test(sent?.summary ?? ""),
    "and the check tells the person how to fix it, and what the verdict would have been", sent?.summary?.slice(0, 200));
}
{
  const { r, sent } = await publish(github({ rules: RULES_NONE, branch: PROTECTED_REQUIRING(CONTEXT) }));
  check(sent && !PASSING.has(sent.conclusion) && r.held,
    "with the check required by classic branch protection, it doesn't pass either", JSON.stringify({ r, sent }));
}
{
  const { r, sent } = await publish(github({ rules: RULES_NONE, branch: NOT_PROTECTED }));
  check(sent?.conclusion === "neutral" && !r.held && /^\[shadow\] BLOCK/.test(sent.title),
    "control: with the check not required anywhere, shadow mode publishes neutral, which blocks nothing", JSON.stringify({ r, sent }));
}
{
  const { r, sent } = await publish(github({ rules: rulesRequiring("some/other-check"), branch: NOT_PROTECTED }));
  check(sent?.conclusion === "neutral" && !r.held, "control: another check being required doesn't make this one required", JSON.stringify({ r, sent }));
}
{
  const { r, sent } = await publish(github({ rules: FORBIDDEN, branch: NOT_PROTECTED }));
  check(sent && !PASSING.has(sent.conclusion) && /couldn't be read/.test(r.held ?? ""),
    "when the rules can't be read, shadow mode doesn't pass: unknown is never taken for not required", JSON.stringify({ r, sent }));
}
{
  const { r, sent } = await publish(github({ rules: RULES_NONE, branch: FORBIDDEN }));
  check(sent && !PASSING.has(sent.conclusion) && r.held,
    "nor when the branch's own protection can't be read", JSON.stringify({ r, sent }));
}
{
  const { r, sent } = await publish(github({ rules: RULES_NONE, branch: NOT_PROTECTED }), { base: null });
  check(sent && !PASSING.has(sent.conclusion) && r.held, "nor when the base branch isn't known", JSON.stringify({ r, sent }));
}
{
  const gh = github({ rules: FORBIDDEN, branch: FORBIDDEN });
  const { sent } = await publish(gh, { shadow: false });
  check(sent?.conclusion === "failure" && !/shadow/.test(sent.title), "control: enforcing, the real conclusion is published as before", JSON.stringify(sent));
}
check(requiredOn({ rules: { ok: true, out: "not json" }, branch: NOT_PROTECTED }, CONTEXT) === null && shadowConclusion(null) === "action_required",
  "an unreadable rules answer is unknown, and unknown doesn't pass");

// ── what the daemon does with it ──────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-required-"));
  try {
    const calls = [];
    const evaluation = (pr) => ({ ok: true, pr, state: "open", head: "b".repeat(40), title: "t", headRef: `f${pr}`, baseRef: "main",
      updatedAt: "2026-09-25T10:00:00Z", verdict: { state: "PASS", summary: "ok", clauses: [] },
      rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 }, checks: { verdict: "GREEN", caused: [], failing: [] },
      reviewers: [], threads: { readable: true, total: 0, unresolved: 0, seen: 0 }, settled: { settled: true } });
    const ctx = {
      nwo: NWO, profile: { identity: { key: NWO, defaultBranch: "main" }, authority: { policy: "propose_only" },
        ci: { provider: "github-actions", requiredChecks: [] }, watch: { maxWorkers: 1 }, reviewers: [] },
      db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"), execute: false, shadow: true, running: 0,
      openPrs: () => [7, 8], evaluate: ({ pr }) => evaluation(pr),
      publish: async (args) => { calls.push(args); return { ok: true, id: 1, conclusion: "action_required", held: `${CONTEXT} is required on main` }; },
      observe: () => ({ observations: [], incomplete: false, threads: { readable: true, total: 0, unresolved: 0, seen: 0 } }),
      derivePr: () => ({}), reviewState: () => ({ readable: true, total: 0, open: 0, resolved: 0, unspilledCritical: 0, rounds: 1 }),
    };
    const t = await tick(ctx);
    const log = readFileSync(ctx.logPath, "utf8");
    check(calls.length === 2 && calls.every((c) => c.base === "main"), "the daemon tells the publisher which branch the pull request targets", JSON.stringify(calls.map((c) => c.base)));
    const raised = [...(t.escalations?.entries?.() ?? [])].filter(([cause]) => /shadow mode/.test(cause));
    check(/published a conclusion that doesn't pass, because ops\/merge-policy is required on main/.test(log) && raised.length === 1,
      "and a check shadow mode held back is logged and raised once for the person, not once per pull request",
      JSON.stringify({ raised, log: log.split("\n").filter((l) => /shadow/.test(l)).slice(0, 3) }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
