// A recorded, reproducible signature for the guardian's tick.
//
// WHY THIS EXISTS. Issue #50 moves the provider and hub mechanics out of a
// 2,282-line `tick()` into a session that owns the rules. The move is worth
// doing because the findings it is meant to prevent are all one shape -- a rule
// that must hold at N call sites, applied at N-1 -- but a move of that size is
// exactly where behaviour changes by accident and nobody notices, because the
// suite asserts PROPERTIES and a reordering can preserve every property while
// changing what the tick actually did.
//
// So the tick's observable behaviour is recorded here, byte-for-byte, BEFORE
// anything moves. The artifacts are the review: a step that changes one is
// either wrong or is declaring a deliberate change.
//
// WHAT IS RECORDED, and the order is deliberate:
//
//   1 SEAM LOG    every scheduler seam call, in order, with its arguments.
//                 The ORDER is the signal -- a reordering that preserves every
//                 property still shows here.
//   2 ESCALATIONS the keys, sorted. Keys not counts: a count changes when a
//                 loop runs twice, which is noise, and the KEY is the contract.
//   3 LOG FILE    the tick's own log, normalised. Line order is the signal.
//   4 RESULT      halted / unreadable / the decision actions.
//   5 CARRIED     the retry obligations left in ctx for the NEXT tick. A move
//                 that drops one is invisible in every other field.
//
// REDACTION IS REQUIRED, AND IT IS ALSO THE MOST DANGEROUS PART OF THIS FILE.
// Every value it normalises is a value the signature can no longer see, so a
// pattern that is wider than its reason blinds the comparison to real
// behaviour. Each one is therefore justified by a measurement, and the controls
// below re-run that measurement on every suite run.
//
// TO APPROVE A CHANGE:  REEVE_APPROVE=1 node test/characterise-tick.test.mjs
// Approving is a deliberate act and the diff is the thing a reviewer reads.

import { run, CLAIM_TOKEN } from "./fixtures/tick-harness.mjs";
// DERIVED, not restated. A scenario that hard-coded "rate_limited" would keep
// naming an outcome the supervisor had since renamed, and the branch it is meant
// to reach would simply stop being taken.
import { OUTCOMES } from "../src/supervisor.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPROVED = join(HERE, "fixtures", "tick-approved");
const APPROVE = process.env.REEVE_APPROVE === "1";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// THE INTERPRETER PATH IS PART OF THE HOST, not of the behaviour. `spawnWorker`
// records an allow-rule naming the running node binary, so an artifact captured
// on one machine cannot match on another -- MEASURED: six scenarios failed in CI
// against artifacts approved locally, with no change to the tick at all.
const NODE_PATH_RE = /(?:\/[^\s"',)\]]*)?\bnode\/?[^\s"',)\]]*\/bin\/node\b|\/[^\s"',)\]]*\/bin\/node\b/g;

/**
 * Redaction, by MEASURED provenance rather than by name.
 *
 * Each pattern declares WHY it exists, and there are exactly two admissible
 * reasons:
 *
 *   "varies"      the value differs between two runs of one scenario in this
 *                 process. Proved by the control below: remove the pattern and
 *                 the two runs must stop matching.
 *   "provenance"  a same-process pair CANNOT show it varying -- the process id
 *                 is fixed for the life of the process, the interpreter path for
 *                 the life of the machine, and a whole-second clock reading for
 *                 the whole second, so two runs a few hundred milliseconds apart
 *                 record the same one. Differencing them is a control that
 *                 passes or fails on timing, which is no control at all. Each of
 *                 these instead asserts where the removed value CAME FROM, which
 *                 is the actual reason for removing it, and that claim is
 *                 deterministic.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERS. The previous list redacted by NAME:
 * every `"id"`, every `"token"`, `runRef`, `lstart`, every `*_at`, every 40-hex
 * string. Measured against this fixture, not one of them varies -- the harness
 * builds a fresh database per run and the claim answers deterministically -- so
 * every one of them was BEHAVIOUR being blanked, and four of them never matched
 * anything at all. Under that redactor a refactor that released lease 2 instead
 * of the claimed lease 1, or released under a different run reference, or sent
 * the worker at a different head, produced a byte-identical artifact.
 *
 * A pattern is only ever as narrow as its reason. `"id"` is not a reason;
 * "this value came from the clock" is.
 */
