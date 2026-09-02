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

import { openHub, HUB_SCHEMA_VERSION, hubIncarnation, mintIncarnation } from "../src/build/hubdb.mjs";
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
const cur = (seq, at, incarnation = null) => ({ seq, at, incarnation });
// A LIVE BUILDER, because `doing` is an inference and the inference needs a
// running process: with nothing running, a task with no wait against it is not
// moving, it is simply unattended.
const liveBuilder = () => db.prepare(
  `INSERT OR REPLACE INTO singleton_lease(name,pid,lstart,command,acquired_at,expires_at)
   VALUES('builder',424242,'L','reeve build run',?,?)`).run(NOW - 300, NOW + 60);
const noBuilder = () => db.prepare("DELETE FROM singleton_lease WHERE name = 'builder'").run();
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
  // AN OPEN PULL REQUEST ON ONE TASK. Nothing writes `task_pr` before S7, so a
  // fixture built only from the producer leaves every task's `prs` empty -- and a
  // render that drops the list then passes a walk with nothing to walk, which is
  // exactly how the digest shipped a PR its JSON advertised and its text never
  // showed. `generation` and `slice` are NULL because `task_pr`'s CHECK forbids
  // them on a spec row: values there fail the constraint rather than the
  // assertion, and the test would report a database error where it meant to
  // report a missing reader.
  db.prepare(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at)
              VALUES(?, 'spec', NULL, NULL, 3, 11, 'specheadsha', ?)`).run(T.moving, NOW - 400);
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
                      "since", "next_cursor", "cursor_rewound", "cursor_proof", "incarnation",
                      "incarnation_damaged", "cursor_verdict"];
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
  // UNKNOWN, not the phase age. Nothing records when a switch was turned off, and
  // borrowing the age in state answers a different question: a task that worked
  // for ten days before the switch flipped a minute ago would report a ten-day
  // wait and outrank every genuine one.
  check(cap?.for_seconds === null,
    "and an unknown duration, because nothing records when the switch was turned off",
    JSON.stringify(cap));
  check(renderDash(off).includes("for UNKNOWN"),
    "which the text says out loud rather than printing a borrowed number",
    (renderDash(off).split("\n").find(l => l.includes(T.quota)) ?? ""));
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
  // CONTROL: with the switches readable AND a builder running, the same tasks ARE
  // doing -- or the rule has simply emptied the list.
  liveBuilder();
  check(dash().doing.length > 0,
    "control: with readable switches and a live builder the same tasks are doing again",
    JSON.stringify(dash().doing.map(t => t.id)));
  noBuilder();
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
                                         parseCursor(all.next_cursor).at,
                                         parseCursor(all.next_cursor).incarnation),
    "and it round-trips through the pair that formats and reads it, ALL THREE fields",
    String(all.next_cursor));
  check(parseCursor(all.next_cursor).incarnation === hubIncarnation(db).id,
    "and the identity it round-trips is this hub's own, not a shape that merely parses",
    JSON.stringify({ cursor: parseCursor(all.next_cursor).incarnation, hub: hubIncarnation(db).id }));

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
  liveBuilder();
  check(dash().doing.some(x => x.id === T.beta),
    "control: back in an active phase with nothing waiting, it is doing again");

  // NOTHING RUNNING IS NOT EVIDENCE OF PROGRESS. With no builder the digest was
  // describing newly filed tasks as doing work on a page whose own first line
  // said NOT RUNNING.
  noBuilder();
  const stopped = dash();
  check(stopped.alive.running === false,
    "control: and with the builder gone the digest says NOT RUNNING", JSON.stringify(stopped.alive));
  check(stopped.doing.length === 0,
    "no task is `doing` when no process exists to advance it",
    JSON.stringify(stopped.doing.map(x => x.id)));
  // A task with a LIVE RUN is still doing: that one is observed, not inferred.
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path)
              VALUES(?,1,'SIZING',0,1,'live',900,'L',?,?,?,'/o','/e')`)
    .run(T.beta, NOW - 50, NOW - 5, NOW + 300);
  check(dash().doing.some(x => x.id === T.beta),
    "control: a task with a LIVE RUN is still doing, because that is observed rather than inferred",
    JSON.stringify(dash().doing.map(x => x.id)));
  db.prepare("DELETE FROM phase_run WHERE task = ?").run(T.beta);
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
  liveBuilder();
  // A LIVE RUN, INSIDE THIS BLOCK. Without one every `running` on the model is
  // null, so the walk below returns `doing[].running` as a single null leaf and
  // never reaches `since`, `attempt`, `slice` or `drift` -- four values the
  // renderer is answerable for, exempt because the fixture could not produce
  // them rather than because anyone decided they were.
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,contract_drift)
              VALUES(?,1,'SIZING',0,2,'live',400,'L',?,?,?,'/o','/e','drift-guard')`)
    .run(T.moving, NOW - 90, NOW - 5, NOW + 600);
  // A DIRECT ESCALATION, with NO hold row. `phases.mjs` moves a task straight to
  // ESCALATED on retry exhaustion and on the gate's revision cap, and neither
  // writes `hold_reason` -- so the founder wait is inferred from the phase and
  // carries no moment. Without one here, every wait in the fixture had a
  // timestamp and the branch that has none was never rendered.
  const escOnly = (await file({ title: "escalated with no hold row", territory: ["packages/eo"] })).task;
  setPhase(escOnly, "ESCALATED");
  // WITH THE TRANSITION IN THE LOG, because production writes one on every phase
  // move and `setPhase` is a bare UPDATE. Without it the age falls back to
  // `created_at` and the fallback under test would be reading the wrong clock
  // while still producing a plausible number.
  db.prepare(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
              VALUES(?,?,'phase.failed','SIZING','ESCALATED',1,1,'{}')`).run(escOnly, NOW - 3600);
  // AND A TASK WAITING ON TWO THINGS AT ONCE. Every other task in this fixture
  // waits on exactly one, so `waiting.all` and `waiting.first` were the same
  // single value and a render that printed only the headline was indistinguishable
  // from one that printed the set.
  const twoWaits = (await file({ title: "held and queued at once", territory: ["packages/tw"] })).task;
  setPhase(twoWaits, "ESCALATED");
  db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,status,requested_at,expires_at)
              VALUES('builder',1,?,779,'L','queued',?,?)`)
    .run(builderRunRef(twoWaits, "SIZING"), NOW - 100, NOW + 300);
  const m = dash({ since: cur(0, 0) });
  const text = renderDash(m);
  // ONE WALK, OVER THE WHOLE MODEL, FROM THE ROOT.
  //
  // The sections this guard walked used to be a hand-written list, so a
  // top-level key absent from that list was exempt without ever being named:
  // `alive`, `switches` and `projects` were never walked at all. That is how a
  // stale lease and a live attempt's start time reached the JSON and not the
  // text, in the same review round, after this guard had already been widened
  // three times for the same shape. Deriving the walk from the VALUE means a
  // sixth question, or a new field on an existing one, arrives inside the guard
  // rather than beside it.
  //
  // Exclusions are dotted paths from the root, naming LEAVES and never
  // containers -- excluding `doing.running` is what once hid `running.drift`.
  // `[]` is an array element and `*` is exactly one segment, for a map keyed by
  // something the data chooses rather than the code: `switches` is keyed by
  // project name.
  const EXCLUDED = {
    format_version: "the envelope's, not the digest's; `--json` carries it",
    generated_at: "a timestamp the render does not repeat",
    since: "echoed only when it is a rewound cursor, where it is the finding",
    cursor_rewound: "rendered as the words CURSOR UNUSABLE",
    cursor_verdict: "not printed as a value: it SELECTS the sentence after CURSOR UNUSABLE, " +
                    "which is the operator-facing form of it",
    cursor_proof: "printed as the note about a cursor predating the incarnation, and " +
                  "deliberately silent when the answer is proof",
    incarnation: "carried in `next_cursor`, which is where an operator needs it",
    incarnation_damaged: "rendered as the words HUB DAMAGED with the recovery line",

    "alive.running": "rendered as the words RUNNING and NOT RUNNING",

    "switches.*.*": "a boolean rendered as on/off in the switches block, beside its project",
    "alive.last_seen_from": "which clock produced the figure; `show` and `why` carry the provenance",
    "alive.lease_unexpired": "a boolean rendered as the words LEASE STALE when it is false, " +
      "asserted in both directions below rather than left to this exclusion",
    "projects[].nwo": "the registry's name for the project; the digest identifies a project by NAME, " +
      "which every row it appears on uses",

    "doing[].running.slice": "rendered as part of `phase/slice`, not on its own",
    "doing[].age.from": "which clock produced the figure; `show` and `why` carry the provenance",
    "doing[].running.since": "rendered as the attempt's elapsed time; the digest reports elapsed " +
      "figures rather than clock values",

    "waiting_on_you[].for_from": "which moment produced the figure; `show` and `why` carry the provenance",

    "declined[].last_seen_at": "a timestamp the render formats elsewhere",
    "declined[].scope": "rendered as the key's own shape: a `builder:` prefix or a task id",
    "declined[].project": "the row names the task, and the tasks block names its project",

    "since_you_looked[].seq": "the cursor, handed back as `next_cursor` rather than per row",

    "tasks[].generation": "the run lines carry it; the task header names phase and title",
    "tasks[].priority": "not part of the digest's five questions",
    "tasks[].created_at": "a timestamp; the row shows age in state instead",
    "tasks[].nwo": "the projects block names it once per project",
    "tasks[].cli_version": "shown by `task show`, not the digest",
    "tasks[].depth": "shown by `task show`, not the digest",
    "tasks[].model": "shown by `task show`, not the digest",
    "tasks[].waiting.since": "rendered as the elapsed figure beside the wait",
    "tasks[].waiting.capability_known": "rendered as UNKNOWN where it is false",
    "tasks[].running.*": "a live run is rendered in the `doing` block, which every running task is " +
      "in by construction -- asserted below rather than assumed here",
    "tasks[].escalations[].*": "rendered in the `declined` block, which unions the task-scoped " +
      "escalations with the builder's own -- asserted below rather than assumed here",
    "tasks[].age.from": "which clock produced the figure; `show` and `why` carry the provenance",
    "tasks[].switches.*": "the PROJECT's map, rendered once in the switches block as on/off",
    "tasks[].prs[].created_at": "a timestamp; the row presents the same three facts `show` does, " +
      "kind, number and head, and the digest reports elapsed figures rather than clock values",
  };
  const leaves = (v, path = "") => {
    if (Array.isArray(v)) return v.flatMap(el => leaves(el, `${path}[]`));
    if (v && typeof v === "object")
      return Object.entries(v).flatMap(([k, val]) => leaves(val, path ? `${path}.${k}` : k));
    return [[path, v]];
  };
  const matches = (pat, path) => {
    const a = pat.split("."), b = path.split(".");
    return a.length === b.length && a.every((seg, i) => seg === "*" || seg === b[i]);
  };
  // SCOPED TO THE SECTION THE VALUE BELONGS TO, not to the whole document.
  //
  // A whole-document `includes` is satisfied by text belonging to a different
  // row: every task carries a `project`, and the project NAME is printed in the
  // switches block, so "the digest renders each task's project" passed while no
  // task row named one and an operator could not tell which repository any task
  // belonged to. A value must appear where its own row is rendered, or it has not
  // been rendered for that row.
  const SECTION_OF = {
    waiting_on_you: "waiting on you", doing: "doing", declined: "declined",
    since_you_looked: "since you looked", tasks: "tasks", switches: "switches",
  };
  const BLOCKS = Object.fromEntries(text.split("\n\n").flatMap(b => {
    const head = /^(switches|waiting on you|doing|declined|since you looked|tasks)\b/.exec(b.split("\n")[0]);
    return head ? [[head[1], b]] : [];
  }));
  for (const [key, name] of Object.entries(SECTION_OF))
    check(typeof BLOCKS[name] === "string" && BLOCKS[name].length > 0,
      `control: the render emits a \`${name}\` block for \`${key}\`, so scoping to it is not vacuous`,
      Object.keys(BLOCKS).join(" | "));
  const scopeFor = (path) => BLOCKS[SECTION_OF[path.split(/[.[]/)[0]]] ?? text;

  const all = leaves(m);
  const used = new Set();
  const missing = [];
  for (const [k, v] of all) {
    const pat = Object.keys(EXCLUDED).find(p => matches(p, k));
    if (pat) { used.add(pat); continue; }
    if (v === null || v === undefined || v === "") continue;
    if (!scopeFor(k).includes(String(v))) missing.push(`${k}=${JSON.stringify(v)}`);
  }
  check(missing.length === 0,
    "every value the digest carries into the model reaches the human render",
    `not rendered: ${missing.join(", ")}\n        ` +
    "Either render it, or name it in EXCLUDED with the reason it is deliberately absent.");

  // CONTROLS. The walk must reach every section, and every exclusion must still
  // describe something -- an exclusion matching nothing is a rule kept alive past
  // the field it was written for, and it silently widens the next time a path of
  // that shape appears.
  check(all.length > 100, "control: the walk reaches the whole model, not a corner of it",
    `${all.length} leaves`);
  for (const sec of ["waiting_on_you", "doing", "declined", "since_you_looked", "tasks",
                     "projects", "switches", "alive"])
    check(all.some(([k]) => k === sec || k.startsWith(`${sec}.`) || k.startsWith(`${sec}[`)),
      `control: the walk reaches \`${sec}\``);
  const stale = Object.keys(EXCLUDED).filter(p => !used.has(p));
  check(stale.length === 0,
    "control: every exclusion still names a value this model carries",
    `matching nothing: ${stale.join(", ")}`);

  // COUNTER-CONTROL: the walk can FAIL. A value the text does not contain must be
  // reported, or the loop passes on any render at all.
  const probe = [];
  for (const [k, v] of leaves({ ...m.waiting_on_you[0], ghost_field: "ghost-zq" }, "waiting_on_you[]")) {
    if (Object.keys(EXCLUDED).some(p => matches(p, k))) continue;
    if (v === null || v === undefined || typeof v === "object") continue;
    if (!text.includes(String(v))) probe.push(k);
  }
  check(probe.length === 1 && probe[0] === "waiting_on_you[].ghost_field",
    "counter-control: a value the render does NOT contain is reported missing", JSON.stringify(probe));
  db.prepare("DELETE FROM phase_run WHERE task = ?").run(T.moving);
  noBuilder();
}

