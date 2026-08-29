// The hub session's guarantees, tested without a database.
//
// The session performs no I/O and imports nothing: `getter`, `onFault` and
// `overrides` all arrive as arguments. That is what makes these assertions
// possible at all -- a test can observe every handle the session ever hands out,
// and count every time it asks for one.
//
// WHAT IS BEING ASSERTED, and it is not "the code runs":
//
//   every operation takes a handle acquired FOR IT, not one taken earlier;
//   an absent hub performs NO operation, and runs the caller's own answer;
//   the fault is reported ONCE however many times the hub is read;
//   the surface cannot be replaced by a caller.
//
// Each has a control that fails if the fixture stopped exercising it, because an
// assertion over a scenario that never reached the code is the failure this
// programme keeps paying for.

import { hubSession, NO_HUB } from "../src/build/hubsession.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

/** A getter that hands out a DISTINCT handle per ask and records each one. */
const recording = (why = null) => {
  const handed = [];
  return { handed, get: () => { const h = { id: handed.length }; handed.push(h); return { hub: why ? null : h, why }; } };
};

// ── A handle is acquired for each operation, never reused ───────────────────
{
  const g = recording();
  const used = [];
  const s = hubSession({ getter: g.get, onFault: () => {},
                         overrides: { op: (h) => { used.push(h); return { ok: true }; } } });
  s.perform("op", null, {}, () => {});
  s.perform("op", null, {}, () => {});
  s.perform("op", null, {}, () => {});

  check(used.length === 3, "control: the operations really ran", `${used.length} of 3`);
  check(g.handed.length === 3, "the hub is asked once per operation, not once per tick", `${g.handed.length} acquisition(s)`);
  check(new Set(used).size === 3, "and each operation received a DIFFERENT handle, so none is reused");
  check(used.every((h, i) => h === g.handed[i]),
    "and each received the handle acquired for IT, in order");
}

// ── An absent hub performs nothing, and the caller decides what that means ──
{
  const g = recording("busy");
  let performed = 0, policyRan = 0;
  const s = hubSession({ getter: g.get, onFault: () => {},
                         overrides: { op: () => { performed++; return { ok: true }; } } });
  const r = s.perform("op", null, {}, () => { policyRan++; return NO_HUB; });

  check(performed === 0, "with no handle the operation is NOT performed", `${performed} call(s)`);
  check(policyRan === 1, "and the caller's own answer runs instead", `${policyRan} time(s)`);
  check(r === NO_HUB, "and its value is what the caller returned, not a fabricated one");
  // A SENTINEL, not a falsy value: `undefined`, `null` and `{ok:false}` are all
  // things a scheduler can legitimately answer, and a caller that cannot tell
  // "no scheduler" from "the scheduler refused" will eventually treat one as the
  // other. That already happened once, and a lease was silently discarded.
  check(typeof NO_HUB === "symbol", "and NO_HUB is a symbol no scheduler could return");
}

// ── Omitting the answer is a distinct, documented outcome ──────────────────
{
  const g = recording("busy");
  const s = hubSession({ getter: g.get, onFault: () => {}, overrides: {} });
  check(s.perform("op", () => ({ ok: true }), {}) === undefined,
    "a site that states no answer for an absent hub gets undefined, which its own code must handle");
}

// ── The fault is reported once, however many times the hub is read ─────────
{
  const g = recording("corrupt");
  const said = [];
  const s = hubSession({ getter: g.get, onFault: (why) => said.push(why), overrides: {} });
  s.available(); s.available();
  s.perform("op", () => {}, {}, () => {});
  s.sayFault("corrupt");

  check(g.handed.length >= 3, "control: the hub really was read several times", `${g.handed.length}`);
  check(said.length === 1, "an outage is reported ONCE, not once per read", `${said.length} report(s)`);
  check(said[0] === "corrupt", "and it carries the reason the getter gave", JSON.stringify(said));
}

// ── available() answers the question without handing back the answer ───────
{
  const g = recording();
  const s = hubSession({ getter: g.get, onFault: () => {}, overrides: {} });
  const a = s.available();
  check(a === true, "available() answers yes when there is a scheduler");
  check(typeof a === "boolean", "and answers with a BOOLEAN, so asking cannot leave a handle in scope");
  check(!g.handed.includes(a), "control: and what it returns is not the handle it read");

  const gone = hubSession({ getter: recording("busy").get, onFault: () => {}, overrides: {} });
  check(gone.available() === false, "and no when there is not");
}

// ── The surface cannot be replaced ─────────────────────────────────────────
{
  const g = recording();
  const s = hubSession({ getter: g.get, onFault: () => {}, overrides: {} });
  const before = s.perform;
  try { s.perform = () => "hijacked"; } catch { /* strict mode throws; either is fine */ }
  check(s.perform === before,
    "assigning over `perform` does not take -- one line would otherwise reinstate the whole defect class");
  check(Object.isFrozen(s), "and the session is frozen");
}

// ── Overrides are read at CALL time, not at construction ──────────────────
{
  const g = recording();
  const overrides = {};
  const s = hubSession({ getter: g.get, onFault: () => {}, overrides });
  let viaFallback = 0, viaOverride = 0;
  s.perform("op", () => { viaFallback++; }, {}, () => {});
  overrides.op = () => { viaOverride++; };
  s.perform("op", () => { viaFallback++; }, {}, () => {});

  check(viaFallback === 1 && viaOverride === 1,
    "a seam replaced after construction is honoured, as `(ctx.NAME ?? fallback)` always did",
    `fallback=${viaFallback} override=${viaOverride}`);
}

// ── A getter that is not a function is a handle, not a crash ──────────────
{
  const handle = { id: "direct" };
  const used = [];
  const s = hubSession({ getter: handle, onFault: () => {},
                         overrides: { op: (h) => { used.push(h); } } });
  s.perform("op", null, {}, () => {});
  check(used[0] === handle, "a plain handle passed as the getter is used directly");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exitCode = fail ? 1 : 0;
