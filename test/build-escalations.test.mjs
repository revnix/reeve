// A builder escalation key is an IDENTITY, and the failure type rides in the body.
//
// `bt:7:lease:starved` is one situation however long it has been starved;
// `bt:7:lease:starved:4200s` is a new situation every tick, and a standing cause
// that re-announces itself is how an unattended system trains its owner to
// ignore it. So the key carries only what says WHICH situation this is, and
// everything that changes while the situation does not rides in the body.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { HOLD_ESCALATION, PHASES } from "../src/build/phases.mjs";
import { openHub } from "../src/build/hubdb.mjs";
import { openHubAsGuest } from "../src/build/hubguest.mjs";
import { open as openGuardianStore } from "../src/db/ops.mjs";
import { announceable } from "../src/daemon.mjs";
import { notify, readNtfyResponse, scrub } from "../src/notify.mjs";
import {
  FAILURE_TYPES, IDENTITY_SHAPES, PAGES, escalationKey, shapeOf, body,
  assertHub, builderAnnounceable, pages, announce, subjectOf, ACTION_FOR, actionFor,
} from "../src/build/announce.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
// READING AN ELEMENT AFTER ASSERTING HOW MANY THERE ARE is how four assertions
// in this file have killed the run instead of failing it: the size assertion
// goes red, the next line indexes past the end, and the file dies with its
// remaining assertions unreported -- which is indistinguishable, to the stub
// sweep, from a run that was never a measurement. `nth` never throws, so a wrong
// size fails exactly the assertions that are about size.
// A CALL THAT MAY THROW, TURNED INTO A VALUE.
//
// Every assertion here runs under the stub sweep, which reintroduces a defect and
// expects the NAMED assertion to go red. A bare call that the stub makes throw
// kills the file instead: the run stops, and every assertion after it is
// unmeasured -- which reads exactly like passing. That has now happened three
// times in this file, each time to a newly written test, so it is closed here
// rather than wrapped again at the fourth site.
const attempt = (fn) => {
  try { return { ok: true, value: fn(), kind: null }; }
  catch (e) { return { ok: false, value: undefined, kind: e?.kind ?? "threw" }; }
};

const nth = (arr, i) => (Array.isArray(arr) ? arr[i] : undefined) ?? "";

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
// EVERY TASK AN ESCALATION NAMES EXISTS. `hub_event.task` references `task(id)`,
// so an event about a task nobody filed is refused by the database -- correctly,
// because an escalation about a task that does not exist is not a state
// production can reach. Written directly rather than through `fileTask`: what is
// under test is the announcer, and admission would drag the registry, profiles
// and territory leasing into a test about reducing a map.
const TASK_IDS = ["bt:01AA", "bt:01BB", "bt:0A", "bt:0B", "bt:0C", "bt:0D"];
const seedTasks = (db) => {
  const ins = db.prepare(`INSERT INTO task(
      id, project, repo_id, nwo_snapshot, title, phase, source_kind, source_key,
      repo_path, profile_path, profile_hash, default_branch, visibility,
      registry_version, created_at, updated_at)
    VALUES(?, 'alpha', 42, 'o/a', 'a task', 'ESCALATED', 'founder', ?, '/repo',
           '/p.json', 'ph-1', 'main', 'private', 1, ?, ?)`);
  for (const id of TASK_IDS) ins.run(id, `src-${id}`, NOW, NOW);
  return db;
};
const freshHub = () => {
  const d = join(dir, `h${++hubSeq}`);
  mkdirSync(d, { recursive: true });
  return seedTasks(openHub(join(d, "hub.db")));
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
//
// Driven through `announce` rather than the reducer, because a cause is marked
// announced only once something has actually surfaced it. That is the whole
// point of the split: the reducer says what is worth saying, delivery says what
// was said.
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [] }; };
  const key = escalationKey({ task: "bt:01AA", kind: "phase:blocked", phase: "RESEARCH" });
  const run = (count, at) => announce(hub, {
    escalations: new Map([[key, count]]), at, isAlive: ALIVE, send });

  const first = run(1, NOW);
  check(first.paged.length === 1 && first.paged[0].why === key,
    "a cause is announced when it arrives", JSON.stringify(first.paged));
  check(hub.prepare("SELECT announced_count c FROM escalation WHERE why=?").get(key).c === 1,
    "and is marked announced at that count once the send succeeded");

  const again = run(1, NOW + 60);
  check(again.paged.length === 0 && again.digested.length === 0,
    "and NOT announced again while its shape is unchanged, or the channel earns being muted",
    JSON.stringify(again));
  check(hub.prepare("SELECT last_seen_at FROM escalation WHERE why=?").get(key).last_seen_at === NOW + 60,
    "control: though the row was touched, so silence is a decision and not a skipped write");

  const changed = run(4, NOW + 120);
  check(changed.paged.length === 1 && changed.paged[0].count === 4,
    "and announced again when the count changes: one task blocked and four are different situations",
    JSON.stringify(changed.paged));
}

// ── a page the sender refused comes back ───────────────────────────────────
//
// `declined` makes an undelivered page visible in the RESULT, and a result
// scrolls past. Marking the row announced before the send meant the next pass
// saw nothing to say, so a page that was owed was owed for ever in silence.
{
  const hub = freshHub();
  const key = escalationKey({ task: "bt:0A", kind: "phase:blocked", phase: "SIZING" });
  const refuse = () => ({ ok: false, why: "no credential on this machine" });

  const first = announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send: refuse });
  check(first.declined.length === 1 && first.paged.length === 0,
    "control: the send was refused", JSON.stringify(first.declined));
  check(hub.prepare("SELECT announced_count c FROM escalation WHERE why=?").get(key).c === 0,
    "the row is NOT marked announced, because nothing was announced",
    JSON.stringify(hub.prepare("SELECT * FROM escalation WHERE why=?").get(key)));

  const sent = [];
  const accept = (a) => { sent.push(a); return { ok: true, channels: [] }; };
  const second = announce(hub, { escalations: new Map([[key, 1]]), at: NOW + 60,
                                 isAlive: ALIVE, send: accept });
  check(second.paged.length === 1,
    "so the next pass offers it again rather than treating silence as delivery",
    JSON.stringify(second));
  check(hub.prepare("SELECT announced_count c FROM escalation WHERE why=?").get(key).c === 1,
    "and only now is it marked announced");
  const third = announce(hub, { escalations: new Map([[key, 1]]), at: NOW + 120,
                                isAlive: ALIVE, send: accept });
  check(third.paged.length === 0, "control: and it goes quiet once it has actually landed",
    JSON.stringify(third));
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

  const blind = builderAnnounceable(hub, new Map(), { at: NOW + 60, isAlive: ALIVE, examined: new Set() });
  check(blind.cleared.length === 0,
    "a cause absent from a pass that did NOT examine its task is not retired", JSON.stringify(blind));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 1,
    "and the row still stands, so nothing was announced as resolved");

  const looked = builderAnnounceable(hub, new Map(), {
    at: NOW + 120, isAlive: ALIVE, examined: new Set(["bt:01BB"]) });

  // AND A PASS THAT MAKES NO CLAIM RETIRES NOTHING. `examined: null` used to
  // mean "no claim" and then clear every task cause anyway, which is the false
  // clear this block exists to prevent, arriving through the default.
  const noClaim = builderAnnounceable(hub, new Map(), { at: NOW + 180, isAlive: ALIVE });
  check(noClaim.cleared.length === 0,
    "control: and a pass that claims no coverage at all retires nothing",
    JSON.stringify(noClaim));
  check(looked.cleared.includes(key),
    "and IS retired by a pass that examined it, so clearing still works", JSON.stringify(looked));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 0,
    "control: the row is gone");
}

