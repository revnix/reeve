// Enforcing only after a passed shadow trial (#166, its 2026-09-24 addition).
//
// --enforce already refuses where the default branch doesn't enforce what reeve
// publishes. It also needs the shadow trial to have passed: every condition of
// its report met, and a person's audit finding no false call. Time alone
// doesn't pass it. `reeve run --enforce` is told when the trial began, builds
// its report as `reeve trial` does, and refuses unless it passed, saying what's
// short, beside any other reason it refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as trial from "../src/trial.mjs";
import { open, storeLock } from "../src/db/ops.mjs";
import { statePathFor } from "../src/paths.mjs";
import { withDefaults } from "../src/profile/schema.mjs";
import { digestOf, policyOf } from "../src/evidence.mjs";
import { TICK_STARTED, TICK_STOPPED } from "../src/status.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { run } from "./fixtures/tick-harness.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = fileURLToPath(new URL("../bin/reeve", import.meta.url));
/** @type {any} */ const T = trial;
const SINCE = Math.floor(Date.parse("2026-09-30T09:14Z") / 1000);

test("the shadow trial lets reeve enforce only once its report has passed, and says each condition short otherwise", () => {
  assert.equal(typeof T.trialGate, "function", "src/trial.mjs has no trialGate");
  const condition = (/** @type {string} */ name, /** @type {boolean | null} */ met, /** @type {string} */ detail) => ({ name, met, detail });
  const passed = { passed: true, conditions: [condition("at least 72 hours of running", true, "80.0 hours")] };
  assert.deepEqual(T.trialGate(passed, { since: SINCE }), { ok: true });
  const short = { passed: false, ready: false, conditions: [
    condition("at least 72 hours of running", false, "17.6 hours"),
    condition("each kind of case seen", true, "all seen"),
    condition("no false call on audit", null, "54 call(s) on 17 pull request(s) to audit"),
  ] };
  const g = T.trialGate(short, { since: SINCE });
  assert.equal(g.ok, false);
  assert.match(g.why, /the shadow trial from 2026-09-30 09:14Z hasn't passed: at least 72 hours of running: 17\.6 hours; no false call on audit: 54 call\(s\)/);
  assert.doesNotMatch(g.why, /each kind of case seen/, "only what's short");
  // Ready, every condition the records show met, but no audit yet: still not passed.
  assert.equal(T.trialGate({ passed: false, ready: true, conditions: [condition("no false call on audit", null, "3 call(s) to audit")] }, { since: SINCE }).ok, false);
});

/** A home whose App can't be signed in to, with acme/widget's store and profile, and `reeve run` there; `before` readies it. */
function runEnforcing(/** @type {string[]} */ extra, /** @type {(home: string, db: string) => (() => void) | void} */ before = () => {},
                     /** @type {string[] | null} */ args = null) {
  const home = tempDir("reeve-trial-gate-home-");
  const db = statePathFor(home, "acme/widget");
  mkdirSync(dirname(db), { recursive: true });
  open(db).close();
  mkdirSync(join(home, "profiles", "acme"), { recursive: true });
  writeFileSync(join(home, "profiles", "acme", "widget.json"), JSON.stringify(withDefaults({ schemaVersion: 1, project: { kind: "product" },
    identity: { key: "acme/widget", defaultBranch: "main", visibility: "public" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
    state: { mode: "in-repo" }, units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] })));
  const after = before(home, db);
  try {
    return spawnSync(process.execPath, [REEVE, "run", "acme/widget", ...(args ?? ["--enforce", ...extra])], { encoding: "utf8", cwd: home,
      env: { ...offlineEnv(), REEVE_HOME: home }, timeout: 120_000 });
  } finally { if (after) after(); }
}

test("reeve run --enforce needs to be told when the shadow trial began, and refuses a date it can't read", () => {
  const none = runEnforcing([]);
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stderr, /reeve run: --enforce needs --trial-since, the date the shadow trial began/);
  assert.doesNotMatch(none.stdout + none.stderr, /daemon starting/);
  const garbled = runEnforcing(["--trial-since", "yesterday"]);
  assert.equal(garbled.status, 1, garbled.stdout + garbled.stderr);
  assert.match(garbled.stderr, /--trial-since takes the date the shadow trial began, as 2026-09-30T09:14Z, got "yesterday"/);
});

