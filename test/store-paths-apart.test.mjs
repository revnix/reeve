// Stores and dashboards of repositories whose names a path made alike, kept apart
// (#310): `.github` and `-github` were both `-github` on disk, and shared one
// store and one dashboard, each writing into the other's.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import * as paths from "../src/paths.mjs";
import { everyStore } from "../src/backup.mjs";
import { storeStatus, ensureStore } from "../src/init.mjs";
import { storeLock } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
const sha = (/** @type {string} */ c) => c.repeat(40);

/** A store at `path` holding a decision record of each repository in `repos`. */
function storeAt(/** @type {string} */ path, /** @type {string[]} */ repos) {
  mkdirSync(dirname(path), { recursive: true });
  const db = open(path);
  repos.forEach((repo, i) => db.prepare("INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
    .run(`${repo}#${i + 1}`, i + 1, sha("a"), JSON.stringify({ subject: { repo, pr: i + 1, head: sha("a") } }), 1, 1, 1, 1));
  db.close();
  return path;
}
/** Where a store was kept before #310: the owner and name made safe for the path, `.github` as `-github`. */
const shared = (/** @type {string} */ home, /** @type {string} */ owner, /** @type {string} */ name) => join(home, "state", owner, `${name}.db`);

test("repositories whose names a path made alike get stores and dashboards of their own, and every other keeps its path", () => {
  const home = "/h";
  assert.notEqual(paths.statePathFor(home, "o/.github"), paths.statePathFor(home, "o/-github"));
  assert.notEqual(paths.dashPathFor(home, "o/.github"), paths.dashPathFor(home, "o/-github"));
  assert.notEqual(paths.statePathFor(home, "o/..x"), paths.statePathFor(home, "o/-x"));
  // Every name a path keeps as it is stays where it was.
  assert.equal(paths.statePathFor(home, "nextlyhq/nextly"), "/h/state/nextlyhq/nextly.db");
  assert.equal(paths.statePathFor(home, "o/my.repo_2-x"), "/h/state/o/my.repo_2-x.db");
  assert.equal(paths.dashPathFor(home, "o/-github"), "/h/dash/o/-github.html");
  // And none walks out of the folder.
  for (const nwo of ["o/..", "o/.", "../x/y", "o/a%2Fb"]) {
    const p = paths.statePathFor(home, nwo);
    assert.ok(!relative("/h/state", p).startsWith(".."), p);
    assert.equal(relative("/h/state", p).split("/").length, 2, `one owner's folder and one file: ${p}`);
  }
  assert.notEqual(paths.statePathFor(home, "o/a%2Eb"), paths.statePathFor(home, "o/a.b"), "a name with a % in it is coded too");
});

test("a store an earlier reeve kept where names were made alike is found again for the repository its records are of, and moved into place", () => {
  const home = tempDir("reeve-paths-");
  const was = storeAt(shared(home, "o", "-github"), ["o/.github", "o/.github"]);
  assert.equal(paths.earlierStorePath(home, "o/.github"), was);
  assert.deepEqual(storeStatus(home, "o/.github"), { state: "legacy", path: paths.statePathFor(home, "o/.github"), legacy: was });
  const made = ensureStore(home, "o/.github");
  assert.equal(made.changed, true, JSON.stringify(made));
  assert.ok(existsSync(paths.statePathFor(home, "o/.github")), "moved into place");
  assert.equal(existsSync(was), false);
});

test("a store kept there that holds another repository's records, none, or can't be read, isn't taken for this one's", () => {
  const home = tempDir("reeve-paths-");
  const theirs = storeAt(shared(home, "o", "-github"), ["o/-github"]);
  assert.notEqual(paths.earlierStorePath(home, "o/.github"), theirs, "another repository's");
  const mixed = storeAt(shared(home, "o2", "-x"), ["o2/.x", "o2/-x"]);
  assert.notEqual(paths.earlierStorePath(home, "o2/.x"), mixed, "another repository's beside this one's");
  const empty = storeAt(shared(home, "o3", "-y"), []);
  assert.notEqual(paths.earlierStorePath(home, "o3/.y"), empty, "none, so whose can't be told");
  const garbled = shared(home, "o4", "-z");
  mkdirSync(dirname(garbled), { recursive: true });
  writeFileSync(garbled, "not a store");
  /** @type {any} */ let got;
  try { got = paths.earlierStorePath(home, "o4/.z"); } catch (err) { got = { threw: String(err) }; }
  assert.notEqual(got, garbled, "one that can't be read");
  assert.equal(typeof got, "string", JSON.stringify(got));
  // The repository whose path it still is keeps it.
  assert.equal(paths.statePathFor(home, "o/-github"), theirs);
});

test("each store is backed up as the repository its path names, the names a path codes read back", () => {
  const home = tempDir("reeve-paths-");
  storeAt(paths.statePathFor(home, "o/.github"), []);
  storeAt(paths.statePathFor(home, "o/-github"), []);
  storeAt(paths.statePathFor(home, "o/my.repo"), []);
  // A file reeve didn't name, with a % that doesn't read as a code.
  storeAt(join(home, "state", "50%", "x.db"), []);
  /** @type {any} */ let stores;
  try { stores = everyStore(home).map((s) => s.nwo).sort(); } catch (err) { stores = { threw: String(err) }; }
  assert.deepEqual(stores, ["50%/x", "o/-github", "o/.github", "o/my.repo"]);
});

test("reeve finds the store an earlier reeve kept for a repository whose name a path made alike, and moves it into place", () => {
  const home = tempDir("reeve-paths-home-");
  const was = storeAt(shared(home, "o", "-github"), ["o/.github"]);
  const bin = tempDir("reeve-paths-gh-");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho \"not a read this test answers: $*\" >&2\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const r = spawnSync(process.execPath, [REEVE, "replay", "o/.github"], { encoding: "utf8", env: { ...offlineEnv(), PATH: `${bin}:${offlineEnv().PATH}`, REEVE_HOME: home } });
  assert.match(r.stderr, new RegExp(`moved ${was.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> .*%2Egithub\\.db`), r.stdout + r.stderr);
  assert.ok(existsSync(paths.statePathFor(home, "o/.github")));
});

// ── #318's first review ──────────────────────────────────────────────────────

/** reeve, run with `home` as its home and a gh that answers nothing. */
function reeveIn(/** @type {string} */ home) {
  const bin = tempDir("reeve-paths-gh-");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho \"not a read this test answers: $*\" >&2\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  return (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [REEVE, ...args], { encoding: "utf8", env: { ...offlineEnv(), PATH: `${bin}:${offlineEnv().PATH}`, REEVE_HOME: home } });
}

test("a store at a repository's own path holding another's records, kept there while names a path made alike shared one, is refused for it", () => {
  const home = tempDir("reeve-paths-home-");
  // `o/.github`'s store, kept at the path `o/-github`'s is now.
  storeAt(shared(home, "o", "-github"), ["o/.github"]);
  const r = reeveIn(home)("replay", "o/-github");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /reeve replay: the store at .*-github\.db holds decision records of o\/\.github, not o\/-github/);
  // Its own, the command runs on it.
  const own = tempDir("reeve-paths-home-");
  storeAt(shared(own, "o", "-github"), ["o/-github"]);
  assert.doesNotMatch(reeveIn(own)("replay", "o/-github").stderr, /holds decision records of/, "control: its own store");
});

