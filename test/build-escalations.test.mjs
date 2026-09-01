// A builder escalation key is an IDENTITY, and the failure type rides in the body.
//
// `bt:7:lease:starved` is one situation however long it has been starved;
// `bt:7:lease:starved:4200s` is a new situation every tick, and a standing cause
// that re-announces itself is how an unattended system trains its owner to
// ignore it. So the key carries only what says WHICH situation this is, and
// everything that changes while the situation does not rides in the body.
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOLD_ESCALATION, PHASES } from "../src/build/phases.mjs";
import { openHub } from "../src/build/hubdb.mjs";
import { openHubAsGuest } from "../src/build/hubguest.mjs";
import { open as openGuardianStore } from "../src/db/ops.mjs";
import { announceable } from "../src/daemon.mjs";
import { notify, readNtfyResponse } from "../src/notify.mjs";
import {
  FAILURE_TYPES, IDENTITY_SHAPES, PAGES, escalationKey, shapeOf, body,
  assertHub, builderAnnounceable, pages, announce,
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


// ── neither process may read the other's escalations ───────────────────────
//
// Escalation ownership is by PROCESS, and the proof is that each reader refuses
// the other's store. The two halves are not symmetric, and pretending they were
// would hide the asymmetry that matters: the guardian is already refused
// structurally, by the guest allowlist; the builder is refused by nothing,
// because the guardian's store carries an `escalation` table of the same shape
// and a write would land in it silently.
const dir = mkdtempSync(join(tmpdir(), "reeve-esc-"));
const NOW = 1_800_000_000;
const ALIVE = () => true, DEAD = () => false;
mkdirSync(join(dir, "state"), { recursive: true });
const hubPath = join(dir, "state", "hub.db");
const hub = openHub(hubPath);
const guardian = openGuardianStore(join(dir, "guardian.db"));

// A HUB PER BLOCK. Sharing one made every block's meaning depend on the block
// before it: a cause already standing is correctly not re-announced, and a pass
// that makes no coverage claim correctly retires everything absent -- so an
// assertion about "two paged" quietly became an assertion about execution order,
// and it would have passed or failed on where the block was moved to.
let hubSeq = 0;
const freshHub = () => {
  const d = join(dir, `h${++hubSeq}`);
  mkdirSync(d, { recursive: true });
  return openHub(join(d, "hub.db"));
};

{
  // --- the guardian half: already true, asserted rather than built ----------
  const guest = openHubAsGuest(hubPath);
  let readsLease = false;
  try { guest.prepare("SELECT count(*) c FROM provider_lease").get(); readsLease = true; }
  catch { readsLease = false; }
  check(readsLease,
    "control: the guardian's guest handle CAN read the hub's provider_lease, so the handle works");

  let guardianThrew = null;
  try { announceable(guest, new Map([["x", 1]]), { at: NOW }); }
  catch (e) { guardianThrew = e.message; }
  check(guardianThrew !== null && /escalation/.test(guardianThrew),
    "the guardian's announceable is refused the hub's escalation table by the guest allowlist",
    String(guardianThrew));

  // --- the builder half: the one that needed code --------------------------
  let builderKind = null;
  try { builderAnnounceable(guardian, new Map([["builder:backup:failed", 1]]),
                            { at: NOW, isAlive: ALIVE }); }
  catch (e) { builderKind = e.kind ?? "threw"; }
  check(builderKind === "not_a_hub",
    "the builder's announcer refuses the guardian's store, which has an escalation table of the " +
    "same shape and would have taken the write", String(builderKind));

  // CONTROL: the guardian store really does carry the table, so the refusal
  // above is about WHOSE store it is and not about a missing table.
  let hasEscalation = false;
  try { guardian.prepare("SELECT count(*) c FROM escalation").get(); hasEscalation = true; }
  catch { hasEscalation = false; }
  check(hasEscalation,
    "control: the guardian's store does carry an `escalation` table, so the refusal is about ownership");
  check(guardian.prepare("SELECT count(*) c FROM escalation").get().c === 0,
    "and nothing was written into it");

  // CONTROL: the refusal is not "everything is refused".
  const ok = builderAnnounceable(hub, new Map(), { at: NOW, isAlive: ALIVE });
  check(Array.isArray(ok.fresh) && Array.isArray(ok.cleared),
    "control: the same call against the real hub is accepted", JSON.stringify(ok));

  let notHub = null;
  try { assertHub(guardian); } catch (e) { notHub = e.kind; }
  check(notHub === "not_a_hub", "assertHub names the refusal so a caller can tell it apart",
    String(notHub));
  check(assertHub(hub) === hub, "control: and returns the hub it was given");
}

// ── arrival, change, and silence in between ────────────────────────────────
{
  const hub = freshHub();
  const key = escalationKey({ task: "bt:01AA", kind: "phase:blocked", phase: "RESEARCH" });
  const first = builderAnnounceable(hub, new Map([[key, 1]]), { at: NOW, isAlive: ALIVE });
  check(first.fresh.length === 1 && first.fresh[0].why === key,
    "a cause is announced when it arrives", JSON.stringify(first));

  const again = builderAnnounceable(hub, new Map([[key, 1]]), { at: NOW + 60, isAlive: ALIVE });
  check(again.fresh.length === 0,
    "and NOT announced again while its shape is unchanged, or the channel earns being muted",
    JSON.stringify(again));
  check(hub.prepare("SELECT last_seen_at FROM escalation WHERE why=?").get(key).last_seen_at === NOW + 60,
    "control: though the row was touched, so silence is a decision and not a skipped write");

  const changed = builderAnnounceable(hub, new Map([[key, 4]]), { at: NOW + 120, isAlive: ALIVE });
  check(changed.fresh.length === 1 && changed.fresh[0].count === 4,
    "and announced again when the count changes: one task blocked and four are different situations",
    JSON.stringify(changed));
}

// ── absence is not success ─────────────────────────────────────────────────
//
// The property the guardian paid for in production. A pass that could not
// examine a task produces no escalation for it, and retiring the cause on that
// silence announces "resolved" for something nobody looked at.
{
  const hub = freshHub();
  const key = escalationKey({ task: "bt:01BB", kind: "infeasible" });
  builderAnnounceable(hub, new Map([[key, 1]]), { at: NOW, isAlive: ALIVE });
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 1,
    "control: the cause is standing");

  const blind = builderAnnounceable(hub, new Map(), { at: NOW + 60, isAlive: ALIVE, covered: new Set() });
  check(blind.cleared.length === 0,
    "a cause absent from a pass that did NOT examine its task is not retired", JSON.stringify(blind));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 1,
    "and the row still stands, so nothing was announced as resolved");

  const looked = builderAnnounceable(hub, new Map(), {
    at: NOW + 120, isAlive: ALIVE, covered: new Set(["bt:01BB"]) });
  check(looked.cleared.includes(key),
    "and IS retired by a pass that examined it, so clearing still works", JSON.stringify(looked));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 0,
    "control: the row is gone");
}

