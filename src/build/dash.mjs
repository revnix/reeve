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
import { hubIncarnation } from "./hubdb.mjs";
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
/**
 * A cursor is `<seq>.<at>.<incarnation>` -- opaque to the operator, who copies
 * what the digest printed.
 *
 * THE INCARNATION IS THE PROOF, and the other two fields are what the cursor
 * MEANS. `seq` says where in the log the operator stopped reading; `at` is the
 * older evidence that the log is the same one, kept because a cursor issued
 * before the incarnation table existed still has to be readable.
 *
 * A TRAILING FIELD RATHER THAN A NEW FORMAT, so a cursor written by yesterday's
 * binary still parses and still answers. It reads with a WEAKER guarantee, which
 * `cursor_proof` reports rather than leaves as an impression -- the whole defect
 * this closes was a check that looked like proof and was not.
 *
 * The id is 32 hex characters, so it can never contain the separator and the
 * three fields cannot be confused for one another.
 */
export const formatCursor = (seq, at, incarnation = null) =>
  incarnation ? `${seq}.${at}.${incarnation}` : `${seq}.${at}`;
export function parseCursor(raw) {
  // STRICT ON THE THIRD FIELD. A mistyped incarnation refused as unparseable is a
  // misuse the CLI can name; accepted, it would differ from the hub's and report
  // a RESTORE that never happened -- sending an operator to look for damage
  // because they fumbled a paste.
  const m = /^(\d+)\.(\d+)(?:\.([0-9a-f]{32}))?$/.exec(String(raw ?? ""));
  return m ? { seq: Number(m[1]), at: Number(m[2]), incarnation: m[3] ?? null } : null;
}

