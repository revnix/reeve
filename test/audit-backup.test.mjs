// A person's audits of the shadow trial kept with the store's backups (#311): each
// snapshot of a repository's store carries its audits in its own file, and a
// restore puts back those the audits folder is missing, as they were recorded.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, fsyncSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { open } from "../src/db/ops.mjs";
import * as backup from "../src/backup.mjs";
import * as trial from "../src/trial.mjs";
import { auditDirFor, auditNotesFor, statePathFor } from "../src/paths.mjs";
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
    trial.recordAudit(dir, made.audit, { notes: auditNotesFor(home, R) });
  }
  return { home, db, dir, notes: auditNotesFor(home, R), root: join(home, "backups") };
}
/** The audits in `dir`, by name, as their bytes read. */
const audits = (/** @type {string} */ dir) =>
  Object.fromEntries((existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".json")).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
/** The audits the snapshot at `path` carries, by name, as their text reads; null where it carries none. */
function carried(/** @type {string} */ path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trial_audit'").get()) return null;
    return Object.fromEntries(db.prepare("SELECT name, text FROM trial_audit ORDER BY name").all().map((r) => [r.name, r.text]));
  } finally { db.close(); }
}
/** A snapshot of `home`'s store of `R` at `at`, carrying its audits. */
const snap = (/** @type {any} */ h, at = 1000, keep = 5) => backup.snapshot(h.db, h.root, R, at, { keep, audits: { dir: h.dir, notes: h.notes } });

test("a snapshot of a repository's store carries its audits in its own file, as recorded", () => {
  const h = homeWith(2);
  const was = audits(h.dir);
  assert.deepEqual(Object.keys(was), ["000001.json", "000002.json"], "control: two recorded");
  const first = snap(h);
  h.db.close();
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual(carried(String(first.path)), was, "each as its file reads, in the snapshot itself");
  assert.deepEqual(readdirSync(dirname(String(first.path))), ["1000.db"], "and nothing beside it");
  assert.equal(backup.validateSnapshot(String(first.path), { kind: "repo", deep: true }).ok, true, "a store that restores");
});

test("a snapshot whose audits a report wouldn't read isn't taken, so it never pushes out one that holds them", () => {
  const h = homeWith(2);
  const kept = snap(h, 1000, 1);
  assert.ok(kept.ok, JSON.stringify(kept));
  const whole = readFileSync(join(h.dir, "000002.json"));
  // One that doesn't read whole.
  writeFileSync(join(h.dir, "000002.json"), "{not json");
  const broken = snap(h, 1001, 1);
  assert.equal(broken.ok, false, JSON.stringify(broken));
  assert.match(String(broken.why), /its audits couldn't be put in it whole, so it wasn't taken: the audit recorded in 000002\.json can't be read/);
  // The newest lost, as only the host's notes tell.
  rmSync(join(h.dir, "000002.json"));
  const lost = snap(h, 1002, 1);
  assert.equal(lost.ok, false, JSON.stringify(lost));
  assert.match(String(lost.why), /000002\.json, noted on the host as recorded, is missing/);
  assert.deepEqual(readdirSync(dirname(String(kept.path))), ["1000.db"], "the one that holds them is kept, though only one is");
  assert.deepEqual(Object.keys(carried(String(kept.path)) ?? {}), ["000001.json", "000002.json"]);
  writeFileSync(join(h.dir, "000002.json"), whole);
  assert.ok(snap(h, 1003, 1).ok, "control: put back, a snapshot is taken");
  h.db.close();
});

test("every store's snapshot carries its repository's audits, and one whose audits can't be read is a backup that failed, escalated, older ones kept", () => {
  const { home, db, dir, root } = homeWith(1);
  db.close();
  const all = backup.snapshotAll(home, root, { at: 2000 });
  const ours = all.find((r) => r.nwo === R);
  assert.ok(ours?.ok, JSON.stringify(all));
  assert.deepEqual(Object.keys(carried(String(ours?.path)) ?? {}), ["000001.json"]);
  // The audits folder can't be read: a file stands where it would be.
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "");
  const next = backup.snapshotAll(home, root, { at: 2001 }).find((r) => r.nwo === R);
  assert.equal(next?.ok, false, JSON.stringify(next));
  assert.equal(next?.escalate, "builder:backup:failed");
  assert.match(String(next?.why), /its audits couldn't be put in it whole, so it wasn't taken: .*ENOTDIR/);
  assert.deepEqual(readdirSync(join(root, "repos", "o", "r")), ["2000.db"], "nothing taken, and the one before kept");
});

