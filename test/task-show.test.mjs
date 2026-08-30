// The task read model: six waiting substates DERIVED from rows, absence rendered
// as absence, and one envelope both renderers agree on.
//
// The test of "derived" is NOT that the code performs no UPDATE. It is that an
// input living OUTSIDE the hub changes the answer while the hub stays
// byte-identical. A substate computed once at filing and stored would survive the
// switch that justified it being turned off, and the operator would be told a
// worker is coming for a task nothing can dispatch.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lstatSync } from "node:fs";

import { openHub } from "../src/build/hubdb.mjs";
import { fileTask } from "../src/build/taskfile.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { CAPABILITY_NAMES, capabilitiesFrom } from "../src/build/capabilities.mjs";
import {
  READ_FORMAT_VERSION, WAITING, NEEDS_SWITCH, UNKNOWN, envelope,
  switchesFrom, switchesResolver, builderRunRef, isRunRefOf,
  waitingFor, evidenceFor, taskShow, taskList, renderShow, renderList,
} from "../src/build/show.mjs";
import { whyModel, renderWhy, SECTIONS } from "../src/build/why.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-taskshow-"));

const NOW = 1_800_000_000;

// ── the fixture is built by CALLING THE PRODUCER ─────────────────────────────
//
// `fileTask` writes the `task`, `task_territory` and `territory_lease` rows this
// module reads. A hand-built row is a fixture describing a system that does not
// exist: it can be richer, poorer, or simply different from what admission
// writes, and then it cannot exhibit the defect it was written for. Phases and
// the auxiliary tables ARE written directly, because the dispatcher that writes
// them is not merged -- and each such write is paired below with a control that
// the read is live rather than hard-coded.
const HOME = join(dir, ".reeve");                  // literally `.reeve`, or init's tests fail spuriously
const repo = join(HOME, "repo");
for (const d of ["x", "y", "g", "b", "f", "u"])
  mkdirSync(join(repo, "packages", d), { recursive: true });
mkdirSync(join(HOME, "state"), { recursive: true });

// Two projects, so a switch map applied to the whole list rather than per project
// is a thing this file can SEE. With one project the two designs are identical.
const profileFor = (key, caps) => ({ identity: { key }, builder: { capabilities: caps } });
const pathA = join(repo, "profile-a.json");
const pathB = join(repo, "profile-b.json");
const writeProfiles = (aCaps, bCaps) => {
  writeFileSync(pathA, JSON.stringify(profileFor("o/a", aCaps)) + "\n");
  writeFileSync(pathB, JSON.stringify(profileFor("o/b", bCaps)) + "\n");
};
const ALL_ON = Object.fromEntries(CAPABILITY_NAMES.map(n => [n, true]));
writeProfiles(ALL_ON, ALL_ON);

writeFileSync(join(HOME, "projects.json"), JSON.stringify({
  alpha: { nwo: "o/a", repoPath: repo, profilePath: pathA },
  beta:  { nwo: "o/b", repoPath: repo, profilePath: pathB },
}) + "\n");

const entries = {
  alpha: { nwo: "o/a", repoPath: repo, profilePath: pathA },
  beta:  { nwo: "o/b", repoPath: repo, profilePath: pathB },
};
const readProfile = (p) => JSON.parse(readFileSync(p, "utf8"));
// A fresh resolver per call: it MEMOISES, which is the point, so a test that
// changes a profile on disk must not read a cached answer from before the change.
const resolver = () => switchesResolver(entries, readProfile);

const registry = { version: 1, projects: entries };
const io = {
  lstat: (p) => lstatSync(p), lsTree: () => null,
  repoId: async () => 42, profileHash: async () => "ph-1",
  defaultBranch: async () => "main", visibility: async () => "private",
  specRepoId: async () => 77, gateDefinitionHash: async () => "gd-1",
  founderUserId: async () => 9,
};

const db = openHub(join(HOME, "state", "hub.db"));
const file = async (over) => fileTask({
  db, registry, project: "alpha", title: "a scout task", territory: ["packages/x"],
  io, isAlive: isSameProcess, pid: process.pid, lstart: readStart(process.pid), ...over,
});
const setPhase = (id, phase) => db.prepare("UPDATE task SET phase = ? WHERE id = ?").run(phase, id);

