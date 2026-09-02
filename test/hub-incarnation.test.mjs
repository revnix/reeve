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
// ONE READER, and a throw is a VALUE here rather than an exit.
//
// `hubIncarnation` answers null, a row, or throws, and which of the three it does
// is exactly what several of these assertions are about -- so a bare call kills
// the file the moment a stub makes it take the third path. Measured twice: the
// same entry came back UNRUNNABLE at 5 of 26 assertions and again at 5 of 26 after
// only the FIRST call was guarded, because the next unguarded one was four blocks
// down. Guarding them one at a time is how a file ends up half-covered.
const read = (db) => { try { return { value: hubIncarnation(db), threw: null }; }
                       catch (e) { return { value: null, threw: e.message }; } };

const dir = mkdtempSync(join(tmpdir(), "reeve-incarn-"));
const DEAD = () => false;

// ── a hub is never without one ────────────────────────────────────────────────
{
  const p = join(dir, "fresh.db");
  const db = openHub(p);
  // SURVIVES A HUB WITH NO ROW. Since the empty-table case became damage, a
  // migration that creates the table without minting makes this read THROW rather
  // than answer null -- so the stub that removes the mint killed the file instead
  // of failing the assertion it names, and CI reported CRASHED where a sweep at an
  // older tree had reported CAUGHT. The entry did not change; the code under it
  // did, which is why a verification has to be re-run after the tree moves rather
  // than carried forward.
  const fresh = read(db); const inc = fresh.value;
  check(inc !== null, "a freshly created hub carries an incarnation",
    fresh.threw ?? JSON.stringify(inc));
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
  const inc = read(up).value;
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

  // THE RIGHT LENGTH IS NOT THE RIGHT ALPHABET, and a length check alone accepts
  // this. The writer here is not the only way in -- an import, a hand repair or a
  // direct statement reaches the table too -- and the id is the whole proof a
  // cursor carries, so a value no hexadecimal parser accepts leaves the hub
  // unable to issue one.
  let notHex = null;
  try { db.prepare("INSERT OR REPLACE INTO hub_incarnation(only,id,started_at) VALUES(1,?,1)").run("z".repeat(32)); }
  catch (e) { notHex = e.message; }
  check(notHex !== null, "and 32 characters that are not hex are refused too", String(notHex));
  check((() => { try { db.prepare("INSERT OR REPLACE INTO hub_incarnation(only,id,started_at) VALUES(1,?,1)").run("a1b2".repeat(8)); return true; } catch { return false; } })(),
    "control: a well-formed id still stores, so the constraint is not simply refusing everything");
  db.close();
}

