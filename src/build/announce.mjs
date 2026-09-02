/**
 * The builder's escalation identities, and the minter that refuses detail.
 *
 * An escalation key is an IDENTITY. `bt:7:lease:starved` is one situation
 * however long it has been starved; `bt:7:lease:starved:4200s` is a new
 * situation every tick, and a standing cause that re-announces itself is how an
 * unattended system trains its owner to ignore it -- measured elsewhere and it
 * generalises: alert acceptance drops about a third for each repeat.
 *
 * So the key carries only components that say WHICH situation this is -- the
 * task and the phase -- and everything that changes while the situation does
 * not, a count or a duration or a path or a sha, rides in the body.
 */
import { HOLD_ESCALATION, PHASES } from "./phases.mjs";
import { hubTx, hubEvent } from "./hubdb.mjs";
import { printable, redact, scrub } from "../notify.mjs";
import { assertWritable } from "./locks.mjs";

/**
 * How a stop is classified, for the body.
 *
 * Closed, and only what the builder can currently produce. A vocabulary padded
 * with types nothing emits reads as coverage and is not: a test that every type
 * reaching an announcement is declared stays green over a path that emits none.
 */
export const FAILURE_TYPES = Object.freeze(["FAILED", "UNCERTAIN", "REFUSED", "BLOCKED"]);

/**
 * The hold causes, FROM the map that already declares them.
 *
 * `HOLD_ESCALATION` is closed against `pr_hold`'s CHECK set rather than against
 * memory, and its own comment records why a second copy is a hazard: it would be
 * a second closed set to drift from the DDL. Re-typing its five entries here
 * would create precisely that. `blocked_other` maps to null -- its key is
 * supplied by the caller rather than declared -- so it contributes no shape.
 */
const HOLD_SHAPES = Object.values(HOLD_ESCALATION).filter(v => v !== null);

/**
 * Every identity this build can raise.
 *
 * MEASURED against source on 2026-09-01 rather than transcribed from the design:
 * the five above, plus `bt:<id>:infeasible` (`phases.mjs:274`),
 * `bt:<id>:phase:failed:<phase>` (`:465`), `bt:<id>:gate:revision-loop` (`:504`),
 * `bt:<id>:phase:blocked:<phase>` (`report.mjs:233`) and `builder:backup:failed`
 * (`backup.mjs:405`, `:433`). `depth:post-approval` is minted at `phases.mjs:561`
 * AND declared in the hold map, and it is one identity, not two.
 *
 * NOTHING IS LISTED THAT NOTHING RAISES. A shape no site can mint cannot be
 * exercised, so it is permanently unmeasured -- and inside a closed list an
 * entry that can never fire is indistinguishable from one that works. Three
 * shapes the design named are absent for that reason: `lease:conflict`,
 * `cancel:draining` and `sandbox:canary-failed` appear nowhere in `src/` or
 * `bin/`. They are added when a site raises them, not before.
 */
export const IDENTITY_SHAPES = Object.freeze([...new Set([
  ...HOLD_SHAPES,
  "bt:<id>:infeasible",
  "bt:<id>:phase:failed:<phase>",
  "bt:<id>:phase:blocked:<phase>",
  "bt:<id>:gate:revision-loop",
  "builder:backup:failed",
])].sort());

/**
 * The identities that may interrupt a human, as opposed to reaching a digest.
 *
 * Escalation and page are two different facts: an escalation is a durable row
 * that stops work, and a page is an interruption. Every identity above is
 * durable; only these reach a phone, because escalating everything is not the
 * safe end of the trade -- it is measurably worse than a load-aware policy, and
 * an over-pushing channel is muted within days and then worse than nothing.
 *
 * TWO, NOT THREE. The founder's list names `builder:sandbox:canary-failed` as
 * the third, and nothing in this repository raises it: a canary failure stops
 * every dispatch and reaches the digest only. It joins this list when a site
 * mints it, and not by being written down here first.
 */
export const PAGES = Object.freeze(["builder:backup:failed", "bt:<id>:phase:blocked:<phase>"]);

/**
 * The row image for a raise or a count change, IN THE CALLER'S TRANSACTION.
 *
 * `escalation` is replayed from `escalation.raised`, so a mutation this module
 * makes without one is a mutation a restore silently undoes. The ROW, never
 * just the key: `{ why }` alone loses the counters and timestamps the statement
 * just changed, so the log would record that something happened and not what it
 * now says.
 */
const raised = (db, why) => hubEvent(db, {
  kind: "escalation.raised",
  task: /^bt:/.test(why) ? subjectOf(why) : null,
  // `body` IS IN THE IMAGE. `escalation` is replayed from this event, so a
  // column absent here is a column a restore silently empties -- and what it
  // would empty is the only durable record of what the alert actually said.
  payload: db.prepare(
    "SELECT why, count, first_seen_at, last_seen_at, announced_count, body FROM escalation WHERE why = ?")
    .get(why),
});

