// The check's old name (#242). reeve published as `ops/merge-policy` before it
// kept a record of what it published, and its shadow results there were
// `neutral`, which a required check reads as passing. It publishes as
// `merge-policy` now, so none of those old results can pass a rule that
// requires its check. A rule that still requires an old name, where reeve's App
// could meet it, is a rule to change, not a check to meet.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY_CONTEXT, excludeOwnPolicy } from "../src/github/reconciler.mjs";
import { clearRequirements, evaluatePr, evaluateQueueEntry, publishVerdict, requiredChecksOf, shadowContextOf } from "../src/pr.mjs";
import { computeVerdict, publishArgs, CLAUSE_IDS } from "../src/verdict.mjs";
import { ACTIONS, ESCALATIONS, nextAction } from "../src/watcher.mjs";
import { GATE_CHECK } from "../src/build/gatestate.mjs";
import { open } from "../src/db/ops.mjs";
import { openHub } from "../src/build/hubdb.mjs";
import { hubFindings } from "../src/doctor.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const OLD = "ops/merge-policy", OLD_SHADOW = "ops/merge-policy (shadow)";
const HEAD = "a".repeat(40), BASE = "b".repeat(40), QUEUED = "c".repeat(40);

/** A fake GitHub for publishing: a head with no runs, a base nothing protects, and every write. */
const github = () => {
  const writes = [];
  const api = (_token, args) => {
    const path = args.find((a) => typeof a === "string" && a.startsWith("repos/"));
    const verb = args.includes("PATCH") ? "PATCH" : args.includes("POST") ? "POST" : "GET";
    if (verb === "GET") {
      if (path.includes("/rules/branches/")) return { ok: true, out: JSON.stringify({ type: "deletion" }) };
      if (/\/branches\/[^/]+$/.test(path)) return { ok: true, out: JSON.stringify({ protected: true, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } }) };
      return { ok: true, out: "" };
    }
    const field = (k) => (args.find((a) => typeof a === "string" && a.startsWith(`${k}=`)) ?? "").slice(k.length + 1);
    writes.push({ verb, path, name: field("name") });
    return { ok: true, out: JSON.stringify({ id: 99 }) };
  };
  return { api, writes, auth: async () => ({ ok: true, token: "t", appId: "12345" }) };
};

/** What the watcher does with a CI clause, every other clause passing. */
const decide = (ci) => nextAction({
  pr: 1, state: "open", checks: {}, rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  verdict: { state: ci.state, summary: "x", clauses: CLAUSE_IDS.map((id) => (id === "ci" ? ci : { id, state: "PASS", detail: "" })) },
}, { rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 }, authority: { policy: "propose_and_merge" }, watch: { reviewActions: true } });

test("reeve publishes its verdict as merge-policy, and its shadow result as merge-policy (shadow)", async () => {
  assert.equal(POLICY_CONTEXT, "merge-policy");
  assert.equal(shadowContextOf(POLICY_CONTEXT), "merge-policy (shadow)");
  assert.equal(GATE_CHECK, POLICY_CONTEXT, "the builder's gate is bound to the same name");
  const v = { state: "BLOCK", summary: "ci: failing", head: HEAD, clauses: [] };
  assert.equal(publishArgs(v, { nwo: "o/r", asApp: true }).body.name, "merge-policy");
  assert.equal(publishArgs(v, { nwo: "o/r" }).body.context, "merge-policy");
  const enforcing = github(), shadow = github();
  const e = await publishVerdict({ nwo: "o/r", verdict: v, shadow: false, base: "main-enforcing", auth: enforcing.auth, api: enforcing.api });
  const s = await publishVerdict({ nwo: "o/r", verdict: v, shadow: true, base: "main-shadow", auth: shadow.auth, api: shadow.api });
  assert.ok(e.ok && s.ok, JSON.stringify({ e, s }));
  assert.deepEqual(enforcing.writes.filter((w) => w.verb === "POST").map((w) => w.name), ["merge-policy"]);
  assert.deepEqual(shadow.writes.filter((w) => w.verb === "POST").map((w) => w.name), ["merge-policy (shadow)"]);
});

