// Measurements taken ABOUT the provider, kept as durable history.
//
// SEPARATE FROM `providerdb.mjs`, and the separation is the point. That module
// holds `provider_lease` and `provider_state`: the two tables the guardian's
// guest connection is authorised for, both process-scoped, both cleared by
// `restoreHub`. Its defining constraint is that NOTHING there writes
// `hub_event`, because a provider transaction on the guest connection would be
// denied the statement and every real claim and release would fail on it.
//
// A measurement is the opposite kind of fact. It is not about this machine or
// this run, it survives a restore, and it MUST be replayable -- so it needs the
// event write that module is forbidden. Putting it there would have meant either
// breaking that invariant or leaving the measurement unreplayable; it is here
// instead, written by a CLI command on the full hub connection, and
// `providerdb.mjs` keeps the property its comment claims for it.
import { hubEvent, hubTx } from "./hubdb.mjs";
import { assertWritable } from "./locks.mjs";

export const PROVIDER = "claude";

/**
 * What each measurement KIND is allowed to conclude.
 *
 * Declared, and consulted with `Object.hasOwn`, because an undeclared name must
 * THROW rather than answer. A lookup that returns undefined for a typo is
 * indistinguishable from one that returns undefined for a kind nobody has run
 * yet, so a misspelling would record silently and read back for ever as "not
 * measured". Plain property access would also answer for `toString` and
 * `constructor`, which are not measurement kinds.
 *
 * `pool-relationship` is deliberately NOT a number. It does not belong in
 * `provider_state`, whose `measured_at` asserts one narrow thing: that the
 * concurrency limit and guardian reservation in THAT row were measured. Writing
 * that column for this experiment would make doctor report the unmeasured
 * defaults as measured values.
 *
 * The schema carries this same vocabulary as CHECK constraints, and a test
 * asserts the two agree -- two inventories of one rule are only safe when
 * something fails loudly the moment they diverge.
 */
export const MEASUREMENT_KINDS = Object.freeze({
  "pool-relationship": Object.freeze(["SHARED", "SEPARATE", "INCONCLUSIVE"]),
});

const known = (kind) => Object.hasOwn(MEASUREMENT_KINDS, kind);

/**
 * Record one measurement, refusing anything it cannot stand behind.
 *
 * Every refusal is a defect this repository has already paid for once. An
 * undeclared kind or an unrecognised result throws rather than being stored,
 * because the store is what the arming gate reads. Evidence is mandatory: a
 * result with no provenance is a claim, and a claim outlives whoever made it
 * looking exactly like a measurement.
 *
 * A FUTURE TIMESTAMP IS REFUSED. `reviewer_supply.since` carries 1800000000 --
 * January 2027 -- written by a test clock that reached a real store, and a
 * future timestamp is permanently "recent" so nothing downstream ever calls it
 * stale.
 *
 * THE EVENT IS NOT OPTIONAL. `restoreHub` copies the snapshot and rebuilds
 * everything after it from the `hub_event` tail alone, so a row written after
 * the last snapshot with no event is dropped by a NORMAL restore that reports
 * success. For a table the arming gate reads, that is the answer and its
 * evidence disappearing silently.
 *
 * THE MAINTENANCE CHECK IS INSIDE THE LOCK. It used to run before the write, and
 * a top-level SAVEPOINT is DEFERRED -- it takes no write lock until its first
 * write. So a restore could take `maintenance_lock` and capture its tail in the
 * window after the check passed, this function would then insert the row and its
 * event into the live database the restore was about to replace, and the swap
 * would drop both while every call reported success. `providerTx` solves the same
 * race the same way, and the ordering it documents is the reason: the check runs
 * before argument validation, because a caller missing an identity during a
 * restore should be told about the restore -- that is the bigger fact and the one
 * still true a second later.
 *
 * The nested path is kept only for a caller that already holds an immediate
 * transaction. A SAVEPOINT inside one is atomic with it; a SAVEPOINT opened at
 * the top level only looks like it is.
 */