// ── the facts the guard excuses, asserted where they are actually rendered ──
//
// Two exclusions above say a value is rendered in another block rather than on
// the row that carries it. An exclusion is a claim about the render, and a claim
// nothing checks is how `prs` stayed invisible behind an excuse for a whole
// review round. These are those claims, made falsifiable.
{
  liveBuilder();
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,contract_drift)
              VALUES(?,1,'SIZING',0,2,'live',400,'L',?,?,?,'/o','/e',NULL)`)
    .run(T.moving, NOW - 90, NOW - 5, NOW + 600);
  const m = dash();
  const text = renderDash(m);

  const running = m.tasks.filter(t => t.running);
  check(running.length > 0, "control: a task in this fixture carries a live run",
    running.map(t => t.id).join(","));
  check(running.every(t => m.doing.some(d => d.id === t.id)),
    "every task carrying a live run is in `doing`, which is what lets the tasks block omit it",
    running.map(t => `${t.id}:${m.doing.some(d => d.id === t.id)}`).join(" "));

  const escalated = m.tasks.filter(t => t.escalations.length);
  check(escalated.length > 0, "control: a task in this fixture carries an escalation",
    escalated.map(t => t.id).join(","));
  check(escalated.every(t => t.escalations.every(e =>
        m.declined.some(d => d.id === t.id && d.why === e.why))),
    "every task-scoped escalation reaches `declined`, which is what lets the tasks block omit it");

  noBuilder();
  db.prepare("DELETE FROM phase_run WHERE task = ?").run(T.moving);
}

// ── a wait inferred from a held phase still says how long ──────────────────
//
// Retry exhaustion and the gate's revision cap move a task straight to ESCALATED
// and write no `hold_reason`, so the founder wait has no moment of its own.
// Reporting nothing for it put the OLDEST escalation last in the list whose only
// job is to say what to look at first.
{
  const m = dash();
  const esc = m.waiting_on_you.find(w => w.title === "escalated with no hold row");
  check(esc, "control: the directly-escalated task is in waiting_on_you",
    m.waiting_on_you.map(w => w.title).join(" | "));
  check(typeof esc.for_seconds === "number" && esc.for_seconds > 0,
    "a founder wait inferred from a held phase reports how long, not UNKNOWN",
    JSON.stringify(esc));
  check(esc.for_from === "phase_event",
    "and says which clock answered, because two of them could have", String(esc.for_from));

  // A CAPABILITY WAIT STILL REPORTS NOTHING: a switch being off is a state with
  // no event behind it, and the phase age answers a different question.
  const cap = m.waiting_on_you.filter(w => w.waiting === "WAITING_FOR_CAPABILITY");
  check(cap.every(w => w.for_seconds === null && w.for_from === null),
    "control: a capability wait still reports no elapsed figure at all",
    JSON.stringify(cap));

  // AND IT SORTS BY IT. The figure exists to order the list; computing it and
  // leaving the row last is the same defect with a number printed on it.
  const idx = m.waiting_on_you.findIndex(w => w.id === esc.id);
  const shorter = m.waiting_on_you.findIndex(w =>
    w.for_seconds !== null && w.for_seconds < esc.for_seconds);
  check(shorter === -1 || idx < shorter,
    "and it outranks every shorter wait rather than being buried under them",
    m.waiting_on_you.map(w => `${w.title}=${w.for_seconds}`).join(" | "));
}

// ── clearing the headline can leave the task blocked ───────────────────────
{
  const m = dash();
  const two = m.tasks.find(t => t.title === "held and queued at once");
  check(two && two.waiting.all.length > 1,
    "control: a task in this fixture waits on two things at once",
    JSON.stringify(two?.waiting));
  const row = renderDash(m).split("\n").find(l => l.includes(two.id) && l.includes(two.phase));
  for (const w of two.waiting.all)
    check(row.includes(w),
      `the task row names ${w}, so acting on the headline is not presented as enough`,
      JSON.stringify(row));
}

// ── which repository a row belongs to ──────────────────────────────────────
{
  liveBuilder();
  const m = dash();
  const text = renderDash(m);
  const blockOf = (head) => text.split("\n\n").find(b => b.startsWith(head));
  for (const [name, rows] of [["waiting on you", m.waiting_on_you], ["doing", m.doing],
                              ["tasks", m.tasks]]) {
    const b = blockOf(name);
    check(typeof b === "string", `control: the render emits a ${name} block`, String(b).slice(0, 40));
    for (const r of rows) {
      const line = b.split("\n").find(l => l.includes(r.id));
      check(line && line.includes(r.project),
        `${name}: the row for ${r.id} names its project, so an operator can tell which repository it is`,
        JSON.stringify(line));
    }
  }
  // A project name is NOT enough on its own: `beta` is a substring of nothing
  // here, but the control that matters is that two projects are actually present,
  // or every row could name the same one and pass.
  check(new Set(m.tasks.map(t => t.project)).size > 1,
    "control: the digest spans more than one project, so naming one is not enough",
    [...new Set(m.tasks.map(t => t.project))].join(","));
  noBuilder();
}

// ── a live holder past its lease is not a healthy builder ──────────────────
{
  db.prepare(`INSERT OR REPLACE INTO singleton_lease(name,pid,lstart,command,acquired_at,expires_at)
              VALUES('builder',424242,'L','reeve build run',?,?)`).run(NOW - 300, NOW - 10);
  const stale = dash();
  check(stale.alive.running === true && stale.alive.lease_unexpired === false,
    "control: the holder is alive and its lease has expired", JSON.stringify(stale.alive));
  const head = renderDash(stale).split("\n")[0];
  check(/RUNNING/.test(head) && /LEASE STALE/.test(head),
    "the first line says RUNNING and says the lease is stale, because both are true", head);

  liveBuilder();
  const fresh = dash();
  check(fresh.alive.lease_unexpired === true,
    "control: a fresh lease is not stale", JSON.stringify(fresh.alive));
  check(!/LEASE STALE/.test(renderDash(fresh).split("\n")[0]),
    "and a healthy builder carries no warning, or the warning is decoration",
    renderDash(fresh).split("\n")[0]);
  noBuilder();
}

// ── a fresh attempt inside an old phase ────────────────────────────────────
{
  liveBuilder();
  db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,status,pid,lstart,started_at,
                                    heartbeat_at,lease_expires_at,out_path,err_path,contract_drift)
              VALUES(?,1,'SIZING',0,3,'live',400,'L',?,?,?,'/o','/e',NULL)`)
    .run(T.quota, NOW - 30, NOW - 5, NOW + 600);
  const m = dash();
  const d = m.doing.find(x => x.id === T.quota);
  check(d?.running?.since === NOW - 30, "control: the model carries the attempt's own start",
    JSON.stringify(d?.running));
  check(d.age.seconds > (NOW - d.running.since) * 10,
    "control: and the phase is far older than the attempt, or the two figures cannot be told apart",
    `phase=${d.age.seconds}s attempt=${NOW - d.running.since}s`);
  const line = renderDash(m).split("\n").find(l => l.includes(T.quota) && /running/.test(l));
  check(line && /attempt started 30s ago/.test(line),
    "the row reports the attempt's own age, not the phase's, for the run it is describing",
    JSON.stringify(line));
  db.prepare("DELETE FROM phase_run WHERE task = ?").run(T.quota);
  noBuilder();
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
  check(ahead.next_cursor === `${high}.${headAt()}.${hubIncarnation(db).id}`,
    "and the cursor handed back is this hub's own high-water mark AND its identity, to resync from",
    String(ahead.next_cursor));
  check(/CURSOR UNUSABLE/.test(renderDash(ahead)) && /beyond this hub's log/.test(renderDash(ahead)),
    "and the text says so rather than printing a silent zero",
    renderDash(ahead).split("\n").find(l => /since you looked/.test(l)));

  // A cursor EXACTLY at the high-water mark is not rewound: nothing has moved,
  // which is a real answer and must not be confused with the broken one.
  const level = dash({ since: cur(high, headAt()) });
  check(level.cursor_rewound === false && level.since_you_looked.length === 0,
    "control: a cursor exactly at the mark is quiet, not rewound",
    JSON.stringify({ rewound: level.cursor_rewound, n: level.since_you_looked.length }));
}

