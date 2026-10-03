// Two ways the Nextly shadow trial found reeve blocking a pull request that the
// customer's rule and GitHub let merge (#344), decided by the founder on
// 2026-10-02: a required check CI's own decision skipped, and a failing check no
// rule requires.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { classifyRead, clearRequirements, evaluatePr, evaluateQueueEntry, headCheckRequirements } from "../src/pr.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { validate } from "../src/profile/schema.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const A = "a".repeat(40), Q = "c".repeat(40);
const ACTIONS = "15368";
const DECIDER = "Decide what this commit can affect";
const POSTGRES = "Integration (postgres)";
const WINDOWS = "Pre-push gates (windows-latest)";

/** A check run of GitHub Actions at a commit, in workflow run `suite`, its check suite. */
const run = (/** @type {string} */ name, /** @type {string} */ conclusion, { app = ACTIONS, suite = "1" } = {}) =>
  ({ name, source: "check_run", state: "completed", conclusion, appId: app, id: "1", suiteId: suite, completedAt: new Date(0).toISOString() });
const required = [{ context: "Build", app: ACTIONS }, { context: POSTGRES, app: ACTIONS }];
const decides = { ci: { provider: "github-actions", requiredChecks: [], decidedSkips: { by: DECIDER, checks: [POSTGRES] } } };
/** The head's checks as reeve reads them, judged by `profile`'s rules. */
const judged = (/** @type {any[]} */ rows, profile = decides, req = { required, known: true }) =>
  classifyRead({ ok: true, rows }, headCheckRequirements(req, profile, null));
/** The `ci` clause of a verdict on a head whose checks read as `c`. */
const ciClause = (/** @type {any} */ c) => computeVerdict({
  head: A, checks: { ...c, settled: true, readable: true, inherited: [], impostors: [] },
  base: { verdict: "GREEN", readable: true }, reviewers: [], rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 0, readable: true }, mergeState: "CLEAN" }).clauses.find((x) => x.id === "ci");

test("a required check skipped where CI's own decider succeeded at the head passes, and the verdict names it", () => {
  const head = judged([run("Build", "success"), run(DECIDER, "success"), run(POSTGRES, "skipped")]);
  assert.equal(head.verdict, "GREEN", head.why);
  assert.deepEqual(head.decided, [POSTGRES]);
  const ci = ciClause(head);
  assert.equal(ci?.state, "PASS");
  assert.match(String(ci?.detail), /Integration \(postgres\) skipped, as Decide what this commit can affect decided/);
  // Two workflows may each have a job of that name: the skip's own run decides it.
  assert.equal(judged([run("Build", "success", { suite: "2" }), run(DECIDER, "success", { suite: "2" }), run(DECIDER, "success"), run(POSTGRES, "skipped")]).verdict, "GREEN");
});

test("a skip stays unpassed where the decider failed, didn't run, isn't GitHub's run of the same App, or isn't named", () => {
  // Only the skip's own workflow run can decide it: another's job of the decider's name can't.
  assert.equal(judged([run("Build", "success"), run(DECIDER, "success", { suite: "2" }), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED", "a decider in another run");
  assert.equal(judged([run("Build", "success"), { ...run(DECIDER, "success"), suiteId: null }, { ...run(POSTGRES, "skipped"), suiteId: null }]).verdict, "SKIPPED_REQUIRED",
               "runs GitHub gave no suite for");
  const ok = [run("Build", "success"), run(DECIDER, "success"), run(POSTGRES, "skipped")];
  assert.equal(judged(ok).verdict, "GREEN", "control");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "failure"), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED", "the decider failed");
  assert.equal(judged([run("Build", "success"), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED", "no decider ran");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "skipped"), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED", "the decider skipped itself");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "success"), run(DECIDER, "cancelled"), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED",
               "one of its runs didn't succeed");
  assert.equal(judged([run("Build", "success"), { ...run(DECIDER, "success"), source: "status", suiteId: undefined }, run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED",
               "a commit status under the decider's name, which is no job of a run");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "success", { app: "999", suite: "9" }), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED",
               "another App's run of that name");
  assert.equal(judged(ok, { ci: { provider: "github-actions", requiredChecks: [] } }).verdict, "SKIPPED_REQUIRED", "a profile naming no decider");
  assert.equal(judged([run("Build", "skipped"), run(DECIDER, "success"), run(POSTGRES, "success")]).verdict, "SKIPPED_REQUIRED",
               "a required check the decider isn't named for");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "success"), run(POSTGRES, "neutral")]).verdict, "SKIPPED_REQUIRED", "neutral, not skipped");
});