const REDACTIONS = [
  { name: "iso timestamp", kind: "varies",
    apply: (s) => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>") },
  { name: "temp directory", kind: "varies",
    apply: (s) => s.replace(/\/(?:private\/)?(?:var|tmp)\/[^\s"'),\]]*/g, "<tmp>") },
  // Generated per dispatch as a base36 clock reading joined to a random suffix.
  { name: "run id", kind: "varies",
    apply: (s) => s.replace(/"runId"\s*:\s*"[^"]*"/g, '"runId":"<runId>"') },
  // The same value again, in the log's prose, where it carries no key.
  { name: "run reference in prose", kind: "varies",
    apply: (s) => s.replace(/\brun [0-9a-z]+-[0-9a-z]+/g, "run <ref>") },

  // A cooldown is stamped with the wall clock at observation. The WINDOW is
  // behaviour and stays visible as `cooldownSeconds`; the absolute epochs are
  // the clock and nothing else. Whole seconds, so two runs in one second record
  // the same number -- which is why this is proved by where the value came from
  // rather than by differencing.
  { name: "cooldown wall clock", kind: "provenance",
    apply: (s) => s.replace(/"(observedAt|expiresAt)"\s*:\s*\d+/g, '"$1":<epoch>'),
    cameFromTheHost: (t) => [...t.matchAll(/"(?:observedAt|expiresAt)"\s*:\s*(\d+)/g)]
      .some((m) => Math.abs(Number(m[1]) - Date.now() / 1000) < 3600) },

  // MEASURED: six scenarios failed in CI against artifacts approved locally,
  // with no change to the tick at all. `spawnWorker` records an allow-rule
  // naming the running node binary.
  { name: "node interpreter path", kind: "provenance",
    apply: (s) => s.replace(NODE_PATH_RE, "<node>"),
    cameFromTheHost: (t) => t.includes(process.execPath) },

  // `providerClaim` is handed `pid: process.pid`, constant within a run and
  // different in every other process that ever compares these artifacts.
  { name: "process id", kind: "provenance",
    apply: (s) => s.replace(/"pid"\s*:\s*\d+/g, '"pid":<pid>'),
    cameFromTheHost: (t) => new RegExp(`"pid"\\s*:\\s*${process.pid}\\b`).test(t) },
];

/** Apply every redaction, or every one but `skip` -- the per-pattern control. */
const redact = (s, skip = null) =>
  REDACTIONS.reduce((acc, r) => (r.name === skip ? acc : r.apply(acc)), String(s));

/** No redaction at all: the raw text the controls measure against. */
const raw = (s) => String(s);

/**
 * Seam arguments, safely.
 *
 * A seam is handed live objects -- `providerClaim(db, a)` receives the database
 * handle -- and `JSON.stringify` on a CLOSED handle throws ERR_INVALID_STATE,
 * which kills the run after every assertion has printed PASS. Anything that is
 * not plain data is recorded as its TYPE, which is what a reader needs anyway:
 * that a handle was passed, not what was in it.
 */
const argsOf = (args) => {
  const one = (v) => {
    if (v === null || v === undefined) return v ?? null;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;
    if (t === "function") return "<fn>";
    if (Array.isArray(v)) return v.map(one);
    const name = v.constructor?.name ?? "Object";
    if (name !== "Object") return `<${name}>`;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x)]));
  };
  try { return JSON.stringify(args.map(one)); }
  catch (e) { return `<unserialisable: ${e?.code ?? e?.message}>`; }
};

const serialise = ({ seams, esc, log, r, ctx }, red = redact) => [
  "== 1 SEAM LOG",
  seams.map(({ op, args }) => `${op}\t${red(argsOf(args))}`).join("\n"),
  "",
  "== 2 ESCALATIONS",
  // REDACTED TOO. An escalation KEY can carry a temp path -- the
  // checkout-tampered one names the preserved checkout -- so the key varies per
  // run. Sorting after redaction, or the order follows the unredacted text.
  red([...(r.escalations?.keys?.() ?? [])].map(red).sort().join("\n")),
  "",
  "== 3 LOG FILE",
  red(log).trimEnd(),
  "",
  "== 4 RESULT",
  red(JSON.stringify({
    halted: r.halted ?? null,
    unreadable: r.unreadable ?? null,
    // NESTED. tick() stores `{ e, decision, cause, fp, spendKey }`, so reading
    // `d.action` yields null for every entry and the field records
    // `"decisions":[null]` -- populated-looking and vacuous. The control below
    // asserts at least one scenario names a real action, so this cannot regress
    // to nulls silently.
    decisions: (r.decisions ?? []).map((d) => d?.decision?.action ?? d?.action ?? null),
  })),
  "",
  "== 5 CARRIED",
  `providerRetry: ${[...(ctx.providerRetry?.keys?.() ?? [])].sort().join(",")}`,
  `cooldownRetry: ${[...(ctx.cooldownRetry?.keys?.() ?? [])].sort().join(",")}`,
  "",
].join("\n");

// ── The scenarios ────────────────────────────────────────────────────────────
// Each is reachable through the fixture's existing seams. Scenarios 7 and 8 are
// the two EARLY EXITS and must be present: without them a move can reorder
// housekeeping past an exit and every other artifact stays green.
const SCENARIOS = [
  ["01-happy-path", {}],
  ["02-claim-at-limit", { claim: () => ({ ok: false, reason: "at-limit" }) }],
  ["03-claim-throws-fail-open", { claim: () => { throw new Error("database disk image is malformed"); } }],
  ["04-hub-unreadable-always", { hubGetter: () => ({ hub: null, why: "corrupt" }) }],
  ["05-hub-unreadable-first-read-only", { hubGetter: (() => { let n = 0; return (g) => (n++ === 0 ? { hub: null, why: "busy" } : { hub: g, why: null }); })() }],
  ["06-hub-absent", { hub: null }],
  ["09-repo-id-null-fail-closed", { repoId: null }],
  ["10-maintenance-on-release-and-cooldown", {
    // BOTH HALVES, because the name says both. A rate-limited worker is the only
    // thing that reaches the cooldown recorder at all; without it only the
    // release saw `maintenance`, the artifact contained no cooldown call, and
    // `cooldownRetry` stayed empty -- so an extraction could have dropped or
    // reordered the deferred cooldown and this scenario would still have passed
    // under a name that claimed to cover it.
    //
    // Each refusal is what makes its half DEFER to the next tick, which is the
    // behaviour worth recording: the obligation has to survive in `ctx`.
    spawnWorker: async () => ({ outcome: OUTCOMES.RATE_LIMITED,
                                why: "provider returned 429", ms: 1, cost: 0, sessionId: "s" }),
    noteRateLimit: () => ({ ok: false, reason: "maintenance" }),
    release: () => ({ ok: false, reason: "maintenance" }),
  }],
];

if (!existsSync(APPROVED)) mkdirSync(APPROVED, { recursive: true });

// THE RAW TEXT OF EVERY SCENARIO, kept as it is produced. The controls at the
// foot need text a tick actually emitted -- a redaction pattern proved against a
// hand-written sample proves only that the regex works, which was never the
// question. Costs no extra tick: the same run is serialised twice.
const rawRuns = [];

let approvedWritten = 0;
for (const [name, opts] of SCENARIOS) {
  const seams = [];
  let out;
  try {
    out = await run({ ...opts, seams });
  } catch (e) {
    check(false, `${name}: the tick ran`, String(e?.message ?? e));
    continue;
  }
  const actual = serialise({ ...out, seams });
  rawRuns.push(serialise({ ...out, seams }, raw));
  const file = join(APPROVED, `${name}.txt`);

  if (!existsSync(file) && !APPROVE) {
    // A MISSING BASELINE IS A FAILURE, not an invitation. Regenerating it would
    // let a refactor delete a baseline and have CI bless the new output as if it
    // had been approved -- the deliberate step this file exists to require,
    // skipped by deleting a file.
    check(false, `${name}: has an approved signature`,
      `${file} is missing. If this scenario is new or deliberately changed, run:\n` +
      "        REEVE_APPROVE=1 node test/characterise-tick.test.mjs");
    continue;
  }
  if (APPROVE) {
    writeFileSync(file, actual);
    approvedWritten++;
    console.log(`APPROVED  ${name}`);
    continue;
  }
  const expected = readFileSync(file, "utf8");
  if (actual === expected) {
    check(true, `${name}: matches its approved signature`);
  } else {
    // The first differing line, because a whole-artifact dump buries it.
    const a = actual.split("\n"), b = expected.split("\n");
    const i = a.findIndex((l, k) => l !== b[k]);
    check(false, `${name}: matches its approved signature`,
      `first difference at line ${i + 1}\n        approved: ${JSON.stringify(b[i])}\n        actual:   ${JSON.stringify(a[i])}`);
  }
}

// ── The controls ─────────────────────────────────────────────────────────────
//
// Four runs, two scenarios twice each, serving every control below. The happy
// path reaches the most seams; the maintenance scenario is the only one that
// reaches the cooldown recorder, so between them they exercise every redaction
// pattern. Running them in pairs is what makes the per-pattern control possible
// at all: a pattern's justification is a DIFFERENCE between two runs, and one
// run cannot show a difference.
const PAIRED = ["01-happy-path", "10-maintenance-on-release-and-cooldown"];
const pairs = [];
for (const name of PAIRED) {
  const entry = SCENARIOS.find(([n]) => n === name);
  // A named scenario that no longer exists would otherwise skip its controls in
  // silence, which is the failure this whole file is about.
  check(!!entry, `control: the paired scenario ${name} is still in the list`);
  if (!entry) continue;
  const two = [];
  for (let i = 0; i < 2; i++) {
    const seams = [];
    const out = await run({ ...entry[1], seams });
    two.push({ done: serialise({ ...out, seams }), raw: serialise({ ...out, seams }, raw) });
  }
  pairs.push([name, two[0], two[1]]);
  rawRuns.push(two[0].raw);
}

// 1. DETERMINISM IS THE PRECONDITION. If a scenario does not reproduce itself
//    within one process, comparing it across a refactor means nothing -- every
//    later difference would be unattributable.
for (const [name, a, b] of pairs) {
  check(a.done === b.done, `${name}: the same scenario twice is byte-identical, so a later difference is attributable`,
    a.done === b.done ? "" : `first diff: ${a.done.split("\n").find((l, i) => l !== b.done.split("\n")[i])}`);
}

// 2. EVERY REDACTION PATTERN MATCHES SOMETHING A TICK PRODUCED. A pattern that
//    never fires is not harmless: it reads as coverage, and it sits in the list
//    where a reader takes it for a reason that was checked. Four of the patterns
//    this list replaced had never matched anything.
for (const { name: pname, apply } of REDACTIONS) {
  const fires = rawRuns.some((t) => apply(t) !== t);
  check(fires, `control: the ${pname} redaction matches something a tick actually emitted`);
}

// 3. EVERY "varies" PATTERN IS LOAD-BEARING. Drop it, and two runs of one
//    scenario must stop matching. A pattern that is NOT load-bearing is
//    normalising something stable -- which is to say it is blanking behaviour,
//    and the signature can no longer see a change to it. This is the control
//    that would have caught a redactor blanking the lease id, the incarnation
//    token, the run reference and the head the worker was sent at.
for (const { name: pname, kind, cameFromTheHost } of REDACTIONS) {
  if (kind === "varies") {
    const bearing = pairs.some(([, a, b]) => redact(a.raw, pname) !== redact(b.raw, pname));
    check(bearing, `control: without the ${pname} redaction two runs differ, so it normalises variance rather than hiding behaviour`);
  } else {
    // The provenance half. `.some` over actual matches, so a text with no
    // occurrence cannot satisfy it -- the check cannot pass by finding nothing.
    check(rawRuns.some((t) => cameFromTheHost(t)),
      `control: the value the ${pname} redaction removes is demonstrably this host's, which is the reason for removing it`);
  }
}

// 4. AND THE ARTIFACTS MUST BE ABLE TO DIFFER. An approval mechanism that
//    reports success no matter what is the vacuous case, and it looks exactly
//    like a passing one.
check(pairs.length === 2 && pairs[0][1].done !== pairs[1][1].done,
  "control: two different scenarios produce different artifacts, so equality means something");

// 5. THE RESULT FIELD MUST NOT BE VACUOUS. It once recorded `"decisions":[null]`
//    for every scenario because the action is nested one level deeper than it
//    was read from -- a field that looks populated and measures nothing.
//    Asserted against the artifacts themselves, so it cannot regress silently.
{
  const withAction = SCENARIOS
    .map(([n]) => join(APPROVED, `${n}.txt`))
    .filter((f) => existsSync(f))
    .filter((f) => /"decisions":\[(?!null)[^\]]/.test(readFileSync(f, "utf8")));
  check(withAction.length > 0,
    "at least one artifact records a REAL decision action, so the result field is not vacuous",
    `${withAction.length} of ${SCENARIOS.length} artifacts name an action`);
}

// 6. THE RELEASE CARRIES THE IDENTITY THE CLAIM ISSUED. Not "an id and a token"
//    -- the ones that were handed out. The claim answers deterministically here,
//    so all three are behaviour, and asserting them literally is what stops the
//    redactor from ever blanking them again: a pattern wide enough to cover
//    `"id"` or `"token"` fails this check the moment it is added.
{
  const f = join(APPROVED, "01-happy-path.txt");
  const line = existsSync(f)
    ? readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("providerRelease\t")) : null;
  const carries = !!line && line.includes(`"id":1,"token":"${CLAIM_TOKEN}"`)
    && line.includes('"runRef":"o/r#42:FIX_CI"');
  check(carries,
    "the recorded release carries the id, token and run reference the claim issued, so dropping any one of them changes the signature",
    line ?? "no providerRelease seam was recorded at all");
}

