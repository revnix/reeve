// `reeve why` explains a past verdict from its record, and `reeve replay`
// recomputes it and compares (#165).
//
// A tick runs through the harness, with GitHub out of reach, and keeps its
// records. Everything after that reads the store alone.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { why } from "../src/status.mjs";
import { replayDecisions } from "../src/decisions.mjs";
import { latestDecision } from "../src/db/records.mjs";
import { run, EVAL, HEAD } from "./fixtures/tick-harness.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
const CODE = { commit: "d".repeat(40), tree: "e".repeat(40), dirty: false, diff: null };

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

/** A store holding one tick's records. */
async function recorded() {
  const dbPath = join(tempDir("reeve-why-"), "s.db");
  await run({ evaluate, dbPath, code: CODE, treeOf: () => "c".repeat(40) });
  return { dbPath, db: open(dbPath) };
}

test("why explains the latest decision from the store: every clause with its detail, and what it was judged from", async () => {
  const { db } = await recorded();
  const text = why(db, "42");
  const v = computeVerdict(input());
  assert.match(text, /pr:42 — the latest decision/);
  assert.match(text, new RegExp(`^BLOCK at ${HEAD.slice(0, 12)}`, "m"));
  for (const c of v.clauses) assert.ok(text.includes(c.id) && (!c.detail || text.includes(c.detail)), `clause ${c.id} and its detail`);
  assert.match(text, /judged from:/);
  for (const kind of ["head", "checks", "reviews", "merge"]) assert.match(text, new RegExp(`^ {4}${kind}\\s+seen `, "m"));
  assert.match(text, new RegExp(`code ${CODE.commit.slice(0, 12)}`));
  assert.match(text, /pr:42 — most recent first/, "the trail follows");
});

test("why at a commit with no record says so, rather than showing another commit's", async () => {
  const { db } = await recorded();
  const text = why(db, "42", { head: "f".repeat(8) });
  assert.match(text, /no decision record at ffffffff/);
  assert.doesNotMatch(text, /the latest decision/);
});

test("a recorded decision replays to the same verdict", async () => {
  const { db } = await recorded();
  const results = replayDecisions(db, {}, { code: CODE });
  assert.deepEqual(results.map(r => [r.outcome, r.codeChanged]), [["same", false]]);
});

test("a verdict the code now reaches differently is reported, clause by clause", async () => {
  const { db } = await recorded();
  const compute = i => {
    const v = computeVerdict(i);
    return { ...v, state: "PASS", clauses: v.clauses.map(c => (c.id === "ci" ? { ...c, state: "PASS", detail: "green now" } : c)) };
  };
  const [r] = replayDecisions(db, {}, { compute });
  assert.equal(r.outcome, "differs");
  assert.equal(r.now, "PASS");
  assert.deepEqual(r.diffs?.map(d => d.id), ["ci"]);
  assert.match(String(r.diffs?.[0].now), /green now/);
});

test("a clause that changes while the verdict's state doesn't is still a difference", async () => {
  const { db } = await recorded();
  const compute = i => {
    const v = computeVerdict(i);
    return { ...v, clauses: v.clauses.map(c => (c.id === "base" ? { ...c, detail: "read another way now" } : c)) };
  };
  const [r] = replayDecisions(db, {}, { compute });
  assert.equal(r.outcome, "differs");
  assert.equal(r.now, r.recorded);
  assert.deepEqual(r.diffs?.map(d => d.id), ["base"]);
});

test("a decision whose evidence the store no longer holds can't be replayed, and never counts as the same", async () => {
  const { db } = await recorded();
  const d = latestDecision(db, 42);
  db.prepare(`DELETE FROM evidence WHERE digest = ?`).run(d?.record.evidence.checks);
  const [r] = replayDecisions(db);
  assert.equal(r.outcome, "unreplayable");
  assert.match(String(r.why), /1 piece\(s\) of its evidence are missing/);
});

test("a decision whose policy the store no longer holds can't be replayed", async () => {
  const { db } = await recorded();
  db.prepare(`DELETE FROM policy`).run();
  assert.equal(replayDecisions(db)[0].outcome, "unreplayable");
});

test("replay says whether the code or the policy has changed since the decision", async () => {
  const { db } = await recorded();
  const [r] = replayDecisions(db, {}, { code: { ...CODE, commit: "a".repeat(40) }, policyHash: "not-the-recorded-one" });
  assert.equal(r.outcome, "same");
  assert.equal(r.codeChanged, true);
  assert.equal(r.policyChanged, true);
});

/** `reeve replay`, offline, over a store. */
const replayCli = (dbPath, ...args) =>
  spawnSync(process.execPath, [REEVE, "replay", "o/r", "--db", dbPath, ...args], { encoding: "utf8", env: offlineEnv() });

test("reeve replay exits 0 when every decision replays to the same verdict", async () => {
  const { dbPath, db } = await recorded();
  db.close();
  const r = replayCli(dbPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 decision\(s\): 1 replayed to the same verdict, 0 differ, 0 could not be replayed/);
});

test("reeve replay exits 1 when a decision can't be replayed", async () => {
  const { dbPath, db } = await recorded();
  db.prepare(`DELETE FROM policy`).run();
  db.close();
  const r = replayCli(dbPath);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /could not be replayed: its policy is missing/);
});

test("reeve replay with nothing to replay exits 3, never 0", async () => {
  const dbPath = join(tempDir("reeve-empty-"), "s.db");
  open(dbPath).close();
  const r = replayCli(dbPath);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /nothing was replayed/);
});

test("reeve replay refuses a --since it can't read, rather than replaying everything", async () => {
  const { dbPath, db } = await recorded();
  db.close();
  const r = replayCli(dbPath, "--since", "not-a-date");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--since takes a date/);
});
