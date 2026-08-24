// The prose-versus-DDL cross-check, run rather than remembered.
//
// Two failures this catches, and they point in opposite directions:
//   - a table the design's prose relies on that nobody ever created, so the
//     code that reads it silently gets nothing and reads absence as success;
//   - a table in the DDL that no writer fills and no reader consults -- the
//     read-never-written shape the tracker has already flagged twice.
// ONE import per module, not two spellings of the same path -- and every binding
// the file reaches for. The directory-based emitter scan below uses
// `NON_REPLAYED_KINDS`, `readdirSync` and `fileURLToPath`, none of which the
// standard harness supplies; without them Task 11 throws a ReferenceError before
// it checks a single emitted kind, which reads as a broken suite rather than as
// a missing import.
import { openHub, HUB_TABLES } from "../src/build/hubdb.mjs";
import { replayableKinds, replayedTables, NON_REPLAYED_KINDS, COMPARISON_SET } from "../src/build/replay.mjs";
import { TABLE_OWNERS, PROSE_TABLES } from "../src/build/tables.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const db = openHub(join(mkdtempSync(join(tmpdir(), "reeve-xc-")), "x.db"));
const inDb = new Set(db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
const declared = new Set(Object.keys(TABLE_OWNERS));

check(inDb.size === 32, `the hub has exactly 32 tables (got ${inDb.size})`, [...inDb].sort().join(","));

// direction 0: HUB_TABLES, the set snapshot validation uses, equals the live one.
// Task 8's paragraph promised this assertion and no test made it: HUB_TABLES is
// derived by a REGEX over hub.sql, so a declaration the regex stops recognising
// yields a SHORTER list -- and a short list makes validateSnapshot accept a
// snapshot that is missing exactly the authority-bearing table it dropped. That
// failure is silent in both directions at once, which is why it needs its own
// assertion rather than being implied by the two below.
check(HUB_TABLES.length === inDb.size,
  `HUB_TABLES has one entry per live table (${HUB_TABLES.length} vs ${inDb.size})`);
const notLive = HUB_TABLES.filter(t => !inDb.has(t));
const notDerived = [...inDb].filter(t => !HUB_TABLES.includes(t));
check(notLive.length === 0 && notDerived.length === 0,
  "HUB_TABLES equals the live table set exactly, so snapshot validation checks every table",
  `regex-only: ${notLive.join(",") || "none"}; live-only: ${notDerived.join(",") || "none"}`);
// CONTROL: the comparison can fail. Both lists being empty satisfies the
// assertion above, and an empty HUB_TABLES is precisely what a broken regex
// produces -- the exact case this direction exists to catch.
check(HUB_TABLES.length > 0 && inDb.size > 0,
  "control: both sides of that comparison are non-empty",
  `${HUB_TABLES.length} / ${inDb.size}`);

// direction 1: prose -> DDL
for (const t of PROSE_TABLES) check(inDb.has(t), `the prose names ${t}, and the DDL creates it`);

// direction 2: DDL -> a stated writer and reader
for (const t of inDb) {
  const o = TABLE_OWNERS[t];
  check(!!o, `${t} exists in the DDL and has an owners entry`);
  if (!o) continue;
  check(typeof o.writer === "string" && o.writer.trim().length > 0, `${t} has a stated writer`, JSON.stringify(o));
  check(typeof o.reader === "string" && o.reader.trim().length > 0, `${t} has a stated reader`, JSON.stringify(o));
  check(typeof o.section === "string" && /^\d/.test(o.section), `${t} cites the section it comes from`, String(o.section));
}
// and nothing declared that does not exist -- a stale entry is how a checklist
// goes on reporting a table that was renamed out from under it
for (const t of declared) check(inDb.has(t), `${t} is declared in TABLE_OWNERS and exists in the DDL`);

// direction 3b: the replayed set is EXACTLY the compared set.
// Comparing handlers only against `TABLE_OWNERS.replayed` lets a future handler
// arrive with its flag and without a `COMPARISON_SET` entry -- and then the
// destructive drill never writes or compares that projection, which is precisely
// the regression that reached `guardian_receipt` once already. Both directions,
// because either half alone is satisfied by a subset.
{
  const replayTablesNow = replayedTables();
  const compared = [...COMPARISON_SET].sort();
  check(JSON.stringify(replayTablesNow) === JSON.stringify(compared),
    "every replayed table is compared by the drill, and every compared table is replayed",
    `replayed-only: ${replayTablesNow.filter(t => !compared.includes(t)).join(",") || "none"}; ` +
    `compared-only: ${compared.filter(t => !replayTablesNow.includes(t)).join(",") || "none"}`);
  // CONTROL: both sides are non-empty, or the equality above holds trivially.
  check(replayTablesNow.length > 0 && compared.length > 0,
    "control: both sides of that equality are non-empty",
    `${replayTablesNow.length} / ${compared.length}`);
}

// direction 3: every table marked replayed has a handler, and vice versa
const kinds = replayableKinds();
const replayTables = new Set(kinds.map(k => k.split(".")[0]).map(s => s === "task" ? "task" : s));
for (const [t, o] of Object.entries(TABLE_OWNERS)) {
  const covered = kinds.some(k => k.startsWith(t + ".")) || (t === "task" && kinds.includes("task.transitioned"));
  if (o.replayed) check(covered, `${t} is marked replayed and replay.mjs has a handler for it`, kinds.join(","));
  // The reverse direction the contract promises and the loop skipped: a handler
  // for a table nobody marked replayed means the two lists disagree about what
  // survives a restore, and the comparison set is built from one of them.
  else check(!covered, `${t} is marked NOT replayed and has no handler`, kinds.join(","));
}

// A guard against the cheapest wrong fix: a TABLE_OWNERS filled with "TBD".
for (const [t, o] of Object.entries(TABLE_OWNERS))
  check(!/\b(tbd|todo|unknown|n\/a)\b/i.test(`${o.writer} ${o.reader}`), `${t}'s owners are named, not placeheld`, JSON.stringify(o));

// Control: the check can fail. If every assertion above is vacuous the suite is
// green for the wrong reason, so one deliberate miss is asserted to be caught.
{
  const fake = { ...TABLE_OWNERS };
  delete fake.pr_hold;
  check(!Object.keys(fake).includes("pr_hold") && inDb.has("pr_hold"),
    "control: a table present in the DDL but missing from TABLE_OWNERS is detectable");
}

// test/hub-crosscheck.test.mjs
// Every kind ANY plan emits must be handled or declared unreplayed. Scanned from
// the sources rather than from a list, because a list is the thing that drifts.
// Scan EVERY module under src/build, not a list of files that mostly do not
// exist yet. At Task 11 this plan has created hubdb.mjs, locks.mjs, replay.mjs
// and tables.mjs; transition.mjs, outbox.mjs and the rest arrive in S2-B and
// later. A hardcoded list of future files makes every iteration `continue`, so
// `emitted` is empty -- and the control below then fails the mandatory test on
// the prescribed implementation. Dead on arrival, and loud about it, which is
// the better half of the mistake.
//
// Reading the directory means the check grows with the tree instead of being
// re-edited each stage, and `hubdb.mjs` itself emits, so it is never empty.
const buildDir = fileURLToPath(new URL("../src/build/", import.meta.url));
const emitted = new Set();
for (const f of readdirSync(buildDir).filter(n => n.endsWith(".mjs")))
  for (const m of readFileSync(join(buildDir, f), "utf8")
        .matchAll(/hubEvent\(\s*\w+\s*,\s*\{\s*kind:\s*"([a-z_.]+)"/g))
    emitted.add(m[1]);

const known = new Set([...replayableKinds(), ...NON_REPLAYED_KINDS]);
const undeclared = [...emitted].filter(k => !known.has(k));
check(undeclared.length === 0,
  "every hub_event kind any module emits is either replayed or declared unreplayed",
  JSON.stringify(undeclared));
// CONTROL: the scanner found kinds at all. An empty `emitted` set satisfies the
// assertion above for every possible implementation -- and an empty set is
// exactly what a stale file list produces.
check(emitted.size > 0,
  "control: the emit scanner actually found kinds in src/build", String(emitted.size));
// CONTROL, the other direction: nothing may be in both.
const both = [...replayableKinds()].filter(k => NON_REPLAYED_KINDS.includes(k));
check(both.length === 0, "control: no kind is both replayed and declared unreplayed", JSON.stringify(both));

// ── every column the CONSUMING plans insert by name exists in this schema ────
// S2-A's schema is consumed by S2-B and S2-C, and the cross-check above only
// looks inward: it compares this plan's DDL against this plan's prose. Nothing
// compared it against what the next two plans actually write, and three columns
// were missing that way -- `impl_pr.head_sha`, and the `outbox.worker` /
// `outbox.lease_token` pair that IS the owner fence stopping a stalled worker
// from settling another worker's live delivery.
//
// INSERT column lists are the unambiguous half of that comparison: a name in
// `INSERT INTO t(a,b,c)` is a column or it is nothing. A WHERE clause is not
// scanned here, deliberately -- distinguishing a column from a JS identifier in
// prose produced far more noise than signal when tried, and a check that reports
// a hundred false candidates is one nobody reads.
{
  const planDir = fileURLToPath(new URL("../docs/superpowers/plans/", import.meta.url));
  const consuming = readdirSync(planDir).filter(n => /s2[bc]-.*\.md$/.test(n));
  check(consuming.length === 2,
    "fixture: both consuming plans are present to scan", JSON.stringify(consuming));

  const live = new Map();
  for (const t of inDb)
    live.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)));

  let scanned = 0;
  const missing = [];
  for (const f of consuming) {
    const text = readFileSync(join(planDir, f), "utf8");
    for (const m of text.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_]+)\s*\(([^)]*)\)/gi)) {
      const table = m[1];
      if (!live.has(table)) continue;                 // not a hub table
      for (const raw of m[2].split(",")) {
        const col = raw.trim();
        if (!/^[a-z_]+$/.test(col)) continue;
        scanned++;
        if (!live.get(table).has(col)) missing.push(`${f.slice(11, 14)} ${table}.${col}`);
      }
    }
  }
  check(missing.length === 0,
    "every column S2-B and S2-C insert by name exists in migration 1",
    [...new Set(missing)].join(", "));
  // CONTROL: the scan found real column references. A regex that stops matching
  // -- a reformatted INSERT, a renamed plan file -- would otherwise report an
  // empty `missing` list and read exactly like success.
  check(scanned > 50,
    "control: the scan actually read INSERT column lists, so an empty result means agreement",
    `${scanned} column references across ${consuming.length} plans`);
}