// ── a restore is caught by IDENTITY, including the one timestamps miss ──────
//
// THE DEFECT THIS CLOSES. `phase_event.at` is integer seconds with no uniqueness
// constraint, so a log restored and regrown to the same sequence WITHIN ONE
// SECOND presents an identical (seq, at) pair. The timestamp check accepts that
// stale cursor, every event through that sequence in the new incarnation is
// omitted permanently, and the digest reports it as a quiet period -- the worst
// possible failure for this surface, because it looks exactly like good news.
//
// The fixture does not simulate the restore with a sleep or a clock. It re-mints
// the incarnation and CHANGES NOTHING ELSE, which is the same-second case in its
// purest form: seq identical, `at` identical, only the identity different. If the
// check were still reading timestamps this would pass as quiet.
{
  const high = db.prepare("SELECT COALESCE(max(seq),0) s FROM phase_event").get().s;
  const before = hubIncarnation(db).id;
  const issued = cur(high - 1, atOfSeq(high - 1), before);

  const ok = dash({ since: issued });
  check(ok.cursor_rewound === false,
    "control: a cursor carrying THIS hub's identity is not rewound",
    JSON.stringify({ rewound: ok.cursor_rewound, proof: ok.cursor_proof }));
  check(ok.cursor_proof === "incarnation",
    "and the answer is reported as PROOF, not as an absence of evidence",
    String(ok.cursor_proof));
  check(ok.since_you_looked.length > 0,
    "control: and it still returns what moved after it, so the fixture is not vacuous",
    String(ok.since_you_looked.length));

  // THE RESTORE. Only the identity moves.
  const after = mintIncarnation(db).id;
  check(after !== before, "control: re-minting yields a different identity",
    JSON.stringify({ before, after }));
  check(atOfSeq(high - 1) === issued.at && db.prepare(
    "SELECT COALESCE(max(seq),0) s FROM phase_event").get().s === high,
    "control: and the log is otherwise UNCHANGED -- same seq, same at -- so only " +
    "an identity check can tell this apart",
    JSON.stringify({ at: atOfSeq(high - 1), was: issued.at, high }));

  const restored = dash({ since: issued });
  check(restored.cursor_rewound === true,
    "a cursor from a PREVIOUS incarnation is rewound, though its (seq, at) still matches",
    JSON.stringify({ rewound: restored.cursor_rewound, proof: restored.cursor_proof }));
  check(restored.since_you_looked.length === 0,
    "so the movement list is withheld rather than reported as a quiet period",
    JSON.stringify(restored.since_you_looked));
  check(restored.next_cursor.endsWith(`.${after}`),
    "and the cursor handed back carries the NEW identity, to resync from",
    String(restored.next_cursor));
  check(restored.cursor_verdict === "different-log",
    "and the verdict names the identity mismatch rather than any other fault",
    String(restored.cursor_verdict));
  check(!/was restored\b/.test(renderDash(restored).split("\n").find(l => /CURSOR UNUSABLE/.test(l)) ?? "")
        || /or the cursor came from a different hub/.test(renderDash(restored)),
    "and it never asserts a RESTORE as the cause without naming the other one: a cursor " +
    "pasted from a different hub differs identically, and sending an operator to hunt damage " +
    "for a wrong bookmark is the failure this wording avoids",
    renderDash(restored).split("\n").find(l => /CURSOR UNUSABLE/.test(l)) ?? "(none)");
  // THE FALSE DIAGNOSIS THIS REPLACES. Every unusable cursor was rendered as
  // "ahead of this hub's log", and the restore this whole change exists to catch
  // is one where the cursor is NOT ahead: its sequence is inside the log.
  check(!(issued.seq > high),
    "control: this cursor is INSIDE the log, so `ahead` would be a false diagnosis",
    JSON.stringify({ seq: issued.seq, high }));
  check(/does not belong to this hub's log/.test(renderDash(restored)) &&
        !/beyond this hub's log/.test(renderDash(restored)),
    "so the text says the cursor is not this log's, and does not claim it is ahead",
    renderDash(restored).split("\n").find(l => /CURSOR UNUSABLE/.test(l)) ?? "(no line)");

  // IDENTITY IS ASKED BEFORE THE SEQUENCE, which is the COMMON restore rather
  // than an exotic one: a restore from a shorter snapshot leaves the log below
  // the saved cursor, so `seq > highWater` is true AND the identity differs.
  // Answering `ahead` there reports the symptom -- the log is shorter -- and
  // throws away the identity sitting right beside it, which reports the cause.
  // A MATCHING IDENTITY WITH A SEQUENCE BEYOND THE LOG is the cursor being wrong,
  // not the log: this IS the log that issued it, and it never reached that
  // number. Naming it `ahead` and explaining it as "carries no identity" was
  // false twice -- the cursor carries one, and `cursor_proof` says so on the same
  // screen.
  const pastEnd = dash({ since: cur(high + 1000, 0, hubIncarnation(db).id) });
  check(pastEnd.cursor_verdict === "unknown-event",
    "a cursor with THIS hub's identity whose sequence is past the log is the cursor being wrong",
    JSON.stringify({ verdict: pastEnd.cursor_verdict, proof: pastEnd.cursor_proof }));
  check(!/carries no incarnation/.test(renderDash(pastEnd)),
    "and the text never says it carries no incarnation, which the cursor plainly does",
    renderDash(pastEnd).split("\n").find(l => /CURSOR UNUSABLE/.test(l)) ?? "(none)");
  check(pastEnd.cursor_proof === "incarnation",
    "control: the identity WAS available, which is what makes the old wording false",
    String(pastEnd.cursor_proof));

  const shorter = dash({ since: cur(high + 1000, 0, before) });
  check(shorter.cursor_verdict === "different-log",
    "a restore to a SHORTER log is judged by identity, not reported as merely `ahead`",
    JSON.stringify({ verdict: shorter.cursor_verdict, seq: high + 1000, high }));
  check(shorter.cursor_proof === "incarnation",
    "control: and the proof is the identity, which is what decided it",
    String(shorter.cursor_proof));
  check(high + 1000 > high,
    "control: that cursor genuinely IS beyond the log, so the two arms really do compete here",
    JSON.stringify({ seq: high + 1000, high }));

  // IDENTITY REPLACES THE TIMESTAMP RULE -- it is not ANDed with it. This is the
  // case that separates the two designs, and neither assertion above reaches it:
  // a cursor whose identity MATCHES but whose `at` does not. The old rule calls
  // that rewound. An implementation that kept both rules as `identityDiffers ||
  // atDiffers` would pass every other assertion in this block and fail only here,
  // reporting a restore for a log that merely had a row's clock corrected.
  // TWO QUESTIONS, and the answer to one is not the answer to the other. A cursor
  // whose identity MATCHES but whose event does not is a corrupt cursor -- a digit
  // changed in a paste -- not a restored log. Both refuse the movement list, and
  // saying the wrong one sends an operator to look for damage that is not there.
  //
  // This is also the case that separates the two designs: an implementation that
  // ORed identity with the timestamp reports it as a RESTORE, and one that dropped
  // the timestamp entirely accepts it and silently skips every transition between
  // the real mark and the altered one.
  const clockMoved = cur(high - 1, atOfSeq(high - 1) + 999, after);
  const stillOurs = dash({ since: clockMoved });
  check(stillOurs.cursor_verdict === "unknown-event",
    "a cursor carrying THIS hub's identity but naming an event it does not have is a corrupt cursor",
    JSON.stringify({ verdict: stillOurs.cursor_verdict, proof: stillOurs.cursor_proof }));
  check(stillOurs.cursor_verdict !== "different-log",
    "and is NEVER reported as a different log, which would send an operator hunting damage that is not there",
    String(stillOurs.cursor_verdict));
  check(stillOurs.since_you_looked.length === 0 && stillOurs.cursor_rewound === true,
    "while the movement list is still withheld, because an unresolvable cursor cannot produce one",
    JSON.stringify({ n: stillOurs.since_you_looked.length, rewound: stillOurs.cursor_rewound }));
  check(!(clockMoved.seq > high) && atOfSeq(clockMoved.seq) !== clockMoved.at,
    "control: the cursor is not ahead and its pair genuinely disagrees, so this is that case and no other",
    JSON.stringify({ at: atOfSeq(clockMoved.seq), cursor: clockMoved.at, high }));
  check(/cursor itself is wrong/.test(renderDash(stillOurs)) && !/was restored/.test(renderDash(stillOurs)),
    "and the text says the cursor is wrong rather than that the hub was restored",
    renderDash(stillOurs).split("\n").find(l => /CURSOR UNUSABLE/.test(l)) ?? "(no line)");

  // AND IT CATCHES A RESTORE WHEN THE CLOCK MOVED TOO, so the identity check is
  // not merely the same-second special case wearing a different name.
  const bothMoved = dash({ since: cur(high - 1, atOfSeq(high - 1) + 999, before) });
  check(bothMoved.cursor_rewound === true,
    "and a previous incarnation is still caught when the timestamp differs as well",
    JSON.stringify({ rewound: bothMoved.cursor_rewound, proof: bothMoved.cursor_proof }));

  // THE OLD CHECK, RUN AGAINST THE SAME FIXTURE, to show it is discrimination
  // rather than a test that would pass either way: the timestamp rule this
  // replaced answers "not rewound" for the case above.
  const timestampRuleSays = !(issued.seq > high || (issued.seq > 0 && atOfSeq(issued.seq) !== issued.at));
  check(timestampRuleSays === true,
    "control: the timestamp rule this replaced accepts that very cursor, which is the defect",
    String(timestampRuleSays));
}

