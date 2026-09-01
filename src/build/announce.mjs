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