test("a base that requires a name reeve published under before blocks CI and goes to a person, whichever old name it is", () => {
  for (const old of [OLD, OLD_SHADOW]) {
    const req = requiredChecksOf({ nwo: "o/r", baseRef: "main", profile: {}, appId: "4242",
      requirements: () => [{ context: old, app: null }, { context: "CI Gate", app: null }] });
    assert.equal(req.legacyRequired, true, old);
    assert.deepEqual(req.required.map((c) => c.context), ["CI Gate"], `${old} is a rule to change, not a check to meet`);
  }
  const ci = computeVerdict({ head: HEAD, checks: { verdict: "GREEN", settled: true, failing: [], impostors: [], shadowRequired: false, legacyRequired: true } })
    .clauses.find((c) => c.id === "ci");
  assert.equal(ci?.state, "BLOCK", JSON.stringify(ci));
  assert.match(ci.detail, /requires ops\/merge-policy or ops\/merge-policy \(shadow\), a name reeve published under before/);
  assert.match(ci.detail, /require merge-policy instead/);
  const d = decide(ci);
  assert.equal(d.action, ACTIONS.ESCALATE);
  assert.equal(d.why, ESCALATIONS.LEGACY_REQUIRED);
});

test("an old name bound to another App is required like any other, and one reeve's App could meet is refused", () => {
  const of = (app, appId) => requiredChecksOf({ nwo: "o/r", baseRef: "main", profile: {}, appId,
    requirements: () => [{ context: OLD, app }, { context: "CI Gate", app: null }] });
  const other = of("9999", "4242");
  assert.equal(other.legacyRequired, false);
  assert.ok(other.required.some((c) => c.context === OLD && c.app === "9999" && c.origin === "base"), JSON.stringify(other));
  for (const [name, r] of Object.entries({ mine: of("4242", "4242"), untold: of("9999", null), unbound: of(null, "4242") })) {
    assert.equal(r.legacyRequired, true, name);
    assert.ok(!r.required.some((c) => c.context === OLD), name);
  }
});

