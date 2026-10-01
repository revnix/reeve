// A person's audits of the shadow trial kept with the store's backups (#311): each
// snapshot of a repository's store takes a copy of its audits beside it, and a
// restore puts back those the audits folder is missing, as they were recorded.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, fsyncSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import * as backup from "../src/backup.mjs";
import * as trial from "../src/trial.mjs";
import { auditDirFor, statePathFor } from "../src/paths.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
const T0 = 1_900_000_000, MIN = 60, R = "o/r";
const sha = (/** @type {string} */ c) => c.repeat(40);

/** A home whose store of `R` holds two calls, and `n` audits of them recorded. */
function homeWith(n = 2) {
  const home = tempDir("reeve-audit-backup-");
  const path = statePathFor(home, R);
  mkdirSync(dirname(path), { recursive: true });
  const db = open(path);
  const put = (/** @type {number} */ at, /** @type {string} */ op, /** @type {string | null} */ subject, payload = {}) =>
    db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(at, "daemon", op, subject, JSON.stringify(payload));
  put(T0, "daemon.tick", null);
  put(T0 + MIN, "pr.decided", "pr:5", { head: sha("a"), state: "PASS", summary: "", why: "", clauses: [] });
  put(T0 + 2 * MIN, "pr.decided", "pr:6", { head: sha("b"), state: "BLOCK", summary: "ci blocked", why: "failing: unit", clauses: [] });
  const r = trial.trialReport(db, { repo: R, since: T0, now: T0 + 10 * MIN, merged: [] });
  const dir = auditDirFor(home, R);
  for (let i = 0; i < n; i++) {
    const made = /** @type {any} */ (trial.auditOf(r.toAudit, new Map(r.toAudit.map((c) => [c.id, { right: i % 2 === 0, note: "" }])),
                                                   { repo: R, by: "A. Person", at: T0 + i, judgment: r.judgment }));
    assert.ok(made.ok, JSON.stringify(made));
    trial.recordAudit(dir, made.audit);
  }
  return { home, db, dir, root: join(home, "backups") };
}
/** The audits in `dir`, by name, as their bytes read. */
const audits = (/** @type {string} */ dir) =>
  Object.fromEntries((existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".json")).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
/** The copy of the audits beside the snapshot at `path`. */
const copyOf = (/** @type {string} */ path) => path.replace(/\.db$/, ".audits.json");

test("a snapshot of a repository's store takes a copy of its audits beside it, as recorded, and pruning takes the copy with its store", () => {
  const { db, dir, root } = homeWith(2);
  const was = audits(dir);
  assert.deepEqual(Object.keys(was), ["000001.json", "000002.json"], "control: two recorded");
  const first = backup.snapshot(db, root, R, 1000, { keep: 2, audits: dir });
  assert.ok(first.ok, JSON.stringify(first));
  assert.ok(existsSync(copyOf(String(first.path))), "a copy beside it");
  assert.deepEqual(JSON.parse(readFileSync(copyOf(String(first.path)), "utf8")),
                   { repo: R, audits: Object.entries(was).map(([name, text]) => ({ name, text })) });
  // A copy another process published this second, its store's snapshot not yet beside it, is that one's.
  writeFileSync(join(dirname(String(first.path)), "1001.audits.json"), "theirs");
  // A copy left by a snapshot that stopped before its store was published, older than any kept,
  // and one a process that's gone was writing.
  writeFileSync(join(dirname(String(first.path)), "999.audits.json"), "{}");
  writeFileSync(join(dirname(String(first.path)), ".999.999999.audits.tmp"), "{}");
  const second = backup.snapshot(db, root, R, 1001, { keep: 2, audits: dir });
  assert.equal(second.auditsWhy, null, JSON.stringify(second));
  assert.equal(readFileSync(copyOf(String(second.path)), "utf8"), "theirs");
  backup.snapshot(db, root, R, 1002, { keep: 2, audits: dir });
  db.close();
  assert.deepEqual(readdirSync(dirname(String(first.path))).sort(), ["1001.audits.json", "1001.db", "1002.audits.json", "1002.db"]);
});

