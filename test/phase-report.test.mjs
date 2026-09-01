// The report contract: three schemas, and what an outcome becomes.
//
// A SCHEMA THAT VALIDATES {} IS A SCHEMA THAT PROVES NOTHING, so the rejecting
// half and the accepting half are asserted together throughout. Rejecting the
// empty object is the cheapest possible assertion and it passes against a schema
// that is almost entirely absent -- the accepting half is what stops this file
// being green against a validator that refuses everything.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PHASES, BUILD_ACTION_FOR, BUILD_ACTIONS } from "../src/build/phases.mjs";
import { ACTIONS, PHASE_FOR_ACTION, schemaFor, schemaTextFor, validateReport, evidenceFor,
         badReportPlan, MAPPED_OUTCOMES, assertKnownKeywords } from "../src/build/report.mjs";
import { workerArgs } from "../src/supervisor.mjs";
// THROUGH `applyTransition`, not `nextPhase` alone. A pure-function assertion
// cannot see whether a refusal reached the database, and the database is what
// `task why` renders -- so a refusal that is decided and not recorded is
// indistinguishable, months later, from a report that was never sent.
import { openHub } from "../src/build/hubdb.mjs";
import { applyTransition } from "../src/build/transition.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { fileTask } from "../src/build/taskfile.mjs";
import { writeArtifact } from "../src/build/artifact.mjs";

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
    report: { outcome: "blocked", reason: "the lockfile needs a change I cannot make" } });
  check(blocked.kind === "hold" && blocked.reason === "blocked_other",
    "a blocked outcome becomes a hold", JSON.stringify(blocked));
  // THE IDENTITY IS MINTED, not taken from the report. It is the key notification
  // and retirement are routed by, so a report that could name it could file its
  // hold under another task's cause.
  check(blocked.escalation === "bt:<id>:phase:blocked:DESIGN",
    "under an identity minted from the phase, with the id left for applyTransition",
    JSON.stringify(blocked));
  check(blocked.detail === "the lockfile needs a change I cannot make",
    "and the worker's explanation still travels, as detail", JSON.stringify(blocked));
  // AND THE REPORT CANNOT NAME IT AT ALL. The field is gone from the schemas, so
  // a worker that tries is refused rather than ignored -- a declared field that
  // is silently dropped is a trap for whoever reads the contract next.
  let named = null;
  try {
    evidenceFor({ action: "BUILD_DESIGN",
      report: { outcome: "blocked", reason: "stuck", escalation: "bt:someone-else:cause" } });
  } catch (e) { named = String(e.message); }
  check(named !== null && /escalation/.test(named),
    "a report that supplies its own escalation identity is refused", String(named));

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
                                                  rationale: "r", est_files: 1, est_weighted_files: 1,
                                                  est_packages: 1, est_slices: 1,
                                                  risk_paths_touched: [] } }).kind);
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

// ── And through the machine, not only through the map ───────────────────────
//
// Everything above is a pure function answering about another pure function.
// This is a real task, in a real phase, with every refusal asserted where it is
// RECORDED rather than where it is decided.
const dir = mkdtempSync(join(tmpdir(), "reeve-report-"));
const repo = join(dir, "repo");
mkdirSync(join(repo, "packages", "x"), { recursive: true });
writeFileSync(join(repo, "p.json"), "{}\n");
const registry = { version: 1, projects: {
  nextly: { nwo: "nextlyhq/nextly", repoPath: repo, profilePath: join(repo, "p.json") } } };
const io = { lstat: (p) => lstatSync(p), lsTree: () => null,
  repoId: async () => 42, profileHash: async () => "ph-1", defaultBranch: async () => "main",
  visibility: async () => "private", specRepoId: async () => 77,
  gateDefinitionHash: async () => "gd-1", founderUserId: async () => 9 };

let dbn = 0;
const inSizing = async (title) => {
  const db = openHub(join(dir, `h${++dbn}.db`));
  const f = await fileTask({ db, registry, project: "nextly", title,
    territory: ["packages/x"], io, isAlive: isSameProcess,
    pid: process.pid, lstart: readStart(process.pid) });
  const t = applyTransition(db, { taskId: f.task, expectedPhase: "FILED", expectedGeneration: 1,
    evidence: { kind: "phase.succeeded", phase: "FILED" }, op: "phase.advanced", isAlive: isSameProcess });
  check(f.ok === true && t.applied === true, `fixture: ${title} is in SIZING`,
    JSON.stringify({ filed: f.ok, why: f.why, advanced: t }));
  return { db, id: f.task };
};
const phaseOf = (db, id) => db.prepare("SELECT phase FROM task WHERE id=?").get(id).phase;
const lastRefusal = (db, id) => db.prepare(
  "SELECT payload FROM hub_event WHERE task=? AND kind='transition.refused' ORDER BY seq DESC LIMIT 1")
  .get(id)?.payload ?? "";

