// Read CI completely (#164). Three ways the CI evidence passed what it shouldn't:
//
//   · GitHub counts a skipped or neutral result as passing a required check. A
//     test job that a broken `if:` skipped, or whose `needs:` failed, passed the
//     gate, and passed reeve's CI clause with it.
//   · A read of a head's checks counted with only its check runs or only its
//     statuses read, so a failing status beside passing check runs read green.
//   · Another App's check under reeve's own name was dropped, where it is
//     someone speaking for the gate.
//
// Each rule is checked on its own, then through evaluatePr against a stand-in
// for gh and git, so the wiring is proved and not only the parts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, POLICY_CONTEXT, readChecks, settle } from "../src/github/reconciler.mjs";
import { classifyRead, clearRequirements, evaluatePr, requiredChecksOf, requiredChecksOnBase, requirementsOn, shadowContextOf } from "../src/pr.mjs";
import { computeVerdict, CLAUSE_IDS } from "../src/verdict.mjs";
import { ACTIONS, ESCALATIONS, nextAction } from "../src/watcher.mjs";
import { open } from "../src/db/ops.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const run = (name, conclusion, extra = {}) => ({ name, conclusion, state: "completed", source: "check_run", app: "github-actions", ...extra });
const status = (name, state) => ({ name, conclusion: state, state: "completed", source: "status" });

// ── a skipped or neutral result is no pass for a required check ─────────────
{
  const skipped = classify([run("test", "skipped"), run("lint", "success")], ["test"]);
  const neutral = classify([run("test", "neutral"), run("lint", "success")], ["test"]);
  const pathFiltered = classify([run("test", "success"), run("docs", "skipped")], ["test"]);
  check(skipped.verdict === "SKIPPED_REQUIRED" && /skipped or neutral/.test(skipped.why) && neutral.verdict === "SKIPPED_REQUIRED"
    && pathFiltered.verdict === "GREEN",
    "a required check whose every result is skipped or neutral never passed, and a skipped job nothing requires still passes",
    JSON.stringify({ skipped, neutral, pathFiltered }));
  const beside = classify([run("test", "skipped"), status("test", "success"), run("lint", "success")], ["test"]);
  check(beside.verdict === "GREEN", "a required check with a passing result beside a skipped one ran", JSON.stringify(beside));
  const red = classify([run("build", "failure"), run("test", "skipped")], ["test"]);
  const inFlight = classify([{ name: "build", state: "running", conclusion: null, source: "check_run" }, run("test", "skipped")], ["test"]);
  check(red.verdict === "RED" && inFlight.verdict === "RUNNING",
    "a failure, or a check in flight, comes first: the job a skipped one needs is the one to fix", JSON.stringify({ red, inFlight }));
  const nothingRan = classify([run("a", "skipped"), run("b", "neutral"), run("c", "cancelled")], []);
  const oneRan = classify([run("a", "skipped"), run("b", "success")], []);
  check(nothingRan.verdict === "UNKNOWN" && /no check ran/.test(nothingRan.why) && oneRan.verdict === "GREEN",
    "a head where every check was skipped, neutral or superseded is unknown, not green: nothing ran", JSON.stringify({ nothingRan, oneRan }));
  const health = [classify([run("test", "skipped"), run("lint", "success")], ["test"], { evidence: false }),
                  classify([run("a", "skipped"), run("b", "neutral")], [], { evidence: false }),
                  classify([run("maybe-required", "skipped"), run("lint", "success")], [], { requiredKnown: false, evidence: false })];
  check(health.every((c) => c.verdict === "GREEN"),
    "a base is judged for health, which only its failures decide: a skipped check, or a push that ran nothing, leaves it green",
    JSON.stringify(health));
  const unplaced = classify([run("maybe-required", "skipped"), run("lint", "success")], [], { requiredKnown: false });
  const noneSkipped = classify([run("lint", "success")], [], { requiredKnown: false });
  check(unplaced.verdict === "UNKNOWN" && /couldn't be read/.test(unplaced.why) && noneSkipped.verdict === "GREEN",
    "where the base's requirements couldn't be read, a skipped or neutral check may be a required one, so it isn't green",
    JSON.stringify({ unplaced, noneSkipped }));
}