// ── CONTROL: the fixture's producer actually admits ──────────────────────────
//
// Without this every assertion below could be measuring an empty database. A
// refusal is the easiest thing in this file to produce by accident.
const filed = {};
{
  // Every filing is checked, not only the first: a refusal is the easiest thing
  // in this file to produce by accident (two claims that overlap, a near twin),
  // and an undefined id read out of a refused filing binds as null and reports
  // the FIRST row of nothing at all.
  const admit = async (key, over) => {
    const r = await file(over);
    check(r?.ok === true && typeof r.task === "string",
      `control: the producer admitted the ${key} task`, JSON.stringify(r)?.slice(0, 240));
    filed[key] = r.task;
  };
  await admit("cap",   { title: "the capability task", territory: ["packages/x"] });
  await admit("quota", { title: "the quota task",      territory: ["packages/y"] });
  await admit("gate",  { title: "the gate task",       territory: ["packages/g"] });
  await admit("both",  { title: "two waits at once",   territory: ["packages/b"] });
  await admit("beta",  { title: "a task in another project", project: "beta",
                         territory: ["packages/x"] });
  check(Object.values(filed).every(Boolean) && new Set(Object.values(filed)).size === 5,
    "control: five distinct tasks were admitted", JSON.stringify(filed));
  check(db.prepare("SELECT count(*) c FROM task").get().c === 5,
    "control: and the task table holds exactly those five",
    String(db.prepare("SELECT count(*) c FROM task").get().c));
}

// ── the closed sets, and the map that decides CAPABILITY ─────────────────────
{
  check(WAITING.length === 6, `there are exactly six waiting substates, not ${WAITING.length}`, WAITING.join(","));
  check(WAITING.every(w => /^WAITING_FOR_[A-Z]+$/.test(w)), "each is a bare identity", WAITING.join(","));
  check(new Set(WAITING).size === WAITING.length, "and no substate is named twice", WAITING.join(","));
  check(Object.isFrozen(WAITING) && Object.isFrozen(NEEDS_SWITCH), "and neither set can be widened at runtime");
  check(NEEDS_SWITCH.FILED === "observe" && NEEDS_SWITCH.SPEC_DRAFT === "draftSpec",
    "S3's phases need observe and SPEC_DRAFT needs draftSpec", JSON.stringify(NEEDS_SWITCH));
  check(NEEDS_SWITCH.DONE === undefined && NEEDS_SWITCH.BLOCKED === undefined,
    "a terminal or held phase needs no switch: nothing is going to dispatch it",
    JSON.stringify(Object.keys(NEEDS_SWITCH)));

  // Every name in the table is one the profile schema declares. The module
  // throws on import if this is false, so this assertion records the property
  // rather than discovering it -- but it records it against CAPABILITY_NAMES,
  // which is derived from the schema, not against a list retyped here.
  const undeclared = [...new Set(Object.values(NEEDS_SWITCH))].filter(n => !CAPABILITY_NAMES.includes(n));
  check(undeclared.length === 0, "every switch NEEDS_SWITCH names is one the schema declares",
    `undeclared: ${undeclared.join(",")} / declared: ${CAPABILITY_NAMES.join(",")}`);
  check(CAPABILITY_NAMES.length >= 5,
    `control: the schema declares ${CAPABILITY_NAMES.length} switches, so the check above had something to check`,
    CAPABILITY_NAMES.join(","));
}

// ── the switch map is the one shape a bare-name lookup can read ──────────────
//
// This is the defect that would otherwise be invisible. `capabilitiesFrom` is
// keyed by FULL DOTTED STRINGS and omits any switch the profile never declared,
// because `leaseEffect` needs to tell "off" from "never set". Handing that map to
// a bare-name lookup yields undefined for every switch, every gate reads
// `!== true`, and a fully enabled task renders as WAITING_FOR_CAPABILITY -- with
// nothing going red anywhere.
{
  const profile = profileFor("o/a", ALL_ON);
  const dotted = capabilitiesFrom(profile);
  check(Object.keys(dotted).every(k => k.startsWith("builder.capabilities.")),
    "control: capabilitiesFrom really does return dotted keys", JSON.stringify(Object.keys(dotted)));

  const bare = switchesFrom(profile);
  check(CAPABILITY_NAMES.every(n => bare[n] === true),
    "switchesFrom returns every declared switch under its BARE name", JSON.stringify(bare));

  // A profile declaring NOTHING: capabilitiesFrom preserves the absence and
  // returns {}, switchesFrom fills every declared switch with false. Both are
  // right for their own caller, and that is exactly why one cannot be used as
  // the other.
  const silent = switchesFrom({ builder: {} });
  check(Object.keys(capabilitiesFrom({ builder: {} })).length === 0,
    "control: capabilitiesFrom returns {} for a profile that declares no switch");
  check(CAPABILITY_NAMES.every(n => silent[n] === false),
    "while switchesFrom answers false for every one of them", JSON.stringify(silent));

  // And the wrong map is REFUSED rather than answered. A caller that passes the
  // dotted map gets a throw naming the fix, not a task reported as blocked.
  const row = { phase: "FILED" };
  const ev = { holds: [], notices: [], gateRequests: [], codexClean: [], queued: null, switches: dotted };
  let threw = null;
  try { waitingFor(row, ev); } catch (e) { threw = e.message; }
  check(threw !== null && /switchesFrom/.test(threw),
    "a dotted-key map is refused by name, not silently read as every switch off", String(threw));
}

