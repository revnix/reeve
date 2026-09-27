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
import { readMergeParts, readMergeQueue, evaluateQueueEntry, publishVerdict } from "../src/pr.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { open } from "../src/db/ops.mjs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { tempDir } from "./fixtures/temp.mjs";
import { run, EVAL } from "./fixtures/tick-harness.mjs";
import { decisionsFor } from "../src/db/records.mjs";
import { standingPasses } from "../src/daemon.mjs";
import { replayDecisions } from "../src/decisions.mjs";

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

const HEAD = "a".repeat(40), QUEUED = "c".repeat(40), BASE = "b".repeat(40);

test("the queue is read as its entries, each with the commit the queue built for it", () => {
  const page = { data: { repository: { mergeQueue: { entries: { nodes: [
    { state: "AWAITING_CHECKS", headCommit: { oid: QUEUED }, baseCommit: { oid: BASE }, pullRequest: { number: 7, headRefOid: HEAD } },
    { state: "QUEUED", headCommit: null, baseCommit: null, pullRequest: { number: 8, headRefOid: null } },
  ] } } } } };
  const q = readMergeQueue("o/r", "main", { gh: () => ({ ok: true, out: JSON.stringify(page) }) });
  assert.deepEqual(q, { ok: true, queue: true, entries: [
    { pr: 7, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS", prHead: HEAD },
    { pr: 8, sha: null, baseSha: null, state: "QUEUED", prHead: null },
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
  return evaluateQueueEntry({ nwo: "o/r", entry: { pr: 7, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS", prHead: HEAD }, input: passing(),
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
  let r;
  assert.doesNotThrow(() => {
    r = evaluateQueueEntry({ nwo: "o/r", entry: { pr: 7, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS", prHead: HEAD }, input: undefined,
                             baseRef: "main", profile: { ci: { requiredChecks: [] } }, db: null,
                             read: () => ({ ok: true, rows: [checkRow("test", "success")], impostors: [] }),
                             requirements: () => ({ required: [], known: true, shadowRequired: false }) });
  });
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

/** PR 42 evaluated at its head with every clause passing, on base main. */
const evaluated = () => ({ ...EVAL, baseRef: "main", head: HEAD, input: passing(), verdict: computeVerdict(passing()) });
/** The queue holding PR 42 at QUEUED, awaiting its checks. */
const queued = (entries = [{ pr: 42, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }]) => () => ({ ok: true, queue: true, entries });
/** A queue commit judged PASS from the pull request's input. */
const judged = ({ entry, input }) => { const i = { ...input, head: entry.sha }; return { ok: true, input: i, verdict: computeVerdict(i) }; };

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

// ── what a queue reads as a failure ───────────────────────────────────────────

/** The status and conclusion an enforcing publication writes for `verdict`, on a queue commit or not. */
async function written(verdict, { queue }) {
  const calls = [];
  const api = (_token, args) => {
    calls.push(args);
    if (args.includes("POST") || args.includes("PATCH")) return { ok: true, out: JSON.stringify({ id: 9 }) };
    return { ok: true, out: "" };
  };
  await publishVerdict({ nwo: "o/r", verdict: { head: QUEUED, summary: "s", clauses: [], ...verdict }, shadow: false, queue,
                         auth: async () => ({ ok: true, token: "t" }), api });
  const write = calls.find(a => a.includes("POST") || a.includes("PATCH")) ?? [];
  const field = k => write.find(x => typeof x === "string" && x.startsWith(`${k}=`))?.slice(k.length + 1) ?? null;
  return { status: field("status"), conclusion: field("conclusion") };
}

test("on a queue commit, an UNKNOWN still settling is published as running, which the queue waits for", async () => {
  assert.deepEqual(await written({ state: "UNKNOWN", kind: "waiting" }, { queue: true }), { status: "in_progress", conclusion: null });
  assert.deepEqual(await written({ state: "UNKNOWN", kind: "retry" }, { queue: true }), { status: "in_progress", conclusion: null });
  assert.deepEqual(await written({ state: "UNKNOWN", kind: "waiting" }, { queue: false }), { status: "completed", conclusion: "action_required" },
                   "control: at a pull request's head it holds the merge as before");
});

test("on a queue commit, a block, a pass and an UNKNOWN only a person can settle are published as settled", async () => {
  assert.deepEqual(await written({ state: "BLOCK" }, { queue: true }), { status: "completed", conclusion: "failure" });
  assert.deepEqual(await written({ state: "PASS" }, { queue: true }), { status: "completed", conclusion: "success" });
  assert.deepEqual(await written({ state: "UNKNOWN", kind: "person" }, { queue: true }), { status: "completed", conclusion: "action_required" },
                   "a person's UNKNOWN lets the queue go on rather than hold it to its timeout");
});

test("each tick publishes its queue verdicts as queue verdicts", async () => {
  const seen = [];
  const publish = async (a) => { seen.push({ head: a.verdict.head, queue: a.queue === true }); return { ok: true, id: 1 }; };
  await run({ evaluate: evaluated, readQueue: queued(), evaluateQueue: judged, publish });
  assert.deepEqual(seen, [{ head: HEAD, queue: false }, { head: QUEUED, queue: true }]);
});

// ── from #269's first review ─────────────────────────────────────────────────

test("review coverage at the pull request's head carries to its queue commit, and coverage of an older head doesn't", () => {
  const withReviewer = (reviewedHead) => ({ ...passing(), reviewers: [{ login: "bot", kind: "blocking", state: "CLEAN", reviewedHead }] });
  const judge = (input) => evaluateQueueEntry({ nwo: "o/r", entry: { pr: 7, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS", prHead: HEAD }, input,
    baseRef: "main", profile: { ci: { requiredChecks: [] } }, db: null,
    read: () => ({ ok: true, rows: [checkRow("test", "success")], impostors: [] }),
    requirements: () => ({ required: [], known: true, shadowRequired: false }) });
  const carried = judge(withReviewer(HEAD.slice(0, 10)));
  assert.equal(carried.verdict.clauses.find(c => c.id === "review")?.state, "PASS");
  assert.equal(carried.input.reviewers[0].coveredAt, HEAD.slice(0, 10), "the record says which commit the review covered");
  const older = judge(withReviewer("d".repeat(10)));
  assert.equal(older.verdict.clauses.find(c => c.id === "review")?.state, "BLOCK", "control: a review of another commit still doesn't count");
});

test("a queue PASS is noted before it's published, so a stop or a halt takes it back", async () => {
  const publish = async ({ verdict }) => { if (verdict.head === QUEUED) throw new Error("network"); return { ok: true, id: 1 }; };
  const r = await run({ evaluate: evaluated, readQueue: queued(), evaluateQueue: judged, publish, keepDir: true });
  const db = open(r.dbPath);
  const standing = standingPasses(db);
  db.close();
  assert.ok(standing.some(x => x.pr === 42 && x.head === QUEUED && x.state === "PASS"), JSON.stringify(standing));
});

test("a queue PASS whose commit has left the queue is taken back", async () => {
  const withdrawn = [];
  const withdraw = async (a) => { withdrawn.push(a); return { ok: true }; };
  let tick = 0;
  const readQueue = () => (tick++ === 0 ? queued()() : { ok: true, queue: true, entries: [] });
  await run({ evaluate: evaluated, readQueue, evaluateQueue: judged, withdraw, ticks: 2 });
  assert.ok(withdrawn.some(a => JSON.stringify(a).includes(QUEUED)), JSON.stringify(withdrawn));
});

test("the whole queue is read, past its first page", () => {
  const asked = [];
  const page = (nodes, next) => ({ data: { repository: { mergeQueue: { entries: { nodes, pageInfo: { hasNextPage: Boolean(next), endCursor: next } } } } } });
  const node = (n, sha) => ({ state: "QUEUED", headCommit: { oid: sha }, baseCommit: { oid: BASE }, pullRequest: { number: n } });
  const gh = (args) => {
    asked.push(args.find(a => a.startsWith("after=")) ?? "first");
    return { ok: true, out: JSON.stringify(asked.length === 1 ? page([node(1, QUEUED)], "c1") : page([node(2, HEAD)], null)) };
  };
  const q = readMergeQueue("o/r", "main", { gh });
  assert.deepEqual(q.entries.map(e => e.pr), [1, 2]);
  assert.deepEqual(asked, ["first", "after=c1"]);
});

test("a queue verdict reeve can't publish on three ticks running goes to a person", async () => {
  const publish = async ({ verdict }) => (verdict.head === QUEUED ? { ok: false, why: "HTTP 502" } : { ok: true, id: 1 });
  const r = await run({ evaluate: evaluated, readQueue: queued(), evaluateQueue: judged, publish, ticks: 3 });
  assert.match(r.esc, /#42: reeve couldn't publish its verdict on the merge queue's commit on 3 ticks in a row/);
});

// ── from #269's second review ────────────────────────────────────────────────

test("pull requests the queue batched on one commit get one verdict there, the worst of theirs", async () => {
  const published = [];
  const publish = async ({ verdict }) => { published.push({ head: verdict.head, state: verdict.state }); return { ok: true, id: published.length }; };
  const red = () => ({ ...passing(), checks: { ...passing().checks, verdict: "RED", failing: [{ name: "unit", id: "1" }] } });
  // The blocked one queued first, so the one after it can't overwrite it.
  const evaluate = ({ pr }) => { const input = pr === 42 ? red() : passing(); return { ...EVAL, pr, baseRef: "main", head: HEAD, input, verdict: computeVerdict(input) }; };
  const batch = queued([{ pr: 42, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }, { pr: 43, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }]);
  await run({ evaluate, openPrs: () => [42, 43], readQueue: batch, evaluateQueue: judged, publish });
  assert.deepEqual(published.filter(p => p.head === QUEUED), [{ head: QUEUED, state: "BLOCK" }]);
});

test("a queue PASS is taken back when the queue can't be read, since its commit can't be re-checked", async () => {
  const withdrawn = [];
  const withdraw = async (a) => { withdrawn.push(a); return { ok: true }; };
  let tick = 0;
  const readQueue = () => (tick++ === 0 ? queued()() : { ok: false, why: "HTTP 502" });
  await run({ evaluate: evaluated, readQueue, evaluateQueue: judged, withdraw, ticks: 2 });
  assert.ok(withdrawn.some(a => JSON.stringify(a).includes(QUEUED)), JSON.stringify(withdrawn));
});

// ── from #269's third review ─────────────────────────────────────────────────

test("a queue commit is published on only when every pull request on it was judged this tick", async () => {
  const published = [];
  const publish = async ({ verdict }) => { published.push(verdict.head); return { ok: true, id: 1 }; };
  // #99 shares the commit, and this tick didn't evaluate it.
  const batch = queued([{ pr: 42, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }, { pr: 99, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }]);
  const r = await run({ evaluate: evaluated, readQueue: batch, evaluateQueue: judged, publish });
  assert.deepEqual(published, [HEAD], "nothing on the queue commit");
  assert.match(r.log, /queue commit c{10} \(#42, #99\): not published — not every pull request on it was judged this tick/);
});

test("a queue PASS is taken back once a pull request on its commit can't be judged", async () => {
  const withdrawn = [];
  const withdraw = async (a) => { withdrawn.push(a); return { ok: true }; };
  // Both judged on the first tick, and only #42 on the second: #43's judging throws.
  const evaluate = ({ pr }) => ({ ...EVAL, pr, baseRef: "main", head: HEAD, input: passing(), verdict: computeVerdict(passing()) });
  const batch = queued([{ pr: 42, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }, { pr: 43, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }]);
  let judging = 0;
  const evaluateQueue = (a) => { if (judging++ >= 2 && a.entry.pr === 43) throw new Error("the store is full"); return judged(a); };
  const r = await run({ evaluate, openPrs: () => [42, 43], readQueue: batch, evaluateQueue, withdraw, ticks: 2 });
  assert.match(r.log, /#43 queued at c{10}: not judged — the store is full/);
  assert.ok(withdrawn.some(a => a.pr === 42 && a.head === QUEUED), JSON.stringify(withdrawn));
  assert.ok(withdrawn.some(a => a.pr === 43 && a.head === QUEUED), JSON.stringify(withdrawn));
});

test("a queue entry is judged only when the queue holds the pull request at the head judged this tick", () => {
  const judge = (prHead) => evaluateQueueEntry({ nwo: "o/r", entry: { pr: 7, sha: QUEUED, baseSha: BASE, state: "AWAITING_CHECKS", prHead }, input: passing(),
    baseRef: "main", profile: { ci: { requiredChecks: [] } }, db: null,
    read: () => ({ ok: true, rows: [checkRow("test", "success")], impostors: [] }),
    requirements: () => ({ required: [], known: true, shadowRequired: false }) });
  const moved = judge("d".repeat(40));
  assert.equal(moved.ok, false);
  assert.equal(moved.verdict, undefined, "no verdict from another revision's facts");
  assert.match(moved.why, /dddddddddd/);
  assert.equal(judge(null).ok, false, "a head the queue didn't name isn't taken for this one");
  assert.equal(judge(HEAD).ok, true, "control: the head judged this tick");
});

test("the queue's entries are read with the head each pull request is queued at", () => {
  let asked = "";
  const page = { data: { repository: { mergeQueue: { entries: { nodes: [
    { state: "AWAITING_CHECKS", headCommit: { oid: QUEUED }, baseCommit: { oid: BASE }, pullRequest: { number: 7, headRefOid: HEAD } },
  ] } } } } };
  const q = readMergeQueue("o/r", "main", { gh: (args) => { asked = args.join(" "); return { ok: true, out: JSON.stringify(page) }; } });
  assert.match(asked, /pullRequest\{number headRefOid\}/);
  assert.equal(q.entries[0].prHead, HEAD);
});

test("a HALT that arrives while the queue is judged stops the queue's publications, and takes back what stands", async () => {
  const marker = join(tempDir("reeve-queue-halt-"), "HALT");
  const published = [];
  const publish = async ({ verdict }) => { published.push(verdict.head); return { ok: true, id: 1 }; };
  const evaluateQueue = (a) => { writeFileSync(marker, ""); return judged(a); };
  const withdrawn = [];
  const withdraw = async (a) => { withdrawn.push(a); return { ok: true }; };
  const r = await run({ evaluate: evaluated, readQueue: queued(), evaluateQueue, publish, withdraw, haltMarker: marker });
  assert.deepEqual(published, [HEAD], "nothing published on the queue commit");
  assert.equal(r.r.halted, true);
  assert.ok(withdrawn.some(a => a.head === HEAD), JSON.stringify(withdrawn));
  assert.match(r.log, /HALTED while the merge queue was checked/);
});

test("a HALT that arrives while a queue verdict is published stops the tick right after the queue step", async () => {
  const marker = join(tempDir("reeve-queue-halt-"), "HALT");
  const publish = async ({ verdict }) => { if (verdict.head === QUEUED) writeFileSync(marker, ""); return { ok: true, id: 1 }; };
  const withdrawn = [];
  const withdraw = async (a) => { withdrawn.push(a); return { ok: true }; };
  const r = await run({ evaluate: evaluated, readQueue: queued(), evaluateQueue: judged, publish, withdraw, haltMarker: marker });
  assert.equal(r.r.halted, true);
  assert.ok(withdrawn.some(a => a.head === QUEUED), JSON.stringify(withdrawn));
  assert.match(r.log, /HALTED after the merge queue was checked/);
});

test("queue publication failures count in a row on one commit, so a gap or another commit starts again", async () => {
  const publish = async ({ verdict }) => (verdict.head === HEAD ? { ok: true, id: 1 } : { ok: false, why: "HTTP 502" });
  const THREE = /on the merge queue's commit on 3 ticks in a row/;
  // Two failures, a tick the queue can't be read, then one more.
  let t = 0;
  const gap = () => (t++ === 2 ? { ok: false, why: "HTTP 502" } : queued()());
  assert.doesNotMatch((await run({ evaluate: evaluated, readQueue: gap, evaluateQueue: judged, publish, ticks: 4 })).esc, THREE);
  // Two failures on one commit, then one on the commit the queue rebuilt.
  const REBUILT = "e".repeat(40);
  let u = 0;
  const rebuilt = () => queued([{ pr: 42, sha: u++ === 2 ? REBUILT : QUEUED, baseSha: BASE, state: "AWAITING_CHECKS" }])();
  assert.doesNotMatch((await run({ evaluate: evaluated, readQueue: rebuilt, evaluateQueue: judged, publish, ticks: 3 })).esc, THREE);
});

test("a queue answer that carries GraphQL errors is a failed read, not an empty queue", () => {
  const out = JSON.stringify({ errors: [{ message: "Resource not accessible by integration" }], data: { repository: { mergeQueue: null } } });
  const q = readMergeQueue("o/r", "main", { gh: () => ({ ok: true, out }) });
  assert.equal(q.ok, false);
  assert.match(q.why, /Resource not accessible by integration/);
});
