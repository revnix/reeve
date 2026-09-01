// tables -- who writes each hub table and who reads it.
//
// This file is the cross-check the S2 review requires, kept as data so it runs
// on every push instead of being ticked once by a reviewer. It catches two
// opposite mistakes: a table the design relies on that nobody created (its
// readers then get nothing, and absence reads as success), and a table in the
// DDL that nothing fills and nothing consults -- the read-never-written shape
// the tracker has flagged twice already.
//
// PROSE_TABLES is transcribed BY HAND from section 11.2's SQL block. It is
// deliberately not derived from TABLE_OWNERS: two lists built from one source
// agree with each other and prove nothing.
// One entry per row of the checklist above, transcribed VERBATIM -- all 32.
// "... one entry per row ..." was shorthand in an earlier draft, and an executor
// following it literally produces a file with one entry, which the cross-check
// then reports as 31 missing tables. Write them all out; the checklist is the
// source and it is directly above.
export const TABLE_OWNERS = {
  task:            { writer: "transition.mjs, intake.mjs", reader: "loop.mjs, dash, task why, merge.mjs", replayed: true,  section: "11.2" },
  task_territory:  { writer: "intake.mjs (admission tx)",  reader: "territory.mjs overlap check",         replayed: true,  section: "10.1" },
  task_drain:      { writer: "transition.mjs (CANCELLING)", reader: "loop.mjs drain check, task why",     replayed: true,  section: "3.5"  },
  phase_event:     { writer: "transition.mjs",              reader: "why, dash age-in-state, fences",     replayed: true,  section: "3.2"  },
  hold_reason:     { writer: "transition.mjs",              reader: "task resume, why",                   replayed: true,  section: "3.1"  },
  hub_event:       { writer: "every authority-bearing tx",  reader: "replay.mjs, the restore drill",      replayed: false, section: "11.4" },
  phase_run:       { writer: "loop.mjs at dispatch",        reader: "why, adopt-or-kill, retry budget",   replayed: true,  section: "4.5"  },
  gate_run:        { writer: "gates.mjs",                   reader: "merge clause B2, why",               replayed: true,  section: "8.3"  },
  gate_request:    { writer: "gate.mjs per round",          reader: "revision cap, why",                  replayed: true,  section: "7.3"  },
  approval:        { writer: "gate.mjs from the inbox",     reader: "merge clauses B4/U2, why",           replayed: true,  section: "7.3"  },
  notice_receipt:  { writer: "gate.mjs on notice settle",   reader: "the silence clock",                  replayed: true,  section: "7.3"  },
  task_pr:         { writer: "chain.mjs (pr-create settle)", reader: "receipt importer, merge.mjs, every hold/close/annotate path", replayed: true, section: "8.5" },
  attested_push:   { writer: "chain.mjs",                   reader: "merge clause B1",                    replayed: true,  section: "8.5"  },
  guardian_receipt:{ writer: "chain.mjs receipt importer",  reader: "clause B1 via attested_push",        replayed: true,  section: "8.5"  },
  ownership_check: { writer: "the VERDICT_WAIT poller",     reader: "merge clause B6, pre-flight",        replayed: false,  section: "2.5"  },
  harness_acceptance:{ writer: "task resume --accept-harness", reader: "merge clause B7",                 replayed: true,  section: "8.4"  },
  pr_hold:         { writer: "transition.mjs, chain.mjs",   reader: "the GUARDIAN's verdict (PR-C)",      replayed: true,  section: "9.6"  },
  // The FOUNDER-only command, not intake. Naming intake here told the executable
  // ownership cross-check -- and the implementer reading it -- that ordinary task
  // intake may mint a durable review-witness authority row, which merge clause
  // B5 then consumes as evidence a human granted it. Task 4 and the design are
  // explicit: `reeve build authority` writes it, and nothing else does.
  project_authority:{ writer: "reeve build authority (founder-only)", reader: "merge clause B5, doctor", replayed: true,  section: "2.1"  },
  repo_gate_state: { writer: "loop.mjs per tick (PR-B)",    reader: "merge clause U4",                    replayed: false,  section: "9.3"  },
  inbox:           { writer: "ingest.mjs",                  reader: "gate.mjs, the post-GATE watcher",    replayed: false,  section: "7.6"  },
  outbox:          { writer: "transition.mjs; the executor", reader: "executor, recoverOutbox, drain",    replayed: true,  section: "3.2"  },
  merge_decision:  { writer: "merge.mjs at each phase",     reader: "task why, the false-merge metric",   replayed: true,  section: "9.3"  },
  escalation:      { writer: "applyTransition, the loop",   reader: "notify.mjs, dash, task resolve",     replayed: true,   section: "11.7" },
  intake_event:    { writer: "intake.mjs per candidate",    reader: "the starvation check, why",          replayed: false,  section: "2.4"  },
  schema_version:  { writer: "hubdb.mjs migrations only",   reader: "openHub, validateSnapshot",          replayed: false, section: "11.1" },
  // Five more are `replayed: false` because they are RE-DERIVED, not restored:
  // ownership_check by the poller's next full sync, repo_gate_state by the next
  // refreshGateState, inbox by the next ingest, escalation by the next
  // evaluation of the same condition, intake_event by the next intake pass.
  // They carried `replayed: true` with no handler in HANDLERS -- a table
  // claiming to be restorable with nothing able to restore it, which is exactly
  // what Task 11's direction-3 check exists to catch.
  //
  // The five process-scoped tables. NOT replayed and NOT compared, for the same
  // reason restoreHub clears them: they record which PROCESS holds authority,
  // and every one of those processes is gone by the time a restore runs.
  singleton_lease: { writer: "locks.mjs",                   reader: "build run, restore refusal",         replayed: false, section: "1.2"  },
  writer_lease:    { writer: "locks.mjs per CLI command",   reader: "restore refusal",                    replayed: false, section: "11.4" },
  maintenance_lock:{ writer: "restoreHub only",             reader: "every writer's assertWritable",      replayed: false, section: "11.4" },
  directory_lease: { writer: "worktree.mjs",                reader: "the reaper, dispatch guard",         replayed: false, section: "10.2" },
  territory_lease: { writer: "intake.mjs, transition.mjs",  reader: "the overlap check, the dash",        replayed: true,  section: "10.2" },
  provider_lease:  { writer: "provider.mjs (both daemons)", reader: "admission, reaper, restore refusal", replayed: false, section: "10.4" },
  provider_state:  { writer: "provider.mjs, measure-provider", reader: "admission, doctor H-5",           replayed: false, section: "10.4" },
  // REPLAYED, unlike the two provider tables above it. Those are process-scoped:
  // restoreHub clears them, so there is no image to restore. This one is durable
  // and a restore rebuilds everything after the snapshot from the event tail
  // alone -- so a measurement taken since the last snapshot exists only there,
  // and without a handler a NORMAL restore drops it while reporting success.
  provider_measurement:
                   { writer: "measure-provider", reader: "the arming gate, doctor",                replayed: true,  section: "10.4" },
};

export const PROSE_TABLES = [
  // task_drain was missing here for several revisions while the cross-check
  // this list feeds was described as complete: 31 of 32, and the one absent was
  // the table the CANCELLING drain depends on.
  "task", "task_territory", "task_drain", "phase_event", "hold_reason", "hub_event", "phase_run", "gate_run",
  "gate_request", "approval", "notice_receipt", "task_pr", "attested_push", "guardian_receipt",
  "ownership_check", "harness_acceptance", "pr_hold", "project_authority", "repo_gate_state",
  "inbox", "outbox", "merge_decision", "singleton_lease", "writer_lease", "maintenance_lock",
  "directory_lease", "territory_lease", "provider_lease", "provider_state", "provider_measurement",
  "intake_event", "escalation", "schema_version",
];
// task_drain is in TABLE_OWNERS and NOT in PROSE_TABLES: section 11.2 carries
// drain_set as a column on task, and this plan makes it a child table instead
// (see the deviation note on Task 2). The asymmetry is deliberate and is the
// one place the two lists are allowed to differ.
