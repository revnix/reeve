// A base's health, judged by the checks its rules require (#288): after #287,
// every Nextly pull request was still held because two workflows no rule
// requires failed on main, the review bot's run and a Dependabot run, while
// every check that gates merges there was green.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { classify } from "../src/github/reconciler.mjs";
import { classifyRead, evaluateQueueEntry, baseHealthOf, gatingOf } from "../src/pr.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const ACTIONS = "15368";
/** A check run at a commit, completed with `conclusion`, or still in flight where that's null. */
const run = (name, conclusion, app = ACTIONS) => ({ name, source: "check_run", appId: app, id: "1",
  state: conclusion == null ? "in_progress" : "completed", conclusion, completedAt: new Date(0).toISOString() });
/** What main's rules require: its CI gate, bound to GitHub Actions. */
const gates = [{ context: "CI gate", app: ACTIONS }];
/** A base's health, as the daemon reads it: for failures, with the checks that gate merges known or not. */
const health = (rows, failuresOf = gates) => classify(rows, [], { evidence: false, failuresOf });

test("a workflow no rule requires, failing on the base, doesn't make it red where the checks that gate merges pass", () => {
  const h = health([run("CI gate", "success"), run("Dependabot", "failure"), run("review", "failure")]);
  assert.equal(h.verdict, "GREEN", h.why);
  assert.deepEqual(h.ancillaryFailing, ["Dependabot", "review"], "and they're named, not dropped");
});

test("a check that gates merges, failing on the base, still makes it red, and is the one named failing", () => {
  const h = health([run("CI gate", "failure"), run("Dependabot", "failure")]);
  assert.equal(h.verdict, "RED");
  assert.deepEqual(h.failing.map((r) => r.name), ["CI gate"]);
});

test("only the check its rule is bound to gates: another App's of the same name, failing, doesn't", () => {
  assert.equal(health([run("CI gate", "success"), run("CI gate", "failure", "999")]).verdict, "GREEN");
});

test("a workflow no rule requires, running or cancelled on the base, doesn't hold its health either", () => {
  assert.equal(health([run("CI gate", "success"), run("Dependabot", null)]).verdict, "GREEN", "still running");
  assert.equal(health([run("CI gate", "success"), run("Dependabot", "cancelled")]).verdict, "GREEN", "cancelled");
  assert.equal(health([run("CI gate", null), run("Dependabot", "success")]).verdict, "RUNNING", "control: the gating check still running");
});

test("where the checks that gate merges on the base aren't known, every failure there still counts", () => {
  assert.equal(health([run("CI gate", "success"), run("Dependabot", "failure")], null).verdict, "RED");
  assert.equal(health([run("CI gate", "success"), run("Dependabot", "failure")], []).verdict, "RED", "nor where the base requires none");
});

test("the verdict names a failure on the base that no rule requires, while passing the base clause", () => {
  const h = health([run("CI gate", "success"), run("Dependabot", "failure")]);
  const base = baseHealthOf(h, { complete: true, inHead: null });
  assert.deepEqual(base.ancillaryFailing, ["Dependabot"]);
  const c = computeVerdict(/** @type {any} */ ({ head: "a".repeat(40), base })).clauses.find((x) => x.id === "base");
  assert.equal(c?.state, "PASS");
  assert.match(String(c?.detail), /base is green; Dependabot failing there, which no rule requires/);
});

test("a merge queue's commit is judged on a base whose health comes from the checks that gate merges", () => {
  const BASE = "d".repeat(40), Q = "c".repeat(40), A = "a".repeat(40);
  const db = open(join(tempDir("reeve-base-health-"), "s.db"));
  const input = { head: A, checks: { verdict: "GREEN", settled: true, readable: true, failing: [], inherited: [], impostors: [] },
                  base: { verdict: "GREEN", readable: true }, reviewers: [], rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
                  threads: { unresolved: 0, total: 0, readable: true }, mergeState: "CLEAN" };
  const read = (_nwo, sha) => ({ ok: true, rows: sha === BASE ? [run("CI gate", "success"), run("Dependabot", "failure")] : [run("CI gate", "success")] });
  const j = evaluateQueueEntry({ nwo: "o/r", entry: { pr: 42, sha: Q, prHead: A, baseSha: BASE }, input, baseRef: "main", profile: { ci: {} }, db,
                                 read, requirements: () => ({ required: gates.map((c) => ({ ...c, origin: "base" })), known: true }), contains: () => true });
  db.close();
  assert.ok(j.ok, j.why);
  assert.equal(j.input.base.verdict, "GREEN");
});

test("a pull request's head is judged on a base whose health comes from the checks that gate merges", () => {
  const src = readFileSync(new URL("../src/pr.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function evaluatePr("), src.indexOf("\n}\n", src.indexOf("export function evaluatePr(")));
  assert.match(body, /classifyRead\(baseRead, \{ required: profile\.ci\?\.requiredChecks \?\? \[\], failuresOf: gatingOf\(req\) \}, \{ evidence: false \}\)/);
  assert.ok(classifyRead, "control: the reading this names exists");
});

test("the checks that gate merges are the base's required ones, only where they're known and there are any", () => {
  assert.deepEqual(gatingOf({ known: true, required: gates }), gates);
  assert.equal(gatingOf({ known: false, required: gates }), null, "rules that couldn't be read");
  assert.equal(gatingOf({ known: true, required: [] }), null, "a base that requires none");
});
