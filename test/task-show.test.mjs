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

import { openHub, HUB_SCHEMA_VERSION, completedVersion } from "../src/build/hubdb.mjs";
import { insertLease } from "../src/build/providerdb.mjs";
import { liveLeases } from "../src/build/territory.mjs";
import { DatabaseSync } from "node:sqlite";
import { fileTask } from "../src/build/taskfile.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { CAPABILITY_NAMES, capabilitiesFrom } from "../src/build/capabilities.mjs";
import { validate, withDefaults } from "../src/profile/schema.mjs";
import { HELD } from "../src/build/phases.mjs";
import {
  READ_FORMAT_VERSION, WAITING, NEEDS_SWITCH, UNKNOWN, envelope,
  switchesFrom, switchesResolver, builderRunRef, isRunRefOf, inSnapshot,
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
// A profile the SCHEMA ACCEPTS, not merely one that parses. The reader validates
// and identity-binds before reporting switches, so a fixture that skips the
// required keys would exercise the failure path while claiming to test the
// success one -- and every switch would read UNKNOWN for a reason the test never
// meant to create.
const profileFor = (key, caps) => ({
  schemaVersion: 1, project: { kind: "product" },
  identity: { key, defaultBranch: "main", visibility: "private" },
  authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "committed" },
  state: { mode: "in-repo" },
  units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm" }],
  ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "enforced" },
  builder: { capabilities: caps },
});
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
const readProfile = (p) => withDefaults(JSON.parse(readFileSync(p, "utf8")));
// A fresh resolver per call: it MEMOISES, which is the point, so a test that
// changes a profile on disk must not read a cached answer from before the change.
const resolver = () => switchesResolver(entries, readProfile, { validate });

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
  //
  // THE OPEN SPEC PULL REQUEST IS WHAT ESTABLISHES THE CURRENT HEAD. Migration 2
  // dropped `task.spec_head`, so `task_pr` is where the head under review lives,
  // and a gate wait that is not scoped to it stays outstanding for ever across
  // every revision the task ever made.
  const specPr = (head) => db.prepare(
    `INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at)
     VALUES(?, 'spec', NULL, NULL, 3, 11, ?, ?)`).run(filed.gate, head, NOW - 400);
  const rehead = (head) => db.prepare("UPDATE task_pr SET head_sha = ? WHERE task = ?").run(head, filed.gate);
  const gateReq = (head, round, gen) => db.prepare(
    `INSERT INTO gate_request(task,spec_repo_id,spec_pr,head_sha,round,task_generation,requested_at)
     VALUES(?,2,7,?,?,?,?)`).run(filed.gate, head, round, gen, NOW - 300 + round);
  const show = () => taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() });

  specPr("headA");
  gateReq("headA", 0, 1);
  const gated = show();
  check(gated.waiting.all.includes("WAITING_FOR_CODEX"),
    "control: an open gate_request at the CURRENT head DOES produce WAITING_FOR_CODEX, so the derivation is live",
    JSON.stringify(gated.waiting));

  // And it is answered by a Codex clean pass AT THAT HEAD -- the one row that
  // means "reviewed" -- not by any receipt that happens to exist for the task.
  db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,
                                   kind,verdict,observed_at,source_id,task_generation)
              VALUES(?,2,7,'headA',9,'bot','codex_clean','clean',?, 'src-a',1)`)
    .run(filed.gate, NOW - 200);
  check(!show().waiting.all.includes("WAITING_FOR_CODEX"),
    "a codex_clean approval at that head clears the wait");

  // A REVISION at a new head reopens it, and the OLD head's unanswered request
  // does not keep it open by itself.
  rehead("headB");
  gateReq("headB", 1, 1);
  check(show().waiting.all.includes("WAITING_FOR_CODEX"),
    "and a second round at a NEW head reopens it: the pairing is per head, not per task");

  // THE FINDING THIS SCOPING EXISTS FOR. Codex asked for changes on headB and
  // never cleaned it; the task revises to headC, which has no request yet. A
  // check that asks "is ANY historical request unanswered" answers yes for ever
  // -- long after the task has moved on, and even once it has left the gate.
  rehead("headC");
  const stale = show();
  check(!stale.waiting.all.includes("WAITING_FOR_CODEX"),
    "an unanswered request at a SUPERSEDED head does not keep the wait open",
    JSON.stringify(stale.waiting));
  gateReq("headC", 2, 1);
  check(show().waiting.all.includes("WAITING_FOR_CODEX"),
    "control: and a request AT the new head does, so the scoping did not simply disable it");

  // A REGENERATE resets the contract, so a request recorded under an older
  // generation is not a question about the task as it now is.
  db.prepare("UPDATE task SET generation = 2 WHERE id = ?").run(filed.gate);
  check(!show().waiting.all.includes("WAITING_FOR_CODEX"),
    "a request recorded under an older generation is not a question about this one");
  rehead("headE");
  gateReq("headE", 3, 2);
  check(show().waiting.all.includes("WAITING_FOR_CODEX"),
    "control: a request at the current head AND generation still opens it");
  db.prepare("UPDATE task SET generation = 1 WHERE id = ?").run(filed.gate);
  rehead("headC");

  // ── WAITING_FOR_NOTICE, scoped the same way ────────────────────────────────
  //
  // `notice_receipt`'s primary key is (task, head_sha, clean_source_id), so a
  // delivery and its acknowledgement CANNOT both exist as rows for one source:
  // acknowledging advances the row's `kind`. Measured from the schema, and it is
  // what makes the pairing below testable at all.
  setPhase(filed.gate, "SPEC_PR_OPEN");
  const deliver = (head, src, at) => db.prepare(
    `INSERT INTO notice_receipt(task,head_sha,clean_source_id,channel,kind,delivered_at)
     VALUES(?,?,?,'post','delivered',?)`).run(filed.gate, head, src, at);
  const ack = (src) => db.prepare(
    "UPDATE notice_receipt SET kind='founder_ack' WHERE task = ? AND clean_source_id = ?")
    .run(filed.gate, src);

  deliver("headC", "src-1", NOW - 50);
  check(show().waiting.all.includes("WAITING_FOR_NOTICE"),
    "a delivered notice at the current head with no acknowledgement is WAITING_FOR_NOTICE");
  ack("src-1");
  check(!show().waiting.all.includes("WAITING_FOR_NOTICE"),
    "and an acknowledgement of THAT SOURCE clears it");

  // The founder answered headC by requesting changes rather than acknowledging,
  // and the push of headD voids that window. A task-wide predicate reports the
  // old delivery as outstanding for the rest of the task's life.
  db.prepare("UPDATE notice_receipt SET kind='delivered' WHERE task = ? AND clean_source_id = 'src-1'")
    .run(filed.gate);
  rehead("headD");
  const superseded = show();
  check(!superseded.waiting.all.includes("WAITING_FOR_NOTICE"),
    "a delivery at a SUPERSEDED head is not an outstanding notice: the new push voided its window",
    JSON.stringify(superseded.waiting));
  deliver("headD", "src-3", NOW - 5);
  check(show().waiting.all.includes("WAITING_FOR_NOTICE"),
    "control: a delivery AT the new head is, so the scoping did not simply disable it");

  // AND PAIRED BY SOURCE, not merely by head. One unchanged head can receive
  // several clean passes, each with its own delivery, and each wants its own
  // answer. A head-wide boolean let the first acknowledgement suppress the wait
  // for every later one, so the founder would never be asked about a notice that
  // had genuinely arrived.
  ack("src-3");
  check(!show().waiting.all.includes("WAITING_FOR_NOTICE"),
    "control: acknowledging that source clears it");
  deliver("headD", "src-4", NOW - 3);
  check(show().waiting.all.includes("WAITING_FOR_NOTICE"),
    "a SECOND clean pass at the same head is a second delivery, and the first ack does not answer it",
    JSON.stringify(show().waiting));
  check(show().waiting.since === NOW - 3,
    "and `since` is the unanswered delivery's moment, not the answered one's",
    String(show().waiting.since));
  db.prepare("DELETE FROM notice_receipt WHERE task = ?").run(filed.gate);

  // WAITING_FOR_GUARDIAN is the phase, because the guardian's verdicts live in a
  // store the hub deliberately cannot read.
  check(!show().waiting.all.includes("WAITING_FOR_GUARDIAN"),
    "control: a task that is not in VERDICT_WAIT is not waiting for the guardian");
  setPhase(filed.gate, "VERDICT_WAIT");
  check(show().waiting.all.includes("WAITING_FOR_GUARDIAN"), "and a task in VERDICT_WAIT is");

  // VERDICT_WAIT's next gated effect is the MERGE, not the publish. Under the
  // ordinary staged configuration -- publishPr on, mergeBuilderPr off -- naming
  // publishPr reports no capability wait although merge actuation is exactly what
  // is switched off.
  const staged = { ...ALL_ON, mergeBuilderPr: false };
  const vw = taskShow(db, filed.gate, { now: NOW, switchesFor: () => staged });
  check(vw.waiting.capability === "mergeBuilderPr" &&
        vw.waiting.all.includes("WAITING_FOR_CAPABILITY"),
    "VERDICT_WAIT names mergeBuilderPr, the switch that actually blocks it",
    JSON.stringify(vw.waiting));
  check(!taskShow(db, filed.gate, { now: NOW, switchesFor: () => ({ ...ALL_ON, publishPr: false }) })
          .waiting.all.includes("WAITING_FOR_CAPABILITY"),
    "control: and publishPr being off does not, because publishing already happened");
}

// ── a held phase is a founder wait even with no hold_reason row ──────────────
//
// Retry exhaustion and the gate revision cap move a task straight to ESCALATED
// and write NO hold_reason row, yet ESCALATED's only exit is founder action. A
// check that named only BLOCKED rendered those tasks as waiting for nobody.
{
  check(HELD.includes("BLOCKED") && HELD.includes("ESCALATED"),
    "control: the declared held set is the two phases this depends on", HELD.join(","));
  for (const phase of HELD) {
    setPhase(filed.gate, phase);
    const m = taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() });
    check(m.waiting.all.includes("WAITING_FOR_FOUNDER"),
      `a task in ${phase} waits for the founder even with no hold_reason row`,
      JSON.stringify(m.waiting));
    check(db.prepare("SELECT count(*) c FROM hold_reason WHERE task = ?").get(filed.gate).c === 0,
      `control: and there really is no hold_reason row for ${phase}`);
  }
  setPhase(filed.gate, "SIZING");
  check(!taskShow(db, filed.gate, { now: NOW, switchesFor: resolver() })
          .waiting.all.includes("WAITING_FOR_FOUNDER"),
    "control: an ordinary phase with no hold does not");
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

  // THE FLOORS HAVE NO PRODUCER YET, and `why` says UNKNOWN rather than claiming
  // none fired. An earlier version searched phase_event for a `sizing.decided`
  // op; nothing writes it, so every real task rendered "none recorded" -- a
  // positive claim about a question never asked -- and the test went green only
  // because it inserted that otherwise-unproduced row itself. A fixture that
  // describes a system which does not exist cannot exhibit the defect it is
  // written for.
  {
    const SRC = readFileSync(new URL("../src/build/why.mjs", import.meta.url), "utf8");
    check(!/e\.op === "sizing\.decided"/.test(SRC),
      "why does not read an op nothing writes",
      (SRC.match(/.*sizing\.decided.*/) ?? [""])[0].slice(0, 120));
    // COUNTER-CONTROL: the extraction can find that shape in a literal it has
    // never seen, so the absence above is a real absence and not a dead regex.
    check(/e\.op === "sizing\.decided"/.test('if (e.op === "sizing.decided") {}'),
      "counter-control: the same pattern still matches a literal containing it");

    check(whyModel(db, fresh, { now: NOW }).floors.length === 0,
      "and the model reports no floors");
    check(/floors fired: UNKNOWN/.test(renderWhy(whyModel(db, fresh, { now: NOW }))),
      "and the render says UNKNOWN, not `none recorded`",
      renderWhy(whyModel(db, fresh, { now: NOW })).slice(0, 200));
  }

  // ── the lineage keeps what a projection would drop ────────────────────────
  //
  // A cleared hold is history a founder needs; `evidenceFor` filters it out
  // because `show` answers "what is stopping this NOW", and reusing that list as
  // the lineage renders "no human has stopped this task" about a task a human
  // stopped and then released.
  db.prepare("INSERT INTO hold_reason(task,reason,detail,at,cleared_at) VALUES(?,?,?,?,?)")
    .run(fresh, "blocked_founder", "waiting on a decision", NOW - 900, NOW - 800);
  const withHold = whyModel(db, fresh, { now: NOW });
  check(withHold.holds.length === 1 && withHold.holds[0].cleared_at === NOW - 800,
    "why keeps a CLEARED hold, with the moment it was cleared", JSON.stringify(withHold.holds));
  check(!withHold.absent.includes("holds"),
    "so the holds section is not absent for a task that was once held",
    JSON.stringify(withHold.absent));
  check(/cleared /.test(renderWhy(withHold)),
    "and the render says it was cleared rather than dropping it",
    renderWhy(withHold).slice(0, 600));
  // CONTROL: `show` still answers the present-tense question with the active
  // list only, or the two readers have been collapsed into one wrong one.
  check(taskShow(db, fresh, { now: NOW, switchesFor: resolver() }).waiting.all
          .includes("WAITING_FOR_FOUNDER") === false,
    "control: and a cleared hold is NOT a current founder wait in show");
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


// ── a projection must not drop an identity the key carries ──────────────────
{
  const m = whyModel(db, filed.full, { now: NOW });
  check(m.runs.every(r => typeof r.generation === "number"),
    "every phase_run row in the lineage carries its generation", JSON.stringify(m.runs.map(r => r.generation)));

  // `phase_run`'s key is (task, generation, phase, slice, attempt). After a
  // regenerate two rows share phase, slice and attempt, and without the
  // generation a consumer cannot tell which contract epoch produced either --
  // an identity no ordering restores.
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path)
              VALUES(?,2,'SIZING',0,1,'succeeded',322,'L',?,?,?,'/o','/e')`)
    .run(filed.full, NOW - 800, NOW - 780, NOW - 500);
  const two = whyModel(db, filed.full, { now: NOW }).runs
    .filter(r => r.phase === "SIZING" && r.slice === 0 && r.attempt === 1);
  check(two.length === 2, "control: two runs really do share phase, slice and attempt", JSON.stringify(two.map(r => r.generation)));
  check(new Set(two.map(r => r.generation)).size === 2,
    "and the generation is what tells them apart", JSON.stringify(two.map(r => r.generation)));
  db.prepare("DELETE FROM phase_run WHERE task = ? AND generation = 2").run(filed.full);
}

