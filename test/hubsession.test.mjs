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

// ── The two obligations that outlive a tick ────────────────────────────────
//
// A release and a cooldown are the only scheduler operations whose FAILURE must
// be remembered. Everything else is fire-and-forget. These are driven directly
// here rather than through a whole tick, which is what the issue asked for:
// through a tick, each of these branches needs a scenario, and three of them
// need a hub that changes state mid-run.

const session = (opts = {}) => {
  const retries = { releases: new Map(), cooldowns: new Map() };
  const logged = [], raised = [];
  const s = hubSession({
    getter: opts.getter ?? (() => ({ hub: { db: true }, why: null })),
    onFault: () => {}, overrides: opts.overrides ?? {},
    log: (m) => logged.push(m), raise: (m) => raised.push(m),
    isAlive: () => true, retries,
    ops: { providerRelease: opts.release ?? (() => ({ ok: true })),
           noteRateLimit: opts.note ?? (() => ({ ok: true })) },
  });
  return { s, retries, logged, raised };
};
const IDENT = { owner: "guardian", repoId: 7, runRef: "o/r#1", id: 4, token: "tok" };

// ── A release: three routes out, and all three must RETAIN ─────────────────
{
  // ABSENT is the one exception: no scheduler means no lease and nothing owed.
  const absent = session({ getter: () => ({ hub: null, why: null }) });
  absent.s.release("k", IDENT);
  check(absent.retries.releases.size === 0,
    "an ABSENT hub owes nothing -- there is no scheduler, so there is no lease to give back");

  // UNREADABLE is not absent, and this is the distinction a handle cannot carry.
  const unreadable = session({ getter: () => ({ hub: null, why: "busy" }) });
  unreadable.s.release("k", IDENT);
  check(unreadable.retries.releases.get("k") === IDENT,
    "an UNREADABLE hub keeps the obligation, with the identity it was given");

  // A REFUSAL is the scheduler working, and it must not be read as done.
  const refused = session({ release: () => ({ ok: false, reason: "maintenance" }) });
  refused.s.release("k", IDENT);
  check(refused.retries.releases.get("k") === IDENT, "a maintenance refusal defers, it does not discard");

  // A THROW is not a refusal, and only the refusal used to be handled.
  const threw = session({ release: () => { throw new Error("disk image malformed"); } });
  threw.s.release("k", IDENT);
  check(threw.retries.releases.get("k") === IDENT, "a THROW defers too, which is the route that once dropped it");
  check(threw.raised.length === 1, "and it says so, because dispatching unscheduled is what it causes");

  // And success clears it, or every release would be retried for ever.
  const ok = session();
  ok.retries.releases.set("k", IDENT);
  ok.s.release("k", IDENT);
  check(ok.retries.releases.size === 0, "control: a release that succeeds clears the obligation");
}

// ── A cooldown: the window started when the 429 was SEEN ───────────────────
{
  const nowSec = Math.floor(Date.now() / 1000);
  const sent = [];
  const c = session({ note: (h, a) => { sent.push(a); return { ok: false, reason: "maintenance" }; } });
  c.s.noteCooldown("c", { signature: "claude", cooldownSeconds: 600 });
  const held = c.retries.cooldowns.get("c");

  check(held?.expiresAt >= nowSec + 600, "a deferred cooldown carries an ABSOLUTE expiry, not a duration",
    JSON.stringify(held));
  check(held?.observedAt != null, "and the OBSERVATION time, so a later retry cannot look newer than a real 429");

  // THE RETRY ASKS FOR WHAT IS LEFT, not for the whole window again. An outage
  // longer than the cooldown would otherwise recover and then impose a fresh
  // block for a window that had already passed.
  const c2 = session({ note: (h, a) => { sent.push(a); return { ok: true }; } });
  c2.s.noteCooldown("c", { signature: "claude", cooldownSeconds: 600,
                           observedAt: nowSec - 500, expiresAt: nowSec + 100 });
  const asked = sent[sent.length - 1];
  check(asked.cooldownSeconds <= 100 && asked.cooldownSeconds > 0,
    "a retry asks for the REMAINING window, not the original duration", `asked for ${asked.cooldownSeconds}s`);
  check(asked.observedAt === nowSec - 500, "and carries the original observation time unchanged");

  // A window that elapsed while we could not write it is not a fact any more.
  //
  // ASSERTED ON THE RECORDER, not on the map. Checking only that the map ends
  // empty cannot fail: without the guard the note is still sent, the recorder
  // answers ok, and the success path deletes the key -- the same empty map by a
  // different route. MEASURED: with the guard removed, that assertion stayed
  // green. The property is that a dead cooldown is never WRITTEN.
  const writes = [];
  const gone = session({ note: (h, a) => { writes.push(a); return { ok: true }; } });
  gone.retries.cooldowns.set("c", { signature: "claude", cooldownSeconds: 600, expiresAt: nowSec - 1 });
  gone.s.noteCooldown("c", { signature: "claude", cooldownSeconds: 600, expiresAt: nowSec - 1 });
  check(writes.length === 0,
    "a cooldown whose window has passed is dropped, never written as a fact that stopped being true",
    `${writes.length} write(s): ${JSON.stringify(writes)}`);
  check(gone.retries.cooldowns.size === 0, "and it stops being carried");
  // Control: the same fixture DOES write a cooldown that is still live, so the
  // assertion above is not passing because nothing ever writes.
  const live = session({ note: (h, a) => { writes.push(a); return { ok: true }; } });
  live.s.noteCooldown("c", { signature: "claude", cooldownSeconds: 600 });
  check(writes.length === 1, "control: a live cooldown IS written, so silence above means something",
    `${writes.length} write(s)`);
}

// ── The replay order is the point ──────────────────────────────────────────
{
  const order = [];
  const d = session({ release: () => { order.push("release"); return { ok: true }; },
                      note: () => { order.push("cooldown"); return { ok: true }; } });
  d.retries.releases.set("r", IDENT);
  d.retries.cooldowns.set("c", { signature: "claude", cooldownSeconds: 600 });
  d.s.drainRetries();

  check(order.length === 2, "control: the drain really replayed both", JSON.stringify(order));
  check(order[0] === "cooldown",
    "COOLDOWNS replay before releases: a cooldown declares the window exhausted, a release hands a slot back, " +
    "and returning capacity first lets a tick in between spend what is about to be declared unusable",
    JSON.stringify(order));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exitCode = fail ? 1 : 0;