test("a restore puts back the audits a snapshot holds, as recorded, leaves those recorded since, and refuses where one there isn't the snapshot's", () => {
  const h = homeWith(2);
  const path = String(snap(h).path);
  h.db.close();
  const { dir } = h;
  const was = audits(dir);
  rmSync(dir, { recursive: true });
  const put = backup.restoreAudits(path, dir, R);
  assert.deepEqual(put, { ok: true, put: 2 });
  assert.deepEqual(audits(dir), was, "byte for byte as recorded");
  assert.equal(trial.readAudits(dir, R, { notes: h.notes }).ok, true, "and as the host noted them");
  assert.deepEqual(backup.restoreAudits(path, dir, R), { ok: true, put: 0 }, "those there already are left");
  // One recorded since the snapshot is left as it is.
  writeFileSync(join(dir, "000003.json"), was["000001.json"]);
  rmSync(join(dir, "000002.json"));
  assert.deepEqual(backup.restoreAudits(path, dir, R), { ok: true, put: 1 });
  assert.deepEqual(Object.keys(audits(dir)), ["000001.json", "000002.json", "000003.json"]);
  // One there that isn't the snapshot's: refused, and nothing put back.
  rmSync(join(dir, "000002.json"));
  writeFileSync(join(dir, "000001.json"), was["000002.json"]);
  const refused = backup.restoreAudits(path, dir, R);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(String(/** @type {any} */ (refused).why), /000001\.json in .* isn't the audit the snapshot holds under that number/);
  assert.equal(existsSync(join(dir, "000002.json")), false, "nothing put back");
  // The folder can't be read: a file stands where it would be.
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "");
  assert.match(JSON.stringify(backup.restoreAudits(path, dir, R)), /000001\.json in .* can't be read: ENOTDIR/);
  // Nor written.
  rmSync(dir);
  mkdirSync(dir, { mode: 0o500 });
  /** @type {any} */ let got;
  try { got = backup.restoreAudits(path, dir, R); } catch (err) { got = { threw: String(err) }; } finally { chmodSync(dir, 0o700); }
  assert.match(JSON.stringify(got), /the audits couldn't be put back in .*: EACCES/);
});

test("a restore from a snapshot that wouldn't restore puts back none of the audits it carries", () => {
  const h = homeWith(2);
  const path = String(snap(h).path);
  h.db.close();
  // Its store broken, the audits it carries still there to read.
  const t = new DatabaseSync(path);
  t.exec("DROP TABLE event");
  t.close();
  assert.equal(backup.validateSnapshot(path, { kind: "repo" }).ok, false, "control: it wouldn't restore");
  rmSync(h.dir, { recursive: true });
  /** @type {any} */ let got;
  try { got = backup.restoreAudits(path, h.dir, R); } catch (err) { got = { threw: String(err) }; }
  assert.equal(got.ok, false, JSON.stringify(got));
  assert.match(String(got.why), /the snapshot is not a usable store/);
  assert.equal(existsSync(h.dir), false, "nothing put back");
});

test("a store restored from a snapshot doesn't keep the audits it carried", () => {
  const h = homeWith(1);
  const path = String(snap(h).path);
  h.db.close();
  const to = join(tempDir("reeve-audit-restore-"), "r.db");
  const r = backup.restore(path, to, { isDaemonRunning: () => null });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(carried(path), "control: the snapshot carries them");
  assert.equal(carried(to), null, "the store doesn't");
});

test("audits put back are synced, each file before it's linked into place, and their folders after, those there already too", () => {
  const h = homeWith(2);
  const path = String(snap(h).path);
  h.db.close();
  const { home, dir } = h;
  rmSync(join(home, "audits"), { recursive: true });
  /** @type {string[]} */ let done = [];
  const copy = { repo: R, audits: Object.entries(carried(path) ?? {}).map(([name, text]) => ({ name, text })) };
  const io = {
    fsync: (/** @type {number} */ fd) => { done.push(`file ${readdirSync(dir).filter((f) => f.endsWith(".json")).length}`); fsyncSync(fd); },
    syncDir: (/** @type {string} */ d) => { done.push(`folder ${d.slice(home.length)}`); } };
  assert.deepEqual(trial.putBackAudits(copy, path, dir, R, io), { ok: true, put: 2 });
  assert.deepEqual(done, ["file 0", "file 1", "folder /audits/o/r", "folder /audits/o", "folder /audits", "folder "]);
  // Put back again, nothing missing: its folder is synced again, as a sync that failed before leaves it unsure.
  done = [];
  assert.deepEqual(trial.putBackAudits(copy, path, dir, R, io), { ok: true, put: 0 });
  assert.deepEqual(done, ["folder /audits/o/r"]);
  // A folder that can't be synced: they're put back, and it says so.
  rmSync(dir, { recursive: true });
  /** @type {any} */ let unsynced;
  try { unsynced = trial.putBackAudits(copy, path, dir, R, { syncDir: () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } }); }
  catch (err) { unsynced = { threw: String(err) }; }
  assert.equal(unsynced.put, 2);
  assert.match(String(unsynced.unsynced), /EIO/);
});

test("a snapshot taken before audits were kept with snapshots restores none, and leaves the audits as they are", () => {
  const h = homeWith(1);
  const path = String(backup.snapshot(h.db, h.root, R, 1000, { keep: 5 }).path);
  h.db.close();
  assert.equal(carried(path), null, "control: it carries none");
  const was = audits(h.dir);
  /** @type {any} */ let got;
  try { got = backup.restoreAudits(path, h.dir, R); } catch (err) { got = { threw: String(err) }; }
  assert.deepEqual(got, { ok: true, put: 0, none: true });
  assert.deepEqual(audits(h.dir), was);
  // And its store restores as it did.
  const to = join(tempDir("reeve-audit-restore-"), "r.db");
  assert.deepEqual(backup.restore(path, to, { isDaemonRunning: () => null }), { ok: true, why: null });
});

test("a copy of the audits that isn't one, is another repository's, or misses one, puts none of them back", () => {
  const h = homeWith(2);
  const path = String(snap(h).path);
  h.db.close();
  const copy = { repo: R, audits: Object.entries(carried(path) ?? {}).map(([name, text]) => ({ name, text })) };
  rmSync(h.dir, { recursive: true });
  const put = (/** @type {unknown} */ c) => { try { return trial.putBackAudits(c, path, h.dir, R); } catch (err) { return { threw: String(err) }; } };
  assert.match(JSON.stringify(put([])), /the copy of the audits in .* can't be read/);
  assert.match(JSON.stringify(put({ ...copy, repo: "x/y" })), /the copy of the audits in .* is of x\/y, not o\/r/);
  assert.match(JSON.stringify(put({ ...copy, audits: [copy.audits[1]] })), /000001\.json is missing from the copy of the audits in/);
  // Each as a report reads it: changed in the snapshot since, none goes back.
  const [one, two] = copy.audits;
  assert.match(JSON.stringify(put({ ...copy, audits: [{ ...one, text: "{not json" }, two] })), /in the copy of the audits in .*, the audit recorded in 000001\.json can't be read/);
  const other = JSON.stringify({ ...JSON.parse(one.text), repo: "x/y" });
  assert.match(JSON.stringify(put({ ...copy, audits: [{ ...one, text: other }, two] })), /000001\.json is of x\/y, not o\/r/);
  const twice = JSON.parse(one.text);
  twice.calls.push(twice.calls[0]);
  assert.match(JSON.stringify(put({ ...copy, audits: [{ ...one, text: JSON.stringify(twice) }, two] })), /000001\.json marks call \S+ twice/);
  assert.equal(existsSync(h.dir), false, "nothing put back");
  // A snapshot carrying another repository's.
  const t = new DatabaseSync(path);
  t.exec("UPDATE trial_audit SET repo = 'x/y'");
  t.close();
  assert.match(JSON.stringify(backup.restoreAudits(path, h.dir, R)), /is of x\/y, not o\/r/);
  assert.equal(existsSync(h.dir), false, "nothing put back");
  assert.deepEqual(put(copy), { ok: true, put: 2 }, "control: the copy as it was taken puts them back");
});

test("reeve backup takes the audits with the store, and reeve restore puts back those missing before the store, and says so", () => {
  const { home, db, dir } = homeWith(2);
  db.close();
  const bin = tempDir("reeve-audit-gh-");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho \"not a read this test answers: $*\" >&2\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const env = { ...offlineEnv(), PATH: `${bin}:${offlineEnv().PATH}`, REEVE_HOME: home };
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [REEVE, ...args], { encoding: "utf8", env });
  const taken = run("backup", R);
  assert.equal(taken.status, 0, taken.stdout + taken.stderr);
  const path = String(/snapshot -> (\S+)/.exec(taken.stdout)?.[1]);
  assert.deepEqual(Object.keys(carried(path) ?? {}), ["000001.json", "000002.json"], `the audits in ${path}`);
  const was = audits(dir);
  rmSync(dir, { recursive: true });
  rmSync(auditNotesFor(home, R), { recursive: true });
  // The store is there: it isn't replaced without --overwrite, but the audits it lost are put back, and noted again.
  const kept = run("restore", R, "--from", path, "--force");
  assert.equal(kept.status, 1, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /put back 2 audit\(s\) of o\/r from .*\.db/);
  assert.match(kept.stdout, /refused: .* exists; pass overwrite/);
  assert.deepEqual(audits(dir), was);
  assert.deepEqual(existsSync(auditNotesFor(home, R)) ? readdirSync(auditNotesFor(home, R)).sort() : [], ["000001.sha256", "000002.sha256"]);
  // Restored to a store that's gone, with one audit there that isn't the snapshot's: nothing is restored.
  writeFileSync(join(dir, "000001.json"), was["000002.json"]);
  const fresh = join(tempDir("reeve-audit-restore-"), "r.db");
  const refused = run("restore", R, "--from", path, "--db", fresh, "--force");
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /refused: 000001\.json in .* isn't the audit the snapshot holds under that number/);
  assert.equal(existsSync(fresh), false, "and the store isn't restored either");
  writeFileSync(join(dir, "000001.json"), was["000001.json"]);
  const done = run("restore", R, "--from", path, "--db", fresh, "--force");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /restored .*\.db -> .*r\.db/);
  // A backup whose audits can't be read takes nothing, and fails.
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "");
  const failed = run("backup", R);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /failed: its audits couldn't be put in it whole, so it wasn't taken: .*ENOTDIR/);
});

