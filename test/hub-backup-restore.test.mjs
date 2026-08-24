// everyStore walks state/<owner>/<repo>.db and skips non-directories. The hub
// is a FILE directly in state/, so before this change backup could not see it
// at all -- the same shape as the measured miss where reeve's own store had
// zero backups and the repo it watched had fourteen. A store that nothing
// reminds you about is exactly the one that is not backed up.
// `snapshot` itself, not only `snapshotAll`: the exclusive-publish assertions
// below call it twice at one timestamp, which is the only way to observe the
// winner/loser split from a single process.
import { snapshot, everyStore, snapshotAll, latestSnapshot, validateSnapshot } from "../src/backup.mjs";
import { open as openStore } from "../src/db/ops.mjs";      // builds the real guardian fixture
import { readFileSync } from "node:fs";                      // reads the durable tail back
import { openHub, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
import { hubPathFor } from "../src/paths.mjs";
import { DatabaseSync } from "node:sqlite";
// `statSync` reads the inode, which is what tells `link` and `rename` apart.
// `chmodSync` is the atomic-export drill's: a read-only destination directory
// is how a write failure is arranged where it cannot happen by accident.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";   // the CLI drill runs bin/reeve
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The repository root, from THIS FILE rather than from the working directory.
// `spawnSync(..., ["bin/reeve"])` below resolved against cwd, so the drill ran
// whatever `bin/reeve` the caller happened to be standing next to -- or none.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const home = mkdtempSync(join(tmpdir(), "reeve-home-"));
const root = join(home, "backups");
mkdirSync(join(home, "state", "nextlyhq"), { recursive: true });

// A REAL guardian store, created through the guardian's own open(), not an empty
// SQLite file: the repo validator requires the `event` table, so a bare file
// would be classified unusable, its snapshot deleted, and the retention
// assertions below would fail against a perfectly correct implementation.
openStore(join(home, "state", "nextlyhq", "nextly.db")).close();
openHub(hubPathFor(home)).close();

// ── discovery ────────────────────────────────────────────────────────────────
{
  const stores = everyStore(home);
  const hub = stores.find(s => s.kind === "hub");
  check(!!hub, "everyStore finds the hub", JSON.stringify(stores));
  check(hub?.nwo === "hub", "and labels it 'hub', not an owner/repo pair", String(hub?.nwo));
  check(hub?.path === hubPathFor(home), "at the one path hubPathFor derives", String(hub?.path));
  check(stores.some(s => s.nwo === "nextlyhq/nextly" && s.kind === "repo"),
    "control: the per-repo stores are still discovered", JSON.stringify(stores.map(s => s.nwo)));
  check(stores.filter(s => s.kind === "hub").length === 1, "and the hub appears exactly once");
}

// ── a snapshot is validated before it is trusted ─────────────────────────────
{
  const res = snapshotAll(home, root);
  const hubRes = res.find(r => r.nwo === "hub");
  check(hubRes?.ok === true, "the hub is snapshotted", JSON.stringify(hubRes));
  const snap = latestSnapshot(root, "hub");
  check(!!snap && existsSync(snap), "and the snapshot file exists", String(snap));

  const v = validateSnapshot(snap, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  check(v.ok === true, "a good snapshot validates", JSON.stringify(v));
  // The regression that would otherwise delete every guardian backup on the box.
  const repoSnap = latestSnapshot(root, "nextlyhq/nextly");
  check(validateSnapshot(repoSnap, { kind: "repo" }).ok === true,
    "a per-repository guardian snapshot validates against its OWN marker, not the hub's",
    JSON.stringify(validateSnapshot(repoSnap, { kind: "repo" })));
  check(res.find(r => r.nwo === "nextlyhq/nextly")?.ok === true,
    "and snapshotAll keeps it rather than deleting it as unusable");
  check(v.version === HUB_SCHEMA_VERSION, "and reports the schema version it holds", String(v.version));
  // DEEP, because this line asserts an integrity result and the cheap path does
  // not produce one -- it returns `integrity: null` by design, since skipping
  // the full page scan is the entire point of the split. Asserting it from a
  // cheap call fails against the correct implementation.
  const deepV = validateSnapshot(snap, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep: true });
  check(deepV.integrity === "ok", "and a DEEP validation reports its integrity_check result", String(deepV.integrity));
  check(v.integrity === null,
    "control: the cheap path deliberately reports no integrity at all, rather than a stale 'ok'",
    String(v.integrity));
}

// ── a snapshot at the wrong version is not restorable ────────────────────────
{
  const snap = latestSnapshot(root, "hub");
  const other = snap.replace(/(\d+)\.db$/, (_, n) => `${Number(n) - 1}.db`);
  const d = new DatabaseSync(snap);
  d.exec(`VACUUM INTO '${other.replace(/'/g, "''")}'`);
  d.close();
  const raw = new DatabaseSync(other);
  raw.exec("DELETE FROM schema_version");
  raw.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${HUB_SCHEMA_VERSION + 1}, unixepoch())`);
  raw.close();
  const v = validateSnapshot(other, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  check(v.ok === false, "a snapshot from a NEWER schema does not validate against this binary");
  check(String(v.why).includes(String(HUB_SCHEMA_VERSION + 1)), "and says which version it holds", String(v.why));
}

// ── a corrupt snapshot is deleted, not left looking usable ───────────────────
{
  const corruptDir = join(root, "hub");
  // Snapshot filenames are unix-epoch SECONDS and latestSnapshot sorts numerically
  // descending, so 999999.db (1970) is far OLDER than the good snapshot taken a
  // moment ago -- the assertion below would pass without anything ever being
  // deleted. The corrupt file has to be the newest candidate to be a test.
  const newest = Math.floor(Date.now() / 1000) + 60;
  const path = join(corruptDir, `${newest}.db`);
  writeFileSync(path, "this is not a database");
  // The control is a FILESYSTEM fact, deliberately, not a latestSnapshot() call.
  // Asserting `latestSnapshot(...) === path` here would contradict the assertion
  // below it in the same block with no code in between, so one of the two could
  // never be green -- and the read path is the very thing Step 3 changes.
  const candidates = readdirSync(corruptDir).filter(f => /^\d+\.db$/.test(f))
    .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
  check(candidates[0] === `${newest}.db`,
    "control: the corrupt file IS the newest candidate on disk, so skipping it is observable",
    JSON.stringify(candidates.slice(0, 3)));
  const v = validateSnapshot(path, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  check(v.ok === false, "a file that is not a database does not validate");
  // The deletion is snapshotAll's job, so the test has to RUN snapshotAll.
  // Calling validateSnapshot alone leaves the corrupt file in place and the
  // assertion below passes for the wrong reason -- it never exercised the
  // code that is supposed to remove it.
  // snapshotAll only validates the snapshot IT takes this second, so a corrupt
  // file planted at a future timestamp is never its candidate and is never
  // deleted. What actually protects a restore is the READ path: latestSnapshot
  // must not hand back a file that fails validation. Step 3 changes it to skip
  // candidates that do not validate instead of trusting the filename, which is
  // what these three assertions are about.
  // An invalid snapshot must not cost a retention slot. Before this change
  // `snapshot()` pruned on the way out, so each failed backup evicted the
  // oldest GOOD one and then deleted itself -- a run of failures erasing every
  // recovery point while each looked self-contained.
  {
    const hubDir = join(root, "hub");
    const kept = () => readdirSync(hubDir).filter(f => /^\d+\.db$/.test(f)).length;
    const goodBefore = kept();
    // Force a failing validation by snapshotting a hub that is not one.
    const notAHub = join(home, "state", "notahub.db");
    openStore(notAHub).close();                      // a REPO store, so hub validation fails
    const r = snapshotAll(home, root, { at: Math.floor(Date.now() / 1000) + 5, keep: 1,
                                        open: () => new DatabaseSync(notAHub) });
    check(r.some(x => x.nwo === "hub" && x.ok === false),
      "a hub snapshot that fails validation is reported as failed", JSON.stringify(r));
    check(kept() === goodBefore,
      "and costs no retention slot: the good snapshots that existed before it are all still there",
      `${goodBefore} -> ${kept()}`);
  }

  const before = latestSnapshot(root, "hub");
  check(before !== path,
    "latestSnapshot never returns a candidate that fails validation, whatever its timestamp",
    `returned ${before}`);
  check(validateSnapshot(path, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION }).ok === false,
    "control: the planted file really is invalid, so the assertion above is not vacuous");
  // and it falls THROUGH to a good one rather than giving up. Without this line
  // a `latestSnapshot` "fixed" by returning null whenever anything is wrong
  // passes the assertion above while making every restore impossible.
  check(before !== null && validateSnapshot(before, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION }).ok === true,
    "and it returns the newest snapshot that DOES validate, rather than null",
    String(before));
}

// ── `deep` is forwarded, and this pair is what proves it ─────────────────────
// Two calls, same directory, same newest file, two answers. A snapshot carrying
// an ORPHANED row passes every cheap check -- the markers are there and the
// table set is complete -- and fails only `foreign_key_check`, which is what the
// deep path adds. `integrity_check` reads such a file as `ok` (measured, SQLite
// 3.53.0, with a positive control), so it is invisible to everything except
// `deep`. On the broken implementation -- `deep` destructured in the signature
// and never placed into `opts`, which is what shipped once -- both calls return
// the orphan, the control stays green and the assertion below it goes red.
{
  const at = Math.floor(Date.now() / 1000) + 30;      // newer than the good snapshots, older than the junk at +60
  const good = latestSnapshot(root, "hub");
  const orphan = join(root, "hub", `${at}.db`);
  const src = new DatabaseSync(good, { readOnly: true });
  src.exec(`VACUUM INTO '${orphan.replace(/'/g, "''")}'`);
  src.close();
  const o = new DatabaseSync(orphan);
  // foreign_keys OFF is what lets the offending row exist at all: this is the
  // write the constraint is there to stop, planted so the validator has
  // something real to catch.
  o.exec("PRAGMA foreign_keys=OFF");
  o.exec("INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at) " +
         "VALUES('bt:nosuchtask',1,0,1,1,'h',unixepoch())");
  o.close();
  check(validateSnapshot(orphan, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION }).ok === true,
    "control: the orphaned snapshot PASSES cheap validation, so only `deep` can reject it");
  check(validateSnapshot(orphan, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep: true }).ok === false,
    "control: and deep validation DOES reject it, so the fixture can exhibit the defect");
  check(latestSnapshot(root, "hub", { deep: false }) === orphan,
    "control: it is the newest cheap-valid candidate, so a skip is observable",
    String(latestSnapshot(root, "hub", { deep: false })));
  const deepPick = latestSnapshot(root, "hub", { deep: true });
  check(deepPick !== orphan,
    "latestSnapshot forwards `deep` and skips a snapshot only foreign_key_check can reject",
    String(deepPick));
  check(deepPick !== null && deepPick !== orphan,
    "and falls THROUGH to an older snapshot rather than giving up, which is the fallback restore advertises",
    String(deepPick));
}

// ── two writers, one second: the publish is exclusive, not last-wins ─────────
// `mine` is only meaningful if the publish can actually be LOST. The inode is
// what discriminates the two implementations, and nothing else does: under
// `renameSync` the second writer's file replaces the first's, so the path
// survives, the bytes are valid, `validateSnapshot` passes, and every assertion
// that looks at content stays green while the first writer's snapshot is gone.
// Under `linkSync` the second writer gets EEXIST and the published inode cannot
// change. So: same path, same second, two calls, and the file must not move.
{
  const at = Math.floor(Date.now() / 1000) + 120;   // its own second, clear of every other fixture
  const db = openHub(hubPathFor(home));
  const first = snapshot(db, root, "hub", at, { keep: Infinity });
  check(first.ok === true && first.mine === true,
    "the first writer at a fresh timestamp publishes and owns the snapshot", JSON.stringify(first));
  const inoBefore = statSync(first.path).ino;
  const second = snapshot(db, root, "hub", at, { keep: Infinity });
  db.close();
  check(second.ok === true && second.mine === false,
    "a second writer at the SAME timestamp loses the publish rather than replacing it",
    JSON.stringify(second));
  check(second.path === first.path,
    "control: the loser still reports the canonical path, so callers need no special case",
    `${second.path} vs ${first.path}`);
  check(statSync(first.path).ino === inoBefore,
    "and the published file is the same inode afterwards: the loser did not overwrite the winner",
    `${inoBefore} -> ${statSync(first.path).ino}`);
  // The temporaries are the writers' own business and must not survive as
  // pseudo-snapshots. They are named to stay outside every reader's filter, but
  // leaving them behind fills the backup directory one failed race at a time.
  check(readdirSync(join(root, "hub")).filter(f => f.endsWith(".tmp")).length === 0,
    "control: neither writer left a temporary behind",
    JSON.stringify(readdirSync(join(root, "hub"))));
}

// ── and snapshotAll REPORTS a lost publish rather than claiming it ───────────
// A loser that falls through to the ordinary success push reports `ok: true`
// for a file it never validated and does not own -- and the winner deletes that
// file if its own deep validation fails, so this process has reported a
// successful backup for a path that no longer exists. The third outcome is
// `deferred`: not a success, and not a failure that escalates.
{
  const at2 = Math.floor(Date.now() / 1000) + 200;
  // Claim the second first, so snapshotAll's own snapshot() is the loser.
  const claimDb = openHub(hubPathFor(home));
  const claimed = snapshot(claimDb, root, "hub", at2, { keep: Infinity });
  claimDb.close();
  check(claimed.ok === true && claimed.mine === true,
    "fixture: the pre-claim won the publish, so snapshotAll below must lose it", JSON.stringify(claimed));
  const res = snapshotAll(home, root, { at: at2, keep: Infinity });
  const hub = res.find(r => r.nwo === "hub");
  // BOTH halves, because the contract changed once already and each half has a
  // caller depending on it.
  //
  // Not a failure: `ok` is what every programmatic consumer branches on, and
  // both of them -- `bin/reeve backup --hub` and the daemon's automatic backup
  // path -- treated a benign same-second race as `backup FAILED` when this was
  // `ok: false`. Two callers making the same mistake is a field whose meaning
  // does not match its use.
  check(hub?.ok === true,
    "a lost publish is NOT a failure: another process published it, and `ok` is what callers branch on",
    JSON.stringify(hub));
  // And still distinguishable: it is not a backup THIS process took, so a
  // caller counting its own snapshots must be able to exclude it.
  check(hub?.deferred === true && hub?.outcome === "deferred" && hub?.mine === false,
    "and it is still marked deferred, so a caller counting its own snapshots can exclude it",
    JSON.stringify(hub));
  check(hub != null && !hub.escalate,
    "control: and does NOT escalate -- a same-second race is not a backup failure",
    String(hub?.escalate));
  check(existsSync(claimed.path),
    "control: and the winner's file is untouched, because a loser may not judge or delete it",
    String(claimed.path));
}