// A report that names the wrong phase advances nothing, and the refusal says so.
{
  const { db, id } = await inSizing("mis-attributed");
  const ev = evidenceFor({ action: "BUILD_RESEARCH", report: RESEARCH_OK });
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: ev, artifactSha: "a".repeat(64), op: "phase.advanced", isAlive: isSameProcess });
  check(r.applied === false && r.reason === "refused",
    "a RESEARCH report against a task in SIZING is refused", JSON.stringify(r));
  check(/RESEARCH report cannot advance a task in SIZING/.test(String(r.refusal)),
    "with the machine's own message", String(r.refusal));
  check(lastRefusal(db, id).includes("cannot advance"),
    "and the refusal is the reason RECORDED, not merely returned", lastRefusal(db, id));
  check(phaseOf(db, id) === "SIZING", "and the task did not move", phaseOf(db, id));
  db.close();
}

// A SIZING success with no depth is refused TWICE, by two rules that belong to
// different layers, and both are asserted.
//
// The schema refuses it first now: an `ok` report must carry what its phase
// produces, which for SIZING includes the depth. That is new -- it used to be
// accepted here and refused only at the transition, and the estimates were not
// required at all, so a success carrying just a depth advanced the task while
// the floors compared against nothing.
//
// The machine's rule is unchanged and is still the machine's, so it is exercised
// directly rather than through a report that can no longer express the case.
{
  const { db, id } = await inSizing("no depth");
  const { depth, ...noDepth } = SIZE_OK;
  const bySchema = validateReport("BUILD_SIZE", noDepth);
  check(bySchema.ok === false && bySchema.errors.some(e => /depth/.test(e)),
    "an ok SIZING report that names no depth is refused by its own schema",
    JSON.stringify(bySchema.errors));
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: { kind: "phase.succeeded", phase: "SIZING" },
    artifactSha: "b".repeat(64), op: "phase.advanced", isAlive: isSameProcess });
  check(r.applied === false, "and evidence that names no depth is refused by the machine", JSON.stringify(r));
  check(/must name the depth it selected/.test(String(r.refusal)),
    "with the message that says why the depth is load-bearing", String(r.refusal));
  check(phaseOf(db, id) === "SIZING", "and the task did not move", phaseOf(db, id));
  // AND A STOP STILL NEEDS NO DEPTH, which is why the schema's requirement is
  // conditional: a blocked sizing worker has none to give, and demanding one is
  // how a stop becomes a fabricated success.
  check(validateReport("BUILD_SIZE", { outcome: "blocked", reason: "cannot size it" }).ok === true,
    "control: and a blocked SIZING report needs no depth at all");
  db.close();
}

// A hold with no escalation identity reaches no founder, so it is refused
// rather than held silently.
//
// THE EVIDENCE IS BLANKED BY HAND, because a report can no longer carry one. The
// identity is minted from the phase, so this path cannot produce a blank -- and
// the machine's rule is still the machine's, so it is exercised directly rather
// than deleted along with the way it used to be reachable.
{
  const { db, id } = await inSizing("blocked with no identity");
  const minted = evidenceFor({ action: "BUILD_SIZE", report: { outcome: "blocked", reason: "stuck" } });
  const blank = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: { ...minted, escalation: "  " }, op: "hold", isAlive: isSameProcess });
  check(blank.applied === false,
    "a blocked_other hold with an empty escalation is refused", JSON.stringify(blank));
  check(/no identity reaches no founder/.test(String(blank.refusal)),
    "and says that a hold nobody is told about is not a hold", String(blank.refusal));
  check(phaseOf(db, id) === "SIZING", "and the task did not enter BLOCKED", phaseOf(db, id));

  // THE CONTROL IS THE MINTED ONE, unedited: the same hold, from the same report,
  // is accepted. Without it the assertions above are satisfied by a machine that
  // refuses every hold.
  const ok = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: minted, op: "hold", isAlive: isSameProcess });
  check(ok.applied === true && phaseOf(db, id) === "BLOCKED",
    "control: the same hold with the identity reeve minted is accepted", JSON.stringify(ok));
  const why = db.prepare("SELECT why FROM escalation").all().map(e => e.why);
  check(why.includes(`${id}:phase:blocked:SIZING`),
    "and it is filed under the task's OWN id, which no report could have named", why.join(","));
  db.close();
}

