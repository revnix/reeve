// The dash and `task show` are two renderings of ONE value.
//
// A dash that re-queries for its text is a second implementation of the same
// question: each half is individually correct, they disagree under exactly the
// conditions nobody tested, and neither half reports that it disagreed.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openHub, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
import { DatabaseSync } from "node:sqlite";
import { fileTask } from "../src/build/taskfile.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { validate, withDefaults } from "../src/profile/schema.mjs";
import { CAPABILITY_NAMES } from "../src/build/capabilities.mjs";
import { LEASE_SECONDS } from "../src/build/locks.mjs";
import { TERMINAL } from "../src/build/phases.mjs";
import { TABLE_OWNERS } from "../src/build/tables.mjs";
import {
  READ_FORMAT_VERSION, UNKNOWN, HUMAN_WAITS, WAITING, NEEDS_SWITCH, ageInState,
  taskShow, switchesResolver, switchesFrom, builderRunRef,
} from "../src/build/show.mjs";
import { dashModel, renderDash, parseCursor, formatCursor } from "../src/build/dash.mjs";
const atOfSeq = (seq) => db.prepare("SELECT at FROM phase_event WHERE seq = ?").get(seq)?.at ?? 0;

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-dash-"));
const NOW = 1_800_000_000;

// ── the fixture is built by CALLING the producer ─────────────────────────────
const HOME = join(dir, ".reeve");
const repo = join(HOME, "repo");
for (const d of ["x", "y", "z", "c", "h"]) mkdirSync(join(repo, "packages", d), { recursive: true });
mkdirSync(join(HOME, "state"), { recursive: true });

const ALL_ON = Object.fromEntries(CAPABILITY_NAMES.map(n => [n, true]));
const profileFor = (key, caps) => ({
  schemaVersion: 1, project: { kind: "product" },
  identity: { key, defaultBranch: "main", visibility: "private" },
  authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "committed" },
  state: { mode: "in-repo" },
  units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm" }],
  ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "enforced" },
  builder: { capabilities: caps },
});
const pathA = join(repo, "a.json"), pathB = join(repo, "b.json");
const writeProfiles = (a, b) => {
  writeFileSync(pathA, JSON.stringify(profileFor("o/a", a)) + "\n");
  writeFileSync(pathB, JSON.stringify(profileFor("o/b", b)) + "\n");
};
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
const resolver = () => switchesResolver(entries, readProfile, { validate });
const PROJECTS = [{ name: "alpha", nwo: "o/a" }, { name: "beta", nwo: "o/b" }];

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
const ALIVE = () => true, DEAD = () => false;
const cur = (seq, at) => ({ seq, at });
const headAt = () => db.prepare("SELECT at FROM phase_event ORDER BY seq DESC LIMIT 1").get()?.at ?? 0;
const dash = (over = {}) =>
  dashModel(db, { now: NOW, switchesFor: resolver(), projects: PROJECTS, since: null,
                  isAlive: ALIVE, ...over });

const T = {};
{
  const admit = async (key, over) => {
    const r = await file(over);
    check(r?.ok === true && typeof r.task === "string",
      `control: the producer admitted the ${key} task`, JSON.stringify(r)?.slice(0, 200));
    T[key] = r.task;
  };
  await admit("moving", { title: "a moving task", territory: ["packages/x"] });
  await admit("held",   { title: "a held task",   territory: ["packages/y"] });
  await admit("quota",  { title: "a queued task", territory: ["packages/z"] });
  await admit("cancel", { title: "a cancelling task", territory: ["packages/c"] });
  await admit("beta",   { title: "another project", project: "beta", territory: ["packages/h"] });
  setPhase(T.moving, "SIZING");
  setPhase(T.quota, "SIZING");
  setPhase(T.cancel, "CANCELLING");
}