// ── a process failure clears only when its own subsystem says so ──────────
//
// A complete pass is not evidence about a backup: an ordinary pass runs no
// backup at all, so treating one as proof of recovery deletes the row and
// announces CLEARED while no snapshot has succeeded. The guardian holds these
// failures on `ctx` and re-emits them every tick for exactly this reason, and
// only a snapshot actually TAKEN clears one.
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  // ANNOUNCED, not merely raised. A cause nobody was told about is retired
  // without a recovery notice, so a block about WHEN a cause retires has to page
  // it first or it is measuring the undelivered path instead.
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                  send: () => ({ ok: true, channels: [{ name: "t", ok: true }] }) });
  check(subjectOf(key) === "builder:backup",
    "control: the cause is about the backup subsystem, not about the pass", subjectOf(key));

  const ordinary = builderAnnounceable(hub, new Map(), {
    at: NOW + 60, isAlive: ALIVE, examined: new Set(["bt:0A", "bt:0B"]) });
  check(ordinary.cleared.length === 0,
    "a pass that examined only tasks does not retire a backup failure",
    JSON.stringify(ordinary));

  const backupRan = builderAnnounceable(hub, new Map(), {
    at: NOW + 120, isAlive: ALIVE, examined: new Set(["builder:backup"]) });
  // CLEARABLE, NOT CLEARED. This identity pages, so its row stands until the
  // recovery has actually been delivered; the reducer says it is retirable and
  // `announce` retires it when the send lands.
  check(backupRan.clearable.includes(key) && !backupRan.cleared.includes(key),
    "and a pass in which the backup itself ran marks it retirable",
    JSON.stringify(backupRan));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 1,
    "control: and the row still stands, because nothing has been told yet");
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

  // AN UPPERCASE WORD IS NOT A PHASE. Reducing any uppercase tail let a detail
  // component masquerade as one, so a key ending in a shouted word matched the
  // blocked shape and PAGED -- reachable today through `blocked_other`, which
  // writes a caller-supplied key with no validation at all.
  for (const notAPhase of ["DETAIL", "ZZZ", "FAILED_BADLY"]) {
    check(shapeOf(`bt:7:phase:blocked:${notAPhase}`) === null,
      `bt:7:phase:blocked:${notAPhase} reduces to nothing: ${notAPhase} is not a phase`,
      String(shapeOf(`bt:7:phase:blocked:${notAPhase}`)));
    check(!pages(`bt:7:phase:blocked:${notAPhase}`), `and therefore does not page`);
  }
  // CONTROL: the check is membership of PHASES, not a hand-written deny list.
  check(PHASES.every(ph => shapeOf(`bt:7:phase:blocked:${ph}`) === "bt:<id>:phase:blocked:<phase>"),
    "control: and every real phase still reduces, so this is membership and not a blocklist",
    PHASES.join(","));
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
                            examined: new Set(["bt:0D"]) });
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


// ── reeve notify --test ────────────────────────────────────────────────────
//
// Driven through the CLI rather than through `notify`, because the library
// agreeing with itself is exactly what a green stub looks like: every defect
// this route can have is in the wiring. Nothing here sends anything -- the
// fixture configures no channel, so the send path is never entered, which is
// also the state a new operator is in on their first run.
{
  const BIN = fileURLToPath(new URL("../bin/reeve", import.meta.url));
  const home = join(dir, "cli", ".reeve");
  mkdirSync(home, { recursive: true });
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--home", home],
      { encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? "", out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

  // --test IS the command. A bare `notify` that sent something would mean a
  // half-typed command could put a message on somebody's phone.
  const bare = cli("notify", "o/r");
  check(bare.status === 2, "`reeve notify` without --test is a usage refusal, not a send",
    `rc=${bare.status} ${bare.out.slice(0, 160)}`);
  check(/--test/.test(bare.out), "and it says which flag makes it act", bare.out.slice(0, 200));

  const test = cli("notify", "--test", "o/r");
  check(test.status === 3,
    "with no channel configured the test exits DEGRADED: it ran, and the answer is that " +
    "nothing could be reached", `rc=${test.status} ${test.out.slice(0, 200)}`);
  check(/no notify channel configured/.test(test.out),
    "and says so rather than reporting success over a channel list of zero", test.out.slice(0, 200));

  const asJson = cli("notify", "--test", "--json", "o/r");
  const j = parse(asJson.stdout);
  check(j?.kind === "notify.test", "--json emits the envelope under its own kind",
    asJson.out.slice(0, 200));
  check(Array.isArray(j?.channels) && j.ok === false,
    "carrying the per-channel results a script would branch on", JSON.stringify(j?.channels));
  check(asJson.status === 3, "and the same exit status as the human rendering",
    `rc=${asJson.status}`);

  // The flag is scoped to this command. A flag whose entire meaning is "do not
  // treat this as real" is the most expensive one to accept and ignore.
  // A MALFORMED REPOSITORY IS NOT "THIS ONE". `positionals.find` scanned for the
  // first token matching the repo shape and discarded everything else, so a typo
  // matched nothing, fell through to detectNwo() and sent through whatever
  // checkout the operator happened to be standing in. For the one route that
  // sends, that is the wrong default.
  for (const bad of [["owner/repo/"], ["not-a-repo"], ["o/a", "o/b"]]) {
    const r = cli("notify", "--test", ...bad);
    check(r.status === 2,
      `notify --test ${bad.join(" ")} is refused rather than falling back to this checkout`,
      `rc=${r.status} ${r.out.slice(0, 160)}`);
  }
  check(cli("notify", "--test", "owner/repo").status === 3,
    "control: one well-formed repository is accepted and reaches the channel check");

  const elsewhere = cli("task", "list", "--test", "--json");
  check(elsewhere.status === 2 && parse(elsewhere.stdout)?.kind === "flag_not_applicable",
    "--test is refused on a command that sends nothing, rather than ignored",
    elsewhere.out.slice(0, 200));

  // DISCOVERABLE. A command absent from --help ships to nobody; the read
  // surface's own three commands shipped that way once.
  const help = cli("--help");
  check(/notify --test/.test(help.stdout),
    "and the command appears in --help, so it can be found without reading the source",
    (help.stdout.match(/.*notify.*/) ?? [""])[0]);

  // AND ITS ENTRY DOES NOT STEAL THE LINE ABOVE IT. Help is a table read by
  // position: a continuation line inserted between a command and its own
  // description reattributes that description to the wrong command, and the
  // canary's line -- the one that says it costs a real model call -- is the
  // worst one to move.
  const lines = help.stdout.split("\n");
  const canaryAt = lines.findIndex(l => /^\s{2}canary\s/.test(l));
  check(canaryAt > -1, "control: the canary entry is in the help", String(canaryAt));
  check(/real model call/.test(lines[canaryAt + 1] ?? ""),
    "the canary's cost line sits directly under the canary, not under notify",
    JSON.stringify(lines[canaryAt + 1] ?? null));
  const notifyAt = lines.findIndex(l => /^\s{2}notify\s/.test(l));
  check(notifyAt > canaryAt,
    "control: and notify is listed after it, so this is ordering and not absence",
    `canary@${canaryAt} notify@${notifyAt}`);
}

// ── the profile has to belong to the repository that was asked about ───────
//
// `loadProfile` prefers `./.ops/profile.json` over the sidecar and does not
// check whose it is, so `notify --test owner/B` run inside repository A sent
// through A's channels while titling the alert B -- reporting B's setup healthy
// without having touched it, and putting an unexpected real alert on a phone.
{
  const BIN = fileURLToPath(new URL("../bin/reeve", import.meta.url));
  const repoA = join(dir, "repoA");
  mkdirSync(join(repoA, ".ops"), { recursive: true });
  const home = join(dir, "cli2", ".reeve");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repoA, ".ops", "profile.json"), JSON.stringify({
    schemaVersion: 1, project: { kind: "product" },
    identity: { key: "owner/A", defaultBranch: "main", visibility: "private" },
    authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "committed" },
    state: { mode: "in-repo" },
    units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm" }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "enforced" },
    // A channel that CANNOT succeed: the credential path does not exist, so the
    // send is refused before any request is made. The assertion below is that
    // the mismatch is caught before this is even consulted.
    notify: { provider: "ntfy", url: "https://example.invalid", topic: "t",
              credentialFile: join(dir, "no-such-credential") },
  }) + "\n");
  const inA = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--home", home],
      { encoding: "utf8", cwd: repoA, timeout: 60_000 });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };

  const wrong = inA("notify", "--test", "owner/B");
  check(wrong.status === 2,
    "asking about another repository from inside this one is refused, not answered",
    `rc=${wrong.status} ${wrong.out.slice(0, 200)}`);
  check(/owner\/A/.test(wrong.out) && /owner\/B/.test(wrong.out),
    "and the refusal names both, so the operator can see which profile was found",
    wrong.out.slice(0, 240));

  // CONTROL: the guard is about IDENTITY, not about refusing everything. Asking
  // about the repository whose profile this is reaches the send path and reports
  // the channel's own answer.
  const right = inA("notify", "--test", "owner/A");
  check(right.status === 3,
    "control: asking about this repository reaches the channel and reports it degraded",
    `rc=${right.status} ${right.out.slice(0, 200)}`);
  check(/no credential/.test(right.out),
    "control: with the channel's own reason, so the send path really was entered",
    right.out.slice(0, 200));
}