// Malformed structured output: one resumed retry, then ESCALATED, with the
// identity the machine mints from the phase.
{
  const { db, id } = await inSizing("bad report");
  check(badReportPlan({ resumedAlready: false }).resume === true,
    "control: the first malformed report is retried, not escalated");
  const plan = badReportPlan({ resumedAlready: true });
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: plan.evidence, op: "phase.failed", isAlive: isSameProcess });
  check(r.applied === true && phaseOf(db, id) === "ESCALATED",
    "a second malformed report exhausts the budget and escalates", JSON.stringify(r));
  const why = db.prepare("SELECT why FROM escalation").all().map(e => e.why);
  check(why.includes(`${id}:phase:failed:SIZING`),
    "raising bt:<id>:phase:failed:<phase>, with the id substituted once", why.join(","));
  db.close();
}

// THE ADVANCING CONTROL. Without it every assertion above is satisfied by a
// machine that refuses everything.
{
  const { db, id } = await inSizing("a good report");
  const w = writeArtifact({ dir: join(dir, "art", id), phase: "SIZING",
    bytes: Buffer.from(JSON.stringify(SIZE_OK)) });
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: evidenceFor({ action: "BUILD_SIZE", report: SIZE_OK }),
    artifactSha: w.sha256, op: "phase.advanced", isAlive: isSameProcess });
  check(r.applied === true && phaseOf(db, id) === "RESEARCH",
    "a well-formed report advances the task", JSON.stringify(r));
  const pe = db.prepare(
    "SELECT artifact_sha FROM phase_event WHERE task=? ORDER BY seq DESC LIMIT 1").get(id);
  check(pe.artifact_sha === w.sha256,
    "and the sha the artifact store computed is what justified it", JSON.stringify(pe));
  check(db.prepare("SELECT depth FROM task WHERE id=?").get(id).depth === "standard",
    "and the depth the report selected is now durable on the task");
  db.close();
}

// ── The contract is frozen in BOTH of its halves ────────────────────────────
//
// A phase schema fails in two ways that are not the same failure. The schema
// FILES are what a worker is asked for, handed to the CLI as --json-schema and
// validated against locally. The outcome-to-evidence MAP is what turns a valid
// report into something the machine accepts. A freeze over the JSON alone stays
// green while `evidenceFor` starts emitting a phase `nextPhase` refuses -- and
// then every worker's perfectly good report fails at the transition with a
// message about attribution, which names neither half.
// The reports the freeze drives, one per action per declared outcome. Each is
// VALID for its own action, because `evidenceFor` now validates before mapping.
const OK_FOR = { BUILD_SIZE: SIZE_OK, BUILD_RESEARCH: RESEARCH_OK, BUILD_DESIGN: DESIGN_OK };
const FREEZE_CASES = ACTIONS.flatMap(a => [
  [a, "ok", OK_FOR[a]],
  [a, "blocked", { outcome: "blocked", reason: "r" }],
  [a, "infeasible", { outcome: "infeasible", reason: "r" }],
]);
{
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/report-schemas-v1.json", import.meta.url), "utf8"));
  const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  for (const action of ACTIONS) {
    const now = sha(schemaFor(action));
    check(now === frozen.schemas[action], `${action}'s schema is frozen`,
      `${now} vs ${frozen.schemas[action]}\n        ` +
      "A change here changes what every dispatched worker is asked for.");
  }
  // EVERY ACTION AND EVERY DECLARED OUTCOME, not just `ok`. A freeze over the
  // success path alone reports the map intact while a hold stops carrying its
  // escalation identity or an infeasible stops carrying its reason -- and those
  // are the two the machine refuses, so the failure would arrive as a refusal
  // nobody could trace back to this file.
  const map = sha(FREEZE_CASES.map(([a, , report]) => [a, evidenceFor({ action: a, report })]));
  check(map === frozen.evidence_map,
    "and so is the outcome-to-evidence map, which the JSON freeze cannot see",
    `${map} vs ${frozen.evidence_map}`);
  check(frozen.version === 1, "and the fixture records which contract it froze", String(frozen.version));
}