// ── WAITING_FOR_CAPABILITY is derived: the switch moves, the hub does not ────
{
  const before = db.prepare("SELECT count(*) c FROM hub_event").get().c;
  const bytesBefore = readFileSync(join(HOME, "state", "hub.db"));

  const on = taskShow(db, filed.cap, { now: NOW, switchesFor: resolver() });
  check(on.phase === "FILED", "control: the filed task is in FILED", on.phase);
  check(!on.waiting.all.includes("WAITING_FOR_CAPABILITY"),
    "control: with observe on, a FILED task is not waiting for a capability", JSON.stringify(on.waiting));

  writeProfiles({ ...ALL_ON, observe: false }, ALL_ON);
  const off = taskShow(db, filed.cap, { now: NOW, switchesFor: resolver() });
  check(off.waiting.first === "WAITING_FOR_CAPABILITY",
    "turning observe off makes the same row read WAITING_FOR_CAPABILITY", JSON.stringify(off.waiting));
  check(off.waiting.capability === "observe",
    "and it names WHICH switch, because five of them exist", JSON.stringify(off.waiting));

  const after = db.prepare("SELECT count(*) c FROM hub_event").get().c;
  check(before === after, "and neither call appended a hub_event", `${before} -> ${after}`);
  check(Buffer.compare(bytesBefore, readFileSync(join(HOME, "state", "hub.db"))) === 0,
    "and the hub file is byte-identical across both reads: the answer moved, the store did not");
  check(db.prepare("SELECT phase FROM task WHERE id = ?").get(filed.cap).phase === "FILED",
    "and the phase column is untouched: a substate is never stored as a phase");

  writeProfiles(ALL_ON, ALL_ON);
}

// ── the switches are PER PROJECT, not one map for the whole list ─────────────
//
// The tasks span two projects with two profiles. One map applied to the list
// would report alpha's switches under beta's name, for a value whose entire job
// is to say why a particular task is not moving.
{
  writeProfiles({ ...ALL_ON, observe: false }, ALL_ON);
  const rows = taskList(db, { now: NOW, switchesFor: resolver() });
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  check(byId[filed.cap].waiting.all.includes("WAITING_FOR_CAPABILITY"),
    "a task in the project whose observe is OFF waits for the capability",
    JSON.stringify(byId[filed.cap].waiting));
  check(!byId[filed.beta].waiting.all.includes("WAITING_FOR_CAPABILITY"),
    "while a task in the project whose observe is ON, in the same listing, does not",
    JSON.stringify(byId[filed.beta].waiting));
  check(byId[filed.cap].project === "alpha" && byId[filed.beta].project === "beta",
    "control: the two rows really are in different projects",
    `${byId[filed.cap].project} / ${byId[filed.beta].project}`);

  // A project whose switches cannot be read at all is UNKNOWN, and never `off`.
  // Answering "the switch is off" for a question that was never asked is the
  // collapse this whole module refuses.
  const blind = taskShow(db, filed.cap, { now: NOW, switchesFor: switchesResolver({}, readProfile) });
  check(blind.waiting.capability_known === false,
    "a project whose profile cannot be read reports the capability as UNKNOWN", JSON.stringify(blind.waiting));
  check(!blind.waiting.all.includes("WAITING_FOR_CAPABILITY"),
    "and does NOT claim the switch is off", JSON.stringify(blind.waiting));
  check(blind.unknown.includes("switches") && blind.switches === null,
    "and says so in the unknown list rather than leaving a reader to guess", JSON.stringify(blind.unknown));
  check(renderShow(blind).includes("UNKNOWN"), "and the human text says UNKNOWN out loud",
    renderShow(blind).slice(0, 400));

  writeProfiles(ALL_ON, ALL_ON);
}

