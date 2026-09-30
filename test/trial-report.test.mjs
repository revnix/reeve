// The shadow trial, reported against its conditions (#291), from the store and
// what GitHub says merged, with GitHub stood in for.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import { trialReport, renderTrial, mergedSince, CASE_KINDS } from "../src/trial.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
const T0 = 1_900_000_000, MIN = 60, HOUR = 3600, R = "o/r";
const sha = (c) => c.repeat(40);

/** A store, and a way to put the daemon's events in it. */
function store() {
  const path = join(tempDir("reeve-trial-"), "s.db");
  const db = open(path);
  const put = (at, op, subject, payload = {}) =>
    db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(at, "daemon", op, subject, JSON.stringify(payload));
  const tick = (at) => put(at, "daemon.tick", null);
  const decided = (at, pr, head, state, over = {}) =>
    put(at, "pr.decided", `pr:${pr}`, { head, state, summary: "", action: state === "PASS" ? "WAIT" : "ESCALATE", why: "", clauses: [], ...over });
  // A decision record, which names the repository it was judged for.
  const record = (repo, pr = 1, head = sha("a")) => db.prepare(
    "INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
    .run(`${repo}#${pr}@${head}`, pr, head, JSON.stringify({ subject: { repo, pr, head } }), T0, T0, 1, 1);
  return { db, path, put, tick, decided, record };
}
/** How a seeded case came out, as src/seeded.mjs reports it. */
const seededAs = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {string} */ got, must = "BLOCK") =>
  ({ name, why: "", must, clauses: {}, ran: true, at: T0, got, gotClauses: {}, ok,
     detail: ok ? "every clause satisfied" : `it came out ${got}, but not for its reason` });
/** Ticks every ten minutes, from `from` for `hours`. */
const ticking = (s, from, hours) => { for (let t = from; t <= from + hours * HOUR; t += 10 * MIN) s.tick(t); };

// ── running time ─────────────────────────────────────────────────────────────

test("running time is read from the daemon's ticks, and a gap of over 15 minutes is downtime", () => {
  const s = store();
  ticking(s, T0 + 10 * MIN, 2);
  ticking(s, T0 + 5 * HOUR, 1);
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + 6 * HOUR + 5 * MIN, merged: [] });
  s.db.close();
  assert.equal(r.running.down.length, 1, JSON.stringify(r.running.down));
  assert.deepEqual(r.running.down[0], { from: T0 + 10 * MIN + 2 * HOUR, to: T0 + 5 * HOUR });
  assert.ok(Math.abs(r.running.hours - (3 + 15 / 60)) < 0.01, `${r.running.hours}`);
  assert.equal(r.conditions.find((c) => /72 hours/.test(c.name))?.met, false, "and three hours are short of the floor");
});

test("with no tick at all, the daemon didn't run, however short the time", () => {
  const s = store();
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + 10 * MIN, merged: [] });
  s.db.close();
  assert.equal(r.running.hours, 0);
});

// ── merges ───────────────────────────────────────────────────────────────────

test("each merge counts once judged at its final head, and one merged while the daemon was down, or never judged there, is missed", () => {
  const s = store();
  ticking(s, T0, 2);
  ticking(s, T0 + 4 * HOUR, 1);
  s.decided(T0 + 30 * MIN, 1, sha("a"), "PASS");
  s.decided(T0 + 40 * MIN, 3, sha("b"), "BLOCK");
  const merged = [
    { pr: 1, mergedAt: T0 + 50 * MIN, head: sha("a") },
    { pr: 2, mergedAt: T0 + 3 * HOUR, head: sha("c") },
    { pr: 3, mergedAt: T0 + 90 * MIN, head: sha("d") },
  ];
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + 5 * HOUR, merged });
  s.db.close();
  const by = Object.fromEntries(r.merges.map((m) => [m.pr, m]));
  assert.equal(by[1].missed, null);
  assert.equal(by[1].state, "PASS");
  assert.equal(by[2].missed, "merged while the daemon was down");
  assert.equal(by[3].missed, "its final head was never judged");
  assert.equal(r.passedFinal, 1);
  assert.equal(r.conditions.find((c) => /passed on their final head/.test(c.name))?.met, false, "one pass is short of ten");
  const cover = r.conditions.find((c) => /every merge/.test(c.name));
  assert.equal(cover?.met, false);
  assert.match(String(cover?.detail), /2 of 3 missed: #2 \(merged while the daemon was down\), #3 \(its final head was never judged\)/);
});

