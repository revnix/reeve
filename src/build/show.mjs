// show -- what is true about one task, as data.
//
// ONE VALUE, TWO RENDERERS. `--json` is the contract; the human text is not, and
// it is free to change shape in any release. That is why the version rides on
// the data and never on the prose.
//
// THE SIX WAITING SUBSTATES ARE DERIVED on every read and stored nowhere. A
// stored substate outlives the condition that produced it: a task filed while
// `observe` was on would go on reading "a worker is coming" after the switch went
// off, and the operator would wait for a dispatch that cannot happen.

import { CAPABILITY_NAMES, capabilityOn } from "./capabilities.mjs";
import { HELD } from "./phases.mjs";
import { openPrs } from "./prs.mjs";

/** The envelope every read surface in this family emits. One version, not three. */
export const READ_FORMAT_VERSION = 1;
export const envelope = (kind, data) => ({ format_version: READ_FORMAT_VERSION, kind, data });

/**
 * Rendered wherever a value is not known YET, and never null and never blank.
 *
 * Absent, unreadable and not-yet-decided are three different facts. Collapsing
 * them into an empty cell is the defect this repository pays for most often: the
 * reader cannot tell an answer of "nothing" from a question that was never
 * asked.
 */
export const UNKNOWN = "UNKNOWN";

/**
 * The six substates, in PRECEDENCE ORDER, which is also the only declaration of
 * that order -- the headline is `WAITING.find(...)`, so there is no second list
 * to disagree with this one.
 *
 * Ordered by WHO HAS TO ACT, humans first, and within that by whether the
 * condition can clear on its own:
 *
 *   FOUNDER     a human must act, and nothing else moves until they do
 *   CAPABILITY  a human must flip a switch; this one NEVER clears by itself, so
 *               it outranks every wait that eventually would
 *   NOTICE      a human must acknowledge a delivered notice
 *   CODEX       an external reviewer must answer
 *   GUARDIAN    another process must reach a verdict
 *   QUOTA       capacity, which clears without anyone doing anything
 *
 * The headline is a decision and the whole set is not: `waitingFor` reports both,
 * because a task can be held by a human AND queued behind capacity at once, and
 * a headline that hides the second answers a smaller question than the operator
 * asked.
 */
export const WAITING = Object.freeze([
  "WAITING_FOR_FOUNDER",
  "WAITING_FOR_CAPABILITY",
  "WAITING_FOR_NOTICE",
  "WAITING_FOR_CODEX",
  "WAITING_FOR_GUARDIAN",
  "WAITING_FOR_QUOTA",
]);

/**
 * Which capability the NEXT move out of each phase would need.
 *
 * A phase whose next move is nobody's -- terminal, held, or waiting on a human --
 * is ABSENT here, and absent means "no switch is stopping this", not "the switch
 * is on".
 *
 * The values are BARE switch names, and they are checked against the profile
 * schema at module load below. A name the schema does not declare would
 * otherwise read as "capability off" at every call site -- fail-closed, and
 * therefore invisible, which is exactly the shape `capabilityOn` was written to
 * make loud.
 */
export const NEEDS_SWITCH = Object.freeze({
  FILED: "observe", CLAIMING: "observe", SIZING: "observe",
  RESEARCH: "observe", DESIGN: "observe",
  SPEC_DRAFT: "draftSpec", SPEC_PR_OPEN: "draftSpec", GATE: "draftSpec",
  APPROVED: "implementLocal", IMPLEMENTING: "implementLocal",
  IMPL_PR_OPEN: "publishPr",
  // VERDICT_WAIT's implementation PR is already published; the next gated effect
  // is `gh.pr.merge`, which `capabilityFor` guards with `mergeBuilderPr`. Naming
  // `publishPr` here reports no wait under the ordinary staged configuration
  // (publishPr on, mergeBuilderPr off) even though merge actuation is exactly
  // what is disabled -- and names a switch for work that has already happened.
  VERDICT_WAIT: "mergeBuilderPr",
  SLICE_MERGED: "mergeBuilderPr", FINALIZING: "mergeBuilderPr",
});

