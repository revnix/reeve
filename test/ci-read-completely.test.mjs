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
import { classify, POLICY_CONTEXT, readChecks } from "../src/github/reconciler.mjs";
import { classifyRead, clearRequirements, evaluatePr, requiredChecksOf, requirementsOn } from "../src/pr.mjs";
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
  check(skipped.verdict === "MISSING_REQUIRED" && /skipped or neutral/.test(skipped.why) && neutral.verdict === "MISSING_REQUIRED"
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
  check(JSON.stringify(read.checks) === JSON.stringify(["CI Gate", POLICY_CONTEXT, "CodeRabbit", "legacy/ci"]) && read.others === null && unread.checks === null,
    "the base's required checks are read from its rules and its branch, even where the rest of protection can't be, and are unknown where those can't",
    JSON.stringify({ read: read.checks, others: read.others, unread: unread.checks }));
  const profile = { ci: { requiredChecks: ["e2e", "CI Gate"], reviewerStatusContexts: ["CodeRabbit"] } };
  const known = requiredChecksOf({ nwo: "o/r", baseRef: "main", profile, requirements: () => read, appId: null });
  const unknown = requiredChecksOf({ nwo: "o/r", baseRef: "main", profile, requirements: () => unread, appId: null });
  check(JSON.stringify(known) === JSON.stringify({ required: ["e2e", "CI Gate", "legacy/ci"], known: true })
    && JSON.stringify(unknown) === JSON.stringify({ required: ["e2e", "CI Gate"], known: false }),
    "a pull request's required checks are the profile's and the base's, reeve's own and reviewers' statuses aside", JSON.stringify({ known, unknown }));
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
  check(unread.verdict === "UNKNOWN" && /couldn't be read in full/.test(unread.why),
    "a read that isn't whole classifies as unknown, whatever the part that was read says", JSON.stringify(unread));
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
  const baseSkipped = ciAfterTicks(`  */commits/${BASE}/check-runs*) echo '${runJson("CI Gate", "skipped")}'
    echo '${runJson("lint", "success")}';;
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
  check(baseSkipped.base?.state === "PASS",
    "through evaluatePr, a base whose push skipped a check the base requires is healthy: the base is judged by its failures", JSON.stringify(baseSkipped));
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
