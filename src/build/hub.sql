-- The hub store. One file for the whole builder.
--
-- Every table here obeys the same rules, and they are rules rather than style:
--   STRICT                 -- a TEXT written into an INTEGER column is an error,
--                             not a silent affinity conversion
--   WITHOUT ROWID          -- for every composite identity, so the primary key
--                             IS the storage and a duplicate cannot hide
--   CHECK on every enum    -- the set of legal values lives with the data, not
--                             only in the code that happens to write it
--   NOT NULL on identity   -- a null in a key is a row that matches nothing
--   *_at INTEGER           -- unixepoch() seconds, never a TEXT date
--   numeric GitHub ids     -- repo_id/actor_id/app_id are immutable; the
--                             human-readable name sits beside them as a snapshot
--
-- Pragmas are set in hubdb.mjs rather than here, because foreign_keys cannot be
-- changed inside a transaction and this file runs inside one.

-- ---------------------------------------------------------------- identity
-- One row per builder task, for its whole life.
--
-- generation is the CONTRACT EPOCH and bumps on exactly two founder commands
-- (resume --redesign, regenerate). It is NOT a retry counter -- retries live on
-- phase_run.attempt. Approvals bind to (spec head sha, generation), so a retry,
-- a crash, or a plain resume cannot void an approval, and only a deliberate
-- change of what was approved starts an epoch that must be approved again.
CREATE TABLE IF NOT EXISTS task (
  id             TEXT    PRIMARY KEY,              -- bt:<ulid>, minted by the hub
  project        TEXT    NOT NULL,                 -- registry key; NOT a repo name
  repo_id        INTEGER NOT NULL,                 -- immutable numeric GitHub id
  nwo_snapshot   TEXT    NOT NULL,                 -- readable name as it was at admission
  title          TEXT    NOT NULL,
  body           TEXT,
  priority       TEXT    NOT NULL DEFAULT 'p2' CHECK (priority IN ('p1','p2')),
  depth          TEXT             CHECK (depth IS NULL OR depth IN ('trivial','standard','deep')),

  -- The authoritative state enumeration. phases.mjs shares this domain exactly;
  -- a test asserts the two lists are equal, because a state the machine emits
  -- and the database refuses is a transition that throws at commit time.
  phase          TEXT    NOT NULL CHECK (phase IN (
                   'FILED','CLAIMING','SIZING','RESEARCH','DESIGN','SPEC_DRAFT',
                   'SPEC_PR_OPEN','GATE','APPROVED','IMPLEMENTING','IMPL_PR_OPEN',
                   'VERDICT_WAIT','SLICE_MERGED','FINALIZING',
                   'BLOCKED','ESCALATED','CANCELLING',
                   'DONE','CANCELLED','LOST','INFEASIBLE')),
  generation     INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  slice_cursor   INTEGER NOT NULL DEFAULT 0 CHECK (slice_cursor >= 0),
  resume_seq     INTEGER NOT NULL DEFAULT 0 CHECK (resume_seq >= 0),

  -- provenance
  source_kind    TEXT    NOT NULL CHECK (source_kind IN ('founder','ledger')),
  source_key     TEXT    NOT NULL,
  text_hash      TEXT,                             -- founder filings
  filed_via      TEXT             CHECK (filed_via IS NULL OR filed_via IN ('cli','import')),
  claim_event_id TEXT,                             -- ledger tasks (S5); never a byte offset
  operation_id   TEXT,
  projection_generation INTEGER,
  idempotency_key TEXT,

  -- held and terminal detail
  blocked_reason TEXT,
  held_from      TEXT             CHECK (held_from IS NULL OR held_from IN (
                   'FILED','CLAIMING','SIZING','RESEARCH','DESIGN','SPEC_DRAFT',
                   'SPEC_PR_OPEN','GATE','APPROVED','IMPLEMENTING','IMPL_PR_OPEN',
                   'VERDICT_WAIT','SLICE_MERGED','FINALIZING')),
  terminal_reason TEXT,

  -- the spec PR is fixed for the task's life; a redesign pushes a new head to it
  spec_repo_id   INTEGER,
  spec_pr        INTEGER,
  spec_head      TEXT,
  approved_spec_head TEXT,
  approved_generation INTEGER,

  -- registry snapshot: what admitted this task, frozen. Later phases read THIS,
  -- never the live registry, so an edit to projects.json cannot move a task.
  repo_path        TEXT    NOT NULL,
  profile_path     TEXT    NOT NULL,
  profile_hash     TEXT    NOT NULL,
  default_branch   TEXT    NOT NULL,
  visibility       TEXT    NOT NULL CHECK (visibility IN ('private','public','internal','unknown')),
  gate_definition_hash TEXT,
  registry_version INTEGER NOT NULL,
  founder_user_id  INTEGER,
  ledger_name      TEXT,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,

  UNIQUE (source_kind, source_key)
) STRICT;
CREATE INDEX IF NOT EXISTS task_active ON task(project, phase) WHERE phase NOT IN ('DONE','CANCELLED','LOST','INFEASIBLE');
CREATE UNIQUE INDEX IF NOT EXISTS task_idem ON task(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Territory claims as child rows, never one TEXT blob: overlap is a prefix
-- question and a blob cannot be asked one.
CREATE TABLE IF NOT EXISTS task_territory (
  task TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file','prefix')),
  path TEXT NOT NULL,
  -- A pinned claim outlives a hold: it is the territory a held task keeps so a
  -- resume can reclaim exactly what it had, rather than re-deriving it from a
  -- worktree that may have moved on. PR-B's regrant reads it and its fixtures
  -- insert it by name.
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  PRIMARY KEY (task, kind, path)
) STRICT, WITHOUT ROWID;

-- The drain set of a CANCELLING task: the in-flight outbox rows that must
-- reconcile before CANCELLED is legitimate. A child table rather than a JSON
-- column on task, because "has every row settled" is a query, and because a
-- forced cancel has to record WHICH rows were forced and what was last known
-- about them -- neither of which a blob can be joined against.
CREATE TABLE IF NOT EXISTS task_drain (
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  -- Declared FK, like every other child here (section 11.1). Without it a bad
  -- transition or a replay can record an outbox id that does not exist: no
  -- reconciler can settle that row, the task sits in CANCELLING until the
  -- founder forces it, and the forced record then names an effect nobody can
  -- look up.
  outbox_id   INTEGER NOT NULL REFERENCES outbox(id),
  recorded_at INTEGER NOT NULL,
  settled_at  INTEGER,
  forced      INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0,1)),
  last_known  TEXT,                                -- the last reconciler attempt, for `task why`
  PRIMARY KEY (task, outbox_id)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------- events