// The required set: the profile's, and every check the base's rules and branch
// protection require, reeve's own aside.
{
  const rules = { ok: true, out: JSON.stringify([{ type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "CI Gate" }, { context: POLICY_CONTEXT }, { context: "CodeRabbit" }] } }]) };
  const branch = { ok: true, out: JSON.stringify({ protected: true,
    protection: { enabled: true, required_status_checks: { contexts: ["legacy/ci"], checks: [] } } }) };
  const hidden = { ok: false, err: "gh: Not Found (HTTP 404)" };
  const read = requirementsOn({ rules, branch, protection: hidden }, POLICY_CONTEXT);
  const unread = requirementsOn({ rules: { ok: false, err: "gh: HTTP 502" }, branch, protection: hidden }, POLICY_CONTEXT);
  const names = (checks) => checks?.map((c) => c.context);
  check(JSON.stringify(names(read.checks)) === JSON.stringify(["CI Gate", POLICY_CONTEXT, "CodeRabbit", "legacy/ci"]) && read.others === null && unread.checks === null,
    "the base's required checks are read from its rules and its branch, even where the rest of protection can't be, and are unknown where those can't",
    JSON.stringify({ read: read.checks, others: read.others, unread: unread.checks }));
  const profile = { ci: { requiredChecks: ["e2e", "CI Gate"], reviewerStatusContexts: ["CodeRabbit"] } };
  const known = requiredChecksOf({ nwo: "o/r", baseRef: "main", profile, requirements: () => read.checks });
  const unknown = requiredChecksOf({ nwo: "o/r", baseRef: "main", profile, requirements: () => unread.checks });
  check(JSON.stringify(names(known.required)) === JSON.stringify(["e2e", "CI Gate", "legacy/ci"]) && known.known === true
    && JSON.stringify(names(unknown.required)) === JSON.stringify(["e2e", "CI Gate"]) && unknown.known === false,
    "a pull request's required checks are the profile's and the base's, reeve's own and reviewers' statuses aside", JSON.stringify({ known, unknown }));
}

// A required check bound to an App is met only by that App's own runs.
{
  const bound = [{ context: "test", app: "15368" }];
  const theirs = run("test", "success", { appId: "99" });
  const cases = {
    skippedBesideAnother: classify([run("test", "skipped", { appId: "15368" }), theirs], bound),
    passed: classify([run("test", "success", { appId: "15368" })], bound),
    onlyAnother: classify([theirs, run("lint", "success")], bound),
    onlyAStatus: classify([status("test", "success"), run("lint", "success")], bound),
  };
  const rules = { ok: true, out: JSON.stringify([{ type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "test", integration_id: 15368 }, { context: "any", integration_id: -1 }] } }]) };
  const read = requirementsOn({ rules, branch: { ok: true, out: JSON.stringify({ protected: false }) } }, POLICY_CONTEXT);
  check(cases.skippedBesideAnother.verdict === "SKIPPED_REQUIRED" && cases.passed.verdict === "GREEN"
    && cases.onlyAnother.verdict === "MISSING_REQUIRED" && cases.onlyAStatus.verdict === "UNKNOWN"
    && JSON.stringify(read.checks) === JSON.stringify([{ context: "test", app: "15368" }, { context: "any", app: null }]),
    "a required check bound to an App is met only by that App's runs: another App's pass isn't it, and a status can't be told",
    JSON.stringify({ cases, checks: read.checks }));
}

// A failure or a check in flight comes before a required check yet to report,
// and a skipped required check, which won't change, settles at once.
{
  const red = classify([run("build", "failure")], ["late"]);
  const inFlight = classify([{ name: "build", state: "running", conclusion: null, source: "check_run" }], ["late"]);
  const settled = settle(null, { verdict: "SKIPPED_REQUIRED", sha: "a".repeat(40), rows: [run("test", "skipped")], why: "skipped" });
  check(red.verdict === "RED" && inFlight.verdict === "RUNNING" && settled.settled === true && settled.verdict === "SKIPPED_REQUIRED",
    "a failure or a running check comes before a required check yet to report, and a skipped required check settles at once",
    JSON.stringify({ red, inFlight, settled }));
}