// ── a clearing reads as a clearing on the phone ────────────────────────────
//
// `notify` renders title, message, priority and tags and nothing else, so a
// clearing distinguished only by a `kind` property arrived looking exactly like
// a fresh incident -- and its body said "(x0)", which is worse than saying
// nothing at all.
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [] }; };
  const key = escalationKey({ task: "bt:0B", kind: "phase:blocked", phase: "DESIGN" });

  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send });
  sent.length = 0;
  announce(hub, { escalations: new Map(), at: NOW + 60, isAlive: ALIVE, send,
                  examined: new Set(["bt:0B"]) });

  check(sent.length === 1, "control: one clearing was dispatched", String(sent.length));
  check(/CLEARED/.test(sent[0]?.title ?? ""),
    "the TITLE says CLEARED, which is the part a phone shows first",
    JSON.stringify(sent[0]?.title ?? null));
  check(/CLEARED/.test(sent[0]?.message ?? ""),
    "and so does the message", JSON.stringify(sent[0]?.message ?? null));
  check(!/\(0\)|x0/.test(sent[0]?.message ?? ""),
    "and it does not report a count of zero, which described nothing",
    JSON.stringify(sent[0]?.message ?? null));
}

// ── the body reaches the human ─────────────────────────────────────────────
//
// `body()` is where every changing fact goes once the key refuses it. Carrying
// it no further than the function that builds it means a backup failure pages
// with its identity and without the path or the error that says what to do.
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [] }; };
  const key = escalationKey({ kind: "backup:failed" });
  const b = body({ type: "FAILED", store: "/var/reeve/o-a.db", detail: "checksum mismatch" });

  const r = announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                            bodies: new Map([[key, b]]) });
  // THE SAME REPORT, not the same OBJECT. Reference identity was incidental and
  // is now wrong on purpose: the alert renders what was STORED, so that the first
  // page and every later one for the same cause say the same thing. Asserting
  // `=== b` would pin an implementation that reads the caller's map, which is the
  // second source this deliberately removed.
  check(r.paged.length === 1 && JSON.stringify(r.paged[0]?.body) === JSON.stringify(b),
    "the announcement carries the typed body it was given", JSON.stringify(r.paged[0]?.body));
  check(/checksum mismatch/.test(sent[0]?.message ?? "") &&
        /var\/reeve\/o-a\.db/.test(sent[0]?.message ?? ""),
    "and the detail reaches the message, which is the only part a human reads",
    JSON.stringify(sent[0]?.message ?? null));
  check(/FAILED/.test(sent[0]?.message ?? ""),
    "with the failure type, because 'it stopped' and 'it may have stopped' want different answers",
    JSON.stringify(sent[0]?.message ?? null));

  // CONTROL: a cause with no body still announces, rather than being skipped or
  // rendering the word undefined.
  const k2 = escalationKey({ task: "bt:0C", kind: "phase:blocked", phase: "SIZING" });
  const r2 = announce(hub, { escalations: new Map([[k2, 1]]), at: NOW, isAlive: ALIVE, send });
  check(r2.paged.length === 1 && !/undefined/.test(sent[1]?.message ?? "undefined"),
    "control: and a cause with no body announces without printing undefined",
    JSON.stringify(sent[1]?.message ?? null));
}

// ── every mutation is replayable ───────────────────────────────────────────
//
// `escalation` is in the replayed set and `escalation.raised` was its only
// event. A snapshot whose tail spanned a clear replayed the raise and
// resurrected the row, so an operator was paged again about something resolved
// before the restore; one spanning an announcement restored `announced_count`
// to 0 and re-sent every delivered page.
{
  const hub = freshHub();
  const sent = () => ({ ok: true, channels: [] });
  const key = escalationKey({ task: "bt:0D", kind: "phase:blocked", phase: "RESEARCH" });
  const kinds = () => hub.prepare("SELECT kind FROM hub_event ORDER BY seq").all().map(r => r.kind);

  const before = kinds().length;
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send: sent });
  const afterRaise = kinds().slice(before);
  check(afterRaise.filter(k => k === "escalation.raised").length >= 1,
    "raising an escalation appends escalation.raised", JSON.stringify(afterRaise));

  const row = hub.prepare("SELECT payload FROM hub_event WHERE kind='escalation.raised' ORDER BY seq DESC LIMIT 1").get();
  const image = JSON.parse(row.payload);
  check(image.why === key && typeof image.count === "number" &&
        typeof image.announced_count === "number",
    "carrying the ROW, not just the key, so a replay restores what it now says",
    JSON.stringify(image));

  const atClear = kinds().length;
  announce(hub, { escalations: new Map(), at: NOW + 60, isAlive: ALIVE, send: sent,
                  examined: new Set(["bt:0D"]) });
  const afterClear = kinds().slice(atClear);
  check(afterClear.includes("escalation.cleared"),
    "and clearing one appends escalation.cleared", JSON.stringify(afterClear));

  // THE HANDLER EXISTS, or the event is a row nothing reads back.
  const replaySrc = readFileSync(fileURLToPath(new URL("../src/build/replay.mjs", import.meta.url)), "utf8");
  check(/"escalation\.cleared":\s*\{[^}]*delete:\s*true/.test(replaySrc),
    "and replay handles it as a DELETE, so a restore does not resurrect the row",
    (replaySrc.match(/.*escalation\.cleared.*/) ?? [""])[0]);
  check(/"escalation\.raised":\s*\{/.test(replaySrc),
    "control: and the raise handler it sits beside is still there");
}