// Checked HERE, at load, rather than at the call site that would read the
// answer. A typo in the table above produces `undefined` from any bare-name map,
// every gate in this system reads `!== true`, and the task would render as
// waiting for a switch nobody can find. Loud on import beats silent for ever.
for (const [phase, name] of Object.entries(NEEDS_SWITCH))
  if (!CAPABILITY_NAMES.includes(name))
    throw new Error(`NEEDS_SWITCH[${phase}] names ${JSON.stringify(name)}, ` +
      `which the profile schema does not declare (it declares ${CAPABILITY_NAMES.join(", ")})`);

/**
 * This profile's switches, by BARE name, with every declared switch present.
 *
 * THE ONE PRODUCER of the map `waitingFor` reads, and it exists because the
 * other reader in this codebase returns a different shape for a good reason:
 * `capabilitiesFrom` is keyed by the full dotted strings and OMITS any switch the
 * profile never declared, so that `leaseEffect` can tell "turned off" from "never
 * set". Handing that map to a bare-name lookup yields `undefined` for all five
 * switches and reports a perfectly enabled task as waiting on a capability --
 * silently, because every consumer treats not-true as off.
 *
 * So the map is built through `capabilityOn`, which accepts either key form and
 * THROWS on a name the schema does not declare, and every declared name appears.
 */
export function switchesFrom(profile) {
  return Object.freeze(Object.fromEntries(
    CAPABILITY_NAMES.map(n => [n, capabilityOn(profile, n)])));
}

/**
 * A per-project switch reader, memoised, with its I/O injected.
 *
 * PER PROJECT, and that is not a refinement. The switches live in each project's
 * own profile, `task list` spans every project at once, and one map applied to
 * the whole list would report one project's switches under another project's
 * name -- for a value whose entire job is to say why a particular task is not
 * moving.
 *
 * Returns null when the project's switches cannot be read at all: an entry gone
 * from the registry since the task was filed, or a profile that no longer parses.
 * Null is UNKNOWN and it is not `false`; answering "the switch is off" for a
 * question that was never asked is the collapse this module refuses everywhere
 * else.
 */
export function switchesResolver(entries, readProfile, { validate = null } = {}) {
  const seen = new Map();
  return (project) => {
    if (seen.has(project)) return seen.get(project);
    seen.set(project, resolveOne(entries?.[project], readProfile, validate));
    return seen.get(project);
  };
}

/**
 * One project's switches, or null, with every reason for null treated alike.
 *
 * VALIDATED AND IDENTITY-BOUND, not merely parsed. Two failures hide in a
 * profile that parses:
 *
 *   - `builder.capabilities.observe: "true"` is a STRING. The schema refuses it,
 *     but `capabilityOn` compares against `true` and answers `false` -- so an
 *     invalid profile reports `observe=off`, which reads as a decision the
 *     founder made rather than a file that is broken.
 *   - a registry entry whose `profilePath` points at ANOTHER project's profile
 *     validates perfectly. It is a valid profile; it is just not this one, and
 *     its switches would be reported under this project's name.
 *
 * Both become null, which the read model renders as UNKNOWN. Answering "off" for
 * a question that was never successfully asked is the collapse this module
 * refuses everywhere else.
 *
 * `reeve task file` performs these same three checks inline and EXITS on each,
 * because a filing must refuse rather than proceed on an unknown. That is a
 * second statement of one rule and it should become one; the two differ only in
 * what they do with the answer, so the predicate is what wants sharing.
 */
function resolveOne(entry, readProfile, validate) {
  if (!entry?.profilePath) return null;
  let profile = null;
  try { profile = readProfile(entry.profilePath); } catch { return null; }
  if (validate) {
    let ok = false;
    try { ok = validate(profile)?.ok === true; } catch { return null; }
    if (!ok) return null;
  }
  // A profile that names a different repository is not this project's profile,
  // however well formed it is. Absent is allowed: not every profile declares one.
  const declared = profile?.identity?.key;
  if (declared && entry.nwo && declared !== entry.nwo) return null;
  try { return switchesFrom(profile); } catch { return null; }
}