// ── one object, two renderings ───────────────────────────────────────────────
{
  const m = dash();
  const text = renderDash(m);
  const json = JSON.parse(JSON.stringify(m));
  check(json.tasks.length === 5, `every task is in the model (got ${json.tasks.length})`,
    json.tasks.map(t => t.id).join(","));
  for (const t of json.tasks) {
    check(text.includes(t.id), `the text names ${t.id}, and so does the JSON`, text.slice(0, 200));
    check(text.includes(t.phase), `and its phase ${t.phase}`, text.slice(0, 200));
  }

  // THE assertion: mutate the ONE object and the text moves with it. A dash that
  // re-reads the database produces the same text from a changed model, and every
  // assertion above still passes.
  m.tasks[0].phase = "ZZZTEST";
  check(renderDash(m).includes("ZZZTEST"),
    "the text renders from the model it is handed, not from a second read of the database",
    renderDash(m).slice(0, 200));

  // And the module prepares no statement of its own beyond the two it declares,
  // so "computes nothing show cannot see" is structural rather than hoped for.
  const SRC = readFileSync(new URL("../src/build/dash.mjs", import.meta.url), "utf8");
  const prepares = [...SRC.matchAll(/db\.prepare\(/g)].length;
  check(prepares === 6,
    `the dash prepares exactly the six statements it declares (${prepares})`,
    "the singleton lease, the last orderly release, the builder-scoped escalations, the log head, " +
    "the cursor's own row, and the event log for --since. NOTHING per task: every task fact comes " +
    "from taskList, and a seventh statement here means a question the dash is answering that " +
    "`task show` cannot.");
  check(/db\.prepare\(/.test('x db.prepare( y'),
    "counter-control: the extraction matches a literal containing the call");
}

// ── the model is taskShow's, not a parallel one ──────────────────────────────
{
  const m = dash();
  const direct = taskShow(db, T.moving, { now: NOW, switchesFor: resolver() });
  const inDash = m.tasks.find(t => t.id === T.moving);
  for (const k of Object.keys(direct))
    check(JSON.stringify(inDash[k]) === JSON.stringify(direct[k]),
      `the dash's ${k} is byte-identical to task show's`,
      `dash ${JSON.stringify(inDash[k])} vs show ${JSON.stringify(direct[k])}`);
  check(Object.keys(direct).every(k => k in inDash),
    "the dash's task carries every field show does, so the dash computes nothing show cannot see",
    Object.keys(direct).filter(k => !(k in inDash)).join(","));
  check(m.format_version === READ_FORMAT_VERSION,
    "the dash shares the read model's format version rather than declaring a second",
    String(m.format_version));
}

// ── age-in-state comes from the event log, never from updated_at ─────────────
//
// `task.updated_at` is written by transition compensations that change no phase.
// The measured instance of the class is that a pull request's updated_at does not
// move when a review thread is resolved; the class is general -- a column touched
// by writes unrelated to the change being measured is not a change signal.
{
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
              VALUES(?,?,'dispatch.sizing','FILED','SIZING',1,1,'{}')`).run(T.moving, NOW - 600);
  // THE TRAP: touch updated_at to now, as a phase-preserving compensation would.
  // A dash reading that column answers "0 seconds" for a task stuck ten minutes.
  db.prepare("UPDATE task SET updated_at = ? WHERE id = ?").run(NOW, T.moving);

  const t = dash().tasks.find(x => x.id === T.moving);
  check(t.age?.seconds === 600, "age-in-state is 600s, from the phase_event that entered this phase",
    JSON.stringify(t.age));
  check(t.age?.from === "phase_event", "and it names which column it came from", JSON.stringify(t.age));
  check(t.age?.from !== "updated_at",
    "and never updated_at, which a phase-preserving compensation moves", JSON.stringify(t.age));

  // CONTROL: a newer event entering the same phase moves the age. Without this
  // the assertion above passes on a constant.
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
              VALUES(?,?,'resume','SIZING','SIZING',1,2,'{}')`).run(T.moving, NOW - 60);
  check(dash().tasks.find(x => x.id === T.moving).age.seconds === 60,
    "control: a newer event entering the same phase moves the age");

  // An event entering a DIFFERENT phase must not. Without this, "max(at)" passes
  // as the derivation and the age becomes "time since anything happened".
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
              VALUES(?,?,'noise','SIZING','RESEARCH',2,2,'{}')`).run(T.moving, NOW - 5);
  check(dash().tasks.find(x => x.id === T.moving).age.seconds === 60,
    "control: an event entering ANOTHER phase does not, so this is age in THIS state");
  db.prepare("DELETE FROM phase_event WHERE task = ? AND op = 'noise'").run(T.moving);

  // A task with no event: created_at, and it SAYS so. Not zero and not a throw,
  // both of which read as an answer.
  const fresh = dash().tasks.find(x => x.id === T.held);
  check(fresh.age?.from === "created_at",
    "a task with no phase_event falls back to created_at and names the fallback",
    JSON.stringify(fresh.age));
  check(typeof fresh.age?.seconds === "number" && fresh.age.seconds >= 0,
    "with a real elapsed figure", JSON.stringify(fresh.age));

  // The reader is reachable on its own, so the property is testable without a dash.
  const row = db.prepare("SELECT * FROM task WHERE id = ?").get(T.moving);
  check(ageInState(db, row, { now: NOW }).seconds === 60,
    "ageInState answers the same on its own, so the dash adds no second derivation");
}

// ── the five questions, and the sixth that cannot arrive quietly ─────────────
{
  const m = dash({ since: cur(0, 0) });
  const FIVE = ["alive", "doing", "waiting_on_you", "since_you_looked", "declined"];
  for (const k of FIVE) check(k in m, `the digest answers "${k}"`, Object.keys(m).join(","));
  const SUPPORTING = ["format_version", "generated_at", "projects", "switches", "tasks",
                      "since", "next_cursor", "cursor_rewound"];
  const extra = Object.keys(m).filter(k => !FIVE.includes(k) && !SUPPORTING.includes(k));
  check(extra.length === 0,
    "and nothing else, so the digest cannot grow a sixth question quietly", extra.join(","));
}

// ── what is waiting on ME, and for how long ──────────────────────────────────
{
  db.prepare("INSERT INTO hold_reason(task,reason,detail,at) VALUES(?,?,?,?)")
    .run(T.held, "blocked_founder", "needs a spec repo", NOW - 7200);
  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,?,777,'L','queued',?,?)`)
    .run(builderRunRef(T.quota, "SIZING"), NOW - 100, NOW + 300);

  const m = dash();
  const row = m.waiting_on_you.find(x => x.id === T.held);
  check(row, "a task held on the founder is in waiting_on_you",
    JSON.stringify(m.waiting_on_you.map(x => x.id)));
  check(row?.waiting === "WAITING_FOR_FOUNDER", "with the substate", JSON.stringify(row));
  check(typeof row?.for_seconds === "number" && row.for_seconds >= 7200,
    "and FOR HOW LONG, which is the half of the question a state alone does not answer",
    JSON.stringify(row));

  // CONTROL: a task waiting on the MACHINE is not waiting on you. Without this,
  // waiting_on_you passes as a synonym for "every waiting task", and the one
  // surface an operator scans becomes the one they stop scanning.
  check(!m.waiting_on_you.some(x => x.id === T.quota),
    "control: a task waiting on QUOTA is not waiting on you",
    JSON.stringify(m.waiting_on_you.map(x => x.id)));
  check(m.tasks.some(x => x.id === T.quota),
    "but it is still visible: not-yours is not the same as not-shown");

  // The set is DERIVED from the read model's own declaration, not restated here.
  check(HUMAN_WAITS.has("WAITING_FOR_CAPABILITY"),
    "a switch only the founder can flip is a wait on the founder", [...HUMAN_WAITS].join(","));
  check([...HUMAN_WAITS].every(w => WAITING.includes(w)),
    "and every human wait is one of the six", [...HUMAN_WAITS].join(","));
  check([...HUMAN_WAITS].length < WAITING.length,
    "while some waits are the machine's, or the distinction is empty",
    `${[...HUMAN_WAITS].length} of ${WAITING.length}`);

  // A capability wait reaches the list, with an elapsed figure even though a
  // switch being off is a state rather than an event.
  writeProfiles({ ...ALL_ON, observe: false }, ALL_ON);
  const off = dash();
  const cap = off.waiting_on_you.find(x => x.id === T.quota);
  check(cap?.waiting === "WAITING_FOR_CAPABILITY" && cap?.capability === "observe",
    "a task behind a switch is waiting on you, and names the switch", JSON.stringify(cap));
  check(typeof cap?.for_seconds === "number",
    "with an elapsed figure taken from the age in state, since a switch has no moment",
    JSON.stringify(cap));
  writeProfiles(ALL_ON, ALL_ON);
}