export function recordMeasurement(db, { provider = PROVIDER, kind, result, evidence, measuredAt,
                                        isAlive, inTx = false } = {}) {
  // REQUIRED, and checked by name rather than destructured. A restore holds the
  // maintenance lock precisely so writes stop, and a writer that skips this
  // check races the restore it cannot see. Destructuring alone would fail deep
  // inside `assertWritable` with a message about `isAlive` being undefined,
  // which tells the next author nothing about what they owe.
  if (typeof isAlive !== "function")
    throw new Error("recordMeasurement: isAlive is required -- the maintenance lock is what stops " +
                    "a write from racing a restore, and it can only be evaluated by the caller");

  const body = () => {
    assertWritable(db, { isAlive, inTx: true });
    if (!known(kind))
      throw new Error(`recordMeasurement: ${JSON.stringify(kind)} is not a declared measurement kind; ` +
                      `declared: ${Object.keys(MEASUREMENT_KINDS).join(", ")}`);
    const allowed = MEASUREMENT_KINDS[kind];
    if (!allowed.includes(result))
      throw new Error(`recordMeasurement: ${kind} cannot conclude ${JSON.stringify(result)}; ` +
                      `it concludes one of ${allowed.join(", ")}`);
    if (typeof evidence !== "string" || evidence.trim() === "")
      throw new Error("recordMeasurement: evidence is required -- a result without its readings " +
                      "is a claim, and nothing downstream can tell the two apart");
    if (!Number.isInteger(measuredAt) || measuredAt <= 0)
      throw new Error(`recordMeasurement: measuredAt must be a positive integer of seconds, got ${JSON.stringify(measuredAt)}`);
    const now = db.prepare("SELECT unixepoch() n").get().n;
    if (measuredAt > now)
      throw new Error(`recordMeasurement: measuredAt ${measuredAt} is in the future (now ${now}); ` +
                      `a future timestamp never becomes stale, so nothing would ever ask for it again`);
    db.prepare(
      `INSERT INTO provider_measurement (provider, kind, result, evidence, measured_at)
       VALUES (?, ?, ?, ?, ?)`).run(provider, kind, result, evidence, measuredAt);
    // THE ROW, not the key. A payload of `{provider, kind, measured_at}` would
    // record that a measurement happened and lose what it concluded, so a
    // replay would rebuild a row with no result and no evidence -- which reads
    // downstream as a measurement that says nothing rather than as data loss.
    hubEvent(db, { kind: "provider_measurement.recorded",
      payload: db.prepare(
        `SELECT provider, kind, result, evidence, measured_at FROM provider_measurement
          WHERE provider = ? AND kind = ? AND measured_at = ?`).get(provider, kind, measuredAt) });
    return { provider, kind, result, measuredAt };
  };

  if (!inTx) return hubTx(db, body);
  db.exec("SAVEPOINT record_measurement");
  try { const r = body(); db.exec("RELEASE record_measurement"); return r; }
  catch (e) {
    db.exec("ROLLBACK TO record_measurement");
    db.exec("RELEASE record_measurement");
    throw e;
  }
}

/**
 * The most recent measurement of one kind, with its AGE.
 *
 * The age travels with the answer because the answer alone is not usable: the
 * pool relationship depends on how the provider structures plans, so a reading
 * taken months ago can be confidently wrong. A caller handed only `result` has
 * no way to ask that question and will not think to.
 */
export function latestMeasurement(db, { provider = PROVIDER, kind } = {}) {
  if (!known(kind))
    throw new Error(`latestMeasurement: ${JSON.stringify(kind)} is not a declared measurement kind; ` +
                    `declared: ${Object.keys(MEASUREMENT_KINDS).join(", ")}`);
  const row = db.prepare(
    `SELECT result, evidence, measured_at FROM provider_measurement
      WHERE provider = ? AND kind = ? ORDER BY measured_at DESC LIMIT 1`).get(provider, kind);
  if (!row) return null;
  const now = db.prepare("SELECT unixepoch() n").get().n;
  // THE READ REFUSES WHAT THE WRITE WOULD HAVE. `recordMeasurement` is not the
  // only way a row arrives: a direct statement, a migration, or a replay of an
  // event written by an older binary all reach the table without passing it.
  // A future-dated row is precisely the one that must not be returned -- it
  // sorts newest for ever and its age is negative, so every staleness question
  // downstream answers "fresh" until someone notices by hand.
  //
  // Refused rather than skipped. Returning the row beneath it would answer the
  // caller's question with an older measurement while a corrupt one sits above
  // it unmentioned, and the arming gate would proceed on an answer nobody knows
  // is being shadowed.
  if (row.measured_at > now)
    throw new Error(`latestMeasurement: the newest ${kind} measurement is dated ${row.measured_at}, ` +
                    `which is after now (${now}). A future-dated row never becomes stale, so this is ` +
                    `refused rather than returned; correct or delete it before the arming gate reads it`);
  return { provider, kind, result: row.result, evidence: row.evidence,
           measuredAt: row.measured_at, ageSeconds: now - row.measured_at };
}