/**
 * Run a read against ONE SQLite snapshot.
 *
 * Every statement here runs in autocommit, so each `get`/`all` can observe a
 * different moment. With a live builder transitioning a task between the task-row
 * read and the evidence queries, one model could carry the old phase beside new
 * holds, runs or leases -- and `task list` could mix moments across rows, which
 * is a listing no single instant of the hub ever looked like.
 *
 * DEFERRED, not `BEGIN IMMEDIATE`. The repository's rule that a write must never
 * follow a deferred read is about connections that can write; this one is opened
 * `readOnly`, so no write can follow and there is no upgrade to deadlock on.
 * Failure to begin is not fatal: a snapshot is better than no snapshot, and no
 * snapshot is still better than refusing to answer.
 */
export function inSnapshot(db, fn) {
  let began = false;
  try { db.exec("BEGIN"); began = true; } catch { /* answer without one */ }
  try { return fn(); }
  finally { if (began) { try { db.exec("COMMIT"); } catch { /* read-only: nothing to undo */ } } }
}

/**
 * The provider run reference a builder phase claims a slot under.
 *
 * ONE PRODUCER AND ONE MATCHER, together, because they are two halves of one
 * fact. The dispatcher writes `<task>:<phase>` so that two phases of one task
 * cannot collide in the live-request unique index; a reader that matched the bare
 * task id would therefore find nothing, and `WAITING_FOR_QUOTA` would be a
 * substate the code could compute and never show.
 *
 * The matcher accepts both forms. A task id is `bt:<ulid>` and a ulid carries no
 * colon, so `<task>:` is an unambiguous prefix and a guardian's `pr:<n>` or
 * `canary:<nwo>` can never match one.
 */
export const builderRunRef = (taskId, phase) => `${taskId}:${phase}`;
export const isRunRefOf = (runRef, taskId) =>
  runRef === taskId || runRef.startsWith(`${taskId}:`);

/**
 * Every row-shaped fact the substates are derived from, read once.
 *
 * Taken in ONE function so `show` and `why` cannot each grow their own slightly
 * different set of reads. Two lists built from one source agree with each other
 * and prove nothing; two lists built separately disagree, and the disagreement
 * surfaces as one command contradicting another in front of an operator.
 *
 * The prefix matches use `substr` rather than `LIKE`: a `LIKE` pattern built
 * from an identifier is one metacharacter away from matching more than it was
 * asked to, and the comparison here wants no pattern language at all.
 */
export function evidenceFor(db, taskId, { now }) {
  const prefix = `${taskId}:`;
  const plen = prefix.length;
  return {
    now,
    holds: db.prepare(
      `SELECT reason, detail, at FROM hold_reason
        WHERE task = ? AND cleared_at IS NULL ORDER BY at`).all(taskId),
    // The task's OWN queued slot request, under either run-ref form.
    queued: db.prepare(
      `SELECT run_ref, requested_at, priority FROM provider_lease
        WHERE owner = 'builder' AND status = 'queued'
          AND (run_ref = ? OR substr(run_ref, 1, ?) = ?)
        ORDER BY requested_at LIMIT 1`).get(taskId, plen, prefix) ?? null,
    escalations: db.prepare(
      `SELECT why, count, first_seen_at, last_seen_at, announced_count FROM escalation
        WHERE substr(why, 1, ?) = ? ORDER BY first_seen_at`).all(plen, prefix),
    // Open means asked for and not yet answered by a Codex clean pass at that
    // same head. Grouped by head, because a task revises: an older head having
    // been answered says nothing about the head under review now.
    gateRequests: db.prepare(
      `SELECT head_sha, round, task_generation, requested_at FROM gate_request
        WHERE task = ? ORDER BY requested_at`).all(taskId),
    codexClean: db.prepare(
      `SELECT head_sha FROM approval WHERE task = ? AND kind = 'codex_clean'`).all(taskId),
    notices: db.prepare(
      `SELECT head_sha, kind, channel, delivered_at FROM notice_receipt WHERE task = ?`).all(taskId),
    liveRun: db.prepare(
      `SELECT phase, slice, attempt, status, model_id, cli_version, started_at, heartbeat_at,
              contract_drift
         FROM phase_run WHERE task = ? AND status IN ('live','adopted')
        ORDER BY started_at DESC LIMIT 1`).get(taskId) ?? null,
    lastRun: db.prepare(
      `SELECT phase, slice, attempt, status, model_id, cli_version, started_at
         FROM phase_run WHERE task = ? ORDER BY started_at DESC LIMIT 1`).get(taskId) ?? null,
    draining: db.prepare(
      `SELECT count(*) c FROM task_drain WHERE task = ? AND settled_at IS NULL`).get(taskId).c,
    territory: db.prepare(
      `SELECT kind, path, expires_at, pinned_until FROM territory_lease
        WHERE task = ? ORDER BY kind, path`).all(taskId),
    openPrs: openPrs(db, taskId),
  };
}

