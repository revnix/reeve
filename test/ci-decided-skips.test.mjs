// Two ways the Nextly shadow trial found reeve blocking a pull request that the
// customer's rule and GitHub let merge (#344), decided by the founder on
// 2026-10-02: a required check CI's own decision skipped, and a failing check no
// rule requires.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { classifyRead, evaluateQueueEntry, headCheckRequirements } from "../src/pr.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { validate } from "../src/profile/schema.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const A = "a".repeat(40), Q = "c".repeat(40);
const ACTIONS = "15368";
const DECIDER = "Decide what this commit can affect";
const POSTGRES = "Integration (postgres)";
const WINDOWS = "Pre-push gates (windows-latest)";

/** A check run of GitHub Actions at a commit. */
const run = (/** @type {string} */ name, /** @type {string} */ conclusion, app = ACTIONS) =>
  ({ name, source: "check_run", state: "completed", conclusion, appId: app, id: "1", completedAt: new Date(0).toISOString() });
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
  // Every run of the decider: two workflows may each decide.
  assert.equal(judged([run("Build", "success"), run(DECIDER, "success"), run(DECIDER, "success"), run(POSTGRES, "skipped")]).verdict, "GREEN");
});

test("a skip stays unpassed where the decider failed, didn't run, isn't GitHub's run of the same App, or isn't named", () => {
  const ok = [run("Build", "success"), run(DECIDER, "success"), run(POSTGRES, "skipped")];
  assert.equal(judged(ok).verdict, "GREEN", "control");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "failure"), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED", "the decider failed");
  assert.equal(judged([run("Build", "success"), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED", "no decider ran");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "skipped"), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED", "the decider skipped itself");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "success"), run(DECIDER, "cancelled"), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED",
               "one of its runs didn't succeed");
  assert.equal(judged([run("Build", "success"), { ...run(DECIDER, "success"), source: "status" }, run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED",
               "a commit status under the decider's name, which names no App");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "success", "999"), run(POSTGRES, "skipped")]).verdict, "SKIPPED_REQUIRED",
               "another App's run of that name");
  assert.equal(judged(ok, { ci: { provider: "github-actions", requiredChecks: [] } }).verdict, "SKIPPED_REQUIRED", "a profile naming no decider");
  assert.equal(judged([run("Build", "skipped"), run(DECIDER, "success"), run(POSTGRES, "success")]).verdict, "SKIPPED_REQUIRED",
               "a required check the decider isn't named for");
  assert.equal(judged([run("Build", "success"), run(DECIDER, "success"), run(POSTGRES, "neutral")]).verdict, "SKIPPED_REQUIRED", "neutral, not skipped");
});

test("a skip isn't taken as decided beside any failure, as a job skipped for a failed one it needs looks the same", () => {
  const head = judged([run("Build", "success"), run(DECIDER, "success"), run(POSTGRES, "skipped"), run(WINDOWS, "failure")]);
  assert.equal(head.verdict, "SKIPPED_REQUIRED", head.why);
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
    const beside = atQueue([run("Build", "success"), run(POSTGRES, "success"), run(WINDOWS, "failure")], 43);
    assert.equal(ci(beside)?.state, "PASS", JSON.stringify(ci(beside)));
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
});
