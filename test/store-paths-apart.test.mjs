// Stores and dashboards of repositories whose names a path made alike, kept apart
// (#310): `.github` and `-github` were both `-github` on disk, and shared one
// store and one dashboard, each writing into the other's.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import * as paths from "../src/paths.mjs";
import { everyStore, snapshotAll } from "../src/backup.mjs";
import { storeStatus, ensureStore } from "../src/init.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");

/** A store at `path`. */
function storeAt(/** @type {string} */ path) {
  mkdirSync(dirname(path), { recursive: true });
  open(path).close();
  return path;
}
/** Where a store was kept before #310: the owner and name made safe for the path, `.github` as `-github`. */
const shared = (/** @type {string} */ home, /** @type {string} */ owner, /** @type {string} */ name) => join(home, "state", owner, `${name}.db`);
/** reeve, run with `home` as its home, in `cwd`, and a gh that answers nothing. */
function reeveIn(/** @type {string} */ home, cwd = process.cwd()) {
  const bin = tempDir("reeve-paths-gh-");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho \"not a read this test answers: $*\" >&2\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  return (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [REEVE, ...args], { encoding: "utf8", cwd, env: { ...offlineEnv(), PATH: `${bin}:${offlineEnv().PATH}`, REEVE_HOME: home } });
}

test("repositories whose names a path made alike get stores and dashboards of their own, neither the one they shared, and every other keeps its path", () => {
  const home = "/h";
  const [dot, dash] = [paths.statePathFor(home, "o/.github"), paths.statePathFor(home, "o/-github")];
  assert.notEqual(dot, dash);
  assert.notEqual(paths.dashPathFor(home, "o/.github"), paths.dashPathFor(home, "o/-github"));
  for (const p of [dot, dash]) assert.notEqual(p, "/h/state/o/-github.db", `not the path they shared: ${p}`);
  assert.notEqual(paths.dashPathFor(home, "o/-github"), "/h/dash/o/-github.html");
  assert.notEqual(paths.statePathFor(home, "o/..x"), paths.statePathFor(home, "o/-x"));
  // Every name a path keeps as it is stays where it was.
  assert.equal(paths.statePathFor(home, "nextlyhq/nextly"), "/h/state/nextlyhq/nextly.db");
  assert.equal(paths.statePathFor(home, "o/my.repo_2-x"), "/h/state/o/my.repo_2-x.db");
  assert.equal(paths.statePathFor(home, "o/_x"), "/h/state/o/_x.db");
  assert.equal(paths.dashPathFor(home, "nextlyhq/nextly"), "/h/dash/nextlyhq/nextly.html");
  // And none walks out of the folder.
  for (const nwo of ["o/..", "o/.", "../x/y", "o/a%2Fb", "o/-"]) {
    const p = paths.statePathFor(home, nwo);
    assert.ok(!relative("/h/state", p).startsWith(".."), p);
    assert.equal(relative("/h/state", p).split("/").length, 2, `one owner's folder and one file: ${p}`);
  }
  assert.notEqual(paths.statePathFor(home, "o/a%2Eb"), paths.statePathFor(home, "o/a.b"), "a name with a % in it is coded too");
  assert.notEqual(paths.statePathFor(home, "o/%2Dx"), paths.statePathFor(home, "o/-x"), "nor is a coded name another's");
});

test("each store is backed up as the repository its path names, the names a path codes read back", () => {
  const home = tempDir("reeve-paths-");
  for (const nwo of ["o/.github", "o/-github", "o/my.repo"]) storeAt(paths.statePathFor(home, nwo));
  // A file reeve didn't name, with a % that doesn't read as a code.
  storeAt(join(home, "state", "50%", "x.db"));
  /** @type {any} */ let stores;
  try { stores = everyStore(home).map((s) => s.nwo).sort(); } catch (err) { stores = { threw: String(err) }; }
  assert.deepEqual(stores, ["50%/x", "o/-github", "o/.github", "o/my.repo"]);
});

