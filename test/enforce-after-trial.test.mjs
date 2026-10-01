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
import { tempDir } from "./fixtures/temp.mjs";
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

test("the shadow trial's report runs to when the store's lock is held, so a call recorded before then is never left out", () => {
  // A call the reeve that held the store recorded as it let go: dated a minute
  // on, so a cutoff taken before the lock leaves it out, and one taken once it's
  // held, as late as the store's newest record, doesn't.
  const r = runEnforcing(["--trial-since", "2026-09-30T09:14Z"], (_home, db) => {
    const s = open(db);
    s.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
      .run(Math.floor(Date.now() / 1000) + 60, "daemon", "pr.decided", "pr:7",
           JSON.stringify({ head: "b".repeat(40), state: "BLOCK", summary: "", action: "ESCALATE", why: "", clauses: [] }));
    s.close();
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no false call on audit: 1 call\(s\) on 1 pull request\(s\) to audit/, "the call is in the trial: " + r.stderr.slice(-800));
});

test("the shadow trial counts toward enforcing only where every judgment it saw was made by the code and under the policy about to enforce", () => {
  assert.equal(typeof T.trialRanOn, "function", "src/trial.mjs has no trialRanOn");
  const db = open(join(tempDir("reeve-trial-ran-on-"), "s.db"));
  const code = { commit: "c".repeat(40), tree: "t".repeat(40), dirty: false };
  const judged = (/** @type {number} */ at, /** @type {any} */ over = {}) => db.prepare(
    "INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
    .run(`d${at}`, 1, "a".repeat(40), JSON.stringify({ subject: { repo: "acme/widget", pr: 1, head: "a".repeat(40) }, code, policy: "p1", ...over }), at, at, at, at);
  judged(SINCE + 100); judged(SINCE + 200);
  assert.deepEqual(T.trialRanOn(db, { since: SINCE, until: SINCE + 1000, code, policy: "p1" }), { ok: true });
  // Code that can't be told is no proof it's the same, though the policy is.
  const unreadable = T.trialRanOn(db, { since: SINCE, until: SINCE + 1000, code: { commit: null }, policy: "p1" });
  assert.equal(unreadable.ok, false, "untold code isn't this code");
  assert.match(unreadable.why, /2 judgment\(s\) whose code or policy can't be told/);
  // Before the trial began: not the trial's.
  judged(SINCE - 100, { code: { ...code, commit: "o".repeat(40) } });
  assert.deepEqual(T.trialRanOn(db, { since: SINCE, until: SINCE + 1000, code, policy: "p1" }), { ok: true });
  // Other code within it, and another policy after that.
  judged(SINCE + 300, { code: { ...code, commit: "o".repeat(40) } });
  judged(SINCE + 400, { policy: "p0" });
  const other = T.trialRanOn(db, { since: SINCE, until: SINCE + 1000, code, policy: "p1" });
  assert.equal(other.ok, false);
  assert.equal(other.after, SINCE + 400, "the trial would begin again after the last judgment made otherwise");
  assert.match(other.why, /2 judgment\(s\) made by other code or under another policy/);
  db.close();
});

test("reeve run --enforce refuses a trial made by other code than it runs, saying when the trial would begin again", () => {
  const r = runEnforcing(["--trial-since", "2026-09-30T09:14Z"], (_home, db) => {
    const s = open(db);
    s.prepare("INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
      .run("d1", 1, "a".repeat(40), JSON.stringify({ subject: { repo: "acme/widget", pr: 1, head: "a".repeat(40) },
        code: { commit: "o".repeat(40), tree: "t".repeat(40), dirty: false }, policy: "p0" }), SINCE + 600, SINCE + 600, 1, 1);
    s.close();
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /the shadow trial from 2026-09-30 09:14Z saw 1 judgment\(s\) made by other code or under another policy than this reeve would enforce with/);
  assert.match(r.stderr, /run the trial again on this code and policy, from after 2026-09-30 09:24Z/);
});