// ── a cursor that predates the identity is answered, and says it is weaker ──
{
  const high = db.prepare("SELECT COALESCE(max(seq),0) s FROM phase_event").get().s;
  const legacy = dash({ since: cur(high - 1, atOfSeq(high - 1)) });
  check(legacy.cursor_rewound === false,
    "a cursor with no incarnation is still answered rather than refused",
    JSON.stringify(legacy.cursor_rewound));
  check(legacy.cursor_proof === "timestamp",
    "but the digest reports that the weaker check answered it",
    String(legacy.cursor_proof));
  check(/predates the hub's incarnation id/.test(renderDash(legacy)),
    "and the text says so, so a reader is not left with an impression of proof",
    renderDash(legacy).split("\n").find(l => /note:/.test(l)) ?? "(no note line)");
  check(!/predates the hub's incarnation id/.test(renderDash(dash({
    since: cur(high - 1, atOfSeq(high - 1), hubIncarnation(db).id) }))),
    "control: and it says NOTHING when the answer is proof, so the caveat stays readable",
    "the note must appear only for the weaker answer");
  check(dash().cursor_proof === null,
    "control: with no cursor there was nothing to prove", String(dash().cursor_proof));
}

// ── the cursor's third field is strict, so a fumbled paste is not a restore ──
//
// An unparseable cursor is a misuse the CLI names. Accepted loosely, a mistyped
// identity would differ from the hub's and report a RESTORE THAT NEVER HAPPENED,
// sending an operator to look for damage because they fumbled a copy.
{
  const id = hubIncarnation(db).id;
  check(parseCursor(`5.10.${id}`) !== null, "control: a well-formed cursor parses", "5.10." + id);
  check(parseCursor("5.10") !== null, "control: and so does one with no identity", "5.10");
  for (const [what, raw] of [["too short", `5.10.${id.slice(0, 31)}`],
                             ["too long", `5.10.${id}a`],
                             ["not hex", `5.10.${"z".repeat(32)}`],
                             ["a fourth field", `5.10.${id}.9`]]) {
    check(parseCursor(raw) === null, `a cursor whose identity is ${what} is refused, not guessed`,
      JSON.stringify(raw));
  }
}

