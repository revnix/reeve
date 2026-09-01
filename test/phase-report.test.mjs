// The report contract: three schemas, and what an outcome becomes.
//
// A SCHEMA THAT VALIDATES {} IS A SCHEMA THAT PROVES NOTHING, so the rejecting
// half and the accepting half are asserted together throughout. Rejecting the
// empty object is the cheapest possible assertion and it passes against a schema
// that is almost entirely absent -- the accepting half is what stops this file
// being green against a validator that refuses everything.
import { PHASES, BUILD_ACTION_FOR, BUILD_ACTIONS } from "../src/build/phases.mjs";
import { ACTIONS, PHASE_FOR_ACTION, schemaFor, validateReport, evidenceFor, badReportPlan }
  from "../src/build/report.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// ── The three schemas ───────────────────────────────────────────────────────
{
  check(ACTIONS.length === 3, "there are three report actions", ACTIONS.join(","));
  for (const action of ACTIONS) {
    const empty = validateReport(action, {});
    check(empty.ok === false, `${action}'s schema rejects the empty object`, JSON.stringify(empty));
    check(empty.errors.some(e => /outcome/.test(e)) && empty.errors.some(e => /reason/.test(e)),
      `${action} says which required properties were missing`, JSON.stringify(empty.errors));
    const s = schemaFor(action);
    check(s.additionalProperties === false,
      `${action}'s schema refuses properties it does not declare`, JSON.stringify(s.additionalProperties));
    check(PHASES.includes(PHASE_FOR_ACTION[action]),
      `${action} maps to a phase the machine knows`, PHASE_FOR_ACTION[action]);
  }
  let unknown = null;
  try { schemaFor("BUILD_NOPE"); } catch (e) { unknown = String(e.message); }
  check(unknown !== null, "control: an unknown action has no schema and throws", String(unknown));
}

// ── The maps are the machine's, not a second copy of them ───────────────────
//
// `BUILD_ACTION_FOR` is exported by phases.mjs under a comment saying a second
// inventory of these three names is the defect this codebase keeps finding. The
// plan specified writing the literal out again here. These assertions are what
// makes the derivation load-bearing rather than incidental: a hand-typed copy
// passes every assertion above and fails these the day either side changes.
{
  check(ACTIONS === BUILD_ACTIONS,
    "ACTIONS is the machine's own action list, not a copy of it", JSON.stringify(ACTIONS));
  const roundTrip = Object.entries(BUILD_ACTION_FOR)
    .every(([phase, action]) => PHASE_FOR_ACTION[action] === phase);
  check(roundTrip, "and PHASE_FOR_ACTION inverts it exactly", JSON.stringify(PHASE_FOR_ACTION));
  check(Object.keys(PHASE_FOR_ACTION).length === Object.keys(BUILD_ACTION_FOR).length,
    "with no entry the machine does not have", JSON.stringify(Object.keys(PHASE_FOR_ACTION)));
  // THE NEAR-MISS THE COMMENT WARNS ABOUT, asserted rather than trusted: a
  // `BUILD_${phase}` derivation is right for two of the three and wrong for
  // SIZING, which is the shape that makes a derived list quietly incorrect for
  // exactly one entry.
  check(PHASE_FOR_ACTION.BUILD_SIZE === "SIZING",
    "control: and BUILD_SIZE maps to SIZING, the one pair a naming rule would get wrong",
    PHASE_FOR_ACTION.BUILD_SIZE);
}

// ── The accepting half ──────────────────────────────────────────────────────
const SIZE_OK = { outcome: "ok", reason: "sized", depth: "standard", est_files: 4,
  est_weighted_files: 6, est_packages: 1, est_slices: 2, risk_paths_touched: [],
  rationale: "two packages, one of them a test tree" };
const RESEARCH_OK = { outcome: "ok", reason: "researched", artifact: "research.md" };
const DESIGN_OK = { outcome: "ok", reason: "designed", artifact: "design.md",
  slices: [{ title: "the store", files: ["src/build/hubdb.mjs"], weighted_files: 1,
             packages: ["src"], tests: "test/hub-schema.test.mjs", done_when: "the suite is green" }] };
{
  for (const [action, doc] of [["BUILD_SIZE", SIZE_OK], ["BUILD_RESEARCH", RESEARCH_OK],
                               ["BUILD_DESIGN", DESIGN_OK]]) {
    const r = validateReport(action, doc);
    check(r.ok === true, `control: ${action} accepts its own minimal valid report`, JSON.stringify(r.errors));
  }
  const extra = validateReport("BUILD_SIZE", { ...SIZE_OK, confidence: 0.9 });
  check(extra.ok === false, "and refuses a property the schema does not declare", JSON.stringify(extra.errors));
  const wrong = validateReport("BUILD_SIZE", { ...SIZE_OK, est_files: "four" });
  check(wrong.ok === false, "and refuses a declared property of the wrong type", JSON.stringify(wrong.errors));
  const noSlices = validateReport("BUILD_DESIGN", { ...DESIGN_OK, slices: [] });
  check(noSlices.ok === false, "and a design with an empty slice list is not a design", JSON.stringify(noSlices.errors));
}

