// dash -- the five questions an operator asks at a glance, from one value.
//
// A SECOND RENDERER OVER `taskShow`, and it computes nothing `task show --json`
// cannot already see. That is the whole design constraint: a dash that re-queries
// for its text is a second implementation of one question, each half individually
// correct, disagreeing under exactly the conditions nobody tested, and neither
// half reporting that it disagreed.
//
// THERE IS NO HTML. The founder's decision for this stage is that the surface
// stays headless, recorded because it is a scar rather than an oversight:
// `src/dash.mjs` documents that the telemetry stack this replaced spent weeks
// serving unauthenticated admin to the LAN, and the cheapest way not to repeat
// that is to have no server at all. So the two renderings are TEXT and JSON, and
// a future GUI is a third renderer over this same value which must argue against
// that decision rather than forget it.

import { TERMINAL } from "./phases.mjs";
import { LEASE_SECONDS } from "./locks.mjs";
import {
  READ_FORMAT_VERSION, UNKNOWN, HUMAN_WAITS, ageInState, taskList, oneLine,
} from "./show.mjs";

const TERMINAL_SET = new Set(TERMINAL);

/**
 * The digest.
 *
 * `switchesFor` is the per-project resolver `taskShow` takes, NOT a map of
 * switches: the switches live in each project's own profile and a digest spans
 * every project at once, so one map would report one project's settings under
 * another project's name.
 */
export function dashModel(db, { now, switchesFor, projects = [], since = null }) {
  const tasks = taskList(db, { now, switchesFor })
    // `age` is decorated HERE rather than added to `taskShow`, and that is a
    // promise being kept rather than a shortcut: `task.show`'s key set is frozen
    // at format_version 1 by `test/fixtures/read-model-v1.json`, whose own note
    // says an additive field needs a new version. The dash is a new surface with
    // its own kind, so it may carry what it needs without breaking a consumer
    // that reads `task show`.
    .map(t => ({ ...t, age: ageInState(db, t, { now }) }));

  // `builder` is the name `bin/reeve` acquires, and `singleton_lease` has NO
  // heartbeat column: `heartbeatSingleton` expresses the beat by sliding
  // `expires_at` forward by LEASE_SECONDS. So last-seen is the lease length minus
  // what remains of it, and LEASE_SECONDS is IMPORTED rather than written as a
  // number, because the derivation is sound only while the two agree and a copied
  // constant agrees right up until the day it does not.
  const lease = db.prepare(
    "SELECT pid, acquired_at, expires_at FROM singleton_lease WHERE name = 'builder'").get() ?? null;

  const byProject = Object.create(null);
  for (const p of projects) byProject[p.name] = switchesFor(p.name);

  return {
    format_version: READ_FORMAT_VERSION,
    generated_at: now,
    projects: projects.map(p => ({ name: p.name, nwo: p.nwo })),
    // PER PROJECT, keyed by name. A single flat map would be a second answer to
    // "which switches are in force", correct only while there is one project.
    switches: byProject,
    tasks,
    since,

    // 1. IS IT ALIVE. A heartbeat and when it was last seen. `running` reads the
    // CLOCK, never the row's existence: a lease row outlives the process that
    // took it, which is what makes it a lease. `null` rather than 0 for last-seen
    // when there is none, because never-seen and seen-just-now are different
    // facts and 0 is an answer to the second.
    alive: {
      running: !!lease && lease.expires_at > now,
      pid: lease?.pid ?? null,
      last_seen_seconds: lease ? Math.max(0, LEASE_SECONDS - (lease.expires_at - now)) : null,
    },

    // 2. WHAT IS IT DOING. A live run, or a task that is moving under its own
    // steam: not terminal, and waiting on nothing.
    doing: tasks
      .filter(t => t.running || (!TERMINAL_SET.has(t.phase) && !t.waiting.first))
      .map(t => ({ id: t.id, phase: t.phase, project: t.project, title: t.title,
                   running: t.running, age: t.age })),

    // 3. WHAT IS WAITING ON ME, AND FOR HOW LONG. Only the substates a human can
    // clear; the rest clear themselves, and listing them here turns the one line
    // that matters into a list of everything.
    //
    // `for_seconds` falls back to the age in state when the wait itself carries
    // no moment -- a switch being off is a state rather than an event, and the
    // honest elapsed figure is how long the task has sat there.
    waiting_on_you: tasks
      .filter(t => t.waiting.first && HUMAN_WAITS.has(t.waiting.first))
      .map(t => ({ id: t.id, project: t.project, title: t.title,
                   waiting: t.waiting.first,
                   capability: t.waiting.capability,
                   for_seconds: t.waiting.since !== null ? Math.max(0, now - t.waiting.since)
                                                         : (t.age?.seconds ?? null) })),

    // 4. WHAT DID IT DO SINCE I LAST LOOKED. `since` is the operator's own mark;
    // with none given the answer is an empty list rather than everything, because
    // "everything" is what they were trying not to read.
    since_you_looked: since === null ? [] : movedSince(db, since, now),

    // 5. WHAT DID IT DECLINE, FAIL OR REFUSE. Standing escalations, beside the
    // task that raised them.
    declined: tasks
      .filter(t => t.escalations.length)
      .flatMap(t => t.escalations.map(e => ({
        id: t.id, project: t.project, why: e.why, count: e.count,
        first_seen_at: e.first_seen_at, last_seen_at: e.last_seen_at }))),
  };
}

