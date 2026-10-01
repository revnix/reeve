// Backups of repositories whose names made one folder name (#319).
//
// Snapshots were kept in a folder named by writing the owner and name as one
// name, `/` and every unsafe character made `-`, so `a-b/c` and `a/b-c` shared
// `backups/a-b-c/`: one's snapshots counted against the other's number to
// keep, and restore took the newest there, whoever's it was. Each repository
// now keeps its snapshots in a folder of its own, named one-to-one as its store
// is; a snapshot kept in a shared folder before is found only for the
// repository whose records it holds; and restore refuses another's.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as backup from "../src/backup.mjs";
import { open } from "../src/db/ops.mjs";
import { statePathFor } from "../src/paths.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = fileURLToPath(new URL("../bin/reeve", import.meta.url));
const T = 1_800_000_000;
const HEAD = "a".repeat(40);
/** A store whose decision records are `repo`'s, or one with none. @param {string | null} repo */
function storeOf(repo) {
  const db = open(join(tempDir("reeve-bk-"), "s.db"));
  if (repo) db.prepare("INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
    .run(`${repo}#1@${HEAD}`, 1, HEAD, JSON.stringify({ subject: { repo, pr: 1, head: HEAD } }), T, T, 1, 1);
  return db;
}
const snapshots = (/** @type {string} */ dir) => readdirSync(dir).filter((f) => /^\d+\.db$/.test(f)).sort();

test("repositories whose names made one folder name keep their snapshots apart, each kept to its own number", () => {
  const root = tempDir("reeve-bk-root-");
  const ab = storeOf("a-b/c"), ba = storeOf("a/b-c");
  for (let k = 0; k < 3; k++) {
    backup.snapshot(ab, root, "a-b/c", T + k * 10, { keep: 2 });
    backup.snapshot(ba, root, "a/b-c", T + k * 10 + 5, { keep: 2 });
  }
  ab.close(); ba.close();
  const mine = backup.latestSnapshot(root, "a-b/c"), theirs = backup.latestSnapshot(root, "a/b-c");
  assert.equal(mine, join(root, "repos", "a-b", "c", `${T + 20}.db`), "a-b/c's newest is its own: " + mine);
  assert.equal(theirs, join(root, "repos", "a", "b-c", `${T + 25}.db`));
  assert.deepEqual(snapshots(dirname(String(mine))), [`${T + 10}.db`, `${T + 20}.db`], "each keeps its own two");
  assert.deepEqual(snapshots(dirname(String(theirs))), [`${T + 15}.db`, `${T + 25}.db`]);
  // The hub's are where they were.
  assert.equal(backup.snapshotCandidates(root, "hub").length, 0);
  // The backup run over every store keeps each one's number in its own folder too.
  const home = tempDir("reeve-bk-home-");
  for (const nwo of ["a-b/c", "a/b-c"]) {
    const p = statePathFor(home, nwo);
    mkdirSync(dirname(p), { recursive: true });
    open(p).close();
  }
  for (const at of [T, T + 10]) backup.snapshotAll(home, join(home, "backups"), { at, keep: 1 });
  assert.deepEqual(snapshots(join(home, "backups", "repos", "a-b", "c")), [`${T + 10}.db`]);
  assert.deepEqual(snapshots(join(home, "backups", "repos", "a", "b-c")), [`${T + 10}.db`]);
});

test("a snapshot kept in a shared folder before is found for the repository whose records it holds, and never for another", () => {
  const root = tempDir("reeve-bk-root-");
  const shared = join(root, "a-b-c");
  mkdirSync(shared, { recursive: true });
  // As an earlier reeve kept them: both repositories' snapshots in one folder,
  // the newest holding no record, so whose it is can't be told.
  const kept = (/** @type {string | null} */ repo, /** @type {number} */ at) => {
    const db = storeOf(repo);
    db.exec(`VACUUM INTO '${join(shared, `${at}.db`)}'`);
    db.close();
  };
  kept("a-b/c", T); kept("a/b-c", T + 10); kept(null, T + 20);
  assert.equal(backup.latestSnapshot(root, "a-b/c"), join(shared, `${T}.db`), "its own, not the newest there");
  assert.equal(backup.latestSnapshot(root, "a/b-c"), join(shared, `${T + 10}.db`));
  assert.deepEqual(backup.snapshotCandidates(root, "a-b/c"), [join(shared, `${T}.db`)], "nor counted as another's backup");
  // One taken since, in its own folder, comes first.
  const db = storeOf("a-b/c");
  const taken = backup.snapshot(db, root, "a-b/c", T + 30);
  db.close();
  assert.equal(backup.latestSnapshot(root, "a-b/c"), taken.path);
  // A repository whose name is safe as it is keeps the folder it had, now one of its own.
  const solo = storeOf("o/r");
  backup.snapshot(solo, root, "o/r", T, { keep: 2 });
  solo.close();
  assert.equal(backup.latestSnapshot(root, "o/r"), join(root, "repos", "o", "r", `${T}.db`));
});

test("a snapshot whose decision records are another repository's isn't restored, nor are its audits put back", () => {
  const root = tempDir("reeve-bk-root-");
  const db = storeOf("a/b-c");
  const theirs = String(backup.snapshot(db, root, "a/b-c", T).path);
  db.close();
  const target = join(tempDir("reeve-bk-state-"), "s.db");
  /** @type {any} */ let r;
  try { r = backup.restore(theirs, target, { nwo: "a-b/c", isDaemonRunning: () => null }); } catch (err) { r = { threw: String(err) }; }
  assert.equal(r.ok, false, "another's snapshot is refused: " + JSON.stringify(r));
  assert.match(r.why, /holds decision records of a\/b-c, not a-b\/c/);
  assert.equal(existsSync(target), false);
  const audits = backup.restoreAudits(theirs, join(tempDir("reeve-bk-audits-"), "a"), "a-b/c", { notes: join(tempDir("reeve-bk-notes-"), "n") });
  assert.equal(audits.ok, false);
  assert.match(String(audits.why), /holds decision records of a\/b-c, not a-b\/c/);
  // Control: its own restores.
  const own = backup.restore(theirs, join(tempDir("reeve-bk-state-"), "s.db"), { nwo: "a/b-c", isDaemonRunning: () => null });
  assert.equal(own.ok, true, own.why);
});

test("reeve restore refuses another repository's snapshot before it puts anything back", () => {
  const home = tempDir("reeve-bk-home-");
  const db = storeOf("a/b-c");
  const theirs = String(backup.snapshot(db, join(home, "backups"), "a/b-c", T).path);
  db.close();
  const target = join(home, "restored.db");
  const r = spawnSync(process.execPath, [REEVE, "restore", "a-b/c", "--from", theirs, "--db", target], { encoding: "utf8", cwd: home,
    env: { ...offlineEnv(), REEVE_HOME: home }, timeout: 60_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /refused: .*holds decision records of a\/b-c, not a-b\/c/);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(home, "audits")), false, "nothing put back");
});
