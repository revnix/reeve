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
import { recordMeasurement, latestMeasurement, MEASUREMENT_KINDS,
         nowSeconds } from "../src/build/providerdb.mjs";

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
  const now = nowSeconds(db);
  const evidence = "baseline 90% 04:00Z; between arms 90% 04:12Z; after arm B 74% 04:31Z";
  recordMeasurement(db, { kind: KIND, result: "SHARED", evidence, measuredAt: now - 60 });
  const got = latestMeasurement(db, { kind: KIND });
  check(got?.result === "SHARED", "control: a well-formed measurement is stored and read back");
  check(got?.evidence === evidence, "and its evidence survives verbatim");
  check(got?.ageSeconds >= 60, "and the age travels with it, because a stale answer is not a usable one",
        `ageSeconds=${got?.ageSeconds}`);

  // ---- the newest row wins, which is the whole reason this is a table
  recordMeasurement(db, { kind: KIND, result: "INCONCLUSIVE",
                          evidence: "arm B failed; probe 2 unavailable", measuredAt: now - 10 });
  check(latestMeasurement(db, { kind: KIND })?.result === "INCONCLUSIVE",
        "the most recent measurement is the one returned");
  const rows = db.prepare(`SELECT count(*) c FROM provider_measurement`).get().c;
  check(rows === 2, "and the earlier one is KEPT -- a state column could not have done this", `rows=${rows}`);

  // ---- an undeclared kind throws rather than answering
  refuses(() => recordMeasurement(db, { kind: "pool-relatinship", result: "SHARED",
                                        evidence: "x", measuredAt: now }),
          /not a declared measurement kind/, "a misspelled kind is refused, not silently stored");
  refuses(() => latestMeasurement(db, { kind: "pool-relatinship" }),
          /not a declared measurement kind/, "and reading one is refused too");

  // A PROTOTYPE NAME IS NOT A KIND. Plain property access answers for `toString`
  // and `constructor`, so a lookup written the obvious way would treat them as
  // declared kinds and hand back a function as the allowed-results list.
  for (const name of ["toString", "constructor", "hasOwnProperty"]) {
    refuses(() => recordMeasurement(db, { kind: name, result: "SHARED", evidence: "x", measuredAt: now }),
            /not a declared measurement kind/, `an inherited property name is not a kind: ${name}`);
  }

  // ---- a result outside the kind's vocabulary
  refuses(() => recordMeasurement(db, { kind: KIND, result: "PROBABLY_SHARED",
                                        evidence: "x", measuredAt: now }),
          /cannot conclude/, "a result the kind does not declare is refused");
  refuses(() => recordMeasurement(db, { kind: KIND, result: "shared",
                                        evidence: "x", measuredAt: now }),
          /cannot conclude/, "control: the vocabulary is case-sensitive, so a near-miss is still a miss");

  // ---- evidence is mandatory
  for (const [ev, label] of [[undefined, "absent"], ["", "empty"], ["   ", "whitespace"]]) {
    refuses(() => recordMeasurement(db, { kind: KIND, result: "SHARED", evidence: ev, measuredAt: now }),
            /evidence is required/, `a result with ${label} evidence is a claim, not a measurement`);
  }

  // ---- the timestamp
  for (const [t, label] of [[0, "zero"], [-1, "negative"], [1.5, "fractional"], ["123", "a string"]]) {
    refuses(() => recordMeasurement(db, { kind: KIND, result: "SHARED", evidence: "x", measuredAt: t }),
            /positive integer of seconds/, `${label} is not a timestamp`);
  }

  // A FUTURE TIMESTAMP NEVER BECOMES STALE. `reviewer_supply.since` holds
  // 1800000000 -- January 2027 -- written by a test clock that reached a real
  // store, and nothing downstream has ever called it old because it is always
  // in the future. Refusing on write is what stops the next one.
  refuses(() => recordMeasurement(db, { kind: KIND, result: "SHARED", evidence: "x", measuredAt: now + 60 }),
          /is in the future/, "a future timestamp is refused: it would be permanently recent");
  refuses(() => recordMeasurement(db, { kind: KIND, result: "SHARED", evidence: "x", measuredAt: 1800000000 }),
          /is in the future/, "control: the exact test-clock value that reached a real store is refused");
  check(latestMeasurement(db, { kind: KIND })?.result === "INCONCLUSIVE",
        "control: none of the refusals above wrote anything");

  // ---- the schema refuses what the code would, if the code were bypassed.
  // The validator and the table are two lines of defence for one rule, and a
  // caller reaching the store directly is exactly the case the code cannot see.
  const direct = (sql) => { let m = null; try { db.prepare(sql).run(); } catch (e) { m = e.message; } return m; };
  check(direct(`INSERT INTO provider_measurement VALUES ('claude','k','R','',${now})`) !== null,
        "the table itself refuses empty evidence, not only the writer");
  check(direct(`INSERT INTO provider_measurement VALUES ('claude','k','','e',${now})`) !== null,
        "and an empty result");
  check(direct(`INSERT INTO provider_measurement VALUES ('claude','k','R','e',0)`) !== null,
        "and a non-positive timestamp");

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