/**
 * The ceiling on a stored report, in serialised bytes.
 *
 * Generous for what a report IS -- a failure type and a handful of named facts --
 * and small enough that re-appending it on every pass cannot outgrow the store.
 * Not shared with `notify`'s alert cap: that one exists because a phone is not a
 * log viewer, this one because an append-only authority table is not a spool, and
 * two limits that happen to be numbers are not one limit.
 */
const BODY_LIMIT = 4096;

/**
 * Every string in a report, scrubbed of credentials -- keys included.
 *
 * SCRUBBED BEFORE IT IS DURABLE, not on the way to the phone. `redact` runs on
 * the rendered alert, which is the last point before the text leaves the machine
 * -- but the body is written to `escalation.body` AND to the `escalation.raised`
 * payload, so an echoed token in a CI excerpt would be absent from the page and
 * present verbatim in the hub, in every snapshot of it, and in exported event
 * tails, surviving the escalation row being cleared.
 *
 * VALUE BY VALUE, never over the serialised text: a replacement landing across a
 * JSON escape boundary could corrupt the document, and a body that no longer
 * parses is a report lost to the guard that was protecting it.
 */
const scrubDeep = (v) =>
  typeof v === "string" ? scrub(v)
    : Array.isArray(v) ? v.map(scrubDeep)
    : v && typeof v === "object" && !(typeof v.toJSON === "function")
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), scrubDeep(x)]))
      // A value with its own `toJSON` decides its own serialisation, so scrub what
      // that PRODUCES rather than its enumerable shape, which may be empty.
      : v && typeof v === "object" ? scrubDeep(v.toJSON())
      : v;

/** What the caller passed, named the way the caller would recognise it. */
const describeBody = (body) =>
  Array.isArray(body) ? "an array"
    : typeof body !== "object" ? `a ${typeof body}`
    // NAMED SPECIFICALLY, because "an object" would be actively misleading here:
    // the value IS one, and the reason it is refused is invisible without saying
    // that its `toJSON` replaced it.
    : typeof body.toJSON === "function" ? `${body.constructor?.name ?? "an object"} (its toJSON does not return an object)`
    : "an object";

/**
 * The report, as the column stores it, or null where there is none.
 *
 * CANONICAL JSON, matching what `hub_event.payload` holds, so a reader learns
 * one serialisation rather than two. The column carries a `json_valid` CHECK, so
 * a value that cannot be serialised is refused HERE with a name rather than at
 * the write, where the error names a constraint and not the caller's mistake.
 */
/**
 * The body a pass OFFERS for a cause, or null where it offers none.
 *
 * ONE READING OF EMPTINESS, because the two sides of this seam read it
 * separately and disagreed. The persist side asked `serialiseBody(...) === null`
 * and the alert side asked `bodies.has(why)`, which is TRUE for a key mapped to
 * `undefined` -- and that is what `new Map(items.map(i => [i.why, i.body]))`
 * produces for any item carrying no body, which is the ordinary way to build
 * this map. The row then kept its stored report while the alert paged bare,
 * losing exactly the detail the column exists to keep.
 *
 * A key mapped to nothing is not an offer. Both sides now ask this.
 */
const offeredBody = (bodies, why) => {
  const b = bodies?.get(why);
  return b === null || b === undefined ? null : b;
};