-- phase_event: the transition log. hub_event: EVERY authority-bearing write.
-- They are separate because the restore drill replays hub_event, and a store
-- whose only log is transitions cannot rebuild an approval that was recorded
-- without one.
CREATE TABLE IF NOT EXISTS phase_event (
  seq            INTEGER PRIMARY KEY,
  task           TEXT    NOT NULL REFERENCES task(id),
  at             INTEGER NOT NULL,
  op             TEXT    NOT NULL,                 -- builder op names only; guardian ops are never reused
  from_phase     TEXT,
  to_phase       TEXT,
  from_generation INTEGER,
  to_generation  INTEGER,
  slice          INTEGER,
  artifact_sha   TEXT,                             -- what justified the transition
  detail         TEXT    NOT NULL DEFAULT '{}'     -- canonical JSON
) STRICT;
CREATE INDEX IF NOT EXISTS phase_event_task ON phase_event(task, seq);

CREATE TABLE IF NOT EXISTS hold_reason (
  id         INTEGER PRIMARY KEY,
  task       TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  reason     TEXT    NOT NULL,
  detail     TEXT,
  at         INTEGER NOT NULL,
  cleared_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS hold_reason_open ON hold_reason(task) WHERE cleared_at IS NULL;

-- Append-only. One row per authority-bearing write, in that write's own
-- transaction. This is what the destructive restore drill replays, so a write
-- that skips it is a fact the hub cannot get back.
CREATE TABLE IF NOT EXISTS hub_event (
  seq     INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  task    TEXT REFERENCES task(id),
  payload TEXT    NOT NULL DEFAULT '{}'            -- canonical JSON
) STRICT;
CREATE INDEX IF NOT EXISTS hub_event_task ON hub_event(task, seq);
CREATE INDEX IF NOT EXISTS hub_event_kind ON hub_event(kind, seq);

-- ---------------------------------------------------------------- runs
-- One row per attempt at one phase. slice is 0 for phases that have none.
-- attempt is monotonic per key and never reused, so a run resumed after a
-- founder resume can never collide with a run from before it.
CREATE TABLE IF NOT EXISTS phase_run (
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,
  phase       TEXT    NOT NULL,
  slice       INTEGER NOT NULL DEFAULT 0,
  attempt     INTEGER NOT NULL,
  resume_seq  INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL CHECK (status IN ('live','succeeded','failed','adopted','killed')),
  pid         INTEGER,
  lstart      TEXT,                                -- distinguishes a reused pid
  session_id  TEXT,
  started_at  INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  out_path    TEXT    NOT NULL,
  err_path    TEXT    NOT NULL,
  truncated   INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  outcome     TEXT,
  evidence    TEXT,
  -- the contract snapshot; same column family as the guardian's worker_run
  cli_version TEXT, model_id TEXT, effort TEXT,
  argv_hash TEXT, prompt_hash TEXT, settings_hash TEXT, tools_hash TEXT, agents_hash TEXT,
  max_turns INTEGER, max_budget_usd REAL, canary_id TEXT,
  snapshot_hash TEXT,                              -- the registry snapshot; guardian runs have none
  contract_drift TEXT,                             -- canonical JSON; null when the live env matched
  PRIMARY KEY (task, generation, phase, slice, attempt)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS one_live_run ON phase_run(task) WHERE status IN ('live','adopted');

-- Gates the CONTROLLER ran, from gate definitions hashed at the approved base.
-- A worker's self-report never gates anything; this row is what did.
CREATE TABLE IF NOT EXISTS gate_run (
  id          INTEGER PRIMARY KEY,
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,
  slice       INTEGER NOT NULL DEFAULT 0,
  command     TEXT    NOT NULL,
  base_definition_hashes TEXT NOT NULL,
  tool_versions TEXT,
  env_hash    TEXT,
  exit_code   INTEGER NOT NULL,
  output_hash TEXT    NOT NULL,
  out_path    TEXT    NOT NULL,
  at          INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS gate_run_task ON gate_run(task, generation, slice, at);

-- ---------------------------------------------------------------- gate evidence
-- One gate_request per (spec PR, head). The revision cap counts THESE, not raw
-- pushes: a crash-rerun re-derives different bytes and would otherwise look
-- like a second revision of the same round.
CREATE TABLE IF NOT EXISTS gate_request (
  task           TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  spec_repo_id   INTEGER NOT NULL,
  spec_pr        INTEGER NOT NULL,
  head_sha       TEXT    NOT NULL,
  round          INTEGER NOT NULL CHECK (round >= 0),
  task_generation INTEGER NOT NULL,
  requested_at   INTEGER NOT NULL,
  PRIMARY KEY (spec_repo_id, spec_pr, head_sha)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS gate_request_task ON gate_request(task, task_generation, round);

-- Every witness at a head, from every source. There is deliberately NO waiver
-- table: the Codex-unavailable path (section 7.3 row 7) is an ordinary founder
-- approval row carrying path='founder_codex_unavailable' and the evidence of
-- unavailability, so it is auditable as an approval rather than as an exception.
CREATE TABLE IF NOT EXISTS approval (
  task            TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  spec_repo_id    INTEGER NOT NULL,
  spec_pr         INTEGER NOT NULL,
  head_sha        TEXT    NOT NULL,
  actor_id        INTEGER NOT NULL,               -- numeric; a login can be renamed
  actor_login_snapshot TEXT NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN
                    ('founder_review','founder_cli','founder_silence','codex_clean')),
  verdict         TEXT    NOT NULL CHECK (verdict IN ('approve','changes_requested','clean')),
  receipt_ref     TEXT,                            -- silence rows carry the notice receipt
  command_line    TEXT,                            -- CLI rows carry the command
  head_read_at    INTEGER,
  path            TEXT             CHECK (path IS NULL OR path IN
                    ('codex_clean_founder','codex_clean_silence','founder_codex_unavailable')),
  unavailability_evidence TEXT,                    -- refusal comment id, or request ts + window
  observed_at     INTEGER NOT NULL,
  source_id       TEXT    NOT NULL,                -- the comment/review id this row came from
  task_generation INTEGER NOT NULL,
  superseded_at   INTEGER,
  superseded_by   TEXT,
  PRIMARY KEY (spec_repo_id, spec_pr, head_sha, actor_id, source_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS approval_task ON approval(task, task_generation, head_sha);

-- The founder's 15 minutes start from max(clean comment, notice DELIVERED).
-- Without a receipt there is no clock, and a builder that was down for twenty
-- minutes past a clean comment must not restart and call that silence.
CREATE TABLE IF NOT EXISTS notice_receipt (
  task            TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  head_sha        TEXT    NOT NULL,
  clean_source_id TEXT    NOT NULL,                -- always real: `task ack` refuses before a clean pass
  channel         TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('delivered','founder_ack')),
  delivered_at    INTEGER NOT NULL,
  receipt_ref     TEXT,
  PRIMARY KEY (task, head_sha, clean_source_id)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------- impl chain
CREATE TABLE IF NOT EXISTS impl_pr (
  task       TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  slice      INTEGER NOT NULL,
  repo_id    INTEGER NOT NULL,
  pr         INTEGER NOT NULL,
  -- The PR's current head. `write-pr-hold` (PR-B) reads it from HERE, inside the
  -- transition's own transaction, because the projection is where a PR's head
  -- lives and taking it from the caller would let a stale head be written as the
  -- hold's witness. It is NOT NULL because `pr_hold.head_sha` is NOT NULL: a row
  -- without a head cannot support a hold, and admitting one converts a schema
  -- guarantee into a constraint failure inside a transition, which rolls the
  -- whole transition back at the moment a task is being cancelled or escalated.
  -- The value is known at insert time -- the push that the PR is opened from is
  -- what produced it -- so requiring it costs the writer nothing.
  head_sha   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  merged_sha TEXT,
  PRIMARY KEY (task, generation, slice),
  -- the key the receipt importer joins guardian_event.pr to a (task, slice) on
  UNIQUE (repo_id, pr)
) STRICT, WITHOUT ROWID;

-- The attested head chain. A commit nobody attested blocks the merge, which is
-- what stops a smuggled commit without the check decaying into "head = head".
--
-- pusher and source_kind are PAIRED, not independent: a builder push arrives
-- through the hub outbox, a guardian push arrives as a verified imported
-- receipt. A row asserting one pusher with the other's mechanism describes a
-- chain that cannot be verified against anything.
CREATE TABLE IF NOT EXISTS attested_push (
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,
  slice       INTEGER NOT NULL,
  pr          INTEGER NOT NULL,
  sha         TEXT    NOT NULL,
  pusher      TEXT    NOT NULL CHECK (pusher IN ('builder','guardian')),
  source_kind TEXT    NOT NULL CHECK (source_kind IN ('outbox','guardian_event')),
  source_ref  TEXT    NOT NULL,                    -- outbox key, or <repo_id>:<seq>
  at          INTEGER NOT NULL,
  PRIMARY KEY (task, generation, slice, sha),
  CHECK ((pusher = 'builder'  AND source_kind = 'outbox')
      OR (pusher = 'guardian' AND source_kind = 'guardian_event'))
) STRICT, WITHOUT ROWID;

-- Receipts imported from a guardian's own append-only table. Delivery is
-- at-least-once, so the unique key is the whole dedup mechanism: re-reading a
-- seq is inert rather than a second row.
CREATE TABLE IF NOT EXISTS guardian_receipt (
  repo_id            INTEGER NOT NULL,
  guardian_event_seq INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  pr          INTEGER,
  head_before TEXT,
  head_after  TEXT,
  payload_hash TEXT   NOT NULL,
  received_at INTEGER NOT NULL,
  verified_at INTEGER,
  status      TEXT    NOT NULL CHECK (status IN ('imported','verified','rejected')),
  reason      TEXT,
  PRIMARY KEY (repo_id, guardian_event_seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ownership_check (
  task      TEXT    PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  owner     TEXT,
  synced_at INTEGER NOT NULL,
  at        INTEGER NOT NULL
) STRICT;

-- Written ONLY by `reeve task resume --accept-harness <prefix>`. The command
-- re-hashes the preserved held patch and refuses a prefix that does not match,
-- so the hash recorded here is the hash of the diff the PR carries. No event,
-- comment, or worker can write this row.
CREATE TABLE IF NOT EXISTS harness_acceptance (
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,
  slice       INTEGER NOT NULL,
  diff_hash   TEXT    NOT NULL,
  actor_id    INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (task, generation, slice, diff_hash)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------- holds
-- The one hub table a guardian READS. On CANCELLING, ESCALATED and BLOCKED the
-- entry tx writes one row per open builder PR; the guardian's verdict finds it
-- and renders BLOCK, so the server-required ops/merge-policy check fails at the
-- head and the server refuses a merge even against a stale client request.
--
-- one_open_hold is PARTIAL on purpose. The verdict asks "is there an uncleared
-- hold for this PR"; two open rows would mean clearing one answers no while the
-- other still stands. A cleared row is history and must not block a re-hold.
CREATE TABLE IF NOT EXISTS pr_hold (
  id         INTEGER PRIMARY KEY,
  task       TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  repo_id    INTEGER NOT NULL,
  pr         INTEGER NOT NULL,
  head_sha   TEXT    NOT NULL,
  reason     TEXT    NOT NULL CHECK (reason IN
               ('cancel','reopen','ownership_lost','harness_touched','over_budget',
                'depth_post_approval','escalated','blocked_other')),
  detail     TEXT,                                 -- for blocked_other, the escalation identity
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_hold ON pr_hold(repo_id, pr) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS pr_hold_task ON pr_hold(task) WHERE cleared_at IS NULL;

-- ---------------------------------------------------------------- authority
-- Written ONLY by `reeve build authority <project> --kind review-witness
-- --until <date>`, which is founder-only. It exists because the guardian's
-- review clause emits PASS on an empty blocking-reviewer roster: for a builder
-- PR that is absence read as success on the very witness the requirement names.
-- An expired row authorizes nothing, so `until` is compared, never trusted.
CREATE TABLE IF NOT EXISTS project_authority (
  project_id TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('review-witness')),
  granted_by INTEGER NOT NULL,                     -- numeric actor id
  until      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, kind, created_at)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------- gate state
-- Refreshed by the builder tick, one row per registry project. Clause U4 reads
-- it with a freshness bound; absent, stale or drifted is UNKNOWN, never PASS.
-- Doctor REPORTS this row and never writes it -- a reporter that can also write
-- what it reports can agree with itself.
--
-- There is deliberately no merge-permission probe column. The only merge probe
-- in this system runs against the disposable canary repository; nothing ever
-- attempts a merge on a production repo to discover whether it could.
CREATE TABLE IF NOT EXISTS repo_gate_state (
  repo_id       INTEGER PRIMARY KEY,
  nwo_snapshot  TEXT    NOT NULL,
  ruleset_requires_check INTEGER NOT NULL CHECK (ruleset_requires_check IN (0,1)),
  bound_app_id  INTEGER,                           -- the app the ruleset names as the source
  expected_app_id INTEGER,                         -- the app reeve expects; a mismatch is drift
  app_installed TEXT    NOT NULL CHECK (app_installed IN ('pass','fail','unknown')),
  permission_diff TEXT,                            -- canonical JSON; null when it matched
  ruleset_snapshot TEXT,                           -- what was read, verbatim
  verified_at   INTEGER NOT NULL,
  error         TEXT
) STRICT;

-- ---------------------------------------------------------------- inbox
-- Facts observed from GitHub, keyed by CONTENT so a retro-edit is a new
-- generation rather than a silent no-op. Extended past the guardian's shape
-- with the numeric actor id, the head it was observed at, the server's own
-- timestamp, and whether pagination finished.
--
-- There is no updated_at column, and that is a decision rather than an
-- omission: pull_request.updated_at does NOT change when a review thread is
-- resolved, so a reader that ordered or filtered on it would be blind to
-- exactly the review state it was watching for. GitHub's edit timestamp is
-- kept as edited_at and is never used as an ordering.
CREATE TABLE IF NOT EXISTS inbox (
  id           INTEGER PRIMARY KEY,
  source       TEXT    NOT NULL,                   -- reviewer login, 'human', 'ci'
  external_id  TEXT    NOT NULL,
  repo_id      INTEGER,                            -- numeric; the nwo can be renamed
  pr_number    INTEGER,
  head_sha     TEXT,
  actor_id     INTEGER,
  login_snapshot TEXT,
  kind         TEXT    NOT NULL,
  payload      TEXT    NOT NULL,                   -- canonical JSON
  content_hash TEXT    NOT NULL,                   -- of payload; an edit changes it
  payload_hash TEXT    NOT NULL,
  generation   INTEGER NOT NULL DEFAULT 1,
  complete     INTEGER NOT NULL DEFAULT 1 CHECK (complete IN (0,1)),  -- 0 = pagination unfinished
  delivery_id  TEXT,                               -- X-GitHub-Delivery, when webhooks arm
  observed_at  INTEGER NOT NULL,                   -- when reeve saw it
  server_at    INTEGER,                            -- GitHub's own created/submitted time
  edited_at    INTEGER,                            -- never an ordering; see above
  UNIQUE (source, external_id, content_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS inbox_pr ON inbox(repo_id, pr_number, kind);
CREATE INDEX IF NOT EXISTS inbox_object ON inbox(source, external_id, generation);
CREATE INDEX IF NOT EXISTS inbox_incomplete ON inbox(repo_id, pr_number) WHERE complete = 0;

-- ---------------------------------------------------------------- outbox
-- Every externally-visible effect, enqueued in the same transaction as the
-- state change that decided it.
--
-- Two things differ from the guardian's outbox, and both are load-bearing:
--
-- 1. The idempotency key is unique over LIVE rows only. A done, voided, fenced,
--    failed or superseded row is history; a re-enqueued key is admitted beside
--    it and settled against external truth by its reconciler, which is what
--    makes re-delivery inert. A blanket UNIQUE would either swallow the
--    re-enqueued effect or refuse the enqueue outright.
-- 2. Every row carries the task generation and a fence. The executor
--    revalidates the fence inside the lease transaction: if the task has moved
--    to another generation, or the row was voided, it settles 'fenced' with no
--    effect. Without it a stale attempt from generation 3 can act on a task
--    that was redesigned into generation 4.
--
-- 3. `fence` is a FOREIGN KEY, not just an integer that happens to hold a seq.
--    The executor's whole safety argument is that it can revalidate the
--    authorisation behind an externally-visible effect; an unconstrained column
--    lets a buggy writer or a partial replay enqueue a push or a merge whose
--    authorising event does not exist, and revalidation then compares against
--    nothing. `phase_event` is append-only and its seq is INTEGER PRIMARY KEY,
--    so the parent is never deleted and no child-side index is needed: SQLite
--    scans the child table only on a parent delete, and there is no such path.
--    The transition transaction writes phase_event BEFORE it enqueues, so the
--    parent is always present by the time the FK is checked.
--
-- There is no check-publish kind. On a production repository the guardian is
-- the sole publisher of ops/merge-policy; the builder has nothing to enqueue.
CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN
                 ('git.push.branch','gh.pr.create','gh.pr.comment','gh.pr.close','gh.pr.body',
                  'gh.review.request','gh.pr.merge','notify','gate.clean_notice',
                  'ledger.claim','ledger.release')),
                 -- gate.clean_notice is its own kind, not a plain notify: its
                 -- settle writes the notice_receipt row that STARTS the founder
                 -- silence window (section 7.3), and the window is measured from
                 -- max(clean comment, notice delivered). A generic notify has no
                 -- such settlement, so without this kind the clock never starts
                 -- and no silence approval can ever be legitimate.
  task_id      TEXT REFERENCES task(id) ON DELETE CASCADE,
  task_generation INTEGER NOT NULL,
  fence        INTEGER NOT NULL REFERENCES phase_event(seq),   -- the event that enqueued it
  cancellable  INTEGER NOT NULL DEFAULT 1 CHECK (cancellable IN (0,1)),
  args         TEXT    NOT NULL,                   -- canonical JSON
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN
                 ('pending','inflight','done','failed','dead_letter',
                  'voided','fenced','refused','superseded','forced')),
  -- The LEASE IDENTITY, and it is a fencing token in the ordinary sense.
  --
  -- `settleEffect` is fenced on the ACTIVE LEASE, not on the row id: an id is
  -- not an identity while a row can be re-leased. Without these two columns the
  -- sequence is worker A stalls past its expiry, `recoverEffects` returns the
  -- row to `pending`, worker B leases it and begins delivering -- and A, still
  -- running, settles B's live delivery, overwriting its status and result while
  -- B is mid-flight. Both writes look legitimate at their own call sites.
  --
  -- `lease_token` is bumped on every lease of the row, so it is monotonic per
  -- row and survives a restart because it lives in the row rather than in a
  -- process. The CAS requires BOTH to match the row's current values and
  -- returns `stale` without writing otherwise. This is the mechanism the
  -- literature calls fencing, and TTL-plus-liveness is not a substitute for it:
  -- a paused process keeps its pid, so `isAlive` says yes for exactly the
  -- process that must be refused.
  worker       TEXT,                               -- null while pending; the holder while inflight
  lease_token  INTEGER NOT NULL DEFAULT 0,         -- bumped per lease; the fence `settleEffect` matches on
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  not_before   INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  visibility_repo_id INTEGER,                      -- what was re-queried at effect time
  visibility_result  TEXT CHECK (visibility_result IS NULL OR
                       visibility_result IN ('private','public','internal','unknown')),
  result       TEXT,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS outbox_live_key ON outbox(idempotency_key) WHERE status IN ('pending','inflight');
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(not_before, id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS outbox_inflight ON outbox(lease_expires_at) WHERE status='inflight';
CREATE INDEX IF NOT EXISTS outbox_task ON outbox(task_id, status);

-- ---------------------------------------------------------------- merge
-- Two outcomes per row on purpose. witness_outcome is every clause EXCEPT the
-- capability switch and the process flag; actuation_outcome is that AND the
-- switches. While the switches are off actuation_outcome is UNKNOWN on every
-- row, so a false-merge metric computed over it would be vacuously zero.
-- The dark stages prove something because witness_outcome is scored instead.
CREATE TABLE IF NOT EXISTS merge_decision (
  id           INTEGER PRIMARY KEY,
  task         TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  slice        INTEGER NOT NULL,
  task_generation INTEGER NOT NULL,
  repo_id      INTEGER NOT NULL,
  pr           INTEGER NOT NULL,
  head_sha     TEXT    NOT NULL,
  decided_at   INTEGER NOT NULL,
  phase        TEXT    NOT NULL CHECK (phase IN ('enqueue','preflight','settle')),
  witness_outcome   TEXT NOT NULL CHECK (witness_outcome   IN ('MERGE','REFUSE','UNKNOWN')),
  actuation_outcome TEXT NOT NULL CHECK (actuation_outcome IN ('MERGE','REFUSE','UNKNOWN')),
  clause_results TEXT NOT NULL,                    -- canonical JSON, one entry per clause
  ledger_sync_at INTEGER,
  approval_head_sha TEXT,
  approval_source_id TEXT,
  approval_path TEXT,
  codex_clean_source_id TEXT,
  notice_receipt_ref TEXT,
  server_gate_snapshot TEXT,
  outbox_key   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS merge_decision_pr ON merge_decision(repo_id, pr, decided_at);

-- ---------------------------------------------------------------- coordination
-- The singleton lease lives in the DATABASE, not in an OS lock, so the service
-- manager's instance and a founder's terminal instance can never both tick,
-- on any platform.
CREATE TABLE IF NOT EXISTS singleton_lease (
  name        TEXT    PRIMARY KEY,                 -- 'builder'
  pid         INTEGER NOT NULL,
  lstart      TEXT    NOT NULL,                    -- distinguishes a reused pid
  command     TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT;

-- Held by every CLI command that writes hub.db, for its duration. Restore
-- refuses while any is live and prints the holder.
CREATE TABLE IF NOT EXISTS writer_lease (
  id          TEXT    PRIMARY KEY,
  pid         INTEGER NOT NULL,
  lstart      TEXT    NOT NULL,
  command     TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT;

-- Taken exclusively by restore. Every writer, daemon and CLI alike, refuses to
-- BEGIN a write while it is held -- so a command started a moment after
-- restore's check cannot slip in behind it.
CREATE TABLE IF NOT EXISTS maintenance_lock (
  name        TEXT    PRIMARY KEY,                 -- 'restore'
  pid         INTEGER NOT NULL,
  lstart      TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL
) STRICT;

-- Process-scoped: it protects something that dies with a process, so it is
-- heartbeated and reaped on pid+lstart death.
CREATE TABLE IF NOT EXISTS directory_lease (
  path       TEXT    PRIMARY KEY,                  -- absolute
  owner_kind TEXT    NOT NULL CHECK (owner_kind IN ('worktree','clone')),
  task       TEXT REFERENCES task(id),
  pid        INTEGER NOT NULL,
  lstart     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  -- a clone belongs to no single task; a worktree always belongs to one
  CHECK ((owner_kind = 'clone'    AND task IS NULL)
      OR (owner_kind = 'worktree' AND task IS NOT NULL))
) STRICT;

-- Task-scoped, NOT process-scoped: a task is a row, not a process, so "dead"
-- is a state question. The reaper deletes a territory lease only when its task
-- is terminal, or held with no live pin -- never merely because it looks old.
CREATE TABLE IF NOT EXISTS territory_lease (
  project      TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('file','prefix')),
  path         TEXT    NOT NULL,
  task         TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL,
  pinned_until INTEGER,                            -- the ONLY home of the pin; task carries no copy
  PRIMARY KEY (project, kind, path)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS territory_lease_task ON territory_lease(task);

-- The global provider scheduler: the one hub table pair a guardian WRITES.
CREATE TABLE IF NOT EXISTS provider_lease (
  id           INTEGER PRIMARY KEY,
  owner        TEXT    NOT NULL CHECK (owner IN ('guardian','builder')),
  -- NOT NULL, because provider_one_live_request is UNIQUE over
  -- (owner, repo_id, run_ref) and SQLite does not deduplicate rows whose key
  -- contains a NULL. Nullable here means a caller that cannot resolve the
  -- numeric id inserts a live request the index cannot see, and every tick
  -- inserts another -- the exact duplication the index exists to prevent,
  -- reappearing precisely when identity is unknown.
  repo_id      INTEGER NOT NULL,
  run_ref      TEXT    NOT NULL,
  pid          INTEGER NOT NULL,
  lstart       TEXT    NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 0,
  budget_usd   REAL,
  status       TEXT    NOT NULL CHECK (status IN ('queued','held')),
  requested_at INTEGER NOT NULL,
  started_at   INTEGER,
  heartbeat_at INTEGER,
  expires_at   INTEGER NOT NULL,
  -- Set when a guardian is queued and every slot is held by builder leases
  -- (section 10.4, builder.provider.preemptAtBoundary). It is a REQUEST, read by
  -- the builder loop at a phase boundary and never acted on mid-phase, which is
  -- why it is a flag here rather than a revocation. S2-C writes and reads it;
  -- the column lives here because migration 1 owns the whole schema and a table
  -- gaining a column later would need a numbered migration for no reason.
  preempt_requested INTEGER NOT NULL DEFAULT 0 CHECK (preempt_requested IN (0,1))
  -- There is deliberately NO `refused_release` marker. It was added and then
  -- removed: a release refused because maintenance_lock is held cannot write the
  -- marker either, since assertWritable blocks that write in exactly the
  -- scenario the marker represents. Nor is it needed -- restoreHub CLEARS every
  -- process-scoped row, provider_lease included, from the restored file, so a
  -- lease held across a restore does not survive it at all. An abandoned restore
  -- is covered by ordinary expiry.
) STRICT;
CREATE INDEX IF NOT EXISTS provider_lease_live ON provider_lease(status, owner, requested_at);
-- One LIVE request per run. A capacity-blocked guardian calls claimProvider again
-- on every tick; without this, each call inserts another queued row, the queue
-- depth reports ticks elapsed rather than work waiting, and "no guardian is
-- queued" -- the builder's admission precondition -- can never come true again.
-- repo_id is IN the key: guardian run refs are `pr:<number>`, so PR #9 on two
-- watched repositories produces the same run_ref. Without the repo, one
-- guardian's request collides with another's and the second can never queue.
CREATE UNIQUE INDEX IF NOT EXISTS provider_one_live_request
  ON provider_lease(owner, repo_id, run_ref) WHERE status IN ('queued','held');

CREATE TABLE IF NOT EXISTS provider_state (
  provider          TEXT    PRIMARY KEY,           -- 'claude'
  concurrency_limit INTEGER NOT NULL,
  guardian_reserved INTEGER NOT NULL,
  cooldown_until    INTEGER,
  last_429_at       INTEGER,
  last_signature    TEXT,
  measured_at       INTEGER                        -- null until `build measure-provider` runs (S3)
) STRICT;

CREATE TABLE IF NOT EXISTS intake_event (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  ledger  TEXT,
  node_id TEXT,
  op      TEXT    NOT NULL,
  detail  TEXT
) STRICT;

-- The hub's OWN escalation table. Builder identities (^bt: and ^builder:) are
-- raised and retired only by the builder process, from here; guardian
-- identities stay in their per-repo store. No process announces from another
-- process's table.
CREATE TABLE IF NOT EXISTS escalation (
  why             TEXT    PRIMARY KEY,             -- the bare identity; detail rides in the body
  count           INTEGER NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  announced_count INTEGER NOT NULL
) STRICT;