// ── a draining cancel says how many rows are left ────────────────────────────
{
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
              VALUES(?,?,'cancel.requested','SIZING','CANCELLING',1,1,'{}')`).run(T.cancel, NOW - 40);
  const fence = db.prepare("SELECT max(seq) s FROM phase_event WHERE task = ?").get(T.cancel).s;
  db.prepare(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,args,not_before,
                                 status,attempts,max_attempts,created_at,updated_at)
              VALUES('k1','notify',?,1,?,'{}',0,'pending',0,8,?,?)`).run(T.cancel, fence, NOW, NOW);
  const oid = db.prepare("SELECT id FROM outbox WHERE idempotency_key='k1'").get().id;
  db.prepare("INSERT INTO task_drain(task,outbox_id,recorded_at) VALUES(?,?,?)").run(T.cancel, oid, NOW - 30);

  const m = dash();
  check(m.tasks.find(x => x.id === T.cancel).draining === 1,
    "a CANCELLING task carries the count of rows still draining");
  check(renderDash(m).includes("draining 1"),
    "and the text says the NUMBER, because CANCELLING alone does not say whether it is nearly done",
    renderDash(m).slice(0, 400));

  db.prepare("UPDATE task_drain SET settled_at = ? WHERE task = ?").run(NOW, T.cancel);
  check(dash().tasks.find(x => x.id === T.cancel).draining === 0,
    "control: a settled row leaves the count, so the number is derived and not a flag");
}

// ── territory pins carry their expiry, beside the task ───────────────────────
{
  db.prepare("UPDATE territory_lease SET pinned_until = ? WHERE task = ?").run(NOW + 7200, T.held);
  const m = dash();
  const t = m.tasks.find(x => x.id === T.held);
  check(t.territory.length === 1, "the claim is beside the task", JSON.stringify(t.territory));
  check(t.territory[0].pinned_until === NOW + 7200,
    "and the pin carries its expiry, not just the fact of being pinned", JSON.stringify(t.territory[0]));
  const text = renderDash(m);
  check(/packages\/y/.test(text) && /pinned until/.test(text),
    "and both reach the text", text.slice(-600));
  check(TABLE_OWNERS.territory_lease.reader.includes("dash"),
    "and the table's declared readers name the dash, which is now one of them",
    TABLE_OWNERS.territory_lease.reader);
}

// ── is it alive ──────────────────────────────────────────────────────────────
//
// `singleton_lease` has NO heartbeat column: heartbeatSingleton expresses the
// beat by sliding `expires_at` forward by LEASE_SECONDS, so last-seen is the
// lease length minus what remains. LEASE_SECONDS is IMPORTED, not written as a
// number, because the derivation is sound only while the two agree.
{
  const dead = dash();
  check(dead.alive.running === false,
    "with no singleton lease the digest says the builder is not running, rather than saying nothing",
    JSON.stringify(dead.alive));
  check(dead.alive.last_seen_seconds === null,
    "and last-seen is null rather than 0, because never-seen and seen-just-now are different facts",
    JSON.stringify(dead.alive));
  check(renderDash(dead).includes("NOT RUNNING"), "and the text says so", renderDash(dead).slice(0, 120));

  db.prepare(`INSERT INTO singleton_lease(name,pid,lstart,command,acquired_at,expires_at)
              VALUES('builder',424242,'L','reeve build run',?,?)`)
    .run(NOW - 300, NOW + LEASE_SECONDS - 20);
  const live = dash();
  check(live.alive.running === true, "control: with a live lease it says running", JSON.stringify(live.alive));
  check(live.alive.last_seen_seconds === 20,
    "and how long since the heartbeat, derived from the remaining lease life",
    JSON.stringify(live.alive));
  check(live.alive.pid === 424242, "and the pid that holds it", JSON.stringify(live.alive));

  // An EXPIRED row is not a live builder. The row outlives the process -- that is
  // what makes it a lease -- so `running` reads the clock, not the row.
  db.prepare("UPDATE singleton_lease SET expires_at = ? WHERE name = 'builder'").run(NOW - 1);
  const stale = dash();
  check(stale.alive.running === true,
    "an EXPIRED lease whose holder is alive is still running: a slow tick is not a stopped builder",
    JSON.stringify(stale.alive));
  check(stale.alive.lease_unexpired === false,
    "and the stale claim is reported as its own fact, not folded into `running`",
    JSON.stringify(stale.alive));
  check(dash({ isAlive: DEAD }).alive.running === false,
    "control: the same expired lease with a DEAD holder is not running, so liveness is the process",
    JSON.stringify(dash({ isAlive: DEAD }).alive));

  // AN UNEXPIRED LEASE IS NOT A RUNNING BUILDER. A crash inside the 120-second
  // window leaves the row intact, so reading only the clock reports work
  // proceeding for up to two minutes after everything stopped.
  db.prepare("UPDATE singleton_lease SET expires_at = ? WHERE name = 'builder'")
    .run(NOW + LEASE_SECONDS - 20);
  const crashed = dash({ isAlive: DEAD });
  check(crashed.alive.running === false,
    "an unexpired lease whose HOLDER is gone is not running", JSON.stringify(crashed.alive));
  check(crashed.alive.lease_unexpired === true,
    "and the two facts stay apart, so a crash reads differently from an orderly stop",
    JSON.stringify(crashed.alive));
  check(/crashed/.test(renderDash(crashed)),
    "and the text says the lease is still held, which is what a crash looks like",
    renderDash(crashed).split("\n")[0]);
  check(dash({ isAlive: ALIVE }).alive.running === true,
    "control: the same row with a live holder IS running, so the change is the predicate");

  // LAST-SEEN IS PRINTED WHEN IT IS NOT RUNNING TOO -- that is the state where an
  // operator most needs to know whether the heartbeat was seconds or hours ago.
  check(/last seen 20s ago/.test(renderDash(crashed)),
    "and last-seen reaches the text in the NOT-RUNNING state, not only in JSON",
    renderDash(crashed).split("\n")[0]);
  db.prepare("DELETE FROM singleton_lease WHERE name = 'builder'").run();
  check(/never seen/.test(renderDash(dash())),
    "with no lease at all the text says never seen, rather than an elapsed figure",
    renderDash(dash()).split("\n")[0]);
}