const serialiseBody = (body) => {
  if (body === null || body === undefined) return null;
  let text;
  try { text = JSON.stringify(scrubDeep(body)); }
  catch { text = undefined; }
  // A REPORT, NOT A LOG. Every pass over a standing cause re-appends the row
  // image to `hub_event`, which is append-only and is the authority store, so an
  // unbounded body is an unbounded write rate: a megabyte of CI excerpt
  // re-measured once a minute is gigabytes a day, and the file it exhausts is the
  // one everything else depends on.
  //
  // REFUSED RATHER THAN TRUNCATED, and that is the same trade as everywhere else
  // here: silently cutting a report in half loses the detail at exactly the point
  // it was needed, and reports success. A producer over this cap is putting a log
  // where a summary belongs, which is a defect in the producer.
  if (typeof text === "string" && text.length > BODY_LIMIT)
    throw refuse("escalation_body_too_large",
      `an escalation body must serialise to at most ${BODY_LIMIT} bytes; this one is ${text.length}. ` +
      "Every pass over a standing cause re-appends it to the append-only log, so an unbounded report " +
      "is an unbounded write rate. Put a summary here and the full output in the run's artifacts.");
  // THE SERIALISED FORM IS WHAT GETS STORED, so it is the form that has to be a
  // renderable object -- not the value handed in. Checking the input instead is
  // one check on the wrong side of the boundary: `toJSON` decides what
  // `JSON.stringify` produces, and a `Date` returns a STRING from it. Such a body
  // is an object, is not an array, and serialises perfectly -- then stores as a
  // bare JSON string, renders NO detail because `Object.entries(new Date())` is
  // empty, and is rejected as unrenderable when the next pass reads it back.
  // The report is lost silently, which is the one outcome this column exists to
  // prevent.
  //
  // ONE CHECK, on the value that is actually persisted. It subsumes the input
  // cases -- a string, an array, a number and an unserialisable value all fail it
  // -- so there are not two rules here that can drift apart.
  let shape;
  if (typeof text === "string") { try { shape = JSON.parse(text); } catch { shape = undefined; } }
  // THE WHOLE CONTRACT, AT THE BOUNDARY EVERY BODY CROSSES. `body()` checked the
  // failure type and `announce` accepted whatever the `bodies` map held, so a
  // caller building that map directly -- which the exported signature invites --
  // bypassed the vocabulary entirely. `{}`, an Error that serialises to `{}`, and
  // `{ type: "UNKNOWN_VALUE" }` were all persisted and marked delivered while
  // producing an alert with no type and no detail.
  //
  // This is the THIRD instance of one shape in this file: validating the value
  // handed in rather than the value stored, validating the render source rather
  // than the stored source, and now a vocabulary enforced by a helper nobody is
  // obliged to call. A rule that only a convenience constructor applies is a
  // suggestion. `body()` stays as the ergonomic way to build one and is no longer
  // the only thing that checks it.
  if (shape !== null && typeof shape === "object" && !Array.isArray(shape) &&
      !FAILURE_TYPES.includes(shape.type))
    throw refuse("escalation_body_type",
      `an escalation body must name a failure type (${FAILURE_TYPES.join(", ")}); this one says ` +
      `${JSON.stringify(shape.type)}. The type is what tells "it stopped" from "it may have stopped", ` +
      "and an alert without one asks a human to guess which.");
  if (shape === null || typeof shape !== "object" || Array.isArray(shape))
    throw refuse("escalation_body_shape",
      `an escalation body must serialise to a JSON object; ${describeBody(body)} did not. ` +
      "The alert renders a body by walking its entries, so anything else pages its characters " +
      "or pages nothing at all. `body({ type, ...detail })` builds one and names the failure type.");
  return text;
};

/** A refusal that says WHICH rule it broke, so a caller can tell them apart. */
const refuse = (kind, message) => Object.assign(new Error(message), { kind });

// A kind is dot-free, space-free, lowercase segments joined by colons. A space is
// the cheapest way to smuggle a duration into a key and still look like a kind.
const KIND = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/;
// A task id is ALREADY `bt:<something>`; the placeholder in the shapes is
// `bt:<id>` for the same reason, and substituting a bare id yields `bt:bt:1`.
const TASK = /^bt:[0-9A-Za-z]+$/;

/**
 * The declared shape a minted key belongs to, or null.
 *
 * The task id and the phase are the only variable components, so a key is
 * reduced by replacing exactly those two and nothing else.
 */
export const shapeOf = (key) => {
  const withTask = String(key ?? "").replace(/^bt:[0-9A-Za-z]+:/, "bt:<id>:");
  // ONLY AN ACTUAL PHASE. Reducing any uppercase tail let a detail component
  // masquerade as one: `bt:7:phase:blocked:DETAIL` reduced to the declared
  // blocked shape and therefore PAGED, and that is reachable today through the
  // `blocked_other` branch, which writes a caller-supplied key with no check at
  // all. Membership of `PHASES` is the whole difference between a phase and a
  // word that is shouting.
  const tail = /:([A-Z][A-Z_]*)$/.exec(withTask);
  const shape = tail && PHASES.includes(tail[1])
    ? withTask.slice(0, tail.index) + ":<phase>"
    : withTask;
  return IDENTITY_SHAPES.includes(shape) ? shape : null;
};

/**
 * What a cause is ABOUT, so a pass can say whether it looked at it.
 *
 * A task identity is about its task; a process identity is about the SUBSYSTEM
 * that raises it -- `builder:backup:failed` is about `builder:backup`, and only
 * a backup can say anything about whether it recovered.
 */
export const subjectOf = (why) => {
  const task = /^(bt:[0-9A-Za-z]+):/.exec(String(why ?? ""));
  if (task) return task[1];
  const proc = /^(builder:[a-z][a-z0-9-]*)/.exec(String(why ?? ""));
  return proc ? proc[1] : null;
};