test("a verdict kept after the pull request merged isn't the one that stood when it merged", () => {
  const s = store();
  ticking(s, T0, 2);
  // Kept at its final head only after it merged: a tick that read it open, and
  // kept its verdict once a person had merged it.
  s.decided(T0 + 60 * MIN, 1, sha("a"), "PASS");
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + 2 * HOUR, merged: [{ pr: 1, mergedAt: T0 + 50 * MIN, head: sha("a"), mergeCommit: sha("1") }] });
  s.db.close();
  assert.equal(r.merges[0].missed, "its final head was never judged");
  assert.equal(r.passedFinal, 0);
});

test("where what merged couldn't be read, whether every merge was covered isn't met", () => {
  const s = store();
  ticking(s, T0, 1);
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + HOUR, merged: { why: "HTTP 502" } });
  s.db.close();
  const cover = r.conditions.find((c) => /every merge/.test(c.name));
  assert.equal(cover?.met, false);
  assert.match(String(cover?.detail), /what merged couldn't be read: HTTP 502/);
});

// ── kinds of case ────────────────────────────────────────────────────────────

test("each kind of case is seen from what the daemon decided, and named by the first pull request that showed it", () => {
  const s = store();
  ticking(s, T0, 2);
  s.decided(T0 + 1 * MIN, 11, sha("a"), "PASS");
  s.decided(T0 + 2 * MIN, 12, sha("b"), "BLOCK", { action: "FIX_CI", why: "failing: unit" });
  s.decided(T0 + 3 * MIN, 13, sha("c"), "BLOCK", { why: "the branch conflicts with its base" });
  s.decided(T0 + 4 * MIN, 14, sha("d"), "BLOCK", { clauses: [{ id: "threads", state: "BLOCK" }] });
  // A review round on one head, then a new head seen after it.
  s.db.prepare("INSERT INTO review_round(nwo,pr,reviewer,source_id,outcome,head_full,head10,event_at,classifier_version) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("o/r", 15, "codex", "review:1", "findings", sha("e"), sha("e").slice(0, 10), T0 + 5 * MIN, "v");
  s.db.prepare("INSERT INTO head_seen(nwo,pr,sha,first_seen_at) VALUES(?,?,?,?)").run("o/r", 15, sha("f"), T0 + 6 * MIN);
  s.put(T0 + 7 * MIN, "queue.decided", "pr:16", { head: sha("9"), state: "PASS" });
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + 2 * HOUR, merged: [{ pr: 16, mergedAt: T0 + 8 * MIN, head: sha("8"), mergeCommit: sha("9") }] });
  s.db.close();
  assert.deepEqual(r.kinds, {
    "a pull request that passes": 11, "failing CI": 12, "a conflict with the base": 13, "unresolved threads": 14,
    "a new push after a review": 15, "a merge through the merge queue": 16,
  });
  assert.equal(r.conditions.find((c) => /each kind/.test(c.name))?.met, true);
});

test("a kind of case not seen is named as not yet, and a push before the review isn't one after it", () => {
  const s = store();
  ticking(s, T0, 1);
  s.db.prepare("INSERT INTO review_round(nwo,pr,reviewer,source_id,outcome,head_full,head10,event_at,classifier_version) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("o/r", 15, "codex", "review:1", "findings", sha("e"), sha("e").slice(0, 10), T0 + 30 * MIN, "v");
  s.db.prepare("INSERT INTO head_seen(nwo,pr,sha,first_seen_at) VALUES(?,?,?,?)").run("o/r", 15, sha("f"), T0 + 6 * MIN);
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + HOUR, merged: [] });
  s.db.close();
  assert.equal(r.kinds["a new push after a review"], null);
  const kinds = r.conditions.find((c) => /each kind/.test(c.name));
  assert.equal(kinds?.met, false);
  assert.match(String(kinds?.detail), new RegExp(`not yet: ${CASE_KINDS.join("; ")}`));
});