// ── A report that is not an object at all ───────────────────────────────────
//
// The one case that takes an early return at the ROOT of the walk. Written as
// `const errors = walk(...)`, that branch returned `errors.push(...)` -- a
// NUMBER -- so `errors.length` was `undefined`, which is falsy, and every one of
// these validated as OK. It is not an exotic input: it is what a worker that
// answers in prose instead of JSON produces.
{
  for (const [label, value] of [["a string", "not an object"], ["null", null],
                                ["a number", 7], ["an array", []]]) {
    const r = validateReport("BUILD_SIZE", value);
    check(r.ok === false, `a report that is ${label} is refused`, JSON.stringify(r));
    check(Array.isArray(r.errors) && r.errors.length > 0,
      `and ${label} produces a reportable error rather than an empty refusal`, JSON.stringify(r.errors));
  }
}

// ── The refusal carries the kind its consumer dispatches on ─────────────────
//
// S3-D's consumed table names `{ok:false, kind:"BAD_REPORT", errors}` and
// branches on `kind`; S3-B's produces clause omitted it. Two plans disagreeing
// about one interface, and the consumer's is the shape that has to hold.
{
  const bad = validateReport("BUILD_SIZE", {});
  check(bad.kind === "BAD_REPORT", "a refusal is labelled BAD_REPORT for its consumer", JSON.stringify(bad));
  const good = validateReport("BUILD_SIZE", SIZE_OK);
  check(!("kind" in good), "control: and an acceptance carries no kind to branch on", JSON.stringify(good));
}

// ── The mapping ─────────────────────────────────────────────────────────────
//
// An outcome becomes evidence the machine already accepts, and nothing here
// invents a field the machine would refuse.
{
  const size = evidenceFor({ action: "BUILD_SIZE", report: SIZE_OK });
  check(size.kind === "phase.succeeded" && size.phase === "SIZING" && size.depth === "standard",
    "an ok SIZING report becomes a phase.succeeded naming its phase and depth", JSON.stringify(size));
  const res = evidenceFor({ action: "BUILD_RESEARCH", report: RESEARCH_OK });
  check(res.kind === "phase.succeeded" && res.phase === "RESEARCH" && !("depth" in res),
    "an ok RESEARCH report names its phase and no depth", JSON.stringify(res));

  const blocked = evidenceFor({ action: "BUILD_DESIGN",
    report: { outcome: "blocked", reason: "the lockfile needs a change I cannot make",
              escalation: "bt:x:phase:blocked:DESIGN" } });
  check(blocked.kind === "hold" && blocked.reason === "blocked_other",
    "a blocked outcome becomes a hold", JSON.stringify(blocked));
  check(blocked.escalation === "bt:x:phase:blocked:DESIGN",
    "carrying the escalation identity the report supplied", JSON.stringify(blocked));

  // AND NEVER MANUFACTURES ONE. `holdReasonRefusal` refuses a blocked_other with
  // an empty escalation, and that rule has exactly one home. A default here
  // would be a second copy of it, and the copy that wins is the one that runs.
  const noId = evidenceFor({ action: "BUILD_DESIGN", report: { outcome: "blocked", reason: "stuck" } });
  check(noId.escalation === undefined || String(noId.escalation).trim() === "",
    "and an absent escalation identity stays absent", JSON.stringify(noId));

  const inf = evidenceFor({ action: "BUILD_DESIGN",
    report: { outcome: "infeasible", reason: "the API this needs was removed upstream" } });
  check(inf.kind === "founder.infeasible" && /removed upstream/.test(inf.reason),
    "an infeasible outcome carries its reason, which is required", JSON.stringify(inf));
}

// ── An outcome the schema does not declare does not advance anything ────────
//
// Two `if`s and a trailing `return` made everything that was not `infeasible` or
// `blocked` a `phase.succeeded`. That is failing OPEN in the one function whose
// output moves a task forward: a report that skipped validation, or one
// validated against a different action, advances the task on a word nobody
// declared. The declared list is read from the schema, so this cannot disagree
// with what validation admits.
{
  for (const outcome of ["nonsense", "OK", "", undefined, null]) {
    let threw = null;
    try { evidenceFor({ action: "BUILD_SIZE", report: { outcome, reason: "x", depth: "standard" } }); }
    catch (e) { threw = String(e.message); }
    check(threw !== null, `an outcome of ${JSON.stringify(outcome)} is refused rather than advanced`, String(threw));
  }
  // CONTROL: all three declared outcomes still map, so the refusal above is not
  // a function that throws on everything.
  const mapped = ["ok", "blocked", "infeasible"].map(outcome =>
    evidenceFor({ action: "BUILD_SIZE", report: { outcome, reason: "x", depth: "standard",
                                                  escalation: "bt:x:e" } }).kind);
  check(mapped.length === 3 && new Set(mapped).size === 3,
    "control: and each declared outcome still maps to its own evidence kind", mapped.join(","));
}

// ── ONE resumed retry, then the attempt budget is exhausted ─────────────────
{
  const first = badReportPlan({ resumedAlready: false });
  check(first.resume === true, "a malformed report gets one --resume retry", JSON.stringify(first));
  const second = badReportPlan({ resumedAlready: true });
  check(second.resume === false, "and exactly one", JSON.stringify(second));
  check(second.evidence.kind === "phase.failed" && second.evidence.retriesExhausted === true,
    "after which the evidence is a phase.failed with retries exhausted", JSON.stringify(second.evidence));
  // A COUNTER IS WHAT LETS "ONE RETRY" BECOME "ONE RETRY PER ATTEMPT", so the
  // flag is required rather than defaulted: an omitted argument must not read as
  // "not yet resumed".
  let missing = null;
  try { badReportPlan({}); } catch (e) { missing = String(e.message); }
  check(missing !== null, "control: and being told nothing is refused rather than assumed", String(missing));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
