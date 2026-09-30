// Where the Nextly shadow trial found Reeve and the repository it judges
// disagreeing, so that no pull request could ever pass (#286): a required check
// that runs only in the merge queue, review bodies written by people, and a red
// base blocking the pull request that repairs it.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { classifyRead, evaluateQueueEntry, headCheckRequirements, baseHealthOf, passedNames } from "../src/pr.mjs";
import { readFileSync } from "node:fs";
import { computeVerdict } from "../src/verdict.mjs";
import { validate, withDefaults } from "../src/profile/schema.mjs";
import { derivePr, reviewState } from "../src/review/derive.mjs";
import { ingest, noteHead } from "../src/review/ingest.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const NWO = "o/r", PR = 42;
const A = "a".repeat(40), Q = "c".repeat(40);
const ACTIONS = "15368";
const REVIEWED = "Independent review of the revision being merged";

/** A check run of GitHub Actions at a commit. */
const run = (name, conclusion) => ({ name, source: "check_run", state: "completed", conclusion, appId: ACTIONS, id: "1",
                                     completedAt: new Date(0).toISOString() });
const required = [{ context: "Build", app: ACTIONS }, { context: REVIEWED, app: ACTIONS }];
/** At a pull request's head: the build passed, and the queue's own check was skipped, as it runs only in the queue. */
const atHead = [run("Build", "success"), run(REVIEWED, "skipped")];
const queueProfile = { ci: { provider: "github-actions", requiredChecks: [], queueOnlyChecks: [REVIEWED] } };

// ── a required check that runs only in the merge queue ──────────────────────

test("a required check the profile says runs only in the merge queue, skipped at a pull request's head, doesn't block it there", () => {
  const head = classifyRead({ ok: true, rows: atHead }, headCheckRequirements({ required, known: true }, queueProfile));
  assert.equal(head.verdict, "GREEN", head.why);
  assert.deepEqual(head.queueOnly, [REVIEWED], "and it's named, as judged at the queue's commit");
  const undeclared = classifyRead({ ok: true, rows: atHead }, headCheckRequirements({ required, known: true }, { ci: {} }));
  assert.equal(undeclared.verdict, "SKIPPED_REQUIRED", "control: one the profile doesn't name still never passed");
});

test("only skipped is let through: a queue-only check that failed or never reported at the head still counts", () => {
  const req = headCheckRequirements({ required, known: true }, queueProfile);
  assert.equal(classifyRead({ ok: true, rows: [run("Build", "success"), run(REVIEWED, "failure")] }, req).verdict, "RED");
  assert.equal(classifyRead({ ok: true, rows: [run("Build", "success")] }, req).verdict, "MISSING_REQUIRED");
  assert.equal(classifyRead({ ok: true, rows: [run("Build", "success"), run(REVIEWED, "neutral")] }, req).verdict, "SKIPPED_REQUIRED",
               "and one neutral, not skipped, still never passed");
  assert.equal(classifyRead({ ok: true, rows: [run("Build", "skipped"), run(REVIEWED, "skipped")] }, req).verdict, "SKIPPED_REQUIRED",
               "and another required check skipped still blocks");
});

test("at the merge queue's commit, a queue-only check must pass like any other", () => {
  const dir = tempDir("reeve-trial-queue-");
  const db = open(join(dir, "s.db"));
  const input = { head: A, checks: { verdict: "GREEN", settled: true, readable: true, failing: [], inherited: [], impostors: [] },
                  base: { verdict: "GREEN", readable: true }, reviewers: [], rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
                  threads: { unresolved: 0, total: 0, readable: true }, mergeState: "CLEAN" };
  const judged = evaluateQueueEntry({ nwo: NWO, entry: { pr: PR, sha: Q, prHead: A }, input, baseRef: "main", profile: queueProfile, db,
                                      read: () => ({ ok: true, rows: atHead }), requirements: () => ({ required, known: true }) });
  db.close();
  assert.ok(judged.ok, judged.why);
  const ci = judged.verdict.clauses.find((c) => c.id === "ci");
  assert.equal(ci?.state, "BLOCK", JSON.stringify(ci));
  assert.match(String(ci?.detail), /skipped or neutral, so they never reported a pass: Independent review/);
});

