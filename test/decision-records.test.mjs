// A tick keeps what each verdict was judged from, and a past verdict replays to
// the same result from its record (#165).
//
// The tick runs through the harness, with GitHub out of reach, and an evaluation
// that carries its input as `evaluatePr` does. The store is read back after.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { open } from "../src/db/ops.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { joinEvidence, asJson, recordsFor } from "../src/evidence.mjs";
import { latestDecision, evidenceBy, policyBody, saveDecision } from "../src/db/records.mjs";
import { run, EVAL, HEAD } from "./fixtures/tick-harness.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const TREE = "c".repeat(40);
const CODE = { commit: "d".repeat(40), tree: "e".repeat(40), dirty: false, diff: null };

/** What evaluatePr gives the verdict for #42: CI red at the head, everything else satisfied. */
const input = () => ({
  head: HEAD,
  checks: { verdict: "RED", settled: true, why: null, failing: [{ name: "unit", id: "1" }], inherited: [],
            impostors: [], shadowRequired: false },
  base: { verdict: "GREEN" },
  reviewers: [],
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 0, readable: true, mergeState: "CLEAN" },
  cleared: { readable: true, uncleared: 0, reviewers: [] },
  bodyFindings: { readable: true, open: 0, reviewers: [] },
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
  ledgerBlockers: 0,
  mergeState: "CLEAN",
  profile: { schemaVersion: 1, project: { kind: "product" } },
  mergeParts: null,
  hold: null,
});
const evaluate = () => { const i = input(); return { ...EVAL, verdict: computeVerdict(i), input: i }; };

/** Ticks over a store of their own, read back once they're done. */
async function ticked(o = {}) {
  const dbPath = join(tempDir("reeve-records-"), "s.db");
  const out = await run({ evaluate, dbPath, ...o });
  return { ...out, db: open(dbPath) };
}
const decidedPayloads = db => db.prepare(`SELECT payload FROM event WHERE op = 'pr.decided' AND subject = 'pr:42' ORDER BY seq`)
  .all().map(r => JSON.parse(/** @type {any} */ (r).payload));

test("a tick keeps what its verdict was judged from, and names the record on its decision", async () => {
  const { db } = await ticked();
  const d = latestDecision(db, 42);
  assert.ok(d, "a decision record was kept");
  assert.equal(d.head, HEAD);
  assert.deepEqual(decidedPayloads(db).map(p => p.record), [d.digest]);
  const { missing } = evidenceBy(db, Object.values(d.record.evidence));
  assert.deepEqual(missing, []);
  assert.ok(policyBody(db, d.record.policy), "its policy is kept");
});

test("a past verdict replays to the same result from its record", async () => {
  const { db } = await ticked();
  const d = latestDecision(db, 42);
  assert.ok(d, "a decision record was kept");
  const { found } = evidenceBy(db, Object.values(d.record.evidence));
  const replayed = computeVerdict(joinEvidence(found.map(e => e.statement), policyBody(db, d.record.policy)));
  assert.deepEqual(asJson({ state: replayed.state, summary: replayed.summary, clauses: replayed.clauses }), d.record.verdict);
  assert.equal(d.record.verdict.state, "BLOCK");
});

test("ticks that decide the same thing from the same evidence keep one record, seen again", async () => {
  const { db } = await ticked({ ticks: 3 });
  const decisions = db.prepare(`SELECT digest FROM decision WHERE pr = 42`).all();
  assert.equal(decisions.length, 1);
  const kinds = Object.keys(latestDecision(db, 42)?.record.evidence ?? {}).length;
  assert.equal(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM evidence`).get()).n, kinds);
  const payloads = decidedPayloads(db);
  assert.equal(payloads.length, 3, "each tick recorded its decision");
  assert.equal(new Set(payloads.map(p => p.record)).size, 1);
});

test("an evaluation that carries no input records nothing new, and its decision still stands", async () => {
  const { db } = await ticked({ evaluate: () => EVAL });
  assert.equal(latestDecision(db, 42), null);
  const payloads = decidedPayloads(db);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].record, undefined);
});

test("the record carries the head's tree and the code that judged", async () => {
  const { db } = await ticked({ treeOf: () => TREE, code: CODE });
  const d = latestDecision(db, 42);
  assert.ok(d, "a decision record was kept");
  assert.equal(d.record.subject.tree, TREE);
  assert.deepEqual(d.record.code, CODE);
  const [e] = evidenceBy(db, [d.record.evidence.checks]).found;
  assert.deepEqual(e.statement.subject[0].digest, { gitCommit: HEAD, gitTree: TREE });
  assert.equal(e.statement.predicate.producer.version, CODE.commit);
});

test("a tree that can't be read is kept as unknown, not guessed", async () => {
  const { db } = await ticked();
  assert.equal(latestDecision(db, 42)?.record.subject.tree, null);
});

test("the code version is taken when the tick starts, before anything is evaluated", async () => {
  let evaluated = false;
  const before = { ...CODE, commit: "1".repeat(40) }, after = { ...CODE, commit: "2".repeat(40) };
  const { db } = await ticked({ codeVersion: () => (evaluated ? after : before),
                                evaluate: (...a) => { evaluated = true; return evaluate(...a); } });
  assert.equal(latestDecision(db, 42)?.record.code.commit, before.commit);
});

test("the latest decision is the one recorded last, even within the same second", async () => {
  const { db } = await ticked();
  const d = latestDecision(db, 42);
  assert.ok(d, "a decision record was kept");
  const policy = { hash: d.record.policy, body: policyBody(db, d.record.policy) ?? {} };
  const kept = i => recordsFor({ nwo: "o/r", pr: 42, head: HEAD, input: i, verdict: computeVerdict(i), policy, code: CODE,
                                 observedAt: "2026-09-27T05:00:00Z" });
  const first = kept({ ...input(), mergeState: "BEHIND" }), second = kept({ ...input(), mergeState: "DIRTY" });
  // The same second for both, and the later one sorts first by digest, so only
  // the order they were recorded in can tell them apart.
  const [earlier, later] = first.decision.digest > second.decision.digest ? [first, second] : [second, first];
  assert.doesNotThrow(() => saveDecision(db, { at: 1_900_000_000, seq: 9001, pr: 42, head: HEAD, ...earlier }));
  assert.doesNotThrow(() => saveDecision(db, { at: 1_900_000_000, seq: 9002, pr: 42, head: HEAD, ...later }));
  assert.equal(latestDecision(db, 42)?.digest, later.decision.digest);
});

test("each decision is kept under the seq of the event that names it, so the latest is the last one decided", async () => {
  // Two ticks over one store, each deciding from a different reading.
  const dbPath = join(tempDir("reeve-records-"), "s.db");
  const judging = mergeState => () => { const i = { ...input(), mergeState }; return { ...EVAL, verdict: computeVerdict(i), input: i }; };
  await run({ evaluate: judging("BEHIND"), dbPath });
  await run({ evaluate: judging("DIRTY"), dbPath });
  const db = open(dbPath);
  const events = db.prepare(`SELECT seq, payload FROM event WHERE op = 'pr.decided' AND subject = 'pr:42' ORDER BY seq`).all()
    .map(r => ({ seq: Number(/** @type {any} */ (r).seq), record: JSON.parse(/** @type {any} */ (r).payload).record }));
  assert.equal(events.length, 2);
  assert.notEqual(events[0].record, events[1].record);
  const latest = latestDecision(db, 42);
  assert.equal(latest?.digest, events[1].record);
  assert.equal(latest?.last_seq, events[1].seq);
});
