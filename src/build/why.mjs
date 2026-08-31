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
import { allPrs } from "./prs.mjs";

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
  // `generation` IS SELECTED, because `phase_run`'s primary key is
  // (task, generation, phase, slice, attempt). Without it a redesign or a
  // regenerate produces two rows with the same phase, slice and attempt and
  // nothing to tell a consumer which contract epoch produced either -- and
  // ordering by time does not restore an identity the projection dropped.
  // THE WHOLE CONTRACT SNAPSHOT. `argv_hash`, `prompt_hash`, `settings_hash`,
  // `tools_hash`, `agents_hash` and `canary_id` are durable columns that define
  // the sandbox and the prompt a run actually executed under. A lineage carrying
  // only the model and the budget cannot answer "what exactly ran", which is the
  // question `why` exists for -- and an operator auditing a bad run would have to
  // open the database by hand to get the rest.
  const runs = db.prepare(
    `SELECT generation, phase, slice, attempt, status, started_at, outcome, model_id, cli_version,
            effort, max_turns, max_budget_usd, snapshot_hash, contract_drift,
            argv_hash, prompt_hash, settings_hash, tools_hash, agents_hash, canary_id
       FROM phase_run WHERE task = ? ORDER BY generation, started_at, attempt`).all(taskId);
  // EVERY hold, cleared ones included, and this is why `why` does not reuse
  // `evidenceFor`'s list. That one filters to `cleared_at IS NULL` because
  // `show` answers "what is stopping this task NOW". A lineage that drops a
  // cleared hold erases the reason and the time a human actually stopped the
  // task, and renders "no human has stopped this task" about a task a human
  // stopped and then released.
  // EVERY pull request, merged ones included. `openPrs` filters `merged_sha IS
  // NOT NULL`, which is right for `show` and erases from the lineage exactly the
  // work that completed: the number, the reviewed head and the merge sha of a task
  // that finished.
  const prs = allPrs(db, taskId);
  const holds = db.prepare(
    `SELECT reason, detail, at, cleared_at FROM hold_reason WHERE task = ? ORDER BY at`).all(taskId);
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

  // THE FLOORS ARE NOT RECORDED ANYWHERE YET, and this says so rather than
  // reporting that none fired.
  //
  // The model proposes a depth and code disposes the floors, so the lineage
  // wants to show WHICH FLOOR FIRED. But no writer persists them: `git grep
  // floors -- src` finds only the dry-run plan, which computes them for a
  // filing that has not happened and stores nothing, and the sizing transition
  // records the chosen depth as a `sizing.recorded` hub event whose
  // `phase_event.detail` carries no floors at all. An earlier version of this
  // reader searched for a `sizing.decided` op that NOTHING WRITES, so every real
  // task rendered "floors fired: none recorded" -- a positive claim about a
  // question never asked, and green in a test only because the test inserted the
  // otherwise-unproduced row itself.
  //
  // So: absent until a producer exists, and `absent` is the honest word. Wiring
  // this to the real writer belongs with the task that adds the writer, which is
  // the only place the shape can be confirmed rather than guessed.
  const floors = [];

  // Gate rounds, each paired with whether a Codex clean pass exists AT THAT HEAD.
  // Pairing at the head is the whole content of the section: a clean pass on an
  // earlier head is not an answer about the head under review now.
  // A FOUNDER APPROVAL IS FOUNDER EVIDENCE. `notice_receipt.kind='founder_ack'`
  // is one way a founder answers a round; `approval` rows of kind
  // `founder_review`, `founder_cli` and `founder_silence` are the others, and
  // treating the acknowledgement as the only evidence rendered "founder not yet"
  // about a round the founder had explicitly approved -- while omitting the
  // source that proves it.
  // THE LATEST VERDICT AT EACH HEAD, and never a superseded row.
  //
  // A founder can answer a round with `changes_requested` as readily as with
  // `approve`, and an approval can be superseded by a later one. Taking the FIRST
  // row by time and reading its KIND alone reported "approved" for a round the
  // founder had explicitly asked for changes on -- the one mistake in this whole
  // surface that could make an operator ship something.
  //
  // `superseded_at IS NULL` is the filter and `observed_at DESC` is the order, so
  // the row that answers each head is the newest one still standing.
  const founderApprovals = db.prepare(
    `SELECT head_sha, kind, verdict, actor_login_snapshot, source_id, observed_at
       FROM approval
      WHERE task = ? AND kind IN ('founder_review','founder_cli','founder_silence')
        AND superseded_at IS NULL
      ORDER BY observed_at DESC`).all(taskId);
  const byHead = new Map();
  for (const a of founderApprovals) if (!byHead.has(a.head_sha)) byHead.set(a.head_sha, a);

  // THE GOVERNING CLEAN PASS, not a boolean. `codex_clean: true` tells an operator
  // auditing why a round advanced that a review happened and gives them no way to
  // find it; `source_id` is the comment, and several rows can exist at one head.
  // Newest first, so the row named is the one that governed.
  const cleanRows = new Map();
  for (const a of [...ev.codexClean].sort((x, y) => (y.observed_at ?? 0) - (x.observed_at ?? 0)))
    if (!cleanRows.has(a.head_sha)) cleanRows.set(a.head_sha, a);
  const clean = new Set(ev.codexClean.map(a => a.head_sha));
  // PAIRED TO THE GOVERNING CLEAN PASS, not to the head. `notice_receipt` keys
  // each row by `clean_source_id`, and `show`'s waiting model was corrected to
  // pair on it -- leaving this one collapsing by head meant a round could report
  // `founder_acked: true` beside a `codex_evidence` naming a NEWER source the
  // founder has never seen. The two halves of one answer, disagreeing.
  const ackedSources = new Set(ev.notices
    .filter(n => n.kind === "founder_ack").map(n => n.clean_source_id));
  const gate = ev.gateRequests.map(g => {
    const approval = byHead.get(g.head_sha) ?? null;
    // ANSWERED is not APPROVED. `changes_requested` is a founder verdict and it
    // closes nothing, so it must not read as an acknowledgement.
    const witness = cleanRows.get(g.head_sha) ?? null;
    // The acknowledgement must be OF the pass being rendered. With no clean pass
    // at this head there is no source to acknowledge, so a notice ack cannot
    // stand in for one.
    const noticeAcked = witness !== null && ackedSources.has(witness.source_id);
    const approved = approval !== null && approval.verdict !== "changes_requested";
    return {
      head_sha: g.head_sha, round: g.round, requested_at: g.requested_at,
      // The generation the round belongs to. Two contract epochs can both have
      // reviewed heads, and without this a consumer cannot tell which is which —
      // the same identity loss as dropping `generation` from a phase run.
      task_generation: g.task_generation,
      codex_clean: clean.has(g.head_sha),
      codex_evidence: witness
        ? { source_id: witness.source_id, actor: witness.actor_login_snapshot,
            observed_at: witness.observed_at }
        : null,
      founder_acked: noticeAcked || approved,
      // WHICH evidence, not merely that there was some. A silence approval and an
      // explicit review are both "approved" and an operator auditing a merge
      // needs to know which one, and where it came from.
      founder_evidence: approval
        ? { kind: approval.kind, verdict: approval.verdict,
            actor: approval.actor_login_snapshot, source_id: approval.source_id }
        : (noticeAcked
            ? { kind: "notice_ack", verdict: "approve", actor: null,
                source_id: witness.source_id }
            : null),
    };
  });

  const model = {
    format_version: READ_FORMAT_VERSION,
    task: row.id, project: row.project, phase: row.phase, generation: row.generation,
    depth: orUnknown(row.depth),
    floors, events, runs, lease, drain, gate,
    holds, escalations: ev.escalations, prs,
    unknown: [], absent: [],
  };
  if (model.depth === UNKNOWN) model.unknown.push("depth");
  // `floors: []` READS AS A FACT to anything parsing this -- an empty list is a
  // definite answer, and the definite answer here is wrong. The human render
  // already said UNKNOWN; a machine consumer was told "none fired". Two renderers
  // over one model must not disagree about whether a question was asked.
  model.unknown.push("floors");

  // ABSENT is per section and computed FROM THE ROWS, never guessed from the
  // phase: a task can reach RESEARCH by adoption and still carry no run of its
  // own, and a phase-based guess would report rows that are not there.
  const rows = {
    events, runs, drain, gate, holds,
    prs, escalations: ev.escalations,
    lease: lease ? [lease] : [],
  };
  for (const section of SECTIONS) if (!rows[section].length) model.absent.push(section);
  return model;
}