test("a merge through the merge queue is seen only where its merge commit is the queue's commit reeve judged before it merged", () => {
  const s = store();
  ticking(s, T0, 1);
  // Judged in the queue, then dropped from it and merged another way.
  s.put(T0 + 5 * MIN, "queue.decided", "pr:16", { head: sha("9"), state: "PASS" });
  // Its queue commit judged only after it merged.
  s.put(T0 + 9 * MIN, "queue.decided", "pr:17", { head: sha("7"), state: "PASS" });
  // Merged by the queue, at the commit reeve judged there.
  s.put(T0 + 10 * MIN, "queue.decided", "pr:18", { head: sha("5"), state: "PASS" });
  const merged = [
    { pr: 16, mergedAt: T0 + 6 * MIN, head: sha("a"), mergeCommit: sha("b") },
    { pr: 17, mergedAt: T0 + 8 * MIN, head: sha("c"), mergeCommit: sha("7") },
    { pr: 18, mergedAt: T0 + 11 * MIN, head: sha("d"), mergeCommit: sha("5") },
  ];
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + HOUR, merged });
  s.db.close();
  assert.deepEqual(r.merges.map((m) => [m.pr, m.queue]), [[16, false], [17, false], [18, true]]);
  assert.equal(r.kinds["a merge through the merge queue"], 18);
});

test("a push after a review is counted only from this repository's heads and review rounds", () => {
  const s = store();
  ticking(s, T0, 1);
  const round = (nwo, pr, at) => s.db.prepare("INSERT INTO review_round(nwo,pr,reviewer,source_id,outcome,head_full,head10,event_at,classifier_version) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(nwo, pr, "codex", `review:${pr}`, "findings", sha("e"), sha("e").slice(0, 10), at, "v");
  const seen = (nwo, pr, at) => s.db.prepare("INSERT INTO head_seen(nwo,pr,sha,first_seen_at) VALUES(?,?,?,?)").run(nwo, pr, sha("f"), at);
  // Another repository's round, and its push after it.
  round("x/y", 15, T0 + 5 * MIN);
  seen("x/y", 15, T0 + 6 * MIN);
  // A push here, after a round on another repository's pull request of the same number.
  round("x/y", 16, T0 + 5 * MIN);
  seen(R, 16, T0 + 6 * MIN);
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + HOUR, merged: [] });
  s.db.close();
  assert.equal(r.kinds["a new push after a review"], null);
});

// ── conditions ───────────────────────────────────────────────────────────────