/**
 * Mint an escalation key, or refuse.
 *
 * Refuses rather than sanitises: a key quietly stripped of its detail is a key
 * the caller believes carries it, and the body it should have ridden in never
 * gets written.
 *
 * The closed-set check at the end is what makes this more than a formatter. A
 * key that matches no declared shape is a situation nobody wrote down, so the
 * page list cannot decide about it and `task resolve` cannot name it -- it would
 * be raised into a namespace nothing reads. `transition.mjs`'s `blocked_other`
 * branch takes an escalation key straight from its caller and writes it with no
 * check at all; wiring that branch through here is what closes it, and until it
 * is wired this function governs only the callers that use it.
 */
export function escalationKey(spec = {}) {
  if (spec === null || typeof spec !== "object")
    throw refuse("escalation_key_shape", `escalationKey wants an object, got ${typeof spec}`);
  const extra = Object.keys(spec).filter(k => !["task", "kind", "phase"].includes(k));
  if (extra.length)
    throw refuse("escalation_key_detail",
      `escalationKey refuses ${extra.map(e => JSON.stringify(e)).join(", ")}: a key carries only ` +
      `task, kind and phase. Detail changes while the situation does not, and a key that changes ` +
      `with it raises a new escalation every tick -- put it in the body.`);

  const { task = null, kind = null, phase = null } = spec;
  if (typeof kind !== "string" || !KIND.test(kind))
    throw refuse("escalation_key_shape",
      `escalationKey: ${JSON.stringify(kind)} is not a kind. A kind is lowercase segments joined ` +
      `by colons, so a space or an uppercase word is detail wearing a kind's clothes.`);
  if (task !== null && !TASK.test(task))
    throw refuse("escalation_key_shape",
      `escalationKey: ${JSON.stringify(task)} is not a task id (they look like bt:01H9...).`);
  if (phase !== null && !PHASES.includes(phase))
    throw refuse("escalation_key_shape",
      `escalationKey: ${JSON.stringify(phase)} is not one of the phases (${PHASES.join(", ")}).`);
  // A process-scoped identity belongs to no task, so it is in no phase either.
  if (phase !== null && task === null)
    throw refuse("escalation_key_shape",
      `escalationKey: a phase needs a task -- \`builder:\` identities belong to the process.`);

  const key = `${task ?? "builder"}:${kind}${phase === null ? "" : `:${phase}`}`;
  if (shapeOf(key) === null)
    throw refuse("escalation_key_undeclared",
      `escalationKey: ${JSON.stringify(key)} matches no declared identity. Declare it in ` +
      `IDENTITY_SHAPES when a site raises it; a key nothing declares is raised into a namespace ` +
      `nothing reads.\n-> declared: ${IDENTITY_SHAPES.join(", ")}`);
  return key;
}

/**
 * The body an escalation carries, where every changing fact belongs.
 *
 * Typed, because "it stopped" and "it may have stopped" want different answers
 * from a human, and a body that cannot say which is a body that reports the
 * safest reading of itself.
 */
export function body({ type, ...detail } = {}) {
  if (!FAILURE_TYPES.includes(type))
    throw refuse("escalation_body_type",
      `body: ${JSON.stringify(type)} is not a failure type (${FAILURE_TYPES.join(", ")}).`);
  return Object.freeze({ type, ...detail });
}

/**
 * Refuse a store that is not the builder's hub.
 *
 * The guardian's store has an `escalation` table of the SAME shape -- measured
 * 2026-09-01, the two stores share exactly three tables: `escalation`, `inbox`
 * and `outbox`. So handing this module a guardian store would not fail: it would
 * silently write builder identities into the guardian's escalations, and nothing
 * anywhere would report that it had.
 *
 * The guardian half of that symmetry needs no code and is asserted rather than
 * built: `openHubAsGuest`'s allowlist admits only `provider_lease`,
 * `provider_state`, `pr_hold` and `maintenance_lock`, so the guardian's own
 * `announceable` throws on the hub before it reads a row.
 *
 * PROVENANCE, NOT ABSENCE. This asks whether the store carries the hub's own
 * migration ledger and its core table, rather than whether it lacks something a
 * guardian store happens to have: absence has no natural positive control, and a
 * store that is neither would answer "not a guardian" perfectly well. Both are
 * checked because one table name could coincide; `schema_version` is the ledger
 * the hub cannot exist without, and the guardian store does not have it.
 */
export function assertHub(db) {
  for (const [table, why] of [["schema_version", "the hub's migration ledger"],
                              ["task", "the builder's own tasks"]]) {
    let ok = false;
    try { db.prepare(`SELECT count(*) c FROM ${table}`).get(); ok = true; } catch { ok = false; }
    if (!ok)
      throw refuse("not_a_hub",
        `this store has no ${table} table (${why}), so it is not the builder's hub. The guardian's ` +
        `store carries an escalation table of the same shape, and writing builder identities into ` +
        `it would land silently and be reported by nothing.`);
  }
  return db;
}

