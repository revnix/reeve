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
const T0 = 1_900_000_000, MIN = 60, HOUR = 3600;
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
  return { db, path, put, tick, decided };
}
/** Ticks every ten minutes, from `from` for `hours`. */
const ticking = (s, from, hours) => { for (let t = from; t <= from + hours * HOUR; t += 10 * MIN) s.tick(t); };

// ── running time ─────────────────────────────────────────────────────────────

test("running time is read from the daemon's ticks, and a gap of over 15 minutes is downtime", () => {
  const s = store();
  ticking(s, T0 + 10 * MIN, 2);
  ticking(s, T0 + 5 * HOUR, 1);
  const r = trialReport(s.db, { since: T0, now: T0 + 6 * HOUR + 5 * MIN, merged: [] });
  s.db.close();
  assert.equal(r.running.down.length, 1, JSON.stringify(r.running.down));
  assert.deepEqual(r.running.down[0], { from: T0 + 10 * MIN + 2 * HOUR, to: T0 + 5 * HOUR });
  assert.ok(Math.abs(r.running.hours - (3 + 15 / 60)) < 0.01, `${r.running.hours}`);
  assert.equal(r.conditions.find((c) => /72 hours/.test(c.name))?.met, false, "and three hours are short of the floor");
});

test("with no tick at all, the daemon didn't run, however short the time", () => {
  const s = store();
  const r = trialReport(s.db, { since: T0, now: T0 + 10 * MIN, merged: [] });
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
  const r = trialReport(s.db, { since: T0, now: T0 + 5 * HOUR, merged });
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

test("where what merged couldn't be read, whether every merge was covered isn't met", () => {
  const s = store();
  ticking(s, T0, 1);
  const r = trialReport(s.db, { since: T0, now: T0 + HOUR, merged: { why: "HTTP 502" } });
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
  const r = trialReport(s.db, { since: T0, now: T0 + 2 * HOUR, merged: [{ pr: 16, mergedAt: T0 + 8 * MIN, head: sha("8") }] });
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
  const r = trialReport(s.db, { since: T0, now: T0 + HOUR, merged: [] });
  s.db.close();
  assert.equal(r.kinds["a new push after a review"], null);
  const kinds = r.conditions.find((c) => /each kind/.test(c.name));
  assert.equal(kinds?.met, false);
  assert.match(String(kinds?.detail), new RegExp(`not yet: ${CASE_KINDS.join("; ")}`));
});

// ── conditions ───────────────────────────────────────────────────────────────

test("every final verdict on a merged pull request is listed for a person's audit, and the trial never passes on its own", () => {
  const s = store();
  ticking(s, T0, 80);
  const merged = [];
  for (let pr = 1; pr <= 10; pr++) { s.decided(T0 + pr * MIN, pr, sha(String(pr % 10)), "PASS"); merged.push({ pr, mergedAt: T0 + pr * MIN + 30, head: sha(String(pr % 10)) }); }
  s.decided(T0 + 20 * MIN, 21, sha("b"), "BLOCK", { action: "FIX_CI", why: "failing: unit", clauses: [{ id: "threads", state: "BLOCK" }] });
  merged.push({ pr: 21, mergedAt: T0 + 21 * MIN, head: sha("b") });
  s.decided(T0 + 22 * MIN, 22, sha("c"), "BLOCK", { why: "the branch conflicts with its base" });
  s.db.prepare("INSERT INTO review_round(nwo,pr,reviewer,source_id,outcome,head_full,head10,event_at,classifier_version) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("o/r", 23, "codex", "review:1", "findings", sha("e"), sha("e").slice(0, 10), T0 + 23 * MIN, "v");
  s.db.prepare("INSERT INTO head_seen(nwo,pr,sha,first_seen_at) VALUES(?,?,?,?)").run("o/r", 23, sha("f"), T0 + 24 * MIN);
  s.put(T0 + 25 * MIN, "queue.decided", "pr:1", { head: sha("9"), state: "PASS" });
  const r = trialReport(s.db, { since: T0, now: T0 + 80 * HOUR, merged, seeded: [{ name: "red CI", must: "BLOCK", got: "BLOCK" }] });
  s.db.close();
  assert.equal(r.toAudit.length, 11);
  assert.deepEqual(r.toAudit.map((a) => a.state).sort(), [...Array(10).fill("PASS"), "BLOCK"].sort());
  assert.equal(r.conditions.find((c) => /no false call/.test(c.name))?.met, null, "the audit is a person's");
  assert.equal(r.ready, true, "every condition the records show holds");
  assert.equal(r.passed, false, "yet it isn't passed until the audit is");
  assert.match(renderTrial(r, "o/r"), /every condition the records show holds: it passes once a person's audit finds no false call/);
});

test("a seeded known-bad case must get the verdict it must, and none seeded is a condition not met", () => {
  const s = store();
  const cond = (seeded) => trialReport(s.db, { since: T0, now: T0 + HOUR, merged: [], seeded }).conditions.find((c) => /seeded/.test(c.name));
  assert.equal(cond([])?.met, false);
  assert.match(String(cond([])?.detail), /none seeded yet/);
  assert.equal(cond([{ name: "red CI", must: "BLOCK", got: "PASS" }])?.met, false);
  assert.equal(cond([{ name: "red CI", must: "BLOCK", got: "BLOCK" }])?.met, true);
  s.db.close();
});

// ── what GitHub says merged ──────────────────────────────────────────────────

test("what merged is read from GitHub since the trial began, and an answer that doesn't read whole vouches for nothing", () => {
  const answer = (rows) => () => ({ ok: true, out: JSON.stringify(rows) });
  const at = (s) => new Date(s * 1000).toISOString();
  const got = mergedSince("o/r", T0, { run: answer([{ number: 2, mergedAt: at(T0 + 60), headRefOid: sha("a") }, { number: 1, mergedAt: at(T0 - 60), headRefOid: sha("b") }]) });
  assert.deepEqual(got, [{ pr: 2, mergedAt: T0 + 60, head: sha("a") }], "only since the start");
  assert.match(JSON.stringify(mergedSince("o/r", T0, { run: () => ({ ok: false, out: "", err: "HTTP 502" }) })), /HTTP 502/);
  assert.match(JSON.stringify(mergedSince("o/r", T0, { run: () => ({ ok: true, out: "{not json" }) })), /doesn't read as a list/);
  assert.match(JSON.stringify(mergedSince("o/r", T0, { run: answer([{ number: 2, mergedAt: at(T0 + 60), headRefOid: "short" }]) })), /doesn't read whole/);
  assert.match(JSON.stringify(mergedSince("o/r", T0, { run: answer([{ number: 2, mergedAt: at(T0 + 60), headRefOid: sha("a") }]), limit: 1 })), /more than one read holds/);
});

test("reeve trial reports a store against the trial's conditions, reading what merged with gh", () => {
  // Read against the real clock, so the trial began three hours ago.
  const start = Math.floor(Date.now() / 1000) - 3 * HOUR;
  const s = store();
  ticking(s, start, 2);
  s.decided(start + 5 * MIN, 7, sha("a"), "PASS");
  s.db.close();
  const bin = tempDir("reeve-trial-gh-");
  const merged = JSON.stringify([{ number: 7, mergedAt: new Date((start + 10 * MIN) * 1000).toISOString(), headRefOid: sha("a") }]);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n  "pr list") printf '%s' '${merged}' ;;\n  *) echo "not a read this test answers: $*" >&2; exit 1 ;;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const home = tempDir("reeve-trial-home-");
  mkdirSync(join(home, "credentials"), { recursive: true, mode: 0o700 });
  const env = { ...offlineEnv(), PATH: `${bin}:${offlineEnv().PATH}`, REEVE_HOME: home };
  const since = new Date(start * 1000).toISOString();
  const text = spawnSync(process.execPath, [REEVE, "trial", "o/r", "--db", s.path, "--since", since], { encoding: "utf8", env });
  assert.equal(text.status, 1, "not passed: " + text.stderr);
  assert.match(text.stdout, /#7 at aaaaaaaaaa: PASS/);
  const json = spawnSync(process.execPath, [REEVE, "trial", "o/r", "--db", s.path, "--since", since, "--json"], { encoding: "utf8", env });
  assert.equal(JSON.parse(json.stdout).passedFinal, 1);
  const none = spawnSync(process.execPath, [REEVE, "trial", "o/r", "--db", s.path], { encoding: "utf8", env });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /--since takes the date the trial's count started from/);
  const later = spawnSync(process.execPath, [REEVE, "trial", "o/r", "--db", s.path, "--since", new Date((start + 10 * HOUR) * 1000).toISOString()], { encoding: "utf8", env });
  assert.equal(later.status, 1);
  assert.match(later.stderr, /a trial can't have begun after now/);
});
