// Stores and dashboards of repositories whose names a path made alike, kept apart
// (#310): `.github` and `-github` were both `-github` on disk, and shared one
// store and one dashboard, each writing into the other's.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import * as paths from "../src/paths.mjs";
import { everyStore } from "../src/backup.mjs";
import { storeStatus, ensureStore } from "../src/init.mjs";
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