// ── a process-scoped cause needs a COMPLETE pass ───────────────────────────
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  builderAnnounceable(hub, new Map([[key, 1]]), { at: NOW, isAlive: ALIVE });
  const partial = builderAnnounceable(hub, new Map(), {
    at: NOW + 60, isAlive: ALIVE, complete: false, covered: new Set() });
  check(partial.cleared.length === 0,
    "a `builder:` cause names no task, so an incomplete pass may not retire it",
    JSON.stringify(partial));
  const done = builderAnnounceable(hub, new Map(), {
    at: NOW + 120, isAlive: ALIVE, complete: true, covered: new Set() });
  check(done.cleared.includes(key),
    "and a complete pass does, because that is a positive fact about the whole pass",
    JSON.stringify(done));
}

// ── it writes, so it asks whether the hub is being replaced ────────────────
{
  const hub = freshHub();
  let noPredicate = null;
  try { builderAnnounceable(hub, new Map(), { at: NOW }); } catch (e) { noPredicate = e.kind; }
  check(noPredicate === "not_writable",
    "the announcer refuses to write without an isAlive predicate, rather than defaulting one",
    String(noPredicate));

  hub.prepare("INSERT INTO maintenance_lock(name,pid,lstart,acquired_at) VALUES('restore',?,?,?)")
    .run(4242, "L", NOW);
  let held = null;
  try { builderAnnounceable(hub, new Map([["builder:backup:failed", 1]]),
                            { at: NOW, isAlive: ALIVE }); }
  catch (e) { held = e.message; }
  check(held !== null && /restore/.test(held),
    "a LIVE restore holds the hub read-only, and the announcer refuses rather than writing into it",
    String(held));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why='builder:backup:failed'").get().c === 0,
    "control: and nothing was written while it was held");

  // A DEAD holder's lock is reaped rather than obeyed for ever, which is the
  // other half: a lock that outlives its process would stop the builder
  // permanently and look exactly like a live restore.
  const reaped = builderAnnounceable(hub, new Map([["builder:backup:failed", 1]]),
                                     { at: NOW, isAlive: DEAD });
  check(reaped.fresh.length === 1,
    "and a DEAD holder's lock is reaped rather than stopping the builder for ever",
    JSON.stringify(reaped));
  check(hub.prepare("SELECT count(*) c FROM maintenance_lock WHERE name='restore'").get().c === 0,
    "control: the stale lock is gone");
}


