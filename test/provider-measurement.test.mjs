// A measurement is an EVENT, and the record has to be able to say when it was
// taken and what was seen. The pool experiment's answer -- whether headless work
// draws on the interactive allowance -- is a relationship, not a number, and the
// only column that would have taken it, `provider_state.measured_at`, asserts
// something narrower: that THAT row's numeric limits were measured. Writing it
// here would make doctor's H-5 report the unmeasured defaults as measured.
//
// Every refusal below is asserted with a matching ACCEPTANCE. A validator that
// rejects everything passes a suite of rejections, and would then quietly refuse
// the one real measurement this store exists to hold.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub } from "../src/build/hubdb.mjs";
import { recordMeasurement, latestMeasurement, MEASUREMENT_KINDS } from "../src/build/measurementdb.mjs";
import { replayableKinds, COMPARISON_SET } from "../src/build/replay.mjs";
import { TABLE_OWNERS } from "../src/build/tables.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
// The message is asserted, not just the throw. A validator that throws for the
// wrong reason passes a bare `threw === true`, and the operator reading the
// error is the one who has to act on it.
const refuses = (fn, re, name) => {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  if (msg === null) return check(false, name, "did not throw at all");
  check(re.test(msg), name, re.test(msg) ? null : `threw, but for the wrong reason: ${msg}`);
};

const dir = mkdtempSync(join(tmpdir(), "reeve-measurement-"));
const KIND = "pool-relationship";
// No restore lock exists in this fixture, so assertWritable returns before ever
// calling this -- it is supplied because the contract requires it, and the
// held-lock case is asserted separately below.
const LIVE = () => true;

