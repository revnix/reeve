// A required reeve check must not block on its own absence (#159).
//
// GitHub's mergeStateStatus counts reeve's own check once that check is required.
// The verdict read BLOCKED as a reason to block, published failure, and so kept
// GitHub BLOCKED: every verdict after the first was BLOCK, for ever. These tests
// build verdicts that are satisfied in every other way, with BLOCKED standing
// for each reason GitHub can have, and check which of them still block.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeVerdict, PASS, BLOCK, UNKNOWN } from "../src/verdict.mjs";
import { readMergeParts, readThreads, mergeRows } from "../src/pr.mjs";
import { readChecks } from "../src/github/reconciler.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const HEAD = "bfbbe6ed6a1c2d3e4f5061728394a5b6c7d8e9f0";
// Satisfied in every other way, as test/verdict.test.mjs builds it, and BLOCKED.
const blocked = (parts) => ({
  head: HEAD,
  checks: { verdict: "GREEN", settled: true, failing: [] },
  base: { verdict: "GREEN" },
  reviewers: [{ login: "codex", kind: "blocking", state: "CLEAN", reviewedHead: HEAD.slice(0, 10) }],
  rounds: { n: 2, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 4, readable: true },
  cleared: { readable: true, uncleared: 0, reviewers: [] },
  bodyFindings: { readable: true, open: 0, reviewers: [] },
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
  ledgerBlockers: 0,
  mergeState: "BLOCKED",
  mergeParts: { mergeable: "MERGEABLE", reviewDecision: "APPROVED", ownCheckRequired: true,
                others: [{ context: "ci/test", app: null, state: "passing" }], unresolvedBlocks: false, strict: false, behind: null, unevaluated: [], ...parts },
});
const verdictOf = (parts) => computeVerdict(blocked(parts));
// The mergeable clause, with a throw recorded rather than raised: a stubbed rule
// can make the verdict throw, and a file that dies there leaves the rest unrun.
const mergeable = (parts) => { try { return verdictOf(parts).clauses.find((c) => c.id === "mergeable"); } catch (e) { return { state: "threw", detail: e.message }; } };

// ── the verdict ──────────────────────────────────────────────────────────────
{
  const v = verdictOf({});
  check(v.state === PASS && /reeve's own required check/.test(mergeable({}).detail),
    "with reeve's check required and absent, a head that passes everything else reaches PASS", JSON.stringify(v.clauses.filter((c) => c.state !== PASS)));
  check(verdictOf({ reviewDecision: null }).state === PASS, "and so it does where no review is required at all");
}
check(mergeable({ mergeable: "CONFLICTING" }).state === BLOCK, "a conflict with the base still blocks", JSON.stringify(mergeable({ mergeable: "CONFLICTING" })));
check(mergeable({ reviewDecision: "REVIEW_REQUIRED" }).state === BLOCK && mergeable({ reviewDecision: "CHANGES_REQUESTED" }).state === BLOCK,
  "an outstanding or refused review still blocks", JSON.stringify([mergeable({ reviewDecision: "REVIEW_REQUIRED" }), mergeable({ reviewDecision: "CHANGES_REQUESTED" })]));
check(mergeable({ ownCheckRequired: false }).state === BLOCK,
  "control: BLOCKED while reeve's check isn't required is someone else's block, and blocks", JSON.stringify(mergeable({ ownCheckRequired: false })));
check(mergeable({ ownCheckRequired: null }).state === UNKNOWN,
  "BLOCKED when whether reeve's check is required couldn't be read is UNKNOWN, never a pass", JSON.stringify(mergeable({ ownCheckRequired: null })));
check(mergeable({ mergeable: "UNKNOWN" }).state === UNKNOWN,
  "BLOCKED while GitHub hasn't settled whether the branch merges is UNKNOWN", JSON.stringify(mergeable({ mergeable: "UNKNOWN" })));
{
  const i = blocked({}); delete i.mergeParts;
  check(computeVerdict(i).clauses.find((c) => c.id === "mergeable").state === BLOCK,
    "control: without the parts, BLOCKED blocks as before");
}

