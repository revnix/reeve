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
import { hubTx } from "./hubdb.mjs";
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
  const shape = String(key ?? "")
    .replace(/^bt:[0-9A-Za-z]+:/, "bt:<id>:")
    .replace(/:[A-Z][A-Z_]*$/, ":<phase>");
  return IDENTITY_SHAPES.includes(shape) ? shape : null;
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
  at = Math.floor(Date.now() / 1000), isAlive, covered = null, complete = true } = {}) {
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
    const fresh = [], cleared = [];
    const standing = new Map(
      db.prepare("SELECT why, count, announced_count FROM escalation").all().map(r => [r.why, r]));

    for (const [why, count] of escalations) {
      const prev = standing.get(why);
      if (!prev) {
        db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
                    VALUES(?,?,?,?,?)`).run(why, count, at, at, count);
        fresh.push({ why, count });
      } else {
        db.prepare("UPDATE escalation SET count=?, last_seen_at=? WHERE why=?").run(count, at, why);
        // The count is the SHAPE of a shared cause: one task blocked at RESEARCH
        // and four blocked there are different situations, and both deserve
        // saying. Comparing against `announced_count` rather than against
        // `count` is what makes a repeat silent and a change loud.
        if (prev.announced_count !== count) {
          db.prepare("UPDATE escalation SET announced_count=? WHERE why=?").run(count, why);
          fresh.push({ why, count });
        }
      }
    }

    for (const why of standing.keys()) {
      if (escalations.has(why)) continue;
      // The subject is the TASK where there is one. A task id is already two
      // colon-separated components, so the subject is the first two and the
      // cause is the rest.
      const task = /^(bt:[0-9A-Za-z]+):/.exec(why)?.[1] ?? null;
      const looked = task === null ? complete : (covered === null || covered.has(task));
      if (!looked) continue;
      db.prepare("DELETE FROM escalation WHERE why=?").run(why);
      cleared.push(why);
    }
    return { fresh, cleared };
  });
}