test("reeve run --enforce refuses until the shadow trial has passed, saying what's short beside any other reason", () => {
  const r = runEnforcing(["--trial-since", "2026-09-30T09:14Z"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  // Both reasons, so a person sees all that's missing at once.
  assert.match(r.stderr, /--enforce refused: reeve's App couldn't be signed in to read main's rules/);
  assert.match(r.stderr, /the shadow trial from 2026-09-30 09:14Z hasn't passed: .*no false call on audit/);
  assert.match(r.stderr, /reeve trial acme\/widget --since 2026-09-30T09:14Z --seeded/, "how to see what's short");
  assert.doesNotMatch(r.stdout + r.stderr, /daemon starting/);
});

test("the shadow trial is read only from the repository's own store, never another's named with --db", () => {
  const r = runEnforcing(["--trial-since", "2026-09-30T09:14Z", "--db", "other.db"], (home) => {
    const other = open(join(home, "other.db"));
    other.prepare("INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
      .run("x", 1, "a".repeat(40), JSON.stringify({ subject: { repo: "some/other", pr: 1, head: "a".repeat(40) } }), SINCE, SINCE, 1, 1);
    other.close();
  });
  // --db other.db, in the home it runs in.
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /--enforce refused: .*holds decision records of some\/other, not acme\/widget/);
  assert.doesNotMatch(r.stdout + r.stderr, /daemon starting/);
});

test("the shadow trial is read only once the store's lock is held, so a reeve running on it is never written under", () => {
  /** @type {string} */ let before = "";
  /** @type {string} */ let path = "";
  const digest = (/** @type {string} */ p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const r = runEnforcing(["--trial-since", "2026-09-30T09:14Z"], (_home, db) => {
    path = db;
    before = digest(db);
    const held = storeLock(db);
    assert.ok(!("why" in held), JSON.stringify(held));
    return () => /** @type {any} */ (held).release();
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /another reeve is running on/, "the lock first, before the store is opened for the trial");
  assert.doesNotMatch(r.stderr, /shadow trial/);
  assert.equal(digest(path), before, "the store as it was");
});

test("reeve run's help and the README say --enforce needs --trial-since", () => {
  const help = spawnSync(process.execPath, [REEVE, "help"], { encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: tempDir("reeve-help-") }, timeout: 60_000 });
  assert.match(help.stdout + help.stderr, /--enforce --trial-since <date>/);
  assert.match(readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8"), /--enforce --trial-since/);
});

test("--trial-since is taken only by reeve run --enforce, and refused anywhere it would be ignored", () => {
  const home = tempDir("reeve-trial-since-home-");
  const at = (/** @type {string[]} */ args) => spawnSync(process.execPath, [REEVE, ...args], { encoding: "utf8", cwd: home, env: { ...offlineEnv(), REEVE_HOME: home }, timeout: 60_000 });
  const backup = at(["backup", "acme/widget", "--trial-since", "2026-09-30T09:14Z"]);
  assert.notEqual(backup.status, 0, backup.stdout + backup.stderr);
  assert.match(backup.stderr, /--trial-since is not implemented by `backup`/);
  const shadow = runEnforcing([], () => {}, ["--trial-since", "2026-09-30T09:14Z"]);
  assert.equal(shadow.status, 1, shadow.stdout + shadow.stderr);
  assert.match(shadow.stderr, /--trial-since is read only with --enforce/);
  assert.doesNotMatch(shadow.stdout + shadow.stderr, /daemon starting/);
});

test("a store holding a record dated after now is refused, as the clock has gone back and a trial can't be read across it", () => {
  // Dated a minute on: a trial run to the store's newest record would stretch
  // into the future, and count running time it never had.
  const r = runEnforcing(["--trial-since", "2026-09-30T09:14Z"], (_home, db) => {
    const s = open(db);
    s.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
      .run(Math.floor(Date.now() / 1000) + 60, "daemon", "pr.decided", "pr:7",
           JSON.stringify({ head: "b".repeat(40), state: "BLOCK", summary: "", action: "ESCALATE", why: "", clauses: [] }));
    s.close();
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /holds a record dated .*, after now: the clock has gone back since it was written, and a shadow trial can't be read across that/);
  assert.doesNotMatch(r.stderr, /1 call\(s\) on 1 pull request\(s\) to audit/, "the trial isn't read past now");
});

const CODE = { commit: "c".repeat(40), tree: "t".repeat(40), dirty: false };
const HEAD = "a".repeat(40);
/** A store of its own, for one case. */
const fresh = () => open(join(tempDir("reeve-trial-ran-on-"), "s.db"));
/**
 * A judgment of pull request 1 at `at`, as the daemon records one: its event,
 * naming the record it was judged from, and that record, kept under its digest
 * in the same seq. `over` changes the record, and `row` the row it's kept in,
 * once its digest is taken; `op` is the event's; `kept: false` records the event
 * alone, as a judgment whose record couldn't be made.
 * @param {any} db @param {number} at
 * @param {{ over?: any, row?: any, op?: string, kept?: boolean }} [o]
 */
function judge(db, at, { over = {}, row = {}, op = "pr.decided", kept = true } = {}) {
  const record = { subject: { repo: "acme/widget", pr: 1, head: HEAD }, code: CODE, policy: "p1", observedAt: at, ...over };
  const digest = digestOf(record);
  const payload = op === "queue.decided" ? { head: HEAD, state: "PASS", record: kept ? digest : null } : { head: HEAD, state: "PASS", ...(kept ? { record: digest } : {}) };
  const seq = Number(db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(at, "daemon", op, "pr:1", JSON.stringify(payload)).lastInsertRowid);
  const r = { pr: 1, head: HEAD, record: JSON.stringify(record), first_seq: seq, last_seq: seq, ...row };
  if (kept) db.prepare("INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
    .run(digest, r.pr, r.head, r.record, at, at, r.first_seq, r.last_seq);
}
/**
 * A tick's start, end or stop at `at`, as the daemon records each, saying the
 * code and policy it ran; `mark: null` says neither, as one recorded before
 * ticks said.
 * @param {any} db @param {number} at @param {{ op?: string, mark?: any }} [o]
 */
const ticked = (db, at, { op = TICK_STARTED, mark = { code: CODE, policy: "p1" } } = {}) =>
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(at, "daemon", op, null, JSON.stringify(mark ?? {}));
/** Whether the trial in `db` from SINCE ran on CODE under p1, or what `o` says. @param {any} db @param {any} [o] */
const ranOn = (db, o = {}) => T.trialRanOn(db, { since: SINCE, until: SINCE + 1000, code: CODE, policy: "p1", ...o });

test("the shadow trial counts toward enforcing only where every judgment it saw was made by the code and under the policy about to enforce", () => {
  assert.equal(typeof T.trialRanOn, "function", "src/trial.mjs has no trialRanOn");
  const db = fresh();
  judge(db, SINCE + 100); judge(db, SINCE + 200, { op: "queue.decided" });
  assert.deepEqual(ranOn(db), { ok: true });
  // Code that can't be told is no proof it's the same, though the policy is.
  const unreadable = ranOn(db, { code: { commit: null } });
  assert.equal(unreadable.ok, false, "untold code isn't this code");
  assert.match(unreadable.why, /2 judgment\(s\) whose code or policy can't be told/);
  // Before the trial began: not the trial's.
  judge(db, SINCE - 100, { over: { code: { ...CODE, commit: "o".repeat(40) } } });
  assert.deepEqual(ranOn(db), { ok: true });
  // Other code within it, and another policy after that.
  judge(db, SINCE + 300, { over: { code: { ...CODE, commit: "o".repeat(40) } } });
  judge(db, SINCE + 400, { over: { policy: "p0" }, op: "queue.decided" });
  const other = ranOn(db);
  assert.equal(other.ok, false);
  assert.equal(other.after, SINCE + 400, "the trial would begin again after the last judgment made otherwise");
  assert.match(other.why, /2 judgment\(s\) made by other code or under another policy/);
  db.close();
});

test("a judgment the shadow trial saw without the record it was judged from is no proof of the code and policy about to enforce", () => {
  // Each alone in a store of its own: a judgment whose record couldn't be kept,
  // on a pull request and on the queue, and one naming a record the store doesn't hold.
  for (const [what, make] of /** @type {[string, (db: any) => void][]} */ ([
    ["a pull request's, its record not kept", (db) => judge(db, SINCE + 100, { kept: false })],
    ["the queue's, its record not kept", (db) => judge(db, SINCE + 100, { op: "queue.decided", kept: false })],
    ["one naming a record the store doesn't hold", (db) => { judge(db, SINCE + 100); db.prepare("DELETE FROM decision WHERE first_at = ?").run(SINCE + 100); }],
  ])) {
    const db = fresh();
    judge(db, SINCE + 50);
    make(db);
    const r = ranOn(db);
    assert.equal(r.ok, false, what);
    assert.match(r.why, /1 judgment\(s\) whose code or policy can't be told/, what);
    assert.equal(r.after, SINCE + 100, what);
    db.close();
  }
});

test("a record that doesn't hold as it was kept is no proof of the code and policy about to enforce, though it names them", () => {
  for (const [what, o] of /** @type {[string, any][]} */ ([
    // Changed in place, still naming this code and policy: its digest is the old one's.
    ["its record changed since it was kept", { row: { record: JSON.stringify({ subject: { repo: "acme/widget", pr: 1, head: HEAD }, code: CODE, policy: "p1", observedAt: 1 }) } }],
    // Whole, but another pull request's record, which this judgment names.
    ["another pull request's record", { over: { subject: { repo: "acme/widget", pr: 2, head: HEAD } }, row: { pr: 2 } }],
    // Whole, but kept as another judgment's: its seqs aren't this one's.
    ["another judgment's record", { row: { first_seq: 1000, last_seq: 1000 } }],
  ])) {
    const db = fresh();
    judge(db, SINCE + 100, o);
    const r = ranOn(db);
    assert.equal(r.ok, false, what);
    assert.match(r.why, /1 judgment\(s\) whose code or policy can't be told/, what);
    db.close();
  }
});

test("the time the shadow trial ran counts toward enforcing only where every tick in it ran the code and policy about to enforce", () => {
  // Every tick of the trial on this code and policy: its start, end and stop.
  const same = fresh();
  ticked(same, SINCE + 10); ticked(same, SINCE + 20, { op: "daemon.tick" }); ticked(same, SINCE + 30); ticked(same, SINCE + 40, { op: TICK_STOPPED });
  // One the other version ran, before the trial began: not the trial's.
  ticked(same, SINCE - 10, { op: "daemon.tick", mark: { code: { ...CODE, commit: "o".repeat(40) }, policy: "p1" } });
  assert.deepEqual(ranOn(same), { ok: true });
  // Each alone, among this code's ticks: an end by the version before, a stop
  // that says nothing, and a start under another policy.
  for (const [what, op, mark, says] of /** @type {[string, string, any, RegExp][]} */ ([
    ["the end of a tick the version before ran", "daemon.tick", { code: { ...CODE, commit: "o".repeat(40) }, policy: "p1" }, /1 tick\(s\) run by other code or under another policy/],
    ["a stop that says nothing of what ran it", TICK_STOPPED, null, /1 tick\(s\) whose code or policy can't be told/],
    ["a start under another policy", TICK_STARTED, { code: CODE, policy: "p0" }, /1 tick\(s\) run by other code or under another policy/],
  ])) {
    const db = fresh();
    ticked(db, SINCE + 10); ticked(db, SINCE + 20, { op: "daemon.tick" });
    ticked(db, SINCE + 30, { op, mark });
    const r = ranOn(db);
    assert.equal(r.ok, false, what);
    assert.match(r.why, says, what);
    assert.equal(r.after, SINCE + 30, what);
    db.close();
  }
});

test("each tick says the code and policy it ran, at its start, its end and a stop, so a trial is told by them", async () => {
  const dbPath = join(tempDir("reeve-trial-ticks-"), "s.db");
  const from = Math.floor(Date.now() / 1000);
  let n = 0;
  // A tick that ends, and one that stops, unable to list the pull requests.
  const out = await run({ dbPath, ticks: 2, code: CODE, openPrs: () => (n++ ? null : []) });
  const policy = policyOf(out.ctx.profile).hash;
  const db = open(dbPath);
  const marks = /** @type {any[]} */ (db.prepare("SELECT op, payload FROM event WHERE op IN (?, 'daemon.tick', ?) ORDER BY seq").all(TICK_STARTED, TICK_STOPPED))
    .map((e) => ({ op: e.op, ...JSON.parse(e.payload) }));
  assert.deepEqual(marks.map((m) => m.op), [TICK_STARTED, "daemon.tick", TICK_STARTED, TICK_STOPPED]);
  for (const m of marks) assert.deepEqual({ code: m.code, policy: m.policy }, { code: CODE, policy }, m.op);
  const until = Math.floor(Date.now() / 1000) + 1;
  assert.deepEqual(T.trialRanOn(db, { since: from, until, code: CODE, policy }), { ok: true });
  assert.match(T.trialRanOn(db, { since: from, until, code: { ...CODE, commit: "o".repeat(40) }, policy }).why ?? "", /4 tick\(s\) run by other code/);
  db.close();
  // And a tick that throws, once it knows what it runs.
  const thrownPath = join(tempDir("reeve-trial-ticks-"), "s.db");
  await assert.rejects(run({ dbPath: thrownPath, code: CODE, openPrs: () => { throw new Error("the list couldn't be read"); } }), /the list couldn't be read/);
  const thrown = open(thrownPath);
  const stop = JSON.parse(/** @type {any} */ (thrown.prepare("SELECT payload FROM event WHERE op = ?").get(TICK_STOPPED))?.payload ?? "{}");
  assert.deepEqual(stop.code, CODE, "the stop of a tick that threw");
  assert.match(String(stop.policy), /^[0-9a-f]{64}$/);
  thrown.close();
});

test("reeve run --enforce refuses a trial made by other code than it runs, saying when the trial would begin again", () => {
  const r = runEnforcing(["--trial-since", "2026-09-30T09:14Z"], (_home, db) => {
    const s = open(db);
    judge(s, SINCE + 600, { over: { code: { commit: "o".repeat(40), tree: "t".repeat(40), dirty: false }, policy: "p0" } });
    s.close();
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /the shadow trial from 2026-09-30 09:14Z saw 1 judgment\(s\) made by other code or under another policy than this reeve would enforce with/);
  assert.match(r.stderr, /run the trial again on this code and policy, from after 2026-09-30 09:24Z/);
});

test("an audit recorded while the shadow trial is read refuses enforcing, since what it says may not be what was read", () => {
  assert.equal(typeof T.trialForEnforcing, "function", "src/trial.mjs has no trialForEnforcing");
  const db = open(join(tempDir("reeve-trial-audits-"), "s.db"));
  const now = Math.floor(Date.now() / 1000);
  const base = { nwo: "acme/widget", store: "s.db", named: false, since: SINCE, now, merged: [], seeded: null, trialSince: "2026-09-30T09:14Z",
                 code: { commit: "c".repeat(40), tree: "t".repeat(40), dirty: false }, policy: "p1" };
  // The same audits read twice, and one recorded between the reads.
  const steady = T.trialForEnforcing(db, { ...base, audits: () => ({ ok: true, audits: [] }) });
  assert.doesNotMatch(steady.reasons.join("\n"), /an audit was recorded while/);
  let reads = 0;
  const changed = T.trialForEnforcing(db, { ...base, audits: () => ({ ok: true, audits: reads++ ? [{ name: "000001.json", calls: [] }] : [] }) });
  assert.equal(changed.ok, false);
  assert.match(changed.reasons.join("\n"), /an audit was recorded while the shadow trial was read, so what it says may not be what was read\. To enforce, run this again/);
  assert.equal(reads, 2, "read once for the report, and again once all of it's read");
  db.close();
});