// ── absence of a lease is not evidence a slot was never asked for ───────────
//
// A successful release DELETES the row, so an ordinary task with completed runs
// has no lease precisely BECAUSE it held one and gave it back. A lineage must not
// assert history it cannot read.
{
  const noLease = whyModel(db, filed.fresh, { now: NOW });
  check(noLease.absent.includes("lease"), "control: the fresh task has no provider lease row", JSON.stringify(noLease.absent));
  const text = renderWhy(noLease);
  check(!/never asked for a slot/.test(text),
    "why does not claim a task never asked for a slot", (text.match(/.*provider_lease.*/) ?? [""])[0]);
  check(/not evidence either way/.test(text),
    "and says the absence is not evidence either way", (text.match(/.*provider_lease.*/) ?? [""])[0]);
}

// ── a profile is validated and identity-bound before its switches are read ──
//
// Two failures hide in a profile that PARSES: a schema-invalid value, and a
// registry entry pointing at another project's perfectly valid profile.
{
  const bad = join(dir, "invalid.json");
  writeFileSync(bad, JSON.stringify({ ...profileFor("o/a", ALL_ON), schemaVersion: 99 }) + "\n");
  const r1 = switchesResolver({ alpha: { nwo: "o/a", profilePath: bad } }, readProfile, { validate });
  check(r1("alpha") === null,
    "a profile the schema refuses reports UNKNOWN, not every switch off", JSON.stringify(r1("alpha")));

  // Without validation the SAME file answers `off` for every switch, which reads
  // as a decision the founder made rather than a file that is broken. This is the
  // control that the assertion above is about validation and not about the file
  // being unreadable.
  const r2 = switchesResolver({ alpha: { nwo: "o/a", profilePath: bad } }, readProfile);
  check(r2("alpha") !== null && r2("alpha").observe === true,
    "control: unvalidated, that same file is read and answers with switches",
    JSON.stringify(r2("alpha")));

  // A valid profile that names a DIFFERENT repository is not this project's.
  const r3 = switchesResolver({ alpha: { nwo: "o/somewhere-else", profilePath: pathA } },
                              readProfile, { validate });
  check(r3("alpha") === null,
    "a profile whose identity.key names another repository is not this project's", JSON.stringify(r3("alpha")));
  const r4 = switchesResolver({ alpha: { nwo: "o/a", profilePath: pathA } }, readProfile, { validate });
  check(r4("alpha")?.observe === true,
    "control: the same file under its OWN nwo resolves, so the refusal is the identity check",
    JSON.stringify(r4("alpha")));

  // MEMOISED, which is the point of the resolver, and asserted because a
  // resolver that re-reads on every row turns one listing into N file reads.
  let reads = 0;
  const counting = switchesResolver({ alpha: entries.alpha },
    (p) => { reads++; return readProfile(p); }, { validate });
  counting("alpha"); counting("alpha"); counting("alpha");
  check(reads === 1, `the resolver reads each project's profile once (${reads})`, String(reads));
}