// ── an escalation is not a page ────────────────────────────────────────────
//
// Fail-closed is never fail-quiet, and those are two different sentences. Every
// identity stays a durable row that stops work and is read by dash and why;
// only the page list interrupts a human. Escalating everything is not the safe
// end of the trade -- it is measurably worse than the optimum, and it is
// attackable, because a channel that pushes for everything is muted within days
// and is then worse than none.
{
  check(PAGES.every(p => IDENTITY_SHAPES.includes(p)),
    "every page names a declared identity, so a page cannot fire for a situation nothing raises",
    PAGES.join(", "));

  const PAGED_KEYS = ["builder:backup:failed", "bt:7:phase:blocked:RESEARCH"];
  for (const k of PAGED_KEYS) check(pages(k), `${k} pages`, k);

  // ENUMERATED from IDENTITY_SHAPES rather than retyped, so an identity added
  // without a decision about paging shows up here as a failure and not as
  // silence.
  const asKey = (sh) => sh.replace("<id>", "7").replace("<phase>", "RESEARCH");
  const notPaged = IDENTITY_SHAPES.map(asKey).filter(k => !PAGED_KEYS.includes(k));
  check(notPaged.length === 8, `and eight do not (got ${notPaged.length})`, notPaged.join(", "));
  for (const k of notPaged) check(!pages(k), `${k} does not page`, k);

  // The templated entry matches by SHAPE. A page list of literal keys would fire
  // for exactly one task id and send every other blocked task to the digest in
  // silence.
  check(pages("bt:99:phase:blocked:SIZING") && pages("bt:1:phase:blocked:DESIGN"),
    "the templated entry pages for any task and any phase");
  check(!pages("bt:7:phase:failed:RESEARCH"),
    "control: failed is not blocked, and the two are one word apart in the shape list");
  check(!pages("bt:7:phase:blocked"),
    "control: and a shape missing its phase does not match, which a startsWith would");
}

// ── every identity is durable; only the page list is dispatched ────────────
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "test", ok: true, ref: "r1" }] }; };
  const NOW2 = 1_800_002_000;

  const esc = new Map([
    [escalationKey({ task: "bt:0A", kind: "phase:blocked", phase: "RESEARCH" }), 1],  // pages
    [escalationKey({ kind: "backup:failed" }), 1],                                    // pages
    [escalationKey({ task: "bt:0A", kind: "infeasible" }), 3],                        // digest
    [escalationKey({ task: "bt:0B", kind: "spec:reopened" }), 1],                     // digest
  ]);
  const r = announce(hub, { escalations: esc, at: NOW2, isAlive: ALIVE, send, profile: {} });

  check(hub.prepare("SELECT count(*) c FROM escalation").get().c === 4,
    "all four identities become durable rows: nothing stops being recorded",
    JSON.stringify(hub.prepare("SELECT why FROM escalation").all().map(x => x.why)));
  check(r.paged.length === 2, `two paged (got ${r.paged.length})`, JSON.stringify(r.paged));
  check(r.digested.length === 2, `and two digested (got ${r.digested.length})`, JSON.stringify(r.digested));
  check(r.declined.length === 0, "and none declined, because the sender accepted both",
    JSON.stringify(r.declined));
  check(sent.length === 2, "the sender was called exactly twice", String(sent.length));
  check(sent.every(a => /blocked|backup/.test(a.message)),
    "for the two on the page list and no others", JSON.stringify(sent.map(a => a.message)));

  // CONTROL: "not paged" must not mean "not reported". That would be fail-quiet,
  // which is the one outcome this design may not produce.
  const durable = hub.prepare("SELECT why FROM escalation").all().map(x => x.why);
  // ONE assertion over the whole set rather than one per row. A loop over a
  // RESULT costs a different number of assertions when the result changes, and a
  // run that reports fewer assertions than its control is indistinguishable from
  // one that died half way -- which is precisely the reading the stub sweep uses
  // to decide whether a measurement happened at all.
  check(r.digested.length > 0 && r.digested.every(d => durable.includes(d.why)),
    "every digested identity is in the store for dash and why to read, so not-paged " +
    "never means not-reported",
    `digested ${JSON.stringify(r.digested.map(d => d.why))} / durable ${durable.join(",")}`);
}