// ── builder-scoped escalations reach the digest ──────────────────────────────
//
// `evidenceFor` attaches escalations whose key is prefixed by a TASK id, which is
// right for a task's own view and hides the whole `builder:` family. Those belong
// to no task and are the failures that most need an operator -- one of them, the
// merge probe, is a P0 that also writes the HALT marker.
{
  db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
              VALUES('builder:backup:failed',2,?,?,0)`).run(NOW - 500, NOW - 20);
  // A TASK-scoped row beside it, so "both kinds arrive" is asserted against a
  // hub that actually holds both rather than against one that holds neither.
  db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
              VALUES(?,1,?,?,0)`).run(`${T.held}:gate:unreviewed`, NOW - 400, NOW - 10);
  const m = dash();
  const b = m.declined.find(x => x.why === "builder:backup:failed");
  check(b, "a builder-scoped escalation is in `declined`",
    JSON.stringify(m.declined.map(x => x.why)));
  check(b?.scope === "builder" && b?.id === null,
    "marked as the builder's rather than attributed to a task that did not raise it",
    JSON.stringify(b));
  check(b?.count === 2, "with its count", JSON.stringify(b));
  check(renderDash(m).includes("builder:backup:failed"), "and it reaches the text",
    renderDash(m).slice(-600));

  // CONTROL: task-scoped rows still arrive, and are still marked as such -- or
  // the fix replaced one half of the answer with the other.
  check(m.declined.some(x => x.scope === "task"),
    "control: task-scoped escalations are still there", JSON.stringify(m.declined.map(x => x.scope)));
  check(!m.declined.some(x => x.scope === "builder" && x.id !== null),
    "and no builder row is attributed to a task");
  db.prepare("DELETE FROM escalation WHERE why = 'builder:backup:failed'").run();
  db.prepare("DELETE FROM escalation WHERE why = ?").run(`${T.held}:gate:unreviewed`);
}

// ── unknown is not a green light ─────────────────────────────────────────────
{
  const blind = dashModel(db, { now: NOW, switchesFor: switchesResolver({}, readProfile),
                                projects: PROJECTS, since: null, isAlive: ALIVE });
  const active = blind.tasks.filter(t =>
    NEEDS_SWITCH[t.phase] && !TERMINAL.includes(t.phase) && !t.running);
  check(active.length > 0, "control: there are active, non-running tasks that NEED a switch",
    String(active.length));
  check(active.every(t => t.waiting.capability_known === false),
    "control: and their switches genuinely could not be read",
    JSON.stringify(active.map(t => t.waiting.capability_known)));
  check(!blind.doing.some(t => active.some(a => a.id === t.id)),
    "a task whose capability is UNKNOWN is not reported as doing: that inference needs evidence",
    JSON.stringify(blind.doing.map(t => t.id)));
  // CONTROL: with the switches readable, the same tasks ARE doing -- or the rule
  // has simply emptied the list.
  check(dash().doing.length > 0,
    "control: with readable switches the same tasks are doing again",
    JSON.stringify(dash().doing.map(t => t.id)));
}

// ── the longest wait is first ────────────────────────────────────────────────
{
  db.prepare("INSERT INTO hold_reason(task,reason,detail,at) VALUES(?,?,?,?)")
    .run(T.quota, "blocked_founder", "a newer hold", NOW - 60);
  const last = (await file({ title: "newest, waiting longest", territory: ["packages/nw"] })).task;
  db.prepare("INSERT INTO hold_reason(task,reason,detail,at) VALUES(?,?,?,?)")
    .run(last, "blocked_founder", "the oldest wait on the newest task", NOW - 99000);

  const order = dash().tasks.map(t => t.id);
  check(order.indexOf(last) > order.indexOf(T.held),
    "control: the newest task is LAST in creation order, so creation order is not duration order",
    JSON.stringify([order.indexOf(T.held), order.indexOf(last)]));

  const w = dash().waiting_on_you;
  check(w[0]?.id === last,
    "the longest wait is first, though it belongs to the most recently created task",
    JSON.stringify(w.map(x => [x.id, x.for_seconds])));
  check(w.length >= 2, `control: at least two tasks are waiting on you (${w.length})`,
    JSON.stringify(w.map(x => [x.id, x.for_seconds])));
  check(new Set(w.map(x => x.for_seconds)).size === w.length,
    "control: and they have DIFFERENT elapsed figures, so an order exists to get wrong",
    JSON.stringify(w.map(x => x.for_seconds)));
  const secsList = w.map(x => x.for_seconds ?? -1);
  check(secsList.every((v, i) => i === 0 || secsList[i - 1] >= v),
    "waiting_on_you is ordered longest-first, because the elapsed figure exists to triage",
    JSON.stringify(w.map(x => [x.id, x.for_seconds])));
}

// ── what happened since I last looked ────────────────────────────────────────
{
  const none = dash();
  check(none.since === null && none.since_you_looked.length === 0,
    "with no --since the answer is empty rather than everything, which is what they were avoiding",
    JSON.stringify(none.since_you_looked));

  // THE CURSOR IS A SEQUENCE. An integer-second timestamp loses every transition
  // committed in the same whole second as the cursor, and loses it for ever
  // because the next cursor is later still. `next_cursor` is handed back so the
  // operator never constructs one by hand.
  const all = dash({ since: cur(0, 0) });
  check(all.since_you_looked.length > 1,
    `control: from cursor 0 the whole log is listed (${all.since_you_looked.length})`);
  check(parseCursor(all.next_cursor) !== null,
    "the digest hands back a parseable cursor for next time", String(all.next_cursor));
  check(all.next_cursor === formatCursor(parseCursor(all.next_cursor).seq,
                                         parseCursor(all.next_cursor).at),
    "and it round-trips through the pair that formats and reads it", String(all.next_cursor));

  const mid = all.since_you_looked[1].seq;
  const recent = dash({ since: cur(mid, atOfSeq(mid)) });
  check(recent.since_you_looked.every(e => e.seq > mid),
    "with a cursor, only what came AFTER it is listed",
    JSON.stringify(recent.since_you_looked.map(e => e.seq)));
  check(recent.since_you_looked.length < all.since_you_looked.length,
    "and a later cursor returns strictly less, so the bound is applied",
    `${recent.since_you_looked.length} vs ${all.since_you_looked.length}`);

  // THE DEFECT THE CURSOR CHANGE EXISTS FOR: two transitions in one whole second.
  // With a second-resolution cursor the later of them is invisible for ever.
  const t0 = db.prepare("SELECT max(seq) s FROM phase_event").get().s;
  for (const op of ["same-second-a", "same-second-b"])
    db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
                VALUES(?,?,?,'SIZING','SIZING',1,1,'{}')`).run(T.moving, NOW - 7, op);
  const both = dash({ since: cur(t0, atOfSeq(t0)) }).since_you_looked;
  check(both.filter(e => /same-second/.test(e.op)).length === 2,
    "two transitions sharing one second are BOTH returned, which a timestamp cursor cannot do",
    JSON.stringify(both.map(e => e.op)));
  const firstOfPair = both[both.length - 1];
  const afterFirst = dash({ since: cur(firstOfPair.seq, firstOfPair.at) }).since_you_looked;
  check(afterFirst.some(e => e.op === "same-second-b") &&
        !afterFirst.some(e => e.op === "same-second-a"),
    "and a cursor at the first of them still returns the second, rather than skipping the whole second",
    JSON.stringify(afterFirst.map(e => e.op)));
  check(dash({ since: parseCursor(dash({ since: cur(0, 0) }).next_cursor) }).since_you_looked.length === 0,
    "control: a cursor at the high-water mark returns nothing, so the bound is real");
}

// ── what it declined ─────────────────────────────────────────────────────────
{
  db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
              VALUES(?,3,?,?,0)`).run(`${T.held}:gate:unreviewed`, NOW - 900, NOW - 60);
  const m = dash();
  const d = m.declined.find(x => x.why === `${T.held}:gate:unreviewed`);
  check(d, "a standing escalation is in `declined`", JSON.stringify(m.declined));
  check(d?.count === 3 && d?.id === T.held,
    "with its count and the task that raised it", JSON.stringify(d));
  check(renderDash(m).includes("gate:unreviewed"), "and it reaches the text", renderDash(m).slice(-500));
  check(dash().declined.every(x => m.tasks.some(t => t.id === x.id)),
    "control: every declined row belongs to a task in the model, not a free-floating key");
}