test("the verdict says a queue-only check skipped at the head is judged at the queue's commit", () => {
  const input = { head: A, checks: { verdict: "GREEN", settled: true, readable: true, failing: [], inherited: [], impostors: [], queueOnly: [REVIEWED] },
                  base: { verdict: "GREEN", readable: true } };
  const ci = computeVerdict(/** @type {any} */ (input)).clauses.find((c) => c.id === "ci");
  assert.equal(ci?.state, "PASS");
  assert.match(String(ci?.detail), /Independent review of the revision being merged runs only in the merge queue, and is judged at its commit/);
});

test("a profile names its queue-only checks as a list of names", () => {
  // A whole profile, as the profile validation tests make one.
  const base = withDefaults({
    schemaVersion: 1, project: { kind: "product" },
    identity: { key: NWO, defaultBranch: "main", visibility: "private" },
    authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "sidecar" },
    state: { mode: "in-repo" },
    units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm", commands: { test: { cmd: "pnpm test", state: "present" } } }],
    ci: { provider: "github-actions", requiredChecks: [] }, merge: { method: "squash", enforcement: "enforced" },
  });
  assert.deepEqual(validate(base).errors, [], "control: the profile is whole");
  const ok = validate({ ...base, ci: { ...base.ci, queueOnlyChecks: [REVIEWED] } });
  assert.deepEqual(ok.errors, [], JSON.stringify(ok.errors));
  const bad = validate({ ...base, ci: { ...base.ci, queueOnlyChecks: [7] } });
  assert.ok(bad.errors.some((e) => /queueOnlyChecks/.test(e)), JSON.stringify(bad.errors));
});

// ── review bodies written by people ─────────────────────────────────────────

const T = 1_800_000_000;
/** A review as GitHub's REST API reports it: an App's login ends in [bot], and is kept whole in the payload. */
const review = (id, login, body, state = "COMMENTED") => ({
  source: login.replace(/\[bot\]$/, ""), external_id: `review:${id}`, kind: "review", head_sha: A, event_at: T + id, edited_at: null,
  payload: { login, state, commit_id: A, body },
});
/** What the review fold makes of `reviews` on a pull request, with `reviewers` rostered. */
function fold(reviews, reviewers = []) {
  const db = open(join(tempDir("reeve-trial-reviews-"), "s.db"));
  noteHead(db, NWO, PR, A, T);
  ingest(db, NWO, PR, reviews, { at: T });
  const profile = { watch: { staleSeconds: 900 }, reviewers };
  derivePr(db, NWO, PR, profile, { at: T + 100, head: A });
  const st = reviewState(db, NWO, PR, profile, { at: T + 100, head: A });
  db.close();
  return st;
}

test("a person's review body isn't read as findings, so an approval that says LGTM doesn't block", () => {
  const st = fold([review(1, "a-person", "LGTM", "APPROVED"), review(2, "another-person", "Looks fine, one small nit on naming.")]);
  assert.deepEqual(st.unreadableBodies, [], JSON.stringify(st.unreadableBodies));
  assert.equal(st.bodyFindingsDerived, true, "and the count is complete");
});

test("a bot's review body with no reading rule is still unreadable, and blocks", () => {
  const st = fold([review(1, "some-bot[bot]", "Found 2 issues, see below.")]);
  assert.equal(st.unreadableBodies.length, 1, JSON.stringify(st.unreadableBodies));
  assert.equal(st.unreadableBodies[0].reviewer, "some-bot");
});

