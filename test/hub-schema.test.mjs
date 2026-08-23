// The hub is the authority for who is allowed to do what, so it does not
// inherit the guardian's pragmas. synchronous=NORMAL can lose the last
// transactions on power loss, which for the guardian costs a re-poll and for
// the hub would mean an approval or a merge decision that the database no
// longer remembers granting. It is also forward-only: an older binary opening
// a newer store would read columns it does not know about as absent, and
// absence is never read as success anywhere else in this system either.
import { hubPathFor, statePathFor } from "../src/paths.mjs";
import { openHub, hubTx, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-hub-"));

// ── the path is one place, and it is not a repository store ──────────────────
{
  check(hubPathFor("/h") === join("/h", "state", "hub.db"), "the hub lives at <home>/state/hub.db", hubPathFor("/h"));
  check(hubPathFor("/h") !== statePathFor("/h", "nextlyhq/nextly"),
    "and is not the same file as any repository's store", `${hubPathFor("/h")} vs ${statePathFor("/h", "nextlyhq/nextly")}`);
  check(hubPathFor("/h") !== statePathFor("/h", "hub/db"),
    "control: a repository literally named hub/db still does not collide with it");
}

// ── the pragmas the hub does not inherit ─────────────────────────────────────
{
  const db = openHub(join(dir, "p.db"));
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  check(String(one("PRAGMA journal_mode")).toLowerCase() === "wal", "journal_mode is WAL", String(one("PRAGMA journal_mode")));
  check(one("PRAGMA synchronous") === 2, "synchronous is FULL, not the guardian's NORMAL", `got ${one("PRAGMA synchronous")} (1=NORMAL, 2=FULL)`);
  check(one("PRAGMA foreign_keys") === 1, "foreign_keys is ON", String(one("PRAGMA foreign_keys")));
  check(one("PRAGMA busy_timeout") === 10000, "busy_timeout is 10s", String(one("PRAGMA busy_timeout")));
  db.close();
}

// ── the version is recorded, and opening again is inert ──────────────────────
{
  const p = join(dir, "v.db");
  const a = openHub(p);
  const v1 = a.prepare("SELECT max(version) v FROM schema_version").get().v;
  check(v1 === HUB_SCHEMA_VERSION, "a fresh store records the binary's schema version", `${v1} vs ${HUB_SCHEMA_VERSION}`);
  const rows1 = a.prepare("SELECT count(*) c FROM schema_version").get().c;
  a.close();
  const b = openHub(p);
  const rows2 = b.prepare("SELECT count(*) c FROM schema_version").get().c;
  check(rows2 === rows1, "re-opening applies nothing and appends no version row", `${rows1} then ${rows2}`);
  b.close();
}

// ── forward-only: an older binary refuses a newer store ──────────────────────
{
  const p = join(dir, "future.db");
  openHub(p).close();
  const raw = new DatabaseSync(p);
  // CONTIGUOUS, not merely tall. Writing only `HUB_SCHEMA_VERSION + 7` leaves
  // every version between it and this binary's missing, so `openHub`'s
  // CONTIGUITY refusal fires first and this whole block passes against an
  // implementation with no forward-version check at all. Measured, not
  // supposed: with both version checks stubbed out the refusal read
  // `records schema version 8 but is missing migration(s) 2, 3, 4, 5, 6, 7`
  // and every assertion here stayed green.
  for (let v = HUB_SCHEMA_VERSION + 1; v <= HUB_SCHEMA_VERSION + 7; v++)
    raw.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${v}, unixepoch())`);
  raw.close();
  let why = null;
  try { openHub(p); } catch (e) { why = e.message; }
  check(why !== null, "a store recorded above this binary's version refuses to open");
  // The PHRASES, not bare digits. `why.includes("1")` is satisfied by any "1"
  // anywhere in the message -- and the message contains a tmpdir path, which on
  // this machine supplied one, so that assertion was green by accident.
  check(new RegExp(`schema version ${HUB_SCHEMA_VERSION + 7}\\b`).test(String(why)) &&
        new RegExp(`this binary knows ${HUB_SCHEMA_VERSION}\\b`).test(String(why)),
    "and the refusal names both versions, so the operator knows which binary to run", String(why));
  // WHICH refusal. Contiguity and forward-version are different failures and
  // only one is this block's subject; without this line the assertions above
  // are satisfied by a hole the fixture itself created.
  check(!/missing migration/.test(String(why)),
    "and it is refused for being NEWER than this binary, not for a hole in its history", String(why));
  // And by the OPENING check, not the locked recheck. Both refuse a newer
  // store, so removing the opening one alone leaves this block green -- while
  // the operator gets `It was migrated by a newer reeve while this one was
  // opening it`, which describes a concurrent migration that did not happen.
  // The two exist for different reasons and each needs its own assertion.
  check(/Migrations are forward-only/.test(String(why)),
    "and the message is the opening refusal, not the concurrent-migration one that would misdescribe it",
    String(why));
}

// ── hubTx rolls back, so a failed transition leaves nothing behind ───────────
{
  const db = openHub(join(dir, "tx.db"));
  db.exec("CREATE TABLE t(x INTEGER) STRICT");
  try { hubTx(db, () => { db.exec("INSERT INTO t VALUES(1)"); throw new Error("boom"); }); } catch {}
  check(db.prepare("SELECT count(*) c FROM t").get().c === 0, "hubTx rolls back on a throw");
  hubTx(db, () => db.exec("INSERT INTO t VALUES(2)"));
  check(db.prepare("SELECT count(*) c FROM t").get().c === 1, "control: hubTx commits when the body returns");
  db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
