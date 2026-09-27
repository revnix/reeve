// A merge queue on the base (#163), measured on nextlyhq/merge-queue-sandbox on
// 2026-09-27 (docs/measured/2026-09-27-merge-queue.md).
//
// Under a required queue, GitHub reports a pull request whose required checks
// pass as CLEAN, not BLOCKED: the queue is where it merges, not a reason it
// can't. So when a base with a queue reports BLOCKED, the queue isn't among the
// reasons, and reading it as a requirement only a person can settle made a
// pull request whose one outstanding check is reeve's own an UNKNOWN for good.
import test from "node:test";
import assert from "node:assert/strict";
import { readMergeParts } from "../src/pr.mjs";
import { computeVerdict } from "../src/verdict.mjs";

const OWN = { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ops/merge-policy", integration_id: 1 }, { context: "test", integration_id: 15368 }] } };
const QUEUE = { type: "merge_queue", parameters: { merge_method: "SQUASH", grouping_strategy: "ALLGREEN", check_response_timeout_minutes: 10 } };

/** The merge parts of a BLOCKED pull request on a base whose rules are `rules`, with its `test` check passing. */
function partsWith(rules, base) {
  const gh = args => {
    const path = args.find(a => a.startsWith("repos/"));
    if (path.includes("/rules/branches/")) return { ok: true, out: rules.map(r => JSON.stringify(r)).join("\n") };
    if (path.endsWith("/protection")) return { ok: false, err: "gh: Branch not protected (HTTP 404)" };
    return { ok: true, out: JSON.stringify({ protected: true, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } }) };
  };
  const rows = [{ name: "test", state: "completed", conclusion: "success", source: "check_run", appId: 15368, completedAt: new Date().toISOString() }];
  return readMergeParts("o/r", base, { mergeState: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: null, readable: true, unresolved: 0 },
                        { gh, appId: "1", rows, head: "a".repeat(40) });
}

test("a merge queue on the base isn't a requirement only a person can settle", () => {
  const parts = partsWith([OWN, QUEUE], "queued-base");
  assert.equal(parts.ownCheckRequired, true, "control: reeve's own check is required");
  assert.deepEqual(parts.unevaluated, []);
});

test("a pull request blocked only by reeve's own check can pass on a base with a merge queue", () => {
  const verdict = computeVerdict({
    head: "a".repeat(40),
    checks: { verdict: "GREEN", settled: true, failing: [] },
    base: { verdict: "GREEN" },
    reviewers: [],
    rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    threads: { unresolved: 0, total: 0, readable: true },
    cleared: { readable: true, uncleared: 0, reviewers: [] },
    bodyFindings: { readable: true, open: 0, reviewers: [] },
    unreadableBodies: { readable: true, open: 0, reviewers: [] },
    ledgerBlockers: 0,
    mergeState: "BLOCKED",
    mergeParts: partsWith([OWN, QUEUE], "queued-base-verdict"),
  });
  assert.equal(verdict.clauses.find(c => c.id === "mergeable")?.state, "PASS");
});

// ── reading the queue, and judging the commit it built ────────────────────────

import { readMergeQueue, evaluateQueueEntry } from "../src/pr.mjs";
import { open } from "../src/db/ops.mjs";
import { join } from "node:path";
import { tempDir } from "./fixtures/temp.mjs";

const HEAD = "a".repeat(40), QUEUED = "c".repeat(40), BASE = "b".repeat(40);

test("the queue is read as its entries, each with the commit the queue built for it", () => {
  const page = { data: { repository: { mergeQueue: { entries: { nodes: [
    { state: "AWAITING_CHECKS", headCommit: { oid: QUEUED }, baseCommit: { oid: BASE }, pullRequest: { number: 7 } },
    { state: "QUEUED", headCommit: null, baseCommit: null, pullRequest: { number: 8 } },
  ] } } } } };
  const q = readMergeQueue("o/r", "main", { gh: () => ({ ok: true, out: JSON.stringify(page) }) });
  assert.deepEqual(q, { ok: true, queue: true, entries: [
    { pr: 7, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" },
    { pr: 8, sha: null, baseSha: null, state: "QUEUED" },
  ] });
  assert.deepEqual(readMergeQueue("o/r", "main", { gh: () => ({ ok: true, out: JSON.stringify({ data: { repository: { mergeQueue: null } } }) }) }),
                   { ok: true, queue: false, entries: [] }, "a branch without a queue");
  assert.equal(readMergeQueue("o/r", "main", { gh: () => ({ ok: false, err: "HTTP 502" }) }).ok, false, "a read that failed");
});

/** A pull request's input as evaluatePr hands it back, every clause passing at its head. */
const passing = () => ({
  head: HEAD,
  checks: { verdict: "GREEN", settled: true, why: null, readable: true, failing: [], inherited: [], impostors: [], shadowRequired: false },
  base: { verdict: "GREEN", readable: true },
  reviewers: [],
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 0, readable: true },
  cleared: { readable: true, uncleared: 0, reviewers: [] },
  bodyFindings: { readable: true, open: 0, reviewers: [] },
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
  ledgerBlockers: 0,
  mergeState: "CLEAN",
});
const checkRow = (name, conclusion) => ({ name, source: "check_run", state: "completed", conclusion, id: "1", appId: "15368", completedAt: new Date().toISOString() });
/** The queue commit's verdict, with `test` reading `conclusion` there and passing on the base. */
function judgeQueued(db, conclusion) {
  // `test` reads `conclusion` on the queue's commit only; it passes at the head and on the base.
  const read = (_nwo, sha) => ({ ok: true, rows: [checkRow("test", sha === QUEUED ? conclusion : "success")], impostors: [] });
  const requirements = () => ({ required: [{ context: "test", app: null, origin: "base" }], known: true, shadowRequired: false });
  return evaluateQueueEntry({ nwo: "o/r", entry: { pr: 7, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }, input: passing(),
                              baseRef: "main", profile: { ci: { requiredChecks: [] } }, db, read, requirements });
}