try {
  const db = openHub(join(dir, "hub.db"));

  // ---- the table exists, and migration 4 is what put it there
  const table = db.prepare(
    `SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='provider_measurement'`).get().c;
  check(table === 1, "migration 4 creates provider_measurement");
  const idx = db.prepare(
    `SELECT count(*) c FROM sqlite_master WHERE type='index' AND name='provider_measurement_latest'`).get().c;
  check(idx === 1, "and the index the latest-row read depends on");

  // ---- ACCEPTANCE FIRST, so every refusal below is measured against a case
  // that is known to get through. Without this the refusals could all be
  // passing because the writer rejects everything.
  const now = db.prepare("SELECT unixepoch() n").get().n;
  const evidence = "baseline 90% 04:00Z; between arms 90% 04:12Z; after arm B 74% 04:31Z";
  recordMeasurement(db, { isAlive: LIVE, kind: KIND, result: "SHARED", evidence, measuredAt: now - 60 });
  const got = latestMeasurement(db, { kind: KIND });
  check(got?.result === "SHARED", "control: a well-formed measurement is stored and read back");
  check(got?.evidence === evidence, "and its evidence survives verbatim");
  check(got?.ageSeconds >= 60, "and the age travels with it, because a stale answer is not a usable one",
        `ageSeconds=${got?.ageSeconds}`);

  // ---- the newest row wins, which is the whole reason this is a table
  recordMeasurement(db, { isAlive: LIVE, kind: KIND, result: "INCONCLUSIVE",
                          evidence: "arm B failed; probe 2 unavailable", measuredAt: now - 10 });
  check(latestMeasurement(db, { kind: KIND })?.result === "INCONCLUSIVE",
        "the most recent measurement is the one returned");
  const rows = db.prepare(`SELECT count(*) c FROM provider_measurement`).get().c;
  check(rows === 2, "and the earlier one is KEPT -- a state column could not have done this", `rows=${rows}`);

  // ---- an undeclared kind throws rather than answering
  refuses(() => recordMeasurement(db, { isAlive: LIVE, kind: "pool-relatinship", result: "SHARED",
                                        evidence: "x", measuredAt: now }),
          /not a declared measurement kind/, "a misspelled kind is refused, not silently stored");
  refuses(() => latestMeasurement(db, { kind: "pool-relatinship" }),
          /not a declared measurement kind/, "and reading one is refused too");

  // A PROTOTYPE NAME IS NOT A KIND. Plain property access answers for `toString`
  // and `constructor`, so a lookup written the obvious way would treat them as
  // declared kinds and hand back a function as the allowed-results list.
  for (const name of ["toString", "constructor", "hasOwnProperty"]) {
    refuses(() => recordMeasurement(db, { isAlive: LIVE, kind: name, result: "SHARED", evidence: "x", measuredAt: now }),
            /not a declared measurement kind/, `an inherited property name is not a kind: ${name}`);
  }

  // ---- a result outside the kind's vocabulary
  refuses(() => recordMeasurement(db, { isAlive: LIVE, kind: KIND, result: "PROBABLY_SHARED",
                                        evidence: "x", measuredAt: now }),
          /cannot conclude/, "a result the kind does not declare is refused");
  refuses(() => recordMeasurement(db, { isAlive: LIVE, kind: KIND, result: "shared",
                                        evidence: "x", measuredAt: now }),
          /cannot conclude/, "control: the vocabulary is case-sensitive, so a near-miss is still a miss");

  // ---- evidence is mandatory
  for (const [ev, label] of [[undefined, "absent"], ["", "empty"], ["   ", "whitespace"]]) {
    refuses(() => recordMeasurement(db, { isAlive: LIVE, kind: KIND, result: "SHARED", evidence: ev, measuredAt: now }),
            /evidence is required/, `a result with ${label} evidence is a claim, not a measurement`);
  }

  // ---- the timestamp
  for (const [t, label] of [[0, "zero"], [-1, "negative"], [1.5, "fractional"], ["123", "a string"]]) {
    refuses(() => recordMeasurement(db, { isAlive: LIVE, kind: KIND, result: "SHARED", evidence: "x", measuredAt: t }),
            /positive integer of seconds/, `${label} is not a timestamp`);
  }

  // A FUTURE TIMESTAMP NEVER BECOMES STALE. `reviewer_supply.since` holds
  // 1800000000 -- January 2027 -- written by a test clock that reached a real
  // store, and nothing downstream has ever called it old because it is always
  // in the future. Refusing on write is what stops the next one.
  // THE WRITER'S OWN MESSAGE, not merely "in the future". The table carries this
  // rule too, as a trigger, and its message also says "is in the future" -- so a
  // looser pattern passes whether the writer refuses or the trigger does. That
  // is a test that cannot fail: deleting the writer's check leaves it green,
  // which is exactly what happened when the backstop was added. Defence in depth
  // has to be asserted layer by layer or one layer stops being tested.
  const BY_WRITER = /recordMeasurement: measuredAt \d+ is in the future/;
  refuses(() => recordMeasurement(db, { isAlive: LIVE, kind: KIND, result: "SHARED", evidence: "x", measuredAt: now + 60 }),
          BY_WRITER, "a future timestamp is refused BY THE WRITER: it would be permanently recent");
  refuses(() => recordMeasurement(db, { isAlive: LIVE, kind: KIND, result: "SHARED", evidence: "x", measuredAt: 1800000000 }),
          BY_WRITER, "control: the exact test-clock value that reached a real store is refused");
  // COUNTED, not read back through latestMeasurement. The question here is
  // whether a refused write left a row, and counting answers it directly. Going
  // through the read couples this control to the read's own guards: with the
  // writer's future-timestamp check stubbed out, the row lands, the read refuses
  // it, and the throw is uncaught HERE -- aborting the file with half its
  // assertions unexecuted, which a log cannot tell from half its assertions
  // passing. The stub still reported CAUGHT while proving a third of what it
  // claimed.
  check(db.prepare(`SELECT count(*) c FROM provider_measurement`).get().c === 2,
        "control: none of the refusals above wrote anything",
        String(db.prepare(`SELECT count(*) c FROM provider_measurement`).get().c));

  // ---- THE SCHEMA IS THE BACKSTOP, because the writer is not the only way in.
  // A caller reaching the store directly is exactly the case the writer cannot
  // see, and a row it would have refused is returned by the next read as the
  // newest apparently-current answer -- which the arming gate then consumes.
  const direct = (sql) => { let m = null; try { db.prepare(sql).run(); } catch (e) { m = e.message; } return m; };
  const V = `'claude','${KIND}'`;
  check(direct(`INSERT INTO provider_measurement VALUES (${V},'SHARED','',${now})`) !== null,
        "the table refuses empty evidence, not only the writer");
  check(direct(`INSERT INTO provider_measurement VALUES (${V},'SHARED','   ',${now})`) !== null,
        "and whitespace-only evidence, which is not provenance");
  check(direct(`INSERT INTO provider_measurement VALUES (${V},'',            'e',${now})`) !== null,
        "and an empty result");
  check(direct(`INSERT INTO provider_measurement VALUES (${V},'BAD',         'e',${now})`) !== null,
        "and a NON-EMPTY result outside the kind's vocabulary -- the case a non-emptiness check lets through");
  check(direct(`INSERT INTO provider_measurement VALUES ('claude','made-up','SHARED','e',${now})`) !== null,
        "and an undeclared kind");
  check(direct(`INSERT INTO provider_measurement VALUES (${V},'SHARED','e',0)`) !== null,
        "and a non-positive timestamp");
  // The control that makes the refusals above mean something: the same statement
  // shape, with every value valid, gets through.
  check(direct(`INSERT INTO provider_measurement VALUES (${V},'SEPARATE','real evidence',${now - 5})`) === null,
        "control: the same direct insert succeeds when every value is valid");

  // ---- THE FUTURE TIMESTAMP IS GUARDED AT THE READ, not by a constraint.
  // SQLite forbids non-deterministic functions in CHECK, so `unixepoch()` is
  // reachable only from a trigger -- and this schema declares NONE, which is
  // what lets snapshot validation treat any trigger at all as unexpected.
  // Guarding the read is also the stronger place: it catches rows this database
  // never validated, including one replayed from a snapshot an older binary
  // wrote, and a future-dated row is only dangerous when something CONSUMES it.
  check(direct(`INSERT INTO provider_measurement VALUES (${V},'SHARED','e',${now + 3600})`) === null,
        "control: the table itself accepts a future timestamp, so the read guard below is load-bearing");
  refuses(() => latestMeasurement(db, { kind: KIND }),
          /is dated \d+, which is after now/,
          "a future-dated row reaching the table directly is REFUSED BY THE READ");
  // Refused, not skipped. Returning the row beneath it would answer with an
  // older measurement while a corrupt one sat above it unmentioned, and the
  // arming gate would proceed on an answer nobody knows is being shadowed.
  db.prepare(`DELETE FROM provider_measurement WHERE measured_at > ?`).run(now);
  check(latestMeasurement(db, { kind: KIND })?.result === "SEPARATE",
        "control: with the future row gone the read answers again, so it refused rather than broke");

  // ---- TWO INVENTORIES OF ONE RULE, and the thing that makes that safe.
  // The vocabulary is declared in MEASUREMENT_KINDS and again as CHECK
  // constraints. Neither can be derived from the other in SQL, so the guard is
  // that they are compared here and diverge loudly rather than silently.
  const ddl = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_measurement'`).get().sql;
  for (const k of Object.keys(MEASUREMENT_KINDS)) {
    check(ddl.includes(`'${k}'`), `the schema declares the kind the code declares: ${k}`, ddl);
    for (const r of MEASUREMENT_KINDS[k])
      check(ddl.includes(`'${r}'`), `and the result ${r} that ${k} may conclude`, ddl);
  }

  // ---- REPLAY. A row written after the last snapshot exists only in the event
  // tail, and restoreHub rebuilds everything past the snapshot from that tail
  // alone. Without a handler a NORMAL restore drops the measurement while
  // reporting success -- losing the arming gate's answer and its evidence.
  check(replayableKinds().includes("provider_measurement.recorded"),
        "the recorded event has a replay handler, so a post-snapshot measurement survives a restore");
  check(COMPARISON_SET.includes("provider_measurement"),
        "and the drill compares the table, so the handler is proven to restore it rather than merely registered");
  check(TABLE_OWNERS.provider_measurement?.replayed === true,
        "and the owners entry agrees it is replayed", JSON.stringify(TABLE_OWNERS.provider_measurement));
  const ev = db.prepare(
    `SELECT kind, payload FROM hub_event WHERE kind = 'provider_measurement.recorded' ORDER BY seq DESC LIMIT 1`).get();
  check(!!ev, "recording a measurement appends its event");
  // THE ROW, not the key. A payload carrying only the primary key would replay
  // into a row with no result and no evidence, which reads downstream as a
  // measurement that concluded nothing rather than as data loss.
  const payload = ev ? JSON.parse(ev.payload) : {};
  for (const col of ["provider", "kind", "result", "evidence", "measured_at"])
    check(payload[col] !== undefined, `and the event carries the whole row image: ${col}`, ev?.payload);

  // ---- the vocabulary is frozen, so a caller cannot widen it at runtime
  let widened = false;
  try { MEASUREMENT_KINDS[KIND].push("DEFINITELY"); widened = true; } catch { /* frozen */ }
  check(!widened && !MEASUREMENT_KINDS[KIND].includes("DEFINITELY"),
        "the declared vocabulary cannot be widened by a caller at runtime");

  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