// A base that requires reeve's shadow check is gated by a result that never
// fails, and that's refused, not set aside.
{
  const shadowed = requiredChecksOf({ nwo: "o/r", baseRef: "main", profile: {},
    requirements: () => [{ context: shadowContextOf(POLICY_CONTEXT), app: null }, { context: "CI Gate", app: null }] });
  const ci = computeVerdict({ head: "a".repeat(40), checks: { verdict: "GREEN", settled: true, failing: [], impostors: [], shadowRequired: true } })
    .clauses.find((c) => c.id === "ci");
  const d = nextAction({ pr: 1, state: "open", checks: {}, rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    verdict: { state: ci.state, summary: "x", clauses: CLAUSE_IDS.map((id) => (id === "ci" ? ci : { id, state: "PASS", detail: "" })) } },
    { rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 }, authority: { policy: "propose_and_merge" }, watch: { reviewActions: true } });
  check(shadowed.shadowRequired === true && JSON.stringify(shadowed.required.map((c) => c.context)) === JSON.stringify(["CI Gate"])
    && ci.state === "BLOCK" && d.action === ACTIONS.ESCALATE && d.why === ESCALATIONS.SHADOW_REQUIRED,
    "a base that requires reeve's shadow check blocks CI and goes to a person: the shadow result passes the rule whatever reeve finds",
    JSON.stringify({ shadowed, ci, d }));
}

// The base's required checks are read from its rules and branch alone, and kept
// for a minute, so a token without the admin-only protection read still has
// them, without reading them again on every tick.
{
  const calls = [], paged = [];
  const gh = (args) => {
    const path = args.find((a) => a.startsWith("repos/"));
    calls.push(path);
    if (args.includes("--paginate")) paged.push(path);
    if (path.includes("/rules/")) return { ok: true, out: '{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"CI Gate"}]}}' };
    if (path.endsWith("/protection")) return { ok: false, err: "gh: Not Found (HTTP 404)" };
    return { ok: true, out: JSON.stringify({ protected: true, protection: { enabled: true, required_status_checks: { contexts: [], checks: [] } } }) };
  };
  clearRequirements();
  const first = requiredChecksOnBase({ nwo: "o/r", base: "main", gh, now: 1_000 });
  const second = requiredChecksOnBase({ nwo: "o/r", base: "main", gh, now: 30_000 });
  const reads = calls.length;
  const later = requiredChecksOnBase({ nwo: "o/r", base: "main", gh, now: 120_000 });
  clearRequirements();
  check(JSON.stringify(first) === JSON.stringify([{ context: "CI Gate", app: null }]) && JSON.stringify(second) === JSON.stringify(first)
    && reads === 2 && calls.length === 4 && !calls.some((c) => c.endsWith("/protection")) && JSON.stringify(later) === JSON.stringify(first)
    && paged.length === 2 && paged.every((p) => p.includes("/rules/")),
    "the base's required checks are read from its rules, every page, and its branch, never protection's admin-only read, and kept for a minute",
    JSON.stringify({ first, reads, calls, paged }));
}

