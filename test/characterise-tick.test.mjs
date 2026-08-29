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
// REDACTION IS REQUIRED, NOT COSMETIC. Timestamps, pids, tokens, ids and temp
// paths differ per run; without normalising them every artifact differs from
// itself and the whole mechanism reports noise. `newToken()` is
// `Date.now().toString(36) + Math.random()` with no injection point, so
// redaction is strictly cheaper than adding one.
//
// TO APPROVE A CHANGE:  REEVE_APPROVE=1 node test/characterise-tick.test.mjs
// Approving is a deliberate act and the diff is the thing a reviewer reads.

import { run } from "./fixtures/tick-harness.mjs";
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

/**
 * Everything that varies run to run, replaced by a stable token.
 *
 * Each pattern is here because it was OBSERVED to vary, not because it looked
 * like it might. A pattern that never matches is dead weight that hides a real
 * one, so the harness asserts below that the redactor actually fired.
 */
// Every key whose value is generated per run. One list, asserted below.
const GENERATED = ["token", "lstart", "sessionId", "runRef", "runId"];

// THE INTERPRETER PATH IS PART OF THE HOST, not of the behaviour. `spawnWorker`
// records an allow-rule naming the running node binary, so an artifact captured
// on one machine cannot match on another -- MEASURED: six scenarios failed in CI
// against artifacts approved locally, with no change to the tick at all.
//
// The determinism check below runs the same scenario twice in ONE process, so it
// proves reproducibility and says nothing about portability. This is the half it
// cannot see, which is why the path is redacted rather than merely noticed.
const NODE_PATH_RE = /(?:\/[^\s"',)\]]*)?\bnode\/?[^\s"',)\]]*\/bin\/node\b|\/[^\s"',)\]]*\/bin\/node\b/g;