test("the queue's commit is judged by its own checks: failing there blocks, though the pull request passes at its head", () => {
  const db = open(join(tempDir("reeve-queue-"), "s.db"));
  const v = judgeQueued(db, "failure").verdict;
  db.close();
  assert.equal(v.head, QUEUED);
  assert.equal(v.state, "BLOCK");
  assert.match(v.clauses.find(c => c.id === "ci")?.detail ?? "", /test/);
});

test("a queue commit is judged only with the pull request's facts from this tick", () => {
  const r = evaluateQueueEntry({ nwo: "o/r", entry: { pr: 7, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }, input: undefined,
                                 baseRef: "main", profile: { ci: { requiredChecks: [] } }, db: null,
                                 read: () => ({ ok: true, rows: [checkRow("test", "success")], impostors: [] }),
                                 requirements: () => ({ required: [], known: true, shadowRequired: false }) });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, undefined, "no verdict built from nothing");
});

test("the queue's commit settles apart from the pull request's head, and passes once settled", () => {
  const db = open(join(tempDir("reeve-queue-"), "s.db"));
  const first = judgeQueued(db, "success").verdict;
  assert.equal(first.clauses.find(c => c.id === "ci")?.kind, "waiting", "one green reading is still settling");
  judgeQueued(db, "success");
  const third = judgeQueued(db, "success").verdict;
  const headRow = db.prepare("SELECT count(*) AS n FROM settlement WHERE nwo = ? AND pr = ?").get("o/r", 7).n;
  db.close();
  assert.equal(third.state, "PASS");
  assert.equal(third.head, QUEUED);
  assert.equal(headRow, 0, "the pull request's own settlement is untouched");
});

// ── each tick judges the queue's commits ──────────────────────────────────────

import { run, EVAL } from "./fixtures/tick-harness.mjs";
import { decisionsFor } from "../src/db/records.mjs";
import { replayDecisions } from "../src/decisions.mjs";
import { computeVerdict as recompute } from "../src/verdict.mjs";

/** PR 42 evaluated at its head with every clause passing, on base main. */
const evaluated = () => ({ ...EVAL, baseRef: "main", head: HEAD, input: passing(), verdict: computeVerdict(passing()) });
/** The queue holding PR 42 at QUEUED, awaiting its checks. */
const queued = (entries = [{ pr: 42, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }]) => () => ({ ok: true, queue: true, entries });
/** A queue commit judged PASS from the pull request's input. */
const judged = ({ entry, input }) => { const i = { ...input, head: entry.sha }; return { ok: true, input: i, verdict: recompute(i) }; };

test("each tick publishes a verdict on a queued pull request's own commit, beside the one at its head", async () => {
  const published = [];
  const publish = async ({ verdict, shadow }) => { published.push({ head: verdict.head, state: verdict.state, shadow }); return { ok: true, id: published.length }; };
  const r = await run({ evaluate: evaluated, readQueue: queued(), evaluateQueue: judged, publish });
  assert.deepEqual(published.map(p => p.head), [HEAD, QUEUED]);
  assert.deepEqual(published[1], { head: QUEUED, state: "PASS", shadow: true }, "shadow here, as the tick is");
  assert.match(r.log, /#42 queued at c{10}: PASS/);
});

test("a queued pull request this tick didn't evaluate isn't judged, since its facts can't carry over", async () => {
  const published = [];
  const publish = async ({ verdict }) => { published.push(verdict.head); return { ok: true, id: 1 }; };
  const r = await run({ evaluate: evaluated, readQueue: queued([{ pr: 99, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }]), evaluateQueue: judged, publish });
  assert.deepEqual(published, [HEAD], "control: the pull request itself was still published");
  assert.match(r.log, /#99 queued at c{10}: not judged/);
});

test("a queue that can't be read is logged, and the tick goes on", async () => {
  const r = await run({ evaluate: evaluated, readQueue: () => ({ ok: false, why: "HTTP 502" }), evaluateQueue: judged });
  assert.match(r.log, /merge queue for main: could not read — HTTP 502/);
  assert.equal(r.r?.halted ?? false, false);
});

test("a PASS on a queue commit is never taken back as a head the pull request moved on from", async () => {
  const withdrawn = [];
  const withdraw = async (a) => { withdrawn.push(a); return { ok: true }; };
  await run({ evaluate: evaluated, readQueue: queued(), evaluateQueue: judged, withdraw, ticks: 2 });
  assert.deepEqual(withdrawn, []);
});

test("a queue commit's verdict is kept as a decision record that replays", async () => {
  const r = await run({ evaluate: evaluated, readQueue: queued(), evaluateQueue: judged, keepDir: true });
  const db = open(r.dbPath);
  const heads = decisionsFor(db, { pr: 42 }).map(d => d.head);
  const replayed = replayDecisions(db, { pr: 42 });
  db.close();
  assert.ok(heads.includes(QUEUED), JSON.stringify(heads));
  assert.ok(replayed.every(x => x.outcome === "same"), JSON.stringify(replayed.map(x => x.outcome)));
});