// ── a clearing waits for its notification too ──────────────────────────────
//
// The raise path was taught to hold `announced_count` until a send landed, and
// the clear path still deleted the row before dispatching. A channel down for a
// single pass therefore lost the recovery permanently: the next pass had no
// standing cause left to classify as cleared. The same rule belongs on both
// sides — the durable state changes when the notification lands, not before.
{
  const hub = freshHub();
  const key = escalationKey({ task: "bt:0A", kind: "phase:blocked", phase: "SIZING" });
  const ok = () => ({ ok: true, channels: [] });
  const refuse = () => ({ ok: false, why: "the channel is down" });

  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send: ok });
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 1,
    "control: the cause is standing and has been paged");

  const lost = announce(hub, { escalations: new Map(), at: NOW + 60, isAlive: ALIVE,
                               send: refuse, examined: new Set(["bt:0A"]) });
  check(lost.declined.length === 1 && lost.declined[0].kind === "cleared",
    "a clearing whose send is refused is declined", JSON.stringify(lost.declined));
  check(lost.cleared.length === 0, "and is NOT reported as cleared", JSON.stringify(lost.cleared));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 1,
    "and the row still stands, so the recovery is still owed");

  const landed = announce(hub, { escalations: new Map(), at: NOW + 120, isAlive: ALIVE,
                                 send: ok, examined: new Set(["bt:0A"]) });
  check(landed.cleared.includes(key),
    "the next pass offers it again and retires it once the send lands",
    JSON.stringify(landed.cleared));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 0,
    "control: and only now is the row gone");
}

// ── every alert says what to do about it ───────────────────────────────────
//
// An identity says what happened. A page read at night without the one command
// that changes it is a notification the reader can only file away, and a channel
// whose alerts cannot be acted on is one that gets muted.
{
  check(IDENTITY_SHAPES.every(sh => typeof ACTION_FOR[sh] === "string" && ACTION_FOR[sh].length > 0),
    "every declared identity names the single action that changes it",
    IDENTITY_SHAPES.filter(sh => !ACTION_FOR[sh]).join(", "));
  check(Object.keys(ACTION_FOR).every(k => IDENTITY_SHAPES.includes(k)),
    "and the action map names no identity that does not exist",
    Object.keys(ACTION_FOR).filter(k => !IDENTITY_SHAPES.includes(k)).join(", "));
  // THE PLACEHOLDER IS REPLACED. The shapes carry `<id>` because they are
  // shapes; an alert that says `reeve task why <id>` hands the founder a command
  // they cannot paste -- under a shell `<id>` is input redirection -- and makes
  // them reconstruct the identifier the alert is already holding.
  check(actionFor("bt:7:phase:blocked:RESEARCH") ===
        ACTION_FOR["bt:<id>:phase:blocked:<phase>"].replaceAll("<id>", "bt:7"),
    "a concrete key resolves to its shape's action with the task substituted",
    String(actionFor("bt:7:phase:blocked:RESEARCH")));
  check(!/<id>/.test(actionFor("bt:7:phase:blocked:RESEARCH")),
    "and no placeholder survives into something a founder is asked to run",
    String(actionFor("bt:7:phase:blocked:RESEARCH")));
  check(actionFor("builder:backup:failed") === ACTION_FOR["builder:backup:failed"],
    "control: a process identity has no task to substitute and is unchanged",
    String(actionFor("builder:backup:failed")));
  check(actionFor("bt:7:not:declared") === null,
    "and an undeclared key resolves to none rather than to something near it");

  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [] }; };
  const key = escalationKey({ task: "bt:0B", kind: "phase:blocked", phase: "RESEARCH" });
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send });
  check(/reeve task why/.test(sent[0]?.message ?? ""),
    "and the rendered alert carries it, which is the only place a phone shows it",
    JSON.stringify(sent[0]?.message ?? null));
}

// ── nothing leaves the machine unsanitised ─────────────────────────────────
//
// A body carries externally sourced text — CI output, a pathname, a validation
// error — and the dispatcher is the last point before it leaves. `buildAlert`
// applies `redact(printable(...))`; `notify` itself does not, so a second
// producer of alerts is a second place the boundary has to be applied.
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [] }; };
  const key = escalationKey({ kind: "backup:failed" });
  const nasty = body({ type: "FAILED",
    // A control character that forges a line, and a credential shape.
    detail: "line one\u0007\u001b[2Kforged: OK  token ghp_" + "A".repeat(24) });
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                  bodies: new Map([[key, nasty]]) });

  const msg = sent[0]?.message ?? "";
  check(msg.length > 0, "control: an alert was produced", JSON.stringify(msg.slice(0, 60)));
  check(!new RegExp("[\\u0000-\\u0008\\u000b-\\u001f]").test(msg),
    "control characters are neutralised before the message leaves",
    JSON.stringify(msg));
  check(!/ghp_A{20,}/.test(msg) && /redacted/.test(msg),
    "and a credential shape is redacted rather than sent", JSON.stringify(msg));
  // WHICH LAYER DID IT, said out loud. The body is scrubbed where it is STORED,
  // with the same SECRETS list, so the credential is already gone before an alert
  // is assembled -- `redact` here is defence in depth for this path rather than
  // the only barrier, and an assertion that cannot tell them apart would report
  // one layer's work as the other's.
  check(!/ghp_A{20,}/.test(
    hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? ""),
    "control: and it was already gone from the STORED body, which is the first layer",
    hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? null);
  // CONTROL: sanitising is not deleting. The parts that are not dangerous still
  // arrive, or an operator gets a clean message that says nothing.
  check(/line one/.test(msg) && /FAILED/.test(msg),
    "control: and the legitimate detail still arrives", JSON.stringify(msg));
}


// ── the action survives a body long enough to truncate ─────────────────────
//
// `redact` caps a message and truncates the TAIL. An action appended after an
// externally supplied body is therefore the first thing a long CI error deletes,
// producing an actionless alert for exactly the escalations whose detail is
// longest — the ones a founder most needs a next step for.
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true }] }; };
  const key = escalationKey({ task: "bt:0C", kind: "phase:blocked", phase: "RESEARCH" });
  const huge = body({ type: "FAILED", detail: "E".repeat(2000) });

  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                  bodies: new Map([[key, huge]]) });
  const msg = sent[0]?.message ?? "";
  check(/truncated/.test(msg),
    "the outbound message is capped, which is what the alert boundary still uniquely applies",
    JSON.stringify({ length: msg.length, tail: msg.slice(-40) }));
  check(msg.length < 2000,
    "control: and it is genuinely shorter than the body it carried, so the cap did the work",
    JSON.stringify({ message: msg.length, body: 2000 }));
  check(/reeve task why bt:0C/.test(msg),
    "and the action still arrives, because it is above the detail rather than after it",
    JSON.stringify(msg.slice(0, 200)));
}

// ── a page is sent as an interruption; a clearing is not ───────────────────
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true }] }; };
  const key = escalationKey({ task: "bt:0D", kind: "phase:blocked", phase: "SIZING" });

  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send });
  check(sent[0]?.priority === "high",
    "a raised page names high priority, or `notify` falls back to default and the page " +
    "list promises an interruption it does not deliver", JSON.stringify(sent[0]?.priority));

  announce(hub, { escalations: new Map(), at: NOW + 60, isAlive: ALIVE, send,
                  examined: new Set(["bt:0D"]) });
  check(sent[1]?.kind === "cleared" && sent[1]?.priority === "default",
    "and a clearing does not interrupt: there is nothing to do about a resolved cause",
    JSON.stringify({ kind: sent[1]?.kind, priority: sent[1]?.priority }));
}