// ── the switches are per project, and read live ──────────────────────────────
{
  writeProfiles({ ...ALL_ON, observe: false }, ALL_ON);
  const m = dash();
  check(m.switches.alpha?.observe === false && m.switches.beta?.observe === true,
    "the digest reports each project's OWN switches, not one map for all of them",
    JSON.stringify(m.switches));
  check(renderDash(m).includes("observe=off") && renderDash(m).includes("observe=on"),
    "and the text says which, by project", renderDash(m).slice(0, 400));
  writeProfiles(ALL_ON, ALL_ON);
  check(dash().switches.alpha?.observe === true,
    "control: flipping the profile back moves the answer, so it is read live and not cached");

  // A project whose profile cannot be read is UNKNOWN, never "off".
  const blind = dashModel(db, { now: NOW, switchesFor: switchesResolver({}, readProfile),
                                projects: PROJECTS, since: null, isAlive: ALIVE });
  check(blind.switches.alpha === null,
    "a project whose profile cannot be read reports null, not a map of falses",
    JSON.stringify(blind.switches));
  check(renderDash(blind).includes(UNKNOWN), "and the text says UNKNOWN out loud",
    renderDash(blind).slice(0, 400));
}

// ── terminal tasks are not `doing` ───────────────────────────────────────────
{
  check(TERMINAL.length > 0, "control: the terminal set is not empty", TERMINAL.join(","));
  setPhase(T.beta, TERMINAL[0]);
  const m = dash();
  check(!m.doing.some(x => x.id === T.beta),
    `a ${TERMINAL[0]} task is not "doing"`, JSON.stringify(m.doing.map(x => x.id)));
  check(m.tasks.some(x => x.id === T.beta),
    "but it is still in the model, because finished is a fact worth showing");
  setPhase(T.beta, "FILED");
  check(dash().doing.some(x => x.id === T.beta),
    "control: back in an active phase with nothing waiting, it is doing again");
}


// ── the age is measured from the LATEST visit, by sequence ──────────────────
//
// `seq` is INTEGER PRIMARY KEY and is the monotonic order transitions actually
// happened in. `at` is a clock reading, and a clock can move backwards -- or be
// restored non-monotonically by a replay. A task that leaves a phase and
// re-enters it can then carry a smaller `at` on the CURRENT visit than on an
// earlier one, and `max(at)` measures the age from the wrong visit.
{
  const t = (await file({ title: "a revisited task", territory: ["packages/rv"] })).task;
  setPhase(t, "RESEARCH");
  const ev = (at, op, to) => db.prepare(
    `INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
     VALUES(?,?,?,'SIZING',?,1,1,'{}')`).run(t, at, op, to);

  ev(NOW - 100, "first-visit", "RESEARCH");     // an EARLIER visit with a LATER clock
  ev(NOW - 900, "second-visit", "RESEARCH");    // the CURRENT visit, clock skewed back
  const row = db.prepare("SELECT * FROM task WHERE id = ?").get(t);
  const age = ageInState(db, row, { now: NOW });
  check(age.seconds === 900,
    "the age comes from the LATEST row by seq, even when its clock reads earlier",
    JSON.stringify(age));
  check(age.seconds !== 100,
    "and not from the row with the largest `at`, which is a different visit",
    JSON.stringify(age));

  // CONTROL: with the clocks in order the two answers agree, so the assertion
  // above is about the skew and not about the query being broken generally.
  db.prepare("UPDATE phase_event SET at = ? WHERE task = ? AND op = 'second-visit'")
    .run(NOW - 50, t);
  check(ageInState(db, row, { now: NOW }).seconds === 50,
    "control: with monotonic clocks the newest visit is also the latest `at`");
}