// ── a read counts only when it is whole ──────────────────────────────────────
// A stand-in for gh and git on the PATH. gh answers `case` on the request path,
// as `gh api --paginate --jq` prints: one JSON value per line. git answers
// ls-remote with a fixed base head.
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const withFakes = (answers, fn) => {
  const bin = mkdtempSync(join(tmpdir(), "reeve-ci-read-"));
  const path = process.env.PATH;
  try {
    // The pull request's own GraphQL read answers a clean page: no threads, and
    // a merge state that isn't BLOCKED, so the merge parts aren't read.
    const page = JSON.stringify({ data: { repository: { pullRequest: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviewDecision: null,
      reviews: { totalCount: 0 }, reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nfor a in "$@"; do case "$a" in repos/*|graphql) p="$a";; esac; done\ncase "$p" in\n  graphql) echo '${page}';;\n${answers}\n  *) ;;\nesac\n`, { mode: 0o755 });
    writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = ls-remote ] && printf '%s\\trefs/heads/main\\n' ${BASE}\nexit 0\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${path}`;
    clearRequirements();
    return fn();
  } finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); }
};
const runJson = (name, conclusion, app = "github-actions") =>
  JSON.stringify({ name, status: "completed", conclusion, id: 1, completed_at: new Date().toISOString(), app: { slug: app, id: 1 } });
{
  const partial = withFakes(`  */check-runs*) echo '${runJson("CI Gate", "success")}';;
  */status*) echo "gh: HTTP 502" >&2; exit 1;;`, () => readChecks("o/r", HEAD));
  const whole = withFakes(`  */check-runs*) echo '${runJson("CI Gate", "success")}';;
  */status*) echo '{"context":"lint","state":"success"}';;`, () => readChecks("o/r", HEAD));
  check(partial.ok === false && /502/.test(partial.why ?? "") && whole.ok === true && whole.rows.length === 2,
    "a read of a head's checks is ok only when its check runs and its statuses were both read in full",
    JSON.stringify({ partial: { ok: partial.ok, why: partial.why }, whole: { ok: whole.ok, rows: whole.rows.length } }));
  const unread = classifyRead({ ok: false, why: "gh: HTTP 502", rows: [run("CI Gate", "success")] }, { required: ["CI Gate"] });
  const seenFailing = classifyRead({ ok: false, why: "gh: HTTP 502", rows: [run("CI Gate", "failure")] }, { required: ["CI Gate"] });
  check(unread.verdict === "UNKNOWN" && /couldn't be read in full/.test(unread.why) && seenFailing.verdict === "RED",
    "a read that isn't whole passes nothing, but a failure it did read stays a failure", JSON.stringify({ unread, seenFailing }));
}

// ── another App's check under reeve's own name ───────────────────────────────
const P = { rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
            authority: { policy: "propose_and_merge" }, watch: { reviewActions: true } };
const decide = (ci) => nextAction({
  pr: 1, state: "open", checks: {}, rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  verdict: { state: ci.state, summary: "x", clauses: CLAUSE_IDS.map((id) => (id === "ci" ? ci : { id, state: "PASS", detail: "" })) },
}, P);
{
  const impostor = run(POLICY_CONTEXT, "success", { app: "look-alike" });
  const v = computeVerdict({ head: HEAD, checks: { verdict: "GREEN", settled: true, failing: [], impostors: [impostor] } });
  const ci = v.clauses.find((c) => c.id === "ci");
  const unsettled = computeVerdict({ head: HEAD, checks: { verdict: "SETTLING", settled: false, failing: [], impostors: [impostor] } })
    .clauses.find((c) => c.id === "ci");
  const d = decide(ci);
  check(ci.state === "BLOCK" && /look-alike/.test(ci.detail) && unsettled.state === "BLOCK" && d.action === ACTIONS.ESCALATE && d.why === ESCALATIONS.IMPOSTOR,
    "another App's check under reeve's own name blocks CI, settled or not, and goes to a person, not a fixer",
    JSON.stringify({ ci, unsettled, d }));
  const skipped = classify([run("test", "skipped"), run("lint", "success")], ["test"]);
  const ds = decide({ id: "ci", state: "BLOCK", detail: skipped.why });
  check(ds.action === ACTIONS.ESCALATE && ds.why === ESCALATIONS.SKIPPED_REQUIRED,
    "a skipped required check goes to a person too: no fixer can make a job run that its workflow skips", JSON.stringify(ds));
}

// ── through evaluatePr ──────────────────────────────────────────────────────
// Three ticks, as the daemon would take them, so a green reading can settle.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-ci-read-db-"));
  const db = open(join(dir, "state.db"));
  const profile = { ci: { requiredChecks: [], reviewerStatusContexts: [] }, reviewers: [] };
  let pr = 100;
  const ciAfterTicks = (answers) => withFakes(answers, () => {
    pr++;
    const anchor = { ok: true, headRef: "feature", baseRef: "main", state: "OPEN", title: "t", updatedAt: "2026-09-25T00:00:00Z",
                     head: HEAD, pin: { ok: true, sha: HEAD }, authorLogin: "someone" };
    let r;
    for (let k = 0; k < 3; k++) r = evaluatePr({ nwo: "o/r", pr, profile, db, anchor });
    const clause = (id) => (r.ok ? r.verdict.clauses.find((c) => c.id === id) : { state: "none", detail: r.why });
    return { ...clause("ci"), base: clause("base") };
  });
  const base = `  */commits/${BASE}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${BASE}/status*) ;;
  */check-suites*) echo '[{"app":{"slug":"github-actions"},"status":"completed"}]';;`;
  const requiresGate = `  */rules/branches/*) echo '{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"CI Gate"}]}}';;
  */branches/main) echo '{"protected":true,"protection":{"enabled":false}}';;`;
  const control = ciAfterTicks(`${base}
${requiresGate}
  */commits/${HEAD}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${HEAD}/status*) ;;`);
  const statusesUnread = ciAfterTicks(`${base}
${requiresGate}
  */commits/${HEAD}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${HEAD}/status*) echo "gh: HTTP 502" >&2; exit 1;;`);
  const gateSkipped = ciAfterTicks(`${base}