// ── one channel down does not re-page the one that works ───────────────────
//
// `notify` reports ok:false when ANY configured channel fails, while the healthy
// one has already delivered. Treating that as undelivered re-pages the working
// channel on every pass until the broken one recovers, which is the alert
// fatigue the closed page list exists to prevent.
{
  const hub = freshHub();
  const sent = [];
  const partial = (a) => {
    sent.push(a);
    return { ok: false, why: "desktop: osascript is not on this host",
             channels: [{ name: "ntfy", ok: true, ref: "ntfy:1" },
                        { name: "desktop", ok: false, why: "osascript is not on this host" }] };
  };
  const key = escalationKey({ task: "bt:0A", kind: "phase:blocked", phase: "DESIGN" });

  const first = announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                                send: partial });
  check(first.paged.length === 1 && first.declined.length === 0,
    "a page one channel accepted is paged, not declined", JSON.stringify(first.declined));
  // OPTIONAL READS. The assertion above proves how many were paged; these must
  // still RUN when that number is zero, or a stub that reclassifies a partial
  // delivery kills the file instead of failing this line.
  check(first.paged[0]?.partial === true,
    "and is marked partial, so the failed channel is not hidden",
    JSON.stringify(first.paged[0]?.partial ?? null));
  check(first.paged[0]?.channels?.some(c => !c.ok) === true,
    "control: the failed channel rides on the result for a caller to read",
    JSON.stringify(first.paged[0]?.channels ?? null));
  check(hub.prepare("SELECT announced_count c FROM escalation WHERE why=?").get(key).c === 1,
    "and it is marked announced, because a human was reached");

  const second = announce(hub, { escalations: new Map([[key, 1]]), at: NOW + 60,
                                 isAlive: ALIVE, send: partial });
  check(second.paged.length === 0 && sent.length === 1,
    "so the next pass does not page the working channel again", JSON.stringify(second.paged));

  // CONTROL: nothing accepted is still a refusal, or this rule would swallow a
  // total failure as delivery.
  const hub2 = freshHub();
  const none = () => ({ ok: false, why: "every channel is down",
                        channels: [{ name: "ntfy", ok: false, why: "down" }] });
  const dead = announce(hub2, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                                send: none });
  check(dead.declined.length === 1 && dead.paged.length === 0,
    "control: a send no channel accepted is still declined", JSON.stringify(dead.declined));
  check(hub2.prepare("SELECT announced_count c FROM escalation WHERE why=?").get(key).c === 0,
    "control: and is not marked announced, so it comes back");
}


// ── the alert's own line breaks are real ───────────────────────────────────
//
// `printable` escapes every control character and a line feed is one, so
// sanitising the FINISHED message turned this surface's own separators into a
// literal backslash-n and delivered identity, action and detail as a single
// run-on line with visible escapes. The layout the action line depends on was
// destroyed by the boundary added to protect it — and an assertion that the
// action is PRESENT cannot see the difference, which is why this asserts the
// STRUCTURE instead.
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true }] }; };
  const key = escalationKey({ task: "bt:0A", kind: "phase:blocked", phase: "RESEARCH" });
  const b = body({ type: "FAILED", detail: "line one\nFORGED: everything is fine", store: "/var/x" });

  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                  bodies: new Map([[key, b]]) });
  const msg = sent[0]?.message ?? "";
  const lines = msg.split("\n");

  check(lines.length >= 3,
    "the message is rendered as separate lines, not one run-on string",
    JSON.stringify(msg));
  check(!/\\n/.test(nth(lines, 0)) && nth(lines, 0).includes(key),
    "the first line is the identity, with no escape sequence in it",
    JSON.stringify(nth(lines, 0)));
  check(nth(lines, 1).startsWith("-> ") && nth(lines, 1).includes("reeve task why bt:0A"),
    "the second is the action, on its own line where a phone shows it",
    JSON.stringify(nth(lines, 1)));

  // AND THE UNTRUSTED NEWLINE IS STILL ESCAPED. That is the property the
  // boundary exists for: our separators are real, a body's are not, so a detail
  // cannot forge a line that looks like ours.
  const forged = lines.find(l => l.startsWith("detail:"));
  check(typeof forged === "string" && /\\n/.test(forged),
    "a newline inside the body is escaped, so a detail cannot forge a line",
    JSON.stringify(forged ?? null));
  check(!lines.some(l => l.startsWith("FORGED:")),
    "control: and the forged line never becomes a line of its own",
    JSON.stringify(lines));
}

// ── no recovery notice for an incident nobody heard about ──────────────────
//
// A cause every channel declined still has `announced_count` 0. Sending its
// CLEARED notice tells the reader a situation they were never informed of has
// ended, which is worse than silence: it invites them to go looking for an alert
// that does not exist.
{
  const hub = freshHub();
  const sent = [];
  const refuse = (a) => { sent.push(a); return { ok: false, why: "the channel is down" }; };
  const accept = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true }] }; };
  const key = escalationKey({ task: "bt:0B", kind: "phase:blocked", phase: "SIZING" });

  const raised = announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                                 send: refuse });
  check(raised.declined.length === 1, "control: the page was declined by every channel",
    JSON.stringify(raised.declined));
  check(hub.prepare("SELECT announced_count c FROM escalation WHERE why=?").get(key).c === 0,
    "control: so nothing was ever announced about it");

  sent.length = 0;
  const gone = announce(hub, { escalations: new Map(), at: NOW + 60, isAlive: ALIVE,
                               send: accept, examined: new Set(["bt:0B"]) });
  check(sent.length === 0,
    "the cause is retired without a recovery notice, because none was owed",
    JSON.stringify(sent.map(x => x.title)));
  check(gone.cleared.includes(key),
    "and it IS retired, rather than standing for ever because it was never delivered",
    JSON.stringify(gone.cleared));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 0,
    "control: the row is gone");

  // CONTROL: a cause that WAS announced still gets its recovery, or this rule
  // would silence every clearing.
  const k2 = escalationKey({ task: "bt:0C", kind: "phase:blocked", phase: "DESIGN" });
  announce(hub, { escalations: new Map([[k2, 1]]), at: NOW, isAlive: ALIVE, send: accept });
  sent.length = 0;
  announce(hub, { escalations: new Map(), at: NOW + 60, isAlive: ALIVE, send: accept,
                  examined: new Set(["bt:0C"]) });
  check(sent.length === 1 && /CLEARED/.test(sent[0]?.title ?? ""),
    "control: a cause that was announced still gets its recovery",
    JSON.stringify(sent.map(x => x.title)));
}


