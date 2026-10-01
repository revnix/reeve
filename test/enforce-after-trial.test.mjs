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
function runEnforcing(/** @type {string[]} */ extra, /** @type {(home: string, db: string) => (() => void) | void} */ before = () => {}) {
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
    return spawnSync(process.execPath, [REEVE, "run", "acme/widget", "--enforce", ...extra], { encoding: "utf8", cwd: home,
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