/**
 * Which of the six, from rows and switches alone. PURE: no database, no clock.
 *
 * `ev.switches` is a bare-name map from `switchesFrom`, or null when the
 * project's profile could not be read. Null is UNKNOWN: the capability wait is
 * neither claimed nor denied, and the caller is told which by `capability_known`.
 *
 * A map that is present but does not carry the switch being asked about is a
 * PROGRAMMING ERROR and throws. It is the shape a caller lands in by passing
 * `capabilitiesFrom`'s dotted-key map, and answering "off" for it would report an
 * enabled task as blocked, for ever, with nothing going red.
 */
export function waitingFor(row, ev) {
  const all = [];
  // ONE TIMESTAMP PER WAIT, and the scalar below is the HEADLINE's own.
  //
  // A single `since` filled by whichever branch ran first reported the quota
  // request's moment while `first` named a founder hold -- so anything measuring
  // "how long has this been waiting" got the age of a different condition, and
  // got it silently, because both are plausible integers.
  const at = Object.create(null);
  let capability = null, capabilityKnown = true;

  // A human must act. `hold_reason` is the durable record, and `HELD` is the
  // phases a task rests in while one stands; either alone is enough, because a
  // hold written without the phase move is still a hold.
  //
  // HELD IS IMPORTED, not restated. It is `["BLOCKED","ESCALATED"]`, and naming
  // only BLOCKED here missed every task that retry exhaustion or the gate
  // revision cap moved straight to ESCALATED -- transitions that write no
  // `hold_reason` row at all, so such a task rendered with no founder wait and
  // read as needing nobody, which is the opposite of true.
  if (ev.holds.length || HELD.includes(row.phase)) {
    all.push("WAITING_FOR_FOUNDER");
    at.WAITING_FOR_FOUNDER = ev.holds[0]?.at ?? null;
  }

  const need = NEEDS_SWITCH[row.phase];
  if (need) {
    if (ev.switches === null || ev.switches === undefined) {
      capabilityKnown = false;
      capability = need;
    } else {
      if (!(need in ev.switches))
        throw new Error(`waitingFor: the switch map carries no ${JSON.stringify(need)} ` +
          `(it has ${Object.keys(ev.switches).join(", ") || "no keys at all"}); ` +
          `build it with switchesFrom(profile), not capabilitiesFrom(profile)`);
      if (ev.switches[need] !== true) { all.push("WAITING_FOR_CAPABILITY"); capability = need; }
    }
  }

  // THE CURRENT HEAD, and nothing else. Both gate waits below are scoped to it.
  //
  // A task REVISES. Codex requests changes on head A, the task pushes head B, and
  // A never receives a clean pass -- so a check that asks "is any historical
  // request unanswered" answers yes for ever, long after B was answered and even
  // after the task has left the gate entirely. The same argument holds for a
  // notice delivered at A that the founder answered by requesting changes: the
  // push of B voids A's window rather than leaving it open.
  //
  // The head comes from the OPEN SPEC PULL REQUEST, because migration 2 dropped
  // `task.spec_head` and `task.spec_pr` and moved both onto `task_pr`. With no
  // open spec PR there is no head under review, and neither wait can be
  // outstanding -- which is the true answer, not a missing one.
  const specPr = ev.openPrs.find(p => p.kind === "spec") ?? null;
  const head = specPr?.head_sha ?? null;

  if (head !== null) {
    const acked = ev.notices.some(n => n.kind === "founder_ack" && n.head_sha === head);
    const delivered = ev.notices.filter(n => n.kind === "delivered" && n.head_sha === head);
    if (delivered.length && !acked) {
      all.push("WAITING_FOR_NOTICE");
      at.WAITING_FOR_NOTICE = Math.min(...delivered.map(n => n.delivered_at));
    }

    // Asked for review AT THIS HEAD, for THIS generation, with no Codex clean
    // pass at that head. A regenerate resets the contract, so a request recorded
    // under an older generation is not a question about the task as it now is.
    const clean = new Set(ev.codexClean.map(a => a.head_sha));
    const open = ev.gateRequests.filter(g => g.head_sha === head &&
                                             g.task_generation === row.generation &&
                                             !clean.has(g.head_sha));
    if (open.length) {
      all.push("WAITING_FOR_CODEX");
      at.WAITING_FOR_CODEX = Math.min(...open.map(g => g.requested_at));
    }
  }

  // The guardian owes this task a verdict. Its verdicts live in the guardian's
  // own per-repo store, which the hub deliberately cannot read, so the phase IS
  // the fact the hub holds: VERDICT_WAIT means the wait is outstanding, and the
  // move out of it is what records the answer.
  if (row.phase === "VERDICT_WAIT") all.push("WAITING_FOR_GUARDIAN");

  if (ev.queued) {
    all.push("WAITING_FOR_QUOTA");
    at.WAITING_FOR_QUOTA = ev.queued.requested_at;
  }

  const first = WAITING.find(w => all.includes(w)) ?? null;
  // The headline's OWN moment, or null where the condition has no timestamp to
  // give -- a capability switch and a guardian verdict are states, not events,
  // and inventing a moment for them would be worse than saying there is none.
  const since = first === null ? null : (at[first] ?? null);
  return { first, all, since, capability, capability_known: capabilityKnown };
}

