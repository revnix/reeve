// report -- the phase report's schema, its validation, and what it becomes.
//
// The CLI's structured result is validated LOCALLY against the same schema that
// was passed to it, because `--json-schema` is a request and not a guarantee.
// Nothing here decides anything the phase machine decides: an outcome becomes
// evidence, and `nextPhase` rules on it.
import { readFileSync } from "node:fs";
// NOT A SECOND LIST OF THE SAME THREE NAMES. `BUILD_ACTION_FOR` already exists,
// is exported, and carries a comment saying in as many words that a second
// inventory of these three names is the defect this codebase keeps finding --
// so this module derives both of its maps from it rather than writing
// `{BUILD_SIZE: "SIZING", ...}` out again. The plan specified the literal; the
// literal would have been correct on the day it was written, which is the only
// day a duplicate ever is.
import { BUILD_ACTION_FOR, BUILD_ACTIONS } from "./phases.mjs";

/** The three actions a phase worker is dispatched under. */
export const ACTIONS = BUILD_ACTIONS;

/**
 * Action -> the phase it reports for, inverted from the map the machine owns.
 *
 * The two vocabularies do not match by rule (`SIZING` dispatches as
 * `BUILD_SIZE`, not `BUILD_SIZING`), which is exactly why the inversion is
 * computed rather than typed: a hand-written inverse is wrong for one entry in
 * three the first time either side gains a phase.
 */
export const PHASE_FOR_ACTION = Object.freeze(Object.fromEntries(
  Object.entries(BUILD_ACTION_FOR).map(([phase, action]) => [action, phase])));

// DEEPLY FROZEN, because the cache is shared and its contents are handed to
// every caller. One consumer mutating the object it was given would change what
// every later validation enforces, and the freeze fixture would go on reporting
// the contract intact -- it hashes the same mutated object.
const deepFreeze = (v) => {
  if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); Object.freeze(v); }
  return v;
};
const CACHE = new Map();
function load(action) {
  if (!ACTIONS.includes(action)) throw new Error(`no report schema for ${JSON.stringify(action)}`);
  if (!CACHE.has(action)) {
    const text = readFileSync(new URL(`./schemas/${action.toLowerCase()}.json`, import.meta.url), "utf8");
    CACHE.set(action, { text, schema: deepFreeze(JSON.parse(text)) });
  }
  return CACHE.get(action);
}

/** The parsed schema, for validating a report against it. */
export const schemaFor = (action) => load(action).schema;

/**
 * The schema AS TEXT, which is what `--json-schema` takes.
 *
 * `workerArgs` pushes its `jsonSchema` straight into the argv array
 * (`src/supervisor.mjs:149`) and its tested contract is serialized JSON
 * (`test/worker-args.test.mjs`, `'{"type":"object"}'`). The documented handoff
 * passes `schemaFor(action)` -- a parsed OBJECT -- so every phase dispatch
 * following it would spawn a worker with the literal string `[object Object]`
 * as its structured-output contract. Not a validation failure: an argument that
 * is syntactically fine and semantically nothing, on all three phases at once.
 *
 * It returns the FILE'S TEXT rather than a re-serialization, so what the worker
 * is asked for is byte-identical to what the freeze fixture hashes and what a
 * reviewer read.
 */
export const schemaTextFor = (action) => load(action).text;

// The subset of JSON Schema these three files use, and no more. A dependency is
// not added for it, and a validator that silently ignores a keyword it does not
// implement would make a schema look stricter than it is -- so an unknown
// keyword is an error here rather than a shrug.
const KNOWN = new Set(["$schema", "title", "type", "enum", "required", "properties",
                       "additionalProperties", "items", "minItems", "minLength", "minimum"]);