// ── what else the base requires ──────────────────────────────────────────────
//
// Finding reeve's check among the requirements doesn't make it the only one.
// GitHub reports BLOCKED for every requirement outstanding, so the verdict passes
// only when each of the others is accounted for.
{
  const failing = mergeable({ others: [{ context: "ci/test", app: null, state: "failing" }] });
  check(failing.state === BLOCK && /ci\/test/.test(failing.detail), "another required check that fails still blocks, and is named", JSON.stringify(failing));
  const waiting = ["missing", "running", "unknown"].map((state) => mergeable({ others: [{ context: "deploy/preview", app: null, state }] }));
  check(waiting.every((c) => c.state === UNKNOWN && /deploy\/preview/.test(c.detail)),
    "another required check that hasn't reported, is still running, or can't be matched to its App keeps it from passing", JSON.stringify(waiting));
  const replaced = mergeable({ others: [{ context: "ci/e2e", app: null, state: "superseded" }] });
  check(replaced.state === UNKNOWN && /ci\/e2e/.test(replaced.detail),
    "a required check whose run was cancelled or went stale waits for the run that replaces it: UNKNOWN, never BLOCK", JSON.stringify(replaced));
  const behind = mergeable({ strict: true, behind: 3 }), current = mergeable({ strict: true, behind: 0 }), unmeasured = mergeable({ strict: true, behind: null });
  check(behind.state === BLOCK && /3 commit/.test(behind.detail) && current.state === PASS && unmeasured.state === UNKNOWN,
    "a base that wants branches up to date blocks one that is behind, passes one that isn't, and is UNKNOWN when that couldn't be read",
    JSON.stringify([behind, current, unmeasured]));
  const rule = mergeable({ unevaluated: ["rule required_deployments"] });
  check(rule.state === UNKNOWN && /required_deployments/.test(rule.detail),
    "a requirement reeve doesn't evaluate keeps it from passing, and is named", JSON.stringify(rule));
  check(mergeable({ unresolvedBlocks: true }).state === BLOCK,
    "an unresolved conversation the base requires resolved blocks", JSON.stringify(mergeable({ unresolvedBlocks: true })));
  const unread = [{ others: null }, { unevaluated: null }, { unresolvedBlocks: null }, { others: undefined, unevaluated: undefined, unresolvedBlocks: undefined }].map(mergeable);
  check(unread.every((c) => c.state === UNKNOWN), "what else the base requires, unread, is UNKNOWN, never a pass", JSON.stringify(unread));
}