// ── a damaged incarnation row is a visible state, not a stack trace ─────────
//
// `hubIncarnation` answers three things and they must stay three: a row, `null`
// for a store older than the table, and a THROW for a store that records the
// migration with no row -- a hub altered outside reeve. Collapsing the throw into
// null would rebuild the misclassification the throw exists to prevent; letting
// it out raw makes a stack trace the interface for a state an operator has to act
// on. So it renders, carrying the error's own recovery line.
{
  const dhome = mkdtempSync(join(dir, "dash-damaged-"));
  mkdirSync(join(dhome, "state"), { recursive: true });
  const ddb = openHub(join(dhome, "state", "hub.db"));
  check(hubIncarnation(ddb) !== null, "control: the fresh hub has an incarnation to remove",
    JSON.stringify(hubIncarnation(ddb)));
  ddb.prepare("DELETE FROM hub_incarnation").run();

  let model = null, threw = null;
  try {
    model = dashModel(ddb, { now: NOW, switchesFor: resolver(), projects: [],
                             since: null, isAlive: ALIVE });
  } catch (e) { threw = e.message; }
  check(threw === null, "the digest still answers on a hub whose incarnation row is gone",
    String(threw));
  check(model?.incarnation === null && typeof model?.incarnation_damaged === "string",
    "and it reports DAMAGE rather than the absence that means `merely old`",
    JSON.stringify({ id: model?.incarnation, damaged: model?.incarnation_damaged?.slice(0, 60) }));
  check(/altered outside reeve/.test(model?.incarnation_damaged ?? ""),
    "carrying the reason the store cannot be trusted", String(model?.incarnation_damaged));
  // AND THE NOTE MUST NOT BLAME THE CURSOR. `cursor_proof` is "timestamp" for two
  // opposite reasons -- a legacy cursor, or a hub that cannot supply an identity
  // -- and one note served both. For the second it is simply false: the cursor
  // DOES carry an id, the hub does not, and telling the operator "the cursor
  // above carries the id; the next call is provable" promises a cure that will
  // not arrive. `next_cursor` was formatted with no identity, so it has two
  // fields and the next call is no better.
  const SOME_ID = "a".repeat(32);
  const withCursor = model && dashModel(ddb, { now: NOW, switchesFor: resolver(), projects: [],
                                               since: cur(0, 0, SOME_ID), isAlive: ALIVE });
  const withText = withCursor ? renderDash(withCursor) : "";
  check(withCursor?.cursor_proof === "timestamp",
    "control: a damaged hub cannot prove a cursor even when the cursor carries an id",
    String(withCursor?.cursor_proof));
  check(/this HUB cannot supply an incarnation id/.test(withText),
    "the note blames the HUB, which is what cannot supply the identity",
    withText.split("\n").find(l => /note:/.test(l)) ?? "(no note)");
  check(!/this cursor predates/.test(withText),
    "and never says the cursor predates the id, which is false when the cursor carries one",
    withText.split("\n").find(l => /note:/.test(l)) ?? "(no note)");
  check(!/the next call is provable/.test(withText),
    "nor promises a next call that will be provable, since next_cursor carries no id either",
    String(withCursor?.next_cursor));

  // AND THE EXIT STATUS SAYS SO. Monitoring watches the status, not the payload:
  // a plain `task dash` with no --since on a damaged hub printed HUB DAMAGED and
  // exited 0, so anything polling this read a store altered outside reeve as
  // healthy. The model said one thing and the status contradicted it.
  const CLI = fileURLToPath(new URL("../bin/reeve", import.meta.url));
  const dr = spawnSync(process.execPath, [CLI, "task", "dash", "--home", dhome, "--json"],
    { encoding: "utf8", timeout: 60_000 });
  check(dr.status !== 0,
    "and `task dash` exits NON-ZERO on a damaged hub even with no --since given",
    JSON.stringify({ status: dr.status, out: (dr.stdout ?? "").slice(0, 120) }));
  const dj = JSON.parse(dr.stdout || "{}");
  check(typeof (dj?.data?.incarnation_damaged ?? null) === "string",
    "control: and it is the damage that made it non-zero, since no cursor was given",
    JSON.stringify({ damaged: dj?.data?.incarnation_damaged?.slice(0, 60),
                     rewound: dj?.data?.cursor_rewound }));
  check(dj?.data?.cursor_rewound === false,
    "control: cursor_rewound is false here, so the old rule alone would have exited 0",
    String(dj?.data?.cursor_rewound));

  const damagedText = model ? renderDash(model) : "";
  check(/HUB DAMAGED/.test(damagedText) && /reeve restore --hub --force/.test(damagedText),
    "and the text says so, with the recovery command the error itself carries",
    damagedText.split("\n").filter(l => /DAMAGED|recover/.test(l)).join(" | ") || "(no model)");
  ddb.close();
  rmSync(dhome, { recursive: true, force: true });
}