test("a skip isn't taken as decided beside another job of its run that was skipped, failed, was cancelled or went stale", () => {
  // A job is skipped for one it needs that didn't succeed, and looks the same as one skipped by decision.
  const beside = (/** @type {string} */ conclusion, suite = "1") =>
    judged([run("Build", "success", { suite: "2" }), run(DECIDER, "success"), run(POSTGRES, "skipped"), run("Prepare", conclusion, { suite })]);
  for (const conclusion of ["skipped", "failure", "cancelled", "stale"])
    assert.notEqual(beside(conclusion).verdict, "GREEN", conclusion);
  // Another run's jobs can't be what its own were skipped for.
  for (const conclusion of ["skipped", "failure", "cancelled"]) {
    const head = beside(conclusion, "3");
    assert.notEqual(head.verdict === "SKIPPED_REQUIRED" && /Integration/.test(String(head.why)), true, `${conclusion} in another run: ${head.why}`);
  }
  const elsewhere = beside("failure", "3");
  assert.equal(elsewhere.verdict, "GREEN", elsewhere.why);
  assert.deepEqual([elsewhere.decided, elsewhere.ancillaryFailing], [[POSTGRES], ["Prepare"]]);
});

test("at a head only a failing required check blocks; another's failure is named, and doesn't hold it", () => {
  const head = judged([run("Build", "success"), run(POSTGRES, "success"), run(WINDOWS, "failure")]);
  assert.equal(head.verdict, "GREEN", head.why);
  assert.deepEqual(head.ancillaryFailing, [WINDOWS]);
  const ci = ciClause(head);
  assert.equal(ci?.state, "PASS");
  assert.match(String(ci?.detail), /Pre-push gates \(windows-latest\) failing, which no rule requires/);
  assert.equal(judged([run("Build", "failure"), run(POSTGRES, "success"), run(WINDOWS, "failure")]).verdict, "RED", "a required one still blocks");
  // With the base's requirements unread, none can be told apart: every failure counts.
  assert.equal(judged([run("Build", "success"), run(POSTGRES, "success"), run(WINDOWS, "failure")], decides, { required, known: false }).verdict, "RED");
});

test("at the merge queue's commit the same two rules hold", () => {
  const dir = tempDir("reeve-decided-queue-");
  const db = open(join(dir, "s.db"));
  const input = { head: A, checks: { verdict: "GREEN", settled: true, readable: true, failing: [], inherited: [], impostors: [] },
                  base: { verdict: "GREEN", readable: true }, reviewers: [], rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
                  threads: { unresolved: 0, total: 0, readable: true }, mergeState: "CLEAN" };
  /** The queue's commit for pull request `pr` judged as successive ticks would, until its green reading settles. */
  const atQueue = (/** @type {any[]} */ rows, /** @type {number} */ pr) => {
    let judged;
    for (let tick = 0; tick < 3; tick++)
      judged = evaluateQueueEntry({ nwo: "o/r", entry: { pr, sha: Q, prHead: A }, input, baseRef: "main", profile: decides, db,
                                    read: () => ({ ok: true, rows }), requirements: () => ({ required, known: true }) });
    return /** @type {any} */ (judged);
  };
  /** Its `ci` clause. */
  const ci = (/** @type {any} */ judged) => judged.verdict.clauses.find((/** @type {any} */ c) => c.id === "ci");
  try {
    const decided = atQueue([run("Build", "success"), run(DECIDER, "success"), run(POSTGRES, "skipped")], 42);
    assert.ok(decided.ok, decided.why);
    assert.equal(ci(decided)?.state, "PASS", JSON.stringify(ci(decided)));
    assert.match(String(ci(decided)?.detail), /Integration \(postgres\) skipped, as Decide what this commit can affect decided/);
    const beside = atQueue([run("Build", "success"), run(POSTGRES, "success"), run(WINDOWS, "failure")], 43);
    assert.equal(ci(beside)?.state, "PASS", JSON.stringify(ci(beside)));
    assert.match(String(ci(beside)?.detail), /Pre-push gates \(windows-latest\) failing, which no rule requires/);
  } finally { db.close(); }
});