// ── #317's second review ─────────────────────────────────────────────────────

test("a snapshot carries the audits recorded before its store was copied, so every judgment they cover is in it", () => {
  const h = homeWith(1);
  const r = trial.trialReport(h.db, { repo: R, since: T0, now: T0 + 10 * MIN, merged: [] });
  // An audit recorded while the store is copied.
  const during = { exec: (/** @type {string} */ sql) => {
    if (/^VACUUM INTO/.test(sql)) {
      const made = /** @type {any} */ (trial.auditOf(r.toAudit, new Map(r.toAudit.map((c) => [c.id, { right: true, note: "" }])), { repo: R, by: "B", at: T0 + 9, judgment: r.judgment }));
      trial.recordAudit(h.dir, made.audit, { notes: h.notes });
    }
    return h.db.exec(sql);
  } };
  const taken = backup.snapshot(during, h.root, R, 1000, { keep: 5, audits: { dir: h.dir, notes: h.notes } });
  h.db.close();
  assert.ok(taken.ok, JSON.stringify(taken));
  assert.deepEqual(Object.keys(audits(h.dir)), ["000001.json", "000002.json"], "control: the second recorded while it was copied");
  assert.deepEqual(Object.keys(carried(String(taken.path)) ?? {}), ["000001.json"]);
});

