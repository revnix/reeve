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
import { ACTIONS, PHASE_FOR_ACTION, schemaFor, validateReport, evidenceFor, badReportPlan }
  from "../src/build/report.mjs";
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

// A SIZING report with no depth is refused with the section 5 message.
{
  const { db, id } = await inSizing("no depth");
  const { depth, ...noDepth } = SIZE_OK;
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: evidenceFor({ action: "BUILD_SIZE", report: noDepth }),
    artifactSha: "b".repeat(64), op: "phase.advanced", isAlive: isSameProcess });
  check(r.applied === false, "a SIZING report that names no depth is refused", JSON.stringify(r));
  check(/must name the depth it selected/.test(String(r.refusal)),
    "with the message that says why the depth is load-bearing", String(r.refusal));
  // AND THE VALIDATOR IS NOT WHAT REFUSED IT. The schema deliberately does not
  // require `depth`, so a blocked sizing worker need not invent one -- which
  // means this refusal has to come from the machine, and only asserting it
  // through applyTransition can tell the two apart.
  check(validateReport("BUILD_SIZE", noDepth).ok === true,
    "control: the schema itself accepts a depth-less report",
    JSON.stringify(validateReport("BUILD_SIZE", noDepth)));
  db.close();
}

// A blocked outcome with no escalation identity reaches no founder, so it is
// refused rather than held silently.
{
  const { db, id } = await inSizing("blocked with no identity");
  const r = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: evidenceFor({ action: "BUILD_SIZE",
      report: { outcome: "blocked", reason: "stuck", escalation: "  " } }),
    op: "hold", isAlive: isSameProcess });
  check(r.applied === false, "a blocked_other hold with an empty escalation is refused", JSON.stringify(r));
  check(/no identity reaches no founder/.test(String(r.refusal)),
    "and says that a hold nobody is told about is not a hold", String(r.refusal));
  check(phaseOf(db, id) === "SIZING", "and the task did not enter BLOCKED", phaseOf(db, id));

  const ok = applyTransition(db, { taskId: id, expectedPhase: "SIZING", expectedGeneration: 1,
    evidence: evidenceFor({ action: "BUILD_SIZE",
      report: { outcome: "blocked", reason: "stuck", escalation: "bt:x:phase:blocked:SIZING" } }),
    op: "hold", isAlive: isSameProcess });
  check(ok.applied === true && phaseOf(db, id) === "BLOCKED",
    "control: the same hold WITH an identity is accepted", JSON.stringify(ok));
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
{
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/report-schemas-v1.json", import.meta.url), "utf8"));
  const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  for (const action of ACTIONS) {
    const now = sha(schemaFor(action));
    check(now === frozen.schemas[action], `${action}'s schema is frozen`,
      `${now} vs ${frozen.schemas[action]}\n        ` +
      "A change here changes what every dispatched worker is asked for.");
  }
  const map = sha(ACTIONS.map(a => [a, evidenceFor({ action: a,
    report: { outcome: "ok", reason: "r", depth: "standard" } })]));
  check(map === frozen.evidence_map,
    "and so is the outcome-to-evidence map, which the JSON freeze cannot see",
    `${map} vs ${frozen.evidence_map}`);
  check(frozen.version === 1, "and the fixture records which contract it froze", String(frozen.version));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