// ── the report is durable, not just delivered ──────────────────────────────
//
// The identity is the bare cause by design; the report is what a bare key makes
// possible rather than an addition to it. Until the column existed the detail
// reached the phone and nothing else, so `task show` and `task why` could not
// recover afterwards what an alert had said — and a process-scoped cause could
// not name the repository it was about, which is what decides whose channel
// pages for it.
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true }] }; };
  const key = escalationKey({ kind: "backup:failed" });
  const b = body({ type: "FAILED", store: "/var/reeve/o-a.db", detail: "checksum mismatch" });

  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                  bodies: new Map([[key, b]]) });

  const stored = hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? null;
  check(typeof stored === "string", "the report is stored on the row, not only sent",
    JSON.stringify(stored));
  const roundTrip = attempt(() => JSON.stringify(JSON.parse(stored)));
  check(roundTrip.value === JSON.stringify(b),
    "and round-trips as the same value", JSON.stringify({ stored, threw: roundTrip.kind }));

  // IN THE ROW IMAGE, or a restore empties the column while reporting success.
  const imageRow = hub.prepare(
    "SELECT payload FROM hub_event WHERE kind='escalation.raised' ORDER BY seq DESC LIMIT 1").get();
  const image = attempt(() => JSON.parse(imageRow?.payload ?? "null")).value ?? {};
  check(image.body === stored,
    "and rides in the escalation.raised image, so a replay restores what the alert said",
    JSON.stringify(image.body));

  // THE CASE THAT MATTERS MOST: a pass that offers no bodies at all. That is
  // every cause `applyTransition` raises, which is most of them.
  sent.length = 0;
  announce(hub, { escalations: new Map([[key, 4]]), at: NOW + 60, isAlive: ALIVE, send });
  check(/checksum mismatch/.test(nth(sent, 0)?.message ?? ""),
    "a later pass with no bodies map still renders the stored report",
    JSON.stringify(nth(sent, 0)?.message ?? null));
  check(/var\/reeve\/o-a\.db/.test(nth(sent, 0)?.message ?? ""),
    "including the subject a process-scoped cause cannot put in its key",
    JSON.stringify(nth(sent, 0)?.message ?? null));

  // A LATER REPORT REPLACES AN EARLIER ONE, because the row should say what is
  // true now — but a pass that offers none leaves the stored one alone, since
  // absence of a report this pass is not evidence the report is gone.
  const b2 = body({ type: "FAILED", store: "/var/reeve/o-a.db", detail: "disk full" });
  announce(hub, { escalations: new Map([[key, 9]]), at: NOW + 120, isAlive: ALIVE, send,
                  bodies: new Map([[key, b2]]) });
  check(/disk full/.test(hub.prepare("SELECT body FROM escalation WHERE why=?").get(key).body),
    "a newer report replaces the stored one",
    hub.prepare("SELECT body FROM escalation WHERE why=?").get(key).body);
  announce(hub, { escalations: new Map([[key, 11]]), at: NOW + 180, isAlive: ALIVE, send });
  check(/disk full/.test(hub.prepare("SELECT body FROM escalation WHERE why=?").get(key).body),
    "control: and a pass offering none does not erase it",
    hub.prepare("SELECT body FROM escalation WHERE why=?").get(key).body);

  // A KEY MAPPED TO NOTHING IS NOT AN OFFER, and the two sides of this seam once
  // disagreed about that. The persist side asked whether the body serialised to
  // null and kept the stored one; the alert side asked `bodies.has(why)`, which
  // is true for a key mapped to `undefined`. So the row kept its report and the
  // alert paged bare -- the exact loss the column exists to prevent, reached by
  // the ordinary way of building this map, where one item simply has no body:
  //
  //     new Map(items.map(i => [i.why, i.body]))
  sent.length = 0;
  announce(hub, { escalations: new Map([[key, 13]]), at: NOW + 240, isAlive: ALIVE, send,
                  bodies: new Map([[key, undefined]]) });
  check(/disk full/.test(nth(sent, 0)?.message ?? ""),
    "a key mapped to nothing is not an offer, so the alert still renders the stored report",
    JSON.stringify(nth(sent, 0)?.message ?? null));
  check(/disk full/.test(hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? ""),
    "control: and the row keeps it too, so both sides read that absence the same way",
    hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? null);
}

