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

import { openHub } from "../src/build/hubdb.mjs";
import { fileTask } from "../src/build/taskfile.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { validate, withDefaults } from "../src/profile/schema.mjs";
import { CAPABILITY_NAMES } from "../src/build/capabilities.mjs";
import { LEASE_SECONDS } from "../src/build/locks.mjs";
import { TERMINAL } from "../src/build/phases.mjs";
import { TABLE_OWNERS } from "../src/build/tables.mjs";
import {
  READ_FORMAT_VERSION, UNKNOWN, HUMAN_WAITS, WAITING, ageInState,
  taskShow, switchesResolver, switchesFrom, builderRunRef,
} from "../src/build/show.mjs";
import { dashModel, renderDash } from "../src/build/dash.mjs";

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
const dash = (over = {}) =>
  dashModel(db, { now: NOW, switchesFor: resolver(), projects: PROJECTS, since: null, ...over });

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
  check(prepares === 2,
    `the dash prepares exactly the two statements it declares (${prepares})`,
    "the singleton lease, and the event log for --since; everything else comes from taskList");
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
  const m = dash({ since: NOW - 3600 });
  const FIVE = ["alive", "doing", "waiting_on_you", "since_you_looked", "declined"];
  for (const k of FIVE) check(k in m, `the digest answers "${k}"`, Object.keys(m).join(","));
  const SUPPORTING = ["format_version", "generated_at", "projects", "switches", "tasks", "since"];
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
  check(dash().alive.running === false,
    "control: an expired lease row is not a running builder", JSON.stringify(dash().alive));
  db.prepare("DELETE FROM singleton_lease WHERE name = 'builder'").run();
}

// ── what happened since I last looked ────────────────────────────────────────
{
  const none = dash();
  check(none.since === null && none.since_you_looked.length === 0,
    "with no --since the answer is empty rather than everything, which is what they were avoiding",
    JSON.stringify(none.since_you_looked));

  const recent = dash({ since: NOW - 100 });
  check(recent.since_you_looked.length > 0,
    "with a mark, the transitions after it are listed",
    JSON.stringify(recent.since_you_looked.map(e => e.at)));
  check(recent.since_you_looked.every(e => e.at > NOW - 100),
    "and only those after it", JSON.stringify(recent.since_you_looked.map(e => e.at)));
  check(recent.since_you_looked.some(e => e.op === "resume"),
    "naming the op that moved", JSON.stringify(recent.since_you_looked.map(e => e.op)));

  // CONTROL: an older mark returns MORE, or the filter is not a filter.
  check(dash({ since: NOW - 100000 }).since_you_looked.length > recent.since_you_looked.length,
    "control: an older mark returns more, so the bound is applied");
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
                                projects: PROJECTS, since: null });
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

  const since = cli("task", "dash", "--since", String(NOW - 100), "--json");
  check(Array.isArray(parse(since.stdout)?.data?.since_you_looked),
    "--since is accepted by the digest", since.out.slice(0, 200));
  const bad = cli("task", "dash", "--since", "not-a-number", "--json");
  check(parse(bad.stdout)?.kind === "usage" && bad.status === 2,
    "a --since that is not a timestamp is a typed refusal, not a silent NaN", bad.out.slice(0, 200));

  // `--since` belongs to the digest alone, and the gate that proves it is the one
  // that already refuses an inapplicable flag.
  const wrong = cli("task", "list", "--since", String(NOW), "--json");
  check(parse(wrong.stdout)?.kind === "flag_not_applicable" && wrong.status === 2,
    "and --since on another subcommand is refused rather than ignored", wrong.out.slice(0, 200));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