// ── a page that could not be delivered is neither paged nor silent ─────────
{
  const hub = freshHub();
  const NOW3 = 1_800_003_000;
  const key = escalationKey({ task: "bt:0C", kind: "phase:blocked", phase: "SIZING" });

  const refusing = () => ({ ok: false, why: "no ntfy credential on this machine" });
  const r = announce(hub, { escalations: new Map([[key, 1]]), at: NOW3, isAlive: ALIVE,
                            send: refusing });
  check(r.paged.length === 0, "a refused send is not reported as paged", JSON.stringify(r.paged));
  check(r.declined.length === 1 && r.declined[0].why === key,
    "it is DECLINED, so a page that was owed and did not go out is visible",
    JSON.stringify(r.declined));
  check(/ntfy credential/.test(r.declined[0]?.not_sent ?? ""),
    "carrying the sender's own reason rather than a generic one",
    JSON.stringify(r.declined[0] ?? null));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 1,
    "and the escalation still stands in the store, because recording never depended on the send");

  // A THROWN sender is the same fact to a reader who needs to know a human was
  // not reached, and it must not escape as an exception that loses the rest.
  const hub2 = freshHub();
  const key2 = escalationKey({ kind: "backup:failed" });
  const throwing = () => { throw new Error("osascript is not on this host"); };
  const r2 = announce(hub2, { escalations: new Map([[key2, 1]]), at: NOW3, isAlive: ALIVE,
                             send: throwing });
  check(r2.declined.length === 1 && /osascript/.test(r2.declined[0]?.not_sent ?? ""),
    "a sender that throws is declined with its message, not propagated",
    JSON.stringify(r2.declined));
  check(hub2.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key2).c === 1,
    "control: and that row stands too");

  let noSend = null;
  try { announce(hub, { escalations: new Map(), at: NOW3, isAlive: ALIVE }); }
  catch (e) { noSend = e.kind; }
  check(noSend === "not_writable",
    "announce refuses without a sender rather than defaulting one that silently succeeds",
    String(noSend));
}

// ── clearing is dispatched too, for the identities that page ───────────────
//
// An operator who is only ever told about problems cannot tell "resolved" from
// "reeve stopped looking". Computing `cleared` and never sending it implements
// half of that sentence.
{
  const hub = freshHub();
  const NOW4 = 1_800_004_000;
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [] }; };
  const paging = escalationKey({ task: "bt:0D", kind: "phase:blocked", phase: "DESIGN" });
  const quiet = escalationKey({ task: "bt:0D", kind: "infeasible" });

  announce(hub, { escalations: new Map([[paging, 1], [quiet, 1]]), at: NOW4,
                  isAlive: ALIVE, send });
  sent.length = 0;

  const r = announce(hub, { escalations: new Map(), at: NOW4 + 60, isAlive: ALIVE, send,
                            covered: new Set(["bt:0D"]) });
  check(r.cleared.includes(paging) && r.cleared.includes(quiet),
    "control: both causes cleared, because the pass examined their task", JSON.stringify(r.cleared));
  check(sent.length === 1, "exactly one clearing was dispatched", JSON.stringify(sent.map(x => x.message)));
  // OPTIONAL READS. The assertion above proves how many were sent; this one must
  // still RUN when that number is zero, or a stub that stops the dispatch kills
  // the file instead of failing this line, and the run reports fewer assertions
  // than it has.
  check(sent[0]?.kind === "cleared" && sent[0]?.message?.includes(paging) === true,
    "and it is the one on the page list, marked as a clearing rather than a new alarm",
    JSON.stringify(sent[0] ?? null));
}