// ── a machine-cleared wait is still diagnosable ────────────────────────────
{
  const mq = (await file({ title: "machine-waiting only", territory: ["packages/mw"] })).task;
  setPhase(mq, "SIZING");
  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,?,778,'L','queued',?,?)`)
    .run(builderRunRef(mq, "SIZING"), NOW - 100, NOW + 300);

  const m = dash();
  const quota = m.tasks.find(x => x.id === mq);
  check(quota.waiting.first && !HUMAN_WAITS.has(quota.waiting.first),
    "control: this task waits on the machine, not on you", JSON.stringify(quota.waiting));
  check(!m.waiting_on_you.some(x => x.id === mq) && !m.doing.some(x => x.id === mq),
    "control: so it is in neither waiting_on_you nor doing", JSON.stringify(quota.waiting));

  const row = renderDash(m).split("\n").find(l => l.includes(mq) && l.includes(quota.phase));
  check(row && row.includes(quota.waiting.first),
    "yet its own row names the substate, so an idle task is never an unexplained phase",
    JSON.stringify(row));
}

// ── every value a dash row carries reaches the text ────────────────────────
//
// The render guard PR-E1 built walks `why`'s row-shaped sections. This surface
// had none, and the very first review of it found two fields carried in the model
// and dropped from the text -- the same shape, in a place the guard could not
// see. A guard narrower than its class is a guard the next instance walks around.
{
  const m = dash({ since: cur(0, 0) });
  const text = renderDash(m);
  const EXCLUDED = {
    waiting_on_you: { project: "the row names the task; the project is on its `tasks` entry" },
    doing: { project: "same",
             "running.slice": "rendered as part of `phase/slice`, not on its own",
             "age.from": "which clock produced the figure; `show` and `why` carry the provenance" },
    declined: { last_seen_at: "a timestamp the render formats elsewhere",
                scope: "rendered as the key's own shape: a `builder:` prefix or a task id",
                project: "the row names the task" },
    since_you_looked: { seq: "the cursor, handed back as `next_cursor` rather than per row" },
    tasks: {
      generation: "the run lines carry it; the task header names phase and title",
      priority: "not part of the digest's five questions",
      created_at: "a timestamp; the row shows age in state instead",
      nwo: "the projects block names it once per project",
      project: "same", cli_version: "shown by `task show`, not the digest",
      "waiting.since": "rendered as the elapsed figure in waiting_on_you",
      "waiting.capability_known": "rendered as UNKNOWN where it is false",
      "running.slice": "rendered as part of `phase/slice`",
      "age.from": "which clock produced the figure; `show` and `why` carry the provenance",
      "switches.observe": "the PROJECT's map, rendered once in the switches block as on/off",
      "switches.draftSpec": "the PROJECT's map, rendered once in the switches block as on/off",
      "switches.implementLocal": "the PROJECT's map, rendered once in the switches block as on/off",
      "switches.publishPr": "the PROJECT's map, rendered once in the switches block as on/off",
      "switches.mergeBuilderPr": "the PROJECT's map, rendered once in the switches block as on/off",
      depth: "shown by `task show`, not the digest",
      model: "shown by `task show`, not the digest",
    },
  };
  // DESCENDS into nested objects, naming leaves by dotted path. A container in
  // the exclusion list exempts everything inside it, which is precisely how
  // `running.drift` stayed invisible: `doing.running` was excused as "rendered as
  // phase/slice/attempt" and the drift warning rode along inside the excuse.
  const leaves = (obj, prefix = "") => Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) return leaves(v, path);
    return [[path, v]];
  });
  const missing = [];
  for (const section of Object.keys(EXCLUDED))
    for (const row of m[section])
      for (const [k, v] of leaves(row)) {
        if (k in EXCLUDED[section]) continue;
        if (v === null || v === undefined || v === "" || typeof v === "object") continue;
        if (!text.includes(String(v))) missing.push(`${section}.${k}=${JSON.stringify(v)}`);
      }

  // AND THE TOP-LEVEL SCALARS. The guard walked row-shaped sections only, so a
  // scalar the model promises -- `next_cursor`, which the operator needs to make
  // the very next call -- could be carried in JSON and absent from the text with
  // nothing noticing.
  const TOP_EXCLUDED = {
    format_version: "the envelope's, not the digest's; `--json` carries it",
    generated_at: "a timestamp the render does not repeat",
    since: "echoed only when it is a rewound cursor, where it is the finding",
    cursor_rewound: "rendered as the words CURSOR REWOUND",
  };
  const topMissing = [];
  for (const [k, v] of Object.entries(m)) {
    if (k in TOP_EXCLUDED || Array.isArray(v) || (v && typeof v === "object")) continue;
    if (v === null || v === undefined || v === "") continue;
    if (!text.includes(String(v))) topMissing.push(`${k}=${JSON.stringify(v)}`);
  }
  check(topMissing.length === 0,
    "every top-level scalar the digest carries reaches the human render",
    `not rendered: ${topMissing.join(", ")}`);
  check(missing.length === 0,
    "every value a digest row carries into the model reaches the human render",
    `not rendered: ${missing.join(", ")}\n        ` +
    "Either render it, or name it in EXCLUDED with the reason it is deliberately absent.");
  check(Object.keys(EXCLUDED).every(sec => m[sec].length > 0),
    "control: every section this walks has a row, so none of it is vacuous",
    JSON.stringify(Object.fromEntries(Object.keys(EXCLUDED).map(x => [x, m[x].length]))));

  // COUNTER-CONTROL: the walk can FAIL. A value the text does not contain must be
  // reported, or the loop passes on any render at all.
  const probe = [];
  for (const [k, v] of Object.entries({ ...m.waiting_on_you[0], ghost_field: "ghost-zq" })) {
    if (k in EXCLUDED.waiting_on_you || v === null || v === undefined || typeof v === "object") continue;
    if (!text.includes(String(v))) probe.push(k);
  }
  check(probe.length === 1 && probe[0] === "ghost_field",
    "counter-control: a value the render does NOT contain is reported missing", JSON.stringify(probe));
}


// ── a cursor from a hub that no longer exists ──────────────────────────────
//
// `phase_event.seq` is monotonic WITHIN one hub, not across a restore. Replacing
// the store with an older snapshot puts the high-water mark below a cursor issued
// before it, and every later transition is then `seq <= since` -- reading as
// "nothing moved" for ever, while the digest hands back a smaller cursor the
// client dutifully saves. Nothing readable after the fact distinguishes that from
// a genuinely quiet period, which is why it is reported rather than inferred.
{
  const high = db.prepare("SELECT COALESCE(max(seq),0) s FROM phase_event").get().s;
  check(high > 0, "control: the log has a high-water mark", String(high));

  const ok = dash({ since: cur(high - 1, atOfSeq(high - 1)) });
  check(ok.cursor_rewound === false,
    "control: a cursor within the log is not rewound", JSON.stringify(ok.cursor_rewound));
  check(ok.since_you_looked.length > 0,
    "and it returns what moved after it", String(ok.since_you_looked.length));

  const ahead = dash({ since: cur(high + 1000, 0) });
  check(ahead.cursor_rewound === true,
    "a cursor AHEAD of the log is reported rewound, not answered with an empty list",
    JSON.stringify({ since: high + 1000, next: ahead.next_cursor }));
  check(ahead.since_you_looked.length === 0,
    "the movement list is empty, because it cannot be computed", JSON.stringify(ahead.since_you_looked));
  check(ahead.next_cursor === `${high}.${headAt()}`,
    "and the cursor handed back is this hub's own high-water mark, to resync from",
    String(ahead.next_cursor));
  check(/CURSOR REWOUND/.test(renderDash(ahead)),
    "and the text says so rather than printing a silent zero",
    renderDash(ahead).split("\n").find(l => /since you looked/.test(l)));

  // A cursor EXACTLY at the high-water mark is not rewound: nothing has moved,
  // which is a real answer and must not be confused with the broken one.
  const level = dash({ since: cur(high, headAt()) });
  check(level.cursor_rewound === false && level.since_you_looked.length === 0,
    "control: a cursor exactly at the mark is quiet, not rewound",
    JSON.stringify({ rewound: level.cursor_rewound, n: level.since_you_looked.length }));
}

// ── the cursor an operator needs next is in the TEXT ───────────────────────
{
  const m = dash();
  check(m.since === null, "control: this digest was given no cursor", String(m.since));
  check(renderDash(m).includes(`--since ${m.next_cursor}`),
    "the first invocation prints the cursor to use next, so the follow-up call needs no JSON",
    renderDash(m).split("\n").filter(l => /next:/.test(l)).join(" | "));
}

// ── a drifted run is not an ordinary one, in the digest either ─────────────
{
  const dr = (await file({ title: "a drifted run", territory: ["packages/dr"] })).task;
  setPhase(dr, "RESEARCH");
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,contract_drift)
              VALUES(?,1,'RESEARCH',0,1,'live',400,'L',?,?,?,'/o','/e','drift-zq')`)
    .run(dr, NOW - 100, NOW - 10, NOW + 600);

  const m = dash();
  const row = m.doing.find(x => x.id === dr);
  check(row?.running?.drift === "drift-zq",
    "control: the model carries the drift on the running object", JSON.stringify(row?.running));
  const line = renderDash(m).split("\n").find(l => l.includes(dr) && /running/.test(l));
  check(line && /DRIFT/.test(line),
    "and the digest's own row says DRIFT, so a drifted run is not presented as current",
    JSON.stringify(line));

  // CONTROL: a run whose contract matched says nothing, or DRIFT is decoration
  // rather than a warning.
  db.prepare("UPDATE phase_run SET contract_drift = NULL WHERE task = ?").run(dr);
  const clean = renderDash(dash()).split("\n").find(l => l.includes(dr) && /running/.test(l));
  check(clean && !/DRIFT/.test(clean),
    "control: and a run whose contract matched does not", JSON.stringify(clean));
  db.prepare("DELETE FROM phase_run WHERE task = ?").run(dr);
}


