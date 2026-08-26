// replay -- rebuild the hub projection from its own append-only log.
//
// hub_event.payload carries THE ROW THAT WAS WRITTEN, canonical, not a
// description of a change. So replay is a primary-key upsert per kind and needs
// to know nothing about which transitions are legal: it is not a second
// implementation of the state machine that could disagree with the first.
//
// That is also why this can be trusted at 2am. The alternative -- replaying
// intent and re-deriving state -- means the recovery path runs code that has
// never been exercised except during a disaster.
import { hubTx } from "./hubdb.mjs";

/**
 * The tables the destructive restore drill compares, and the ONLY definition of
 * that list. Doctor and the drill both import it, so they cannot drift.
 *
 * Process-scoped rows are absent on purpose: directory_lease, provider_lease,
 * singleton_lease, writer_lease and maintenance_lock describe processes that do
 * not exist after a restore, and comparing them would fail every drill for the
 * one reason that is correct.
 */
// §11.4's comparison set. The invariant Task 11 asserts BOTH WAYS: every table
// with a replay handler appears here, and every table here has a handler.
// `guardian_receipt` was handled and not compared, so a replay that silently
// dropped every imported receipt passed the recovery acceptance test -- and
// those receipts are what clause B1 reads to decide a push was attested.
export const COMPARISON_SET = [
  "task", "task_territory", "task_drain", "phase_event", "phase_run", "approval", "gate_request", "notice_receipt", "task_pr", "attested_push",
  "harness_acceptance", "gate_run", "pr_hold", "hold_reason", "project_authority",
  "outbox", "territory_lease", "merge_decision", "guardian_receipt",
  // `escalation` joined the set when `escalation.raised` became replayable: a
  // table that replay writes and the drill does not compare is a projection
  // nothing proves came back.
  "escalation",
];

/**
 * Kinds that are deliberately NOT replayed, declared rather than merely absent.
 *
 * An unknown kind is skipped silently, so "no handler" and "typo in the kind
 * name" are the same observable outcome -- which is exactly how six fixture
 * kinds came to be wrong in this plan's own drill. Declaring the intentional
 * ones makes the difference checkable: Task 11 asserts every kind any plan emits
 * is in HANDLERS or in this set, and nothing may be in neither.
 */
export const NON_REPLAYED_KINDS = Object.freeze([
  // A refusal is a record that nothing happened. There is no projection row to
  // restore, and re-applying it would append a second refusal for an attempt
  // that was never re-made.
  "transition.refused",
  // RESEARCH was skipped, not lost. The reason is durable in hub_event as
  // history; there is no row it projects into.
  "research.skipped",
  // `repo_gate_state` has a LIVE WRITER: the builder tick re-derives it every
  // pass, and `tables.mjs` declares it `replayed: false`. Restoring an older
  // reading would put a staler gate state in front of clause U4 than the one the
  // loop is about to write. The event is the record of what reeve saw and when;
  // the row is a projection that rebuilds itself.
  "repo_gate_state.refreshed",
  // The singleton lease is PROCESS-scoped: `singleton_lease` is cleared by
  // `restoreHub` along with every other row naming a pid, because no process
  // from before the restore still holds anything. Replaying a grant would
  // reinstate a lease for a pid that is gone and lock out the builder that
  // starts next. Both kinds are emitted by `locks.mjs`, which the scanner below
  // reads -- so leaving them undeclared fails the cross-check on the very
  // implementation this plan prescribes.
  "lease.singleton.granted",
  "lease.singleton.released",
]);