// 7. THE MAINTENANCE SCENARIO REACHES BOTH HALVES OF ITS NAME. A scenario named
//    for coverage it does not have is worse than a missing one: it is counted.
{
  const f = join(APPROVED, "10-maintenance-on-release-and-cooldown.txt");
  const t = existsSync(f) ? readFileSync(f, "utf8") : "";
  check(/^noteRateLimit\t/m.test(t),
    "the maintenance scenario reaches the cooldown recorder, not only the release");
  check(/^cooldownRetry: \S/m.test(t) && /^providerRetry: \S/m.test(t),
    "and BOTH deferred obligations survive into the next tick's carried state",
    `${(t.match(/^(?:cooldown|provider)Retry: .*/gm) ?? []).join("  |  ")}`);
}

// 8. AND THE ARTIFACTS MUST BE PORTABLE, not merely reproducible. The
//    determinism control above runs one process twice and cannot see host
//    dependence; six scenarios once failed in CI against artifacts approved
//    locally, with no behaviour change. These are the two "host" patterns'
//    positive side: control 2 proves each one FIRES, and these prove what it
//    fired on did not survive into the file.
{
  const files = SCENARIOS.map(([n]) => join(APPROVED, `${n}.txt`)).filter((f) => existsSync(f));
  const hostish = files.filter((f) => /\/(?:Users|home|root|opt)\//.test(readFileSync(f, "utf8")));
  check(hostish.length === 0,
    "no artifact embeds an absolute host path, so they compare on a machine that is not this one",
    hostish.join(", "));
  // A pid is not a path, so the check above cannot see it. ASSERTED BY SHAPE,
  // not against `process.pid`: artifacts are approved in one process and
  // compared in another, so a check for THIS process's id would never match the
  // leaked one and would pass on every real leak. What makes this absence
  // non-vacuous is the provenance control above -- it proves a numeric pid IS
  // present before redaction, so finding none here means it was removed rather
  // than never written.
  const pidLeak = files.filter((f) => /"pid"\s*:\s*\d/.test(readFileSync(f, "utf8")));
  check(pidLeak.length === 0,
    "and none carries an unredacted process id, which no other process could ever match",
    pidLeak.join(", "));
}

if (approvedWritten) console.log(`\n${approvedWritten} artifact(s) written. Review the diff; they are the record.`);
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exitCode = fail ? 1 : 0;