test("every store's snapshot takes its repository's audits, and one whose audits can't be read is a backup that failed, its store's snapshot kept", () => {
  const { home, db, dir, root } = homeWith(1);
  db.close();
  const all = backup.snapshotAll(home, root, { at: 2000 });
  const ours = all.find((r) => r.nwo === R);
  assert.ok(ours?.ok, JSON.stringify(all));
  assert.deepEqual(JSON.parse(readFileSync(copyOf(String(ours?.path)), "utf8")).audits.map((/** @type {any} */ a) => a.name), ["000001.json"]);
  // The audits folder can't be read: a file stands where it would be.
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "");
  const next = backup.snapshotAll(home, root, { at: 2001 }).find((r) => r.nwo === R);
  assert.equal(next?.ok, false, JSON.stringify(next));
  assert.equal(next?.escalate, "builder:backup:failed");
  assert.match(String(next?.why), /the store's snapshot was taken, but its audits couldn't be copied beside it: .*ENOTDIR/);
  assert.ok(existsSync(join(root, "o-r", "2001.db")), "the store's snapshot is kept");
  assert.equal(existsSync(join(root, "o-r", "2001.audits.json")), false);
});

test("a restore puts back the audits a snapshot holds, as recorded, leaves those recorded since, and refuses where one there isn't the snapshot's", () => {
  const { db, dir, root } = homeWith(2);
  const snap = String(backup.snapshot(db, root, R, 1000, { keep: 5, audits: dir }).path);
  db.close();
  const was = audits(dir);
  rmSync(dir, { recursive: true });
  const put = backup.restoreAudits(snap, dir, R);
  assert.deepEqual(put, { ok: true, put: 2 });
  assert.deepEqual(audits(dir), was, "byte for byte as recorded");
  assert.deepEqual(trial.readAudits(dir, R), { ok: true, audits: Object.values(was).map((t, i) => ({ ...JSON.parse(t), seq: i + 1 })) });
  assert.deepEqual(backup.restoreAudits(snap, dir, R), { ok: true, put: 0 }, "those there already are left");
  // One recorded since the snapshot is left as it is.
  writeFileSync(join(dir, "000003.json"), was["000001.json"]);
  rmSync(join(dir, "000002.json"));
  assert.deepEqual(backup.restoreAudits(snap, dir, R), { ok: true, put: 1 });
  assert.deepEqual(Object.keys(audits(dir)), ["000001.json", "000002.json", "000003.json"]);
  // One there that isn't the snapshot's: refused, and nothing put back.
  rmSync(join(dir, "000002.json"));
  writeFileSync(join(dir, "000001.json"), was["000002.json"]);
  const refused = backup.restoreAudits(snap, dir, R);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(String(/** @type {any} */ (refused).why), /000001\.json in .* isn't the audit the snapshot holds under that number/);
  assert.equal(existsSync(join(dir, "000002.json")), false, "nothing put back");
  // The folder can't be read: a file stands where it would be.
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "");
  assert.match(JSON.stringify(backup.restoreAudits(snap, dir, R)), /000001\.json in .* can't be read: ENOTDIR/);
  // Nor written.
  rmSync(dir);
  mkdirSync(dir, { mode: 0o500 });
  /** @type {any} */ let got;
  try { got = backup.restoreAudits(snap, dir, R); } catch (err) { got = { threw: String(err) }; } finally { chmodSync(dir, 0o700); }
  assert.match(JSON.stringify(got), /the audits couldn't be put back in .*: EACCES/);
});

test("audits put back are synced, each file before it's linked into place, and their folders after, to the one that held the first made", () => {
  const { home, db, dir, root } = homeWith(2);
  const snap = String(backup.snapshot(db, root, R, 1000, { keep: 5, audits: dir }).path);
  db.close();
  rmSync(join(home, "audits"), { recursive: true });
  /** @type {string[]} */ const done = [];
  const copy = JSON.parse(readFileSync(copyOf(snap), "utf8"));
  const put = trial.putBackAudits(copy, snap, dir, R, {
    fsync: (fd) => { done.push(`file ${readdirSync(dir).filter((f) => f.endsWith(".json")).length}`); fsyncSync(fd); },
    syncDir: (d) => { done.push(`folder ${d.slice(home.length)}`); } });
  assert.deepEqual(put, { ok: true, put: 2 });
  assert.deepEqual(done, ["file 0", "file 1", "folder /audits/o/r", "folder /audits/o", "folder /audits", "folder "]);
  // A folder that can't be synced: they're put back, and it says so.
  rmSync(dir, { recursive: true });
  /** @type {any} */ let unsynced;
  try { unsynced = trial.putBackAudits(copy, snap, dir, R, { syncDir: () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } }); }
  catch (err) { unsynced = { threw: String(err) }; }
  assert.equal(/** @type {any} */ (unsynced).put, 2);
  assert.match(String(/** @type {any} */ (unsynced).unsynced), /EIO/);
});

test("a snapshot taken before audits were kept with snapshots restores none, and leaves the audits as they are", () => {
  const { db, dir, root } = homeWith(1);
  const snap = String(backup.snapshot(db, root, R, 1000, { keep: 5 }).path);
  db.close();
  assert.equal(existsSync(copyOf(snap)), false, "control: no copy beside it");
  const was = audits(dir);
  assert.deepEqual(backup.restoreAudits(snap, dir, R), { ok: true, put: 0, none: true });
  assert.deepEqual(audits(dir), was);
});

test("a snapshot's copy of the audits that can't be read, is another repository's, or misses one, puts none of them back", () => {
  const { db, dir, root } = homeWith(2);
  const snap = String(backup.snapshot(db, root, R, 1000, { keep: 5, audits: dir }).path);
  db.close();
  const copy = JSON.parse(readFileSync(copyOf(snap), "utf8"));
  rmSync(dir, { recursive: true });
  const bad = (/** @type {string} */ text) => {
    writeFileSync(copyOf(snap), text);
    try { return backup.restoreAudits(snap, dir, R); } catch (err) { return { threw: String(err) }; }
  };
  assert.match(JSON.stringify(bad("{not json")), /the copy of the audits beside .* can't be read/);
  assert.match(JSON.stringify(bad("[]")), /the copy of the audits beside .* can't be read/, "JSON, but not a copy");
  assert.match(JSON.stringify(bad(JSON.stringify({ ...copy, repo: "x/y" }))), /the copy of the audits beside .* is of x\/y, not o\/r/);
  assert.match(JSON.stringify(bad(JSON.stringify({ ...copy, audits: [copy.audits[1]] }))), /000001\.json is missing from the copy of the audits beside/);
  assert.equal(existsSync(dir), false, "nothing put back");
  assert.deepEqual(bad(JSON.stringify(copy)), { ok: true, put: 2 }, "control: the copy as it was taken puts them back");
});

test("reeve backup takes a copy of the audits with the store, and reeve restore puts back those missing before the store, and says so", () => {
  const { home, db, dir } = homeWith(2);
  db.close();
  const bin = tempDir("reeve-audit-gh-");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho \"not a read this test answers: $*\" >&2\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const env = { ...offlineEnv(), PATH: `${bin}:${offlineEnv().PATH}`, REEVE_HOME: home };
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [REEVE, ...args], { encoding: "utf8", env });
  const taken = run("backup", R);
  assert.equal(taken.status, 0, taken.stdout + taken.stderr);
  const snap = String(/snapshot -> (\S+)/.exec(taken.stdout)?.[1]);
  assert.ok(existsSync(copyOf(snap)), `a copy beside ${snap}`);
  const was = audits(dir);
  rmSync(dir, { recursive: true });
  // The store is there: it isn't replaced without --overwrite, but the audits it lost are put back.
  const kept = run("restore", R, "--from", snap, "--force");
  assert.equal(kept.status, 1, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /put back 2 audit\(s\) of o\/r from .*\.audits\.json/);
  assert.match(kept.stdout, /refused: .* exists; pass overwrite/);
  assert.deepEqual(audits(dir), was);
  // Restored to a store that's gone, with one audit there that isn't the snapshot's: nothing is restored.
  writeFileSync(join(dir, "000001.json"), was["000002.json"]);
  const fresh = join(tempDir("reeve-audit-restore-"), "r.db");
  const refused = run("restore", R, "--from", snap, "--db", fresh, "--force");
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /refused: 000001\.json in .* isn't the audit the snapshot holds under that number/);
  assert.equal(existsSync(fresh), false, "and the store isn't restored either");
  writeFileSync(join(dir, "000001.json"), was["000001.json"]);
  const done = run("restore", R, "--from", snap, "--db", fresh, "--force");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /restored .*\.db -> .*r\.db/);
  // A backup whose audits can't be read takes the store's snapshot, and fails.
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "");
  const failed = run("backup", R);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /snapshot -> .*\nfailed: the audits of o\/r couldn't be copied beside it: .*ENOTDIR/);
});