/** kind -> the table its payload is a row of. */
const HANDLERS = {
  "task.transitioned":        { table: "task", key: ["id"] },
  // REPLAYED, after review on PR #12 argued the re-derivation premise away. It
  // held for the guardian's escalations, which every tick re-raises from live
  // conditions. It does not hold for the ones `applyTransition` writes: they are
  // raised BY a transition, once. INFEASIBLE is terminal, with no edges out and
  // no later phase; BLOCKED and ESCALATED do not leave on their own either. So
  // for exactly the escalations whose whole purpose is to tell the founder why
  // work stopped, there is no next evaluation -- and this plan's own INFEASIBLE
  // branch refuses a transition without a reason on the grounds that "a terminal
  // state with no durable explanation cannot be explained afterwards". Declaring
  // the carrier unreplayable contradicted that in the one case it was written
  // for. Keyed on `why`, which is the table's primary key, so the upsert is
  // idempotent across a re-replay.
  "escalation.raised":        { table: "escalation", key: ["why"] },
  // A PARTIAL row image, and legitimately so: the upsert is by primary key, so
  // replaying it sets `depth` and leaves every other column as the last full
  // image left it. S2-B's depth override writes this on both the accepted-and-
  // moved and the accepted-but-refused paths.
  "sizing.overridden":        { table: "task", key: ["id"] },
  // The SAME row image, a DIFFERENT fact. `sizing.recorded` is the classifier
  // choosing a depth; `sizing.overridden` is the founder replacing it. Replay
  // treats them identically -- same table, same key -- and a reader asking how
  // the depth was chosen gets an answer instead of a guess.
  "sizing.recorded":          { table: "task", key: ["id"] },
  // The transition LOG, not just the projection. Without it every transition
  // after the snapshot vanishes from history: `task why` and dash's
  // age-in-state lose the record, and restored outbox rows keep fence values
  // pointing at phase_event seqs that no longer exist -- so fence revalidation
  // compares against nothing. The transition tx emits this beside
  // task.transitioned, carrying the exact row including its seq.
  "phase_event.appended":     { table: "phase_event", key: ["seq"] },
  // phase_run's LIVE rows are process state, but its settled ones are history:
  // the attempt counter is monotonic per (task, generation, phase, slice) and
  // must never be reused (section 3.4). Losing settled rows on restore lets a
  // resumed run collide with an earlier attempt's key, and the retry budget
  // silently resets. Live rows are excluded at replay: a run whose process is
  // gone is not resurrected.
  "phase_run.settled":        { table: "phase_run", key: ["task","generation","phase","slice","attempt"] },
  "task.filed":               { table: "task", key: ["id"] },
  // A filing writes the task AND its territory children in one transaction, so a
  // replay that restores only the task row loses the claims -- and territory is
  // what admission checks for overlap, so losing it silently re-opens every
  // conflict the filing was refused for. Emitted once per claim by the admission
  // tx; task_territory is in the comparison set for the same reason.
  "task_territory.claimed":   { table: "task_territory", key: ["task","kind","path"] },
  // task_drain is task_territory's sibling and was missed when that one was
  // fixed -- a class half-swept. Without these, a task restored as CANCELLING
  // reads drainRemaining=0, so drain.settled moves it to CANCELLED while the
  // pre-crash external effects are still unresolved: exactly what section 3.5
  // says CANCELLED must never mean.
  "task_drain.recorded":      { table: "task_drain", key: ["task","outbox_id"] },
  "task_drain.settled":       { table: "task_drain", key: ["task","outbox_id"] },
  "approval.recorded":        { table: "approval", key: ["spec_repo_id","spec_pr","head_sha","actor_id","source_id"] },
  "gate_request.minted":      { table: "gate_request", key: ["spec_repo_id","spec_pr","head_sha"] },
  "notice_receipt.recorded":  { table: "notice_receipt", key: ["task","head_sha","clean_source_id"] },
  // Keyed on the PR's OWN identity, which is what the table's primary key became
  // when the spec PR joined it: `(task, generation, slice)` cannot address a spec
  // row, whose generation and slice are NULL by CHECK.
  "task_pr.bound":            { table: "task_pr", key: ["repo_id","pr"] },
  // THE v1 KIND, STILL REPLAYABLE. A schema-1 durable tail records implementation
  // PRs as `impl_pr.bound`, and removing the kind when migration 2 renamed the
  // table made every such event UNKNOWN -- so restoring a v1 snapshot with a tail
  // exported before the upgrade refuses recovery, and the PRs created after that
  // snapshot cannot be carried forward at all. A migration that changes a table
  // has to keep reading the events written against the old one: the tail is
  // history and cannot be migrated in place.
  //
  // `map` translates the v1 row image into a v2 row. The image is already a
  // task_pr implementation row in every column but the one v1 had no need for.
  "impl_pr.bound":            { table: "task_pr", key: ["repo_id","pr"],
                                map: (row) => ({ ...row, kind: "impl" }) },
  "attested_push.appended":   { table: "attested_push", key: ["task","generation","slice","sha"] },
  "guardian_receipt.imported":{ table: "guardian_receipt", key: ["repo_id","guardian_event_seq"] },
  "harness_acceptance.recorded": { table: "harness_acceptance", key: ["task","generation","slice","diff_hash"] },
  "gate_run.recorded":        { table: "gate_run", key: ["id"] },
  // pr_hold's primary key is `id`. An upsert keyed on (task, repo_id, pr,
  // created_at) has no matching UNIQUE constraint, so SQLite raises "ON CONFLICT
  // clause does not match any PRIMARY KEY or UNIQUE constraint" and the replay
  // dies on the first hold it meets. The writer therefore puts `id` in the
  // payload, like every other rowid table here.
  "pr_hold.created":          { table: "pr_hold", key: ["id"] },
  "pr_hold.cleared":          { table: "pr_hold", key: ["id"] },
  "hold_reason.appended":     { table: "hold_reason", key: ["id"] },   // rowid table, same reason as pr_hold
  "project_authority.granted":{ table: "project_authority", key: ["project_id","kind","created_at"] },
  "merge_decision.recorded":  { table: "merge_decision", key: ["id"] },
  "outbox.enqueued":          { table: "outbox", key: ["id"] },
  "outbox.settled":           { table: "outbox", key: ["id"] },
  "outbox.voided":            { table: "outbox", key: ["id"] },
  "outbox.fenced":            { table: "outbox", key: ["id"] },
  "territory_lease.granted":  { table: "territory_lease", key: ["project","kind","path"] },
  "territory_lease.released": { table: "territory_lease", key: ["project","kind","path"], delete: true },
};