// ── WAITING_FOR_QUOTA matches the run ref the DISPATCHER writes ──────────────
//
// The dispatcher claims a slot under `<task>:<phase>`, because two phases of one
// task would otherwise collide in the live-request unique index. A reader
// matching the bare task id finds nothing, and WAITING_FOR_QUOTA becomes a
// substate the code can compute and never show.
{
  setPhase(filed.quota, "SIZING");
  const dry = taskShow(db, filed.quota, { now: NOW, switchesFor: resolver() });
  check(!dry.waiting.all.includes("WAITING_FOR_QUOTA"),
    "control: with no lease row the task is not waiting for quota", JSON.stringify(dry.waiting));

  const ref = builderRunRef(filed.quota, "SIZING");
  check(ref !== filed.quota && ref.startsWith(`${filed.quota}:`),
    "control: the producer's run ref is NOT the bare task id", ref);
  check(isRunRefOf(ref, filed.quota) && isRunRefOf(filed.quota, filed.quota),
    "the matcher accepts the phase-qualified form AND the bare one", ref);
  check(!isRunRefOf("pr:12", filed.quota) && !isRunRefOf(`${filed.quota}x:SIZING`, filed.quota),
    "counter-control: and rejects a guardian ref and a near-miss id", ref);

  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,?,999,'L','queued',?,?)`).run(ref, NOW - 90, NOW + 300);
  const wet = taskShow(db, filed.quota, { now: NOW, switchesFor: resolver() });
  check(wet.waiting.all.includes("WAITING_FOR_QUOTA"),
    "a queued builder lease written the way the dispatcher writes it is WAITING_FOR_QUOTA",
    JSON.stringify(wet.waiting));
  check(wet.waiting.since === NOW - 90,
    "and it carries when the wait started, from requested_at", JSON.stringify(wet.waiting));

  // `held` is not `queued`: a lease that HAS the slot is not waiting for one.
  db.prepare("UPDATE provider_lease SET status='held' WHERE run_ref = ?").run(ref);
  const held = taskShow(db, filed.quota, { now: NOW, switchesFor: resolver() });
  check(!held.waiting.all.includes("WAITING_FOR_QUOTA"),
    "control: a HELD lease is not a wait", JSON.stringify(held.waiting));
  db.prepare("DELETE FROM provider_lease WHERE run_ref = ?").run(ref);
}

// ── the substates S3 cannot reach are DERIVED, not hard-coded false ──────────
{
  setPhase(filed.gate, "GATE");
  const none = taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() });
  check(!none.waiting.all.includes("WAITING_FOR_CODEX"),
    "with no gate_request row, WAITING_FOR_CODEX is not claimed", JSON.stringify(none.waiting));

  // The control that separates "S3 writes no gate_request" from "the derivation
  // is a hard-coded false". Without it the assertion above passes on a function
  // returning the empty set for everything.
  db.prepare(`INSERT INTO gate_request(task,spec_repo_id,spec_pr,head_sha,round,task_generation,requested_at)
              VALUES(?,2,7,'headA',0,1,?)`).run(filed.gate, NOW - 300);
  const gated = taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() });
  check(gated.waiting.all.includes("WAITING_FOR_CODEX"),
    "control: an open gate_request DOES produce WAITING_FOR_CODEX, so the derivation is live",
    JSON.stringify(gated.waiting));

  // And it is answered by a Codex clean pass AT THAT HEAD -- the one row that
  // means "reviewed" -- not by any receipt that happens to exist for the task.
  db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,
                                   kind,verdict,observed_at,source_id,task_generation)
              VALUES(?,2,7,'headA',9,'bot','codex_clean','clean',?, 'src-a',1)`)
    .run(filed.gate, NOW - 200);
  check(!taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() }).waiting.all.includes("WAITING_FOR_CODEX"),
    "a codex_clean approval at that head clears the wait");

  // A REVISION reopens it. The pairing is per head, so an answer about an older
  // head must not read as an answer about the head under review now.
  db.prepare(`INSERT INTO gate_request(task,spec_repo_id,spec_pr,head_sha,round,task_generation,requested_at)
              VALUES(?,2,7,'headB',1,1,?)`).run(filed.gate, NOW - 100);
  check(taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() }).waiting.all.includes("WAITING_FOR_CODEX"),
    "and a second round at a NEW head reopens it: the pairing is per head, not per task");

  // WAITING_FOR_NOTICE, with the same per-head property.
  setPhase(filed.gate, "SPEC_PR_OPEN");
  db.prepare(`INSERT INTO notice_receipt(task,head_sha,clean_source_id,channel,kind,delivered_at)
              VALUES(?,'headB','src-1','post','delivered',?)`).run(filed.gate, NOW - 50);
  check(taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() }).waiting.all.includes("WAITING_FOR_NOTICE"),
    "a delivered notice with no acknowledgement is WAITING_FOR_NOTICE");
  db.prepare(`INSERT INTO notice_receipt(task,head_sha,clean_source_id,channel,kind,delivered_at)
              VALUES(?,'headB','src-2','cli','founder_ack',?)`).run(filed.gate, NOW - 10);
  check(!taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() }).waiting.all.includes("WAITING_FOR_NOTICE"),
    "and an acknowledgement AT THAT HEAD clears it");
  db.prepare(`INSERT INTO notice_receipt(task,head_sha,clean_source_id,channel,kind,delivered_at)
              VALUES(?,'headC','src-3','post','delivered',?)`).run(filed.gate, NOW - 5);
  check(taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() }).waiting.all.includes("WAITING_FOR_NOTICE"),
    "while a delivery at a LATER head is unanswered again: a task-wide check would call this acknowledged");

  // WAITING_FOR_GUARDIAN is the phase, because the guardian's verdicts live in a
  // store the hub deliberately cannot read.
  check(!taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() }).waiting.all.includes("WAITING_FOR_GUARDIAN"),
    "control: a task that is not in VERDICT_WAIT is not waiting for the guardian");
  setPhase(filed.gate, "VERDICT_WAIT");
  check(taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() }).waiting.all.includes("WAITING_FOR_GUARDIAN"),
    "and a task in VERDICT_WAIT is");
}