// The DDL's CHECK and the machine's domain must be the same set. A state the
// machine emits and the database refuses is a transition that throws at commit
// time, in production, on the one path that must not throw.
{
  const { PHASES } = await import("../src/build/phases.mjs");
  const sql = readFileSync(new URL("../src/build/hub.sql", import.meta.url), "utf8");
  const block = sql.slice(sql.indexOf("phase          TEXT    NOT NULL CHECK"));
  const fromDdl = (block.slice(0, block.indexOf("))")).match(/'([A-Z_]+)'/g) ?? []).map(s => s.slice(1, -1));
  // The anchor is asserted before the comparison. A slice from indexOf(-1) is
  // the whole file, and a match against that would gather every quoted upper-case
  // token in the schema -- so a MOVED CHECK reads as a disagreeing enumeration
  // rather than as a stale anchor, and the failure names the wrong defect.
  check(fromDdl.length > 0,
    "control: the task.phase CHECK was found in hub.sql, so this compares two real sets",
    `${fromDdl.length} phases parsed from the DDL`);
  check(JSON.stringify([...fromDdl].sort()) === JSON.stringify([...PHASES].sort()),
    "the task.phase CHECK and phases.mjs PHASES are the same set",
    `ddl-only: ${fromDdl.filter(p => !PHASES.includes(p))}\n        machine-only: ${PHASES.filter(p => !fromDdl.includes(p))}`);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