test("every call the daemon made is listed for a person's audit, merged or not, at a head or on the queue's commit, each once", () => {
  const s = store();
  ticking(s, T0, 1);
  // Blocked on an earlier head over two ticks, its reason counting what still
  // ran, then passed on its final head, judged in the queue, and merged by it.
  s.decided(T0 + 1 * MIN, 5, sha("a"), "BLOCK", { summary: "ci blocked", why: "ci: checks not settled: RUNNING (3 check(s) still in flight)" });
  s.decided(T0 + 6 * MIN, 5, sha("a"), "BLOCK", { summary: "ci blocked", why: "ci: checks not settled: RUNNING (2 check(s) still in flight)" });
  s.decided(T0 + 11 * MIN, 5, sha("b"), "PASS");
  s.put(T0 + 12 * MIN, "queue.decided", "pr:5", { head: sha("9"), state: "PASS", summary: "" });
  // Passed, and never merged.
  s.decided(T0 + 13 * MIN, 6, sha("c"), "PASS");
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + HOUR, merged: [{ pr: 5, mergedAt: T0 + 14 * MIN, head: sha("b"), mergeCommit: sha("9") }] });
  s.db.close();
  assert.deepEqual(r.toAudit.map((a) => [a.pr, a.where, a.head[0], a.state, a.ticks, a.final]),
    [[5, "head", "a", "BLOCK", 2, false], [5, "head", "b", "PASS", 1, true], [5, "queue", "9", "PASS", 1, true], [6, "head", "c", "PASS", 1, false]]);
  assert.equal(r.conditions.find((c) => /no false call/.test(c.name))?.detail, "4 call(s) on 2 pull request(s) to audit");
  assert.equal(r.toAudit[0].why, "ci: checks not settled: RUNNING (2 check(s) still in flight)", "the latest reason");
  assert.match(renderTrial(r, R), /#5 BLOCK at aaaaaaaaaa \(ci blocked: ci: checks not settled: RUNNING \(2 check\(s\) still in flight\)\), 2 tick\(s\)/);
  assert.match(renderTrial(r, R), /#6 PASS at cccccccccc/);
});