// ── precedence is declared once, and every match is reported ─────────────────
{
  setPhase(filed.both, "SIZING");
  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,?,998,'L','queued',?,?)`)
    .run(builderRunRef(filed.both, "SIZING"), NOW - 30, NOW + 300);
  db.prepare("INSERT INTO hold_reason(task,reason,at) VALUES(?,?,?)").run(filed.both, "blocked_founder", NOW - 600);

  const m = taskShow(db, filed.both, { now: NOW, switchesFor: resolver() });
  check(m.waiting.first === "WAITING_FOR_FOUNDER",
    "a founder hold outranks a queued lease in the headline", JSON.stringify(m.waiting));
  check(m.waiting.all.includes("WAITING_FOR_QUOTA") && m.waiting.all.length === 2,
    "and the quota wait is still reported, because a headline that hides a fact is a smaller answer",
    JSON.stringify(m.waiting));
  check(m.waiting.all.every(w => WAITING.includes(w)),
    "every reported substate is one of the six", JSON.stringify(m.waiting.all));

  // The headline is the FIRST of WAITING that matched, so there is exactly one
  // declaration of the order and no second list to disagree with it.
  const idx = m.waiting.all.map(w => WAITING.indexOf(w));
  check(WAITING.indexOf(m.waiting.first) === Math.min(...idx),
    "and the headline is the earliest match in the declared order, not a second ranking",
    `${m.waiting.first} @${WAITING.indexOf(m.waiting.first)} of ${JSON.stringify(idx)}`);
}

// ── purity: waitingFor takes rows, not a database ────────────────────────────
{
  const ev = evidenceFor(db, filed.cap, { now: NOW });
  const row = db.prepare("SELECT * FROM task WHERE id = ?").get(filed.cap);
  const offMap = { ...ALL_ON, observe: false };
  const a = waitingFor(row, { ...ev, switches: offMap });
  const b = waitingFor(row, { ...ev, switches: offMap });
  check(JSON.stringify(a) === JSON.stringify(b), "waitingFor is pure: the same inputs give the same answer");
  check(waitingFor(row, { ...ev, switches: ALL_ON }).first !== a.first,
    "and it is the SWITCHES argument that moved the answer, not the row",
    `${JSON.stringify(a.first)} vs ${JSON.stringify(waitingFor(row, { ...ev, switches: ALL_ON }).first)}`);
}

// ── UNKNOWN renders as UNKNOWN ───────────────────────────────────────────────
{
  const m = taskShow(db, filed.cap, { now: NOW, switchesFor: resolver() });
  check(m.depth === UNKNOWN, "a task with no depth yet renders UNKNOWN, not null and not empty", String(m.depth));
  check(m.model === UNKNOWN, "and so does the model, which no run has resolved", String(m.model));
  check(m.unknown.includes("depth") && m.unknown.includes("model"),
    "and every UNKNOWN field is listed, so a reader need not scan for the string",
    JSON.stringify(m.unknown));
  const text = renderShow(m);
  check(text.includes("UNKNOWN"), "the human text says UNKNOWN out loud", text.slice(0, 200));
  check(!/\bnull\b|\bundefined\b/.test(text),
    "and never prints null or undefined, which read as a value", text.slice(0, 500));
}

// ── list ─────────────────────────────────────────────────────────────────────
{
  const total = db.prepare("SELECT count(*) c FROM task").get().c;
  const rows = taskList(db, { now: NOW, switchesFor: resolver() });
  check(rows.length === total, `list returns every task (${rows.length} of ${total})`,
    rows.map(r => r.id).join(","));
  check(rows.every(r => typeof r.waiting?.first !== "undefined"),
    "and every row carries the waiting field, present or null",
    JSON.stringify(rows.map(r => r.waiting?.first)));

  const inAlpha = db.prepare("SELECT count(*) c FROM task WHERE project='alpha'").get().c;
  check(taskList(db, { now: NOW, switchesFor: resolver(), project: "alpha" }).length === inAlpha,
    `control: a project filter returns that project's tasks (${inAlpha}), not all of them`);
  check(taskList(db, { now: NOW, switchesFor: resolver(), project: "nothing" }).length === 0,
    "and a filter that matches nothing returns nothing, not everything");
  check(READ_FORMAT_VERSION === 1, "the read model declares its format version", String(READ_FORMAT_VERSION));
  check(renderList([]) === "no tasks", "an empty list says so in words rather than printing a blank line");
}