// ── restore refuses while anything is writing ────────────────────────────────
import { restoreHub } from "../src/backup.mjs";
// Every binding Task 9 adds to this file, not just the two it is named for. The
// event-kind coverage check calls `replayableKinds()`, and the unreadable-hub
// block uses `hubTx`, `hubEvent`, `copyFileSync` and the fd trio -- none of
// which the existing imports or the standard harness supply, so the mandatory
// suite threw before destroying or restoring anything.
import { replayHub, replayableKinds, COMPARISON_SET } from "../src/build/replay.mjs";
import { hubTx, hubEvent } from "../src/build/hubdb.mjs";
import { copyFileSync, openSync, writeSync, closeSync } from "node:fs";
import { acquireSingleton, withWriterLease } from "../src/build/locks.mjs";
import { createHash } from "node:crypto";

// The durable-tail format, written and read EXACTLY as `reeve export-events
// --hub` and `reeve restore --hub --tail` do it. A fixture that invents its own
// shape tests a path no operator can reach -- and the previous revision's
// fixtures were bare JSON arrays with no footer at all, so once `restoreHub`
// began requiring a manifest the destructive drill went red and the
// malformed-payload refusal below started passing for the wrong reason: it was
// refused for the missing footer, never reaching the payload it names.
const writeTail = (path, events) => {
  const body = events.length ? events.map(e => JSON.stringify(e)).join("\n") + "\n" : "";
  writeFileSync(path, body + JSON.stringify({ _manifest: {
    count: events.length,
    first: events.length ? events[0].seq : null,
    last: events.length ? events[events.length - 1].seq : null,
    sha256: createHash("sha256").update(body).digest("hex"),
  } }) + "\n");
};
const readTail = (path) => {
  const rawLines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const parsed = rawLines.map(l => JSON.parse(l));
  const hasFooter = parsed.length > 0 && parsed[parsed.length - 1]?._manifest != null;
  const footer = hasFooter ? parsed.pop()._manifest : null;
  if (hasFooter) rawLines.pop();
  const tail = parsed;
  tail.manifest = footer;
  tail.sha256 = createHash("sha256")
    .update(rawLines.length ? rawLines.join("\n") + "\n" : "").digest("hex");
  return tail;
};
{
  const p = hubPathFor(home);
  const db = openHub(p);
  const snap = latestSnapshot(root, "hub");
  const ALIVE = () => true, DEAD = () => false;

  acquireSingleton(db, { name: "builder", pid: 4242, lstart: "L4242", command: "reeve build run", isAlive: ALIVE });
  let r = restoreHub(snap, p, { isAlive: ALIVE, pid: process.pid, lstart: "me" });
  check(r.ok === false, "restore refuses while the builder holds the singleton lease");
  check(JSON.stringify(r.holders).includes("4242"), "and names the holder", JSON.stringify(r.holders));

  db.exec("DELETE FROM singleton_lease");
  db.exec(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,priority,status,requested_at,expires_at)
           VALUES('guardian',1,'run:9',777,'L777',0,'held',unixepoch(),unixepoch()+120)`);
  r = restoreHub(snap, p, { isAlive: ALIVE, pid: process.pid, lstart: "me" });
  check(r.ok === false, "restore refuses while a GUARDIAN holds a provider lease");
  check(JSON.stringify(r.holders).includes("777"), "and names that holder too", JSON.stringify(r.holders));

  db.exec("DELETE FROM provider_lease");
  db.close();
  const db2 = openHub(p);
  let refusedDuring = null;
  withWriterLease(db2, { command: "reeve task file", pid: 555, lstart: "L555", isAlive: ALIVE }, () => {
    refusedDuring = restoreHub(snap, p, { isAlive: ALIVE, pid: process.pid, lstart: "me" });
  });
  check(refusedDuring?.ok === false, "restore refuses while a CLI command holds a writer lease");
  db2.close();

  // Control: with every writer gone, the same call succeeds. Without this, all
  // four refusals above are satisfied by a restore that refuses unconditionally.
  const ok = restoreHub(snap, p, { isAlive: DEAD, pid: process.pid, lstart: "me" });
  check(ok.ok === true, "control: with nothing live, restore proceeds", JSON.stringify(ok));
}

// ── drill helpers, hoisted ──────────────────────────────────────────────────
// These are `const` bindings used by the destructive drill below. They are
// presented in reading order in the plan and must live ABOVE it in the FILE:
// a const is in the temporal dead zone until its initialiser runs, so the
// drill would otherwise die at module load with
// `ReferenceError: Cannot access 'POST_SNAPSHOT' before initialization` --
// naming a variable rather than a defect, and writing, destroying and
// restoring nothing.

function exportComparison(db) {
  const out = {};
  for (const t of COMPARISON_SET) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).sort();
    out[t] = db.prepare(`SELECT ${cols.join(",")} FROM ${t} ORDER BY ${cols.join(",")}`).all();
  }
  return out;
}
function writeApproval(db, task, sha) {
  const row = { task, spec_repo_id: 9, spec_pr: 1, head_sha: sha, actor_id: 5, actor_login_snapshot: "m",
    kind: "codex_clean", verdict: "clean", observed_at: 1, source_id: "c1", task_generation: 1 };
  db.exec("BEGIN IMMEDIATE");
  db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,kind,verdict,observed_at,source_id,task_generation)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(row));
  db.prepare(`INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),'approval.recorded',?,?)`)
    .run(task, JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]]))));
  db.exec("COMMIT");
}
function writeHold(db, task, pr, reason) {
  const row = { task, repo_id: 1, pr, head_sha: "b".repeat(40), reason, created_at: 1 };
  db.exec("BEGIN IMMEDIATE");
  const info = db.prepare(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at) VALUES(?,?,?,?,?,?)`)
    .run(...Object.values(row));
  // The row as WRITTEN, read back -- the same rule `writeRow` follows and states.
  // `pr_hold.id` is an autoincrement INTEGER PRIMARY KEY and `pr_hold.created`
  // keys its upsert on exactly that column, so an image assembled from the
  // values passed IN has no `id` and replay binds `undefined`. This function
  // predates `writeRow` and was never re-checked against its handler's key.
  const written = db.prepare("SELECT * FROM pr_hold WHERE rowid = ?").get(info.lastInsertRowid);
  db.prepare(`INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),'pr_hold.created',?,?)`)
    .run(task, JSON.stringify(Object.fromEntries(Object.keys(written).sort().map(k => [k, written[k]]))));
  db.exec("COMMIT");
}
// One writer per COMPARISON_SET table, each appending its own hub_event exactly
// as the production path does -- that is what makes replay's primary-key upsert
// the thing under test rather than the fixture. `writeRow` is the shared shape;
// the three hand-written functions above predate it and are kept because their
// column lists document the authority-bearing tables in full.
// `.kind` is hung off the returned function so the coverage assertion above can
// read what each writer emits without calling it. A kind visible only at call
// time can be checked only by running the drill -- which is the moment a wrong
// one stops looking like a fixture bug and starts looking like broken replay.
const writeRow = (table, kind) => Object.assign((db, task, over = {}) => {
  const row = minimalRow(db, table, over);
  // Only tables that HAVE a task column get one: guardian_receipt and
  // project_authority do not, and setting it unconditionally would insert a
  // column the DDL never declared.
  if ("task" in row && !("task" in over)) row.task = task;
  const cols = Object.keys(row);
  db.exec("BEGIN IMMEDIATE");
  const info = db.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`)
    .run(...cols.map(c => row[c]));
  // The row as WRITTEN, read back, not the object that was assembled.
  // `minimalRow` deliberately skips the rowid alias because SQLite allocates it
  // -- so the assembled object has no `id`, and the handlers key their upserts
  // on exactly that column (`phase_event.seq`, `outbox.id`, `merge_decision.id`).
  // An image with no key replays into a NEWLY allocated one, so an `outbox.fence`
  // or a `task_drain.outbox_id` that pointed at the old id now points at nothing.
  // The drill only passes today because it replays into tables that were empty
  // at the snapshot and happen to re-allocate the same low ids; it proves
  // nothing about a snapshot that already had rows, or one with gaps.
  //
  // Reading back is also what keeps the image from drifting from the row, which
  // is the rule every other writer in this plan follows.
  const written = (() => {
    // Rowid tables: select by the rowid SQLite just allocated.
    try { return db.prepare(`SELECT * FROM ${table} WHERE rowid = ?`).get(info.lastInsertRowid) ?? row; }
    catch { /* WITHOUT ROWID -- there is no rowid to select by */ }
    // WITHOUT ROWID: select by the PRIMARY KEY. Returning the ASSEMBLED object
    // here was wrong: it is what we asked to insert, not what the row became,
    // so any column the database defaulted is missing from the image. That is
    // how `phase_run.slice` went absent.
    const pk = db.prepare(`PRAGMA table_info(${table})`).all().filter(c => c.pk)
      .sort((a, b) => a.pk - b.pk).map(c => c.name);
    try {
      return db.prepare(`SELECT * FROM ${table} WHERE ${pk.map(k => `${k}=?`).join(" AND ")}`)
        .get(...pk.map(k => row[k])) ?? row;
    } catch { return row; }
  })();
  const image = Object.keys(written).sort();
  db.prepare(`INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),?,?,?)`)
    .run(kind, task, JSON.stringify(Object.fromEntries(image.map(c => [c, written[c]]))));
  db.exec("COMMIT");
}, { kind });

// The minimum legal row for a table, DERIVED from its own schema rather than
// transcribed. Twenty hand-copied column lists is twenty chances to bake in
// a typo that makes an INSERT throw or -- worse -- silently insert nothing, and
// the drill is back to comparing [] with [].
//
// PRAGMA table_info gives name, type, notnull, dflt_value and pk, which is
// everything needed for a minimal row. Only CHECK constraints need help: they
// are the one thing table_info does not report, so the columns carrying one are
// listed explicitly and nothing else is.
const ENUMS = {
  "task.phase": "GATE", "task.source_kind": "founder", "task.visibility": "private",
  "task_territory.kind": "prefix",
  // 'succeeded', not 'settled'. The CHECK admits only
  // ('live','succeeded','failed','adopted','killed'), and a settled row is what
  // the comparison set is about -- a live one would be cleared by restoreHub and
  // never survive to be compared.
  "phase_run.status": "succeeded",
  // 'codex_clean'/'clean', not 'review'/'approved'. Neither of those is in the
  // DDL's CHECK -- `approval.kind ∈ {founder_review, founder_cli,
  // founder_silence, codex_clean}` and `approval.verdict ∈ {approve,
  // changes_requested, clean}` -- so the moment `approval` moved from its
  // hand-written writer to `writeRow`, both would abort the insert. They were
  // dead entries that documented the wrong schema, which is the failure this map
  // exists to prevent.
  "approval.kind": "codex_clean", "approval.verdict": "clean",
  // The CHECK admits only ('delivered','founder_ack'). With no entry here
  // minimalRow generated the literal 'notice_receipt-kind' and the destructive
  // drill aborted on the CHECK before it destroyed anything -- so the drill
  // reported a corruption-handling failure that was really a fixture defect.
  "notice_receipt.kind": "delivered",
  "attested_push.pusher": "builder", "attested_push.source_kind": "outbox",
  "guardian_receipt.status": "imported",
  "pr_hold.reason": "cancel",
  "outbox.kind": "notify", "outbox.status": "pending",
  "merge_decision.phase": "enqueue",
  "merge_decision.witness_outcome": "UNKNOWN", "merge_decision.actuation_outcome": "UNKNOWN",
  "territory_lease.kind": "prefix",
  "project_authority.kind": "review-witness",
};
const minimalRow = (db, table, over = {}) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  // `c.pk` is the 1-based POSITION in the primary key, not a boolean -- so it is
  // truthy for every component of a composite key. Treating it as "is a rowid
  // alias" dropped `phase_run.generation`, `gate_request.spec_repo_id`,
  // `guardian_receipt.repo_id` and `task_drain.outbox_id`, each of which is NOT
  // NULL, so those writers failed on the constraint before the drill reached
  // its destruction.
  //
  // A rowid alias is the narrow case: EXACTLY ONE pk column, INTEGER, on a
  // rowid table. Everything else is a real column that needs a real value.
  const pkCols = cols.filter(c => c.pk);
  const rowidAlias = pkCols.length === 1 && /^INTEGER$/i.test(pkCols[0].type) ? pkCols[0].name : null;
  const row = {};
  for (const c of cols) {
    if (c.name === rowidAlias) continue;                  // SQLite assigns it
    // A PRIMARY KEY column is ALWAYS supplied, default or not. A default makes a
    // column optional to INSERT; it does not make it optional to the row's
    // IDENTITY, and the image has to carry the whole key or replay cannot
    // address the row at all. `phase_run.slice` is INTEGER NOT NULL DEFAULT 0
    // and part of the composite key, so it was skipped here, absent from the
    // image, and the restore refused the event naming it.
    if (!c.pk && (!c.notnull || c.dflt_value !== null)) continue;   // nullable, or already defaulted
    row[c.name] = ENUMS[`${table}.${c.name}`]
      ?? (/INT/i.test(c.type) ? 1 : `${table}-${c.name}`);
  }
  return { ...row, ...over };
};

// A CHECK this map misses makes the INSERT throw, and the coverage control below
// catches a table that ended up empty -- so both failure modes are loud. That is
// the point of deriving: the fixture cannot silently drift from the schema.

// Except it CAN, in the one direction a throw does not cover: an entry that is
// present and ILLEGAL. Three were -- `notice_receipt.kind` absent, and
// `approval.kind`/`approval.verdict` naming values no CHECK admits, harmless
// only because `approval` happens to use a hand-written writer. So the map is
// checked against the schema rather than trusted, ONCE, before the drill runs:
{
  // `home`, not `dir`. test/hub-backup-restore.test.mjs binds `home` and `root`;
  // `dir` belongs to the standard-harness examples and is never declared here,
  // so this probe threw before the enum cross-check or the drill could run.
  const probe = openHub(join(home, "enums-probe.db"));
  const wrong = [];
  for (const t of COMPARISON_SET) {
    const ddl = probe.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t)?.sql ?? "";
    for (const c of probe.prepare(`PRAGMA table_info(${t})`).all()) {
      if (!c.notnull || c.dflt_value !== null) continue;
      // The column's own CHECK list, read out of the stored DDL. A column with
      // no enumeration is not this check's business.
      const m = new RegExp(`\\b${c.name}\\b[^,]*?CHECK\\s*\\([^)]*?IN\\s*\\(([^)]*)\\)`, "s").exec(ddl);
      if (!m) continue;
      const legal = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
      const key = `${t}.${c.name}`;
      const got = ENUMS[key];
      if (got === undefined || !legal.includes(got)) wrong.push(`${key}=${JSON.stringify(got)} legal=${legal.join("|")}`);
    }
  }
  check(wrong.length === 0,
    "every enumerated NOT NULL column in the comparison set has a LEGAL value in ENUMS",
    wrong.join("; "));
  // CONTROL: the reader found enumerations at all. An empty scan satisfies the
  // assertion above for every possible map, and a regex that stops matching the
  // stored DDL is exactly how this check would rot into a green no-op.
  check(Object.keys(ENUMS).length > 0 && /CHECK/.test(
      probe.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task'").get().sql),
    "control: the DDL really carries CHECK constraints for this scan to read");
  probe.close();
}