test("once every condition the records show holds, the trial is ready, and it never passes without a person's audit", () => {
  const s = store();
  ticking(s, T0, 80);
  const merged = [];
  for (let pr = 1; pr <= 10; pr++) { s.decided(T0 + pr * MIN, pr, sha(String(pr % 10)), "PASS"); merged.push({ pr, mergedAt: T0 + pr * MIN + 30, head: sha(String(pr % 10)), mergeCommit: null }); }
  s.decided(T0 + 20 * MIN, 21, sha("b"), "BLOCK", { action: "FIX_CI", why: "failing: unit", clauses: [{ id: "threads", state: "BLOCK" }] });
  merged.push({ pr: 21, mergedAt: T0 + 21 * MIN, head: sha("b"), mergeCommit: null });
  s.decided(T0 + 22 * MIN, 22, sha("c"), "BLOCK", { why: "the branch conflicts with its base" });
  s.db.prepare("INSERT INTO review_round(nwo,pr,reviewer,source_id,outcome,head_full,head10,event_at,classifier_version) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("o/r", 23, "codex", "review:1", "findings", sha("e"), sha("e").slice(0, 10), T0 + 23 * MIN, "v");
  s.db.prepare("INSERT INTO head_seen(nwo,pr,sha,first_seen_at) VALUES(?,?,?,?)").run("o/r", 23, sha("f"), T0 + 24 * MIN);
  // Pull request 1 merged by the queue, at the commit judged there.
  s.put(T0 + 1 * MIN + 10, "queue.decided", "pr:1", { head: sha("e"), state: "PASS" });
  merged[0].mergeCommit = sha("e");
  const r = trialReport(s.db, { repo: R, since: T0, now: T0 + 80 * HOUR, merged, seeded: [seededAs("good", true, "PASS", "PASS"), seededAs("red CI", true, "BLOCK")] });
  s.db.close();
  assert.equal(r.conditions.find((c) => /no false call/.test(c.name))?.met, null, "the audit is a person's");
  assert.equal(r.ready, true, "every condition the records show holds");
  assert.equal(r.passed, false, "yet it isn't passed until the audit is");
  assert.match(renderTrial(r, "o/r"), /every condition the records show holds: it passes once a person's audit finds no false call/);
});

test("each seeded case must come out as it must, for its reason, and cases not run or none seeded are a condition not met", () => {
  const s = store();
  const report = (/** @type {any} */ seeded) => trialReport(s.db, { repo: R, since: T0, now: T0 + HOUR, merged: [], ...(seeded === undefined ? {} : { seeded }) });
  const cond = (/** @type {any} */ seeded) => report(seeded).conditions.find((c) => /seeded/.test(c.name));
  assert.equal(cond(undefined)?.met, false);
  assert.match(String(cond(undefined)?.detail), /not run: pass --seeded to run them/);
  assert.equal(cond([])?.met, false);
  assert.match(String(cond([])?.detail), /none seeded yet/);
  // The right verdict for another reason isn't the case holding.
  const wrongReason = [seededAs("good", true, "PASS", "PASS"), seededAs("red CI", false, "BLOCK")];
  assert.equal(cond(wrongReason)?.met, false);
  assert.match(String(cond(wrongReason)?.detail), /1 of 2; not as they must: red CI \(it came out BLOCK, but not for its reason\)/);
  assert.match(renderTrial(report(wrongReason), R), /seeded cases:\n {2}ok {3}PASS {5}good: every clause satisfied\n {2}NOT {2}BLOCK {4}red CI: it came out BLOCK, but not for its reason/);
  assert.equal(cond([seededAs("good", true, "PASS", "PASS"), seededAs("red CI", true, "BLOCK")])?.met, true);
  s.db.close();
});

// ── what GitHub says merged ──────────────────────────────────────────────────

test("what merged is read from GitHub since the trial began, with its merge commit, and an answer that doesn't read whole vouches for nothing", () => {
  const asked = [];
  const answer = (rows) => (args) => { asked.push(args.join(" ")); return { ok: true, out: JSON.stringify(rows) }; };
  const at = (s) => new Date(s * 1000).toISOString();
  const got = mergedSince("o/r", T0, { run: answer([
    { number: 2, mergedAt: at(T0 + 60), headRefOid: sha("a"), mergeCommit: { oid: sha("c") } },
    { number: 3, mergedAt: at(T0 + 90), headRefOid: sha("d"), mergeCommit: null },
    { number: 1, mergedAt: at(T0 - 60), headRefOid: sha("b"), mergeCommit: { oid: sha("e") } }]) });
  assert.deepEqual(got, [{ pr: 2, mergedAt: T0 + 60, head: sha("a"), mergeCommit: sha("c") }, { pr: 3, mergedAt: T0 + 90, head: sha("d"), mergeCommit: null }], "only since the start");
  assert.match(asked[0], /--json number,mergedAt,headRefOid,mergeCommit /);
  assert.match(JSON.stringify(mergedSince("o/r", T0, { run: () => ({ ok: false, out: "", err: "HTTP 502" }) })), /HTTP 502/);
  assert.match(JSON.stringify(mergedSince("o/r", T0, { run: () => ({ ok: true, out: "{not json" }) })), /doesn't read as a list/);
  assert.match(JSON.stringify(mergedSince("o/r", T0, { run: answer([{ number: 2, mergedAt: at(T0 + 60), headRefOid: "short", mergeCommit: null }]) })), /doesn't read whole/);
  assert.match(JSON.stringify(mergedSince("o/r", T0, { run: answer([{ number: 2, mergedAt: at(T0 + 60), headRefOid: sha("a"), mergeCommit: { oid: "short" } }]) })), /doesn't read whole/);
  assert.match(JSON.stringify(mergedSince("o/r", T0, { run: answer([{ number: 2, mergedAt: at(T0 + 60), headRefOid: sha("a"), mergeCommit: null }]), limit: 1 })), /more than one read holds/);
});

/** A reeve to run, with a home of its own and a gh that answers what merged with `rows`. */
function reeveWith(rows) {
  const bin = tempDir("reeve-trial-gh-");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n  "pr list") printf '%s' '${JSON.stringify(rows)}' ;;\n  *) echo "not a read this test answers: $*" >&2; exit 1 ;;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const home = tempDir("reeve-trial-home-");
  mkdirSync(join(home, "credentials"), { recursive: true, mode: 0o700 });
  const env = { ...offlineEnv(), PATH: `${bin}:${offlineEnv().PATH}`, REEVE_HOME: home };
  return { home, run: (...args) => spawnSync(process.execPath, [REEVE, "trial", ...args], { encoding: "utf8", env }) };
}

test("reeve trial reports a store against the trial's conditions, reading what merged with gh", () => {
  // Read against the real clock, so the trial began three hours ago.
  const start = Math.floor(Date.now() / 1000) - 3 * HOUR;
  const s = store();
  ticking(s, start, 2);
  s.decided(start + 5 * MIN, 7, sha("a"), "PASS");
  s.record(R, 7, sha("a"));
  s.db.close();
  const { run } = reeveWith([{ number: 7, mergedAt: new Date((start + 10 * MIN) * 1000).toISOString(), headRefOid: sha("a"), mergeCommit: { oid: sha("b") } }]);
  const since = new Date(start * 1000).toISOString();
  const text = run("o/r", "--db", s.path, "--since", since);
  assert.equal(text.status, 1, "not passed: " + text.stderr);
  assert.match(text.stdout, /#7 at aaaaaaaaaa: PASS/);
  const json = run("o/r", "--db", s.path, "--since", since, "--json");
  assert.equal(JSON.parse(json.stdout).passedFinal, 1);
  const none = run("o/r", "--db", s.path);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /--since takes the date the trial's count started from/);
  const later = run("o/r", "--db", s.path, "--since", new Date((start + 10 * HOUR) * 1000).toISOString());
  assert.equal(later.status, 1);
  assert.match(later.stderr, /a trial can't have begun after now/);
  // The seeded cases, run when asked.
  const seededCond = (/** @type {any} */ doc) => doc.conditions.find((/** @type {any} */ c) => /seeded/.test(c.name));
  assert.match(seededCond(JSON.parse(json.stdout)).detail, /not run/);
  const seeded = JSON.parse(run("o/r", "--db", s.path, "--since", since, "--seeded", "--json").stdout);
  assert.ok(Array.isArray(seeded.seeded) && seeded.seeded.length > 1 && seeded.seeded.every((/** @type {any} */ x) => x.ok), JSON.stringify(seeded.seeded));
  assert.equal(seededCond(seeded).met, true);
  const elsewhere = spawnSync(process.execPath, [REEVE, "replay", "o/r", "--seeded"], { encoding: "utf8", env: offlineEnv() });
  assert.equal(elsewhere.status, 2, "only the trial runs them: " + elsewhere.stderr);
});

test("reeve trial reads only a store of the repository it's asked about", () => {
  const start = Math.floor(Date.now() / 1000) - 3 * HOUR;
  const since = new Date(start * 1000).toISOString();
  const { home, run } = reeveWith([]);
  // A store whose decision records are another repository's.
  const other = store();
  ticking(other, start, 1);
  other.record(R);
  other.record("x/y");
  other.db.close();
  const foreign = run("o/r", "--db", other.path, "--since", since);
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /this store holds decision records of x\/y, not o\/r/);
  const typed = run("o/r", "--db", other.path, "--since", since, "--json");
  assert.equal(JSON.parse(typed.stdout).kind, "store_unusable");
  // One named by hand that holds no record can't be told to be this one's.
  const bare = store();
  ticking(bare, start, 1);
  bare.db.close();
  const unnamed = run("o/r", "--db", bare.path, "--since", since);
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stderr, /holds no decision record, so which repository it's of can't be told/);
  // Nor one whose record can't be read.
  const garbled = store();
  ticking(garbled, start, 1);
  garbled.db.prepare("INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
    .run("garbled", 1, sha("a"), "{not json", start, start, 1, 1);
  garbled.db.close();
  const unread = run("o/r", "--db", garbled.path, "--since", since);
  assert.equal(unread.status, 1);
  assert.match(unread.stderr, /holds decision records of a repository that can't be read, not o\/r/);
  // The one reeve keeps for the repository is told by where it is.
  mkdirSync(join(home, "state", "o"), { recursive: true });
  const own = open(join(home, "state", "o", "r.db"));
  own.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(start + MIN, "daemon", "daemon.tick", null, "{}");
  own.close();
  const kept = run("o/r", "--since", since);
  assert.equal(kept.status, 1, "read, and not passed: " + kept.stderr);
  assert.match(kept.stdout, /shadow trial {2}o\/r/);
});