/**
 * Reduce this pass's escalations against the standing set.
 *
 * The builder's copy of the guardian's `announceable`, and deliberately a COPY:
 * that one reads the guardian store's own `escalation` table, and neither
 * process may read the other's. The SHAPE is what is shared, not the code.
 *
 * A cause is announced when it ARRIVES and when its shape CHANGES, never on
 * every pass. Clearing is announced too, because an operator who is only ever
 * told about problems cannot tell "resolved" from "reeve stopped looking".
 *
 * ABSENCE IS NOT SUCCESS, and this is the property the guardian paid for in
 * production rather than one it reasoned its way to. A pass that could not
 * examine a task simply does not produce its escalation, and retiring the cause
 * on that silence announces "resolved" for something nobody looked at -- then
 * re-announces it on the next pass that does look, with the reason string
 * identical each time. Two pushes for one unchanged condition is how a channel
 * earns being muted, and a muted channel is worse than none.
 *
 * So `covered` names the tasks this pass actually examined, and `complete` says
 * whether it finished what it set out to do. A `builder:` identity names no
 * task, so only a complete pass may retire it. `covered: null` is a caller
 * making no claim rather than a caller promising it looked everywhere.
 *
 * @param {Map<string, number>} escalations  identity -> how many subjects share it
 * @returns {{fresh: {why: string, count: number}[], cleared: string[]}}
 */