// ── the read runs against one snapshot ──────────────────────────────────────
{
  let began = 0, committed = 0;
  const spy = {
    exec: (sql) => { if (/^BEGIN/.test(sql)) began++; if (/^COMMIT/.test(sql)) committed++; },
  };
  const out = inSnapshot(spy, () => "the answer");
  check(out === "the answer", "inSnapshot returns what the read returned", String(out));
  check(began === 1 && committed === 1, `and opens exactly one transaction around it (${began}/${committed})`);

  // A store that refuses to begin one still gets ANSWERED. A snapshot is better
  // than none, and none is better than refusing to answer at all.
  const refusing = { exec: () => { throw new Error("cannot begin"); } };
  let threw = null, val = null;
  try { val = inSnapshot(refusing, () => "answered anyway"); } catch (e) { threw = e; }
  check(threw === null && val === "answered anyway",
    "and a store that cannot begin one is answered without it", String(threw?.message));

  // It really is a transaction on the live connection, not a no-op.
  const inside = inSnapshot(db, () => taskShow(db, filed.full, { now: NOW, switchesFor: resolver() }));
  check(inside?.id === filed.full, "and a real read through it returns the model", String(inside?.id));
}


// ── the headline's age is the headline's own ────────────────────────────────
//
// A single `since` filled by whichever branch happened to run first reported the
// quota request's moment while `first` named a founder hold. Anything measuring
// "how long has this been waiting" then got the age of a different condition, and
// got it silently, because both are plausible integers.
{
  const m = taskShow(db, filed.both, { now: NOW, switchesFor: resolver() });
  check(m.waiting.first === "WAITING_FOR_FOUNDER" && m.waiting.all.includes("WAITING_FOR_QUOTA"),
    "control: this task has a founder hold AND a queued lease", JSON.stringify(m.waiting));
  check(m.waiting.since === NOW - 600,
    "`since` is the FOUNDER hold's moment, the wait the headline names",
    `${m.waiting.since} (hold at ${NOW - 600}, lease at ${NOW - 30})`);
  check(m.waiting.since !== NOW - 30,
    "and not the queued lease's, which is a different condition", String(m.waiting.since));

  // THE CASE THAT EXHIBITS THE DEFECT, and the fixture has to carry BOTH halves
  // or the two implementations agree. A queued lease beside a HIGHER-priority
  // wait is where the old code borrowed the lease's moment for a headline that
  // was not the lease: with only a founder hold, or only a lease, the broken and
  // the correct answer are the same integer.
  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,?,997,'L','queued',?,?)`)
    .run(builderRunRef(filed.cap, "FILED"), NOW - 42, NOW + 300);
  const capOff = taskShow(db, filed.cap, { now: NOW,
    switchesFor: () => ({ ...ALL_ON, observe: false }) });
  check(capOff.waiting.first === "WAITING_FOR_CAPABILITY" &&
        capOff.waiting.all.includes("WAITING_FOR_QUOTA"),
    "control: the capability wait outranks a queued lease that is also standing",
    JSON.stringify(capOff.waiting));
  check(capOff.waiting.since === null,
    "a switch being off is a state, not an event, so `since` is null rather than the lease's moment",
    `${capOff.waiting.since} (the lease was requested at ${NOW - 42})`);
  check(capOff.waiting.since !== NOW - 42,
    "and specifically not the queued lease's, which is what the headline is NOT",
    String(capOff.waiting.since));

  // And a wait that DOES have a moment reports its own, not the lease's.
  const codex = taskShow(db, filed.cap, { now: NOW, switchesFor: resolver() });
  check(codex.waiting.first === "WAITING_FOR_QUOTA" && codex.waiting.since === NOW - 42,
    "control: once the switch is on, the lease IS the headline and `since` is its moment",
    JSON.stringify(codex.waiting));
  db.prepare("DELETE FROM provider_lease WHERE run_ref = ?").run(builderRunRef(filed.cap, "FILED"));
}

// ── the overview must not render UNKNOWN as `not waiting` ───────────────────
{
  const blind = taskList(db, { now: NOW, switchesFor: switchesResolver({}, readProfile) });
  const text = renderList(blind);
  check(blind.every(m => m.waiting.capability_known === false || m.waiting.first !== null),
    "control: every row in this listing has an unreadable capability",
    JSON.stringify(blind.map(m => m.waiting.capability_known)));
  check(/UNKNOWN/.test(text),
    "the list prints UNKNOWN where the capability could not be read", text.split("\n")[0]);
  check(!/ - /.test(text),
    "and never a dash, which is what a task known NOT to be waiting prints", text.split("\n")[0]);

  // CONTROL: a readable listing still prints the dash, or the change is a blanket
  // relabel rather than a distinction.
  const seen = renderList(taskList(db, { now: NOW, switchesFor: resolver() }));
  check(/ - /.test(seen), "control: a readable listing still prints a dash for a task that waits for nothing",
    (seen.split("\n").find(l => / - /.test(l)) ?? "").slice(0, 80));
}

// ── a drifted run must not read as current ─────────────────────────────────
{
  const drifted = (await file({ title: "a drifted run", territory: ["packages/d"] })).task;
  setPhase(drifted, "RESEARCH");
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,contract_drift)
              VALUES(?,1,'RESEARCH',0,1,'live',400,'L',?,?,?,'/o','/e',?)`)
    .run(drifted, NOW - 100, NOW - 10, NOW + 600, JSON.stringify({ model_id: "asked for y" }));
  const m = taskShow(db, drifted, { now: NOW, switchesFor: resolver() });
  check(m.running !== null, "control: the task has a live run", JSON.stringify(m.running));
  check(m.running.drift !== null && /model_id/.test(String(m.running.drift)),
    "show reports the run's contract drift rather than dropping the column",
    JSON.stringify(m.running.drift));
  // AND THE HUMAN RENDER SAYS SO. The default renderer is what an operator
  // actually reads; carrying drift in the JSON while the text stayed silent left
  // the drifted run looking ordinary to everyone not parsing --json.
  check(/DRIFT/.test(renderShow(m)),
    "and the human render says DRIFT out loud, not only the JSON",
    renderShow(m).slice(0, 400));

  // CONTROL: a run with no drift says null, or the field is not reporting drift
  // so much as reporting that a run exists.
  db.prepare("UPDATE phase_run SET contract_drift = NULL WHERE task = ?").run(drifted);
  check(taskShow(db, drifted, { now: NOW, switchesFor: resolver() }).running.drift === null,
    "control: and a run whose contract matched says null");
  db.prepare("DELETE FROM phase_run WHERE task = ?").run(drifted);
}