// These go ABOVE the destructive drill in the file, whatever order they are
// read in here -- see the ordering note in that block. Every one of them is a
// `const`, so a use before this point is a TDZ ReferenceError at module load.
const POST_SNAPSHOT = {
  task:              (db, t) => writeRow("task", "task.transitioned")(db, t),
  task_territory:    writeRow("task_territory", "task_territory.claimed"),
  task_drain:        writeRow("task_drain", "task_drain.recorded"),
  phase_event:       writeRow("phase_event", "phase_event.appended"),
  phase_run:         writeRow("phase_run", "phase_run.settled"),
  approval:          (db, t) => writeApproval(db, t, "a".repeat(40)),
  gate_request:      writeRow("gate_request", "gate_request.minted"),
  notice_receipt:    writeRow("notice_receipt", "notice_receipt.recorded"),
  impl_pr:           writeRow("impl_pr", "impl_pr.bound"),
  attested_push:     writeRow("attested_push", "attested_push.appended"),
  guardian_receipt:  writeRow("guardian_receipt", "guardian_receipt.imported"),
  harness_acceptance: writeRow("harness_acceptance", "harness_acceptance.recorded"),
  gate_run:          writeRow("gate_run", "gate_run.recorded"),
  pr_hold:           (db, t) => writeHold(db, t, 7, "cancel"),
  hold_reason:       writeRow("hold_reason", "hold_reason.appended"),
  project_authority: (db) => writeAuthority(db, "nextly"),
  outbox:            writeRow("outbox", "outbox.enqueued"),
  territory_lease:   writeRow("territory_lease", "territory_lease.granted"),
  merge_decision:    writeRow("merge_decision", "merge_decision.recorded"),
  // No `task` column, like guardian_receipt and project_authority -- writeRow
  // already only sets one on tables that declare it.
  escalation:        writeRow("escalation", "escalation.raised"),
};

function writeAuthority(db, project) {
  const row = { project_id: project, kind: "review-witness", granted_by: 5, until: 9999999999, created_at: 1 };
  db.exec("BEGIN IMMEDIATE");
  db.prepare(`INSERT INTO project_authority(project_id,kind,granted_by,until,created_at) VALUES(?,?,?,?,?)`).run(...Object.values(row));
  db.prepare(`INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),'project_authority.granted',NULL,?)`)
    .run(JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]]))));
  db.exec("COMMIT");
}

// ── the destructive drill ────────────────────────────────────────────────────
// Not "restore a file and see that it opens". Drop the live hub, put the
// snapshot back, replay everything that happened after it, and compare the
// fourteen tables of the comparison set row for row against what was there
// before the drop. A drill that only checks the file opens would pass against a
// restore that silently lost every row written since the snapshot.
{
  const p = join(home, "state", "drill.db");
  const db = openHub(p);
  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:d','p',1,'o/r','t','GATE',1,'founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  // snapshot HERE, so everything below is post-snapshot history the replay must recover
  const snapDir = join(root, "drill");
  mkdirSync(snapDir, { recursive: true });
  const snap = join(snapDir, "1.db");
  db.exec(`VACUUM INTO '${snap}'`);

  // A post-snapshot write for EVERY table in COMPARISON_SET. Three was not a
  // drill: the other sixteen tables were empty on both sides, so `[] === []`
  // passed for each of them and a replay with its `phase_event`, `outbox`,
  // `merge_decision` or `guardian_receipt` handler deleted outright would have
  // been accepted as a correct recovery.
  //
  // Table-driven, and the coverage is ASSERTED rather than eyeballed, so adding
  // a table to COMPARISON_SET without a writer fails here instead of quietly
  // reintroducing an empty comparison.
  // ORDERING, and it is load-bearing rather than stylistic: `minimalRow`,
  // `writeRow`, `writeApproval`, `writeHold`, `writeAuthority`, `ENUMS`,
  // `POST_SNAPSHOT` and `WRITE_ORDER` are all written into
  // test/hub-backup-restore.test.mjs ABOVE this block. `const` bindings are in
  // the temporal dead zone until their initialiser runs, so a file that shows
  // the drill first throws `ReferenceError: Cannot access 'POST_SNAPSHOT'
  // before initialization` at module evaluation -- the whole drill never writes,
  // destroys or restores anything, and the failure names a variable rather than
  // a defect. The sections below are presented in reading order; the FILE order
  // is helpers first.
  const missingWriters = COMPARISON_SET.filter(t => !POST_SNAPSHOT[t]);
  check(missingWriters.length === 0,
    "every compared table has a post-snapshot writer, so no comparison is [] vs []",
    JSON.stringify(missingWriters));
  // And every kind those writers emit must be one replayHub RECOGNISES. Six did
  // not -- `impl_pr.opened` against a handler for `impl_pr.bound`, and five more
  // of the same shape -- so replay skipped the rows as unknown kinds, leaving
  // those tables empty in the restored database and populated in the pre-drop
  // export. The row-for-row comparison then failed against the exact
  // implementation Step 3 prescribes, and the failure would have read as
  // "replay is broken" rather than "the fixture invented an event name".
  const unknownKinds = COMPARISON_SET
    .map(t => POST_SNAPSHOT[t].kind).filter(Boolean)
    .filter(k => !replayableKinds().includes(k));
  check(unknownKinds.length === 0,
    "and every kind they emit is one replayHub has a handler for",
    JSON.stringify(unknownKinds));
  // FOREIGN-KEY ORDER, which is not COMPARISON_SET's order. §11.4 lists the
  // comparison set for what it compares, and `task_drain` sits third there while
  // `outbox` sits sixteenth -- but `task_drain.outbox_id REFERENCES outbox(id)`,
  // so writing in declaration order inserts a child before its parent and the
  // drill dies on the constraint before it destroys anything.
  //
  // Declared explicitly rather than sorted, because the dependency is a fact
  // about the schema and a topological sort here would be one more thing that
  // can be subtly wrong. The assertion below is what keeps the two lists in
  // step: it is a permutation of COMPARISON_SET, checked, not assumed.
  const WRITE_ORDER = [
    "task",                                   // every other table references it
    "phase_event",                            // outbox.fence references its seq
    "outbox",                                 // task_drain.outbox_id references its id
    "task_drain", "task_territory", "territory_lease", "hold_reason", "pr_hold",
    "phase_run", "gate_request", "gate_run", "approval", "notice_receipt",
    "impl_pr", "attested_push", "guardian_receipt", "harness_acceptance",
    "project_authority", "merge_decision",
    // No foreign keys of its own (`why` is the primary key and nothing
    // references it), so its position here is free.
    "escalation",
  ];
  check(WRITE_ORDER.length === COMPARISON_SET.length
        && WRITE_ORDER.every(t => COMPARISON_SET.includes(t))
        && COMPARISON_SET.every(t => WRITE_ORDER.includes(t)),
    "control: WRITE_ORDER is a permutation of COMPARISON_SET, so nothing is written twice or skipped",
    JSON.stringify({ onlyWrite: WRITE_ORDER.filter(t => !COMPARISON_SET.includes(t)),
                     onlyCompare: COMPARISON_SET.filter(t => !WRITE_ORDER.includes(t)) }));
  for (const t of WRITE_ORDER) POST_SNAPSHOT[t](db, "bt:d");
  // And each one really landed: a writer that silently no-ops leaves the same
  // empty-vs-empty comparison this block exists to remove.
  const emptyAfterWrite = COMPARISON_SET.filter(
    t => db.prepare(`SELECT count(*) c FROM ${t}`).get().c === 0);
  check(emptyAfterWrite.length === 0,
    "control: every compared table actually holds a post-snapshot row now",
    JSON.stringify(emptyAfterWrite));

  const before = exportComparison(db);
  // Exported to DISK before the destruction, the way an operator would have it:
  // once the file is gone there is nothing left to read a tail out of, so a test
  // that kept it only in memory would be testing a path that does not exist.
  const snapSeq = (() => { const q = new DatabaseSync(snap, { readOnly: true });
    try { return q.prepare("SELECT COALESCE(max(seq),0) s FROM hub_event").get().s; } finally { q.close(); } })();
  const events = db.prepare("SELECT seq,at,kind,task,payload FROM hub_event WHERE seq > ? ORDER BY seq").all(snapSeq);
  // JSONL WITH THE FOOTER, which is what `export-events --hub` produces. The
  // `.jsonl` name matters only as documentation; the shape is what is under test.
  writeTail(join(home, "tail.jsonl"), events);
  db.close();

  // DESTROY
  rmSync(p, { force: true });
  for (const s of ["-wal", "-shm"]) rmSync(p + s, { force: true });
  check(!existsSync(p), "the live hub is really gone");

  const durableTail = readTail(join(home, "tail.jsonl"));
  check(durableTail.manifest != null && durableTail.manifest.count === events.length,
    "fixture: the durable tail carries the manifest an export writes, so the restore below can accept it",
    JSON.stringify(durableTail.manifest));
  const r = restoreHub(snap, p, { isAlive: () => false, pid: process.pid, lstart: "me", tail: durableTail });
  check(r.ok === true, "the snapshot restores", JSON.stringify(r));
  // The COMMAND replays the tail. The test must not do it on the command's
  // behalf: that would prove the harness works, not the thing an operator runs.
  check(r.replayed > 0, `restoreHub itself replayed the tail (applied ${r.replayed})`, JSON.stringify(r));
  check(r.tail === events.length, "and captured every post-snapshot event before replacing the file",
    `captured ${r.tail}, expected ${events.length}`);
  const back = openHub(p);

  const after = exportComparison(back);
  for (const t of COMPARISON_SET) {
    check(JSON.stringify(after[t]) === JSON.stringify(before[t]),
      `${t} matches the pre-drop export row for row`,
      `before ${JSON.stringify(before[t])}\n        after  ${JSON.stringify(after[t])}`);
  }
  // Process-scoped rows are excluded BY DESIGN: they describe processes that no
  // longer exist. Asserting it, so nobody later "fixes" the drill by adding them.
  for (const t of ["directory_lease","provider_lease","singleton_lease","writer_lease","maintenance_lock"])
    check(!COMPARISON_SET.includes(t), `${t} is excluded from the comparison set`);
  back.close();
}