test("a restore notes each audit it puts back where the host lost its notes, and refuses one that isn't as the host noted it", () => {
  const h = homeWith(2);
  const path = String(snap(h).path);
  h.db.close();
  // The host lost its audits and its notes of them.
  rmSync(h.dir, { recursive: true });
  rmSync(h.notes, { recursive: true });
  /** @type {any} */ let put;
  try { put = backup.restoreAudits(path, h.dir, R, { notes: h.notes }); } catch (err) { put = { threw: String(err) }; }
  assert.deepEqual(put, { ok: true, put: 2 });
  assert.deepEqual(existsSync(h.notes) ? readdirSync(h.notes).sort() : [], ["000001.sha256", "000002.sha256"], "noted again");
  rmSync(join(h.dir, "000002.json"));
  assert.match(JSON.stringify(trial.readAudits(h.dir, R, { notes: h.notes })), /000002\.json, noted on the host as recorded, is missing/, "so the newest lost is told again");
  // A note that isn't the snapshot's: which was recorded can't be told.
  writeFileSync(join(h.notes, "000002.sha256"), "0".repeat(64) + "\n");
  /** @type {any} */ let refused;
  try { refused = backup.restoreAudits(path, h.dir, R, { notes: h.notes }); } catch (err) { refused = { threw: String(err) }; }
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(String(refused.why), /000002\.json in the copy of the audits in .* isn't the audit the host noted under that number/);
  assert.equal(existsSync(join(h.dir, "000002.json")), false, "nothing put back");
  // Notes that can't be read: none is put back.
  rmSync(h.notes, { recursive: true });
  writeFileSync(h.notes, "");
  /** @type {any} */ let unread;
  try { unread = backup.restoreAudits(path, h.dir, R, { notes: h.notes }); } catch (err) { unread = { threw: String(err) }; }
  assert.match(String(unread.why), /the host's notes of the audits recorded, in .*, can't be read: ENOTDIR, so none is put back/);
  assert.equal(existsSync(join(h.dir, "000002.json")), false, "nothing put back");
  // Notes that can't be made: put back, and said.
  rmSync(h.notes);
  mkdirSync(h.notes, { mode: 0o500 });
  /** @type {any} */ let unnoted;
  try { unnoted = backup.restoreAudits(path, h.dir, R, { notes: h.notes }); } catch (err) { unnoted = { threw: String(err) }; } finally { chmodSync(h.notes, 0o700); }
  assert.equal(unnoted.put, 1, JSON.stringify(unnoted));
  assert.match(String(unnoted.unnoted), /EACCES/);
});

// ── the audits put in a snapshot ─────────────────────────────────────────────

test("a snapshot whose audits can't be put in it isn't taken, and leaves nothing behind", () => {
  const h = homeWith(1);
  /** @type {any} */ let taken;
  try { taken = backup.snapshot(h.db, h.root, R, 1000, { keep: 5, audits: { dir: h.dir, notes: h.notes }, carry: () => "disk full" }); }
  catch (err) { taken = { threw: String(err) }; }
  h.db.close();
  assert.equal(taken.ok, false, JSON.stringify(taken));
  assert.match(String(taken.why), /its audits couldn't be put in it whole, so it wasn't taken: disk full/);
  assert.deepEqual(readdirSync(join(h.root, "repos", "o", "r")), [], "no snapshot, and no file of its own left");
});