test("a store moved from where names were made alike takes the dashboard written beside it there", () => {
  const home = tempDir("reeve-paths-home-");
  storeAt(shared(home, "o", "-github"), ["o/.github"]);
  const dash = join(home, "dash", "o", "-github.html");
  mkdirSync(dirname(dash), { recursive: true });
  writeFileSync(dash, "<title>o/.github — fleet</title>");
  reeveIn(home)("replay", "o/.github");
  assert.ok(existsSync(paths.statePathFor(home, "o/.github")), "control: moved");
  assert.equal(existsSync(dash), false, "its dashboard gone from the other's path");
  // A store moved from the older layout leaves every dashboard as it is.
  const older = tempDir("reeve-paths-home-");
  storeAt(join(older, "state", "r.db"), ["o/r"]);
  const theirs = join(older, "dash", "o", "r.html");
  mkdirSync(dirname(theirs), { recursive: true });
  writeFileSync(theirs, "x");
  reeveIn(older)("replay", "o/r");
  assert.ok(existsSync(paths.statePathFor(older, "o/r")), "control: moved from the older layout");
  assert.ok(existsSync(theirs));
});

test("looking for a store an earlier reeve kept leaves nothing beside it", () => {
  const home = tempDir("reeve-paths-");
  const was = storeAt(shared(home, "o", "-github"), ["o/.github"]);
  assert.deepEqual(readdirSync(dirname(was)), ["-github.db"], "control: closed whole, nothing beside it");
  assert.equal(paths.earlierStorePath(home, "o/.github"), was);
  assert.match(String(paths.storeLookup(home, "o/-github").refused), /holds decision records of o\/\.github, not o\/-github/);
  assert.deepEqual(readdirSync(dirname(was)), ["-github.db"]);
});