function walk(schema, value, path, errors) {
  for (const k of Object.keys(schema))
    if (!KNOWN.has(k)) errors.push(`${path}: schema uses unimplemented keyword ${k}`);
  if (schema.enum && !schema.enum.includes(value))
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected an object`);
      return errors;
    }
    for (const r of schema.required ?? [])
      if (!Object.prototype.hasOwnProperty.call(value, r)) errors.push(`${path}${r}: required and missing`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (!sub) { if (schema.additionalProperties === false) errors.push(`${path}${k}: not declared by this schema`); continue; }
      walk(sub, v, `${path}${k}.`, errors);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) { errors.push(`${path}: expected an array`); return errors; }
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path}: needs at least ${schema.minItems} item(s), got ${value.length}`);
    value.forEach((v, i) => schema.items && walk(schema.items, v, `${path}${i}.`, errors));
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) { errors.push(`${path}: expected an integer`); return errors; }
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
  } else if (schema.type === "string") {
    if (typeof value !== "string") { errors.push(`${path}: expected a string`); return errors; }
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: is empty`);
  }
  return errors;
}

/**
 * Validate a structured result against its action's schema.
 *
 * THE ERROR LIST IS THE CALLER'S, not `walk`'s return value. Written as
 * `const errors = walk(...)`, every branch that returns early returned
 * `errors.push(...)` -- a NUMBER -- so `errors.length` read `undefined`, which
 * is falsy, and `validateReport("BUILD_SIZE", "not an object")` answered
 * `{ok: true}`. The scalar case is the only one that takes an early return at
 * the ROOT, and it is the case a worker producing prose instead of JSON hits.
 *
 * `kind: "BAD_REPORT"` on the refusal because that is the shape S3-D's consumed
 * table names and dispatches on; without it the consumer branches on a field
 * that is never set.
 */
export function validateReport(action, value) {
  const errors = [];
  walk(schemaFor(action), value, "", errors);
  return errors.length ? { ok: false, kind: "BAD_REPORT", errors } : { ok: true, report: value };
}

/**
 * An outcome, as the evidence `nextPhase` already accepts.
 *
 * It invents nothing. A `blocked` report with no escalation identity produces
 * evidence with no escalation identity, and the machine refuses it -- because
 * the rule that a blocked_other must reach a founder has one home, and a default
 * supplied here would be a second copy of it that nobody could see.
 *
 * THE REPORT IS VALIDATED AGAINST THIS ACTION, not merely checked for a known
 * outcome word. Checking the word alone, `{outcome:"ok", reason:"researched",
 * artifact:"research.md"}` -- a valid RESEARCH report -- produced a successful
 * DESIGN evidence when handed in with `BUILD_DESIGN`, which `nextPhase` accepts
 * while the task is in DESIGN. That is precisely the miswired or adopted-report
 * case the phase-attribution guard exists for, defeated one layer above it. The
 * validation is repeated rather than trusted from the caller: this is the
 * function whose output moves a task forward, and it is cheap.
 *
 * EVERY DECLARED OUTCOME IS MAPPED, and the map is a table so that can be
 * ASSERTED rather than hoped for. Written as two `if`s and a trailing `return`,
 * anything not `infeasible` or `blocked` became a `phase.succeeded` -- so an
 * outcome added to the schema later, `cancelled` or `partial`, would ADVANCE the
 * task the day it was declared, and the freeze would not notice because it
 * exercises the outcomes that exist. The completeness check lives in the test,
 * where it fails at the moment the enum grows; the throw below is the backstop
 * for a caller that reaches here anyway.
 */
const EVIDENCE = {
  infeasible: ({ report }) => ({ kind: "founder.infeasible", reason: report.reason }),
  blocked: ({ report }) => ({ kind: "hold", reason: "blocked_other",
                              detail: report.reason, escalation: report.escalation }),
  // The depth is SIZING's alone: `nextPhase` requires it there and nowhere else.
  ok: ({ action, phase, report }) => action === "BUILD_SIZE"
    ? { kind: "phase.succeeded", phase, depth: report.depth }
    : { kind: "phase.succeeded", phase },
};

/** The outcomes this map can turn into evidence. The test asserts it covers the schemas. */
export const MAPPED_OUTCOMES = Object.freeze(Object.keys(EVIDENCE));

export function evidenceFor({ action, report }) {
  const phase = PHASE_FOR_ACTION[action];
  if (!phase) throw new Error(`no phase for ${JSON.stringify(action)}`);
  const v = validateReport(action, report);
  if (!v.ok)
    throw new Error(`this is not a valid ${action} report, so it cannot become ${action} evidence: ` +
                    v.errors.join("; "));
  const make = EVIDENCE[report.outcome];
  if (!make)
    throw new Error(`${action} declares the outcome ${JSON.stringify(report.outcome)} and this map has no ` +
                    `evidence for it; every declared outcome needs one, because the alternative is advancing ` +
                    `a task on a word nobody mapped`);
  return make({ action, phase, report });
}

/**
 * Malformed or missing structured output. ONE `--resume` retry with the schema
 * and the parse error quoted, then the attempt budget is exhausted.
 *
 * `resumedAlready` is required rather than a counter, because a counter is what
 * lets "one retry" become "one retry per attempt".
 */
export function badReportPlan({ resumedAlready }) {
  if (typeof resumedAlready !== "boolean")
    throw new Error("badReportPlan needs to be told whether this attempt has already been resumed");
  return resumedAlready
    ? { resume: false, evidence: { kind: "phase.failed", retriesExhausted: true } }
    : { resume: true };
}