// ── the lineage carries the WHOLE contract snapshot ────────────────────────
//
// These columns define the sandbox and the prompt a run actually executed under.
// A lineage carrying only the model and the budget cannot answer "what exactly
// ran", which is the question `why` exists for.
{
  const CONTRACT = ["argv_hash", "prompt_hash", "settings_hash", "tools_hash", "agents_hash",
                    "canary_id", "snapshot_hash", "model_id", "cli_version", "effort",
                    "max_turns", "max_budget_usd"];
  db.prepare(`UPDATE phase_run SET argv_hash='av', prompt_hash='pr', settings_hash='se',
                                   tools_hash='to', agents_hash='ag', canary_id='ca'
              WHERE task = ? AND generation = 1`).run(filed.full);
  const r = whyModel(db, filed.full, { now: NOW }).runs[0];
  const missing = CONTRACT.filter(c => !(c in r));
  check(missing.length === 0, "every contract-snapshot column reaches the lineage",
    `missing: ${missing.join(", ")}`);
  check(r.argv_hash === "av" && r.canary_id === "ca",
    "and carries the values, not merely the keys", JSON.stringify(r));

  // The columns are DERIVED from the table rather than retyped, so a column added
  // to phase_run's contract family is visible here the day it is added.
  const declared = db.prepare("SELECT name FROM pragma_table_info('phase_run')").all().map(x => x.name);
  const absent = CONTRACT.filter(c => !declared.includes(c));
  check(absent.length === 0, "control: every column this asserts is one phase_run really declares",
    `not columns: ${absent.join(", ")}`);
}

// ── a founder approval is founder evidence ─────────────────────────────────
{
  const fa = (await file({ title: "an approved round", territory: ["packages/a2"] })).task;
  db.prepare(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at)
              VALUES(?, 'spec', NULL, NULL, 5, 21, 'headZ', ?)`).run(fa, NOW - 300);
  db.prepare(`INSERT INTO gate_request(task,spec_repo_id,spec_pr,head_sha,round,task_generation,requested_at)
              VALUES(?,5,21,'headZ',0,1,?)`).run(fa, NOW - 250);

  const before = whyModel(db, fa, { now: NOW }).gate[0];
  check(before.founder_acked === false && before.founder_evidence === null,
    "control: with no approval and no receipt the round reads `not yet`", JSON.stringify(before));

  db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,
                                   kind,verdict,observed_at,source_id,task_generation)
              VALUES(?,5,21,'headZ',9,'mobeenabdullah','founder_review','approve',?, 'rev-77',1)`)
    .run(fa, NOW - 100);
  const after = whyModel(db, fa, { now: NOW }).gate[0];
  check(after.founder_acked === true,
    "a founder_review approval answers the round, with no notice receipt anywhere",
    JSON.stringify(after));
  check(after.founder_evidence?.kind === "founder_review" &&
        after.founder_evidence?.source_id === "rev-77" &&
        after.founder_evidence?.actor === "mobeenabdullah",
    "and the lineage names WHICH evidence and where it came from", JSON.stringify(after.founder_evidence));
  check(/founder_review/.test(renderWhy(whyModel(db, fa, { now: NOW }))) &&
        /rev-77/.test(renderWhy(whyModel(db, fa, { now: NOW }))),
    "and the render says so rather than a bare `acked`",
    renderWhy(whyModel(db, fa, { now: NOW })).slice(0, 700));
}