// ── reading the parts ────────────────────────────────────────────────────────
//
// A fake GitHub for the base: its rules, the branch as it reports itself, and
// classic protection's endpoint. Each case reads a base of its own, so the
// minute-long cache can't carry one case's answer into the next.
const OWN = { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ops/merge-policy", integration_id: 1 }] } };
const RULESETS_ONLY = { protected: true, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } };
const baseOf = ({ rules = [OWN], branch = RULESETS_ONLY, protection = { ok: false, err: "gh: Branch not protected (HTTP 404)" } } = {}) => {
  const calls = [];
  const gh = (args) => {
    const path = args.find((a) => a.startsWith("repos/"));
    calls.push(path);
    if (path.includes("/rules/branches/")) return Array.isArray(rules) ? { ok: true, out: rules.map((r) => JSON.stringify(r)).join("\n") } : rules;
    if (path.endsWith("/protection")) return protection?.ok === false ? protection : { ok: true, out: JSON.stringify(protection) };
    return branch?.ok === false ? branch : { ok: true, out: JSON.stringify(branch) };
  };
  return { gh, calls };
};
let bases = 0;
const partsOf = (base, threads, rows = []) => readMergeParts("o/r", `base-${++bases}`,
  { mergeState: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "APPROVED", readable: true, unresolved: 0, ...threads }, { gh: base.gh, appId: "1", rows });
{
  const base = baseOf();
  const parts = partsOf(base, {});
  check(parts.ownCheckRequired === true && parts.mergeable === "MERGEABLE" && parts.reviewDecision === "APPROVED"
    && base.calls.some((c) => /\/rules\/branches\/base-\d+$/.test(c)) && base.calls.some((c) => /\/branches\/base-\d+$/.test(c)),
    "when BLOCKED, the parts read whether reeve's check is required on the base, from its rules and its protection", JSON.stringify({ parts, calls: base.calls }));
  check(Array.isArray(parts.others) && parts.others.length === 0 && parts.unevaluated?.length === 0 && parts.unresolvedBlocks === false
    && !base.calls.some((c) => c.endsWith("/protection")),
    "a base only rulesets protect, requiring reeve's check alone, leaves nothing else outstanding, and classic protection isn't asked for", JSON.stringify({ parts, calls: base.calls }));
  base.calls.length = 0;
  const clean = readMergeParts("o/r", "parts-clean", { mergeState: "CLEAN", mergeable: "MERGEABLE" }, { gh: base.gh, appId: "1" });
  check(base.calls.length === 0 && clean.ownCheckRequired === null, "control: in any other state nothing more is read", JSON.stringify({ clean, calls: base.calls }));
}
{
  const rules = [{ type: "required_status_checks", parameters: { required_status_checks: [
    { context: "ops/merge-policy", integration_id: 1 }, { context: "ci/test" }, { context: "ci/lint", integration_id: 99 },
    { context: "deploy/preview" }, { context: "ci/slow" }, { context: "ci/bound-status", integration_id: 7 }, { context: "ci/absent" }] } }];
  const rows = [
    { name: "ci/test", source: "check_run", state: "completed", conclusion: "success", appId: "15368" },
    { name: "ci/lint", source: "check_run", state: "completed", conclusion: "success", appId: "42" },   // another App's
    { name: "deploy/preview", source: "status", state: "completed", conclusion: "failure" },
    { name: "ci/slow", source: "check_run", state: "running", conclusion: null, appId: "15368" },
    { name: "ci/bound-status", source: "status", state: "completed", conclusion: "success" },
  ];
  const parts = partsOf(baseOf({ rules }), {}, rows);
  const state = Object.fromEntries((parts.others ?? []).map((c) => [c.context, c.state]));
  check(state["ci/test"] === "passing" && state["deploy/preview"] === "failing" && state["ci/slow"] === "running" && state["ci/absent"] === "missing"
    && state["ci/lint"] === "missing" && state["ci/bound-status"] === "unknown" && !("ops/merge-policy" in state),
    "each other required check is read at the head: passing, failing, running, never reported, or run by an App other than the one it's bound to",
    JSON.stringify(parts.others));
  // One name reported twice, as a status and as a check run: GitHub holds the
  // merge for either, so both must pass.
  const both = (status, run, runState = "completed") => partsOf(baseOf({ rules: [OWN, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci/e2e" }] } }] }), {}, [
    { name: "ci/e2e", source: "status", state: "completed", conclusion: status },
    { name: "ci/e2e", source: "check_run", state: runState, conclusion: run, appId: "15368" }]).others?.[0]?.state;
  check(both("success", "cancelled") === "superseded" && both("success", "stale") === "superseded",
    "a required check whose run was cancelled or went stale is superseded, not failing", JSON.stringify([both("success", "cancelled"), both("success", "stale")]));
  check(both("success", "failure") === "failing" && both("failure", "success") === "failing" && both("success", null, "running") === "running"
    && both("success", "success") === "passing",
    "a check reported both as a status and as a check run passes only when both do", JSON.stringify([both("success", "failure"), both("failure", "success"), both("success", null, "running"), both("success", "success")]));
}
{
  // Branches required up to date, by a rule or by classic protection: how far
  // the head is behind is read, and only then.
  const strictRule = { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true,
    required_status_checks: [{ context: "ops/merge-policy", integration_id: 1 }] } };
  const compare = (behind) => (base) => ({ calls: base.calls, gh: (args) => {
    const path = args.find((a) => a.startsWith("repos/"));
    if (!/\/compare\//.test(path)) return base.gh(args);
    base.calls.push(path);
    return behind == null ? { ok: false, err: "HTTP 502" } : { ok: true, out: String(behind) };
  } });
  const at = (base) => readMergeParts("o/r", `base-${++bases}`, { mergeState: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "APPROVED", readable: true, unresolved: 0 },
    { gh: base.gh, appId: "1", rows: [], head: "f".repeat(40) });
  const byRule = at(compare(2)(baseOf({ rules: [strictRule] })));
  const unread = at(compare(null)(baseOf({ rules: [strictRule] })));
  const classic = { protected: true, protection: { enabled: true, required_status_checks: { contexts: ["ops/merge-policy"], checks: [] } } };
  const byProtection = at(compare(0)(baseOf({ rules: [], branch: classic, protection: { required_status_checks: { strict: true, contexts: ["ops/merge-policy"] } } })));
  const loose = baseOf();
  const plain = at(compare(5)(loose));
  check(byRule.strict === true && byRule.behind === 2 && unread.strict === true && unread.behind === null
    && byProtection.strict === true && byProtection.behind === 0 && plain.strict === false && plain.behind === null && !loose.calls.some((c) => /compare/.test(c)),
    "a base that wants branches up to date, by a rule or by classic protection, has the head's distance behind read, and only then",
    JSON.stringify({ byRule, unread, byProtection, plain }));
}
{
  const rules = [OWN, { type: "deletion" }, { type: "non_fast_forward" }, { type: "creation" }, { type: "required_linear_history" },
    { type: "pull_request", parameters: { required_approving_review_count: 1 } },
    { type: "required_deployments", parameters: { required_deployment_environments: ["preview"] } }, { type: "merge_queue" }, { type: "some_future_rule" }];
  const parts = partsOf(baseOf({ rules }), {});
  check(JSON.stringify(parts.unevaluated) === JSON.stringify(["rule required_deployments", "rule merge_queue", "rule some_future_rule"]),
    "rules reeve doesn't evaluate are named, a new kind included; reviews, and rules that can't stop a merge, aren't", JSON.stringify(parts.unevaluated));
}
{
  const resolution = [OWN, { type: "pull_request", parameters: { required_review_thread_resolution: true } }];
  const open = partsOf(baseOf({ rules: resolution }), { unresolved: 2 });
  const done = partsOf(baseOf({ rules: resolution }), { unresolved: 0 });
  const free = partsOf(baseOf(), { unresolved: 2 });
  const unread = partsOf(baseOf({ rules: resolution }), { readable: false });
  check(open.unresolvedBlocks === true && done.unresolvedBlocks === false && free.unresolvedBlocks === false && unread.unresolvedBlocks === null,
    "an unresolved conversation blocks where the base requires them resolved, and only there", JSON.stringify([open, done, free, unread].map((p) => p.unresolvedBlocks)));
}
{
  const classic = { protected: true, protection: { enabled: true, required_status_checks: { contexts: ["ops/merge-policy"], checks: [] } } };
  const settings = (over) => ({ required_signatures: { enabled: false }, lock_branch: { enabled: false }, required_conversation_resolution: { enabled: false },
    required_linear_history: { enabled: true }, allow_force_pushes: { enabled: false }, enforce_admins: { enabled: true }, ...over });
  const plain = baseOf({ rules: [], branch: classic, protection: settings({}) });
  const plainParts = partsOf(plain, {});
  const guarded = partsOf(baseOf({ rules: [], branch: classic,
    protection: settings({ required_signatures: { enabled: true }, lock_branch: { enabled: true }, restrictions: { users: [], teams: [], apps: [] } }) }), {});
  const conversations = partsOf(baseOf({ rules: [], branch: classic, protection: settings({ required_conversation_resolution: { enabled: true } }) }), { unresolved: 1 });
  const hidden = partsOf(baseOf({ rules: [], branch: classic, protection: { ok: false, err: "gh: Resource not accessible by integration (HTTP 403)" } }), {});
  check(plainParts.ownCheckRequired === true && plainParts.unevaluated?.length === 0 && plain.calls.some((c) => c.endsWith("/protection")),
    "classic protection's other settings are read where the branch has classic protection", JSON.stringify({ plainParts, calls: plain.calls }));
  check(JSON.stringify(guarded.unevaluated) === JSON.stringify(["protection required_signatures", "protection lock_branch", "protection restrictions"])
    && conversations.unresolvedBlocks === true,
    "and signatures, a locked branch or push restrictions are named, and required conversation resolution is read", JSON.stringify({ guarded: guarded.unevaluated, conversations: conversations.unresolvedBlocks }));
  check(hidden.others === null && hidden.unevaluated === null && hidden.unresolvedBlocks === null && hidden.ownCheckRequired === true,
    "classic protection that couldn't be read leaves what else the base requires unknown", JSON.stringify(hidden));
  // The branch is where classic protection's required checks are read. With it
  // unreadable, a check it requires can't be known, even with the rest of
  // protection read and the rules requiring reeve's check.
  const branchless = partsOf(baseOf({ branch: { ok: false, err: "gh: HTTP 502" }, protection: settings({}) }), {});
  check(branchless.ownCheckRequired === true && branchless.others === null && branchless.unevaluated === null
    && mergeable({ ...branchless, readable: true }).state === UNKNOWN,
    "a branch that couldn't be read leaves the checks its protection requires unknown, so BLOCKED can't pass", JSON.stringify(branchless));
  const unreadRules = partsOf(baseOf({ rules: { ok: false, err: "HTTP 502" } }), {});
  const unreadRows = readMergeParts("o/r", `base-${++bases}`, { mergeState: "BLOCKED", mergeable: "MERGEABLE", readable: true, unresolved: 0 }, { gh: baseOf().gh, appId: "1", rows: null });
  check(unreadRules.unevaluated === null && unreadRules.others === null && unreadRows.others === null,
    "and so do rules that couldn't be read, or a head whose checks couldn't be", JSON.stringify({ unreadRules, unreadRows }));
}
// readChecks, with a throw recorded rather than raised, so a stubbed rule that
// makes it throw fails its check and leaves the rest of the file running.
const read = (sha) => { try { return readChecks("o/r", sha); } catch (e) { return { threw: e.message, ok: false, whole: false, rows: [], reviewerRows: [], impostors: [] }; } };
// A stand-in for gh on the PATH, answering as \`gh api --paginate --jq\` does:
// one JSON value per line, every page's in turn. \`script\` is the body of a
// shell \`case\` on the request path. Every call's arguments are logged.
const withGh = (script, fn) => {
  const bin = mkdtempSync(join(tmpdir(), "reeve-gh-"));
  const path = process.env.PATH;
  try {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${join(bin, "calls")}"\nfor a in "$@"; do case "$a" in repos/*) p="$a";; esac; done\ncase "$p" in\n${script}\nesac\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${path}`;
    return fn(() => { try { return readFileSync(join(bin, "calls"), "utf8").trim().split("\n"); } catch { return []; } });
  } finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); }
};
{
  // A required check bound to an App names the App's id, so the head's check runs
  // must carry it.
  withGh(`  *check-runs*) echo '{"name":"ci/lint","status":"completed","conclusion":"success","id":1,"app":{"slug":"linter","id":42}}';;
  *) ;;`, () => {
    const got = read("c".repeat(40));
    const bound = (app) => partsOf(baseOf({ rules: [OWN, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci/lint", integration_id: app }] } }] }), {}, got.rows);
    check(got.ok && got.rows[0]?.appId === "42" && bound(42).others?.[0]?.state === "passing" && bound(99).others?.[0]?.state === "missing",
      "the head's check runs carry their App's id, so a check bound to that App is met by its run and by no other App's", JSON.stringify({ rows: got.rows, ours: bound(42).others, theirs: bound(99).others }));
  });
}
{
  // Two pages of each: gh prints every page's results in turn.
  withGh(`  *check-runs*) echo '{"name":"ci/a","status":"completed","conclusion":"success","id":1,"app":{"slug":"github-actions","id":15368}}'
    echo '{"name":"ci/b","status":"completed","conclusion":"failure","id":2,"app":{"slug":"github-actions","id":15368}}';;
  */status*) echo '{"context":"lint/a","state":"success"}'
    echo '{"context":"lint/b","state":"pending"}';;`, (calls) => {
    const got = read("d".repeat(40));
    const paged = calls().filter((c) => /check-runs|\/status/.test(c));
    check(got.whole === true && got.rows.length === 4 && paged.length === 2 && paged.every((c) => c.includes("--paginate") && c.includes("per_page=100")),
      "a head's check runs and statuses are read past their first page, 100 at a time", JSON.stringify({ whole: got.whole, rows: got.rows.map((r) => r.name), paged }));
  });
}
{
  // The check runs fail to read, and the statuses show the same name passing.
  withGh(`  *check-runs*) echo "gh: HTTP 502" >&2; exit 1;;
  */status*) echo '{"context":"ci/e2e","state":"success"}';;`, () => {
    const got = read("e".repeat(40));
    const parts = partsOf(baseOf({ rules: [OWN, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci/e2e" }] } }] }), {}, mergeRows(got));
    check(got.ok === true && got.whole === false && mergeRows(got) === null && parts.others === null && mergeable({ ...parts, readable: true }).state === UNKNOWN,
      "a head whose check runs or statuses couldn't be read gives the base's other checks nothing to pass on, so BLOCKED is UNKNOWN",
      JSON.stringify({ ok: got.ok, whole: got.whole, others: parts.others }));
  });
}
{
  const page = { data: { repository: { pullRequest: { mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
    reviews: { totalCount: 1 }, reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } };
  const t = readThreads("o/r", 7, { gh: () => ({ ok: true, out: JSON.stringify(page) }) });
  check(t.mergeState === "BLOCKED" && t.mergeable === "MERGEABLE" && t.reviewDecision === "APPROVED" && t.partsReadable === true,
    "the pull request's own read carries mergeable and the review decision", JSON.stringify(t));
  // An HTTP 200 can carry an error for one field, which then reads as null, and a
  // null review decision would read as "no review outstanding".
  const partial = { ...page, errors: [{ message: "Something went wrong while executing your query.", path: ["repository", "pullRequest", "reviewDecision"] }] };
  partial.data = { repository: { pullRequest: { ...page.data.repository.pullRequest, reviewDecision: null } } };
  const e = readThreads("o/r", 7, { gh: () => ({ ok: true, out: JSON.stringify(partial) }) });
  // A base on which reeve's check is the only requirement, so that the error is
  // all that stands between these parts and a pass.
  const parts = readMergeParts("o/r", "parts-partial", e, { gh: baseOf().gh, appId: "1", rows: [] });
  const clause = computeVerdict({ ...blocked({}), mergeParts: parts }).clauses.find((c) => c.id === "mergeable");
  check(e.partsReadable === false && parts.readable === false && parts.ownCheckRequired === true && clause.state === UNKNOWN,
    "a GraphQL error in the pull request's read makes its mergeability parts unknown, never a clear review", JSON.stringify({ partsReadable: e.partsReadable, parts, clause }));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
