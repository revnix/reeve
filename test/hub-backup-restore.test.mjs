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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";   // the CLI drill runs bin/reeve
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  check(hub?.ok === false && hub?.deferred === true,
    "snapshotAll reports a lost publish as deferred, not as a backup it can vouch for",
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
  const tailEvents = [{ seq: snapMax + 1, at: 1, kind: "task.transitioned", task: "bt:2",
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
  const runCli = (args) => spawnSync(process.execPath, ["bin/reeve", ...args],
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

rmSync(home, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