// ── a founder verdict is a verdict, not merely a row ───────────────────────
//
// `changes_requested` is as ordinary a founder answer as `approve`, and an
// approval can be superseded by a later one. Reading the KIND of the FIRST row
// reported "approved" for a round the founder had asked for changes on — the one
// mistake in this surface that could make somebody ship.
{
  const fv = (await file({ title: "a contested round", territory: ["packages/v"] })).task;
  db.prepare(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at)
              VALUES(?, 'spec', NULL, NULL, 6, 31, 'headV', ?)`).run(fv, NOW - 300);
  db.prepare(`INSERT INTO gate_request(task,spec_repo_id,spec_pr,head_sha,round,task_generation,requested_at)
              VALUES(?,6,31,'headV',0,1,?)`).run(fv, NOW - 250);
  const approval = (sid, verdict, at, superseded = null) => db.prepare(
    `INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,
                          kind,verdict,observed_at,source_id,task_generation,superseded_at)
     VALUES(?,6,31,'headV',9,'mobeenabdullah','founder_review',?,?,?,1,?)`)
    .run(fv, verdict, at, sid, superseded);

  approval("rev-a", "changes_requested", NOW - 200);
  const contested = whyModel(db, fv, { now: NOW }).gate[0];
  check(contested.founder_acked === false,
    "a founder_review of changes_requested does NOT read as approved",
    JSON.stringify(contested));
  check(contested.founder_evidence?.verdict === "changes_requested",
    "and the lineage carries the verdict, so the reader can see which answer it was",
    JSON.stringify(contested.founder_evidence));

  // A later approval supersedes it, and the NEWEST standing row is the answer.
  approval("rev-b", "approve", NOW - 100);
  const later = whyModel(db, fv, { now: NOW }).gate[0];
  check(later.founder_acked === true && later.founder_evidence?.source_id === "rev-b",
    "a later approval answers the round, and it is the LATEST row that decides",
    JSON.stringify(later.founder_evidence));

  // And a superseded approval does not answer anything, however recent.
  db.prepare("UPDATE approval SET superseded_at = ? WHERE source_id = 'rev-b'").run(NOW - 50);
  const gone = whyModel(db, fv, { now: NOW }).gate[0];
  check(gone.founder_acked === false,
    "a SUPERSEDED approval answers nothing, and the changes_requested row beneath it still stands",
    JSON.stringify(gone.founder_evidence));
  check(gone.founder_evidence?.source_id === "rev-a",
    "control: and the row that surfaces is the older one, so the query did not simply return nothing",
    JSON.stringify(gone.founder_evidence));
}

// ── the JSON and the render must agree about what was asked ───────────────
//
// `floors: []` is a definite answer to a machine, and the definite answer is
// wrong. The human render already said UNKNOWN; a consumer parsing --json was
// told "none fired". Two renderers over one model must not disagree about
// whether a question was even asked.
{
  const m = whyModel(db, filed.fresh, { now: NOW });
  check(m.floors.length === 0, "control: no writer records the floors, so the list is empty", JSON.stringify(m.floors));
  check(m.unknown.includes("floors"),
    "and `floors` is named in `unknown`, so an empty list is not read as a fact",
    JSON.stringify(m.unknown));
  check(/floors fired: UNKNOWN/.test(renderWhy(m)),
    "control: the human render says the same thing, so the two agree",
    renderWhy(m).split("\n")[1]);
}

// ── the fallback run must not carry a previous generation forward ──────────
{
  const gen = (await file({ title: "a regenerated task", territory: ["packages/gn"] })).task;
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,model_id,cli_version)
              VALUES(?,1,'SIZING',0,1,'succeeded',500,'L',?,?,?,'/o','/e','model-old','1.0.0')`)
    .run(gen, NOW - 900, NOW - 880, NOW - 600);
  const before = taskShow(db, gen, { now: NOW, switchesFor: resolver() });
  check(before.model === "model-old",
    "control: with one generation, the fallback reports that generation's model", String(before.model));

  // A regenerate increments the generation. Before the new one dispatches, there
  // is no run of its own — and the honest answer is UNKNOWN, not the previous
  // contract epoch's model under a heading that reads as current.
  db.prepare("UPDATE task SET generation = 2 WHERE id = ?").run(gen);
  const after = taskShow(db, gen, { now: NOW, switchesFor: resolver() });
  check(after.model === UNKNOWN && after.cli_version === UNKNOWN,
    "after a regenerate, a run from the PREVIOUS generation is not reported as this one's",
    `${after.model} / ${after.cli_version}`);
  check(after.unknown.includes("model") && after.unknown.includes("cli_version"),
    "and both are named in the unknown list", JSON.stringify(after.unknown));

  // CONTROL: once the new generation dispatches, its own run is reported — or the
  // scoping has simply disabled the fallback.
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,model_id,cli_version)
              VALUES(?,2,'SIZING',0,1,'succeeded',501,'L',?,?,?,'/o','/e','model-new','2.0.0')`)
    .run(gen, NOW - 300, NOW - 280, NOW - 100);
  check(taskShow(db, gen, { now: NOW, switchesFor: resolver() }).model === "model-new",
    "control: and the new generation's own run IS reported");
}


// ── WAITING_FOR_QUOTA: the row this reads, and the row nothing writes ───────
//
// THE FIXTURE IS BUILT BY CALLING THE PRODUCER. `insertLease` is what writes a
// provider_lease row, and a hand-written INSERT is a fixture describing a system
// that may not exist — which is how the previous version of this block passed
// while the derivation could never fire.
{
  const q = (await file({ title: "a capacity-blocked task", territory: ["packages/q2"] })).task;
  setPhase(q, "SIZING");
  const ref = builderRunRef(q, "SIZING");
  insertLease(db, { owner: "builder", repoId: 1, runRef: ref, pid: 991, lstart: "L",
                    priority: 0, budgetUsd: null, status: "queued",
                    at: NOW - 77, expiresAt: NOW + 300, token: "tok-q" });
  const m = taskShow(db, q, { now: NOW, switchesFor: resolver() });
  check(m.waiting.all.includes("WAITING_FOR_QUOTA"),
    "a queued builder lease written by insertLease IS WAITING_FOR_QUOTA", JSON.stringify(m.waiting));
  check(m.waiting.since === NOW - 77,
    "and `since` is that row's requested_at", String(m.waiting.since));

  // AND THE GAP, RECORDED RATHER THAN LEFT AS A FALSE GREEN.
  //
  // `claimProvider` inserts a queued row at exactly ONE site, inside
  // `if (owner === "guardian")`. Every builder refusal — cooldown, a queued
  // guardian, at-limit — returns without writing anything. So no production path
  // produces the row this derivation reads, and the assertions above prove the
  // QUERY is correct while proving nothing about whether it can ever fire.
  //
  // Recorded here as a tested fact so the task that makes the builder queue finds
  // this assertion red and knows the reader is already waiting for it.
  const PROV = readFileSync(new URL("../src/provider.mjs", import.meta.url), "utf8");
  const queuedInserts = [...PROV.matchAll(/status:\s*"queued"/g)].length;
  check(queuedInserts === 1,
    `control: provider.mjs writes a queued lease at exactly one site (${queuedInserts})`,
    String(queuedInserts));
  const guardianOnly = /owner === "guardian"[\s\S]*?status: "queued"/.test(PROV);
  check(guardianOnly,
    "KNOWN GAP: the only queued-lease writer is the guardian branch, so no builder " +
    "task can reach WAITING_FOR_QUOTA in production yet", String(guardianOnly));
  // COUNTER-CONTROL: the extraction finds the shape in a literal it has never
  // seen, so `guardianOnly` above is a real read rather than a dead regex.
  check(/owner === "guardian"[\s\S]*?status: "queued"/.test(
          'if (owner === "guardian") { insertLease({ status: "queued" }) }'),
    "counter-control: the same pattern matches a literal containing it");
  db.prepare("DELETE FROM provider_lease WHERE run_ref = ?").run(ref);
}

// ── a lease whose pin has expired is not this task's territory ──────────────
{
  const t = (await file({ title: "a pinned task", territory: ["packages/t2"] })).task;
  const held = taskShow(db, t, { now: NOW, switchesFor: resolver() });
  check(held.territory.length === 1,
    "control: an ordinary task shows the territory it holds", JSON.stringify(held.territory));

  // A HELD phase with a live pin still holds it.
  db.prepare("UPDATE territory_lease SET pinned_until = ? WHERE task = ?")
    .run(Math.floor(Date.now() / 1000) + 3600, t);
  setPhase(t, "BLOCKED");
  check(taskShow(db, t, { now: NOW, switchesFor: resolver() }).territory.length === 1,
    "a held task with a LIVE pin still holds its territory");

  // Past the pin, nothing sweeps the row — but `liveLeases` has already stopped
  // treating it as excluding anyone, so another task may take those paths. Showing
  // it claims ownership the task no longer has.
  db.prepare("UPDATE territory_lease SET pinned_until = ? WHERE task = ?")
    .run(Math.floor(Date.now() / 1000) - 60, t);
  const expired = taskShow(db, t, { now: NOW, switchesFor: resolver() });
  check(expired.territory.length === 0,
    "once the pin has expired the territory is no longer reported as this task's",
    JSON.stringify(expired.territory));
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task = ?").get(t).c === 1,
    "control: and the ROW is still there, so the change is the predicate and not a delete");

  // The predicate is the reaper's own, imported rather than restated: the same
  // row must read the same way to both.
  check(liveLeases(db, "alpha").filter(l => l.task === t).length === 0,
    "control: liveLeases agrees the lease is not live, which is the predicate being shared");
}

// ── the lineage keeps what completed ───────────────────────────────────────
{
  const done = (await file({ title: "a finished task", territory: ["packages/dn"] })).task;
  db.prepare(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at,merged_sha)
              VALUES(?, 'spec', NULL, NULL, 9, 41, 'headM', ?, 'mergedsha')`).run(done, NOW - 500);
  const m = whyModel(db, done, { now: NOW });
  check(m.prs.length === 1 && m.prs[0].merged_sha === "mergedsha",
    "why keeps a MERGED pull request, with the sha it merged as", JSON.stringify(m.prs));
  check(!m.absent.includes("prs"),
    "so the section is not absent for a task whose work completed", JSON.stringify(m.absent));
  // AND THE RENDER SAYS SO. Carrying `merged_sha` in the model while the text
  // printed a merged row identically to an open one is the same seam that hid
  // DRIFT and the floors: the default renderer is what an operator reads.
  const text = renderWhy(m);
  check(/MERGED mergedsha/.test(text),
    "and the human render says it MERGED, with the receipt", text.slice(0, 900));

  // CONTROL: `show` still answers the present tense with open rows only, or the
  // two readers have collapsed into one wrong one.
  check(taskShow(db, done, { now: NOW, switchesFor: resolver() }).prs.length === 0,
    "control: and `show` still reports no OPEN pull request for it");
}