test("a person the profile gives a reading rule is read by it", () => {
  const st = fold([review(1, "a-person", "FINDING: this drops a write.")], [{ login: "a-person", kind: "blocking", bodyFindings: "FINDING:" }]);
  assert.equal(st.bodyOpen, 1, JSON.stringify(st));
});

// ── a red base, and the pull request that repairs it ────────────────────────

/** A verdict's base clause, for a head whose checks are `checks` and a base failing `failing`. */
const baseClause = (checks, failing) => computeVerdict(/** @type {any} */ ({ head: A, checks, base: { verdict: "RED", readable: true, failing } }))
  .clauses.find((c) => c.id === "base");
const green = (passed) => ({ verdict: "GREEN", settled: true, readable: true, failing: [], inherited: [], impostors: [], passed });

test("a pull request whose green head passes every check failing on a red base repairs it, and passes the base clause", () => {
  const c = baseClause(green(["Build", "Lint"]), ["Build"]);
  assert.equal(c?.state, "PASS", JSON.stringify(c));
  assert.match(String(c?.detail), /the base branch is red, and this pull request passes every check failing there \(Build\), so it repairs it/);
});

test("a red base still blocks a pull request that doesn't show passing every check failing there", () => {
  assert.equal(baseClause(green(["Build"]), ["Build", "Deploy"])?.state, "BLOCK", "a check failing on the base that the head doesn't run");
  assert.equal(baseClause({ ...green(["Build"]), verdict: "SETTLING", settled: false }, ["Build"])?.state, "BLOCK", "a head not settled green");
  assert.equal(baseClause(green(["Build"]), [])?.state, "BLOCK", "a base red with nothing named failing");
  assert.equal(baseClause(green([]), ["Build"])?.state, "BLOCK", "a head where the check only didn't fail");
});

test("the base's failing checks and the head's passed ones are named from what GitHub reported, a pass being only a success", () => {
  assert.deepEqual(baseHealthOf({ verdict: "RED", failing: [run("Build", "failure"), run("Build", "failure"), run("Lint", "timed_out")] }),
                   { verdict: "RED", readable: true, failing: ["Build", "Lint"] });
  assert.deepEqual(passedNames([run("Build", "success"), run("Lint", "skipped"), run("Docs", "neutral"), { name: "Slow", state: "in_progress" }]), ["Build"]);
});

test("a merge queue's commit that repairs its red base passes the base clause there too", () => {
  const dir = tempDir("reeve-trial-repair-");
  const db = open(join(dir, "s.db"));
  const input = { head: A, checks: green(["Build"]), base: { verdict: "GREEN", readable: true }, reviewers: [],
                  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 }, threads: { unresolved: 0, total: 0, readable: true }, mergeState: "CLEAN" };
  const BASE = "d".repeat(40);
  const read = (_nwo, sha) => ({ ok: true, rows: sha === BASE ? [run("Build", "failure")] : [run("Build", "success")] });
  const judged = evaluateQueueEntry({ nwo: NWO, entry: { pr: PR, sha: Q, prHead: A, baseSha: BASE }, input, baseRef: "main", profile: { ci: {} }, db,
                                      read, requirements: () => ({ required: [], known: true }) });
  db.close();
  assert.ok(judged.ok, judged.why);
  assert.deepEqual(judged.input.base.failing, ["Build"]);
  assert.deepEqual(judged.input.checks.passed, ["Build"]);
});

test("a pull request's head is judged with its queue-only checks, the base's failing checks and its own passed ones", () => {
  const src = readFileSync(new URL("../src/pr.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function evaluatePr("), src.indexOf("\n}\n", src.indexOf("export function evaluatePr(")));
  assert.match(body, /classifyRead\(read, headCheckRequirements\(req, profile\)\)/, "the queue-only checks");
  assert.match(body, /base: baseHealthOf\(base\),/, "the base's failing checks");
  assert.match(body, /passed: passedNames\(rows\)/, "and the head's passed ones");
});