// ── a hub too corrupt to open is still restorable from a snapshot + tail ─────
{
  const home = mkdtempSync(join(tmpdir(), "reeve-unreadable-"));
  mkdirSync(join(home, "state"), { recursive: true });
  const p = hubPathFor(home);
  const good = openHub(p);
  // The TASK first. `hub_event.task` references `task(id)` and openHub enables
  // foreign keys, so an event naming `bt:1` on a fresh hub aborts the insert --
  // and the setup died before the snapshot was even taken, so not one recovery
  // assertion below ran. The event then has something real to be about.
  hubTx(good, () => {
    good.prepare(
      `INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
                        repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,
                        created_at,updated_at)
       VALUES('bt:1','p',1,'o/r','t','GATE',1,'founder','k','/p','/f','h','main','private',1,
              unixepoch(),unixepoch())`).run();
    hubEvent(good, { kind: "task.transitioned", task: "bt:1",
      payload: { id: "bt:1", phase: "GATE", generation: 1 } });
  });
  good.close();
  const snap = join(home, "snap.db");
  copyFileSync(p, snap);

  // Corrupt the LIVE hub past the point of answering a query, derived from the
  // file rather than hardcoded -- see 2026-08-23-sqlite-page-corruption.md: an
  // offset past the end of a short file corrupts nothing, and every assertion
  // below would then pass having done nothing at all.
  const geom = new DatabaseSync(p, { readOnly: true });
  const pageSize  = geom.prepare("PRAGMA page_size").get().page_size;
  const pageCount = geom.prepare("PRAGMA page_count").get().page_count;
  geom.close();
  const fd = openSync(p, "r+");
  for (let i = 1; i < pageCount; i++) writeSync(fd, Buffer.alloc(pageSize, 0x41), 0, pageSize, i * pageSize);
  closeSync(fd);
  // CONTROL, and the load-bearing one: it really is unreadable NOW. Without it
  // the refusal below is equally satisfied by a hub that opens perfectly well
  // and was refused for some unrelated reason, and the force path that follows
  // would be exercising the ordinary readable branch under a different name.
  let readable = true;
  try { const q = new DatabaseSync(p, { readOnly: true });
        q.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get(); q.close(); }
  catch { readable = false; }
  check(!readable, "control: the live hub really cannot be read now", String(readable));

  // Without force: REFUSED, because no holder can be enumerated either way.
  const no = restoreHub(snap, p, { isAlive: () => false, pid: process.pid, lstart: "L", force: false });
  check(!no.ok && /cannot be read/.test(no.why ?? ""),
    "an unreadable hub is refused without force, naming why the holders are unknowable", JSON.stringify(no));

  // With force and a supplied tail: recovered. This is the whole point of the
  // route, and before the unreadable branch existed it returned
  // `could not restore: ...` from the outer catch instead.
  // A COMPLETE row image, because `bt:2` does not exist in the snapshot: replay
  // takes the INSERT path for a row it has never seen, and a three-field image
  // fails `task.project`, `repo_id`, the provenance columns, the registry
  // version and the timestamps. A partial image is only legal for a row the
  // snapshot already carries -- which is exactly the distinction the applier's
  // existence check draws, and this fixture sat on the wrong side of it.
  // `snapSeq + 1`, DERIVED. A literal 99 against a snapshot whose max seq is 1
  // makes the continuity check report 2..98 missing and return {ok:false} before
  // replay -- so the assertion on the next line fails against the very
  // implementation this plan prescribes. The check and the fixture were written
  // in the same round and never run against each other.
  const snapMax = (() => {
    const q = new DatabaseSync(snap, { readOnly: true });
    try { return q.prepare("SELECT COALESCE(max(seq),0) s FROM hub_event").get().s; } finally { q.close(); }
  })();
  // THE SNAPSHOT'S OWN EVENTS FIRST. `export-events --hub` writes the whole log
  // from seq 1, so a real tail always carries the part the snapshot also has --
  // and that prefix is the only thing tying the file to THIS hub rather than to
  // some other one whose sequence numbers happen to line up. A fixture that
  // starts after the snapshot is not the format the command produces, and the
  // provenance check refuses it correctly.
  const snapPrefix = (() => {
    const q = new DatabaseSync(snap, { readOnly: true });
    try { return q.prepare("SELECT seq, at, kind, task, payload FROM hub_event ORDER BY seq").all(); }
    finally { q.close(); }
  })();
  const tailEvents = [...snapPrefix, { seq: snapMax + 1, at: 1, kind: "task.transitioned", task: "bt:2",
                  payload: JSON.stringify({
                    id: "bt:2", project: "p", repo_id: 1, nwo_snapshot: "o/r", title: "t",
                    phase: "SIZING", generation: 1, source_kind: "founder", source_key: "k2",
                    repo_path: "/p", profile_path: "/f", profile_hash: "h",
                    default_branch: "main", visibility: "private", registry_version: 1,
                    created_at: 1, updated_at: 1 }) }];
  // Through the REAL export format, like every other tail fixture here. A bare
  // array carries neither a manifest nor an observed digest, so `restoreHub`
  // refuses it before replay and NONE of this block's recovery assertions can
  // run -- `yes.ok` is false for the envelope, not for anything this drill is
  // about. Three fixtures in this file supply a tail; when the footer was
  // introduced two were converted and this one was not.
  const recoverPath = join(home, "recover-tail.jsonl");
  writeTail(recoverPath, tailEvents);
  const tail = readTail(recoverPath);
  const yes = restoreHub(snap, p, { isAlive: () => false, pid: process.pid, lstart: "L", force: true, tail });
  check(yes.ok, "restore --hub --tail recovers a hub too corrupt to open", JSON.stringify(yes));
  check(yes.quarantined && existsSync(yes.quarantined),
    "and the unreadable file is quarantined and NAMED in the result, not deleted", String(yes.quarantined));
  const back = openHub(p);
  check(back.prepare("SELECT count(*) c FROM task WHERE id='bt:2'").get().c === 1,
    "and the supplied tail was replayed, so events after the snapshot survived");
  back.close();
  // A FAILED recovery must leave the corrupt database exactly where it was.
  // This is the assertion that would have caught the earlier ordering: with the
  // rename at the top of the branch, `dbPath` is gone by the time replayHub
  // throws, the finally clears staging, and the canonical path is left empty for
  // the next writer to create a fresh hub at.
  {
    // RE-CORRUPT FIRST. The successful restore above replaced the file with a
    // healthy hub, so without this the attempt below takes the ordinary
    // readable-live branch -- and both assertions stay green whether or not the
    // unreadable branch moves the database too early, which is the one thing
    // they exist to detect. A fixture that cannot reach the mechanism it names
    // proves nothing by passing.
    {
      const g = new DatabaseSync(p, { readOnly: true });
      const ps = g.prepare("PRAGMA page_size").get().page_size;
      const pc = g.prepare("PRAGMA page_count").get().page_count;
      g.close();
      const fd2 = openSync(p, "r+");
      for (let i = 1; i < pc; i++) writeSync(fd2, Buffer.alloc(ps, 0x41), 0, ps, i * ps);
      closeSync(fd2);
    }
    // CONTROL: it is unreadable again, so the branch below is the one under test.
    let stillReadable = true;
    try { const q = new DatabaseSync(p, { readOnly: true });
          q.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get(); q.close(); }
    catch { stillReadable = false; }
    check(!stillReadable, "control: the hub is unreadable again before the failing attempt", String(stillReadable));

    // A WELL-FORMED export carrying a MALFORMED event. The two failures are
    // different and this fixture must exhibit only the second: written as a bare
    // array it was refused for its missing manifest and the assertion below went
    // green having never reached the payload it names.
    // `snapMax + 1`, DERIVED -- the same rule the recovery fixture above states
    // in as many words, and this one sat two blocks below it still carrying a
    // literal 100. Against a snapshot whose max seq is 1 that makes the
    // continuity check report 2..99 missing and return `{ok:false}` BEFORE
    // replay ever parses the payload, so the refusal is about a gap, this
    // block never reaches the staging-and-replay seam it exists to guard, and
    // the byte-preservation assertions below pass even against an
    // implementation that moves the canonical file and strands it.
    const badPath = join(home, "bad-tail.jsonl");
    writeTail(badPath, [{ seq: snapMax + 1, at: 1, kind: "task.transitioned", task: "bt:3", payload: "{not json" }]);
    const bad = readTail(badPath);
    check(bad.manifest != null && bad.sha256 === bad.manifest.sha256,
      "fixture: the bad tail's ENVELOPE is valid, so the refusal below is about the payload",
      JSON.stringify(bad.manifest));
    // The BYTES, not the length. A failed recovery that rewrites the file in
    // place -- or mutates a page -- leaves the size unchanged, so a length
    // comparison passes on exactly the regression the assertion names.
    const before = readFileSync(p);
    const failed = restoreHub(snap, p, { isAlive: () => false, pid: process.pid, lstart: "L", force: true, tail: bad });
    check(!failed.ok, "fixture: a malformed tail fails the restore", JSON.stringify(failed));
    // WHICH refusal, not just that there was one. Contiguity and the manifest
    // both refuse earlier than replay, and either would satisfy the line above
    // while this drill silently stopped short of the destructive seam. Naming
    // the two earlier refusals and excluding them is what makes the
    // byte-preservation assertions below mean anything.
    check(!/not a complete run|manifest|digest/.test(String(failed.why)),
      "and it is refused at REPLAY, not by contiguity or the footer -- the seam this drill guards",
      String(failed.why));
    check(existsSync(p) && before.equals(readFileSync(p)),
      "a failed recovery leaves the database at the canonical path, byte for byte",
      `${existsSync(p)} ${readFileSync(p).length} vs ${before.length}`);
    check(!failed.quarantined,
      "and reports no quarantine, because nothing was moved", String(failed.quarantined));
  }

  // ── the footer is checked three independent ways ───────────────────────────
  // Three files an operator could really be holding, each failing a DIFFERENT
  // check. All three are needed: a bare count is satisfied by an edited count,
  // and a digest with nothing to compare it against proves nothing about what
  // was expected. The prose promised all three refusals and only the first two
  // were ever written.
  {
    const target = join(home, "manifest-probe.db");
    const snapM = latestSnapshot(root, "hub");
    const one = { seq: 900001, at: 1, kind: "task.transitioned", task: "bt:9", payload: "{}" };
    const args = { isAlive: () => false, pid: process.pid, lstart: "m", force: true };
    const withFooter = (manifest, observed) => {
      const t = [one]; t.manifest = manifest; t.sha256 = observed; return t;
    };

    const r1 = restoreHub(snapM, target, { ...args, tail: withFooter(null, "unused") });
    check(!r1.ok && /manifest footer/.test(String(r1.why)),
      "a tail with no manifest footer is refused: truncation is invisible without one", String(r1.why));

    const r2 = restoreHub(snapM, target,
      { ...args, tail: withFooter({ count: 5, first: one.seq, last: one.seq, sha256: "x" }, "x") });
    check(!r2.ok && /claims 5 events/.test(String(r2.why)),
      "a tail whose manifest count disagrees with the lines read is refused", String(r2.why));

    // The edit the COUNT check cannot see, which is the entire reason the digest
    // exists: drop the last event, decrement `count` to match, and every
    // arithmetic check agrees while the file has silently lost history.
    const r3 = restoreHub(snapM, target, { ...args,
      tail: withFooter({ count: 1, first: one.seq, last: one.seq, sha256: "a".repeat(64) }, "b".repeat(64)) });
    check(!r3.ok && /digest/.test(String(r3.why)),
      "a tail whose count agrees but whose DIGEST does not is refused: an edited count cannot buy a restore",
      String(r3.why));

    // A manifest that declares `first`/`last` nothing reads is one whose other
    // fields nobody has reason to trust. This is also the FRONT-truncation case,
    // which contiguity reports as a hole against the snapshot rather than as the
    // edit it is.
    const r5 = restoreHub(snapM, target, { ...args,
      tail: (() => { const t = [one];
        t.manifest = { count: 1, first: 7, last: 9,
                       sha256: createHash("sha256").update(JSON.stringify(one) + "\n").digest("hex") };
        t.sha256 = t.manifest.sha256; return t; })() });
    check(!r5.ok && /is not the export it says it is/.test(String(r5.why)),
      "a tail whose declared seq range disagrees with the events it carries is refused", String(r5.why));

    // CONTROL, and deliberately a NARROW one. It asserts only that a correct
    // footer gets PAST every footer check -- not that the restore succeeds,
    // which would depend on this fabricated event being contiguous with the
    // snapshot and replayable, neither of which this block is about. A control
    // that claimed more than it establishes would be the defect these plans keep
    // finding in other people's tests.
    const okPath = join(home, "ok-tail.jsonl");
    writeTail(okPath, [one]);
    const r4 = restoreHub(snapM, target, { ...args, tail: readTail(okPath) });
    check(!/manifest|digest|claims \d+ events|is not the export/.test(String(r4.why ?? "")),
      "control: the same event with a CORRECT footer clears every footer check, so the four refusals above are the footer's doing",
      String(r4.why));
  }

  // CONTROL: the sibling lock was RELEASED. A canonical `.restore-lock` left
  // held makes every later restore refuse, naming a pid that exited long ago --
  // and because the lock is not inside the hub, nothing else in this suite or
  // any other would ever notice.
  const second = restoreHub(snap, p, { isAlive: () => false, pid: process.pid, lstart: "L", force: true });
  check(second.ok, "control: a second restore is not blocked by the first one's sibling lock",
    JSON.stringify(second));
}

// test/hub-backup-restore.test.mjs, before the terminator
{
  const home2 = mkdtempSync(join(tmpdir(), "reeve-cli-restore-"));
  mkdirSync(join(home2, "state"), { recursive: true });
  const hub = hubPathFor(home2);
  openHub(hub).close();
  const runCli = (args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env: { ...process.env, REEVE_HOME: home2 } });

  const bk = runCli(["backup", "--hub"]);
  check(bk.status === 0, "`reeve backup --hub` takes a snapshot through the CLI",
    `${bk.status} ${bk.stderr?.slice(0, 160)}`);
  check(latestSnapshot(join(home2, "backups"), "hub") !== null,
    "and the hub snapshot really exists, so the restore below has something to find");
  const tailFile = join(home2, "tail.jsonl");
  const ex = runCli(["export-events", "--hub", tailFile]);
  check(ex.status === 0 && existsSync(tailFile),
    "`reeve export-events --hub` writes a tail file", `${ex.status} ${ex.stderr?.slice(0, 120)}`);

  rmSync(hub, { force: true });
  const r = runCli(["restore", "--hub", "--tail", tailFile]);
  check(r.status === 0, "`reeve restore --hub` restores through the CLI, not just the function",
    `${r.status} ${r.stderr?.slice(0, 200)}`);
  check(existsSync(hub), "and the hub is back at its canonical path");
  // CONTROL: without --hub the command still asks for a repository, so the new
  // branch has not swallowed the existing per-repo route.
  const repo = runCli(["restore"]);
  // Assert WHICH ROUTE ran, not the wording. `/repo/i` matched only the
  // "Pass owner/repo or run inside a git checkout" message, which appears just
  // when no repository can be DETECTED -- so this control passed or failed
  // depending on the working directory, and inside a git checkout (which is
  // where the suite runs) it detects one and says "no snapshot for <nwo>".
  // The two routes have distinct prefixes and that is the real evidence:
  // `reeve restore:` is the per-repo path, `reeve restore --hub:` is the new one.
  check(repo.status !== 0
        && /reeve restore:/.test(repo.stderr ?? "")
        && !/reeve restore --hub:/.test(repo.stderr ?? ""),
    "control: `reeve restore` with no --hub still takes the per-repo path",
    String(repo.stderr).slice(0, 160));
  rmSync(home2, { recursive: true, force: true });
}

// ── a row image missing its handler's key is refused BY NAME ────────────────
// Five tables key on an autoincrement `id` -- pr_hold, hold_reason, gate_run,
// merge_decision, outbox -- so a writer that builds its image from the values it
// passed IN, rather than reading the row back, emits an image with no key. That
// binds `undefined` and SQLite answers `Provided value cannot be bound to SQLite
// parameter 1`, during a RESTORE: the worst moment in the system to be handed a
// message naming neither the event, the table, nor the column. This is not
// hypothetical -- `writeHold` in this very file did it, and the opaque bind
// error is what had to be traced back to it.
{
  const db = openHub(join(home, "missing-key.db"));
  hubTx(db, () => db.prepare(
    `INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
                      repo_path,profile_path,profile_hash,default_branch,visibility,
                      registry_version,created_at,updated_at)
     VALUES('bt:1','p',1,'o/r','t','GATE','founder','k','/p','/f','h','main','private',1,
            unixepoch(),unixepoch())`).run());
  const image = { task: "bt:1", repo_id: 1, pr: 7, head_sha: "c".repeat(40),
                  reason: "cancel", created_at: 1 };
  let why = null;
  try {
    replayHub(db, [{ seq: 41, at: 1, kind: "pr_hold.created", task: "bt:1",
                     payload: JSON.stringify(image) }]);
  } catch (e) { why = e.message; }
  // Scoped to what it actually establishes. WITHOUT the guard SQLite still
  // throws -- on the bind -- so "a refusal happened" is true either way and this
  // line is a precondition, not evidence. The two below are the evidence: they
  // are about WHAT the refusal says, which is the whole difference.
  check(why !== null,
    "a replay of an image missing its key does not succeed silently", String(why));
  check(/\bid\b/.test(String(why)) && /pr_hold/.test(String(why)),
    "and the refusal names the missing column and the table", String(why));
  check(/seq 41/.test(String(why)) && /pr_hold\.created/.test(String(why)),
    "and names the event, so an operator can find it in the log", String(why));
  // CONTROL: the SAME image carrying its id replays. Without it a guard that
  // refuses everything satisfies all three assertions above, and a restore that
  // refuses every event is worse than the opaque message it replaced.
  const good = replayHub(db, [{ seq: 42, at: 1, kind: "pr_hold.created", task: "bt:1",
                                payload: JSON.stringify({ id: 1, ...image }) }]);
  check(good.applied === 1,
    "control: the same image carrying its id replays normally", JSON.stringify(good));
}

