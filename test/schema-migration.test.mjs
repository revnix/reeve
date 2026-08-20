// open() re-applies schema.sql on every connection, and every statement in it is
// CREATE ... IF NOT EXISTS. That adds new TABLES to an existing database and
// silently does nothing for a new COLUMN, because the table already exists.
//
// Found the hard way: `settlement` gained an `accounting` column, the live
// nextly database did not get it, and the first query naming that column would
// have failed on the next daemon start -- against a database holding 1,300 events
// of real history.
import { open } from "../src/db/ops.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reeve-migrate-"));
const path = join(dir, "old.db");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const cols = db => db.prepare("PRAGMA table_info(settlement)").all().map(c => c.name);

// Build a database in the SHAPE THAT SHIPPED, without the later column.
{
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE settlement (
    nwo TEXT NOT NULL, pr INTEGER NOT NULL, sha TEXT NOT NULL, key TEXT NOT NULL,
    streak INTEGER NOT NULL, floor INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (nwo, pr)) STRICT`);
  old.prepare("INSERT INTO settlement VALUES(?,?,?,?,?,?,?,?)")
    .run("o/r", 1, "aaa", "x", 3, 7, 100, 200);
  check(!cols(old).includes("accounting"), "control: the old shape genuinely lacks the column", cols(old).join(","));
  old.close();
}

// Opening it must bring it up to date rather than fail later.
{
  const db = open(path);
  check(cols(db).includes("accounting"), "open() adds the missing column", cols(db).join(","));
  const row = db.prepare("SELECT nwo, floor, accounting FROM settlement WHERE pr=1").get();
  check(row?.floor === 7, "and the existing row survives", JSON.stringify(row));
  check(row?.accounting === 0,
    "with the default that marks it as recorded under an older accounting", JSON.stringify(row));
  db.close();
}

// Idempotent: opening twice must not fail on a column that is already there.
{
  const db = open(path);
  check(cols(db).includes("accounting"), "a second open is a no-op, not an error");
  db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