/** Which kinds this replay knows. Exported so the cross-check can compare it. */
export function replayableKinds() { return Object.keys(HANDLERS); }
// The TABLES those kinds project into, deduplicated. Exported because Task 11's
// cross-check needs to compare them with `COMPARISON_SET`, and `HANDLERS` itself
// stays module-private -- handing out the handler map would let a caller mutate
// the projection's routing table.
export function replayedTables() {
  return [...new Set(Object.values(HANDLERS).map(h => h.table))].sort();
}

export function replayHub(db, events) {
  let applied = 0, skipped = 0;
  hubTx(db, () => {
    for (const e of events) {
      const h = HANDLERS[e.kind];
      // A lease grant, a heartbeat, or anything else that describes a process
      // is not part of the projection. Counted, never guessed at.
      if (!h) { skipped++; continue; }
      let row = JSON.parse(e.payload);
      // THE HANDLER'S OWN TRANSLATION FIRST, ahead of the key guard. A legacy
      // kind's image is shaped for the table it was WRITTEN against; everything
      // below -- the key check, the existence probe, the upsert -- is about the
      // table it is being replayed INTO. Reading the key off the untranslated
      // image would ask the wrong question of the wrong shape.
      if (h.map) row = h.map(row);
      // THE KEY GUARD RUNS FIRST, above the delete branch.
      //
      // It sat below, so a `territory_lease.released` image with an incomplete
      // key never reached it: an absent column was bound as `undefined` and
      // aborted the restore with `Provided value cannot be bound to SQLite
      // parameter 1` -- the opaque message this guard exists to replace, at the
      // worst moment in the system to be handed one.
      //
      // `== null` catches null as well as undefined, and null is the more
      // dangerous of the two: every key column here is a primary key, `x = NULL`
      // is never true in SQL, so a delete keyed on one matched NOTHING, was
      // counted as `applied`, and appended the release event anyway -- leaving
      // the restored projection holding a lease its own log says was released.
      // A key that cannot identify a row is not a key.
      const badKey = h.key.filter(k => row[k] == null);
      if (badKey.length)
        throw new Error(
          `hub_event seq ${e.seq} of kind ${e.kind} cannot be replayed into ${h.table}: its row image is ` +
          `missing or null in the key column(s) ${badKey.join(", ")}. The image carries ${Object.keys(row).join(", ")}. ` +
          `A row image must be the row AS WRITTEN, read back after the insert -- an autoincrement id is ` +
          `assigned by SQLite and is not in the values the writer supplied.`);
      if (h.delete) {
        db.prepare(`DELETE FROM ${h.table} WHERE ${h.key.map(k => `${k}=?`).join(" AND ")}`).run(...h.key.map(k => row[k]));
        applied++; continue;
      }
      const cols = Object.keys(row);
      const set = cols.filter(c => !h.key.includes(c)).map(c => `${c}=excluded.${c}`).join(",");
      // UPDATE when the row is already there; INSERT only when it is not.
      //
      // A row image may legitimately be PARTIAL. `sizing.overridden` carries
      // `id` and `depth` and nothing else by design -- it is documented as a
      // partial image, and replaying it must set `depth` and leave every other
      // column as the last FULL image left it. An upsert cannot express that:
      // SQLite evaluates the INSERT's NOT NULL constraints BEFORE it reaches
      // ON CONFLICT, so a two-column image raises on `task.project`,
      // `task.repo_id`, `task.phase` and the rest even when the row it would
      // have updated is sitting right there -- and the whole restore aborts.
      //
      // Existence is checked by the handler's own key, which is the key the
      // upsert would have conflicted on, so the two paths agree by construction.
      const where = h.key.map(k => `${k}=?`).join(" AND ");
      const keyVals = h.key.map(k => row[k]);
      // A key column absent from the image is REFUSED, by name. Without this the
      // missing value is bound as `undefined` and SQLite answers
      // `Provided value cannot be bound to SQLite parameter 1` -- during a
      // RESTORE, which is the worst moment in the system to be handed a message
      // that names neither the event, the table, nor the column. Five tables key
      // on an autoincrement `id` (pr_hold, hold_reason, gate_run,
      // merge_decision, outbox), so a writer that emits its image from the
      // values it passed IN, rather than reading the row back, produces exactly
      // this and only at replay time -- long after the write looked fine.
      const exists = db.prepare(`SELECT 1 FROM ${h.table} WHERE ${where}`).get(...keyVals);
      if (exists) {
        // No columns beyond the key means the image says nothing to change --
        // an UPDATE with an empty SET is a syntax error, not a no-op.
        const assign = cols.filter(c => !h.key.includes(c));
        if (assign.length)
          db.prepare(`UPDATE ${h.table} SET ${assign.map(c => `${c}=?`).join(",")} WHERE ${where}`)
            .run(...assign.map(c => row[c]), ...keyVals);
      } else {
        db.prepare(
          `INSERT INTO ${h.table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})
           ON CONFLICT(${h.key.join(",")}) DO UPDATE SET ${set || h.key[0] + "=" + h.key[0]}`)
          .run(...cols.map(c => row[c]));
      }
      applied++;
    }
    // The log itself is history and is restored with the rest of the row set,
    // so replayed events are re-appended verbatim rather than re-minted.
    for (const e of events)
      db.prepare("INSERT INTO hub_event(seq,at,kind,task,payload) VALUES(?,?,?,?,?) ON CONFLICT(seq) DO NOTHING")
        .run(e.seq, e.at, e.kind, e.task, e.payload);
  });
  return { applied, skipped };
}