// ── sequence zero survives a restore, because it names no event ────────────
//
// A first digest taken before any phase event exists issues a cursor at sequence
// 0. If the hub is restored or re-minted before events arrive, the identity
// differs -- and rejecting the cursor there withholds every transition since,
// permanently, because the operator dutifully resyncs to the new high-water mark.
// Sequence 0 names the BEGINNING of any log rather than an event in a particular
// one, so `movedSince(db, 0)` is always the right answer.
{
  const high = db.prepare("SELECT COALESCE(max(seq),0) s FROM phase_event").get().s;
  const foreign = "b".repeat(32);
  check(foreign !== hubIncarnation(db).id,
    "control: the cursor carries an identity this hub does not have", foreign);

  const zero = dash({ since: cur(0, 0, foreign) });
  check(zero.cursor_verdict === "ok",
    "a cursor at sequence 0 is accepted even though its incarnation differs",
    JSON.stringify({ verdict: zero.cursor_verdict, rewound: zero.cursor_rewound }));
  check(zero.since_you_looked.length > 0 && zero.since_you_looked.length === high,
    "and it returns the WHOLE current log, which is what someone who has seen nothing needs",
    JSON.stringify({ returned: zero.since_you_looked.length, high }));

  // CONTROL: the same foreign identity at a NON-zero sequence is still refused,
  // so this exempts sequence zero rather than exempting a mismatch.
  const nonZero = dash({ since: cur(high - 1, atOfSeq(high - 1), foreign) });
  check(nonZero.cursor_verdict === "different-log",
    "control: the same foreign identity at a real sequence is still refused",
    String(nonZero.cursor_verdict));
}