rmSync(dir, { recursive: true, force: true });
// ── The schema reaches the worker as TEXT ───────────────────────────────────
//
// `workerArgs` pushes its `jsonSchema` straight into the argv array and its
// tested contract is serialized JSON. The documented handoff passes
// `schemaFor(action)` -- a parsed object -- so every phase dispatch following it
// would spawn a worker whose structured-output contract is the literal string
// `[object Object]`. Not a validation failure: an argument that is syntactically
// fine and semantically nothing, on all three phases at once.
{
  for (const action of ACTIONS) {
    const text = schemaTextFor(action);
    check(typeof text === "string", `${action}'s schema is available as text`, typeof text);
    // THE PARSE IS GUARDED, because this file is measured under a stub that makes
    // `schemaTextFor` hand back the parsed object. `JSON.parse` then coerces it
    // to "[object Object]" and THROWS, killing the run 26 assertions early -- and
    // the assertions that never ran are indistinguishable in the log from
    // assertions that passed. The sweep reported CAUGHT for it, because the named
    // assertion did go red; only comparing the assertion COUNT against the
    // control found it. A test that dies under its own stub measures a prefix of
    // itself.
    let parsed = null, why = null;
    try { parsed = JSON.parse(text); } catch (e) { why = String(e.message); }
    check(parsed !== null && JSON.stringify(parsed) === JSON.stringify(schemaFor(action)),
      `and the text parses to the same schema the validator uses`, why ?? action);
    // THROUGH THE REAL ARGV BUILDER, not a claim about it. Passing the object is
    // what produced `[object Object]`, and only the builder can show that.
    const argv = workerArgs({ prompt: "p", settings: "/tmp/s.json", jsonSchema: text });
    const at = argv.indexOf("--json-schema");
    check(at !== -1 && argv[at + 1] === text,
      `and workerArgs carries it verbatim`, String(argv[at + 1]).slice(0, 40));
    const bad = workerArgs({ prompt: "p", settings: "/tmp/s.json", jsonSchema: schemaFor(action) });
    const badAt = bad.indexOf("--json-schema");
    check(String(bad[badAt + 1]) === "[object Object]",
      `control: passing the parsed object instead spawns with "[object Object]"`, String(bad[badAt + 1]));
  }
}

// ── Every declared outcome has evidence, asserted rather than hoped for ─────
//
// The map used to be two `if`s and a trailing `return`, so anything that was not
// `infeasible` or `blocked` became a `phase.succeeded`. An outcome added to the
// schema later -- `cancelled`, `partial` -- would have ADVANCED the task the day
// it was declared, and no freeze would notice, because a freeze exercises the
// outcomes that exist. This fails the moment the enum grows past the map.
{
  for (const action of ACTIONS) {
    for (const outcome of schemaFor(action).properties.outcome.enum) {
      check(MAPPED_OUTCOMES.includes(outcome),
        `${action}'s declared outcome ${outcome} has evidence to become`, MAPPED_OUTCOMES.join(","));
    }
  }
  check(MAPPED_OUTCOMES.length === 3, "control: and the map has exactly the three that exist today",
    MAPPED_OUTCOMES.join(","));
}

// ── A report valid for ANOTHER action does not become this action's evidence ─
//
// Checking only that the outcome word is declared, a valid RESEARCH report
// handed in as BUILD_DESIGN produced a successful DESIGN evidence -- which
// `nextPhase` accepts while the task is in DESIGN. That is exactly the miswired
// or adopted-report case the phase-attribution guard exists for, defeated one
// layer above it.
{
  let threw = null;
  try { evidenceFor({ action: "BUILD_DESIGN", report: RESEARCH_OK }); } catch (e) { threw = String(e.message); }
  check(threw !== null && /not a valid BUILD_DESIGN report/.test(threw),
    "a valid RESEARCH report is refused as DESIGN evidence", String(threw));
  check(validateReport("BUILD_RESEARCH", RESEARCH_OK).ok === true,
    "control: and that same report is perfectly valid for the action it belongs to");
  check(evidenceFor({ action: "BUILD_RESEARCH", report: RESEARCH_OK }).phase === "RESEARCH",
    "control: and becomes RESEARCH evidence there");
}

// ── The cached schema cannot be mutated by a caller ─────────────────────────
//
// One cache, handed to every consumer. A consumer mutating what it was given
// would change what every later validation enforces, and the freeze would go on
// reporting the contract intact because it hashes the same mutated object.
{
  const s = schemaFor("BUILD_SIZE");
  let threw = null;
  try { "use strict"; s.properties.confidence = { type: "integer" }; } catch (e) { threw = String(e.message); }
  check(!("confidence" in s.properties),
    "a caller cannot add a property to the shared schema", threw ?? "(silently ignored)");
  check(validateReport("BUILD_SIZE", { ...SIZE_OK, confidence: 1 }).ok === false,
    "control: and validation still refuses the property that mutation tried to declare");
}