// ── why: a task that never dispatched, and absence as absence ────────────────
//
// The failure that matters here is not a throw -- a throw is loud. It is an
// empty render that reads as "nothing went wrong", which is the same output a
// healthy task with nothing to report would produce.
{
  const filedFresh = await file({ title: "never dispatched", territory: ["packages/f"] });
  check(filedFresh?.ok === true, "control: the never-dispatched task was admitted",
    JSON.stringify(filedFresh)?.slice(0, 240));
  const fresh = filedFresh.task;

  let model = null, threw = null;
  try { model = whyModel(db, fresh, { now: NOW }); } catch (e) { threw = e; }
  check(threw === null, "why on a task that never dispatched does not throw", String(threw?.message));
  check(model !== null, "and it returns a model", JSON.stringify(model)?.slice(0, 120));

  check(Array.isArray(model.absent), "the model carries an `absent` list", JSON.stringify(model.absent));
  for (const section of ["runs", "lease", "prs", "events", "gate", "holds"])
    check(model.absent.includes(section),
      `${section} is reported ABSENT, not as an empty success`, JSON.stringify(model.absent));
  check(model.absent.every(s => SECTIONS.includes(s)),
    "and every name in it is one of the declared sections", JSON.stringify(model.absent));

  const text = renderWhy(model);
  check(/no phase_run rows/.test(text),
    "and the human text says the rows are not there, in words", text.slice(0, 500));
  check(!/^\s*$/.test(text), "the render is never blank", JSON.stringify(text.slice(0, 80)));
  check(model.depth === UNKNOWN && model.unknown.includes("depth"),
    "a depth nothing has decided renders UNKNOWN and is listed", JSON.stringify(model.unknown));

  // CONTROL: `absent` is DERIVED, not a constant for new tasks. Give the task one
  // event and the section must leave the list.
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,artifact_sha,detail)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(fresh, NOW - 30, "dispatch.sizing", "FILED", "SIZING", 1, 1, "sha-a", "{}");
  const grown = whyModel(db, fresh, { now: NOW });
  check(!grown.absent.includes("events") && grown.events.length === 1,
    "control: one phase_event and `events` is no longer absent", JSON.stringify(grown.absent));
  check(grown.events[0].artifact_sha === "sha-a",
    "and the chain carries the artifact sha that justified the transition", JSON.stringify(grown.events[0]));
  check(grown.absent.includes("runs"),
    "while runs, which still has no rows, stays absent", JSON.stringify(grown.absent));

  // The floors come out of the transition that recorded them, and a detail that
  // is not the shape expected leaves them empty rather than throwing.
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(fresh, NOW - 20, "sizing.decided", "SIZING", "SIZING", 1, 1,
         JSON.stringify({ floors: ["maxPackages"] }));
  check(whyModel(db, fresh, { now: NOW }).floors.join(",") === "maxPackages",
    "the floors that fired are read from the transition that recorded them");
  db.prepare("UPDATE phase_event SET detail='not json' WHERE task = ? AND op='sizing.decided'").run(fresh);
  check(whyModel(db, fresh, { now: NOW }).floors.length === 0,
    "control: an unparseable detail yields no floors rather than a crash");
  filed.fresh = fresh;
}

