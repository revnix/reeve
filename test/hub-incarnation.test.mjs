// WHICH LOG IS THIS, and can a cursor prove it belongs to it.
//
// `phase_event.seq` is monotonic within one hub and not across a restore.
// Replacing the store with an older snapshot puts the high-water mark below a
// cursor issued before it, and the log then regrows through the same numbers. A
// reader holding `<seq>.<at>` cannot tell an event that survived from a different
// event wearing its number: `at` is integer seconds with no uniqueness, so a log
// restored and regrown to the same sequence WITHIN ONE SECOND presents an
// identical pair. Every event of the new incarnation through that sequence is
// then skipped for ever and the digest reports a quiet period.
//
// THE ONE ASSERTION THAT MATTERS IS THE RESTORE. A table that stores an id proves
// nothing on its own -- the staging database is a COPY OF THE SNAPSHOT, so it
// arrives carrying the id the hub had when that snapshot was taken, which is the
// same id the live hub still had when a reader took its cursor. Restoring without
// re-minting therefore hands back an id that MATCHES, and a matching id is
// exactly the proof being asked for. So these drive a real snapshot and a real
// restore rather than calling the mint directly.
import { openHub, HUB_SCHEMA_VERSION, hubIncarnation, mintIncarnation } from "../src/build/hubdb.mjs";
import { snapshot, restoreHub } from "../src/backup.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
// EVERY READ HERE SURVIVES A NULL, on purpose. `hubIncarnation` returns null for a
// hub that predates the table, and a test that dereferences it dies rather than
// failing -- which the sweep reports as UNRUNNABLE, and which leaves every
// assertion after it unmeasured. Measured: with the mint removed, this file
// reported 9 of 18 assertions before the repair and 18 of 18 after.
const dir = mkdtempSync(join(tmpdir(), "reeve-incarn-"));
const DEAD = () => false;

// ── a hub is never without one ────────────────────────────────────────────────
{
  const p = join(dir, "fresh.db");
  const db = openHub(p);
  const inc = hubIncarnation(db);
  check(inc !== null, "a freshly created hub carries an incarnation");
  check(typeof inc?.id === "string" && /^[0-9a-f]{32}$/.test(inc.id),
    "and it is 128 bits of hex, which is compared for equality and never parsed", JSON.stringify(inc));
  check(inc?.startedAt > 0, "and it records when this incarnation began", JSON.stringify(inc));
  check(HUB_SCHEMA_VERSION >= 6, "control: the schema version moved, so migration 6 really ran",
    `HUB_SCHEMA_VERSION=${HUB_SCHEMA_VERSION}`);
  db.close();
}

// ── AN EXISTING HUB GETS ONE TOO ─────────────────────────────────────────────
//
// The upgrade path is where this class of change fails, and it fails quietly: a
// migration verified on a hub created by the same binary proves only that a
// FRESH store is right. A store that already existed reaches the new code by a
// different route, and "the table is created" and "the table has a row" are two
// facts. Without the mint inside migration 6, every hub in existence would come
// up with the table present and empty, which reads downstream as "cannot prove"
// for ever.
{
  const p = join(dir, "upgraded.db");
  openHub(p).close();

  // Put the store back to v5: drop the table and retract the migration record,
  // which is what a hub last opened by yesterday's binary genuinely looks like.
  const back = new DatabaseSync(p);
  back.exec("DROP TABLE hub_incarnation");
  back.prepare("DELETE FROM schema_version WHERE version = ?").run(6);
  const wasEmpty = back.prepare(
    "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='hub_incarnation'").get().n;
  back.close();
  check(wasEmpty === 0, "control: the fixture really is a store without the table, not a fresh one");

  const up = openHub(p);
  const inc = hubIncarnation(up);
  up.close();
  check(inc !== null && /^[0-9a-f]{32}$/.test(inc.id),
    "an EXISTING hub gets an incarnation when it upgrades, not merely the empty table",
    JSON.stringify(inc));
}

// ── exactly one, enforced by the schema ───────────────────────────────────────
//
// A table that merely HAPPENS to hold one row is one INSERT away from two answers
// to a question that must have exactly one, and the reader takes whichever the
// query returns first.
{
  const db = openHub(join(dir, "one.db"));
  let refused = null;
  try { db.prepare("INSERT INTO hub_incarnation(only,id,started_at) VALUES(2,?,1)").run("b".repeat(32)); }
  catch (e) { refused = e.message; }
  check(refused !== null, "a second incarnation row is REFUSED, so the answer cannot be ambiguous", String(refused));
  check(db.prepare("SELECT count(*) n FROM hub_incarnation").get().n === 1,
    "control: and the first row is still the only one");

  let badId = null;
  try { db.prepare("INSERT OR REPLACE INTO hub_incarnation(only,id,started_at) VALUES(1,?,1)").run("short"); }
  catch (e) { badId = e.message; }
  check(badId !== null, "an id that is not 128 bits of hex is refused rather than stored", String(badId));
  db.close();
}

// ── minting REPLACES, because a restore must be able to end an incarnation ────
{
  const db = openHub(join(dir, "remint.db"));
  const first = hubIncarnation(db) ?? { id: null };
  const second = mintIncarnation(db);
  check(second.id !== first.id, "minting again yields a DIFFERENT id");
  check((hubIncarnation(db) ?? {}).id === second.id,
    "and the store now answers with the new one, not the old", JSON.stringify(hubIncarnation(db)));
  check(db.prepare("SELECT count(*) n FROM hub_incarnation").get().n === 1,
    "control: replacing rather than appending, so there is still exactly one row");
  db.close();
}

// ── THE ONE THAT CLOSES THE DEFECT: a restore begins a new incarnation ────────
{
  const p = join(dir, "live.db");
  const db = openHub(p);
  const beforeSnapshot = (hubIncarnation(db) ?? {}).id ?? null;
  const snap = snapshot(db, join(dir, "snaps"), "hub", Math.floor(Date.now() / 1000), { keep: Infinity });
  check(snap.ok === true, "control: the snapshot was actually taken", JSON.stringify(snap));
  db.close();

  // The snapshot is a COPY, so it carries the incarnation that was live when it
  // was taken. This is the whole trap: that id is also the id a reader's cursor
  // would carry, so a restore that does not re-mint hands back a MATCH.
  const snapDb = openHub(snap.path);
  const inSnapshot = (hubIncarnation(snapDb) ?? {}).id ?? null;
  snapDb.close();
  check(inSnapshot === beforeSnapshot,
    "control: the snapshot carries the incarnation that was live when it was taken -- which is why re-minting is the fix",
    `${inSnapshot} vs ${beforeSnapshot}`);

  const r = restoreHub(snap.path, p, { isAlive: DEAD, pid: process.pid, lstart: "me" });
  check(r.ok === true, "control: the restore succeeded, so what follows is about the restored store", JSON.stringify(r).slice(0, 300));

  const after = openHub(p);
  const restored = (hubIncarnation(after) ?? {}).id ?? null;
  after.close();
  check(restored !== inSnapshot,
    "a restore begins a NEW incarnation, so a cursor issued before it can no longer prove it belongs to this log",
    `restored=${restored} snapshot=${inSnapshot} -- equal means every stale cursor is still accepted`);
  check(restored !== beforeSnapshot,
    "and it differs from the incarnation that was live before the restore too",
    `restored=${restored} before=${beforeSnapshot}`);
  check(/^[0-9a-f]{32}$/.test(restored), "and the restored store's id is well formed", restored);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