// ── the gate lineage keeps its generation and names its witness ────────────
{
  const w = (await file({ title: "a witnessed round", territory: ["packages/w2"] })).task;
  db.prepare(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at)
              VALUES(?, 'spec', NULL, NULL, 8, 51, 'headW', ?)`).run(w, NOW - 400);
  db.prepare(`INSERT INTO gate_request(task,spec_repo_id,spec_pr,head_sha,round,task_generation,requested_at)
              VALUES(?,8,51,'headW',0,1,?)`).run(w, NOW - 350);
  db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,
                                   kind,verdict,observed_at,source_id,task_generation)
              VALUES(?,8,51,'headW',7,'chatgpt-codex-connector','codex_clean','clean',?, 'cmt-900',1)`)
    .run(w, NOW - 300);

  const g = whyModel(db, w, { now: NOW }).gate[0];
  check(g.task_generation === 1,
    "each gate round carries the generation it belongs to", JSON.stringify(g));
  check(g.codex_clean === true && g.codex_evidence?.source_id === "cmt-900",
    "and the clean pass names its witness rather than reducing to a boolean",
    JSON.stringify(g.codex_evidence));
  check(g.codex_evidence?.actor === "chatgpt-codex-connector",
    "with the actor that produced it", JSON.stringify(g.codex_evidence));

  // Several clean rows can exist at one head; the GOVERNING one is the newest.
  db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,
                                   kind,verdict,observed_at,source_id,task_generation)
              VALUES(?,8,51,'headW',7,'chatgpt-codex-connector','codex_clean','clean',?, 'cmt-901',1)`)
    .run(w, NOW - 100);
  check(whyModel(db, w, { now: NOW }).gate[0].codex_evidence?.source_id === "cmt-901",
    "and when a head has two clean passes the NEWEST is the one named",
    JSON.stringify(whyModel(db, w, { now: NOW }).gate[0].codex_evidence));
}

// ── an unreadable profile is unknown even where no switch was needed ───────
{
  const b = (await file({ title: "a blocked task", territory: ["packages/bk"] })).task;
  setPhase(b, "BLOCKED");
  check(NEEDS_SWITCH.BLOCKED === undefined,
    "control: BLOCKED needs no switch, so no capability decision is made for it");
  const m = taskShow(db, b, { now: NOW, switchesFor: switchesResolver({}, readProfile) });
  check(m.switches === null, "control: and the profile could not be read", JSON.stringify(m.switches));
  check(m.waiting.capability_known === true,
    "control: capability_known stays true, because nothing needed a capability",
    JSON.stringify(m.waiting));
  check(m.unknown.includes("switches"),
    "yet `switches` is still named unknown, so the model does not contradict its own null",
    JSON.stringify(m.unknown));
}


// ── every value the lineage MODEL carries must reach the text ──────────────
//
// FOUR findings in this branch have been one shape: a field reaches the model
// and the human renderer drops it. DRIFT, the sizing floors, the merge receipt,
// and now a run's generation. Each was fixed by hand, and the fourth is the
// signal that hand-fixing is the wrong response — the next field added will be
// the fifth.
//
// So this is derived, not enumerated: for each row-shaped section, EVERY column
// the model carries must appear in `renderWhy`'s output. A field added to a
// projection is covered the day it is added, and leaving one out of the text
// becomes a deliberate act with a written reason rather than an oversight.
{
  const t = (await file({ title: "a fully populated lineage", territory: ["packages/rv"] })).task;
  setPhase(t, "RESEARCH");
  // Distinctive values throughout, so a match in the render is this field's and
  // not a coincidence of some short shared string.
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,outcome,
                                    model_id,cli_version,effort,max_turns,max_budget_usd,
                                    snapshot_hash,contract_drift,argv_hash,prompt_hash,
                                    settings_hash,tools_hash,agents_hash,canary_id)
              VALUES(?,7,'SIZING',3,5,'succeeded',777,'L',?,?,?,'/o','/e','OUTCOME-zq',
                     'model-zq','cli-zq','effort-zq',91,3.5,'snap-zq','drift-zq','argv-zq',
                     'prompt-zq','settings-zq','tools-zq','agents-zq','canary-zq')`)
    .run(t, NOW - 900, NOW - 880, NOW - 600);

  // EVERY row-shaped section gets a row, or the walk below is vacuous for the
  // ones it cannot see — which is how the first version of this guard covered
  // `runs` alone and missed `gate` and `drain` entirely.
  db.prepare(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at,merged_sha)
              VALUES(?, 'spec', NULL, NULL, 31, 4242, 'head-zq', ?, 'merged-zq')`).run(t, NOW - 700);
  db.prepare(`INSERT INTO gate_request(task,spec_repo_id,spec_pr,head_sha,round,task_generation,requested_at)
              VALUES(?,31,4242,'head-zq',6,7,?)`).run(t, NOW - 690);
  db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,
                                   kind,verdict,observed_at,source_id,task_generation)
              VALUES(?,31,4242,'head-zq',3,'witness-zq','codex_clean','clean',?, 'source-zq',7)`)
    .run(t, NOW - 680);
  db.prepare("INSERT INTO hold_reason(task,reason,detail,at,cleared_at) VALUES(?,?,?,?,?)")
    .run(t, "reason-zq", "detail-zq", NOW - 670, NOW - 660);
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
              VALUES(?,?,'drain.fence','RESEARCH','RESEARCH',7,7,'{}')`).run(t, NOW - 665);
  const fence = db.prepare("SELECT seq FROM phase_event WHERE task = ? ORDER BY seq DESC LIMIT 1").get(t).seq;
  db.prepare(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,args,status,
                                not_before,created_at,updated_at)
              VALUES('idem-zq','notify',?,7,?,'{}','done',0,?,?)`).run(t, fence, NOW - 660, NOW - 660);
  const obId = db.prepare("SELECT id FROM outbox ORDER BY id DESC LIMIT 1").get().id;
  db.prepare(`INSERT INTO task_drain(task,outbox_id,recorded_at,settled_at,forced,last_known)
              VALUES(?,?,?,NULL,1,'lastknown-zq')`).run(t, obId, NOW - 650);

  const m = whyModel(db, t, { now: NOW });
  const text = renderWhy(m);
  check(m.runs.length === 1, "control: the fixture produced exactly one run row", String(m.runs.length));

  // The exclusions, each with a reason. Anything NOT named here must render.
  // Keyed by section, because a field named `at` means something different in a
  // hold than in a gate round and a shared list would exempt both.
  const EXCLUDED = {
    runs: { started_at: "a timestamp the render formats elsewhere" },
    gate: { requested_at: "a timestamp the render formats elsewhere",
            // Booleans render as WORDS, which is what an operator can read: the
            // literal `true` never appears and should not.
            codex_clean: "rendered as the words `clean` or `not yet`",
            founder_acked: "rendered as the verdict, or the words `not yet`" },
    drain: { recorded_at: "a timestamp the render formats elsewhere",
             settled_at: "rendered as the words `settled` or `OPEN`" },
    prs: { created_at: "a timestamp the render formats elsewhere",
           generation: "null on a spec row, and carried by the run lines",
           slice: "null on a spec row, and carried by the run lines",
           task: "the row's own task, already the first line of the render",
           repo_id: "the numeric id; the render names the human-readable kind and number" },
    holds: { at: "a timestamp the render formats elsewhere" },
  };
  // EVERY row-shaped section, not only `runs`. The first version of this guard
  // covered runs alone and the very next review round found the same defect in
  // `gate` and in `drain` -- a guard narrower than its class is a guard that will
  // be outflanked by the next instance.
  const rows = (section) => {
    const v = m[section];
    return Array.isArray(v) ? v : (v ? [v] : []);
  };
  const missing = [];
  for (const section of Object.keys(EXCLUDED))
    for (const row of rows(section))
      for (const [k, v] of Object.entries(row)) {
        if (k in EXCLUDED[section]) continue;
        if (v === null || v === undefined || v === "") continue;
        if (typeof v === "object") continue;          // nested evidence, asserted by name below
        if (!text.includes(String(v))) missing.push(`${section}.${k}=${JSON.stringify(v)}`);
      }
  check(missing.length === 0,
    "every value a lineage row carries into the model reaches the human render",
    `not rendered: ${missing.join(", ")}\n        ` +
    "Either render it, or name it in EXCLUDED with the reason it is deliberately absent.");
  check(Object.keys(EXCLUDED).every(sec => rows(sec).length > 0),
    "control: every section this walks actually has a row in the fixture, so none is vacuous",
    JSON.stringify(Object.fromEntries(Object.keys(EXCLUDED).map(x => [x, rows(x).length]))));

  // COUNTER-CONTROL: the check can FAIL. A value the model does not carry must be
  // reported missing, or the loop above passes on any render at all.
  const probe = [];
  for (const [k, v] of Object.entries({ ...m.runs[0], ghost_field: "ghost-zq" })) {
    if (k in EXCLUDED.runs || v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    if (!text.includes(String(v))) probe.push(k);
  }
  check(probe.length === 1 && probe[0] === "ghost_field",
    "counter-control: a value the render does NOT contain is reported missing",
    JSON.stringify(probe));

  // And the finding that produced this guard, asserted directly so the reason is
  // legible without reading the loop.
  check(/gen 7/.test(text),
    "a run's generation is in the human lineage, so two contract epochs are distinguishable",
    (text.match(/.*SIZING\/3.*/) ?? [""])[0]);

  // The nested evidence objects the walk above skips, asserted BY NAME. A value
  // the loop cannot reach is a value the loop cannot guard, and saying so here is
  // cheaper than teaching it to recurse into shapes that are not rows.
  check(/witness-zq/.test(text) && /source-zq/.test(text),
    "the governing Codex witness is in the human gate line, not only under --json",
    (text.match(/.*round 6.*/) ?? [""])[0]);
}