const orUnknown = v => (v === null || v === undefined || v === "" ? UNKNOWN : v);

/**
 * One task, as data. `null` when there is no such task, and the caller decides
 * what that means -- a missing task is a refusal at the CLI and an ordinary
 * absence to anything iterating.
 */
export function taskShow(db, taskId, { now, switchesFor }) {
  const row = db.prepare("SELECT * FROM task WHERE id = ?").get(taskId);
  if (!row) return null;
  const ev = { ...evidenceFor(db, taskId, { now }), switches: switchesFor(row.project) };
  const model = {
    id: row.id, project: row.project, nwo: row.nwo_snapshot, title: row.title,
    phase: row.phase, generation: row.generation, priority: row.priority,
    created_at: row.created_at,
    depth: orUnknown(row.depth),
    model: orUnknown(ev.liveRun?.model_id ?? ev.lastRun?.model_id),
    cli_version: orUnknown(ev.liveRun?.cli_version ?? ev.lastRun?.cli_version),
    switches: ev.switches,
    waiting: waitingFor(row, ev),
    // `drift` RIDES WITH THE RUN. A run whose frozen contract no longer matches
    // the live environment is not a run an operator should read as current, and
    // dropping the column here left `show` unable to say so at all.
    running: ev.liveRun
      ? { phase: ev.liveRun.phase, slice: ev.liveRun.slice, attempt: ev.liveRun.attempt,
          since: ev.liveRun.started_at, drift: ev.liveRun.contract_drift ?? null }
      : null,
    draining: row.phase === "CANCELLING" ? ev.draining : null,
    territory: ev.territory,
    escalations: ev.escalations,
    prs: ev.openPrs,
    unknown: [],
  };
  // NAMED rather than searched for. A reader scanning the values for the literal
  // string finds it inside a title too, and would then report a field as unknown
  // because somebody wrote UNKNOWN in the subject line.
  for (const k of ["depth", "model", "cli_version"]) if (model[k] === UNKNOWN) model.unknown.push(k);
  if (!model.waiting.capability_known) model.unknown.push("switches");
  return model;
}