// ── a restore that catches up is still a restore ───────────────────────────
//
// `since > highWater` catches a rewind only while the log is still SHORTER than
// the cursor. Restore to 50, let the builder write through 100, and sequence 100
// exists again -- a DIFFERENT event wearing the same number -- and every event of
// the new incarnation is skipped for ever with nothing reporting it.
//
// A restored log is a PREFIX of the old one, so an event that survives keeps its
// `at` and one written afterwards does not. The cursor therefore carries the
// event it names, and the check is proof rather than inference.
{
  const high = db.prepare("SELECT COALESCE(max(seq),0) s FROM phase_event").get().s;
  const at = db.prepare("SELECT at FROM phase_event WHERE seq = ?").get(high).at;

  check(dash({ since: cur(high, at) }).cursor_rewound === false,
    "control: a cursor naming the event that is actually there is not rewound");

  // THE CASE THE SEQUENCE-ONLY CHECK CANNOT SEE: the number still exists, and the
  // row wearing it is a different event.
  const caughtUp = dash({ since: cur(high, at + 1) });
  check(caughtUp.cursor_rewound === true,
    "a cursor whose sequence EXISTS but names a different event is rewound",
    JSON.stringify({ seq: high, expected: at + 1, actual: at }));
  check(caughtUp.since_you_looked.length === 0,
    "and the movement list is empty because it cannot be computed, not because nothing moved");
  check(/CURSOR REWOUND/.test(renderDash(caughtUp)),
    "and the text says so", renderDash(caughtUp).split("\n").find(l => /since you looked/.test(l)));

  // A sequence-only check would have passed this: `high > high` is false.
  check(!(high > high),
    "control: the old sequence-only rule would have called this cursor valid",
    `since.seq ${high} vs highWater ${high}`);

  // And cursor 0 is always valid: there is no event zero to disagree with.
  check(dash({ since: cur(0, 0) }).cursor_rewound === false,
    "control: the zero cursor is never rewound, so a first poll is not a false alarm");
}

// ── a clean shutdown is not a machine that never ran ───────────────────────
{
  db.prepare("DELETE FROM singleton_lease WHERE name = 'builder'").run();
  db.prepare("DELETE FROM hub_event WHERE kind = 'lease.singleton.released'").run();
  const never = dash();
  check(never.alive.last_seen_seconds === null && never.alive.last_seen_from === null,
    "control: with no lease and no release event, never-seen is null",
    JSON.stringify(never.alive));
  check(/never seen/.test(renderDash(never)), "and the text says never seen",
    renderDash(never).split("\n")[0]);

  // `releaseSingleton` DELETES the row on every orderly shutdown, so the row's
  // absence was reporting "never seen" about a builder that exited seconds ago.
  // The append-only event outlives the row.
  db.prepare(`INSERT INTO hub_event(at,kind,payload)
              VALUES(?, 'lease.singleton.released', '{}')`).run(NOW - 45);
  const stopped = dash();
  check(stopped.alive.last_seen_seconds === 45,
    "after a clean release, last-seen comes from the event the shutdown wrote",
    JSON.stringify(stopped.alive));
  check(stopped.alive.last_seen_from === "released_event",
    "and it names which source, because a lease figure and an event figure mean different things",
    JSON.stringify(stopped.alive));
  check(/last seen 45s ago/.test(renderDash(stopped)),
    "and the text carries it", renderDash(stopped).split("\n")[0]);
  db.prepare("DELETE FROM hub_event WHERE kind = 'lease.singleton.released'").run();
}