// ── a hub older than the table answers NULL, as documented ───────────────────
//
// `hubIncarnation` promises null for a hub that predates migration 6, and a
// caller is told to read that as "cannot prove". It did not honour that: on such a
// hub the table is absent and the prepare THROWS, so the compatibility path the
// documentation describes was unreachable. Found in review.
{
  // GENUINELY PRE-v6: the table is gone AND the migration is not recorded. The
  // first version of this fixture dropped the table and left `schema_version`
  // saying 6 -- which is the DAMAGED case, not the old one. It asserted null and
  // passed, so the fixture built the misclassification and certified it. Review
  // found that, not the suite.
  const p = join(dir, "prev6.db");
  openHub(p).close();
  const raw = new DatabaseSync(p);
  raw.exec("DROP TABLE hub_incarnation");
  raw.prepare("DELETE FROM schema_version WHERE version = ?").run(6);
  raw.close();
  const ro = new DatabaseSync(p, { readOnly: true });
  let threw = null, answer;
  ({ value: answer, threw } = read(ro));
  ro.close();
  check(threw === null, "reading a hub that predates the table does not throw", String(threw));
  check(answer === null, "it answers null, which a caller reads as `cannot prove`", JSON.stringify(answer));

  // AND THE DAMAGED CASE MUST NOT LOOK LIKE IT. A hub that RECORDS migration 6
  // and has lost the table is broken, and null there suppresses the only evidence
  // a caller has.
  const d = join(dir, "damaged-v6.db");
  openHub(d).close();
  const draw = new DatabaseSync(d);
  draw.exec("DROP TABLE hub_incarnation");
  draw.close();
  const dro = new DatabaseSync(d, { readOnly: true });
  let dthrew = null, danswer, dmarked = false;
  ({ value: danswer, threw: dthrew } = read(dro));
  try { hubIncarnation(dro); } catch (e) { dmarked = e?.hubDamaged === true; }
  dro.close();
  check(dthrew !== null,
    "a v6 hub that has LOST the table propagates, rather than reading as an older store",
    `it answered ${JSON.stringify(danswer)}`);
  check(dmarked === true,
    "and it is MARKED as damage, so a caller can tell it from an unreadable store",
    JSON.stringify({ marked: dmarked }));
  check(/hub_incarnation/.test(dthrew ?? "") && /altered outside reeve/.test(dthrew ?? ""),
    "control: and it names the table and says the store was altered outside reeve",
    String(dthrew));
  check(/restore --hub --force/.test(dthrew ?? ""),
    "carrying the same recovery line the missing-ROW case carries, since it is the same corruption",
    String(dthrew));

  // AND THE SAME RULE ONE ROW DOWN. The table can be absent, or present and
  // EMPTY, and both mean "no incarnation" without saying why. `DELETE FROM
  // hub_incarnation` from a hand repair, or a partially applied restore, leaves a
  // migrated hub with the table and no row -- and answering null there is the
  // same misclassification as answering it for a missing table.
  const e6 = join(dir, "empty-v6.db");
  openHub(e6).close();
  const eraw = new DatabaseSync(e6);
  eraw.exec("DELETE FROM hub_incarnation");
  eraw.close();
  const ero = new DatabaseSync(e6, { readOnly: true });
  let ethrew = null, eanswer;
  ({ value: eanswer, threw: ethrew } = read(ero));
  ero.close();
  check(ethrew !== null,
    "a v6 hub whose incarnation ROW is gone propagates too, not only one missing the table",
    `it answered ${JSON.stringify(eanswer)}`);
  check(/altered outside reeve/i.test(ethrew ?? ""),
    "control: and it says the store was altered outside reeve, since nothing in reeve deletes that row",
    String(ethrew));
}

// ── minting REPLACES, because a restore must be able to end an incarnation ────
{
  const db = openHub(join(dir, "remint.db"));
  const first = read(db).value ?? { id: null };
  const second = mintIncarnation(db);
  check(second.id !== first.id, "minting again yields a DIFFERENT id");
  check((read(db).value ?? {}).id === second.id,
    "and the store now answers with the new one, not the old", JSON.stringify(read(db)));
  check(db.prepare("SELECT count(*) n FROM hub_incarnation").get().n === 1,
    "control: replacing rather than appending, so there is still exactly one row");
  db.close();
}

// ── THE ONE THAT CLOSES THE DEFECT: a restore begins a new incarnation ────────
{
  const p = join(dir, "live.db");
  const db = openHub(p);
  const beforeSnapshot = (read(db).value ?? {}).id ?? null;
  const snap = snapshot(db, join(dir, "snaps"), "hub", Math.floor(Date.now() / 1000), { keep: Infinity });
  check(snap.ok === true, "control: the snapshot was actually taken", JSON.stringify(snap));
  db.close();

  // The snapshot is a COPY, so it carries the incarnation that was live when it
  // was taken. This is the whole trap: that id is also the id a reader's cursor
  // would carry, so a restore that does not re-mint hands back a MATCH.
  const snapDb = openHub(snap.path);
  const inSnapshot = (read(snapDb).value ?? {}).id ?? null;
  snapDb.close();
  check(inSnapshot === beforeSnapshot,
    "control: the snapshot carries the incarnation that was live when it was taken -- which is why re-minting is the fix",
    `${inSnapshot} vs ${beforeSnapshot}`);

  const r = restoreHub(snap.path, p, { isAlive: DEAD, pid: process.pid, lstart: "me" });
  check(r.ok === true, "control: the restore succeeded, so what follows is about the restored store", JSON.stringify(r).slice(0, 300));

  const after = openHub(p);
  const restored = (read(after).value ?? {}).id ?? null;
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