test("a store an earlier reeve kept where names a path made alike shared one is named, never taken, for each name it may be, and init makes none in its place", () => {
  const home = tempDir("reeve-paths-home-");
  const was = storeAt(shared(home, "o", "-github"));
  for (const nwo of ["o/.github", "o/-github"]) {
    const found = paths.storeLookup(home, nwo);
    assert.match(String(found.refused), new RegExp(`an earlier reeve kept a store at .*-github\\.db, .* so it may be ${nwo.replace(".", "\\.")}'s or another's\\. If it's .*, move it, with any -wal and -shm beside it, to .*${nwo.endsWith(".github") ? "%2Egithub" : "%2Dgithub"}\\.db`));
    assert.equal(storeStatus(home, nwo).state, "unusable");
    const made = ensureStore(home, nwo);
    assert.equal(made.failed, true, JSON.stringify(made));
    assert.equal(existsSync(paths.statePathFor(home, nwo)), false, `${nwo}: no blank store made`);
    /** @type {any} */ let adopted;
    try { adopted = paths.adoptStore(home, nwo); } catch (err) { adopted = { code: /** @type {any} */ (err).code }; }
    assert.equal(adopted.code, "STORE_REFUSED", JSON.stringify(adopted));
  }
  assert.ok(existsSync(was), "left where it was");
  // Moved by hand to the repository it's of, it's that one's, and the other's is missing, as it is.
  renameSync(was, paths.statePathFor(home, "o/.github"));
  assert.equal(paths.adoptStore(home, "o/.github"), paths.statePathFor(home, "o/.github"));
  assert.equal(storeStatus(home, "o/-github").state, "missing");
});

test("a store kept under the name alone, from before stores were kept by owner, is named, never taken, for a coded name, and moved as before for any other", () => {
  const home = tempDir("reeve-paths-home-");
  storeAt(join(home, "state", "-github.db"));
  assert.match(String(paths.storeLookup(home, "o/.github").refused), /an earlier reeve kept a store at .*state\/-github\.db/);
  assert.match(String(paths.storeLookup(home, "o/-github").refused), /an earlier reeve kept a store at .*state\/-github\.db/);
  const older = tempDir("reeve-paths-home-");
  storeAt(join(older, "state", "r.db"));
  assert.equal(paths.storeLookup(older, "o/r").refused, null);
  assert.deepEqual(storeStatus(older, "o/r"), { state: "legacy", path: paths.statePathFor(older, "o/r"), legacy: join(older, "state", "r.db") });
  assert.equal(paths.adoptStore(older, "o/r", { log: () => {} }), paths.statePathFor(older, "o/r"), "control: moved into place");
});

test("reeve refuses a store an earlier reeve kept where names a path made alike shared one, naming where to move it", () => {
  const home = tempDir("reeve-paths-home-");
  storeAt(shared(home, "o", "-github"));
  const r = reeveIn(home)("replay", "o/.github");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /reeve replay: an earlier reeve kept a store at .*-github\.db, .* move it, with any -wal and -shm beside it, to .*%2Egithub\.db/);
});

test("reeve init refuses such a store before planning anything, as --write couldn't put it right", () => {
  const home = tempDir("reeve-paths-home-");
  storeAt(shared(home, "o", "-github"));
  const repo = tempDir("reeve-paths-repo-");
  for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/o/.github.git"],
                      ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"]])
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const r = reeveIn(home, repo)("init");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /reeve init: the state database can't be used: an earlier reeve kept a store at .*-github\.db/);
  assert.doesNotMatch(r.stdout + r.stderr, /reeve init --write {3}to apply/);
});

test("a store an earlier reeve kept where names a path made alike shared one isn't backed up as any repository's, and the backup that skips it fails", () => {
  const home = tempDir("reeve-paths-home-");
  storeAt(shared(home, "o", "-github"));
  storeAt(paths.statePathFor(home, "o/r"));
  /** @type {any} */ let all;
  try { all = snapshotAll(home, join(home, "backups"), { at: 1000 }); } catch (err) { all = { threw: String(err) }; }
  const shared_ = all.find?.((/** @type {any} */ r) => /-github/.test(r.why ?? "") || r.nwo === "o/-github");
  assert.equal(shared_?.ok, false, JSON.stringify(all));
  assert.equal(shared_?.escalate, "builder:backup:failed");
  assert.match(String(shared_?.why), /-github\.db is a store an earlier reeve kept where names a path made alike shared one, so whose it is can't be told/);
  assert.ok(all.find((/** @type {any} */ r) => r.nwo === "o/r")?.ok, "control: the others are backed up");
  assert.equal(existsSync(join(home, "backups", "o--github")), false, "filed under no repository");
});
