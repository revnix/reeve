// A builder escalation key is an IDENTITY, and the failure type rides in the body.
//
// `bt:7:lease:starved` is one situation however long it has been starved;
// `bt:7:lease:starved:4200s` is a new situation every tick, and a standing cause
// that re-announces itself is how an unattended system trains its owner to
// ignore it. So the key carries only what says WHICH situation this is, and
// everything that changes while the situation does not rides in the body.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HOLD_ESCALATION, PHASES } from "../src/build/phases.mjs";
import {
  FAILURE_TYPES, IDENTITY_SHAPES, PAGES, escalationKey, shapeOf, body,
} from "../src/build/announce.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const refused = (args) => {
  try { escalationKey(args); return "returned"; } catch (e) { return e.kind ?? "threw"; }
};

// ── the identity list is closed, and closed against the CODE ────────────────
//
// Every shape here is one a site in this repository actually mints. A shape
// nothing can raise is permanently unmeasured, and inside a closed list an entry
// that can never fire is indistinguishable from one that works.
{
  check(Object.isFrozen(IDENTITY_SHAPES), "the identity list cannot be widened at runtime");
  check(IDENTITY_SHAPES.length === 10,
    `S3 can raise exactly ten identities, not ${IDENTITY_SHAPES.length}`,
    IDENTITY_SHAPES.join("\n        "));
  for (const s of IDENTITY_SHAPES)
    check(/^(bt:<id>:|builder:)/.test(s),
      `${s} is dispatched by the builder: every identity starts bt:<id>: or builder:`, s);
  check(IDENTITY_SHAPES.every(s => !/<sha>|<count>|<seconds>|<path>/.test(s)),
    "and no shape carries a placeholder for detail", IDENTITY_SHAPES.join(","));
  check(new Set(IDENTITY_SHAPES).size === IDENTITY_SHAPES.length,
    "and `depth:post-approval`, which is both minted and declared in the hold map, is ONE identity",
    IDENTITY_SHAPES.join(","));

  // DERIVED, not re-typed. `HOLD_ESCALATION` is closed against `pr_hold`'s CHECK
  // set, and its own comment records that a second copy is a second closed set
  // to drift from the DDL. This asserts the derivation actually happened: a
  // hand-written list would pass an equality against itself and prove nothing,
  // so the comparison is against the OTHER module's values.
  const holds = Object.values(HOLD_ESCALATION).filter(v => v !== null);
  check(holds.length === 5, "control: the hold map declares five identities", holds.join(","));
  for (const h of holds)
    check(IDENTITY_SHAPES.includes(h),
      `the hold-cause identity ${h} is carried, not re-typed`, IDENTITY_SHAPES.join(","));
  check(HOLD_ESCALATION.blocked_other === null,
    "control: `blocked_other` declares no shape, because its key comes from the caller",
    String(HOLD_ESCALATION.blocked_other));
}