// ── restoring over a NEWER hub is refused, twice ────────────────────────────
// A raw open skips openHub's forward-version refusal, so restoreHub has to make
// it itself -- otherwise an older binary replaces a hub a newer one migrated,
// collects event kinds it does not recognise, counts them as skipped, and exits
// 0 with the newer state gone.
//
// The check is made TWICE and neither had a test. The first read is a fast,
// clear message. The second happens after `acquireMaintenanceLock`, because the
// window is exactly the wait for that lock: an older restore can read version 1,
// wait while a newer builder migrates the hub, and find no live holder when it
// wakes. A pre-lock read cannot close a window it opens.
{
  const p = join(home, "newer-hub.db");
  const db = openHub(p);
  db.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${HUB_SCHEMA_VERSION + 1}, unixepoch())`);
  db.close();
  const snap = latestSnapshot(root, "hub");
  const r = restoreHub(snap, p, { isAlive: () => false, pid: process.pid, lstart: "me" });
  check(r.ok === false,
    "restoring over a hub at a NEWER schema version is refused", JSON.stringify(r).slice(0, 220));
  check(new RegExp(`schema version ${HUB_SCHEMA_VERSION + 1}\\b`).test(String(r.why)) &&
        new RegExp(`knows ${HUB_SCHEMA_VERSION}\\b`).test(String(r.why)),
    "and the refusal names both versions, so an operator knows which binary to run", String(r.why));
  // WHICH refusal. The store is also readable and unheld, so a generic failure
  // would satisfy the two lines above without the version check existing.
  check(/Upgrade reeve/.test(String(r.why)) && !/could not restore/.test(String(r.why)),
    "and it is the version refusal, not an incidental failure", String(r.why));
  // CONTROL: the same call against a hub at THIS version proceeds, so the
  // refusal is about the version and not about the fixture or the snapshot.
  const okPath = join(home, "same-version.db");
  openHub(okPath).close();
  const ok2 = restoreHub(snap, okPath, { isAlive: () => false, pid: process.pid, lstart: "me" });
  check(ok2.ok === true,
    "control: a hub at this binary's own version restores normally", String(ok2.why));
}

// ── a version-0 hub is RECOVERABLE, not a dead end ─────────────────────────
// `openHub` creates `schema_version` as plain DDL before migration 1's
// transaction, so an interrupted first run leaves a file where the version query
// SUCCEEDS -- returning 0 -- while `maintenance_lock` and every other table this
// path queries does not exist. Classified as readable, `restore --hub` died with
// `no such table: maintenance_lock` instead of installing a snapshot it had
// already validated, which is precisely the state the command exists to recover.
{
  const p = join(home, "v0-hub.db");
  const snap = latestSnapshot(root, "hub");
  const half = new DatabaseSync(p);
  half.exec(`CREATE TABLE IF NOT EXISTS schema_version (
               version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`);
  half.close();
  {
    const probe = new DatabaseSync(p, { readOnly: true });
    const v = probe.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
    const tables = probe.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
    probe.close();
    check(v === 0 && tables === 1,
      "fixture: the version query succeeds and returns 0, which is what made this look readable",
      `version ${v}, ${tables} table(s)`);
  }
  const r = restoreHub(snap, p, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
  check(r.ok === true,
    "restore --hub recovers a hub whose first migration never completed",
    JSON.stringify(r).slice(0, 220));
  check(!/no such table/.test(String(r.why ?? "")),
    "and does not die on a table migration 1 never created", String(r.why));
  const back = new DatabaseSync(p, { readOnly: true });
  const tablesAfter = back.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
  const versionAfter = back.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
  back.close();
  check(versionAfter === 1 && tablesAfter > 1,
    "and the store is whole afterwards", `version ${versionAfter}, ${tablesAfter} tables`);
  // The half-created file is KEPT. It carries no completed migration, but a
  // recovery that silently deletes what it replaced is one an operator cannot
  // audit -- and this path quarantines rather than deletes for that reason.
  check(r.quarantined && existsSync(r.quarantined),
    "and the half-created file is quarantined and named, not deleted", String(r.quarantined));
}

// ── abandoned temporaries are reaped, live ones are not ─────────────────────
// A process killed between `VACUUM INTO` and the hard-link publish leaves a
// full database copy under `.<epoch>.<pid>.tmp`. Nothing else would ever remove
// one: `prune` and every candidate reader filter on `/^\d+\.db$/` precisely so a
// partial file is invisible, and `snapshot()` only removes its own current
// path. So each interrupted backup leaked a database-sized file for ever, on
// the disk whose job is holding the backups.
{
  const hubDir = join(root, "hub");
  // A pid that is not running: ESRCH, so this temp is abandoned.
  const dead = join(hubDir, ".1700000000.999999.tmp");
  // pid 1 exists and is not ours: `kill(1, 0)` raises EPERM, which must be read
  // as "running", not as "gone". Reaping on any error would delete the
  // temporary of a live writer mid-VACUUM.
  const live = join(hubDir, ".1700000001.1.tmp");
  writeFileSync(dead, "abandoned");
  writeFileSync(live, "in flight");

  const db = openHub(hubPathFor(home));
  snapshot(db, root, "hub", Math.floor(Date.now() / 1000) + 300, { keep: Infinity });
  db.close();

  check(!existsSync(dead),
    "a temporary whose owning process is gone is reaped by the next snapshot", dead);
  check(existsSync(live),
    "control: one whose pid is still running is left alone, because deleting it would corrupt a live backup",
    live);
  try { rmSync(live, { force: true }); } catch {}
}

// ── the quarantine keeps the WAL, which may be the only copy of the newest events ─
// A WAL holds committed pages that have not been checkpointed into the main
// file, so after the crash that made recovery necessary it can be the ONLY copy
// of the newest history. The sidecars were removed BEFORE the quarantine copy
// was taken, so "the damaged database is kept at <path>" was a half-truth and
// the rest was destroyed permanently.
{
  const p = join(home, "wal-hub.db");
  const snap = latestSnapshot(root, "hub");
  // A hub that cannot be opened, WITH sidecars beside it, which is the shape a
  // crash leaves.
  writeFileSync(p, "this is not a database");
  writeFileSync(p + "-wal", "pretend committed pages nobody has checkpointed");
  writeFileSync(p + "-shm", "shared memory index");
  const r = restoreHub(snap, p, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
  check(r.ok === true, "an unreadable hub with sidecars still restores", JSON.stringify(r).slice(0, 200));
  check(r.quarantined && existsSync(r.quarantined),
    "and the main file is quarantined", String(r.quarantined));
  check(existsSync(r.quarantined + "-wal"),
    "and its -wal goes WITH it, because that may be the only copy of the newest events",
    `${r.quarantined}-wal`);
  check(readFileSync(r.quarantined + "-wal", "utf8").includes("committed pages"),
    "control: the quarantined -wal is the real one, not an empty placeholder",
    readFileSync(r.quarantined + "-wal", "utf8").slice(0, 40));
  // And the canonical path no longer carries the stale sidecars, which would
  // otherwise be replayed into the restored database on its next open.
  check(!existsSync(p + "-wal") && !existsSync(p + "-shm"),
    "control: the stale sidecars are gone from the canonical path, so nothing replays them into the restore");
}

// ── a durable tail is published, never overwritten in place ────────────────
// `export-events --hub` used `writeFileSync`, which TRUNCATES the destination
// before writing a byte. Refreshing an existing tail therefore destroyed the
// last valid one first: a kill or a full disk left a partial file with no
// manifest, and a later restore permanently lost every post-snapshot event that
// tail was protecting. It is the file an operator reaches for after losing the
// hub, so it is the last file in the system that may be replaced in place.
{
  const eHome = mkdtempSync(join(tmpdir(), "reeve-export-"));
  mkdirSync(join(eHome, "state"), { recursive: true });
  openHub(hubPathFor(eHome)).close();
  const env = { ...process.env, REEVE_HOME: eHome };
  const runCli = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env });

  const dest = join(eHome, "tail.jsonl");
  const first = runCli("export-events", "--hub", dest);
  check(first.status === 0 && existsSync(dest),
    "fixture: a first export writes the tail", (first.stdout + first.stderr).slice(0, 160));
  const before = readFileSync(dest);
  check(before.length > 0 && /_manifest/.test(String(before)),
    "fixture: and it carries the manifest footer, so 'still valid' below means something",
    String(before).slice(-80));
  check(readdirSync(eHome).filter(f => f.includes(".tmp-")).length === 0,
    "a successful export leaves no temp file beside the tail", readdirSync(eHome).join(" "));

  // THE INODE is the discriminator for the publish mechanism, and the only one
  // that holds. A truncating writer rewrites the destination in place and keeps
  // its inode; a temp-then-rename publish replaces the directory entry, so the
  // inode CHANGES. Measured: the failure-path assertions below cannot carry this
  // on their own -- a read-only directory stops the temp file from being
  // created, but an in-place `writeFileSync` on an existing writable file
  // succeeds regardless, so under that stub the "previous tail survives" check
  // passes because nothing failed at all.
  const inoBefore = statSync(dest).ino;
  const second = runCli("export-events", "--hub", dest);
  check(second.status === 0, "fixture: a second export over the same path succeeds",
    (second.stdout + second.stderr).slice(0, 160));
  check(statSync(dest).ino !== inoBefore,
    "a refreshed tail is PUBLISHED over the old one, never written into it",
    `ino ${inoBefore} -> ${statSync(dest).ino}`);

  // The failure is arranged where it cannot be arranged by accident: the
  // destination's DIRECTORY is read-only, so creating the temp file fails.
  //
  // NOT established here: that a write failing PART WAY leaves the old tail
  // whole. That needs a full disk or a failing device, and neither can be
  // arranged from a test. What is established is that the failure path never
  // opens the destination at all, which is the property that makes the
  // part-way case safe -- and the inode assertion above is what proves the
  // successful path does not open it either.
  const roDir = join(eHome, "ro");
  mkdirSync(roDir, { recursive: true });
  const roDest = join(roDir, "tail.jsonl");
  writeFileSync(roDest, before);
  const roBefore = readFileSync(roDest);
  chmodSync(roDir, 0o500);
  const failed = runCli("export-events", "--hub", roDest);
  chmodSync(roDir, 0o700);
  check(failed.status !== 0, "an export that cannot be written refuses",
    (failed.stdout + failed.stderr).slice(0, 200));
  check(/the previous export is untouched/.test(failed.stdout + failed.stderr),
    "and says so, rather than leaving the operator to check", (failed.stdout + failed.stderr).slice(0, 240));
  // The BYTES. A length comparison passes on a file rewritten to the same size,
  // and truncate-then-fail is exactly the case being excluded.
  check(readFileSync(roDest).equals(roBefore),
    "and the previous tail survives the failure, byte for byte",
    `${readFileSync(roDest).length} vs ${roBefore.length}`);
  check(readdirSync(roDir).filter(f => f.includes(".tmp-")).length === 0,
    "and the temp file is reaped rather than left beside it", readdirSync(roDir).join(" "));
  rmSync(eHome, { recursive: true, force: true });
}

// ── a replayed key is validated BEFORE the delete branch ───────────────────
// The guard sat below the `h.delete` branch, so a `territory_lease.released`
// image with an incomplete key never reached it. Two distinct failures:
// an ABSENT column bound as `undefined` and aborted the restore with `Provided
// value cannot be bound to SQLite parameter 1` -- the opaque message the guard
// exists to replace; and a NULL one matched no row (`x = NULL` is never true in
// SQL), was still counted as `applied`, and appended the release event anyway,
// leaving the restored projection holding a lease its own log says was released.
//
// The guard WAS tested -- on the upsert path, via `pr_hold.created` above --
// which is why this survived: the covered path was the one that reached it.
{
  const rHome = mkdtempSync(join(tmpdir(), "reeve-replay-"));
  mkdirSync(join(rHome, "state"), { recursive: true });
  const db = openHub(hubPathFor(rHome));

  // The REAL columns. My first fixture invented `granted_at` and used a `kind`
  // the CHECK forbids, so it could not have replayed at all -- and `task` is a
  // NOT NULL foreign key, so the lease needs a task to point at.
  db.prepare(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
                          repo_path,profile_path,profile_hash,default_branch,visibility,
                          registry_version,created_at,updated_at)
              VALUES('bt:1','o/r',1,'o/r','t','FILED','founder','k',
                     '/r','/p.json','h','main','private',1,1,1)`).run();
  const grant = { project: "o/r", kind: "prefix", path: "src/**", task: "bt:1", expires_at: 9, pinned_until: null };
  // `at` and `task` too: replayHub re-appends each event into hub_event, whose
  // columns are NOT NULL, so an event shaped only for the handler cannot replay.
  const ev = (kind, payload, seq) => ({ seq, at: seq, task: null, kind, payload: JSON.stringify(payload) });

  // CONTROL FIRST: a complete pair replays, so the refusals below are about the
  // key and not about the fixture being unreplayable.
  const okRun = replayHub(db, [ev("territory_lease.granted", grant, 1),
                               ev("territory_lease.released", { project: "o/r", kind: "prefix", path: "src/**" }, 2)]);
  check(okRun.applied === 2,
    "control: a grant and a well-keyed release both replay", JSON.stringify(okRun));
  check(db.prepare("SELECT count(*) c FROM territory_lease").get().c === 0,
    "control: and the release actually removed the row", "");

  db.prepare("INSERT INTO territory_lease(project,kind,path,task,expires_at) VALUES(?,?,?,?,?)")
    .run(grant.project, grant.kind, grant.path, grant.task, grant.expires_at);

  let why = null;
  try { replayHub(db, [ev("territory_lease.released", { project: "o/r", kind: "prefix" }, 3)]); }
  catch (e) { why = e.message; }
  check(why != null && /missing or null in the key column\(s\) path/.test(why),
    "a delete whose image omits a key column is refused BY NAME, not by SQLite's binder", String(why));
  check(why != null && !/cannot be bound to SQLite parameter/.test(why),
    "and not with the opaque binder message the guard exists to replace", String(why));

  let nullWhy = null;
  try { replayHub(db, [ev("territory_lease.released", { project: "o/r", kind: "prefix", path: null }, 4)]); }
  catch (e) { nullWhy = e.message; }
  check(nullWhy != null && /missing or null in the key column\(s\) path/.test(nullWhy),
    "a key serialised as null is refused too, because `x = NULL` matches nothing", String(nullWhy));
  check(db.prepare("SELECT count(*) c FROM territory_lease").get().c === 1,
    "and the lease it claimed to release is still there, so nothing was counted as applied", "");

  db.close();
  rmSync(rHome, { recursive: true, force: true });
}

// ── a failed synthetic restore removes the file before it releases the lock ─
// The lock that keeps a builder out lives INSIDE the synthetic hub. Releasing
// it first opens a window in which a `reeve build run` starting in that instant
// opens the file, finds no maintenance lock, takes the singleton lease, and then
// has the file removed underneath it -- writing to an unnamed inode while the
// canonical path is absent.
//
// NOT TESTED, and it cannot be from here: the window itself has no deterministic
// seam. `restoreHub` exposes no hook between the release and the unlink, and
// racing a real builder against it would assert a timing, not a property. So the
// ORDER is asserted from the source, with controls that both anchors were found,
// and the outcome is asserted for real below.
{
  const src = readFileSync(join(ROOT, "src", "backup.mjs"), "utf8");
  const drop = src.indexOf(`for (const ext of ["", "-wal", "-shm"]) { try { rmSync(dbPath + ext, { force: true }); } catch {} }`);
  const release = src.indexOf(`if (locked && live)   { try { releaseMaintenanceLock(live,`);
  check(drop > 0, "control: the synthetic unlink was found in the source", String(drop));
  check(release > 0, "control: and the maintenance-lock release was found", String(release));
  check(drop > 0 && release > 0 && drop < release,
    "the synthetic hub is removed while the restore still holds exclusion, before any release",
    `unlink at ${drop}, release at ${release}`);
}
{
  // And the outcome, for real: an absent hub plus a tail that fails at replay.
  const sHome = mkdtempSync(join(tmpdir(), "reeve-synth-"));
  mkdirSync(join(sHome, "state"), { recursive: true });
  const src = openHub(hubPathFor(sHome));
  src.close();
  const snapRoot = join(sHome, "backups");
  const good = snapshot(openHub(hubPathFor(sHome)), snapRoot, "hub");
  check(good.ok, "fixture: a hub snapshot exists to restore from", JSON.stringify(good));

  const target = join(sHome, "state", "gone.db");
  check(!existsSync(target), "fixture: and the destination hub is absent, so the restore is synthetic", target);
  const badTail = Object.assign(
    [{ seq: 1, at: 1, kind: "territory_lease.released", payload: JSON.stringify({ project: "o/r", kind: "prefix" }) }],
    { manifest: null, sha256: null });
  const r = restoreHub(good.path, target, { isAlive: () => false, pid: process.pid, lstart: "L", force: true, tail: badTail });
  check(!r.ok, "a synthetic restore that fails at replay reports failure", JSON.stringify(r));
  check(!existsSync(target) && !existsSync(target + "-wal") && !existsSync(target + "-shm"),
    "and leaves no half-made hub at the canonical path, sidecars included",
    `${existsSync(target)} ${existsSync(target + "-wal")} ${existsSync(target + "-shm")}`);
  rmSync(sHome, { recursive: true, force: true });
}

// ── a supplied tail must be THIS hub's, not merely a valid export ──────────
// Every other check on `--tail` asks whether the file is internally consistent:
// its manifest matches its bytes, its seqs run without holes, its first follows
// the snapshot. A valid export from a DIFFERENT hub passes all of them --
// sequence numbers start at 1 everywhere, so the post-snapshot part lines up --
// and its events were replayed into the restored database, inserting unrelated
// authority rows and reporting success.
//
// The prefix through snapSeq is the only evidence of provenance the file has,
// and `export-events --hub` always writes it, because it writes the whole log.
{
  const fHome = mkdtempSync(join(tmpdir(), "reeve-foreign-"));
  mkdirSync(join(fHome, "state"), { recursive: true });
  const root = join(fHome, "backups");

  // Hub A: the one being restored. Two events, so the snapshot has a prefix.
  const a = join(fHome, "state", "a.db");
  const dbA = openHub(a);
  const mkTask = (db, id) => db.prepare(
    `INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
                      repo_path,profile_path,profile_hash,default_branch,visibility,
                      registry_version,created_at,updated_at)
     VALUES(?,'p',1,'o/r','t','FILED','founder',?, '/r','/p.json','h','main','private',1,1,1)`).run(id, id);
  mkTask(dbA, "bt:a1");
  hubEvent(dbA, { kind: "task.transitioned", task: "bt:a1", payload: { id: "bt:a1", phase: "SIZING" } });
  const snapA = snapshot(dbA, root, "hub");
  check(snapA.ok, "fixture: hub A is snapshotted", JSON.stringify(snapA));
  dbA.close();

  // Hub B: a DIFFERENT hub, with its own seq 1.. — a perfectly valid export.
  const b = join(fHome, "state", "b.db");
  const dbB = openHub(b);
  mkTask(dbB, "bt:b1");
  hubEvent(dbB, { kind: "task.transitioned", task: "bt:b1", payload: { id: "bt:b1", phase: "RESEARCH" } });
  hubEvent(dbB, { kind: "task.transitioned", task: "bt:b1", payload: { id: "bt:b1", phase: "DESIGN" } });
  const rowsB = dbB.prepare("SELECT seq, at, kind, task, payload FROM hub_event ORDER BY seq").all();
  dbB.close();
  const foreignPath = join(fHome, "foreign.jsonl");
  writeTail(foreignPath, rowsB);
  const foreign = readTail(foreignPath);
  check(foreign.manifest != null && foreign.sha256 === foreign.manifest.sha256,
    "fixture: the foreign tail's envelope is VALID, so the refusal is about provenance and nothing else",
    JSON.stringify(foreign.manifest));

  const target = join(fHome, "state", "target.db");
  const bad = restoreHub(snapA.path, target, { isAlive: () => false, pid: process.pid, lstart: "L", force: true, tail: foreign });
  check(!bad.ok, "a valid export from another hub is refused", JSON.stringify(bad).slice(0, 200));
  check(/not from the hub this snapshot was taken from/.test(String(bad.why)),
    "and the refusal says WHICH problem it is, not 'truncated' or 'has holes'", String(bad.why));
  check(/at seq \d+/.test(String(bad.why)),
    "and names the sequence where the two logs disagree, which is what an operator can act on", String(bad.why));

  // CONTROL: this hub's OWN export, over the same snapshot, is accepted. Without
  // it, refusing every tail satisfies all three assertions above.
  const dbA2 = openHub(a);
  hubEvent(dbA2, { kind: "task.transitioned", task: "bt:a1", payload: { id: "bt:a1", phase: "GATE" } });
  const rowsA = dbA2.prepare("SELECT seq, at, kind, task, payload FROM hub_event ORDER BY seq").all();
  dbA2.close();
  const ownPath = join(fHome, "own.jsonl");
  writeTail(ownPath, rowsA);
  const target2 = join(fHome, "state", "target2.db");
  const good = restoreHub(snapA.path, target2, { isAlive: () => false, pid: process.pid, lstart: "L", force: true, tail: readTail(ownPath) });
  check(good.ok, "control: this hub's own export IS accepted over its own snapshot", JSON.stringify(good).slice(0, 200));
  check(good.replayed === 1, "control: and the one post-snapshot event was replayed", JSON.stringify(good));

  // A tail with no prefix at all cannot be bound to anything, and says so.
  const noPrefixPath = join(fHome, "noprefix.jsonl");
  writeTail(noPrefixPath, rowsA.filter(e => e.seq > 2));
  const target3 = join(fHome, "state", "target3.db");
  const nop = restoreHub(snapA.path, target3, { isAlive: () => false, pid: process.pid, lstart: "L", force: true, tail: readTail(noPrefixPath) });
  check(!nop.ok && /carries no events at or before seq/.test(String(nop.why)),
    "a tail that begins after the snapshot is refused for having no provenance at all", String(nop.why));
  rmSync(fHome, { recursive: true, force: true });
}

// ── a version-zero hub is excluded where a bootstrapping builder looks ─────
// `rawOpen` returns null for a store with no completed migration, which sent it
// down the UNREADABLE path -- where the lock is taken in the SIBLING
// `.restore-lock`. But a version-zero hub is not unreadable to a `build run`:
// it bootstraps, completes migration 1 in the canonical file and takes its
// singleton there, never consulting the sibling. The restore then replaced that
// database without scanning its new holder.
//
// Exclusion has to live where the other writer will look for it, and that is
// `maintenance_lock` in `hub.db` -- what `acquireSingleton` reads through
// `assertWritable`.
{
  const zHome = mkdtempSync(join(tmpdir(), "reeve-zero-"));
  mkdirSync(join(zHome, "state"), { recursive: true });
  const root = join(zHome, "backups");
  const src = openHub(join(zHome, "state", "src.db"));
  const snapZ = snapshot(src, root, "hub");
  src.close();
  check(snapZ.ok, "fixture: a snapshot to restore from", JSON.stringify(snapZ));

  // A store in exactly the interrupted-first-run state.
  const target = join(zHome, "state", "zero.db");
  { const d = new DatabaseSync(target);
    d.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`);
    d.close(); }

  // A restore that FAILS after taking exclusion, so the lock is observable: a
  // foreign tail is refused after the branch has been chosen.
  //
  // The decisive observation is WHERE the lock was taken. On the old path it was
  // the sibling `.restore-lock`, and `hub.db` carried none -- which is what let
  // a bootstrapping builder in.
  let lockedIn = null;
  const probe = restoreHub(snapZ.path, target, {
    isAlive: () => false, pid: process.pid, lstart: "L", force: true,
    tail: Object.assign([{ seq: 1, at: 1, kind: "task.transitioned", task: null, payload: "{}" }],
                        { manifest: null, sha256: null }),
  });
  check(!probe.ok, "fixture: the restore fails after choosing its branch", JSON.stringify(probe).slice(0, 160));
  check(!existsSync(target + ".restore-lock"),
    "a version-zero hub does not send the restore to the sibling lock a builder never reads",
    `${existsSync(target + ".restore-lock")}`);
  // The file itself was kept, because a recovery that destroys what it replaced
  // cannot be audited -- the property the unreadable path already had.
  //
  // ON DISK, not in the result: a FAILED restore returns { ok, why, holders }
  // and never names its quarantine, so reading `probe.quarantined` here asks
  // the wrong object and answers `undefined` whatever the truth is. The
  // successful path's naming is asserted separately, further up this file.
  const kept = readdirSync(join(zHome, "state")).filter(f => f.startsWith("zero.db.incomplete-"));
  check(kept.length === 1,
    "and the unfinished file is kept rather than destroyed by the migration",
    readdirSync(join(zHome, "state")).join(" "));
  check(kept.length === 1 && !kept[0].includes(".corrupt-"),
    "and named incomplete rather than corrupt, since an operator is about to look at it",
    kept.join(" "));

  // CONTROL: a genuinely UNREADABLE hub still takes the sibling lock, so the
  // assertion above is about version zero and not about the sibling path having
  // been removed.
  const corrupt = join(zHome, "state", "corrupt.db");
  writeFileSync(corrupt, "this is not a database");
  const c = restoreHub(snapZ.path, corrupt, {
    isAlive: () => false, pid: process.pid, lstart: "L", force: true,
    tail: Object.assign([{ seq: 1, at: 1, kind: "task.transitioned", task: null, payload: "{}" }],
                        { manifest: null, sha256: null }),
  });
  check(!c.ok, "control: an unreadable hub's restore also fails on the same tail", JSON.stringify(c).slice(0, 160));
  check(existsSync(corrupt + ".restore-lock"),
    "control: and IT does use the sibling lock, because nothing can be written into it",
    `${existsSync(corrupt + ".restore-lock")}`);
  rmSync(zHome, { recursive: true, force: true });
}

// ── a hub whose LOCK SCHEMA is damaged is recoverable ──────────────────────
// The version query answering is not readiness either. A version-1 hub that has
// lost `maintenance_lock` passes `rawOpen`, and `acquireMaintenanceLock` then
// throws `no such table: maintenance_lock` straight past every recovery path --
// so `restore --hub --force`, the command for exactly this, refused to install a
// snapshot it had already validated.
//
// Readable now means "this branch can do its work", and its work is the four
// lock tables it queries.
{
  const lHome = mkdtempSync(join(tmpdir(), "reeve-lockdmg-"));
  mkdirSync(join(lHome, "state"), { recursive: true });
  const src = openHub(join(lHome, "state", "src.db"));
  const snapL = snapshot(src, join(lHome, "backups"), "hub");
  src.close();
  check(snapL.ok, "fixture: a snapshot to restore from", JSON.stringify(snapL));

  for (const dropped of ["maintenance_lock", "singleton_lease", "writer_lease", "provider_lease"]) {
    const target = join(lHome, "state", `${dropped}.db`);
    openHub(target).close();
    { const d = new DatabaseSync(target); d.exec(`DROP TABLE ${dropped}`); d.close(); }
    // CONTROL per table: the store still answers the version query, which is
    // exactly what made it look readable.
    { const q = new DatabaseSync(target, { readOnly: true });
      const v = q.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
      q.close();
      check(v === 1, `fixture: the hub missing ${dropped} still reports version 1`, `version ${v}`); }

    const r = restoreHub(snapL.path, target, { isAlive: () => false, pid: process.pid, lstart: "L", force: true });
    check(r.ok, `a hub missing ${dropped} is recovered rather than refused`, JSON.stringify(r).slice(0, 200));
    check(!/no such table/.test(String(r.why ?? "")),
      `and not with \`no such table: ${dropped}\``, String(r.why));
    const q = new DatabaseSync(target, { readOnly: true });
    const tables = q.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
    q.close();
    check(tables === 32, `and the store is whole afterwards (missing ${dropped})`, `${tables} tables`);
  }

  // CONTROL: an INTACT hub is still classified readable, so the check above did
  // not simply route every restore down the recovery path -- which would pass
  // every assertion here while quarantining healthy databases.
  const intact = join(lHome, "state", "intact.db");
  openHub(intact).close();
  const ok = restoreHub(snapL.path, intact, { isAlive: () => false, pid: process.pid, lstart: "L" });
  check(ok.ok, "control: an intact hub restores WITHOUT force", JSON.stringify(ok).slice(0, 160));
  check(!ok.quarantined,
    "control: and is not quarantined, because it was never classified unreadable", String(ok.quarantined));
  rmSync(lHome, { recursive: true, force: true });
}

// ── the window between CREATING the hub and LOCKING it ─────────────────────
// `openHub` creates and migrates the file; the next statement writes the lock
// into it. A `build run` starting inside that window finds a fully migrated hub
// with no lock, takes its singleton, and is still holding it when the restore
// replaces the file. The readable branch has always scanned for holders; this
// one never did, because "we just made it" was taken to mean nobody else could
// be in it.
//
// The window cannot be closed by ordering -- there is no create-and-lock in one
// step -- so it is closed by LOOKING afterwards, and anything that got in is
// recorded in `singleton_lease`.
{
  const wHome = mkdtempSync(join(tmpdir(), "reeve-window-"));
  mkdirSync(join(wHome, "state"), { recursive: true });
  const src = openHub(join(wHome, "state", "src.db"));
  const snapW = snapshot(src, join(wHome, "backups"), "hub");
  src.close();

  // The builder that got in, and a hub that takes the CREATION branch.
  //
  // A first fixture put the lease in a version-1 store, which `rawOpen` calls
  // readable -- so the readable branch's own scan refused it and the new code
  // never ran at all. The refusal looked right and proved nothing.
  //
  // This one is a store with migration 1's tables and NO version rows: exactly
  // what an interrupted migration leaves, and what `readableVersion` answers 0
  // for. It therefore takes the creation branch, `openHub` re-applies migration
  // 1 over the existing tables, and the lease a builder took is still sitting
  // there when the new scan looks. The refusal's own wording is the
  // discriminator -- the readable branch says "the hub has live writers", and
  // only this path says a builder started while the restore was preparing it.
  const target = join(wHome, "state", "raced.db");
  const born = openHub(target);
  born.prepare(`INSERT INTO singleton_lease(name,pid,lstart,command,acquired_at,expires_at)
                VALUES('builder',?,?, 'reeve build run', unixepoch(), unixepoch()+120)`)
    .run(4242, "L4242");
  born.exec("DELETE FROM schema_version");
  born.close();
  { const q = new DatabaseSync(target, { readOnly: true });
    const v = q.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
    const leases = q.prepare("SELECT count(*) c FROM singleton_lease").get().c;
    q.close();
    check(v === 0 && leases === 1,
      "fixture: the hub reports version 0 and already carries a builder's lease",
      `version ${v}, ${leases} lease(s)`); }

  const alive = (pid) => pid === 4242;
  const r = restoreHub(snapW.path, target, { isAlive: alive, pid: process.pid, lstart: "me", force: true });
  check(!r.ok, "a restore refuses while a builder holds the hub's singleton", JSON.stringify(r).slice(0, 200));
  check(/while this restore was preparing it/.test(String(r.why)),
    "and it is the CREATION branch that refused, not the readable one that always scanned",
    String(r.why).slice(0, 200));
  check(r.holders?.some(h => h.pid === 4242),
    "and names the holder, so an operator knows what to stop", JSON.stringify(r.holders));
  check(existsSync(target),
    "and does NOT delete the file the builder is writing to", `${existsSync(target)}`);

  // THAT ASSERTION IS TRUE HERE FOR A WEAKER REASON, and saying so is the point.
  // This fixture's hub already EXISTS, so `synthetic` is false before the scan
  // runs and the finally has no authority to delete anything: measured, removing
  // the `synthetic = false` guard leaves every assertion above green.
  //
  // The case the guard is for is the ABSENT hub, where this invocation created
  // the file and may delete it -- and that one has no deterministic seam: the
  // builder has to arrive between `openHub` returning and the scan reading, and
  // nothing in `restoreHub` can be driven to that instant from a test. So the
  // guard is asserted from the source, with a control that both anchors exist.
  {
    const src = readFileSync(join(ROOT, "src", "backup.mjs"), "utf8");
    const scan = src.indexOf("if (bornHolders.length) {");
    const disown = src.indexOf("synthetic = false;", scan);
    const ret = src.indexOf("return { ok: false, holders: bornHolders,", scan);
    check(scan > 0 && ret > 0, "control: the creation-branch refusal was found in the source", `${scan} ${ret}`);
    check(disown > 0 && disown < ret,
      "the creation branch disowns the file before refusing, so the finally cannot delete a hub a builder holds",
      `scan ${scan}, disown ${disown}, return ${ret}`);
  }

  // CONTROL: with the holder DEAD, the same restore proceeds -- so the refusal
  // is about liveness rather than about any lease row at all.
  const r2 = restoreHub(snapW.path, target, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
  check(r2.ok, "control: with the holder dead, the restore proceeds", JSON.stringify(r2).slice(0, 200));
  rmSync(wHome, { recursive: true, force: true });
}

// ── a PARTIALLY damaged hub keeps every answer it can still give ───────────
// Routing it down the unreadable path was a blunt fix: that path is defined by
// what it CANNOT do -- no holder enumeration, no version check, no live tail --
// and applying it to a hub that can still answer three of those four questions
// threw away every answer it had. Four separate losses, one cause.
{
  const pHome = mkdtempSync(join(tmpdir(), "reeve-partial-"));
  mkdirSync(join(pHome, "state"), { recursive: true });
  const src = openHub(join(pHome, "state", "src.db"));
  const snapP = snapshot(src, join(pHome, "backups"), "hub");
  src.close();
  const holed = (name, table, fill = () => {}) => {
    const t = join(pHome, "state", name + ".db");
    const d = openHub(t); fill(d); d.close();
    const q = new DatabaseSync(t); q.exec(`DROP TABLE ${table}`); q.close();
    return t;
  };

  // 1. A LIVE HOLDER in a table that still exists is still refused.
  // The unreadable path enumerates nothing, so a live builder in
  // `singleton_lease` went unseen whenever `provider_lease` was the missing one.
  {
    const t = holed("liveholder", "provider_lease", d =>
      d.prepare(`INSERT INTO singleton_lease(name,pid,lstart,command,acquired_at,expires_at)
                 VALUES('builder',?,?, 'reeve build run', unixepoch(), unixepoch()+120)`).run(4242, "L"));
    const r = restoreHub(snapP.path, t, { isAlive: p => p === 4242, pid: process.pid, lstart: "me", force: true });
    check(!r.ok, "a live builder is refused even when another lease table is gone", JSON.stringify(r).slice(0, 160));
    check(r.holders?.some(x => x.pid === 4242),
      "and named, from the table that still exists", JSON.stringify(r.holders));
    check(/force does not override a LIVE holder/.test(String(r.why)),
      "and force does not waive it, exactly as on an intact hub", String(r.why).slice(0, 120));
  }

  // 2. THE FORWARD-VERSION REFUSAL still runs. `rawOpen` used to return null
  // before it, so a forced restore replaced a hub NEWER than this binary with
  // this binary's older snapshot -- state lost, exit 0.
  {
    const t = holed("newer", "maintenance_lock");
    { const d = new DatabaseSync(t);
      d.prepare("INSERT INTO schema_version(version,applied_at) VALUES(?,unixepoch())").run(HUB_SCHEMA_VERSION + 5);
      d.close(); }
    const r = restoreHub(snapP.path, t, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
    check(!r.ok, "a hub NEWER than this binary is refused even with a hole in it", JSON.stringify(r).slice(0, 160));
    check(new RegExp(`schema version ${HUB_SCHEMA_VERSION + 5}`).test(String(r.why)),
      "and the refusal names the version, not the hole", String(r.why).slice(0, 140));
  }

  // 3. THE LIVE EVENT TAIL survives. Losing a LOCK table does not make
  // `hub_event` unreadable, and discarding it exited 0 having thrown away every
  // post-snapshot event -- the one thing a restore is supposed to carry forward.
  {
    const FULL = { id: "bt:9", project: "p", repo_id: 1, nwo_snapshot: "o/r", title: "t", priority: "p2",
      phase: "SIZING", generation: 1, slice_cursor: 0, resume_seq: 0, source_kind: "founder", source_key: "k",
      repo_path: "/r", profile_path: "/p", profile_hash: "h", default_branch: "main", visibility: "private",
      registry_version: 1, created_at: 1, updated_at: 1 };
    // `task: null` on the event row: `hub_event.task` is a foreign key to
    // `task(id)`, and the staging database does not carry that row until this
    // very event is applied.
    const t = holed("tail", "writer_lease", d =>
      d.prepare("INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),'task.filed',NULL,?)")
        .run(JSON.stringify(FULL)));
    const r = restoreHub(snapP.path, t, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
    check(r.ok, "a hub with a hole still restores", JSON.stringify(r).slice(0, 160));
    check(r.liveTailRead === true && r.tail === 1 && r.replayed === 1,
      "and its readable event log is carried forward, not discarded",
      `liveTailRead=${r.liveTailRead} tail=${r.tail} replayed=${r.replayed}`);
    const back = new DatabaseSync(t, { readOnly: true });
    const kept = back.prepare("SELECT count(*) c FROM task WHERE id='bt:9'").get().c;
    back.close();
    check(kept === 1, "and the row that event carried is in the restored database", `${kept}`);
  }

  // 4. FORCE IS STILL REQUIRED, because a lease in a table that is gone cannot
  // be ruled out -- the same ignorance the unreadable path demands force for,
  // narrowed to the tables actually missing.
  {
    const t = holed("noforce", "singleton_lease");
    const r = restoreHub(snapP.path, t, { isAlive: () => false, pid: process.pid, lstart: "me" });
    check(!r.ok, "a partial hub is not restored without force", JSON.stringify(r).slice(0, 160));
    check(/missing singleton_lease/.test(String(r.why)),
      "and the refusal names which table is missing, so the risk is legible", String(r.why).slice(0, 200));
    check(/event log IS readable/.test(String(r.why)),
      "and whether the history is recoverable, which decides if --tail is needed", String(r.why).slice(0, 240));

    const forced = restoreHub(snapP.path, t, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
    check(forced.ok, "and force is what carries it through", JSON.stringify(forced).slice(0, 160));
    check(/\.damaged-/.test(String(forced.quarantined)) && existsSync(forced.quarantined),
      "with the damaged file kept, named for what it is rather than as rubble",
      String(forced.quarantined));
  }

  // CONTROL: an INTACT hub is untouched by all of this -- no force, no
  // quarantine. Without it, a fix that treated every hub as partial would
  // satisfy every assertion above.
  {
    const t = join(pHome, "state", "intact.db");
    openHub(t).close();
    const r = restoreHub(snapP.path, t, { isAlive: () => false, pid: process.pid, lstart: "me" });
    check(r.ok, "control: an intact hub restores without force", JSON.stringify(r).slice(0, 160));
    check(!r.quarantined, "control: and is not quarantined", String(r.quarantined));
  }
  rmSync(pHome, { recursive: true, force: true });
}

// ── the creation-window scan counts a held PROVIDER lease ──────────────────
// A guardian holds one whenever it is dispatching, and it can take one in the
// window this scan exists to close. The readable path has always counted a held
// provider lease as a live writer; leaving it out here made the two paths
// disagree about what "live" means.
{
  const gHome = mkdtempSync(join(tmpdir(), "reeve-provider-"));
  mkdirSync(join(gHome, "state"), { recursive: true });
  const src = openHub(join(gHome, "state", "src.db"));
  const snapG = snapshot(src, join(gHome, "backups"), "hub");
  src.close();

  // The same version-zero-with-tables fixture the creation-window drill uses:
  // migration 1's tables present, no version rows, so it takes the CREATION
  // branch -- and a guardian's provider lease already in it.
  const target = join(gHome, "state", "raced.db");
  const born = openHub(target);
  born.prepare(`INSERT INTO provider_lease(owner, repo_id, run_ref, pid, lstart, status, requested_at, expires_at)
                VALUES('guardian', 1, 'run-7', ?, ?, 'held', unixepoch(), unixepoch()+300)`).run(5150, "L5150");
  born.exec("DELETE FROM schema_version");
  born.close();

  const r = restoreHub(snapG.path, target, { isAlive: p => p === 5150, pid: process.pid, lstart: "me", force: true });
  check(!r.ok, "a restore refuses while a guardian holds a provider lease in the hub it is creating",
    JSON.stringify(r).slice(0, 200));
  check(/while this restore was preparing it/.test(String(r.why)),
    "and it is the CREATION branch that refused", String(r.why).slice(0, 160));
  check(r.holders?.some(h => h.pid === 5150 && h.what === "guardian"),
    "and the holder is named as the guardian it is", JSON.stringify(r.holders));

  // CONTROL: a QUEUED lease raises nothing. 'queued' and 'held' are the only
  // two statuses the column allows, and the readable path counts only 'held' --
  // a guardian waiting for the provider is not one dispatching against the hub.
  // So the scan is about a live dispatch, not about the row existing.
  const target2 = join(gHome, "state", "notheld.db");
  const b2 = openHub(target2);
  b2.prepare(`INSERT INTO provider_lease(owner, repo_id, run_ref, pid, lstart, status, requested_at, expires_at)
              VALUES('guardian', 1, 'run-8', ?, ?, 'queued', unixepoch(), unixepoch()+300)`).run(5151, "L5151");
  b2.exec("DELETE FROM schema_version");
  b2.close();
  const r2 = restoreHub(snapG.path, target2, { isAlive: p => p === 5151, pid: process.pid, lstart: "me", force: true });
  check(r2.ok, "control: a provider lease that is not held does not refuse the restore",
    JSON.stringify(r2).slice(0, 200));
  rmSync(gHome, { recursive: true, force: true });
}

// ── two kinds of damage, and they cost different things ───────────────────
// A missing LOCK table is a SAFETY question: a lease held in it cannot be ruled
// out. A missing EVENT LOG is a LOSS question: nothing held there can hurt
// anyone, but every event after the snapshot goes with it.
//
// Excluding `hub_event` from the lock set was right for the first question and
// wrong for the second: a hub with all four lock tables and no event log read as
// INTACT, so it was replaced with no force, no quarantine and an empty tail --
// discarding every post-snapshot projection change and exiting 0. Over-corrected
// from the opposite defect, where a READABLE log was thrown away because a lock
// table was gone.
{
  const eHome = mkdtempSync(join(tmpdir(), "reeve-noevents-"));
  mkdirSync(join(eHome, "state"), { recursive: true });
  const src = openHub(join(eHome, "state", "src.db"));
  const snapE = snapshot(src, join(eHome, "backups"), "hub");
  src.close();
  const noLog = (name) => {
    const t = join(eHome, "state", name + ".db");
    openHub(t).close();
    const d = new DatabaseSync(t); d.exec("DROP TABLE hub_event"); d.close();
    return t;
  };

  const t1 = noLog("plain");
  const bare = restoreHub(snapE.path, t1, { isAlive: () => false, pid: process.pid, lstart: "me" });
  check(!bare.ok, "a hub whose event log is gone is not replaced silently", JSON.stringify(bare).slice(0, 160));
  check(/event log cannot be read/.test(String(bare.why)),
    "and the refusal is about the LOSS, not about a lock table", String(bare.why).slice(0, 200));
  check(/every event after the snapshot would be lost/.test(String(bare.why)),
    "and says what is at stake before anything is overwritten", String(bare.why).slice(0, 240));
  check(/pass --tail from a durable export-events --hub/.test(String(bare.why)),
    "and names the one thing that recovers it", String(bare.why).slice(0, 300));

  const forced = restoreHub(snapE.path, t1, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
  check(forced.ok, "force accepts the loss and restores", JSON.stringify(forced).slice(0, 160));
  check(/\.damaged-/.test(String(forced.quarantined)) && existsSync(forced.quarantined),
    "and the file is kept, because a hub that lost its history is one to look at",
    String(forced.quarantined));

  // A SUPPLIED TAIL answers the loss question, so it is not damage the operator
  // has to confirm -- it is the recovery they have already performed. No force.
  const t2 = noLog("withtail");
  const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const tail = Object.assign([], { manifest: { count: 0, first: null, last: null, sha256: EMPTY_SHA }, sha256: EMPTY_SHA });
  const withTail = restoreHub(snapE.path, t2, { isAlive: () => false, pid: process.pid, lstart: "me", tail });
  check(withTail.ok, "a supplied tail restores it WITHOUT force, because the history is not lost",
    JSON.stringify(withTail).slice(0, 200));
  check(/\.damaged-/.test(String(withTail.quarantined)),
    "and the damaged file is still kept, because a tail does not make it whole",
    String(withTail.quarantined));
  rmSync(eHome, { recursive: true, force: true });
}

// ── a table LISTED is not a table READABLE ────────────────────────────────
// `sqlite_master` records that a table was created, not that it can be read. A
// corrupt root page leaves the name in the catalogue and throws on first access,
// so the presence check called it available and the holder query then died in
// the outer catch -- `could not restore`, from the command that exists to
// recover exactly that file.
{
  const cHome = mkdtempSync(join(tmpdir(), "reeve-btree-"));
  mkdirSync(join(cHome, "state"), { recursive: true });
  const src = openHub(join(cHome, "state", "src.db"));
  const snapC = snapshot(src, join(cHome, "backups"), "hub");
  src.close();

  const t = join(cHome, "state", "corrupt.db");
  const d = openHub(t);
  d.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
             VALUES('guardian',1,'r',1,'L','held',unixepoch(),unixepoch()+9)`).run();
  const root = d.prepare("SELECT rootpage FROM sqlite_master WHERE name='provider_lease'").get().rootpage;
  const pageSize = d.prepare("PRAGMA page_size").get().page_size;
  d.close();
  // Overwrite that table's root page and nothing else, so the CATALOGUE stays
  // intact and only this one b-tree is unreadable.
  const buf = readFileSync(t);
  buf.fill(0x5a, (root - 1) * pageSize, root * pageSize);
  writeFileSync(t, buf);

  // The fixture's two halves, asserted separately: the name is still listed, and
  // reading it throws. Without both, this could pass against a file that is
  // simply corrupt all over -- which the unreadable path already handled.
  const probe = new DatabaseSync(t, { readOnly: true });
  const listed = probe.prepare("SELECT count(*) c FROM sqlite_master WHERE name='provider_lease'").get().c;
  let readThrows = false;
  try { probe.prepare("SELECT * FROM provider_lease LIMIT 1").get(); } catch { readThrows = true; }
  const versionStillReadable = probe.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
  probe.close();
  check(listed === 1, "fixture: the corrupt table is still listed in sqlite_master", `${listed}`);
  check(readThrows, "fixture: and reading it throws", `${readThrows}`);
  check(versionStillReadable === 1,
    "fixture: while the rest of the hub is fine, which is what made it look readable",
    `version ${versionStillReadable}`);

  const r = restoreHub(snapC.path, t, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
  check(r.ok, "a hub with one unreadable lease table is recovered, not abandoned", JSON.stringify(r).slice(0, 200));
  check(!/could not restore/.test(String(r.why ?? "")),
    "and not through the outer catch, which is where the holder query used to die", String(r.why));
  check(/\.damaged-/.test(String(r.quarantined)),
    "and it is treated as damaged, exactly like a table that is gone", String(r.quarantined));
  rmSync(cHome, { recursive: true, force: true });
}

// ── the read that MATTERS is the read that decides ────────────────────────
// `SELECT … LIMIT 1` touches the FIRST leaf; `.all()` walks every one. So a lease
// table spanning several pages with damage in a LATER leaf passed the probe and
// then threw during enumeration — and that throw escaped to the outer catch as
// `could not restore`, past every recovery path, from the command that exists to
// recover it.
//
// Probing harder is the same shape one size up. A probe is a DIFFERENT QUERY
// from the one that follows it, and a different query can succeed where the real
// one throws. So each lease read reports its own failure and the table joins
// `missing` at that point.
{
  const lHome = mkdtempSync(join(tmpdir(), "reeve-leaf-"));
  mkdirSync(join(lHome, "state"), { recursive: true });
  const src = openHub(join(lHome, "state", "src.db"));
  const snapL = snapshot(src, join(lHome, "backups"), "hub");
  src.close();

  const t = join(lHome, "state", "multileaf.db");
  const d = openHub(t);
  // EVERY row 'held', so the holder scan's `WHERE status='held'` must walk the
  // whole table. With them all 'queued' the scan answers from an index without
  // touching the damaged leaf, and the fixture proves nothing — measured.
  const ins = d.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
                         VALUES('guardian',?,?,1,'L','held',unixepoch(),unixepoch()+9)`);
  for (let i = 0; i < 400; i++) ins.run(i, "run-" + "x".repeat(180) + i);
  d.close();

  const meta = new DatabaseSync(t, { readOnly: true });
  const pages = meta.prepare("SELECT pageno FROM dbstat WHERE name='provider_lease' ORDER BY pageno").all();
  const pageSize = meta.prepare("PRAGMA page_size").get().page_size;
  meta.close();
  check(pages.length > 2, "fixture: provider_lease spans several b-tree pages", `${pages.length} pages`);
  // A LATE leaf, never the root — the root case is the one already covered above.
  const buf = readFileSync(t);
  const victim = pages[pages.length - 1].pageno;
  buf.fill(0x5a, (victim - 1) * pageSize, victim * pageSize);
  writeFileSync(t, buf);

  // The fixture's decisive property, asserted as TWO facts: the probe passes and
  // the real query throws. Without both this is just another corrupt table.
  const probe = new DatabaseSync(t, { readOnly: true });
  let limit1 = false, full = false;
  try { probe.prepare("SELECT * FROM provider_lease LIMIT 1").get(); limit1 = true; } catch { /* recorded below */ }
  try { probe.prepare("SELECT * FROM provider_lease WHERE status='held'").all(); full = true; } catch { /* recorded below */ }
  probe.close();
  check(limit1, "fixture: a LIMIT 1 probe still succeeds on it", `${limit1}`);
  check(!full, "fixture: while the query the holder scan actually runs throws", `${full}`);

  const r = restoreHub(snapL.path, t, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
  check(r.ok, "a table that throws only on the FULL scan is recovered, not abandoned",
    JSON.stringify(r).slice(0, 200));
  check(!/could not restore/.test(String(r.why ?? "")),
    "and not through the outer catch, which is where --force could not reach", String(r.why));
  check(/\.damaged-/.test(String(r.quarantined)),
    "and the file is quarantined, because the scan found damage the probe did not",
    String(r.quarantined));
  rmSync(lHome, { recursive: true, force: true });
}

// ── a failed lock ACQUISITION is not evidence of a damaged lock TABLE ──────
// My previous version caught any throw from `acquireMaintenanceLock`, pushed
// `maintenance_lock` into `missing`, and continued under the sibling lock.
// `SQLITE_BUSY` leaves that table perfectly readable — the attempt failed, the
// table did not — and hub writers consult ONLY the canonical table, so that
// silently downgraded exclusion to a file nothing else reads. With `force` a
// writer could then start after the holder scan and be replaced.
{
  const bHome = mkdtempSync(join(tmpdir(), "reeve-busy-"));
  mkdirSync(join(bHome, "state"), { recursive: true });
  const src = openHub(join(bHome, "state", "src.db"));
  const snapB = snapshot(src, join(bHome, "backups"), "hub");
  src.close();
  const t = join(bHome, "state", "busy.db");
  openHub(t).close();

  // A real SQLITE_BUSY, not a simulated one: a second connection holding an
  // EXCLUSIVE write lock, so `acquireMaintenanceLock`'s BEGIN IMMEDIATE cannot
  // proceed. Costs the hub's 10s busy timeout, and it is deterministic.
  const blocker = new DatabaseSync(t, { timeout: 100 });
  blocker.exec("PRAGMA busy_timeout = 100");
  blocker.exec("BEGIN EXCLUSIVE");
  const r = restoreHub(snapB.path, t, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
  blocker.exec("ROLLBACK");
  blocker.close();

  check(!r.ok, "a transient lock failure refuses the restore", JSON.stringify(r).slice(0, 160));
  check(/busy or transient failure rather than damage/.test(String(r.why)),
    "and says it is transient rather than treating the table as damaged", String(r.why).slice(0, 200));
  // THE DECISIVE ONE. On the previous implementation the sibling store is
  // created and the restore proceeds under it — exclusion nothing else reads.
  check(!existsSync(t + ".restore-lock"),
    "and does NOT fall back to the sibling lock, which hub writers never consult",
    `${existsSync(t + ".restore-lock")}`);
  check(existsSync(t), "and leaves the hub where it was", `${existsSync(t)}`);

  // CONTROL: with the blocker gone the same restore succeeds, so the refusal is
  // about the lock being unavailable rather than about this hub or snapshot.
  const ok = restoreHub(snapB.path, t, { isAlive: () => false, pid: process.pid, lstart: "me" });
  check(ok.ok, "control: unblocked, the same restore succeeds", JSON.stringify(ok).slice(0, 160));
  rmSync(bHome, { recursive: true, force: true });
}

// ── a VERSION-ZERO hub still has an event log ─────────────────────────────
// `liveHasEvents` was set only where `rawOpen` classified the store, so a hub
// whose `schema_version` was emptied — a damaged migration marker, with every
// table and every row intact — came through the bootstrap branch with the flag
// still false. The tail query was skipped and the restore reported success after
// discarding every post-snapshot event.
{
  const zHome = mkdtempSync(join(tmpdir(), "reeve-zerotail-"));
  mkdirSync(join(zHome, "state"), { recursive: true });
  const src = openHub(join(zHome, "state", "src.db"));
  const snapZ = snapshot(src, join(zHome, "backups"), "hub");
  src.close();

  const FULL = { id: "bt:9", project: "p", repo_id: 1, nwo_snapshot: "o/r", title: "t", priority: "p2",
    phase: "SIZING", generation: 1, slice_cursor: 0, resume_seq: 0, source_kind: "founder", source_key: "k",
    repo_path: "/r", profile_path: "/p", profile_hash: "h", default_branch: "main", visibility: "private",
    registry_version: 1, created_at: 1, updated_at: 1 };
  const t = join(zHome, "state", "zeroevents.db");
  const d = openHub(t);
  d.prepare("INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),'task.filed',NULL,?)").run(JSON.stringify(FULL));
  d.exec("DELETE FROM schema_version");
  d.close();
  // CONTROL: this really is the bootstrap-zero state AND the log really is there.
  { const q = new DatabaseSync(t, { readOnly: true });
    const v = q.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
    const n = q.prepare("SELECT count(*) c FROM hub_event").get().c;
    q.close();
    check(v === 0 && n === 1, "fixture: version 0, with one event still readable", `version ${v}, ${n} event(s)`); }

  const r = restoreHub(snapZ.path, t, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
  check(r.ok, "a version-zero hub restores", JSON.stringify(r).slice(0, 160));
  check(r.tail === 1 && r.replayed === 1,
    "and its event log is carried forward rather than skipped", `tail=${r.tail} replayed=${r.replayed}`);
  const back = new DatabaseSync(t, { readOnly: true });
  const kept = back.prepare("SELECT count(*) c FROM task WHERE id='bt:9'").get().c;
  back.close();
  check(kept === 1, "and the row that event carried is in the restored database", `${kept}`);
  rmSync(zHome, { recursive: true, force: true });
}

// ── the TAIL read reports its own failure too ─────────────────────────────
// `hub_event` is the table most likely to span many leaves — it is the only one
// that grows without bound — so the probe passing while the full query throws is
// likelier here than anywhere else, and the throw landed in the outer catch as
// `could not restore`, where `--force` could not reach it.
{
  const tHome = mkdtempSync(join(tmpdir(), "reeve-bigtail-"));
  mkdirSync(join(tHome, "state"), { recursive: true });
  const src = openHub(join(tHome, "state", "src.db"));
  const snapT = snapshot(src, join(tHome, "backups"), "hub");
  src.close();

  const t = join(tHome, "state", "bigtail.db");
  const d = openHub(t);
  const ins = d.prepare("INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),'task.filed',NULL,?)");
  for (let i = 0; i < 400; i++) ins.run(JSON.stringify({ id: "bt:" + i, title: "t".repeat(180) }));
  d.close();
  const meta = new DatabaseSync(t, { readOnly: true });
  const pages = meta.prepare("SELECT pageno FROM dbstat WHERE name='hub_event' ORDER BY pageno").all();
  const ps = meta.prepare("PRAGMA page_size").get().page_size;
  meta.close();
  check(pages.length > 2, "fixture: hub_event spans several b-tree pages", `${pages.length} pages`);
  const buf = readFileSync(t);
  const victim = pages[pages.length - 1].pageno;
  buf.fill(0x5a, (victim - 1) * ps, victim * ps);
  writeFileSync(t, buf);
  { const q = new DatabaseSync(t, { readOnly: true });
    let l1 = false, full = false;
    try { q.prepare("SELECT * FROM hub_event LIMIT 1").get(); l1 = true; } catch { /* asserted below */ }
    try { q.prepare("SELECT seq FROM hub_event WHERE seq > 0").all(); full = true; } catch { /* asserted below */ }
    q.close();
    check(l1 && !full, "fixture: the probe passes and the tail query throws", `LIMIT1=${l1} full=${full}`); }

  const bare = restoreHub(snapT.path, t, { isAlive: () => false, pid: process.pid, lstart: "me" });
  check(!bare.ok, "an unreadable event log refuses without force", JSON.stringify(bare).slice(0, 160));
  check(/cannot be read past the first page/.test(String(bare.why)),
    "and says the log is the problem, naming the loss", String(bare.why).slice(0, 220));
  check(!/could not restore/.test(String(bare.why)),
    "and not through the outer catch, where --force could not reach it", String(bare.why).slice(0, 120));

  const forced = restoreHub(snapT.path, t, { isAlive: () => false, pid: process.pid, lstart: "me", force: true });
  check(forced.ok, "and force accepts the loss and restores", JSON.stringify(forced).slice(0, 160));
  check(/\.damaged-/.test(String(forced.quarantined)) && existsSync(forced.quarantined),
    "with the damaged file kept", String(forced.quarantined));
  rmSync(tHome, { recursive: true, force: true });
}

rmSync(home, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