test("a queue commit whose base requires an old name is blocked too", () => {
  const db = open(join(tempDir("reeve-legacy-queue-"), "s.db"));
  const input = { head: HEAD, checks: { verdict: "GREEN", settled: true, why: null, readable: true, failing: [], inherited: [], impostors: [], shadowRequired: false },
                  base: { verdict: "GREEN", readable: true }, reviewers: [], rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
                  threads: { unresolved: 0, total: 0, readable: true }, cleared: { readable: true, uncleared: 0, reviewers: [] },
                  bodyFindings: { readable: true, open: 0, reviewers: [] }, unreadableBodies: { readable: true, open: 0, reviewers: [] },
                  ledgerBlockers: 0, mergeState: "CLEAN" };
  const judge = (legacyRequired) => evaluateQueueEntry({
    nwo: "o/r", entry: { pr: 7, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS", prHead: HEAD }, input,
    baseRef: "main", profile: { ci: { requiredChecks: [] } }, db,
    read: () => ({ ok: true, rows: [{ name: "test", source: "check_run", state: "completed", conclusion: "success", id: "1", appId: "15368", completedAt: new Date().toISOString() }], impostors: [] }),
    requirements: () => ({ required: [{ context: "test", app: null, origin: "base" }], known: true, shadowRequired: false, legacyRequired }) });
  const control = judge(false), held = judge(true);
  db.close();
  assert.notEqual(control.verdict?.clauses.find((c) => c.id === "ci")?.state, "BLOCK", "control: without it, the queue commit's CI doesn't block");
  const ci = held.verdict?.clauses.find((c) => c.id === "ci");
  assert.equal(ci?.state, "BLOCK", JSON.stringify(held));
  assert.match(ci.detail, /a name reeve published under before/);
});

/**
 * The CI clause for a head evaluated three times, as the daemon's ticks would,
 * against a fake GitHub whose base requires `required`, and whose head has the
 * check runs `runs`, as [name, conclusion], and the commit statuses `statuses`,
 * as [context, state].
 */
function ciThroughEvaluatePr({ required = ["CI Gate"], runs = [["CI Gate", "success"]], statuses = [] } = {}) {
  const runJson = (name, conclusion) =>
    JSON.stringify({ name, status: "completed", conclusion, id: 1, completed_at: new Date().toISOString(), app: { slug: "github-actions", id: 1 } });
  const page = JSON.stringify({ data: { repository: { pullRequest: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviewDecision: null,
    reviews: { totalCount: 0 }, reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
  const db = open(join(tempDir("reeve-legacy-db-"), "s.db"));
  const profile = { ci: { requiredChecks: [], reviewerStatusContexts: [] }, reviewers: [] };
  const bin = join(tempDir("reeve-legacy-gh-"), "bin");
  mkdirSync(bin);
  const rules = JSON.stringify({ type: "required_status_checks", parameters: { required_status_checks: required.map((context) => ({ context })) } });
  const status = statuses.map(([context, state]) => `echo '${JSON.stringify({ context, state })}'`).join("; ") || ":";
  const run = runs.map(([name, conclusion]) => `echo '${runJson(name, conclusion)}'`).join("; ") || ":";
  writeFileSync(join(bin, "gh"), `#!/bin/sh
for a in "$@"; do case "$a" in repos/*|graphql) p="$a";; esac; done
case "$p" in
  graphql) echo '${page}';;
  */commits/${BASE}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${BASE}/status*) ;;
  */check-suites*) echo '[{"app":{"slug":"github-actions"},"status":"completed"}]';;
  */rules/branches/*) echo '${rules}';;
  */branches/main) echo '{"protected":true,"protection":{"enabled":false}}';;
  */commits/${HEAD}/check-runs*) ${run};;
  */commits/${HEAD}/status*) ${status};;
  *) ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = ls-remote ] && printf '%s\\trefs/heads/main\\n' ${BASE}\nexit 0\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    clearRequirements();
    const anchor = { ok: true, headRef: "feature", baseRef: "main", state: "OPEN", title: "t", updatedAt: "2026-09-28T00:00:00Z",
                     head: HEAD, pin: { ok: true, sha: HEAD }, authorLogin: "someone" };
    let r;
    for (let k = 0; k < 3; k++) r = evaluatePr({ nwo: "o/r", pr: 1, profile, db, anchor });
    return r.ok ? r.verdict.clauses.find((c) => c.id === "ci") : { state: "none", detail: r.why };
  } finally { process.env.PATH = path; db.close(); }
}

test("through evaluatePr, a base that requires an old name blocks", () => {
  const control = ciThroughEvaluatePr({ required: ["CI Gate"] });
  const held = ciThroughEvaluatePr({ required: ["CI Gate", OLD] });
  assert.equal(control.state, "PASS", `control: the same head passes CI where no old name is required: ${JSON.stringify(control)}`);
  assert.equal(held.state, "BLOCK", JSON.stringify(held));
  assert.match(held.detail, /a name reeve published under before/);
});

// ── from #273's review ───────────────────────────────────────────────────────

test("an old commit status under a name reeve published under before is never CI evidence, while another App's check run under it is", () => {
  const status = { name: OLD, source: "status", state: "completed", conclusion: "success" };
  const shadowStatus = { name: OLD_SHADOW, source: "status", state: "completed", conclusion: "success" };
  const theirs = { name: OLD, source: "check_run", state: "completed", conclusion: "success", app: "someone-else" };
  const r = excludeOwnPolicy([status, shadowStatus, theirs]);
  assert.deepEqual(r.rows, [theirs]);
  assert.deepEqual(r.impostors, [], "and none is an impostor: neither name is reeve's now");
});

test("through evaluatePr, an old status of reeve's own verdict doesn't pass CI where nothing else is required", () => {
  const control = ciThroughEvaluatePr({ required: [], runs: [], statuses: [["lint", "success"]] });
  const stale = ciThroughEvaluatePr({ required: [], runs: [], statuses: [[OLD, "success"]] });
  assert.equal(control.state, "PASS", `control: a head whose one status passes, with nothing required, passes CI: ${JSON.stringify(control)}`);
  assert.notEqual(stale.state, "PASS", JSON.stringify(stale));
});

test("a gate-state row counts only if the ruleset it read requires merge-policy: one read before the rename doesn't", () => {
  const db = openHub(join(tempDir("reeve-legacy-hub-"), "h.db"));
  const NOW = 1_800_000_000;
  const gateFor = (context) => {
    db.prepare(`INSERT OR REPLACE INTO repo_gate_state(repo_id, nwo_snapshot, ruleset_requires_check, bound_app_id, expected_app_id,
                                                      app_installed, ruleset_snapshot, verified_at)
                VALUES(1, 'o/r', 1, 42, 42, 'pass', ?, ?)`)
      .run(JSON.stringify({ required_status_checks: [{ context, integration_id: 42 }] }), NOW - 60);
    return hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null }).find((x) => x.id === "H-4:o/r");
  };
  const current = gateFor(POLICY_CONTEXT), old = gateFor(OLD);
  db.close();
  assert.equal(current?.severity, "pass", `control: a row whose ruleset required merge-policy passes: ${JSON.stringify(current)}`);
  assert.equal(old?.severity, "fail", JSON.stringify(old));
  assert.equal(old?.classification, "unsafe-authority");
});
