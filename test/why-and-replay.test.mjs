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
import { replayDecisions, policyHashFor, renderReplay } from "../src/decisions.mjs";
import { latestDecision, policyBody, saveDecision } from "../src/db/records.mjs";
import { recordsFor, policyOf } from "../src/evidence.mjs";
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
  const [r] = replayDecisions(db, {}, { code: { ...CODE, commit: "a".repeat(40) },
                                         profile: { schemaVersion: 1, identity: { key: "o/r" }, project: { kind: "client" } } });
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

// ── what a record says must match the digest it's kept under ──────────────────

test("a decision record that doesn't match its digest is corrupt: why says so, and replay can't replay it", async () => {
  const { db } = await recorded();
  const d = latestDecision(db, 42);
  const forged = { ...d.record, verdict: { ...d.record.verdict, state: "PASS" } };
  db.prepare(`UPDATE decision SET record = ? WHERE digest = ?`).run(JSON.stringify(forged), d.digest);
  assert.match(why(db, "42"), /doesn't match its digest/);
  const [r] = replayDecisions(db);
  assert.equal(r.outcome, "unreplayable");
  assert.match(String(r.why), /doesn't match its digest/);
});

test("evidence that doesn't match its digest can't be replayed", async () => {
  const { db } = await recorded();
  const d = latestDecision(db, 42);
  const row = /** @type {any} */ (db.prepare(`SELECT statement FROM evidence WHERE digest = ?`).get(d.record.evidence.checks));
  const s = JSON.parse(row.statement);
  s.predicate.claim.checks.verdict = "GREEN";
  db.prepare(`UPDATE evidence SET statement = ? WHERE digest = ?`).run(JSON.stringify(s), d.record.evidence.checks);
  const [r] = replayDecisions(db);
  assert.equal(r.outcome, "unreplayable");
  assert.match(String(r.why), /1 piece\(s\) of its evidence don't match their digests/);
});

test("a policy that doesn't match its hash can't be replayed", async () => {
  const { db } = await recorded();
  db.prepare(`UPDATE policy SET body = '{"schemaVersion":1,"project":{"kind":"client"}}'`).run();
  const [r] = replayDecisions(db);
  assert.equal(r.outcome, "unreplayable");
  assert.match(String(r.why), /its policy doesn't match its hash/);
});

// ── a commit or record is chosen by its hexadecimal start, never by a pattern ──

test("a --head or --record that isn't hexadecimal is refused, never read as a pattern", async () => {
  const { db, dbPath } = await recorded();
  const text = why(db, "42", { head: "%" });
  assert.match(text, /must be 4 to 40 hexadecimal characters/);
  assert.doesNotMatch(text, /the latest decision/);
  assert.throws(() => replayDecisions(db, { digest: "%" }), /must be 4 to 64 hexadecimal characters/);
  db.close();
  const r = replayCli(dbPath, "--record", "%");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /must be 4 to 64 hexadecimal characters/);
});

test("a start that more than one commit or record shares is refused as ambiguous", async () => {
  const { db } = await recorded();
  const d = latestDecision(db, 42);
  const policy = { hash: d.record.policy, body: policyBody(db, d.record.policy) ?? {} };
  let seq = 1000;
  for (const head of ["abcd1111".padEnd(40, "1"), "abcd2222".padEnd(40, "2")]) {
    const i = { ...input(), head };
    const kept = recordsFor({ nwo: "o/r", pr: 42, head, input: i, verdict: computeVerdict(i), policy, code: CODE,
                              observedAt: "2026-09-27T05:00:00Z" });
    saveDecision(db, { at: 1_800_000_000, seq: ++seq, pr: 42, head, ...kept });
  }
  assert.match(why(db, "42", { head: "abcd" }), /abcd is ambiguous: it starts 2 commits/);
  // Two records whose digests share a start, held as the store holds them.
  for (const digest of ["abcd".padEnd(64, "0"), "abcd".padEnd(64, "1")])
    db.prepare(`INSERT INTO decision(digest, pr, head, record, first_at, last_at, first_seq, last_seq) VALUES(?,?,?,?,?,?,?,?)`)
      .run(digest, 43, HEAD, JSON.stringify(d.record), 1, 1, ++seq, seq);
  assert.throws(() => replayDecisions(db, { digest: "abcd" }), /abcd is ambiguous: it starts 2 records/);
  assert.throws(() => replayDecisions(db, { digest: "0" }), /must be 4 to 64 hexadecimal characters/);
});

// ── from the review after #261 was marked ready ───────────────────────────────

test("the policy is compared only with the selected repository's own profile", () => {
  const profile = { schemaVersion: 1, identity: { key: "o/r" }, project: { kind: "product" } };
  assert.equal(policyHashFor({ ...profile, identity: { key: "x/y" } }, "o/r"), null, "another repository's profile");
  assert.equal(policyHashFor({ schemaVersion: 1 }, "o/r"), null, "a profile that names no repository");
  assert.equal(policyHashFor(profile, "o/r"), policyOf(profile).hash);
});

test("a decision row whose pull request or commit no longer matches its record can't be trusted", async () => {
  const { db } = await recorded();
  const d = latestDecision(db, 42);
  db.prepare(`UPDATE decision SET pr = 99 WHERE digest = ?`).run(d.digest);
  assert.match(why(db, "99"), /names pull request 99, but its record 42/);
  const [r] = replayDecisions(db, { pr: 99 });
  assert.equal(r.outcome, "unreplayable");
  assert.match(String(r.why), /names pull request 99, but its record 42/);
  db.prepare(`UPDATE decision SET pr = 42, head = ? WHERE digest = ?`).run("f".repeat(40), d.digest);
  assert.match(String(replayDecisions(db, { pr: 42 })[0].why), /names commit ffffffff/);
});

test("a code version git couldn't read makes the comparison unknown, never unchanged", async () => {
  const unreadable = { commit: null, tree: null, dirty: null, diff: null };
  const { db } = await recorded();
  assert.equal(replayDecisions(db, {}, { code: unreadable })[0].codeChanged, null, "the replaying code unreadable");
  const dbPath = join(tempDir("reeve-why-"), "s.db");
  await run({ evaluate, dbPath, code: unreadable, treeOf: () => "c".repeat(40) });
  const both = open(dbPath);
  assert.equal(replayDecisions(both, {}, { code: unreadable })[0].codeChanged, null, "both unreadable");
  assert.equal(replayDecisions(both, {}, { code: CODE })[0].codeChanged, null, "the recorded code unreadable");
});

// ── from #263's first review round ─────────────────────────────────────────────

test("a replay whose code comparison is unknown says so, rather than that nothing changed", async () => {
  const { db } = await recorded();
  const compute = i => { const v = computeVerdict(i); return { ...v, state: "PASS" }; };
  const results = replayDecisions(db, {}, { code: { commit: null, tree: null, dirty: null, diff: null }, compute });
  assert.equal(results[0].outcome, "differs");
  const text = renderReplay(results);
  assert.doesNotMatch(text, /with the code and policy it was judged with/);
  assert.match(text, /whether the code changed since is unknown/);
});

test("a code version whose tree git couldn't read compares as unknown", async () => {
  const { db } = await recorded();
  const [r] = replayDecisions(db, {}, { code: { ...CODE, tree: null } });
  assert.equal(r.codeChanged, null);
});

test("the policy is compared per decision, with a profile only for the repository its record names", async () => {
  const { db } = await recorded();
  const mine = { schemaVersion: 1, identity: { key: "o/r" }, project: { kind: "client" } };
  assert.equal(replayDecisions(db, {}, { profile: { ...mine, identity: { key: "x/y" } } })[0].policyChanged, null);
  assert.equal(replayDecisions(db, {}, { profile: mine })[0].policyChanged, true);
});

test("why shows each UNKNOWN clause's kind and what happens next", async () => {
  const dbPath = join(tempDir("reeve-why-"), "s.db");
  const settling = () => { const i = { ...input(), checks: { verdict: "SETTLING", settled: false, why: null, failing: [], inherited: [], impostors: [], shadowRequired: false } };
                           return { ...EVAL, verdict: computeVerdict(i), input: i }; };
  await run({ evaluate: settling, dbPath, code: CODE });
  assert.match(why(open(dbPath), "42"), /ci\s+UNKNOWN\s+checks not settled: SETTLING\s+\[waiting: look again once the checks settle\]/);
});

/** A verdict as the code before the UNKNOWN kinds recorded it: no clause names a kind or a next action. */
const kindless = v => ({ ...v, clauses: v.clauses.map(c => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "kind" && k !== "next"))) });

test("a replay shows the kind and next action a recomputed UNKNOWN clause gained, when they're all that changed", async () => {
  const dbPath = join(tempDir("reeve-why-"), "s.db");
  const before = () => { const i = { ...input(), checks: { verdict: "SETTLING", settled: false, why: null, failing: [], inherited: [], impostors: [], shadowRequired: false } };
                         return { ...EVAL, verdict: kindless(computeVerdict(i)), input: i }; };
  await run({ evaluate: before, dbPath, code: CODE });
  const [r] = replayDecisions(open(dbPath), {});
  assert.equal(r.outcome, "differs", "control: the clause recomputed now names its kind, and the recorded one doesn't");
  assert.deepEqual(r.diffs?.map(d => d.id), ["ci"]);
  const [d] = r.diffs ?? [];
  assert.notEqual(d?.was, d?.now);
  assert.match(String(d?.now), /\[waiting: look again once the checks settle\]/);
});

test("a clause that differs only where replay shows nothing is shown whole, never as two equal lines", async () => {
  const { db } = await recorded();
  const compute = i => {
    const v = computeVerdict(i);
    return { ...v, clauses: v.clauses.map(c => (c.id === "base" ? { ...c, seenAt: 1 } : c)) };
  };
  const [r] = replayDecisions(db, {}, { compute });
  assert.equal(r.outcome, "differs", "control: the extra field is a difference");
  const [d] = r.diffs ?? [];
  assert.equal(d?.id, "base");
  assert.notEqual(d?.was, d?.now);
  assert.match(String(d?.now), /seenAt/);
});