test("a profile names the job that decides, and the required checks it may skip, both or neither", () => {
  const base = { schemaVersion: 1, project: { kind: "product" }, identity: { key: "acme/app", defaultBranch: "main", visibility: "public" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" }, state: { mode: "in-repo" },
    units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
    merge: { method: "squash", enforcement: "attested" }, reviewers: [] };
  const withCi = (/** @type {any} */ ci) => validate({ ...base, ci: { provider: "github-actions", ...ci } }).errors.join("\n");
  assert.equal(withCi({ decidedSkips: { by: DECIDER, checks: [POSTGRES] } }), "");
  assert.match(withCi({ decidedSkips: { by: DECIDER } }), /ci\.decidedSkips/, "the job alone");
  assert.match(withCi({ decidedSkips: { checks: [POSTGRES] } }), /ci\.decidedSkips/, "the checks alone");
  assert.match(withCi({ decidedSkips: DECIDER }), /ci\.decidedSkips must be an object/);
  assert.match(withCi({ decidedSkips: { by: DECIDER, checks: [7] } }), /ci\.decidedSkips\.checks/);
  assert.match(withCi({ decidedSkips: { by: DECIDER, checks: [] } }), /ci\.decidedSkips/, "a job with no checks to decide");
  // A matrix name never matches the name GitHub reports, so it would decide nothing.
  assert.match(withCi({ decidedSkips: { by: DECIDER, checks: ["Integration (${{ matrix.db }})"] } }), /ci\.decidedSkips\.checks contains an unexpanded matrix expression/);
  assert.match(withCi({ decidedSkips: { by: "Decide (${{ matrix.os }})", checks: [POSTGRES] } }), /ci\.decidedSkips\.by contains an unexpanded matrix expression/);
});

test("through evaluatePr, the verdict at a head names a decided skip, and a failure no rule requires", () => {
  const HEAD = A, BASE = "b".repeat(40);
  const runJson = (/** @type {string} */ name, /** @type {string} */ conclusion) =>
    JSON.stringify({ name, status: "completed", conclusion, id: 1, completed_at: new Date().toISOString(), app: { slug: "github-actions", id: 1 },
                     check_suite: { id: name === "CI Gate" || name === WINDOWS ? 6 : 5 } });
  const db = open(join(tempDir("reeve-decided-head-db-"), "s.db"));
  const page = JSON.stringify({ data: { repository: { pullRequest: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviewDecision: null,
    reviews: { totalCount: 0 }, reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
  const requires = JSON.stringify({ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI Gate" }, { context: POSTGRES }] } });
  /** The head's `ci` clause after three ticks, gh answering with `head`'s check runs. */
  const ciAt = (/** @type {string[]} */ head, /** @type {number} */ pr) => {
    const bin = tempDir("reeve-decided-bin-");
    const path = process.env.PATH;
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nfor a in "$@"; do case "$a" in repos/*|graphql) p="$a";; esac; done\ncase "$p" in\n  graphql) echo '${page}';;\n` +
      `  */commits/${BASE}/check-runs*) echo '${runJson("CI Gate", "success")}';;\n  */check-suites*) echo '[{"app":{"slug":"github-actions"},"status":"completed"}]';;\n` +
      `  */rules/branches/*) echo '${requires}';;\n  */branches/main) echo '{"protected":true,"protection":{"enabled":false}}';;\n` +
      `  */commits/${HEAD}/check-runs*) printf '%s\\n' ${head.map((h) => `'${h}'`).join(" ")};;\n  *) ;;\nesac\n`, { mode: 0o755 });
    writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = ls-remote ] && printf '%s\\trefs/heads/main\\n' ${BASE}\nexit 0\n`, { mode: 0o755 });
    const anchor = { ok: true, headRef: "feature", baseRef: "main", state: "OPEN", title: "t", updatedAt: "2026-10-03T00:00:00Z",
                     head: HEAD, pin: { ok: true, sha: HEAD }, authorLogin: "someone" };
    try {
      process.env.PATH = `${bin}:${path}`;
      clearRequirements();
      /** @type {any} */ let r;
      for (let k = 0; k < 3; k++) r = evaluatePr({ nwo: "o/r", pr, profile: { ...decides, reviewers: [] }, db, anchor });
      assert.ok(r.ok, r.why);
      return r.verdict.clauses.find((/** @type {any} */ c) => c.id === "ci");
    } finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); }
  };
  try {
    const decided = ciAt([runJson("CI Gate", "success"), runJson(DECIDER, "success"), runJson(POSTGRES, "skipped")], 7);
    assert.equal(decided?.state, "PASS", JSON.stringify(decided));
    assert.match(String(decided?.detail), /Integration \(postgres\) skipped, as Decide what this commit can affect decided/);
    const beside = ciAt([runJson("CI Gate", "success"), runJson(POSTGRES, "success"), runJson(WINDOWS, "failure")], 8);
    assert.equal(beside?.state, "PASS", JSON.stringify(beside));
    assert.match(String(beside?.detail), /Pre-push gates \(windows-latest\) failing, which no rule requires/);
  } finally { db.close(); }
});
