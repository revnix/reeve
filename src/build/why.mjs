// why -- the evidence lineage behind one task, in the order it accumulated.
//
// THREE ANSWERS, NEVER TWO: a section with rows, a section with NO rows, and a
// field whose value is not known yet. An empty array rendered as blank space is
// indistinguishable from a healthy task with nothing to report, and that
// confusion is the defect this repository has measured most often -- absent and
// unreadable are different facts, and an instrument that cannot tell them apart
// answers a smaller question and reports success.
//
// A task filed one minute ago has none of the middle sections. The failure that
// matters there is not a crash, because a crash is loud; it is an empty render
// that reads as "nothing went wrong".

import { evidenceFor, isRunRefOf, UNKNOWN, READ_FORMAT_VERSION } from "./show.mjs";

const orUnknown = v => (v === null || v === undefined || v === "" ? UNKNOWN : v);

/** Every section `why` can report, so the absent list is checked against a closed set. */
export const SECTIONS = Object.freeze(
  ["events", "runs", "lease", "drain", "prs", "escalations", "holds", "gate"]);

export function whyModel(db, taskId, { now }) {
  const row = db.prepare("SELECT * FROM task WHERE id = ?").get(taskId);
  if (!row) return null;
  const ev = evidenceFor(db, taskId, { now });

  const events = db.prepare(
    `SELECT seq, at, op, from_phase, to_phase, from_generation, to_generation, slice,
            artifact_sha, detail
       FROM phase_event WHERE task = ? ORDER BY seq`).all(taskId);
  const runs = db.prepare(
    `SELECT phase, slice, attempt, status, started_at, outcome, model_id, cli_version, effort,
            max_turns, max_budget_usd, snapshot_hash, contract_drift
       FROM phase_run WHERE task = ? ORDER BY started_at, attempt`).all(taskId);
  const drain = db.prepare(
    `SELECT outbox_id, recorded_at, settled_at, forced, last_known
       FROM task_drain WHERE task = ? ORDER BY outbox_id`).all(taskId);

  // The lease is found through the SAME matcher the substate uses, not through a
  // second predicate written here. Two matchers over one column drift, and the
  // drift shows up as `task show` reporting a wait that `task why` cannot find.
  const lease = db.prepare(
    `SELECT owner, run_ref, status, priority, requested_at, started_at, expires_at, preempt_requested
       FROM provider_lease WHERE owner = 'builder' ORDER BY requested_at DESC`)
    .all().find(r => isRunRefOf(r.run_ref, taskId)) ?? null;

  // The floors that fired at SIZING, read from the transition that recorded them.
  // The model proposes a depth and code disposes the floors, so the lineage shows
  // WHICH FLOOR FIRED rather than what the model said it wanted.
  const sizing = events.find(e => e.op === "sizing.decided");
  let floors = [];
  try { floors = JSON.parse(sizing?.detail ?? "{}")?.floors ?? []; } catch { floors = []; }
  if (!Array.isArray(floors)) floors = [];

  // Gate rounds, each paired with whether a Codex clean pass exists AT THAT HEAD.
  // Pairing at the head is the whole content of the section: a clean pass on an
  // earlier head is not an answer about the head under review now.
  const clean = new Set(ev.codexClean.map(a => a.head_sha));
  const acked = new Set(ev.notices.filter(n => n.kind === "founder_ack").map(n => n.head_sha));
  const gate = ev.gateRequests.map(g => ({
    head_sha: g.head_sha, round: g.round, requested_at: g.requested_at,
    codex_clean: clean.has(g.head_sha), founder_acked: acked.has(g.head_sha),
  }));

  const model = {
    format_version: READ_FORMAT_VERSION,
    task: row.id, project: row.project, phase: row.phase, generation: row.generation,
    depth: orUnknown(row.depth),
    floors, events, runs, lease, drain, gate,
    holds: ev.holds, escalations: ev.escalations, prs: ev.openPrs,
    unknown: [], absent: [],
  };
  if (model.depth === UNKNOWN) model.unknown.push("depth");

  // ABSENT is per section and computed FROM THE ROWS, never guessed from the
  // phase: a task can reach RESEARCH by adoption and still carry no run of its
  // own, and a phase-based guess would report rows that are not there.
  const rows = {
    events, runs, drain, gate, holds: ev.holds,
    prs: ev.openPrs, escalations: ev.escalations,
    lease: lease ? [lease] : [],
  };
  for (const section of SECTIONS) if (!rows[section].length) model.absent.push(section);
  return model;
}

/** THE HUMAN TEXT IS NOT A STABLE INTERFACE. Parse `--json`, never this. */
export function renderWhy(m) {
  const out = [`${m.task}  ${m.phase}  gen ${m.generation}  depth ${m.depth}`];
  out.push(m.floors.length ? `  floors fired: ${m.floors.join(", ")}` : "  floors fired: none recorded");

  out.push("", "  transitions");
  if (m.absent.includes("events")) out.push("    no phase_event rows: this task has never transitioned");
  else for (const e of m.events)
    out.push(`    ${e.seq}  ${e.op}  ${e.from_phase ?? "-"} -> ${e.to_phase ?? "-"}` +
             `  artifact ${e.artifact_sha ?? "none"}`);

  out.push("", "  runs");
  if (m.absent.includes("runs")) out.push("    no phase_run rows: nothing has been dispatched for this task");
  else for (const r of m.runs)
    out.push(`    ${r.phase}/${r.slice} attempt ${r.attempt}  ${r.status}` +
             `  model ${orUnknown(r.model_id)}  cli ${orUnknown(r.cli_version)}` +
             `  snapshot ${orUnknown(r.snapshot_hash)}` +
             (r.contract_drift ? `  DRIFT ${r.contract_drift}` : ""));

  out.push("", "  holds");
  if (m.absent.includes("holds")) out.push("    no hold_reason rows: no human has stopped this task");
  else for (const h of m.holds) out.push(`    ${h.reason}  since ${h.at}${h.detail ? `  ${h.detail}` : ""}`);

  out.push("", "  gate rounds");
  if (m.absent.includes("gate")) out.push("    no gate_request rows: review has never been asked for");
  else for (const g of m.gate)
    out.push(`    round ${g.round}  ${g.head_sha}  codex ${g.codex_clean ? "clean" : "not yet"}` +
             `  founder ${g.founder_acked ? "acked" : "not yet"}`);

  out.push("", "  provider lease");
  out.push(m.absent.includes("lease")
    ? "    no provider_lease row: this task has never asked for a slot"
    : `    ${m.lease.owner} ${m.lease.status}  ref ${m.lease.run_ref}  requested ${m.lease.requested_at}` +
      (m.lease.preempt_requested ? "  PREEMPT REQUESTED" : ""));

  out.push("", "  escalations");
  if (m.absent.includes("escalations")) out.push("    none standing");
  else for (const e of m.escalations) out.push(`    ${e.why}  x${e.count}  since ${e.first_seen_at}`);

  out.push("", "  pull requests");
  if (m.absent.includes("prs"))
    out.push("    none open (S3 opens none: no task in S3 performs any GitHub effect)");
  else for (const p of m.prs) out.push(`    ${p.kind} #${p.pr}  ${p.head_sha}`);

  out.push("", "  draining");
  if (m.absent.includes("drain")) out.push("    no task_drain rows: nothing is being drained");
  else for (const d of m.drain)
    out.push(`    outbox ${d.outbox_id}  ${d.settled_at ? "settled" : "OPEN"}${d.forced ? " (forced)" : ""}`);

  if (m.unknown.length) out.push("", `  unknown: ${m.unknown.join(", ")}`);
  return out.join("\n");
}