// ── An `ok` report carries what its phase produces ──────────────────────────
//
// `required` listed only outcome and reason, so a SIZING success carrying just a
// depth advanced the task -- and the deterministic floors read est_packages and
// est_weighted_files as absent, comparing against nothing and preserving a depth
// the estimates never supported. Requiring them unconditionally is the other
// error: a blocked worker would have to invent them, which is how a stop becomes
// a fabricated success. The requirement is conditional on the outcome.
{
  const bare = validateReport("BUILD_SIZE", { outcome: "ok", reason: "sized", depth: "trivial" });
  check(bare.ok === false, "an ok SIZING report with no estimates is refused", JSON.stringify(bare.errors));
  for (const field of ["est_files", "est_weighted_files", "est_packages", "est_slices",
                       "risk_paths_touched", "rationale"]) {
    const missing = { ...SIZE_OK }; delete missing[field];
    check(validateReport("BUILD_SIZE", missing).ok === false,
      `an ok SIZING report omitting ${field} is refused`, JSON.stringify(validateReport("BUILD_SIZE", missing).errors));
  }
  check(validateReport("BUILD_DESIGN", { outcome: "ok", reason: "designed", artifact: "design.md" }).ok === false,
    "an ok DESIGN report with no slices is refused");
  check(validateReport("BUILD_RESEARCH", { outcome: "ok", reason: "researched" }).ok === false,
    "an ok RESEARCH report naming no artifact is refused");

  // AND A STOP STILL NEEDS NONE OF IT. This is the half that makes the
  // requirement conditional rather than absolute: a worker that cannot size the
  // task has no estimates to give, and demanding them is how a stop becomes a
  // fabricated success.
  for (const action of ACTIONS) {
    check(validateReport(action, { outcome: "blocked", reason: "stuck" }).ok === true,
      `control: a blocked ${action} report needs none of it`,
      JSON.stringify(validateReport(action, { outcome: "blocked", reason: "stuck" }).errors));
    check(validateReport(action, { outcome: "infeasible", reason: "gone upstream" }).ok === true,
      `control: and neither does an infeasible one`,
      JSON.stringify(validateReport(action, { outcome: "infeasible", reason: "gone upstream" }).errors));
  }
}

// ── A reason with no words in it is not a reason ────────────────────────────
//
// `minLength` counts CHARACTERS, so " " satisfied it. `nextPhase` then refuses
// an infeasible on exactly that ground -- so validation passed, the transition
// refused, and the BAD_REPORT retry path that exists for a malformed report was
// never reached. The two now agree.
{
  for (const action of ACTIONS) {
    const blankReason = validateReport(action, { outcome: "blocked", reason: "   " });
    check(blankReason.ok === false, `a whitespace-only reason is refused for ${action}`,
      JSON.stringify(blankReason.errors));
  }
  check(validateReport("BUILD_SIZE", { ...SIZE_OK, rationale: "\t " }).ok === false,
    "and so is a whitespace-only rationale");
  check(validateReport("BUILD_SIZE", { ...SIZE_OK, risk_paths_touched: ["  "] }).ok === false,
    "and a whitespace-only risk path");
  check(validateReport("BUILD_SIZE", { ...SIZE_OK, rationale: " x " }).ok === true,
    "control: and a reason with a word in it, however padded, is accepted");
}

// ── The keyword scan visits branches no report reaches ──────────────────────
//
// Checked during validation, the recursion follows only the properties a REPORT
// carries -- so an unimplemented keyword added beneath an OPTIONAL property was
// never visited by a report that omitted it, and the schema silently enforced
// less than it declares. The scan runs over the whole tree when the schema is
// loaded.
{
  const hidden = { type: "object", properties: { optional: { type: "string", format: "email" } } };
  let threw = null;
  try { assertKnownKeywords(hidden, ""); } catch (e) { threw = String(e.message); }
  check(threw !== null && /format/.test(threw),
    "an unimplemented keyword under an optional property is refused when the schema loads", String(threw));
  // AND IT IS NOT REACHED BY VALIDATING. The report that omits the property is
  // exactly the one the old check could not see.
  check(validateReport("BUILD_SIZE", { outcome: "blocked", reason: "stuck" }).ok === true,
    "control: and a report omitting an optional property validates normally");
  let clean = null;
  try { assertKnownKeywords({ type: "object", properties: { a: { type: "string", minLength: 1 } } }, ""); }
  catch (e) { clean = String(e.message); }
  check(clean === null, "control: and a schema using only implemented keywords passes", String(clean));
  // THE SHIPPED SCHEMAS PASS IT, which is what makes the throw above a guard
  // rather than a thing that refuses everything.
  for (const action of ACTIONS) {
    let why = null;
    try { assertKnownKeywords(schemaFor(action), ""); } catch (e) { why = String(e.message); }
    check(why === null, `control: ${action}'s shipped schema uses only implemented keywords`, String(why));
  }
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