test("a store an earlier reeve kept, its records still in its log beside it, is read with its log", () => {
  const home = tempDir("reeve-paths-");
  const path = shared(home, "o", "-github");
  mkdirSync(dirname(path), { recursive: true });
  // Held open, as a reeve running on it holds it: what it commits stays in its log.
  const db = open(path);
  try {
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.prepare("INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
      .run("o/.github#1", 1, sha("a"), JSON.stringify({ subject: { repo: "o/.github", pr: 1, head: sha("a") } }), 1, 1, 1, 1);
    assert.ok(existsSync(`${path}-wal`), "control: its log is beside it");
    assert.equal(paths.earlierStorePath(home, "o/.github"), path);
  } finally { db.close(); }
});

// ── #318's second review ─────────────────────────────────────────────────────

/** A store at `path` holding a decision record that can't be read as one. */
function garbledAt(/** @type {string} */ path) {
  storeAt(path, []);
  const db = open(path);
  db.prepare("INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)").run("x#1", 1, sha("a"), "{not json", 1, 1, 1, 1);
  db.close();
  return path;
}

test("a store at a repository's own path holding a decision record that can't be read is refused, as whose it is can't be told", () => {
  const home = tempDir("reeve-paths-home-");
  garbledAt(shared(home, "o", "-github"));
  const r = reeveIn(home)("replay", "o/-github");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /holds a decision record that can't be read, so whether it's o\/-github's .* can't be told/);
});