export function dashModel(db, { now, switchesFor, projects = [], since = null, isAlive }) {
  if (typeof isAlive !== "function")
    throw new Error("dashModel needs an isAlive predicate: an unexpired lease is not a running process, " +
      "and defaulting it here would make the digest's first line a guess");
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
  // `lstart` IS SELECTED, and `isAlive` is injected. An unexpired lease is not a
  // running builder: a crash inside the 120-second window leaves the row intact,
  // and reading only the clock reports work proceeding for up to two minutes
  // after everything stopped. `build status` already distinguishes these with
  // `isSameProcess(pid, lstart)` -- pid AND lstart, because pids are reused and
  // lstart is what tells this process from whatever inherited its number.
  const lease = db.prepare(
    `SELECT pid, lstart, acquired_at, expires_at FROM singleton_lease
      WHERE name = 'builder'`).get() ?? null;
  // RUNNING IS THE PROCESS, NOT THE CLOCK. `build status` determines it from
  // `isSameProcess(pid, lstart)` alone, and `acquireSingleton` refuses a takeover
  // while the holder is alive EVEN AFTER EXPIRY -- "expired alone is not enough:
  // a busy process can miss a heartbeat, and killing its authority while it is
  // mid-effect is the race, not the fix." Requiring both would report a live
  // builder as stopped whenever a tick blocks past the lease, and would disagree
  // with the authority rule about who is holding the hub.
  //
  // The two facts stay apart: `running` answers "is anyone there", and
  // `lease_unexpired` answers "is its claim still fresh". A live holder with a
  // stale lease is a slow tick; a dead holder with a fresh one is a crash.
  const unexpired = !!lease && lease.expires_at > now;
  const holderAlive = !!lease && isAlive(lease.pid, lease.lstart);

  // The moment of the last orderly shutdown, from the append-only log.
  const released = db.prepare(
    `SELECT at FROM hub_event WHERE kind = 'lease.singleton.released'
      ORDER BY seq DESC LIMIT 1`).get()?.at ?? null;

  const head = db.prepare(
    "SELECT seq, at FROM phase_event ORDER BY seq DESC LIMIT 1").get() ?? null;
  const highWater = head?.seq ?? 0;
  // A CURSOR CARRIES THE EVENT IT NAMES, not just its number.
  //
  // `since > highWater` catches a restore only while the log is still SHORTER
  // than the cursor. Restore to 50, let the builder write through 100, and
  // sequence 100 exists again -- a different event wearing the same number, and
  // events 51-100 of the new incarnation are skipped for ever with nothing
  // reporting it.
  //
  // WHAT THIS CATCHES, AND WHAT IT DOES NOT. A restored log is a PREFIX of the
  // old one, so an event that survives keeps its `at` and one written afterwards
  // usually does not -- the cursor therefore carries the event it names, and a
  // sequence wearing a different row is caught.
  //
  // It was NOT proof, and now it is -- when both ends can supply an identity.
  // `at` has integer-second resolution and is not unique, so a log restored and
  // regrown to the same sequence WITHIN ONE SECOND presents an identical
  // (seq, at) and the timestamp check accepts it. Every event through that
  // sequence in the new incarnation is then omitted permanently and the digest
  // reports it as a quiet period.
  //
  // The hub now carries a durable per-incarnation id, minted on creation and
  // re-minted by a restore, so the cursor carries it too and the check COMPARES
  // IDENTITIES rather than inferring one from a timestamp. Two different logs
  // cannot present the same id, whatever their clocks did.
  //
  // THE FALLBACK IS NOT A SECOND RULE, it is the older rule kept for the cursors
  // that predate the new one. A cursor without an incarnation, or a hub too old
  // to have one, cannot be answered by identity at all -- so it is answered the
  // old way, with the old bound, and `cursor_proof` says which of the two
  // answered rather than letting a weaker check pass for the stronger one.
  //
  // `hubIncarnation` THROWS on a migrated hub whose row is missing, and that is
  // deliberately not caught here. It distinguishes "predates the table" (null)
  // from "the table is damaged" (throws), and swallowing the throw would collapse
  // exactly the distinction it exists to draw, reporting damage as an ordinary
  // older store. The read route already turns it into a typed refusal.
  // THREE OUTCOMES, KEPT AS THREE. `hubIncarnation` answers a row, `null` for a
  // store that genuinely predates the table, or THROWS for one that records the
  // migration and has no row -- which is damage, and each of those three was put
  // there by a review finding.
  //
  // Catching the throw into `null` would rebuild the exact misclassification the
  // throw exists to prevent, one layer up: a hand-repaired or partially restored
  // store would render as an ordinary old hub and the operator would read
  // "cannot prove" for a store that has been altered outside reeve.
  //
  // Letting it out raw is not the other half of that choice. A stack trace is not
  // an interface for a state an operator has to act on, and this surface exists
  // to answer "what is going on" rather than to fail at it. So the damage becomes
  // its own visible answer, carrying the recovery line the error already holds --
  // and ONLY the marked verdict is caught, so anything else still propagates.
  let incarnation = null, incarnationDamaged = null;
  try { incarnation = hubIncarnation(db)?.id ?? null; }
  catch (e) {
    if (!e?.hubDamaged) throw e;
    incarnationDamaged = e.message;
  }
  const provable = since !== null && since.incarnation !== null && incarnation !== null;
  const atOf = (seq) => db.prepare("SELECT at FROM phase_event WHERE seq = ?").get(seq)?.at ?? null;
  const rewound = since !== null &&
    (since.seq > highWater ||
     (provable
       ? since.incarnation !== incarnation
       : (since.seq > 0 && atOf(since.seq) !== since.at)));

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

    // 1. IS IT ALIVE. A heartbeat and when it was last seen. `running` reads the
    // CLOCK, never the row's existence: a lease row outlives the process that
    // took it, which is what makes it a lease. `null` rather than 0 for last-seen
    // when there is none, because never-seen and seen-just-now are different
    // facts and 0 is an answer to the second.
    alive: {
      running: holderAlive,
      // The two facts kept apart rather than collapsed: a lease that has not
      // expired but whose holder is gone is a CRASH, and it reads differently
      // from an orderly stop. Collapsing them into one boolean loses exactly the
      // distinction an operator needs at the moment it matters most.
      lease_unexpired: unexpired,
      pid: lease?.pid ?? null,
      // NEVER-SEEN AND CLEANLY-STOPPED ARE DIFFERENT FACTS. `releaseSingleton`
      // DELETES the row on every orderly shutdown, so an absent lease was
      // reporting "never seen" about a builder that exited five seconds ago. The
      // append-only `lease.singleton.released` event outlives the row and is
      // where that moment still lives.
      last_seen_seconds: lease
        ? Math.max(0, LEASE_SECONDS - (lease.expires_at - now))
        : (released === null ? null : Math.max(0, now - released)),
      last_seen_from: lease ? "lease" : (released === null ? null : "released_event"),
    },

    // 2. WHAT IS IT DOING. A live run, or a task that is moving under its own
    // steam: not terminal, and waiting on nothing.
    // A RUNNING TASK IS OBSERVED; every other member of this list is INFERRED
    // from having nothing against it, so the inference must not be made on
    // unknowns. When a project's profile cannot be read, `capability_known` is
    // false and there is no headline wait -- not because the task is moving, but
    // because nobody could tell. Calling that "doing" reports progress on
    // evidence that is missing.
    // A LIVE RUN IS OBSERVED; everything else here is INFERRED from having
    // nothing against it, and that inference needs a builder to be running. With
    // no process at all -- never started, or cleanly stopped -- a newly filed
    // task has no wait recorded against it and was being described as doing work
    // on a digest whose own first line said NOT RUNNING.
    doing: tasks
      .filter(t => t.running ||
                   (holderAlive && !TERMINAL_SET.has(t.phase) &&
                    !t.waiting.first && t.waiting.capability_known))
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
                   // ONLY when the headline IS the capability wait. `waitingFor`
                   // sets `capability` whenever the phase needs a switch, so
                   // copying it unconditionally rendered
                   // `WAITING_FOR_FOUNDER (observe)` -- pairing a founder hold
                   // with a switch that belongs to a different condition, or is
                   // merely unknown.
                   capability: t.waiting.first === "WAITING_FOR_CAPABILITY"
                     ? t.waiting.capability : null,
                   // UNKNOWN, NOT THE PHASE AGE. A switch has no recorded moment
                   // of being turned off, and borrowing the age in state answers a
                   // different question: a task that worked in SIZING for ten days
                   // before `observe` was disabled a minute ago would report a
                   // ten-day wait and outrank every genuine one. Nulls sort last,
                   // so an unknown duration makes no claim on attention rather
                   // than the strongest possible one.
                   // THE PHASE-ENTRY TIME WHERE THE HOLD LEFT NO ROW. Retry
                   // exhaustion and the gate's revision cap move a task straight
                   // to ESCALATED and write no `hold_reason` at all, so the
                   // founder wait is inferred from the phase and carries no
                   // moment of its own. Reporting nothing for it sorted the
                   // oldest escalation below every timed wait -- burying exactly
                   // the row that had waited longest, in the list whose whole
                   // purpose is to say what to look at first. `phase_event`
                   // records when the task entered the held phase, and that IS
                   // when the wait began.
                   //
                   // A CAPABILITY WAIT STILL REPORTS NOTHING, for the reason
                   // above: the phase age answers a different question there.
                   for_seconds: t.waiting.since !== null
                     ? Math.max(0, now - t.waiting.since)
                     : t.waiting.first === "WAITING_FOR_CAPABILITY"
                       ? null : t.age?.seconds ?? null,
                   // WHICH MOMENT PRODUCED THE FIGURE. Two clocks can answer
                   // this and they mean different things; `age` already carries
                   // its provenance for the same reason.
                   for_from: t.waiting.since !== null
                     ? "hold"
                     : t.waiting.first === "WAITING_FOR_CAPABILITY"
                       ? null : t.age?.from ?? null }))
      // LONGEST FIRST. `for_seconds` exists to decide what to handle first, and
      // leaving the list in task-creation order means the number is printed and
      // not used. A null elapsed sorts last -- it is the weakest claim on
      // attention, not the strongest -- and the id breaks ties so two runs over
      // one hub produce the same order.
      .sort((a, b) => (b.for_seconds ?? -1) - (a.for_seconds ?? -1) || a.id.localeCompare(b.id)),

    // 4. WHAT DID IT DO SINCE I LAST LOOKED. `since` is the operator's own mark;
    // with none given the answer is an empty list rather than everything, because
    // "everything" is what they were trying not to read.
    // THE CURSOR IS A SEQUENCE, NOT A TIMESTAMP. An operator reusing a previous
    // digest's `generated_at` as `--since` loses every transition committed in
    // that same whole second -- and loses it for ever, because the next cursor is
    // later still. `phase_event.seq` is lossless and monotonic, and
    // `next_cursor` is handed back so the operator never has to construct one.
    since_you_looked: since === null || rewound ? [] : movedSince(db, since.seq),
    next_cursor: formatCursor(highWater, head?.at ?? 0, incarnation),
    // A RESTORE REWINDS THE LOG. `phase_event.seq` is monotonic within one hub,
    // not across a restore: replacing the store with an older snapshot can put
    // the high-water mark BELOW a cursor issued before it. Every later
    // transition is then `seq <= since` and reads as "nothing moved" for ever,
    // while the digest hands back a smaller cursor the client dutifully saves.
    //
    // Nothing readable after the fact distinguishes that from a genuinely quiet
    // period, which is why it is reported rather than inferred: a cursor ahead of
    // the log is PROOF the log is not the one that issued it.
    cursor_rewound: rewound,
    // WHICH CHECK ANSWERED, said out loud. `cursor_rewound: false` from an
    // identity comparison is proof; the same false from the timestamp fallback
    // is "no evidence of a restore", and the two are worth different amounts to
    // anything deciding whether to trust the movement list. Reporting the
    // stronger and the weaker answer as one value is the defect this closes.
    // `null` where no cursor was given: there was nothing to prove.
    cursor_proof: since === null ? null : provable ? "incarnation" : "timestamp",
    // The hub's own identity, so a client holding several cursors can tell which
    // of them belong to this log without asking for each in turn.
    incarnation,
    // AND THE REASON THERE IS NONE, when the reason is damage rather than age.
    // `incarnation: null` alone cannot distinguish a store older than the table
    // from one whose row was removed, and those need opposite responses: the
    // first is fine and the second is a hub altered outside reeve.
    incarnation_damaged: incarnationDamaged,
    since: since === null ? null : formatCursor(since.seq, since.at, since.incarnation),

    // 5. WHAT DID IT DECLINE, FAIL OR REFUSE. Standing escalations, beside the
    // task that raised them.
    // BUILDER-SCOPED ROWS TOO. `evidenceFor` attaches escalations whose key is
    // prefixed by a task id, which is right for a task's own view and hides the
    // whole `builder:` family -- `builder:sandbox:canary-failed`,
    // `builder:backup:failed`, `builder:probe:merged`. Those belong to no task,
    // and they are the failures that most need an operator: the last of them is
    // a P0 that also writes the HALT marker. A digest of "what did it decline"
    // that cannot show them is answering a smaller question than it claims.
    declined: [
      ...tasks.filter(t => t.escalations.length).flatMap(t => t.escalations.map(e => ({
        id: t.id, project: t.project, scope: "task", why: e.why, count: e.count,
        first_seen_at: e.first_seen_at, last_seen_at: e.last_seen_at }))),
      ...builderEscalations(db).map(e => ({
        id: null, project: null, scope: "builder", why: e.why, count: e.count,
        first_seen_at: e.first_seen_at, last_seen_at: e.last_seen_at })),
    ],
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
/**
 * Standing escalations that belong to the builder rather than to any task.
 *
 * `substr` rather than `LIKE`: a pattern built from an identifier is one
 * metacharacter away from matching more than it was asked to, and this comparison
 * wants no pattern language at all.
 */