// ── the proof names the evidence that actually decided it ──────────────────
//
// A legacy cursor beyond the high-water mark is settled by the sequence alone:
// no event is looked up and no timestamp compared. Reporting `timestamp` there
// made the renderer print a note about a restore inferred from timestamps
// directly beneath a line saying the cause could not be told apart -- naming
// evidence that was never consulted, which is this change's own subject.
{
  const high = db.prepare("SELECT COALESCE(max(seq),0) s FROM phase_event").get().s;
  const beyond = dash({ since: cur(high + 1000, 0) });
  check(beyond.cursor_verdict === "ahead",
    "control: a legacy cursor past the log is `ahead`, decided without any event lookup",
    String(beyond.cursor_verdict));
  check(beyond.cursor_proof === "sequence",
    "and the proof says SEQUENCE, because that is what settled it",
    String(beyond.cursor_proof));
  check(!/inferred from timestamps/.test(renderDash(beyond)),
    "so the text does not claim a timestamp inference that never happened",
    renderDash(beyond).split("\n").find(l => /note:/.test(l)) ?? "(no note)");

  // CONTROL: a legacy cursor INSIDE the log really is decided by the timestamp,
  // and still says so.
  const inside = dash({ since: cur(high - 1, atOfSeq(high - 1)) });
  check(inside.cursor_proof === "timestamp",
    "control: a legacy cursor inside the log is still decided by the timestamp",
    String(inside.cursor_proof));
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
  check(/CURSOR UNUSABLE/.test(renderDash(caughtUp)),
    "and the text says so", renderDash(caughtUp).split("\n").find(l => /since you looked/.test(l)));
  // NO IDENTITY ON THIS CURSOR, so the two causes genuinely cannot be told apart
  // and the text must claim neither.
  check(caughtUp.cursor_verdict === "changed-event",
    "and without an incarnation it reports a CHANGED EVENT rather than asserting a restore",
    String(caughtUp.cursor_verdict));

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

  // ── a bare word nothing reads ──────────────────────────────────────────────
  //
  // The parser refuses an unknown flag and `inapplicable` refuses a known flag on
  // a command that cannot act on it. An extra POSITIONAL was governed by neither,
  // so a cursor typed without its flag was discarded in silence: the digest
  // answered from the beginning of the log, printed an empty movement list and
  // exited 0, which is indistinguishable from a genuinely quiet period. Driven
  // through the CLI and not through `extraArgs`, because the library agreeing
  // with itself is what a green stub looks like -- the defect was the ROUTE never
  // calling it.
  const stray = cli("task", "dash", "1234.1800000000", "--json");
  check(stray.status === 2,
    "a cursor typed as a positional is refused, not discarded",
    `rc=${stray.status} ${stray.out.slice(0, 200)}`);
  check(parse(stray.stdout)?.kind === "usage",
    "as a usage refusal, under a kind a script can branch on", stray.out.slice(0, 200));
  check(/--since <cursor>/.test(stray.out),
    "and the refusal shows where a cursor actually belongs", stray.out.slice(0, 300));
  check(cli("task", "dash", "--json").status === 0,
    "control: the same digest without the stray word still answers");

  // THE SAME HOLE ON THE THREE SIBLING READERS, closed in the same place. `list`
  // reads no positional either, and `show`/`why` read exactly one and answered
  // about it while discarding whatever followed.
  check(cli("task", "list", "alpha", "--json").status === 2,
    "`task list` refuses a stray argument rather than listing everything");
  check(cli("task", "show", T.moving, "extra", "--json").status === 2,
    "`task show` refuses the argument after its id rather than ignoring it");
  check(cli("task", "why", T.moving, "extra", "--json").status === 2,
    "and so does `task why`");
  check(cli("task", "show", T.moving, "--json").status === 0,
    "control: `task show` still answers when given its id alone");
  check(cli("task", "list", "--json").status === 0,
    "control: `task list` still answers when given none");

  // ── one database moment, not two ───────────────────────────────────────────
  //
  // The digest names the projects and then enumerates the tasks. Run as two
  // reads, a project registered and given its first task between them puts that
  // task in the digest while the `projects` and `switches` blocks have never
  // heard of it, and the row renders under a project the text does not name.
  //
  // ASSERTED OVER SOURCE, and that bound is real: `bin/reeve` runs its route
  // table on import, so nothing can import the route to observe the ordering, and
  // a concurrent writer racing a subprocess would be a flaky test rather than a
  // proof. The counter-control below is what keeps it from being a regex that
  // passes over anything.
  const BINSRC = readFileSync(BIN, "utf8");
  const from = BINSRC.indexOf('if (sub === "dash") {');
  const to = BINSRC.indexOf('if (sub === "list") {', from);
  check(from > 0 && to > from,
    "control: the dash branch was located in the route source", `${from}..${to}`);
  const branch = BINSRC.slice(from, to);
  const snapAt = branch.indexOf("inSnapshot(");
  const discAt = branch.indexOf("projectsWithTasks(");
  const inside = snapAt > -1 && discAt > snapAt;
  check(inside,
    "project discovery runs inside the digest's snapshot, so naming and enumeration " +
    "describe one database moment",
    `inSnapshot@${snapAt} projectsWithTasks@${discAt}`);
  check(discAt > -1 && branch.indexOf("projectsWithTasks(", discAt + 1) === -1,
    "and the hub is asked exactly once, so no second read reopens the gap");
  // COUNTER-CONTROL: the predicate must reject the shape it replaced, or it is a
  // check that passes over any source at all.
  const WAS = 'if (sub === "dash") {\n  let seen;\n  try { seen = projectsWithTasks(db); } catch (e) {}\n' +
              '  model = inSnapshot(db, () => dashModel(db, {}));\n}';
  const wSnap = WAS.indexOf("inSnapshot("), wDisc = WAS.indexOf("projectsWithTasks(");
  check(!(wSnap > -1 && wDisc > wSnap),
    "counter-control: the same predicate rejects the two-moment shape this replaced",
    `inSnapshot@${wSnap} projectsWithTasks@${wDisc}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