// ── why: the lineage, when there IS one ──────────────────────────────────────
{
  const filedFull = await file({ title: "a dispatched task", territory: ["packages/u"] });
  check(filedFull?.ok === true, "control: the dispatched task was admitted",
    JSON.stringify(filedFull)?.slice(0, 240));
  const full = filedFull.task;
  setPhase(full, "RESEARCH");
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,model_id,cli_version,
                                    snapshot_hash,contract_drift)
              VALUES(?,1,'SIZING',0,1,'succeeded',321,'L',?,?,?,'/o','/e','model-x','2.0.0','snap1',?)`)
    .run(full, NOW - 900, NOW - 880, NOW - 600, JSON.stringify({ model_id: "asked for y" }));
  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,?,321,'L','held',?,?)`)
    .run(builderRunRef(full, "SIZING"), NOW - 910, NOW + 600);

  const m = whyModel(db, full, { now: NOW });
  check(m.runs.length === 1 && m.runs[0].phase === "SIZING", "the run is in the lineage", JSON.stringify(m.runs));
  check(m.runs[0].snapshot_hash === "snap1",
    "with the contract snapshot it ran under", JSON.stringify(m.runs[0]));
  check(m.runs[0].contract_drift !== null,
    "and the drift, when the live environment did not match", JSON.stringify(m.runs[0].contract_drift));
  check(m.lease && m.lease.status === "held",
    "and the provider lease, found under the phase-qualified ref the dispatcher writes",
    JSON.stringify(m.lease));
  check(!m.absent.includes("runs") && !m.absent.includes("lease"),
    "and neither section is absent", JSON.stringify(m.absent));
  check(m.format_version === READ_FORMAT_VERSION,
    "why shares the read model's format version rather than declaring a second one",
    String(m.format_version));

  // `openPrs` is real and returns nothing in S3, because nothing writes `task_pr`
  // before S7. Assert BOTH halves -- the emptiness, and that the query can see a
  // row -- otherwise a broken query and an empty table read identically.
  check(m.prs.length === 0 && m.absent.includes("prs"),
    "S3 has no pull requests, and `prs` says absent", JSON.stringify(m.prs));
  // `task_pr`'s CHECK forbids generation and slice on a spec row: passing 1 and 0
  // there fails the constraint rather than the assertion, and the test would then
  // report a database error where it meant to report a missing reader.
  db.prepare(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at)
              VALUES(?, 'spec', NULL, NULL, 1, 5, 'headsha', ?)`).run(full, NOW);
  const withPr = whyModel(db, full, { now: NOW });
  check(withPr.prs.length === 1 && !withPr.absent.includes("prs"),
    "control: openPrs does return a row when one exists, so the emptiness above is the table's",
    JSON.stringify(withPr.prs));
  db.prepare("DELETE FROM task_pr WHERE task = ?").run(full);

  const text = renderWhy(withPr);
  check(!/\bundefined\b/.test(text), "the why render never prints undefined", text.slice(0, 600));
  filed.full = full;
}

// ── the CLI: compute -> data -> render ───────────────────────────────────────
//
// The JSON is the interface; the text is not, and it says so in its own comments
// rather than only in a document nobody reads at 2am.
{
  db.close();                                   // the CLI opens the same file
  const BIN = fileURLToPath(new URL("../bin/reeve", import.meta.url));
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--home", HOME],
      { encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "",
             out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  const j = cli("task", "show", filed.full, "--json");
  const parsed = parse(j.stdout);
  check(parsed !== null, "task show --json emits parseable JSON on stdout", j.out.slice(0, 300));
  check(parsed?.format_version === READ_FORMAT_VERSION,
    "carrying the read model's format_version", JSON.stringify(parsed)?.slice(0, 160));
  check(parsed?.kind === "task.show", "and a kind naming which surface produced it", String(parsed?.kind));
  check(parsed?.data?.waiting !== undefined, "and the waiting substate", JSON.stringify(parsed?.data?.waiting));
  check(parsed?.data?.switches?.observe === true,
    "and the switches, resolved from the project's own profile through the registry",
    JSON.stringify(parsed?.data?.switches));

  const human = cli("task", "show", filed.full);
  check(human.stdout.includes(filed.full) && human.stdout.includes("RESEARCH"),
    "the human render prints the same task", human.out.slice(0, 300));
  check(parse(human.stdout) === null,
    "and it is NOT json, so nothing can parse it by accident", human.stdout.slice(0, 160));

  // A missing task is a typed refusal, not a stack trace and not an empty
  // success -- the two shapes an operator cannot tell apart from a real answer.
  const missing = cli("task", "show", "bt:nope", "--json");
  const mj = parse(missing.stdout);
  check(mj?.ok === false && mj?.kind === "task_not_found",
    "a task that does not exist is a typed refusal", missing.out.slice(0, 300));
  check(missing.status === 1, "exiting refused, not misuse and not zero", `rc=${missing.status}`);

  const w = cli("task", "why", filed.fresh, "--json");
  const wj = parse(w.stdout);
  check(Array.isArray(wj?.data?.absent) && wj.data.absent.includes("runs"),
    "task why --json carries the absent list", w.out.slice(0, 300));

  const l = cli("task", "list", "--json");
  const lj = parse(l.stdout);
  check(Array.isArray(lj?.data) && lj.data.length > 0, "task list --json is an array of models", l.out.slice(0, 300));
  check(lj?.kind === "task.list", "under its own kind", String(lj?.kind));

  const filtered = parse(cli("task", "list", "--project", "beta", "--json").stdout);
  check(Array.isArray(filtered?.data) && filtered.data.every(t => t.project === "beta") && filtered.data.length > 0,
    "and --project filters it", JSON.stringify(filtered?.data?.map(t => t.project)));

  // A project name that names nothing anywhere is a typed refusal rather than an
  // empty list: an empty list is what a correct filter returns, so a typo would
  // otherwise be indistinguishable from a project with no tasks.
  const bogus = cli("task", "list", "--project", "not-a-project", "--json");
  const bj = parse(bogus.stdout);
  check(bj?.ok === false && bj?.kind === "project_unknown",
    "a --project nobody has heard of is refused rather than answered with nothing",
    bogus.out.slice(0, 300));
  check(/beta/.test(bogus.out) && /alpha/.test(bogus.out),
    "and the refusal names the projects that do exist", bogus.out.slice(0, 300));

  const usage = cli("task", "show", "--json");
  check(parse(usage.stdout)?.kind === "usage" && usage.status === 2,
    "show with no id is a usage refusal, exiting misuse", usage.out.slice(0, 200));

  // Reading the hub must not MIGRATE it. `openHub` applies forward migrations,
  // and a migration is a write, so a read command opened privileged would upgrade
  // the store under a live builder while holding no lease at all.
  const check2 = openHub(join(HOME, "state", "hub.db"));
  const events = check2.prepare("SELECT count(*) c FROM hub_event").get().c;
  check2.close();
  cli("task", "list"); cli("task", "show", filed.full); cli("task", "why", filed.full);
  const check3 = openHub(join(HOME, "state", "hub.db"));
  check(check3.prepare("SELECT count(*) c FROM hub_event").get().c === events,
    "three read commands appended no hub_event between them", `${events}`);
  check(events > 0, "control: the count is not zero, so the comparison had something to compare",
    String(events));
  check3.close();

  // A machine with no builder has no hub, and an open error whose text is a
  // sqlite message is not an answer to "what are my tasks".
  const noHub = join(dir, "empty", ".reeve");
  mkdirSync(noHub, { recursive: true });
  const r = spawnSync(process.execPath, [BIN, "task", "list", "--home", noHub, "--json"],
    { encoding: "utf8", timeout: 60_000 });
  const nj = parse(r.stdout ?? "");
  check(nj?.ok === false && nj?.kind === "hub_absent",
    "a home with no hub is a typed answer, not a crash", ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 300));
}

// ── the envelope is frozen at version 1 ──────────────────────────────────────
//
// A version that stays 1 while the shape underneath changes is worse than no
// version, because the consumer's check passes. Both halves are frozen: a freeze
// verified only against the half it already covered proves nothing about the half
// that was added.
{
  const db2 = openHub(join(HOME, "state", "hub.db"));
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/read-model-v1.json", import.meta.url), "utf8"));
  check(frozen.format_version === READ_FORMAT_VERSION,
    "the fixture froze the version this build emits", `${frozen.format_version} vs ${READ_FORMAT_VERSION}`);

  const show = taskShow(db2, filed.full, { now: NOW, switchesFor: resolver() });
  const showKeys = Object.keys(show).sort();
  check(JSON.stringify(showKeys) === JSON.stringify(frozen.show_keys),
    "task.show's key set is unchanged since the freeze",
    `now ${showKeys.join(",")}\n        was ${frozen.show_keys.join(",")}\n        ` +
    "If this change is intentional it is a NEW format_version, not an edit here.");

  const waitKeys = Object.keys(show.waiting).sort();
  check(JSON.stringify(waitKeys) === JSON.stringify(frozen.waiting_keys),
    "and so is the waiting object's, which is the field a script actually branches on",
    `now ${waitKeys.join(",")}\n        was ${frozen.waiting_keys.join(",")}`);

  const w = whyModel(db2, filed.full, { now: NOW });
  const whyKeys = Object.keys(w).sort();
  check(JSON.stringify(whyKeys) === JSON.stringify(frozen.why_keys),
    "task.why's key set is unchanged since the freeze",
    `now ${whyKeys.join(",")}\n        was ${frozen.why_keys.join(",")}`);

  check(JSON.stringify([...WAITING]) === JSON.stringify(frozen.waiting),
    "and the six waiting substates are the six that were frozen",
    `now ${WAITING.join(",")}\n        was ${frozen.waiting.join(",")}`);
  check(JSON.stringify([...SECTIONS]) === JSON.stringify(frozen.sections),
    "and why's section names are the ones that were frozen",
    `now ${SECTIONS.join(",")}\n        was ${frozen.sections.join(",")}`);

  const env = envelope("task.show", show);
  check(JSON.stringify(Object.keys(env).sort()) === JSON.stringify(["data", "format_version", "kind"]),
    "the envelope itself carries exactly three keys", JSON.stringify(Object.keys(env)));
  db2.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