// ── a founder acknowledgement answers the pass it was given ────────────────
{
  const a = (await file({ title: "an acked round", territory: ["packages/ak"] })).task;
  db.prepare(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at)
              VALUES(?, 'spec', NULL, NULL, 12, 61, 'headK', ?)`).run(a, NOW - 400);
  db.prepare(`INSERT INTO gate_request(task,spec_repo_id,spec_pr,head_sha,round,task_generation,requested_at)
              VALUES(?,12,61,'headK',0,1,?)`).run(a, NOW - 350);
  const cleanPass = (src, at) => db.prepare(
    `INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,
                          kind,verdict,observed_at,source_id,task_generation)
     VALUES(?,12,61,'headK',7,'codex','codex_clean','clean',?,?,1)`).run(a, at, src);

  cleanPass("pass-old", NOW - 300);
  db.prepare(`INSERT INTO notice_receipt(task,head_sha,clean_source_id,channel,kind,delivered_at)
              VALUES(?,'headK','pass-old','cli','founder_ack',?)`).run(a, NOW - 250);
  const one = whyModel(db, a, { now: NOW }).gate[0];
  check(one.founder_acked === true && one.codex_evidence?.source_id === "pass-old",
    "control: the founder acknowledged the only clean pass, and the round reads acked",
    JSON.stringify(one));

  // A NEWER clean pass arrives at the same head. It governs, and the founder has
  // never seen it — so the round is no longer answered, and reporting `acked`
  // beside a witness naming the new source is two halves of one answer disagreeing.
  cleanPass("pass-new", NOW - 100);
  const two = whyModel(db, a, { now: NOW }).gate[0];
  check(two.codex_evidence?.source_id === "pass-new",
    "control: the newer pass governs", JSON.stringify(two.codex_evidence));
  check(two.founder_acked === false,
    "and an acknowledgement of the OLDER source does not answer the newer pass",
    JSON.stringify(two));
  check(two.founder_evidence === null,
    "so no founder evidence is claimed for a pass the founder never saw",
    JSON.stringify(two.founder_evidence));
}


// ── a persisted title cannot forge a row in the listing ────────────────────
//
// `normalizeFiling` refuses only an EMPTY title, so a newline is accepted and
// persisted. Measured before this change: filing one task titled
// "first\nbt:fake  DONE  forged" produced a TWO-LINE listing whose second line
// carried a plausible id and a terminal phase -- a task that does not exist,
// indistinguishable from one that does in the view an operator scans first.
{
  const forged = "first\nbt:fake  DONE  forged";
  const f = await file({ title: forged, territory: ["packages/fg"] });
  check(f?.ok === true,
    "control: the producer ACCEPTS a title containing a newline, which is why the render must handle it",
    JSON.stringify(f)?.slice(0, 160));
  check(db.prepare("SELECT title FROM task WHERE id = ?").get(f.task).title === forged,
    "control: and stores it verbatim, so this is about rendering and not about filing");

  const rows = taskList(db, { now: NOW, switchesFor: resolver() });
  const mine = rows.filter(m => m.id === f.task);
  const line = renderList(mine);
  check(line.split("\n").length === 1,
    `one task renders as ONE row (got ${line.split("\n").length})`, JSON.stringify(line));
  check(!line.includes("\n") && line.includes("bt:fake"),
    "and the forged text is still shown, on that row, rather than silently dropped",
    JSON.stringify(line));

  // CONTROL: the sanitiser is about control characters, not about mangling text.
  // An ordinary title must survive byte for byte.
  const ordinary = rows.filter(m => m.title === "the capability task");
  check(ordinary.length === 1, "control: there is an ordinary-titled task to compare against",
    String(ordinary.length));
  check(renderList(ordinary).includes("the capability task"),
    "control: an ordinary title is untouched", JSON.stringify(renderList(ordinary)));

  // An ESC repaints the terminal; every C0 and C1 code is meaningless in a cell.
  // Built from code points rather than written literally, so the file itself
  // carries none of what it is testing for.
  const CTRL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");
  const titleLine = renderShow(mine[0]).split("\n")[1];
  check(titleLine.includes("bt:fake") && !CTRL.test(titleLine),
    "and in `show` the title occupies its own single line, control characters replaced",
    JSON.stringify(titleLine));
  check(CTRL.test(forged),
    "counter-control: the pattern DOES match the raw title, so the absence above is real");
}

// ── a valued flag is checked by the same gate as a boolean one ─────────────
//
// The argv walk puts boolean switches in ARGS.flags and VALUED options in
// ARGS.values, so a gate reading only the first exempted every flag that takes a
// value -- a whole category, inside the mechanism written to enforce the rule.
{
  const { inapplicable, APPLIES } = await import("../bin/reeve.flags.mjs");
  check(Array.isArray(APPLIES.project) && APPLIES.project.includes("task file") &&
        APPLIES.project.includes("task list"),
    "--project is scoped to the subcommands that read it", JSON.stringify(APPLIES.project));

  check(inapplicable("task", new Set(), "show", ["project"])?.cmd === "task show",
    "a VALUED flag reaches the gate and is refused where it cannot act",
    JSON.stringify(inapplicable("task", new Set(), "show", ["project"])));
  check(inapplicable("task", new Set(), "list", ["project"]) === null,
    "control: and is allowed where it can");
  check(inapplicable("task", new Set(), "file", ["project"]) === null,
    "control: including on the subcommand that files with it");
  check(inapplicable("doctor", new Set(), "o/r", ["home"]) === null,
    "control: a valued flag with no entry is unconstrained, as the map promises");
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

  const withProject = cli("task", "show", filed.full, "--project", "alpha", "--json");
  const wp = parse(withProject.stdout);
  check(wp?.ok === false && wp?.kind === "flag_not_applicable",
    "reeve task show --project is refused through the CLI, not merely by the map",
    withProject.out.slice(0, 300));
  check(withProject.status === 2 && /task show/.test(wp?.message ?? ""),
    "naming the subcommand, and exiting misuse", `rc=${withProject.status} ${wp?.message}`);
  // CONTROL: the subcommand that DOES read it still works end to end, or the
  // change is a ban rather than a scoping.
  check(parse(cli("task", "list", "--project", "beta", "--json").stdout)?.kind === "task.list",
    "control: and `task list --project` still answers");

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


  // ── an incompatible hub is a typed refusal, not a stack trace ─────────────
  //
  // A version-1 hub OPENS PERFECTLY and has no `task_pr` -- migration 2 creates
  // it -- so every route here would reach `openPrs` and die on `no such table`,
  // which is the uncaught trace this whole surface exists to replace. A hub
  // NEWER than the binary must be refused too: `openHub` refuses it explicitly,
  // and a reader that quietly proceeds where the privileged opener stops is
  // guessing at a shape it does not know.
  {
    const old = join(dir, "oldhub", ".reeve");
    mkdirSync(join(old, "state"), { recursive: true });
    const oldDb = new DatabaseSync(join(old, "state", "hub.db"));
    oldDb.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
    oldDb.exec("INSERT INTO schema_version(version, at) VALUES (1, 1)");
    oldDb.close();
    check(completedVersion(join(old, "state", "hub.db")) === 1,
      "control: the fixture really is a version-1 hub, and it opens",
      String(completedVersion(join(old, "state", "hub.db"))));
    check(HUB_SCHEMA_VERSION > 1,
      `control: this binary speaks a later version (${HUB_SCHEMA_VERSION}), so the gate has something to refuse`);

    const r = spawnSync(process.execPath, [BIN, "task", "list", "--home", old, "--json"],
      { encoding: "utf8", timeout: 60_000 });
    const j = parse(r.stdout ?? "");
    check(j?.ok === false && j?.kind === "hub_incompatible",
      "a hub older than this binary is a typed refusal", ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 300));
    check(!/no such table/.test((r.stdout ?? "") + (r.stderr ?? "")),
      "and never the `no such table: task_pr` the unguarded read produced",
      ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 300));
    check(r.status === 1, "exiting refused", `rc=${r.status}`);
    // THE PROPERTY, not the wording. This asserted the literal "schema version 1",
    // which is one phrasing of "says what the store carries". The refusal is now
    // rendered from `historyFault`, which names what it carries and what this
    // binary expects; an operator needs both ends and does not need either
    // sentence.
    check(/carries 1\b/.test(j?.message ?? "") && new RegExp(`through ${HUB_SCHEMA_VERSION}`).test(j?.message ?? ""),
      "naming both versions, so an operator knows which end is behind", String(j?.message));

    // NEWER than the binary, which is the other direction and a different remedy.
    const ahead = join(dir, "newhub", ".reeve");
    mkdirSync(join(ahead, "state"), { recursive: true });
    const aheadDb = new DatabaseSync(join(ahead, "state", "hub.db"));
    aheadDb.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
    aheadDb.prepare("INSERT INTO schema_version(version, at) VALUES (?, 1)").run(HUB_SCHEMA_VERSION + 1);
    aheadDb.close();
    const a = spawnSync(process.execPath, [BIN, "task", "list", "--home", ahead, "--json"],
      { encoding: "utf8", timeout: 60_000 });
    const aj = parse(a.stdout ?? "");
    // Both halves, because the direction is the whole point: it must send the
    // operator at the BINARY and must not suggest changing the store, which for a
    // forward-only history would be a downgrade that cannot be undone.
    check(aj?.kind === "hub_incompatible" && /newer binary/.test(aj?.message ?? "")
          && !/\bdowngrad/i.test(aj?.message ?? ""),
      "a hub newer than this binary is refused too, and says to upgrade reeve rather than the store",
      String(aj?.message));

    // CONTROL: the gate is about the VERSION. The real hub, at the current
    // version, still answers -- or the refusal above is just a broken route.
    check(parse(cli("task", "list", "--json").stdout)?.kind === "task.list",
      "control: a hub at the current version still answers");
  }


    // A MAXIMUM IS NOT A HISTORY. A damaged or hand-repaired hub recording 1 and
    // 3 but missing 2 passes an equality against the current version and then
    // dies on `no such table: task_pr`, because migration 2 is what creates it.
    // Same uncaught trace, second door.
    {
      const holed = join(dir, "holedhub", ".reeve");
      mkdirSync(join(holed, "state"), { recursive: true });
      const h = new DatabaseSync(join(holed, "state", "hub.db"));
      h.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
      for (const v of [1, HUB_SCHEMA_VERSION]) h.prepare("INSERT INTO schema_version(version,at) VALUES(?,1)").run(v);
      h.close();
      check(completedVersion(join(holed, "state", "hub.db")) === HUB_SCHEMA_VERSION,
        `control: completedVersion answers ${HUB_SCHEMA_VERSION} for this hub, so a maximum check would PASS it`,
        String(completedVersion(join(holed, "state", "hub.db"))));

      const r = spawnSync(process.execPath, [BIN, "task", "list", "--home", holed, "--json"],
        { encoding: "utf8", timeout: 60_000 });
      const j = parse(r.stdout ?? "");
      check(j?.kind === "hub_incompatible",
        "a hub missing a migration in the middle is refused, though its maximum is current",
        ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 300));
      // DERIVED from the fixture, not written down beside it. The fixture records
      // 1 and the current maximum, so the hole is every version in between --
      // which was exactly {2} while the maximum was 3, and became {2,3} the first
      // time the schema gained a migration. A hardcoded "migration 2" then stopped
      // describing the hub this block builds, and the assertion failed for a
      // reason with nothing to do with the refusal it exists to test.
      const holes = [];
      for (let v = 2; v < HUB_SCHEMA_VERSION; v++) holes.push(v);
      check(holes.length > 0,
        "control: the fixture actually creates a hole, so the assertion below is not vacuous",
        `HUB_SCHEMA_VERSION=${HUB_SCHEMA_VERSION} holes=${holes.join(",") || "none"}`);
      const named = /missing migration\(s\) ([\d, ]+?) \(/.exec(j?.message ?? "");
      const listed = named ? named[1].split(",").map(x => x.trim()).filter(Boolean) : [];
      check(named !== null && listed.length === holes.length
            && holes.every(v => listed.includes(String(v))),
        "and the refusal names WHICH migration is missing", String(j?.message));
      // THE REMEDY, which is what #121 reported and what nothing here asserted.
      // A HOLE and a missing TAIL both arrive as a non-empty `missing`, and only
      // one of them migrates: `openHub` re-runs a tail and refuses a hole
      // outright, because a migration beneath an applied one cannot be re-run
      // over a store that has already moved past it. Sending a holed hub to the
      // writing command sends the operator to a second refusal -- and that second
      // refusal is the one naming the repair.
      check(/\bHOLE\b/.test(j?.message ?? "") && /restore a snapshot/i.test(j?.message ?? ""),
        "and a HOLE is sent to a snapshot restore, not to a command that writes",
        String(j?.message));
      check(!/reeve build run/.test(j?.message ?? ""),
        "and never to `reeve build run`, which refuses a holed history",
        String(j?.message));
      check(!/no such table/.test((r.stdout ?? "") + (r.stderr ?? "")),
        "and never the `no such table` the maximum check let through",
        ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 200));
    }

    // SQLITE READS LAZILY. A hub whose corruption lies outside the pages the open
    // touches constructs a connection perfectly and fails at the FIRST REAL
    // QUERY -- past every guard, and out through an uncaught stack trace.
    {
      const rotten = join(dir, "rottenhub", ".reeve");
      mkdirSync(join(rotten, "state"), { recursive: true });
      const path = join(rotten, "state", "hub.db");
      const r0 = new DatabaseSync(path);
      r0.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
      for (let v = 1; v <= HUB_SCHEMA_VERSION; v++)
        r0.prepare("INSERT INTO schema_version(version,at) VALUES(?,1)").run(v);
      r0.close();
      // Every version is present and the file opens; the tables the routes query
      // are simply not there. That is what a query-time failure looks like from
      // the outside, and it is the shape the open-time guard cannot see.
      const r = spawnSync(process.execPath, [BIN, "task", "list", "--home", rotten, "--json"],
        { encoding: "utf8", timeout: 60_000 });
      const both = (r.stdout ?? "") + (r.stderr ?? "");
      const j = parse(r.stdout ?? "");
      check(j?.ok === false && j?.kind === "hub_unreadable",
        "a hub that fails at QUERY time is a typed refusal, not a stack trace", both.slice(0, 300));
      check(!/^\s*(Error|TypeError)\b/m.test(both) && !/ at .*\.mjs:/.test(both),
        "and no stack trace reaches the operator", both.slice(0, 300));
      check(typeof j?.retryable === "boolean",
        "carrying a retryable bit, so an operator knows whether trying again can help",
        JSON.stringify(j));
      check(j?.retryable === false,
        "and damage is NOT retryable, because retrying a broken file forever is the wrong advice",
        JSON.stringify(j));

      // AND A HUB WHOSE schema_version ITSELF CANNOT BE READ. That is a different
      // path from the query-time failure above: the history read fails, so the
      // route never reaches an application query at all.
      //
      // ASSERTING THE CAUSE REACHES THE OPERATOR, not merely that `retryable` is
      // a boolean. `migrationStateOf` swallows the exception, and the first
      // version of this refusal hard-coded `retryable: false` -- which passes any
      // assertion about the bit's VALUE while telling a client not to retry a hub
      // another process was holding past the busy timeout. The observable that
      // only exists when the cause survives is the cause itself, in the message.
      const noHist = mkdtempSync(join(tmpdir(), "reeve-nohist-"));
      mkdirSync(join(noHist, "state"), { recursive: true });
      const nh = new DatabaseSync(join(noHist, "state", "hub.db"));
      nh.exec("CREATE TABLE placeholder (x INTEGER)");
      nh.close();
      const nr = spawnSync(process.execPath, [BIN, "task", "list", "--home", noHist, "--json"],
        { encoding: "utf8", timeout: 60_000 });
      const nj = parse(nr.stdout ?? "");
      check(nj?.kind === "hub_unreadable",
        "a hub whose schema_version cannot be read is a typed refusal",
        ((nr.stdout ?? "") + (nr.stderr ?? "")).slice(0, 300));
      check(/no such table: schema_version/.test(nj?.message ?? ""),
        "an unreadable schema_version is refused WITH the reason it could not be read",
        `the reason is what decides whether retrying can help, and it is the thing a swallowed exception loses: ${JSON.stringify(nj?.message)}`);
      check(typeof nj?.retryable === "boolean",
        "control: and it still carries a retryable bit", JSON.stringify(nj));

      // THE PROJECT PREFILTER READS THE SAME BROKEN STORE. It ran outside the
      // guard, so `--project` was the one path that still escaped as a trace.
      const f = spawnSync(process.execPath, [BIN, "task", "list", "--project", "alpha", "--home", rotten, "--json"],
        { encoding: "utf8", timeout: 60_000 });
      const fb = (f.stdout ?? "") + (f.stderr ?? "");
      check(parse(f.stdout ?? "")?.kind === "hub_unreadable",
        "and `--project` fails the same typed way, not through the prefilter", fb.slice(0, 300));
      check(!/ at .*\.mjs:/.test(fb),
        "with no stack trace either", fb.slice(0, 300));
    }

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