// ── a body that cannot be stored is refused by name ────────────────────────
//
// The column carries a `json_valid` CHECK, so an unserialisable body would fail
// at the write with a message naming a constraint rather than the caller's
// mistake — and the report, which exists precisely because the key refuses
// detail, would be lost at the moment it mattered.
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  const cyclic = { type: "FAILED" }; cyclic.self = cyclic;
  let kind = null;
  try {
    announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                    send: () => ({ ok: true, channels: [] }), bodies: new Map([[key, cyclic]]) });
  } catch (e) { kind = e.kind ?? "threw"; }
  check(kind === "escalation_body_shape",
    "a body that cannot serialise is refused with its own kind, not a constraint error",
    String(kind));

  // CONTROL: the refusal is about serialisability, not about bodies. A plain one
  // is stored.
  const ok = body({ type: "FAILED", detail: "fine" });
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                  send: () => ({ ok: true, channels: [] }), bodies: new Map([[key, ok]]) });
  check(/fine/.test(hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? ""),
    "control: a serialisable body is stored");

  // AND THE DATABASE REFUSES NONSENSE INDEPENDENTLY, so the guard above is a
  // better error rather than the only one.
  let dbRefused = false;
  try {
    hub.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count,body)
                 VALUES('bt:zz:infeasible',1,1,1,0,'not json')`).run();
  } catch { dbRefused = true; }
  check(dbRefused, "control: the column's own CHECK refuses a body that is not JSON");

  // AND A BODY THAT IS NOT AN OBJECT, refused for the same reason and by the
  // same name. The alert renders a body by walking its entries, so a string
  // pages one line per letter, an array pages its indices, and a number pages
  // NOTHING -- which loses the report while every other signal says the alert
  // was delivered. Each of these serialises and each satisfies `json_valid`, so
  // this refusal is the only thing standing between them and a rendered alert.
  for (const [what, value] of [["a string", "checksum mismatch"],
                               ["an array", ["a", "b"]],
                               ["a number", 42]]) {
    let k = null;
    try {
      announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                      send: () => ({ ok: true, channels: [] }), bodies: new Map([[key, value]]) });
    } catch (e) { k = e.kind ?? "threw"; }
    check(k === "escalation_body_shape",
      `${what} is refused as a body, not rendered as one`, String(k));
  }

  // AND A BODY WHOSE `toJSON` REPLACES IT, which is the case a check on the
  // INPUT cannot see. A `Date` is an object and is not an array, so it passes any
  // test of the value handed in -- then `JSON.stringify` asks its `toJSON`, gets
  // a STRING, and stores that. The alert renders no detail, because
  // `Object.entries(new Date())` is empty; the next pass parses the stored scalar
  // back, finds it unrenderable, and drops it. The report is lost with every
  // other signal reporting success, which is the single outcome this column
  // exists to prevent. So the check is on what is STORED, not on what was passed.
  {
    let k = null;
    try {
      announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                      send: () => ({ ok: true, channels: [] }),
                      bodies: new Map([[key, new Date(NOW)]]) });
    } catch (e) { k = e.kind ?? "threw"; }
    check(k === "escalation_body_shape",
      "a body whose toJSON returns a scalar is refused, though the body itself is an object",
      String(k));

    // CONTROL: an object that merely HAS a toJSON is fine when it returns one, so
    // the refusal is about the produced shape rather than about the method.
    const shaped = { type: "FAILED", detail: "x", toJSON() { return { type: "FAILED", detail: "x" }; } };
    announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                    send: () => ({ ok: true, channels: [] }), bodies: new Map([[key, shaped]]) });
    check(/"detail":"x"/.test(hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? ""),
      "control: a toJSON that returns an object is stored, so this is about the shape produced",
      hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? null);
  }

// ── the report that is stored is the whole report the caller supplied ───────
//
// `JSON.stringify` DROPS an undefined, a function and a symbol from an object
// without a word, and turns a non-finite number into null. So a body could
// serialise cleanly, pass every shape check, be stored and be marked DELIVERED
// while quietly missing a fact the caller put in it. Serialising without error is
// not proof that the whole report survived.
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  const send = () => ({ ok: true, channels: [{ name: "t", ok: true }] });
  for (const [what, detail] of [["undefined", undefined],
                                ["a function", () => 1],
                                ["a symbol", Symbol("s")],
                                ["Infinity", Infinity],
                                ["NaN", NaN]]) {
    let k = null;
    try {
      announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                      bodies: new Map([[key, { type: "FAILED", detail }]]) });
    } catch (e) { k = e.kind ?? "threw"; }
    check(k === "escalation_body_value",
      `a detail of ${what} is refused rather than silently dropped from the report`, String(k));
  }
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 0,
    "control: none of them was stored, so the refusal precedes the write",
    JSON.stringify(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key)));

  // CONTROL: the values JSON carries faithfully are still accepted, so this
  // refuses what would be LOST rather than refusing richness.
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                  bodies: new Map([[key, { type: "FAILED", n: 0, ok: false, s: "x",
                                           nested: { a: [1, "b", null] } }]]) });
  const kept = JSON.parse(hub.prepare("SELECT body FROM escalation WHERE why=?").get(key).body);
  check(kept.n === 0 && kept.ok === false && kept.nested.a.length === 3,
    "control: numbers, booleans, nulls and nested arrays all survive intact",
    JSON.stringify(kept));

  // A VALUE REFERENCED TWICE IS NOT A CYCLE. The walk carries a set to detect
  // circularity, and a set that only ever grows refuses `{ x: shared, y: shared }`
  // -- ordinary JSON, which stringify serialises perfectly by writing it twice.
  // The set therefore tracks the PATH from the root and is unwound on the way out.
  // A BOXED PRIMITIVE DOES NOT SERIALISE AS THE VALUE IT WRAPS -- `new Number(5)`
  // walks as an ordinary object and stores as {}, `new String("abc")` as a map of
  // character indices. Refused rather than emulated: nobody puts one in a report
  // on purpose, and quietly storing 5 for it would be inventing the caller's
  // intent from a mistake.
  for (const [what, value] of [["a boxed Number", new Number(5)],
                               ["a boxed String", new String("abc")],
                               ["a boxed Boolean", new Boolean(true)]]) {
    let k = null;
    try {
      announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                      bodies: new Map([[key, { type: "FAILED", v: value }]]) });
    } catch (e) { k = e.kind ?? "threw"; }
    check(k === "escalation_body_value",
      `${what} is refused rather than stored as something else`, String(k));
  }

  // AN OWN `__proto__` KEY, which `JSON.parse` produces and an ordinary object
  // cannot hold: assigning it invokes the legacy prototype setter, so the field
  // is silently absent from the stored report while plain serialisation keeps it.
  const withProto = JSON.parse('{"type":"FAILED","__proto__":{"a":1},"d":"kept"}');
  check(Object.hasOwn(withProto, "__proto__"),
    "control: the fixture really carries __proto__ as an OWN key, which only JSON.parse makes",
    JSON.stringify(Object.keys(withProto)));
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                  bodies: new Map([[key, withProto]]) });
  const protoRow = hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? "";
  check(protoRow === JSON.stringify(withProto),
    "an own __proto__ key survives, exactly as plain JSON.stringify keeps it",
    JSON.stringify({ stored: protoRow, plain: JSON.stringify(withProto) }));

  // A `toJSON` PROPERTY IS THE HOOK, NOT A DETAIL. The serialiser calls it and
  // then omits it, so refusing every function rejected a body that stringifies
  // perfectly -- and the refusal was for a value nothing would have lost.
  const selfy = { type: "FAILED", detail: "kept", toJSON() { return this; } };
  const selfyRun = attempt(() => announce(hub, { escalations: new Map([[key, 1]]), at: NOW,
                                                 isAlive: ALIVE, send,
                                                 bodies: new Map([[key, selfy]]) }));
  check(selfyRun.ok &&
        (hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? "") === JSON.stringify(selfy),
    "a self-returning toJSON is stored exactly as plain JSON.stringify stores it",
    JSON.stringify({ refused: selfyRun.kind,
                     stored: hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body,
                     native: JSON.stringify(selfy) }));
  // CONTROL: a function that is a real DETAIL is still refused, so the exemption
  // is the hook and not functions in general.
  {
    let k = null;
    try {
      announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                      bodies: new Map([[key, { type: "FAILED", detail: () => 1 }]]) });
    } catch (e) { k = e.kind ?? "threw"; }
    check(k === "escalation_body_value",
      "control: a function as an ordinary detail is still refused, so this exempts the hook alone",
      String(k));
  }

  const shared = { a: 1 };
  let sharedRefused = null;
  try {
    announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                    bodies: new Map([[key, { type: "FAILED", x: shared, y: shared }]]) });
  } catch (e) { sharedRefused = e.kind ?? "threw"; }
  const twiceRow = hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? "null";
  const twice = JSON.parse(twiceRow);
  check(sharedRefused === null && twice?.x?.a === 1 && twice?.y?.a === 1,
    "a value referenced twice as siblings is stored twice, not refused as circular",
    JSON.stringify({ refused: sharedRefused, stored: twice }));
}

// ── the ceiling is measured in the unit it promises ─────────────────────────
//
// `String.length` counts UTF-16 code units. The cap and the message both say
// BYTES, and the two diverge most where it matters: about 4000 CJK characters
// measure as 4000 and occupy roughly 12KB, so a body three times over the ceiling
// passed the check whose entire purpose is bounding what gets written.
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  const wide = "漢".repeat(2000);            // 2000 UTF-16 units, 6000 UTF-8 bytes
  check(wide.length < 4096 && Buffer.byteLength(wide, "utf8") > 4096,
    "control: the fixture is inside the cap by code units and outside it by bytes",
    JSON.stringify({ units: wide.length, bytes: Buffer.byteLength(wide, "utf8") }));
  let k = null;
  try {
    announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                    send: () => ({ ok: true, channels: [] }),
                    bodies: new Map([[key, { type: "FAILED", detail: wide }]]) });
  } catch (e) { k = e.kind ?? "threw"; }
  check(k === "escalation_body_too_large",
    "a body measured in bytes is refused though its code-unit count is inside the cap", String(k));
}

// ── a scrubbed key never displaces another field ────────────────────────────
//
// Two credential-shaped keys reduce to the SAME replacement, and building the
// object in one pass keeps only the last -- dropping a field from a report that
// was otherwise entirely valid. Losing a fact to the guard protecting it is the
// failure this column exists to prevent.
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  const A = "ghp_" + "A".repeat(24), B = "ghp_" + "B".repeat(24);
  check(scrub(`k${A}`) === scrub(`k${B}`),
    "control: the two keys really do scrub to one name, so a collision is possible",
    JSON.stringify([scrub(`k${A}`), scrub(`k${B}`)]));
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                  send: () => ({ ok: true, channels: [{ name: "t", ok: true }] }),
                  bodies: new Map([[key, { type: "FAILED", [`k${A}`]: "first", [`k${B}`]: "second" }]]) });
  const storedRow = hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? null;
  const stored = attempt(() => JSON.parse(storedRow)).value;
  const values = Object.values(stored ?? {}).filter(v => v === "first" || v === "second");
  check(values.length === 2,
    "both values survive a key collision, under distinct names", JSON.stringify(storedRow));
}

// ── toJSON is the SERIALISER's to call, and it calls it once ────────────────
//
// `JSON.stringify` hands `toJSON` the property name -- "" at the root. Calling it
// with no argument is a different call, so an implementation branching on `key`
// would persist something other than what stringify would have produced, and the
// scrub would have changed the report's MEANING rather than only its credentials.
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  const MARK = "root-" + Math.random().toString(36).slice(2, 8);
  const keyed = { toJSON(k) { return k === "" ? { type: "FAILED", detail: MARK }
                                              : { type: "FAILED", detail: "fallback" }; } };
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                  send: () => ({ ok: true, channels: [{ name: "t", ok: true }] }),
                  bodies: new Map([[key, keyed]]) });
  check((hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? "").includes(MARK),
    "a toJSON that reads its key gets the root key, as JSON.stringify would give it",
    hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? null);
  check(JSON.stringify(keyed).includes(MARK),
    "control: and that is exactly what plain JSON.stringify produces for it",
    JSON.stringify(keyed));
}

// ── the vocabulary is enforced where every body passes, not only in body() ──
//
// `body()` checked the failure type; `announce` took the `bodies` map as given.
// A caller building that map directly -- which the exported signature invites --
// bypassed the vocabulary, and the value was persisted AND marked delivered while
// producing an alert carrying no type and no detail. A rule only a convenience
// constructor applies is a suggestion.
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  const send = () => ({ ok: true, channels: [{ name: "t", ok: true }] });
  for (const [what, value] of [["an empty object", {}],
                               ["an Error, which serialises to {}", new Error("boom")],
                               ["a type outside the vocabulary", { type: "UNKNOWN_VALUE", detail: "x" }],
                               ["a type of the wrong case", { type: "failed", detail: "x" }]]) {
    let k = null;
    try {
      announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                      bodies: new Map([[key, value]]) });
    } catch (e) { k = e.kind ?? "threw"; }
    check(k === "escalation_body_type",
      `${what} is refused at the announce boundary, not only by body()`, String(k));
  }
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 0,
    "control: and none of them was persisted, so the refusal precedes the write",
    JSON.stringify(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key)));

  // CONTROL: every type the vocabulary DOES name is accepted, so this bounds the
  // vocabulary rather than the field.
  for (const t of FAILURE_TYPES) {
    const h = freshHub();
    announce(h, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                  bodies: new Map([[key, { type: t, detail: "d" }]]) });
    check(/"type"/.test(h.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? ""),
      `control: ${t} is accepted, so the check names a vocabulary and not a single value`,
      h.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? null);
  }
}

// ── a credential never becomes durable ──────────────────────────────────────
//
// `redact` runs on the RENDERED alert, which is the last point before text
// leaves the machine. The body goes somewhere else entirely: `escalation.body`
// and the `escalation.raised` payload, both of which outlive the alert, ride
// into every snapshot, appear in exported event tails, and survive the row being
// cleared. A token echoed by a failing CI command was therefore absent from the
// page and present verbatim, for ever, in the authority store.
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0";
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                  send: () => ({ ok: true, channels: [{ name: "t", ok: true }] }),
                  bodies: new Map([[key, body({ type: "FAILED", detail: `push failed: ${TOKEN}` })]]) });

  const stored = hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? "";
  check(!stored.includes(TOKEN), "a credential is scrubbed from the STORED report", stored);
  check(/redacted token/.test(stored),
    "control: and the scrub actually ran, rather than the fixture carrying no token",
    stored);

  // THE ROW IMAGE TOO, which is the copy a restore replays and an export ships.
  const image = hub.prepare(
    "SELECT payload FROM hub_event WHERE kind='escalation.raised' ORDER BY seq DESC LIMIT 1").get().payload;
  check(!image.includes(TOKEN),
    "and from the replayed row image, which outlives the escalation row itself", image);

  // KEYS AS WELL AS VALUES: a report built from external names can carry one in
  // either half, and scrubbing only values leaves the other in place.
  const hub2 = freshHub();
  announce(hub2, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                   send: () => ({ ok: true, channels: [{ name: "t", ok: true }] }),
                   bodies: new Map([[key, { type: "FAILED", [`saw ${TOKEN}`]: "yes" }]]) });
  check(!(hub2.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? "").includes(TOKEN),
    "including one that arrives as a KEY rather than as a value",
    hub2.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? null);
}

// ── a report is a report, not a log ─────────────────────────────────────────
//
// Every pass over a standing cause re-appends the row image to `hub_event`,
// which is append-only and is the authority store -- so an unbounded body is an
// unbounded WRITE RATE, not merely a large row. Refused rather than truncated:
// cutting a report in half loses the detail exactly where it was needed and
// reports success.
{
  const hub = freshHub();
  const key = escalationKey({ kind: "backup:failed" });
  let kind = null;
  try {
    announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                    send: () => ({ ok: true, channels: [] }),
                    bodies: new Map([[key, body({ type: "FAILED", detail: "x".repeat(9000) })]]) });
  } catch (e) { kind = e.kind ?? "threw"; }
  check(kind === "escalation_body_too_large",
    "an oversized report is refused by its own name, not silently cut down", String(kind));
  check(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key).c === 0,
    "control: and nothing was written, so the refusal is before the row rather than after",
    JSON.stringify(hub.prepare("SELECT count(*) c FROM escalation WHERE why=?").get(key)));

  // CONTROL: an ordinary report is nowhere near the ceiling, so this bounds a
  // producer that is misusing the field rather than one that is using it.
  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE,
                  send: () => ({ ok: true, channels: [] }),
                  bodies: new Map([[key, body({ type: "FAILED", store: "/var/reeve/o-a.db",
                                                detail: "checksum mismatch" })]]) });
  check((hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? "").length < 200,
    "control: a real report is two orders of magnitude inside the ceiling",
    String((hub.prepare("SELECT body FROM escalation WHERE why=?").get(key)?.body ?? "").length));
}

// ── the alert says what the row says ────────────────────────────────────────
//
// THE CASE THE EARLIER CONTROL COULD NOT REACH. It used a `toJSON` returning the
// SAME shape as its object, so it could not tell a body read from the caller's
// map from one read back out of the row. A `toJSON` that returns something the
// object does not have separates them: the row stores the useful report, and the
// object itself has no enumerable properties at all -- so the FIRST page rendered
// nothing while every LATER page for the same cause, read from the row, carried
// the detail. One cause, two different alerts.
{
  const hub = freshHub();
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true }] }; };
  const key = escalationKey({ kind: "backup:failed" });
  const DETAIL = ["disk", "full"].join("-") + "-" + Math.random().toString(36).slice(2, 8);
  const TYPE = "FAILED";
  const hidden = { toJSON() { return { type: TYPE, detail: DETAIL }; } };
  check(JSON.stringify(Object.keys(hidden)) === JSON.stringify(["toJSON"]),
    "control: walking the object's own entries yields only `toJSON` -- not the report",
    JSON.stringify(Object.keys(hidden)));
  check(!Object.keys(hidden).includes("detail") && "detail" in hidden.toJSON(),
    "control: so the detail exists ONLY in what toJSON produces, which is what makes the two sources differ",
    JSON.stringify({ own: Object.keys(hidden), produced: Object.keys(hidden.toJSON()) }));

  announce(hub, { escalations: new Map([[key, 1]]), at: NOW, isAlive: ALIVE, send,
                  bodies: new Map([[key, hidden]]) });
  check((nth(sent, 0)?.message ?? "").includes(DETAIL),
    "the FIRST alert renders what was stored, not the object it was handed",
    JSON.stringify(nth(sent, 0)?.message ?? null));
  check(/\[FAILED\]/.test(nth(sent, 0)?.message ?? ""),
    "including the failure type, which the handed object also does not carry",
    JSON.stringify(nth(sent, 0)?.message ?? null));

  // AND THE LATER PAGE AGREES WITH IT, which is the property that was broken:
  // the two alerts came from two different sources for one value.
  sent.length = 0;
  announce(hub, { escalations: new Map([[key, 7]]), at: NOW + 60, isAlive: ALIVE, send });
  check((nth(sent, 0)?.message ?? "").includes(DETAIL),
    "and a later page for the same cause says the same thing",
    JSON.stringify(nth(sent, 0)?.message ?? null));
}
}

hub.close();
guardian.close();
rmSync(dir, { recursive: true, force: true });

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