export function taskList(db, { now, switchesFor, project = null }) {
  const ids = (project === null
    ? db.prepare("SELECT id FROM task ORDER BY created_at, id").all()
    : db.prepare("SELECT id FROM task WHERE project = ? ORDER BY created_at, id").all(project)
  ).map(r => r.id);
  return ids.map(id => taskShow(db, id, { now, switchesFor }));
}

/** Every project the hub itself knows about, so a filter can be checked against reality. */
export const projectsWithTasks = (db) =>
  db.prepare("SELECT DISTINCT project FROM task ORDER BY project").all().map(r => r.project);

// ── renderers ────────────────────────────────────────────────────────────────
//
// THE HUMAN TEXT IS NOT A STABLE INTERFACE. It is free to change shape in any
// release, and anything parsing it is broken by design. `--json` is what a script
// reads, and its envelope carries the version that says so.

const waitingLine = (w) => {
  if (!w.first && w.capability_known) return "nothing";
  if (!w.first) return `nothing that can be read (${w.capability} is unknown: the project's profile could not be read)`;
  if (w.first !== "WAITING_FOR_CAPABILITY") return w.first;
  return `${w.first} (${w.capability} is off)`;
};

export function renderShow(m) {
  const lines = [
    `${m.id}  ${m.phase}  gen ${m.generation}  ${m.priority}`,
    `  ${m.title}`,
    `  project      ${m.project} (${m.nwo})`,
    `  depth        ${m.depth}`,
    `  model        ${m.model}`,
    `  waiting on   ${waitingLine(m.waiting)}`,
  ];
  if (m.waiting.all.length > 1)
    lines.push(`  also waiting ${m.waiting.all.filter(x => x !== m.waiting.first).join(", ")}`);
  lines.push(`  switches     ${m.switches
    ? Object.entries(m.switches).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(" ")
    : UNKNOWN}`);
  if (m.running)
    lines.push(`  running      ${m.running.phase}/${m.running.slice} attempt ${m.running.attempt}`);
  if (m.draining !== null) lines.push(`  draining     ${m.draining} row(s) still to settle`);
  for (const t of m.territory)
    lines.push(`  territory    ${t.kind} ${t.path}` +
               (t.pinned_until ? `  pinned until ${t.pinned_until}` : "") +
               `  expires ${t.expires_at}`);
  for (const e of m.escalations) lines.push(`  escalation   ${e.why}  x${e.count}`);
  for (const p of m.prs) lines.push(`  pull request ${p.kind} #${p.pr}  ${p.head_sha}`);
  if (m.unknown.length) lines.push(`  unknown      ${m.unknown.join(", ")}`);
  return lines.join("\n");
}

export function renderList(models) {
  if (!models.length) return "no tasks";
  // UNKNOWN IS NOT A DASH. `-` is what a task known not to be waiting prints, and
  // printing it for a task whose capability could not be read reports an
  // unreadable decision as healthy -- in the one view an operator scans to decide
  // where to look, and while `show` correctly says UNKNOWN about the same task.
  const wait = (m) => m.waiting.first ?? (m.waiting.capability_known ? "-" : UNKNOWN);
  return models.map(m =>
    `${m.id}  ${m.phase.padEnd(13)} ${wait(m).padEnd(23)} ${m.title}`).join("\n");
}