/**
 * Every transition since the operator's mark, newest first.
 *
 * From `phase_event`, which is the log of what actually moved. `task.updated_at`
 * would answer a different question -- it moves for compensations that change no
 * phase -- and a digest of "what happened" built on it reports rows that did
 * nothing.
 */
function movedSince(db, since, now) {
  return db.prepare(
    `SELECT task, at, op, from_phase, to_phase FROM phase_event
      WHERE at > ? AND at <= ? ORDER BY at DESC, seq DESC`).all(since, now)
    .map(e => ({ id: e.task, at: e.at, op: e.op, from: e.from_phase, to: e.to_phase }));
}

const secs = (n) => (n === null || n === undefined ? UNKNOWN : `${n}s`);

/** THE HUMAN TEXT IS NOT A STABLE INTERFACE. Parse `--json`, never this. */
export function renderDash(m) {
  const out = [];
  out.push(m.alive.running
    ? `builder RUNNING  pid ${m.alive.pid}  last seen ${secs(m.alive.last_seen_seconds)} ago`
    : "builder NOT RUNNING");

  const sw = Object.entries(m.switches);
  out.push("", "switches");
  if (!sw.length) out.push("  (no projects)");
  for (const [name, s] of sw)
    out.push(`  ${oneLine(name)}  ${s
      ? Object.entries(s).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(" ")
      : UNKNOWN}`);

  out.push("", `waiting on you (${m.waiting_on_you.length})`);
  if (!m.waiting_on_you.length) out.push("  nothing");
  for (const w of m.waiting_on_you)
    out.push(`  ${w.id}  ${w.waiting}${w.capability ? ` (${w.capability})` : ""}` +
             `  for ${secs(w.for_seconds)}  ${oneLine(w.title)}`);

  out.push("", `doing (${m.doing.length})`);
  if (!m.doing.length) out.push("  nothing");
  for (const d of m.doing)
    out.push(`  ${d.id}  ${d.phase}` +
             (d.running ? `  running ${d.running.phase}/${d.running.slice} attempt ${d.running.attempt}` : "") +
             `  in state ${secs(d.age?.seconds)}  ${oneLine(d.title)}`);

  out.push("", `declined (${m.declined.length})`);
  if (!m.declined.length) out.push("  nothing");
  for (const e of m.declined)
    out.push(`  ${e.id}  ${oneLine(e.why)}  x${e.count}  since ${e.first_seen_at}`);

  out.push("", m.since === null
    ? "since you looked  (no --since given)"
    : `since you looked (${m.since_you_looked.length})`);
  for (const e of m.since_you_looked)
    out.push(`  ${e.id}  ${e.op}  ${e.from ?? "-"} -> ${e.to ?? "-"}  at ${e.at}`);

  // Per task, the facts a digest owes beside the state: what is draining, what
  // territory is pinned and until when, and every UNKNOWN said out loud.
  out.push("", `tasks (${m.tasks.length})`);
  for (const t of m.tasks) {
    out.push(`  ${t.id}  ${t.phase}  ${oneLine(t.title)}` +
             (t.draining !== null ? `  draining ${t.draining}` : ""));
    for (const r of t.territory)
      out.push(`      territory ${r.kind} ${oneLine(r.path)}` +
               (r.pinned_until ? `  pinned until ${r.pinned_until}` : "") +
               `  expires ${r.expires_at}`);
    if (t.unknown.length) out.push(`      unknown: ${t.unknown.join(", ")}`);
  }
  return out.join("\n");
}