// ── a capability label belongs to the capability wait ──────────────────────
{
  // A founder hold AND a switch that is off: `waitingFor` reports FOUNDER as the
  // headline and still names the switch, so copying it unconditionally paired a
  // founder hold with a capability that belongs to a different condition.
  writeProfiles({ ...ALL_ON, observe: false }, ALL_ON);
  const m = dash();
  const held = m.waiting_on_you.find(x => x.id === T.held);
  check(held?.waiting === "WAITING_FOR_FOUNDER",
    "control: this task's headline is the founder hold", JSON.stringify(held));
  const full = m.tasks.find(t => t.id === T.held);
  check(full.waiting.capability === "observe",
    "control: and the underlying model still knows which switch is off",
    JSON.stringify(full.waiting));
  check(held?.capability === null,
    "yet the digest row does not label a founder hold with a capability that is not its reason",
    JSON.stringify(held));
  const line = renderDash(m).split("\n").find(l => l.includes(T.held) && /WAITING_FOR_FOUNDER/.test(l));
  check(line && !/observe/.test(line),
    "and the text does not render WAITING_FOR_FOUNDER (observe)", JSON.stringify(line));

  // CONTROL: a task whose headline IS the capability wait still names it, or the
  // change has removed the label rather than scoped it.
  const cap = m.waiting_on_you.find(x => x.waiting === "WAITING_FOR_CAPABILITY");
  check(cap?.capability === "observe",
    "control: a genuine capability wait still names its switch", JSON.stringify(cap));
  writeProfiles(ALL_ON, ALL_ON);
}

// ── the CLI ──────────────────────────────────────────────────────────────────
{
  db.close();
  const BIN = fileURLToPath(new URL("../bin/reeve", import.meta.url));
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--home", HOME],
      { encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? "", out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  const j = cli("task", "dash", "--json");
  const p = parse(j.stdout);
  check(p?.kind === "task.dash", "task dash --json emits the envelope under its own kind", j.out.slice(0, 200));
  check(p?.format_version === READ_FORMAT_VERSION, "carrying the read model's version", String(p?.format_version));
  check(Array.isArray(p?.data?.waiting_on_you), "and the five questions", Object.keys(p?.data ?? {}).join(","));

  const human = cli("task", "dash");
  check(human.stdout.includes("builder") && parse(human.stdout) === null,
    "the human render is text, not JSON", human.stdout.slice(0, 160));

  const baseline = parse(cli("task", "dash", "--json").stdout)?.data?.next_cursor;
  check(typeof baseline === "string", "control: the CLI printed a cursor to reuse", String(baseline));
  const since = cli("task", "dash", "--since", baseline, "--json");
  check(Array.isArray(parse(since.stdout)?.data?.since_you_looked),
    "--since is accepted by the digest", since.out.slice(0, 200));
  const bad = cli("task", "dash", "--since", "not-a-number", "--json");
  check(parse(bad.stdout)?.kind === "usage" && bad.status === 2,
    "a --since that is not a timestamp is a typed refusal, not a silent NaN", bad.out.slice(0, 200));

  // `--since` belongs to the digest alone, and the gate that proves it is the one
  // that already refuses an inapplicable flag.
  const help = cli("--help");
  for (const sub of ["task list", "task show", "task why", "task dash", "task file"])
    check(help.stdout.includes(sub),
      `\`reeve --help\` lists ${sub}, so the read surface is discoverable`,
      (help.stdout.match(/.*task .*/g) ?? []).slice(0, 6).join(" | "));
  check(help.stdout.includes("--since"),
    "and names --since, which nothing else advertises", (help.stdout.match(/.*--since.*/) ?? [""])[0]);

  // A HUB THAT FAILS AT QUERY TIME IS A TYPED REFUSAL, not a stack trace. The
  // schema-version guard reads `schema_version` and nothing else, so a store
  // whose other tables are gone passes it and dies on the first real query --
  // which for this route is the project prefilter, before the model is built.
  {
    const rotten = join(dir, "rotten", ".reeve");
    mkdirSync(join(rotten, "state"), { recursive: true });
    const r0 = new DatabaseSync(join(rotten, "state", "hub.db"));
    r0.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
    for (let v = 1; v <= HUB_SCHEMA_VERSION; v++)
      r0.prepare("INSERT INTO schema_version(version,at) VALUES(?,1)").run(v);
    r0.close();

    const r = spawnSync(process.execPath, [BIN, "task", "dash", "--home", rotten, "--json"],
      { encoding: "utf8", timeout: 60_000 });
    const both = (r.stdout ?? "") + (r.stderr ?? "");
    check(parse(r.stdout ?? "")?.kind === "hub_unreadable",
      "a hub that fails at query time is a typed refusal from the dash too", both.slice(0, 260));
    check(!/ at .*\.mjs:/.test(both) && !/^\s*(Error|TypeError)\b/m.test(both),
      "and no stack trace reaches the operator", both.slice(0, 260));
    // CONTROL: the healthy hub still answers, so the refusal is about the store
    // rather than about the route being broken.
    check(parse(cli("task", "dash", "--json").stdout)?.kind === "task.dash",
      "control: a healthy hub still answers");
  }

  // A REWOUND CURSOR EXITS DEGRADED. The answer is still printed -- it carries
  // the cursor to resync from -- but a script polling this must not read a
  // restore as a quiet period, and the exit status is what it can branch on.
  const rew = cli("task", "dash", "--since", "999999999.1", "--json");
  check(parse(rew.stdout)?.data?.cursor_rewound === true,
    "the CLI reports a rewound cursor", rew.out.slice(0, 200));
  check(rew.status === 3,
    "and exits DEGRADED, so a poller cannot mistake a restore for nothing having moved",
    `rc=${rew.status}`);
  check(cli("task", "dash", "--json").status === 0,
    "control: an ordinary digest still exits ok");

  // The local usage line and the global help must name the same thing. Advertising
  // `<unix>` invited passing a timestamp, which is a valid integer far above any
  // sequence -- so the digest answered "nothing moved" and looked correct.
  const localHelp = cli("task", "nonsense");
  check(/--since <cursor>/.test(localHelp.out) && !/--since <unix>/.test(localHelp.out),
    "the local usage line calls --since a cursor, not a timestamp",
    (localHelp.out.match(/.*--since.*/) ?? [""])[0]);
  const g = cli("--help");
  check(/--since <cursor>/.test(g.stdout),
    "and the global help says the same word for the same thing",
    (g.stdout.match(/.*--since.*/) ?? [""])[0]);

  const wrong = cli("task", "list", "--since", String(NOW), "--json");
  check(parse(wrong.stdout)?.kind === "flag_not_applicable" && wrong.status === 2,
    "and --since on another subcommand is refused rather than ignored", wrong.out.slice(0, 200));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