// ── every identity the codebase mints is declared ───────────────────────────
//
// The list is measured against source rather than transcribed, so this reads the
// mint sites back and requires each one to be declared. A shape the code raises
// and the list omits is an escalation raised into a namespace nothing reads --
// the page list cannot decide about it and no announcer can name it.
{
  const SRC = ["src/build/phases.mjs", "src/build/report.mjs", "src/backup.mjs"]
    .map(f => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), "utf8")).join("\n");
  check(SRC.length > 1000, "control: the mint sites were read, so this is not scanning nothing",
    `${SRC.length} bytes`);
  // A minted key is a template: `bt:<id>` literal, and `${phase}` for the phase.
  const minted = [...new Set([...SRC.matchAll(/["'`](bt:<id>:[^"'`]*|builder:[a-z][a-z0-9:-]*)["'`]/g)]
    .map(m => m[1].replace(/\$\{phase\}/g, "<phase>")))]
    .filter(k => !/^builder:(backup)$/.test(k));
  check(minted.length >= 9,
    "control: the extraction finds the mint sites, so an empty result cannot pass",
    `${minted.length}: ${minted.join(", ")}`);
  const undeclared = minted.filter(k => !IDENTITY_SHAPES.includes(k));
  check(undeclared.length === 0,
    "every identity a site in this repository mints is declared in IDENTITY_SHAPES",
    `undeclared: ${undeclared.join(", ")}`);

  // COUNTER-CONTROL. The extraction above is a regex over source text, and a
  // rename disables such a guard while it still prints PASS. So the same
  // extraction is run over a literal string containing a violating mint, and it
  // must find it.
  const VIOLATION = 'return go("ESCALATED", { escalate: `bt:<id>:lease:starved:${seconds}s` });';
  const found = [...VIOLATION.matchAll(/["'`](bt:<id>:[^"'`]*|builder:[a-z][a-z0-9:-]*)["'`]/g)]
    .map(m => m[1]);
  check(found.length === 1 && found[0].includes("lease:starved"),
    "counter-control: the same extraction finds a violating mint in a literal sample",
    JSON.stringify(found));
  check(!IDENTITY_SHAPES.includes(found[0].replace(/\$\{seconds\}s/, "")),
    "and that sample would be reported undeclared, so the check above can fail", found[0]);
}

// ── the minter refuses detail ───────────────────────────────────────────────
{
  check(escalationKey({ task: "bt:7", kind: "phase:blocked", phase: "RESEARCH" })
        === "bt:7:phase:blocked:RESEARCH",
    "a task-scoped identity is task, kind and phase, in that order",
    escalationKey({ task: "bt:7", kind: "phase:blocked", phase: "RESEARCH" }));
  check(escalationKey({ kind: "backup:failed" }) === "builder:backup:failed",
    "a process-scoped identity has no task and is prefixed builder:",
    escalationKey({ kind: "backup:failed" }));
  check(escalationKey({ task: "bt:7", kind: "infeasible" }) === "bt:7:infeasible",
    "and a phase-less task identity omits the phase rather than padding it",
    escalationKey({ task: "bt:7", kind: "infeasible" }));

  check(refused({ task: "bt:7", kind: "gate:revision-loop", detail: "4200s" })
        === "escalation_key_detail",
    "a detail component is REFUSED: detail rides in the body");
  check(refused({ task: "bt:7", kind: "gate:revision-loop 4200s" }) === "escalation_key_shape",
    "and so is detail smuggled into the kind, because a space is not a component");
  check(refused({ task: "bt:7", kind: "phase:failed", phase: "sizing" }) === "escalation_key_shape",
    "and a lowercase phase, which is not one of the enumerated phases");
  check(refused({ task: "7", kind: "infeasible" }) === "escalation_key_shape",
    "and a task id without its bt: prefix, which would mint bt:bt:7 downstream");
  check(refused({ kind: "phase:failed", phase: "SIZING" }) === "escalation_key_shape",
    "and a phase with no task, because a builder: identity belongs to the process");
  check(refused({ task: "bt:7", kind: "lease:starved" }) === "escalation_key_undeclared",
    "and a well-formed key nothing declares, which would be raised where nothing reads");

  // CONTROL: the refusal is not "everything throws". Without this every
  // assertion above passes over a function whose body is a bare throw.
  check(refused({ task: "bt:7", kind: "infeasible" }) === "returned",
    "control: a well-formed, declared identity is minted rather than refused");

  // REFUSES rather than sanitises. A key quietly stripped of its detail is a key
  // the caller believes carries it, and the body it should have ridden in is
  // never written.
  let stripped = null;
  try { escalationKey({ task: "bt:7", kind: "gate:revision-loop", detail: "4200s" }); }
  catch (e) { stripped = e.message; }
  check(/detail/i.test(stripped) && /body/i.test(stripped),
    "and the refusal says where the detail should have gone", String(stripped).slice(0, 160));
}

// ── every minted key reduces to a declared shape ────────────────────────────
{
  for (const [args, expected] of [
    [{ task: "bt:01H9", kind: "phase:failed", phase: "SIZING" }, "bt:<id>:phase:failed:<phase>"],
    [{ task: "bt:01H9", kind: "gate:revision-loop" }, "bt:<id>:gate:revision-loop"],
    [{ task: "bt:01H9", kind: "spec:reopened" }, "bt:<id>:spec:reopened"],
    [{ kind: "backup:failed" }, "builder:backup:failed"],
  ]) {
    const key = escalationKey(args);
    check(shapeOf(key) === expected, `${key} reduces to ${expected}`, String(shapeOf(key)));
  }
  check(shapeOf("bt:7:lease:starved") === null,
    "and a key matching no declared shape reduces to null rather than to something near it",
    String(shapeOf("bt:7:lease:starved")));
  // The phase is the ONLY uppercase tail a reduction may eat. Without this the
  // reducer could swallow a detail component that merely looks like a phase.
  for (const p of PHASES)
    check(shapeOf(`bt:7:phase:failed:${p}`) === "bt:<id>:phase:failed:<phase>",
      `control: ${p} reduces as a phase, so the reduction covers the whole enum`);
}

// ── the page list is a subset, and every entry is reachable ─────────────────
//
// An escalation is a durable row that stops work; a page is an interruption.
// Escalating everything is not the safe end of that trade -- an over-pushing
// channel is muted within days and is then worse than nothing.
{
  check(Object.isFrozen(PAGES), "the page list cannot be widened at runtime");
  for (const p of PAGES)
    check(IDENTITY_SHAPES.includes(p),
      `${p} is a declared identity, so a page cannot name a situation nothing raises`,
      IDENTITY_SHAPES.join(","));
  check(PAGES.length < IDENTITY_SHAPES.length,
    "and pages are a strict subset: if everything pages, nothing does",
    `${PAGES.length} of ${IDENTITY_SHAPES.length}`);
  check(!PAGES.includes("builder:sandbox:canary-failed"),
    "the canary page is absent, because nothing in this repository raises it");
}

// ── the body is typed ───────────────────────────────────────────────────────
{
  check(FAILURE_TYPES.length === 4 && Object.isFrozen(FAILURE_TYPES),
    "four failure types, frozen", FAILURE_TYPES.join(","));
  const b = body({ type: "BLOCKED", seconds: 4200, phase: "RESEARCH" });
  check(b.type === "BLOCKED" && b.seconds === 4200,
    "the body carries the type and the detail the key refused", JSON.stringify(b));
  check(Object.isFrozen(b), "and is frozen, so a later caller cannot edit what was announced");
  let kind = null;
  try { body({ type: "WEDGED" }); } catch (e) { kind = e.kind; }
  check(kind === "escalation_body_type",
    "an undeclared failure type is refused: 'it stopped' and 'it may have stopped' want " +
    "different answers from a human", String(kind));
  let none = null;
  try { body({ seconds: 1 }); } catch (e) { none = e.kind; }
  check(none === "escalation_body_type", "control: and so is a body with no type at all");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