const redact = (s) => String(s)
  .replace(NODE_PATH_RE, "<node>")
  .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>")
  .replace(/\/(?:private\/)?(?:var|tmp)\/[^\s"'),\]]*/g, "<tmp>")
  .replace(/"pid"\s*:\s*\d+/g, '"pid":<pid>')
  .replace(/\bpid[= ]\d+/g, "pid=<pid>")
  // KEY-DRIVEN, not one pattern per key. Every generated identifier here has the
  // same provenance -- a base36 clock reading joined to a random suffix -- and
  // they arrive under several names. Listing the KEYS in one place means a new
  // one is a single addition rather than a new pattern, and the control below
  // asserts each name in the list actually gets replaced.
  .replace(new RegExp(`"(${GENERATED.join("|")})"\\s*:\\s*"[^"]*"`, "g"), '"$1":"<redacted>"')
  .replace(/"id"\s*:\s*\d+/g, '"id":<id>')
  .replace(/\b\w+_at"\s*:\s*[^,}]+/g, (m) => m.replace(/:.*/, ':"<at>"'))
  .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
  // THE RUN REFERENCE. Generated the same way as a token -- a base36 clock
  // reading joined to a random suffix -- so it differs on every tick. Found by
  // the determinism check below rather than anticipated, which is the reason
  // that check runs before any artifact is trusted.
  .replace(/\brun [0-9a-z]+-[0-9a-z]+/g, "run <ref>");

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

const serialise = ({ seams, esc, log, r, ctx }) => [
  "== 1 SEAM LOG",
  seams.map(({ op, args }) => `${op}\t${redact(argsOf(args))}`).join("\n"),
  "",
  "== 2 ESCALATIONS",
  // REDACTED TOO. An escalation KEY can carry a temp path -- the
  // checkout-tampered one names the preserved checkout -- so the key varies per
  // run. Sorting after redaction, or the order follows the unredacted text.
  redact([...(r.escalations?.keys?.() ?? [])].map(redact).sort().join("\n")),
  "",
  "== 3 LOG FILE",
  redact(log).trimEnd(),
  "",
  "== 4 RESULT",
  redact(JSON.stringify({
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
    release: () => ({ ok: false, reason: "maintenance" }),
    claim: () => ({ ok: true, id: 1 }),
  }],
];

if (!existsSync(APPROVED)) mkdirSync(APPROVED, { recursive: true });

// A CONTROL ON THE REDACTOR ITSELF. If it stops firing, every artifact still
// compares equal to a stale approved file for a while and then all of them
// differ at once -- so it is asserted directly, on a string containing one of
// each varying shape.
{
  const sample = '{"id":7,"token":"abc","pid":41,"x_at":123} 2026-08-28T05:04:05.866Z /tmp/reeve-x/y';
  const out = redact(sample);
  check(!/\d{4}-\d{2}-\d{2}T/.test(out), "control: the redactor replaces timestamps", out);
  check(out.includes("<tmp>"), "control: and temp paths", out);
  check(/"id":<id>/.test(out), "control: and numeric ids", out);
  check(/"token":"<redacted>"/.test(out), "control: and tokens", out);
  check(!/"pid"\s*:\s*\d/.test(out), "control: and pids", out);
  // EVERY name in the list, not a representative one. A key that stops being
  // replaced would otherwise sit undetected until it happened to vary.
  for (const k of GENERATED) {
    const one = redact(`{"${k}":"mtdx5ou9-ag6t"}`);
    check(one === `{"${k}":"<redacted>"}`, `control: the redactor replaces ${k}`, one);
  }
  check(/run <ref>,/.test(redact("dispatching FIX_CI (run mtdx5p7z-11oh, attempt 1)")),
    "control: and a run reference in the log's prose, which carries no key");
}

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

// DETERMINISM IS THE PRECONDITION. If a scenario does not reproduce itself
// within one process, comparing it across a refactor means nothing -- every
// later difference would be unattributable. Asserted on the happy path, which
// exercises the most seams.
{
  const s1 = [], s2 = [];
  const a = serialise({ ...(await run({ seams: s1 })), seams: s1 });
  const b = serialise({ ...(await run({ seams: s2 })), seams: s2 });
  check(a === b, "the same scenario twice is byte-identical, so a later difference is attributable",
    a === b ? "" : `first diff: ${a.split("\n").find((l, i) => l !== b.split("\n")[i])}`);
}

// AND THE ARTIFACTS MUST BE ABLE TO DIFFER. An approval mechanism that reports
// success no matter what is the vacuous case, and it looks exactly like a
// passing one.
{
  const s = [];
  const base = serialise({ ...(await run({ seams: s })), seams: s });
  const s2 = [];
  const other = serialise({ ...(await run({ seams: s2, claim: () => ({ ok: false, reason: "at-limit" }) })), seams: s2 });
  check(base !== other,
    "control: two different scenarios produce different artifacts, so equality means something");
}

// THE RESULT FIELD MUST NOT BE VACUOUS. It recorded `"decisions":[null]` for
// every scenario because the action is nested one level deeper than it was read
// from -- a field that looks populated and measures nothing. Asserted against
// the artifacts themselves, so it cannot regress to nulls silently.
{
  const withAction = SCENARIOS
    .map(([n]) => join(APPROVED, `${n}.txt`))
    .filter((f) => existsSync(f))
    .filter((f) => /"decisions":\[(?!null)[^\]]/.test(readFileSync(f, "utf8")));
  check(withAction.length > 0,
    "at least one artifact records a REAL decision action, so the result field is not vacuous",
    `${withAction.length} of ${SCENARIOS.length} artifacts name an action`);
}

// AND THE ARTIFACTS MUST BE PORTABLE, not merely reproducible. The determinism
// check runs one process twice and cannot see host dependence; six scenarios
// once failed in CI against artifacts approved locally, with no behaviour change.
{
  const hostish = SCENARIOS
    .map(([n]) => join(APPROVED, `${n}.txt`))
    .filter((f) => existsSync(f))
    .filter((f) => /\/(?:Users|home|root|opt)\//.test(readFileSync(f, "utf8")));
  check(hostish.length === 0,
    "no artifact embeds an absolute host path, so they compare on a machine that is not this one",
    hostish.join(", "));
}

if (approvedWritten) console.log(`\n${approvedWritten} artifact(s) written. Review the diff; they are the record.`);
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exitCode = fail ? 1 : 0;