export function builderAnnounceable(db, escalations, {
  at = Math.floor(Date.now() / 1000), isAlive, examined = null, bodies = null } = {}) {
  assertHub(db);
  // EXPLICIT, never defaulted. `assertWritable` reads the restore lock and asks
  // whether its holder is alive; a predicate that always answered true would
  // leave a dead restore's lock standing for ever, and one that always answered
  // false would reap a LIVE restore's lock and write into a hub being replaced
  // underneath this process.
  if (typeof isAlive !== "function")
    throw refuse("not_writable",
      "builderAnnounceable needs an isAlive predicate: it writes, and whether a restore holds the " +
      "hub is decided by whether that restore's process is still running.");

  return hubTx(db, () => {
    assertWritable(db, { isAlive, at, inTx: true });
    const fresh = [], cleared = [], clearable = [];
    const standing = new Map(
      db.prepare("SELECT why, count, announced_count FROM escalation").all().map(r => [r.why, r]));

    for (const [why, count] of escalations) {
      const prev = standing.get(why);
      if (!prev) {
        // ANNOUNCED_COUNT 0: RAISED, NOT YET ANNOUNCED. Writing `count` here
        // claimed the announcement before anything had been sent, so a page the
        // sender refused was never retried -- the next pass saw an unchanged
        // `announced_count`, produced no `fresh` item, and the operator was
        // never told, while `declined` had already scrolled past. 0 is also what
        // `applyTransition` raises with, so a cause raised by a transition and
        // one raised here are the same row to this function.
        db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count,body)
                    VALUES(?,?,?,?,0,?)`).run(why, count, at, at, serialiseBody(offeredBody(bodies, why)));
        raised(db, why);
        fresh.push({ why, count });
      } else {
        // THE REPORT IS REFRESHED, THE COUNTERS ARE NOT RESET. A standing cause
        // measured again carries a newer report -- a different path, a later
        // error -- and the row should say what is true now. A caller that offers
        // no body leaves the stored one alone rather than erasing it: absence of
        // a report in this pass is not evidence that the report is gone.
        const body = serialiseBody(offeredBody(bodies, why));
        if (body === null)
          db.prepare("UPDATE escalation SET count=?, last_seen_at=? WHERE why=?").run(count, at, why);
        else
          db.prepare("UPDATE escalation SET count=?, last_seen_at=?, body=? WHERE why=?")
            .run(count, at, body, why);
        raised(db, why);
        // The count is the SHAPE of a shared cause: one task blocked at RESEARCH
        // and four blocked there are different situations, and both deserve
        // saying. Comparing against `announced_count` rather than against
        // `count` is what makes a repeat silent and a change loud -- and it is
        // now also what makes an undelivered page come back.
        if (prev.announced_count !== count) fresh.push({ why, count });
      }
    }

    for (const why of standing.keys()) {
      if (escalations.has(why)) continue;
      // POSITIVE EVIDENCE, OR THE CAUSE STANDS. Not "the pass finished", not
      // "no coverage was claimed" -- the subject of THIS cause has to have been
      // re-examined, and `examined` is the only thing that says so.
      //
      // Both weaker readings were wrong in the same direction. A pass that made
      // no coverage claim retired every task cause, which is the false-clear
      // cycle this function exists to prevent, arriving through the default. And
      // a COMPLETE pass retired `builder:backup:failed` even though an ordinary
      // pass runs no backup: the guardian holds those failures on `ctx` and
      // re-emits them every tick for exactly this reason, and only a snapshot
      // actually TAKEN clears one.
      const subject = subjectOf(why);
      if (subject === null || examined === null || !examined.has(subject)) continue;
      // A PAGING CAUSE IS NOT DELETED HERE. Its recovery has to reach the same
      // human the alarm did, and deleting the row first destroys the only
      // durable record that a clearing is owed -- so a channel that was down for
      // one pass lost the recovery permanently, while the raise it is recovering
      // from had just been taught to wait. The same rule on both sides: the
      // durable state changes when the notification lands, not before.
      // AND ONLY IF THE ALARM WAS EVER DELIVERED. A cause every channel declined
      // still has `announced_count` 0, so a recovery sent for it tells the reader
      // a situation they were never informed of has ended -- which is worse than
      // silence, because it invites them to look for an alert that does not
      // exist. An undelivered cause is retired without a word.
      if (pages(why) && standing.get(why).announced_count > 0) {
        clearable.push(why);
        continue;
      }
      clearOne(db, why);
      cleared.push(why);
    }
    return { fresh, cleared, clearable };
  });
}

/**
 * Retire a cause, and log it, in one transaction.
 *
 * Separated because a paging cause is retired only once its recovery has been
 * delivered, which happens outside the reduction that decided it was retirable.
 */
export function clearEscalation(db, why, { isAlive, at = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof isAlive !== "function")
    throw refuse("not_writable", "clearEscalation writes, so it needs an isAlive predicate.");
  return hubTx(db, () => {
    assertWritable(db, { isAlive, at, inTx: true });
    clearOne(db, why);
  });
}

/** The delete and its event, IN THE CALLER'S TRANSACTION. */
function clearOne(db, why) {
  db.prepare("DELETE FROM escalation WHERE why=?").run(why);
  // `escalation` is in the replayed set and `escalation.raised` is its only
  // other event, so a snapshot whose tail spans a clear replays the raise and
  // resurrects the row -- paging the founder again about something resolved
  // before the restore.
  hubEvent(db, { kind: "escalation.cleared",
                 task: /^bt:/.test(why) ? subjectOf(why) : null, payload: { why } });
}

/**
 * Does this identity interrupt a human?
 *
 * Answered by REDUCING the key to its declared shape rather than by matching it
 * against a second list of patterns. A page list of literal keys would fire for
 * exactly one task id and send every other blocked task silently to the digest;
 * a `startsWith` would page for `bt:7:phase:blocked` with no phase at all. Both
 * are second statements of "which identity is this", and `shapeOf` is the first
 * one -- so this asks it, and there is one rule to get wrong instead of two.
 */
export const pages = (key) => PAGES.includes(shapeOf(key));

/**
 * The single action that changes each situation.
 *
 * §11.7 ends "Every alert names the single founder action needed", and an alert
 * that arrives on a phone at night without one is a notification the reader can
 * only file away. The identity says what happened; this says what to do about
 * it, and the two together are the whole of what a page is for.
 *
 * CLOSED against `IDENTITY_SHAPES`, and asserted to be: an identity added
 * without an action would page with nothing to do, which is the shape that
 * teaches a reader to stop opening them.
 */
export const ACTION_FOR = Object.freeze({
  "bt:<id>:phase:blocked:<phase>":
    "reeve task why <id> — a worker stopped and named a reason only you can settle",
  "bt:<id>:phase:failed:<phase>":
    "reeve task why <id> — retries are exhausted for this phase",
  "bt:<id>:infeasible":
    "reeve task why <id> — the task was judged infeasible and will not resume",
  "bt:<id>:gate:revision-loop":
    "reeve task why <id> — the spec has hit the revision cap and needs your decision",
  "bt:<id>:depth:post-approval":
    "reeve task why <id> — the depth changed after approval",
  "bt:<id>:intake:ownership-lost":
    "reeve task why <id> — the repository is no longer owned as admission recorded it",
  "bt:<id>:impl:harness-touched":
    "reeve task why <id> — the worker changed the harness it is judged by",
  "bt:<id>:impl:over-budget":
    "reeve task why <id> — the implementation exceeded its budget",
  "bt:<id>:spec:reopened":
    "reeve task why <id> — an approved spec was reopened",
  "builder:backup:failed":
    "reeve backup --hub — there is no working snapshot until this succeeds",
});

/**
 * The action for a concrete key, with the task substituted, or null.
 *
 * `<id>` IS REPLACED. The shapes carry the placeholder because they are shapes,
 * and an alert that tells the founder to run `reeve task why <id>` hands them a
 * command they cannot paste -- under a shell `<id>` is input redirection -- and
 * makes them reconstruct the very identifier the alert is holding.
 */
export const actionFor = (key) => {
  const action = ACTION_FOR[shapeOf(key)] ?? null;
  if (action === null) return null;
  const subject = subjectOf(key);
  return subject === null ? action : action.replaceAll("<id>", subject);
};

/**
 * Record every escalation, and interrupt a human about the few that earn it.
 *
 * FAIL-CLOSED IS NEVER FAIL-QUIET, and the two halves of that are separate here.
 * Every identity becomes a durable row that stops work and is read by `task
 * show`, `task why` and `task dash` -- nothing stops being recorded. Only the
 * page list reaches a phone.
 *
 * `declined` is the third answer and it is the one that keeps this honest. A
 * page that was owed and could not be delivered is neither paged nor digested,
 * and collapsing it into either would report a phone call that never happened or
 * hide one that was needed. The row still stands in the store either way.
 *
 * Clearing is dispatched too, for the identities that page. An operator who is
 * only ever told about problems cannot tell "resolved" from "reeve stopped
 * looking", and computing `cleared` without sending it implements half of that
 * sentence.
 */
export function announce(db, {
  escalations, at = Math.floor(Date.now() / 1000), isAlive, send,
  profile = null, examined = null, bodies = null } = {}) {
  if (typeof send !== "function")
    throw refuse("not_writable",
      "announce needs a send function: whether a page reached anyone is the one thing this " +
      "cannot infer, and a default that silently succeeded would report delivery it never made.");

  const { fresh, cleared, clearable } =
    builderAnnounceable(db, escalations, { at, isAlive, examined, bodies });

  /**
   * The report for a cause: this pass's, else the one the row already holds.
   *
   * A cause raised by `applyTransition` carries no body through this call at
   * all, so reading only the caller's map would page it bare while the durable
   * row had the report all along.
   */
  const bodyFor = (why) => {
    // THE STORED ROW, ALWAYS -- never the object the caller handed in, because
    // the two can differ and the stored one is what everything else will see.
    // `toJSON` decides what is persisted, so a body whose `toJSON` replaces its
    // shape stored the useful report and paged the ORIGINAL: an object with no
    // enumerable properties renders as nothing, so the FIRST alert carried
    // neither the failure type nor the detail while the row held both, and every
    // LATER alert for the same cause -- read from the row -- disagreed with it.
    //
    // `builderAnnounceable` has already written this pass's body by the time
    // anything dispatches, and a clearing reads this before the row is deleted,
    // so the row is available to both and is the one answer they share. Preferring
    // the caller's map was a second source for a value that has one.
    const stored = db.prepare("SELECT body FROM escalation WHERE why = ?").get(why)?.body ?? null;
    if (stored === null) return null;
    // A row that cannot be parsed is reported as having no body rather than
    // throwing: the alert is the thing that matters, and losing it because its
    // detail is malformed would be the wrong trade.
    // THE SAME SHAPE RULE THE WRITE SIDE APPLIES, for a row written around it --
    // `json_valid` accepts a bare string or number, so direct SQL can put one
    // here. Unrenderable and unparseable get the same answer for the same
    // reason: the alert matters more than its detail.
    try {
      const parsed = JSON.parse(stored);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  };
  const paged = [], digested = [], declined = [];

  /**
   * Record that a cause has been SURFACED at this count, so the next pass is
   * silent about it. Deliberately not part of raising: a page the sender refused
   * has not been surfaced, and marking it before the send is what made an
   * undelivered page unretryable.
   */
  const markAnnounced = (why, count) => hubTx(db, () => {
    assertWritable(db, { isAlive, at, inTx: true });
    db.prepare("UPDATE escalation SET announced_count=? WHERE why=?").run(count, why);
    raised(db, why);
  });

  const dispatch = (why, count, kind, body) => {
    const isCleared = kind === "cleared";
    // THE TRANSITION IS IN THE TEXT, not in a metadata field. `notify` renders
    // title, message, priority and tags and nothing else, so a clearing that
    // said only `kind: "cleared"` reached the phone reading exactly like a fresh
    // incident -- and its body said "(x0)", which is worse than saying nothing.
    // SANITISE THE PARTS, THEN ASSEMBLE. `printable` escapes every control
    // character, and a line feed is one -- so passing the finished message
    // through it turned this surface's own separators into a literal backslash-n
    // and delivered the identity, the action and the detail as a single run-on
    // line with visible escapes. The layout the action depends on was destroyed
    // by the boundary added to protect it, and an assertion that the action is
    // PRESENT could not see the difference.
    //
    // So each untrusted value is cleaned on its own, and the line breaks between
    // them are this file's, never the body's: a detail containing a newline is
    // still escaped and cannot forge a line, which is the property that mattered.
    const clean = (v) => printable(String(v ?? ""));
    const detail = body
      ? Object.entries(body).filter(([k]) => k !== "type")
          .map(([k, v]) => `\n${clean(k)}: ${clean(v)}`).join("")
      : "";
    // THE ACTION, ON EVERY ALERT. An identity says what happened; without the one
    // command that changes it, a page read at night is a notification the reader
    // can only file away -- and a channel whose alerts cannot be acted on is one
    // that gets muted, which is the outcome the closed page list exists to avoid.
    const action = actionFor(why);
    // THE ACTION GOES ABOVE THE DETAIL, and that ordering is load-bearing rather
    // than cosmetic. `redact` caps a message at its own limit and truncates the
    // TAIL, so an action appended after an externally supplied body is the first
    // thing a long CI error deletes -- producing exactly the actionless alert
    // this exists to prevent, and only for the alerts whose detail is longest.
    // Reordering removes the dependency; reserving a byte count would inherit a
    // constant from another module and drift from it.
    const raw = isCleared
      ? `CLEARED — ${clean(why)} is no longer standing.`
      // The count is the shape of a shared cause, and it is only worth saying
      // when it is more than one.
      : `${clean(why)}${count > 1 ? ` (${count} subjects)` : ""}` +
        `${body?.type ? ` [${clean(body.type)}]` : ""}` +
        `${action ? `\n-> ${clean(action)}` : ""}${detail}`;
    // SANITISED AT THE BOUNDARY, exactly as `buildAlert` does it. A body carries
    // externally sourced text -- CI output, a pathname, a validation error -- and
    // this is the last point before it leaves the machine. `notify` does not do
    // it: `buildAlert` is the only caller that ever has, so a second producer of
    // alerts is a second place the boundary has to be applied, and skipping it
    // lets control characters forge a rendered alert and an echoed credential
    // leave the host.
    // `redact` LAST and on the whole, because it neutralises secret SHAPES that
    // can span the parts and applies the length cap once. It does not touch line
    // feeds, so the assembled layout survives it -- which is the whole reason the
    // two halves of the boundary are applied at different granularities.
    const title = redact(clean(isCleared ? `reeve: CLEARED ${why}` : `reeve: ${why}`));
    const message = redact(raw);

    // THE SENDER'S OWN VERDICT, never an assumption. A throw and an `ok: false`
    // are the same fact to a reader who needs to know a human was not reached.
    let result = null, failure = null;
    try {
      result = send({ title, message, kind, why, count, body: body ?? null, profile,
        // A PAGE IS AN INTERRUPTION, and it has to be sent as one. `notify`
        // falls back to "default" when an alert names no priority, so the
        // closed page list would have delivered ordinary notifications while
        // promising a phone call. A CLEARING is deliberately not urgent: there
        // is nothing to do about it, and waking someone to say a problem ended
        // is how the channel earns being muted.
        priority: isCleared ? "default" : "high",
        tags: isCleared ? "white_check_mark" : "warning" });
    }
    catch (e) { failure = e.message; }
    // DELIVERED MEANS A HUMAN WAS REACHED, not that every channel worked.
    // `notify` reports `ok: false` when ANY configured channel fails while the
    // healthy one has already delivered -- so treating that as undelivered
    // re-pages the working channel on every pass until the broken one recovers,
    // which is the alert fatigue the page list exists to prevent. The failed
    // channel is not hidden: it rides on `channels`, and `reeve notify --test`
    // is the command that finds it. Nothing accepted is still a refusal.
    const accepted = (result?.channels ?? []).filter(c => c.ok);
    if (result?.ok || accepted.length)
      return { why, count, kind, body: body ?? null, channels: result?.channels ?? [],
               partial: !result?.ok };
    declined.push({ why, count, kind, body: body ?? null,
      not_sent: failure ?? result?.why ?? "the sender returned no reason" });
    return null;
  };

  for (const f of fresh) {
    const body = bodyFor(f.why);
    if (!pages(f.why)) {
      // THE DIGEST CANNOT DECLINE. It is the durable row itself, which is
      // already written, so surfacing there is complete the moment it exists.
      digested.push({ ...f, body });
      markAnnounced(f.why, f.count);
      continue;
    }
    const sent = dispatch(f.why, f.count, "raised", body);
    // ONLY ON SUCCESS. A refused page leaves `announced_count` where it was, so
    // the next pass raises it again rather than treating silence as delivery.
    if (sent) { paged.push(sent); markAnnounced(f.why, f.count); }
  }

  // THE RETIREMENT HAPPENS WHEN THE RECOVERY LANDS. `clearable` is the set the
  // reduction judged retirable and deliberately did not delete; a refused send
  // leaves the row standing, so the next pass offers the clearing again instead
  // of losing it.
  const retired = [...cleared];
  for (const why of clearable) {
    const sent = dispatch(why, 0, "cleared", bodyFor(why));
    if (!sent) continue;
    clearEscalation(db, why, { isAlive, at });
    paged.push(sent);
    retired.push(why);
  }
  return { paged, digested, declined, cleared: retired };
}