// ── a reference, or a sentence saying why there is none ────────────────────
//
// This file's header has promised since it was written that nothing declines
// silently. Until now there was no way to check it: every path needed a real
// escalation and a real server, so the promise was prose. And the reference the
// promise implies was discarded before anything could read it -- `postViaCurl`
// passed `-o /dev/null`, so the response body, the only place a message id
// exists, never reached the caller.
{
  const R = readNtfyResponse;
  check(R('{"id":"abc123","time":1}\n200').ref === "ntfy:abc123",
    "the server's own id becomes the delivery reference",
    JSON.stringify(R('{"id":"abc123","time":1}\n200')));
  check(R('{"error":1}\n403').ok === false && /403/.test(R('{"error":1}\n403').why),
    "a non-2xx status is a failure carrying the code", JSON.stringify(R('{"error":1}\n403')));

  // A REFERENCE IS A BONUS, NEVER A CONDITION. Reporting a failure because the
  // body could not be parsed would invent a failure that never happened -- the
  // publish already succeeded.
  for (const [out, label] of [['not json\n200', "an unparseable body"],
                              ['\n200', "an empty body"],
                              ['{"time":1}\n201', "a body with no id"],
                              ['200', "no body at all"]]) {
    check(R(out).ok === true && R(out).ref === undefined,
      `${label} still reports delivery, without a reference`, JSON.stringify(R(out)));
  }
}

{
  const profile = { notify: { provider: "ntfy", url: "https://x", topic: "t", credentialFile: "/c" } };
  const alert = { title: "t", message: "m" };
  const call = (post) => notify({ profile, alert, readCredential: () => ":tk", post });

  const withRef = call(() => ({ ok: true, ref: "ntfy:12345" }));
  check(withRef.ok && withRef.channels[0].ref === "ntfy:12345",
    "a channel that returns a reference carries it up", JSON.stringify(withRef.channels));
  check(withRef.channels[0].ref_why === undefined,
    "and carries no reason, because there is nothing to explain", JSON.stringify(withRef.channels[0]));

  const noRef = call(() => ({ ok: true }));
  check(noRef.ok === true, "a channel that returns no reference still succeeded", JSON.stringify(noRef));
  check(noRef.channels[0].ref === null && typeof noRef.channels[0].ref_why === "string",
    "and the absent reference is null WITH a reason, never undefined",
    JSON.stringify(noRef.channels[0]));
  check(noRef.channels[0].why === undefined,
    "and `why` stays unset on a channel that did not fail, so it never has to be read " +
    "through `ok` to know which question it answered",
    JSON.stringify(noRef.channels[0]));

  const failed = call(() => ({ ok: false, why: "HTTP 403" }));
  check(failed.ok === false && failed.channels[0].why === "HTTP 403",
    "a failed channel keeps its failure reason in `why`", JSON.stringify(failed.channels[0]));
  check(failed.channels[0].ref === null && /did not succeed/.test(failed.channels[0].ref_why),
    "and says separately that a send which did not succeed has no reference",
    JSON.stringify(failed.channels[0]));

  // A MISCONFIGURED channel never reaches the sender at all, and it must still
  // answer the same two questions -- otherwise the one path that produces no
  // entry shape is the one an operator hits on their first run.
  const misconfigured = notify({ profile: { notify: { provider: "ntfy" } }, alert,
                                 readCredential: () => ":tk" });
  check(misconfigured.channels[0].ref === null &&
        typeof misconfigured.channels[0].ref_why === "string",
    "a channel refused before the send still reports a null reference with a reason",
    JSON.stringify(misconfigured.channels[0]));

  // THE INVARIANT, over every shape above: a reference or a reason, never both
  // and never neither. Stated once here so a new channel cannot introduce a
  // third answer without this going red.
  const every = [withRef, noRef, failed, misconfigured].flatMap(r => r.channels);
  check(every.length === 4, "control: four channel results to check", String(every.length));
  check(every.every(c => (c.ref === null) === (typeof c.ref_why === "string")),
    "every channel result carries a reference or a reason there is none, and exactly one of them",
    JSON.stringify(every));
}

hub.close();
guardian.close();
rmSync(dir, { recursive: true, force: true });

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