test("a store kept where names were made alike whose owner can't be told is refused, not taken for none, and init makes no other in its place", () => {
  for (const [name, make] of /** @type {const} */ ([["none", (/** @type {string} */ p) => storeAt(p, [])], ["unread", garbledAt]])) {
    const home = tempDir("reeve-paths-home-");
    make(shared(home, "o", "-github"));
    const status = storeStatus(home, "o/.github");
    assert.equal(status.state, "unusable", `${name}: ${JSON.stringify(status)}`);
    assert.match(String(/** @type {any} */ (status).why), /whether it's o\/\.github's can't be told: move it to .*%2Egithub\.db by hand if it is/);
    const made = ensureStore(home, "o/.github");
    assert.equal(made.failed, true, JSON.stringify(made));
    assert.equal(existsSync(paths.statePathFor(home, "o/.github")), false, `${name}: no blank store made`);
    assert.match(reeveIn(home)("replay", "o/.github").stderr, /can't be told/);
  }
  // One that's only the other's is the other's: this one's store is missing, as it is.
  const theirs = tempDir("reeve-paths-home-");
  storeAt(shared(theirs, "o", "-github"), ["o/-github"]);
  assert.equal(storeStatus(theirs, "o/.github").state, "missing");
});

test("a store holding both repositories' records is refused for each, saying it must be split by hand", () => {
  const home = tempDir("reeve-paths-home-");
  storeAt(shared(home, "o", "-github"), ["o/.github", "o/-github"]);
  const run = reeveIn(home);
  for (const nwo of ["o/.github", "o/-github"]) {
    const r = run("replay", nwo);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, nwo === "o/-github" ? /holds the decision records of o\/-github and of o\/\.github, .* neither can use it until it's split by hand/ : /holds the decision records of o\/\.github and of o\/-github/);
    assert.doesNotMatch(r.stderr, /Run reeve once for/);
  }
});

test("a store isn't moved from where names were made alike while a reeve runs on it there", () => {
  const home = tempDir("reeve-paths-home-");
  const was = storeAt(shared(home, "o", "-github"), ["o/.github"]);
  // An earlier reeve, running on it under its old name.
  const running = storeLock(was);
  assert.ok(!("why" in running), JSON.stringify(running));
  /** @type {any} */ let got;
  try { got = paths.adoptStore(home, "o/.github"); } catch (err) { got = { code: /** @type {any} */ (err).code, message: String(err) }; }
  finally { if (!("why" in running)) running.release(); }
  assert.equal(got?.code, "STORE_BUSY", JSON.stringify(got));
  assert.match(got.message, /a reeve is running on .*-github\.db/);
  assert.ok(existsSync(was), "not moved");
  assert.equal(paths.adoptStore(home, "o/.github"), paths.statePathFor(home, "o/.github"), "control: once it's stopped, moved");
});

test("this repository's dashboard left at the other's path is taken away whenever it's found there, though it couldn't be when the store moved", () => {
  const home = tempDir("reeve-paths-home-");
  storeAt(shared(home, "o", "-github"), ["o/.github"]);
  const dash = join(home, "dash", "o", "-github.html");
  mkdirSync(dirname(dash), { recursive: true });
  writeFileSync(dash, "<title>o/.github — fleet</title>");
  chmodSync(dirname(dash), 0o500);
  /** @type {any} */ let moved;
  try { moved = paths.adoptStore(home, "o/.github"); } catch (err) { moved = { threw: String(err) }; } finally { chmodSync(dirname(dash), 0o700); }
  assert.equal(moved, paths.statePathFor(home, "o/.github"), JSON.stringify(moved));
  assert.ok(existsSync(dash), "control: it couldn't be taken away then");
  paths.adoptStore(home, "o/.github");
  assert.equal(existsSync(dash), false, "taken away the next time");
  // Another's, at its own path, is left, by this one and by it.
  writeFileSync(dash, "<title>o/-github — fleet</title>");
  paths.adoptStore(home, "o/.github");
  assert.ok(existsSync(dash));
  storeAt(shared(home, "o", "-github"), ["o/-github"]);
  paths.adoptStore(home, "o/-github");
  assert.ok(existsSync(dash), "its own dashboard is at its own path");
});

test("a store at a repository's path that's another's is refused by init too", () => {
  const home = tempDir("reeve-paths-home-");
  storeAt(shared(home, "o", "-github"), ["o/.github"]);
  const status = storeStatus(home, "o/-github");
  assert.equal(status.state, "unusable", JSON.stringify(status));
  const made = ensureStore(home, "o/-github");
  assert.equal(made.failed, true, JSON.stringify(made));
  assert.match(String(made.line), /holds decision records of o\/\.github, not o\/-github/);
});

test("a store not moved yet from where names were made alike is backed up as the repository its records are of", () => {
  const home = tempDir("reeve-paths-");
  storeAt(shared(home, "o", "-github"), ["o/.github"]);
  storeAt(shared(home, "o2", "-x"), ["o2/-x"]);
  storeAt(shared(home, "o3", "-y"), ["o3/.y", "o3/-y"]);
  // Another repository's records, of a name a path never made this one's.
  storeAt(shared(home, "o4", "-z"), ["q/zzz"]);
  /** @type {any} */ let stores;
  try { stores = everyStore(home).map((s) => s.nwo).sort(); } catch (err) { stores = { threw: String(err) }; }
  assert.deepEqual(stores, ["o/.github", "o2/-x", "o3/-y", "o4/-z"]);
});