function builderEscalations(db) {
  return db.prepare(
    `SELECT why, count, first_seen_at, last_seen_at FROM escalation
      WHERE substr(why, 1, 8) = 'builder:' ORDER BY first_seen_at`).all();
}

function movedSince(db, since, now) {
  return db.prepare(
    `SELECT seq, task, at, op, from_phase, to_phase FROM phase_event
      WHERE seq > ? ORDER BY seq DESC`).all(since)
    .map(e => ({ seq: e.seq, id: e.task, at: e.at, op: e.op, from: e.from_phase, to: e.to_phase }));
}

const secs = (n) => (n === null || n === undefined ? UNKNOWN : `${n}s`);

/** THE HUMAN TEXT IS NOT A STABLE INTERFACE. Parse `--json`, never this. */
export function renderDash(m) {
  const out = [];
  // LAST-SEEN IS PRINTED WHETHER OR NOT IT IS RUNNING. The state where an
  // operator most needs to know whether the last heartbeat was seconds or hours
  // ago is precisely the one where it is NOT running, and the model carried the
  // figure while the text threw it away. `lease_unexpired` without a live holder
  // is a crash, and it reads differently from an orderly stop.
  const seen = m.alive.last_seen_seconds === null
    ? "never seen"
    : `last seen ${secs(m.alive.last_seen_seconds)} ago`;
  out.push(m.alive.running
    // A LIVE HOLDER PAST ITS LEASE is a tick that has not come back. The process
    // is alive, so RUNNING is the honest word for it, and the two facts are kept
    // apart in the model precisely because collapsing them loses this one. Saying
    // only RUNNING left the wedged case reading exactly like the healthy one, and
    // an operator would have had to know the lease interval and infer it from the
    // last-seen figure.
    ? `builder RUNNING  pid ${m.alive.pid}  ${seen}` +
      (m.alive.lease_unexpired ? "" : "  LEASE STALE: this tick has outrun its lease")
    : `builder NOT RUNNING  ${seen}` +
      (m.alive.lease_unexpired ? `  (lease still held by pid ${m.alive.pid}: it crashed)` : ""));

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
    // THE PROJECT, BESIDE THE TASK. A digest spans every project on the machine,
    // and the switches block names projects without associating any task with
    // one -- so an operator reading a row could not tell which repository it
    // belonged to, in the list that tells them what to act on.
    out.push(`  ${w.id}  ${oneLine(w.project)}  ${w.waiting}` +
             `${w.capability ? ` (${w.capability})` : ""}` +
             `  for ${secs(w.for_seconds)}  ${oneLine(w.title)}`);

  out.push("", `doing (${m.doing.length})`);
  if (!m.doing.length) out.push("  nothing");
  for (const d of m.doing)
    // DRIFT RIDES WITH THE RUN. `show` warns that a run whose frozen contract no
    // longer matches the live environment must not be read as current; printing
    // the run here without it presents exactly that run as an ordinary one.
    out.push(`  ${d.id}  ${oneLine(d.project)}  ${d.phase}` +
             (d.running ? `  running ${d.running.phase}/${d.running.slice} attempt ${d.running.attempt}` +
                          // THE ATTEMPT'S OWN AGE, not the phase's. A retried
                          // phase keeps its entry time while the live attempt
                          // began seconds ago, so one figure made a fresh attempt
                          // look hours old -- and the number an operator needs to
                          // decide whether a run is wedged is this one.
                          (d.running.since !== null
                            ? `  attempt started ${secs(Math.max(0, m.generated_at - d.running.since))} ago`
                            : "") +
                          (d.running.drift ? `  DRIFT ${oneLine(d.running.drift)}` : "") : "") +
             `  in state ${secs(d.age?.seconds)}  ${oneLine(d.title)}`);

  out.push("", `declined (${m.declined.length})`);
  if (!m.declined.length) out.push("  nothing");
  for (const e of m.declined)
    out.push(`  ${e.id}  ${oneLine(e.why)}  x${e.count}  since ${e.first_seen_at}`);

  out.push("", m.cursor_rewound
    ? `since you looked  CURSOR REWOUND: --since ${m.since} is ahead of this hub's log ` +
      "(it was restored). Resync from the cursor below."
    : m.since === null
      ? "since you looked  (no --since given)"
      : `since you looked (${m.since_you_looked.length})`);
  for (const e of m.since_you_looked)
    out.push(`  ${e.id}  ${e.op}  ${e.from ?? "-"} -> ${e.to ?? "-"}  at ${e.at}`);
  // THE CURSOR, IN THE TEXT. The model promises to hand one back so the operator
  // never constructs one; printing it only under --json makes that promise
  // reachable exclusively by the people who did not need it.
  out.push(`  next: --since ${m.next_cursor}`);
  // THE WEAKER ANSWER IS SAID OUT LOUD, and only the weaker one. Printing a line
  // for the proof case too would train the reader past both, and the strong case
  // is the one that needs no caveat -- so silence here means proof, and the only
  // sentence on this subject is the one that changes what the reader may conclude.
  // DAMAGE FIRST, because it changes what every other line on this subject is
  // worth. The sentence is the error's own, so the recovery command an operator
  // needs is not re-typed here and cannot drift from the one hubdb prints.
  if (m.incarnation_damaged)
    out.push(`  HUB DAMAGED: ${m.incarnation_damaged.split("\n")[0]}`,
             ...m.incarnation_damaged.split("\n").slice(1).map(l => `  ${l.trim()}`));
  if (m.cursor_proof === "timestamp")
    out.push("  note: this cursor predates the hub's incarnation id, so a restore is " +
             "inferred from timestamps and a same-second restore can pass unseen. " +
             "The cursor above carries the id; the next call is provable.");

  // Per task, the facts a digest owes beside the state: what is draining, what
  // territory is pinned and until when, and every UNKNOWN said out loud.
  out.push("", `tasks (${m.tasks.length})`);
  for (const t of m.tasks) {
    // THE WAIT IS PRINTED HERE TOO. A task waiting on quota, the guardian or a
    // reviewer is in neither `waiting_on_you` nor `doing` -- correctly, those
    // clear themselves -- and without the substate on its own row it appears as
    // an unexplained phase. Not-yours is not the same as not-diagnosable.
    out.push(`  ${t.id}  ${oneLine(t.project)}  ${t.phase}  ${oneLine(t.title)}` +
             (t.waiting.first ? `  ${t.waiting.first}` : "") +
             // AND EVERY OTHER WAIT STANDING AGAINST IT. The model keeps the full
             // set because clearing the headline can leave the task blocked on
             // something else; printing only the headline told an operator that
             // one condition stood, and they would act on it and find the task
             // exactly where they left it.
             (t.waiting.all.length > 1
               ? `  also ${t.waiting.all.filter(w => w !== t.waiting.first).join(" ")}` : "") +
             (t.waiting.first === "WAITING_FOR_CAPABILITY" && t.waiting.capability
               ? ` (${t.waiting.capability})` : "") +
             // AGE ON EVERY ROW. A task waiting on quota, the guardian or a
             // reviewer is in neither list above, and those are exactly the rows
             // where a brief wait and one that has lasted days look identical
             // without it.
             `  in state ${secs(t.age?.seconds)}` +
             (t.draining !== null ? `  draining ${t.draining}` : ""));
    for (const r of t.territory)
      out.push(`      territory ${r.kind} ${oneLine(r.path)}` +
               (r.pinned_until ? `  pinned until ${r.pinned_until}` : "") +
               `  expires ${r.expires_at}`);
    // THE PULL REQUESTS, IN THE TEXT. The model carries every open PR for the
    // task and the JSON hands them over, while the default rendering finished the
    // row without reading the list -- so the operator who did not think to ask for
    // JSON could not see that a task was waiting on a review that already exists.
    // Same three facts and same order as `task show`, because a reader who learns
    // the shape in one place should not have to learn it twice.
    for (const p of t.prs)
      out.push(`      pull request ${p.kind} #${p.pr}  ${p.head_sha}`);
    if (t.unknown.length) out.push(`      unknown: ${t.unknown.join(", ")}`);
  }
  return out.join("\n");
}