/** THE HUMAN TEXT IS NOT A STABLE INTERFACE. Parse `--json`, never this. */
export function renderWhy(m) {
  const out = [`${m.task}  ${m.phase}  gen ${m.generation}  depth ${m.depth}`];
  out.push(m.floors.length
    ? `  floors fired: ${m.floors.join(", ")}`
    : `  floors fired: ${UNKNOWN} (no writer records them yet)`);

  out.push("", "  transitions");
  if (m.absent.includes("events")) out.push("    no phase_event rows: this task has never transitioned");
  else for (const e of m.events)
    out.push(`    ${e.seq}  ${e.op}  ${e.from_phase ?? "-"} -> ${e.to_phase ?? "-"}` +
             `  artifact ${e.artifact_sha ?? "none"}`);

  out.push("", "  runs");
  if (m.absent.includes("runs")) out.push("    no phase_run rows: nothing has been dispatched for this task");
  else for (const r of m.runs) {
    out.push(`    gen ${r.generation}  ${r.phase}/${r.slice} attempt ${r.attempt}  ${r.status}` +
             `  outcome ${orUnknown(r.outcome)}`);
    out.push(`      model ${orUnknown(r.model_id)}  cli ${orUnknown(r.cli_version)}` +
             `  effort ${orUnknown(r.effort)}` +
             `  turns ${orUnknown(r.max_turns)}  budget ${orUnknown(r.max_budget_usd)}`);
    out.push(`      snapshot ${orUnknown(r.snapshot_hash)}  argv ${orUnknown(r.argv_hash)}` +
             `  prompt ${orUnknown(r.prompt_hash)}  settings ${orUnknown(r.settings_hash)}`);
    out.push(`      tools ${orUnknown(r.tools_hash)}  agents ${orUnknown(r.agents_hash)}` +
             `  canary ${orUnknown(r.canary_id)}`);
    if (r.contract_drift) out.push(`      DRIFT ${r.contract_drift}`);
  }

  out.push("", "  holds");
  if (m.absent.includes("holds")) out.push("    no hold_reason rows: no human has stopped this task");
  else for (const h of m.holds)
    out.push(`    ${h.reason}  since ${h.at}` +
             (h.cleared_at ? `  cleared ${h.cleared_at}` : "  STANDING") +
             (h.detail ? `  ${h.detail}` : ""));

  out.push("", "  gate rounds");
  if (m.absent.includes("gate")) out.push("    no gate_request rows: review has never been asked for");
  else for (const g of m.gate)
    out.push(`    round ${g.round}  ${g.head_sha}  codex ${g.codex_clean ? "clean" : "not yet"}` +
             `  founder ${g.founder_evidence
                 ? `${g.founder_evidence.kind} ${g.founder_evidence.verdict}`
                 : "not yet"}` +
             (g.founder_evidence?.source_id ? `  source ${g.founder_evidence.source_id}` : ""));

  out.push("", "  provider lease");
  // NOT "never asked for a slot". A successful release DELETES the row, so an
  // ordinary task with completed runs has no lease here precisely BECAUSE it
  // held one and gave it back. `provider_lease` records what is live, not what
  // happened, and a lineage must not assert history it cannot read.
  out.push(m.absent.includes("lease")
    ? "    no current provider_lease row (a released lease is deleted, so this is not evidence either way)"
    : `    ${m.lease.owner} ${m.lease.status}  ref ${m.lease.run_ref}  requested ${m.lease.requested_at}` +
      (m.lease.preempt_requested ? "  PREEMPT REQUESTED" : ""));

  out.push("", "  escalations");
  if (m.absent.includes("escalations")) out.push("    none standing");
  else for (const e of m.escalations) out.push(`    ${e.why}  x${e.count}  since ${e.first_seen_at}`);

  out.push("", "  pull requests");
  if (m.absent.includes("prs"))
    out.push("    none open (S3 opens none: no task in S3 performs any GitHub effect)");
  // MERGED IS THE FACT THE LINEAGE EXISTS TO CARRY. `allPrs` preserves
  // `merged_sha` and the render was printing a merged row identically to an open
  // one, so the human reading `why` could not tell that the work landed, nor
  // recover the receipt that says where.
  else for (const p of m.prs)
    out.push(`    ${p.kind} #${p.pr}  ${p.head_sha}` +
             (p.merged_sha ? `  MERGED ${p.merged_sha}` : "  open"));

  out.push("", "  draining");
  if (m.absent.includes("drain")) out.push("    no task_drain rows: nothing is being drained");
  else for (const d of m.drain)
    out.push(`    outbox ${d.outbox_id}  ${d.settled_at ? "settled" : "OPEN"}${d.forced ? " (forced)" : ""}`);

  if (m.unknown.length) out.push("", `  unknown: ${m.unknown.join(", ")}`);
  return out.join("\n");
}
