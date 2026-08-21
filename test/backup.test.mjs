// reeve's entire memory — every decision, every run, every settlement — lived in
// one file on one laptop, with no second copy anywhere. `exportJsonl` existed and
// nothing ever called it: a fire extinguisher still in its box.
//
// This tests the RESTORE, not the write. A backup nobody has restored is a
// hypothesis, and the failure mode of an untested one is that you discover it on
// the day you need it.
//
// A snapshot rather than an event replay, deliberately: replaying reeve's own
// events back into a store would need code that understands every op, and that
// code would be one more thing that can be subtly wrong at the worst moment.
// `VACUUM INTO` produces a byte-exact database that restores by being copied back.
import { open, snapshot, restore as restoreRaw, exportEvents, latestSnapshot } from "../src/backup.mjs";

// Every restore here states the daemon condition explicitly. Left implicit, the
// result depended on whether a real reeve daemon happened to be running on the
// machine running the test — which it was, so the suite failed for a reason that
// had nothing to do with the code.
const noDaemon = () => null;
const restore = (a, b, o = {}) => restoreRaw(a, b, { isDaemonRunning: noDaemon, ...o });
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reeve-backup-"));
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dbPath = join(dir, "live.db");
const backups = join(dir, "backups");

// A store with real content in several tables, so a partial restore is visible.
let db = open(dbPath);
db.prepare(`INSERT INTO node(id,kind,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
  .run("pr:1", "pr", "a pull request", "open", 1, 1);
for (let i = 0; i < 25; i++)
  db.prepare(`INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)`)
    .run(1000 + i, "daemon", "pr.decided", "pr:1", JSON.stringify({ n: i }));
db.prepare(`INSERT INTO settlement(nwo,pr,sha,key,streak,floor,first_seen_at,last_seen_at,accounting)
            VALUES(?,?,?,?,?,?,?,?,?)`).run("o/r", 1, "abc", "k", 3, 7, 1, 2, 2);
const events = db.prepare("SELECT count(*) c FROM event").get().c;
check(events === 25, `control: the live store holds ${events} events`, String(events));

// --- taking one ---------------------------------------------------------------
let snapPath;
{
  const r = snapshot(db, backups, "o/r", 1_700_000_000);
  check(r.ok, "a snapshot is taken", JSON.stringify(r));
  snapPath = r.path;
  check(existsSync(snapPath), "and lands on disk", snapPath);
  check(snapPath.includes("o-r") || snapPath.includes("o/r"),
    "named for the repository, so several projects do not overwrite each other", snapPath);
}

// --- THE test: can it actually be restored? -----------------------------------
{
  // Destroy the original the way a disk failure would.
  db.close();
  rmSync(dbPath);
  for (const s of ["-wal", "-shm"]) { try { rmSync(dbPath + s); } catch {} }
  check(!existsSync(dbPath), "control: the live store is really gone");

  const r = restore(snapPath, dbPath);
  check(r.ok, "the snapshot restores", JSON.stringify(r));

  db = open(dbPath);
  const back = db.prepare("SELECT count(*) c FROM event").get().c;
  check(back === 25, "every event came back", `${back} of 25`);
  const node = db.prepare("SELECT title FROM node WHERE id='pr:1'").get();
  check(node?.title === "a pull request", "and so did the graph", JSON.stringify(node));
  const st = db.prepare("SELECT floor, accounting FROM settlement WHERE pr=1").get();
  check(st?.floor === 7 && st?.accounting === 2,
    "and the settlement state, including the column added by a later migration", JSON.stringify(st));
}

// --- it must not restore over a live store by accident ------------------------
{
  const r = restore(snapPath, dbPath);
  check(!r.ok && /exists/i.test(r.why ?? ""),
    "restoring onto an existing store refuses — that would silently discard newer work",
    JSON.stringify(r));
  // The daemon holding the store is the real hazard, and it is a PROCESS question,
  // not a database one: an idle SQLite connection does not hold a lock a probe can
  // see, so the obvious check — open it and take EXCLUSIVE — silently succeeded and
  // the file was replaced underneath a live handle. The failure then surfaced two
  // cases later, for a reason nobody had caused.
  db.close();
  const forced = restore(snapPath, dbPath, { overwrite: true });
  check(forced.ok, "with nothing holding it, an explicit overwrite works", JSON.stringify(forced));

  // And with the daemon up it refuses, because replacing a file underneath a live
  // process fails much later and for a reason nobody caused.
  const busy = restoreRaw(snapPath, dbPath, { overwrite: true, isDaemonRunning: () => "12345 reeve run o/r" });
  check(!busy.ok && /daemon is running|HALT/i.test(busy.why ?? ""),
    "and refuses while the daemon is running", JSON.stringify(busy));
  const anyway = restoreRaw(snapPath, dbPath, { overwrite: true, force: true, isDaemonRunning: () => "12345 reeve run o/r" });
  check(anyway.ok, "unless force says otherwise", JSON.stringify(anyway));
}

// --- keeping a series, and finding the newest ---------------------------------
{
  db = open(dbPath);
  for (const t of [1_700_000_100, 1_700_000_200, 1_700_000_300]) snapshot(db, backups, "o/r", t);
  const latest = latestSnapshot(backups, "o/r");
  check(latest?.includes("1700000300"), "the newest snapshot is findable without guessing", String(latest));
}
{
  // Old ones are pruned, or a backup directory grows without bound on a laptop
  // that is already the single point of failure.
  for (let t = 1_700_001_000; t < 1_700_001_100; t += 10) snapshot(db, backups, "o/r", t, { keep: 3 });
  const { readdirSync } = await import("node:fs");
  const kept = readdirSync(join(backups, "o-r")).filter(f => f.endsWith(".db"));
  check(kept.length <= 3, `only the newest few are kept (${kept.length})`, kept.join(", "));
}

// --- the human-readable trail -------------------------------------------------
{
  const p = join(dir, "events.jsonl");
  const r = exportEvents(db, p);
  check(r.ok && r.count === 25, "events export as JSONL too, for reading and for portability", JSON.stringify(r));
  const first = readFileSync(p, "utf8").split("\n")[0];
  check(/"op":"pr.decided"/.test(first), "one event per line, parseable", first.slice(0, 80));
}

// --- a corrupt snapshot must be caught, not restored ---------------------------
{
  const bad = join(dir, "corrupt.db");
  writeFileSync(bad, "this is not a database");
  const r = restore(bad, join(dir, "target.db"));
  check(!r.ok, "a corrupt snapshot refuses rather than producing an unusable store", JSON.stringify(r));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