${requiresGate}
  */commits/${HEAD}/check-runs*) echo '${runJson("CI Gate", "skipped")}'
    echo '${runJson("lint", "success")}';;
  */commits/${HEAD}/status*) ;;`);
  const baseUnread = ciAfterTicks(`  */commits/${BASE}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${BASE}/status*) echo "gh: HTTP 502" >&2; exit 1;;
  */check-suites*) echo '[{"app":{"slug":"github-actions"},"status":"completed"}]';;
${requiresGate}
  */commits/${HEAD}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${HEAD}/status*) ;;`);
  // A push whose path filters skipped every check, the one the base requires
  // among them.
  const noSuites = `  */commits/${BASE}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${BASE}/status*) ;;`;
  const gateSkippedNoSuites = ciAfterTicks(`${noSuites}
${requiresGate}
  */commits/${HEAD}/check-runs*) echo '${runJson("CI Gate", "skipped", "other-ci")}'
    echo '${runJson("lint", "success", "other-ci")}';;
  */commits/${HEAD}/status*) ;;`);
  const failingPartly = ciAfterTicks(`${base}
${requiresGate}
  */commits/${HEAD}/check-runs*) echo '${runJson("CI Gate", "failure")}';;
  */commits/${HEAD}/status*) echo "gh: HTTP 502" >&2; exit 1;;`);
  const shadowGated = ciAfterTicks(`${base}
  */rules/branches/*) echo '{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"CI Gate"},{"context":"${shadowContextOf(POLICY_CONTEXT)}"}]}}';;
  */branches/main) echo '{"protected":true,"protection":{"enabled":false}}';;
  */commits/${HEAD}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${HEAD}/status*) ;;`);
  const baseSkipped = ciAfterTicks(`  */commits/${BASE}/check-runs*) echo '${runJson("CI Gate", "skipped")}'
    echo '${runJson("lint", "skipped")}';;
  */commits/${BASE}/status*) ;;
  */check-suites*) echo '[{"app":{"slug":"github-actions"},"status":"completed"}]';;
${requiresGate}
  */commits/${HEAD}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${HEAD}/status*) ;;`);
  const impersonated = ciAfterTicks(`${base}
${requiresGate}
  */commits/${HEAD}/check-runs*) echo '${runJson("CI Gate", "success")}'
    echo '${runJson(POLICY_CONTEXT, "success", "look-alike")}';;
  */commits/${HEAD}/status*) ;;`);
  check(control.state === "PASS" && control.base?.state === "PASS",
    "control: through evaluatePr, a whole read of a passing required check settles to PASS, on the head and the base", JSON.stringify(control));
  check(gateSkippedNoSuites.state === "BLOCK" && /skipped or neutral/.test(gateSkippedNoSuites.detail),
    "through evaluatePr, a skipped required check from another CI blocks at once, though no GitHub Actions suite exists to finish", JSON.stringify(gateSkippedNoSuites));
  check(failingPartly.state === "BLOCK" && /CI Gate/.test(failingPartly.detail),
    "through evaluatePr, a failure read where the statuses couldn't be blocks as a failure", JSON.stringify(failingPartly));
  check(shadowGated.state === "BLOCK" && /shadow check/.test(shadowGated.detail),
    "through evaluatePr, a base that requires reeve's shadow check blocks", JSON.stringify(shadowGated));
  check(baseSkipped.base?.state === "PASS",
    "through evaluatePr, a base whose push skipped every check, the one it requires among them, is healthy: the base is judged by its failures", JSON.stringify(baseSkipped));
  check(baseUnread.base?.state === "UNKNOWN",
    "through evaluatePr, a base whose statuses couldn't be read has unknown health, though its check runs pass", JSON.stringify(baseUnread));
  check(statusesUnread.state === "UNKNOWN" && /couldn't be read in full/.test(statusesUnread.detail),
    "through evaluatePr, a head whose statuses couldn't be read has no CI pass, though its check runs pass", JSON.stringify(statusesUnread));
  check(gateSkipped.state === "BLOCK" && /skipped or neutral/.test(gateSkipped.detail),
    "through evaluatePr, a check the base requires that was skipped blocks, though the profile names none", JSON.stringify(gateSkipped));
  check(impersonated.state === "BLOCK" && /look-alike/.test(impersonated.detail),
    "through evaluatePr, another App's check under reeve's own name blocks", JSON.stringify(impersonated));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
