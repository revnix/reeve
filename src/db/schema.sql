-- ops state layer. SQLite is the write path and the concurrency authority.
-- Every timestamp is an INTEGER of unixepoch() seconds unless the name ends _ms.

PRAGMA journal_mode = WAL;          -- one writer, many readers, same host only
PRAGMA synchronous  = NORMAL;       -- survives process crash; may lose last txns on power loss
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 10000;        -- also settable via new DatabaseSync(path,{timeout:10000})

-- ---------------------------------------------------------------- events
-- The immutable audit trail. Written in the SAME transaction as the
-- projection update, so there is exactly one source of truth.
CREATE TABLE IF NOT EXISTS event (
  seq        INTEGER PRIMARY KEY,          -- monotonic; the export order
  at         INTEGER NOT NULL,             -- unixepoch()
  actor      TEXT    NOT NULL,             -- lane id / 'founder' / 'daemon'
  op         TEXT    NOT NULL,             -- 'task.add' | 'task.claim' | ...
  subject    TEXT,                         -- node id this event is about
  run_id     TEXT,                         -- run that produced it, if any
  payload    TEXT    NOT NULL DEFAULT '{}' -- JSON, canonical key order
) STRICT;
CREATE INDEX IF NOT EXISTS event_subject ON event(subject, seq);
CREATE INDEX IF NOT EXISTS event_run     ON event(run_id, seq);

-- ---------------------------------------------------------------- graph
CREATE TABLE IF NOT EXISTS node (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN
                ('goal','task','research','decision','finding','lesson','pr')),
  title       TEXT NOT NULL,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN
                ('open','ready','running','blocked','review','done','decided',
                 'refuted','cancelled','dead_letter')),
  territory   TEXT,                         -- glob; used for write-conflict checks
  priority    INTEGER NOT NULL DEFAULT 0,
  profile     TEXT NOT NULL DEFAULT 'default',  -- per-project namespace (reusability)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1   -- optimistic-concurrency token
) STRICT;
CREATE INDEX IF NOT EXISTS node_kind_status ON node(profile, kind, status);

CREATE TABLE IF NOT EXISTS edge (
  src  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  dst  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN
        ('DEPENDS_ON','BLOCKS','SUPERSEDES','REFUTES','IMPLEMENTS','CITES','DECIDED_BY')),
  note TEXT,
  at   INTEGER NOT NULL,
  PRIMARY KEY (src, dst, type)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS edge_dst ON edge(dst, type);

-- ---------------------------------------------------------------- runs
-- One row per attempt at executing a task. This is the leased unit.
CREATE TABLE IF NOT EXISTS run (
  id             TEXT PRIMARY KEY,            -- ULID-ish, sortable
  task_id        TEXT NOT NULL REFERENCES node(id),
  profile        TEXT NOT NULL DEFAULT 'default',
  lane           TEXT NOT NULL,               -- logical worker identity
  status         TEXT NOT NULL CHECK (status IN
                   ('leased','running','blocked_on_ci','blocked_on_review',
                    'awaiting_founder','succeeded','failed','abandoned')),
  attempt        INTEGER NOT NULL DEFAULT 1,
  -- lease
  lease_expires_at INTEGER NOT NULL,          -- unixepoch(); reaper's trigger
  heartbeat_at     INTEGER NOT NULL,
  owner_pid        INTEGER,                   -- for liveness probing
  owner_boot       TEXT,                      -- `ps -o lstart=` -> distinguishes reused PIDs
  owner_host       TEXT NOT NULL,
  -- resumption
  step           TEXT,                        -- last COMPLETED step name
  cursor         TEXT NOT NULL DEFAULT '{}',  -- JSON: pr_number, head_sha, branch, round…
  -- outcome
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  error_class    TEXT,                        -- 'transient' | 'permanent' | 'cancelled'
  error          TEXT
) STRICT;
-- THE invariant: at most one live run per task.
CREATE UNIQUE INDEX IF NOT EXISTS run_one_live_per_task
  ON run(task_id)
  WHERE status IN ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder');
CREATE INDEX IF NOT EXISTS run_expiry ON run(lease_expires_at)
  WHERE status IN ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder');

-- attempt/backoff bookkeeping lives on the task so it survives run rows
CREATE TABLE IF NOT EXISTS task_exec (
  task_id       TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  not_before    INTEGER NOT NULL DEFAULT 0,   -- backoff gate; unixepoch()
  cancel_requested INTEGER NOT NULL DEFAULT 0,-- cooperative cancellation flag
  last_error    TEXT
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------- checkpoints
CREATE TABLE IF NOT EXISTS checkpoint (
  run_id   TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  step     TEXT NOT NULL,                     -- 'branch','implement','push','pr','ci','review','merge'
  seq      INTEGER NOT NULL,                  -- step ordinal
  state    TEXT NOT NULL,                     -- JSON blob the step needs to resume
  at       INTEGER NOT NULL,
  PRIMARY KEY (run_id, step)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------- outbox
-- Every externally-visible side effect is enqueued transactionally with the
-- state change that decided it, then performed by a single drainer.
CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY,
  idem_key     TEXT NOT NULL UNIQUE,          -- deterministic; see the algorithms
  kind         TEXT NOT NULL CHECK (kind IN
                 ('git.push','gh.pr.create','gh.pr.comment','gh.pr.merge',
                  'gh.thread.resolve','notify')),
  run_id       TEXT REFERENCES run(id),
  -- The effect this one waits for, and the reason it is an EDGE rather than one
  -- compound handler that does both halves.
  --
  -- Spilling needs an issue created and then replies naming its number, and the
  -- number does not exist until the first effect has delivered. A compound handler
  -- would hold both, and would then have to share one retry budget and one
  -- idempotency key across two writes with different costs: re-running it after a
  -- successful create and a failed reply would file a second issue. Split in two,
  -- each half keeps its own budget, its own key and its own marker.
  --
  -- Nullable, and null is the ordinary case: an effect that waits for nothing is
  -- every effect written before this column existed, which is why it is additive.
  depends_on   INTEGER REFERENCES outbox(id),
  args         TEXT NOT NULL,                 -- JSON
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                 ('pending','inflight','done','failed','dead_letter')),
  -- The fence. Bumped on EVERY lease, so it is monotonic per row and survives a
  -- restart because it lives in the row rather than in a process. `settleOutbox`
  -- matches on it and refuses to write when it does not hold, which is the only
  -- thing standing between a stalled drainer and a delivery it no longer owns:
  -- A's lease expires, B leases the row and starts posting the comment, and A --
  -- still running -- settles B's live delivery, overwriting its status and result.
  -- This is what the literature calls fencing, and a TTL plus a liveness check is
  -- NOT a substitute: a paused process keeps its pid, so `isAlive` answers yes for
  -- exactly the process that has to be refused.
  --
  -- It is a SEPARATE column from `attempts` and must stay one. `attempts` is the
  -- retry BUDGET -- `dead = attempts >= max_attempts` -- so it may only count real
  -- attempts, while a fence has to count every lease including one that delivered
  -- nothing. Two facts that both increase are still two facts; merging them is
  -- overloading, not deduplication. reeve's hub store carries both side by side
  -- for this reason.
  lease_token  INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  -- A THIRD counter, for the same reason there is a second one.
  --
  -- Delivery and reconciliation are different acts with different costs. A
  -- delivery POSTs and must be strictly bounded, because every attempt can create
  -- another comment. A reconciliation only READS -- it asks GitHub whether a
  -- delivery already landed -- and can conclude nothing worse than "still cannot
  -- tell". Charging both to `attempts` made the reconciliation budget exactly one,
  -- expressed as the difference between `>` here and `>=` there, and that budget
  -- was too small twice over:
  --
  --   · the final allowed POST reached GitHub and the response was lost, so the
  --     handler reported a retryable failure and the settle path dead-lettered a
  --     comment that exists;
  --   · the single reconciliation lease crashed before settling, and the next
  --     recovery dead-lettered a delivery a second look would have confirmed.
  --
  -- Both are one row being told a delivered effect needs a person. So the phase is
  -- explicit and each phase has its own budget. A row is RECONCILING once
  -- `reconcile_attempts > 0`; the lease bumps whichever counter the phase names,
  -- and the total number of leases is still bounded, at max_attempts + max_reconcile.
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  max_reconcile      INTEGER NOT NULL DEFAULT 3,
  not_before   INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  result       TEXT,                          -- JSON: pr number, sha, comment id…
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(not_before, id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS outbox_inflight ON outbox(lease_expires_at) WHERE status='inflight';
-- Read on every lease, to answer "is this row's parent finished". Partial, because
-- a row that waits for nothing never asks the question.
CREATE INDEX IF NOT EXISTS outbox_depends ON outbox(depends_on) WHERE depends_on IS NOT NULL;

-- ---------------------------------------------------------------- inbox
-- Facts observed from the outside world (GitHub). Dedup by external id so a
-- re-poll is free. The reviewer/CI loops consume from here.
-- Keyed by CONTENT, not only by id. CodeRabbit rewrites its own history: the
-- summary comment is a living document, inline findings are retro-edited to
-- record resolution ("Addressed in commit <sha>"), and a status was edited to
-- "Review rate limited" twenty seconds before a review for the same head. Under
-- UNIQUE(source, external_id) every one of those edits was a silent no-op and the
-- earlier text was simply lost. An edit is a new GENERATION of the same object.
CREATE TABLE IF NOT EXISTS inbox (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,                 -- reviewer login, 'human', or 'ci'
  external_id  TEXT NOT NULL,                 -- comment / review / thread / reaction id
  pr_number    INTEGER,
  head_sha     TEXT,
  kind         TEXT NOT NULL,                 -- 'review'|'issue_comment'|'review_thread'|'reaction'|'check_run'
  payload      TEXT NOT NULL,                 -- canonical JSON
  content_hash TEXT NOT NULL,                 -- of payload; an edit changes it
  generation   INTEGER NOT NULL DEFAULT 1,    -- 1, then 2 on the first edit, ...
  observed_at  INTEGER NOT NULL,              -- when REEVE saw it
  event_at     INTEGER,                       -- GitHub's created/submitted time
  -- GitHub's updated_at, kept as updated_at and never used as an event ordering:
  -- a retro-edit has no timestamp for the EDIT, only for the object, so treating
  -- it as when-this-happened would reorder history around a rewrite.
  edited_at    INTEGER,
  processed_at INTEGER,                       -- unused: the fold is total, see review/ingest.mjs
  UNIQUE (source, external_id, content_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS inbox_pr ON inbox(pr_number, kind);
CREATE INDEX IF NOT EXISTS inbox_object ON inbox(source, external_id, generation);

-- ---------------------------------------------------------------- head_seen
-- Every head reeve has pinned, with when IT first saw it.
--
-- The push time is needed to judge whether a reviewer has had a chance to answer,
-- and GitHub does not report one: the timeline carries a push event only for
-- FORCE pushes, and committer-date is a trap -- PRs 1123 and 1124 were opened
-- fifteen hours after their commits were authored, a 913-minute false latency.
-- reeve's own first sighting is the only honest watermark it has.
--
-- It is also how an abbreviated sha in a comment body resolves to a full one.
CREATE TABLE IF NOT EXISTS head_seen (
  nwo           TEXT NOT NULL,
  pr            INTEGER NOT NULL,
  sha           TEXT NOT NULL CHECK (length(sha) = 40),
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (nwo, pr, sha)) STRICT;

-- ------------------------------------------------------- review projections
-- Derived from inbox by a pure fold (src/review/derive.mjs). Every row here can
-- be deleted and rebuilt from the raw observations, which is the whole point:
-- CodeRabbit's finding taxonomy has already been replaced once, so a classifier
-- improvement must re-read history rather than only affecting what comes next.
--
-- classifier_version is hash(derivation code + the profile's detector block). A
-- mismatch means these rows were derived by something that no longer exists, and
-- they are rebuilt rather than trusted.

-- One SUBSTANTIVE answer by one reviewer at one revision. Not one review object:
-- every inline reply mints a 0-byte COMMENTED review (nine at a single commit on
-- #1124), so counting review objects overstates rounds by an order of magnitude.
CREATE TABLE IF NOT EXISTS review_round (
  nwo        TEXT NOT NULL,
  pr         INTEGER NOT NULL,
  reviewer   TEXT NOT NULL,                  -- normalised login, rostered or not
  source_id  TEXT NOT NULL,                  -- the inbox external_id it came from
  outcome    TEXT NOT NULL CHECK (outcome IN
               ('findings','clean','refusal','skip','unbound_clean')),
  head_full  TEXT,                           -- 40-hex when the API gave one
  head10     TEXT,                           -- resolved via head_seen; NULL = unbound
  event_at   INTEGER NOT NULL,
  classifier_version TEXT NOT NULL,
  PRIMARY KEY (nwo, pr, reviewer, source_id)) STRICT;
CREATE INDEX IF NOT EXISTS round_pr ON review_round(nwo, pr, reviewer, outcome);

-- One review thread. Identity is GitHub's node id, which is stable across pushes
-- AND force pushes -- a force push at most marks a thread outdated.
CREATE TABLE IF NOT EXISTS review_thread (
  nwo         TEXT NOT NULL,
  pr          INTEGER NOT NULL,
  thread_id   TEXT NOT NULL,
  reviewer    TEXT NOT NULL,
  path        TEXT,
  line        INTEGER,
  severity    TEXT NOT NULL CHECK (severity IN
                ('critical','major','minor','nit','unknown')),
  is_resolved INTEGER NOT NULL,
  is_outdated INTEGER NOT NULL,
  resolved_by TEXT,
  resolved_at INTEGER,
  -- Resolved is a CLAIM, not evidence: the bot resolves its own threads, and
  -- `@coderabbitai resolve` is author-invokable and bulk-resolves. Cleared means
  -- a LATER substantive round by the same reviewer has been and gone.
  is_cleared  INTEGER NOT NULL DEFAULT 0,
  excerpt     TEXT NOT NULL,
  event_at    INTEGER,
  classifier_version TEXT NOT NULL,
  PRIMARY KEY (nwo, pr, thread_id)) STRICT;
CREATE INDEX IF NOT EXISTS thread_pr ON review_thread(nwo, pr, is_cleared, severity);

-- A finding stated in a review's BODY, with no inline thread of its own.
--
-- A SEPARATE table from review_thread on purpose, not a flag on it. The two
-- populations answer different questions and only one of them has a GitHub
-- object behind it: a thread can be replied to and resolved, a body finding
-- cannot. Sharing a table would put a synthetic id one careless filter away from
-- a resolve mutation that can only fail, and would break the live cross-check
-- besides -- `compare` measures the projection's thread counts against a live
-- THREAD read, so a body finding counted as a thread is a permanent disagreement
-- that would turn the whole review path UNKNOWN.
--
-- `is_cleared` here carries a WEAKER rule than the one on a thread, and the
-- difference is the founder's decision of 2026-08-27. A thread clears when it is
-- resolved AND a later substantive round by the same reviewer covered this head.
-- A body finding has no resolve to observe, so only the second half survives: the
-- reviewer looked at this same revision again. If the problem is still there the
-- reviewer restates it and it returns as a new finding.
CREATE TABLE IF NOT EXISTS review_body_finding (
  nwo        TEXT NOT NULL,
  pr         INTEGER NOT NULL,
  -- `<review external_id>#<ordinal>`. Stable across re-derivation because the
  -- fold reads the LATEST generation of each review, so an edited body re-derives
  -- under the same external_id rather than accumulating.
  finding_id TEXT NOT NULL,
  reviewer   TEXT NOT NULL,
  severity   TEXT NOT NULL CHECK (severity IN
               ('critical','major','minor','nit','unknown')),
  is_cleared INTEGER NOT NULL DEFAULT 0,
  excerpt    TEXT NOT NULL,
  event_at   INTEGER,
  -- Is this row a FINDING, or a statement that reeve could not read the body it
  -- came from? Both are counted -- an unreadable body must not be spillable -- but
  -- only one of them is work. There is nothing for a worker to fix in "I cannot
  -- parse this reviewer", and nothing for a reviewer to clear either; it is
  -- cleared by the operator describing that reviewer in the profile. So it is
  -- routed to a person rather than to a worker, and keeping the two apart in the
  -- row is what lets the readers ask their own question instead of sharing one.
  unreadable INTEGER NOT NULL DEFAULT 0,
  -- The revision the filing round was bound to. Recorded so a later reader can
  -- tell a finding filed against this head from one carried over from an older
  -- one, without re-deriving.
  head_full  TEXT,
  classifier_version TEXT NOT NULL,
  PRIMARY KEY (nwo, pr, finding_id)) STRICT;
CREATE INDEX IF NOT EXISTS body_finding_pr
  ON review_body_finding(nwo, pr, is_cleared, severity);

-- WHICH generation of an object is the one being observed NOW.
--
-- The inbox is content-addressed: re-polling unchanged data writes nothing,
-- because (source, external_id, content_hash) already holds it. That is right for
-- STORAGE and wrong as an answer to "what does this object say today", and the
-- fold was using MAX(generation) as a stand-in for it.
--
-- The two only agree while content never repeats. A body edited A -> B -> A
-- matches A's existing hash on the third observation, so nothing is written, and
-- MAX(generation) still points at B. The fold then reads text the reviewer has
-- already replaced, and a finding restored by the revert is invisible.
--
-- The split is the one Git makes and this table is the missing half: blobs are
-- content-addressed and deduplicated, while a ref records which blob is current.
-- Storing the pointer separately keeps de-duplication AND makes "current" a
-- recorded fact rather than one inferred from an ordering that does not hold.
--
-- Upserted on EVERY observation, including one whose payload was already stored.
-- That is the whole point: the write that was being skipped is the one that
-- carries the information.
CREATE TABLE IF NOT EXISTS inbox_current (
  pr_number    INTEGER NOT NULL,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  observed_at  INTEGER NOT NULL,
  PRIMARY KEY (pr_number, source, external_id)) STRICT;

-- Per-reviewer availability as a BAND, not a rate. Measured: 15/15 refusals in
-- one 7-hour window, then ~30 straight answers over 29 hours.
CREATE TABLE IF NOT EXISTS reviewer_supply (
  nwo          TEXT NOT NULL,
  reviewer     TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('up','down','never_seen')),
  since        INTEGER NOT NULL,
  -- Bumps on every down->up transition, and keys the re-request so a refusal
  -- does not permanently spend the idempotency slot for a head.
  supply_epoch INTEGER NOT NULL DEFAULT 0,
  classifier_version TEXT NOT NULL,
  PRIMARY KEY (nwo, reviewer)) STRICT;

-- What derived the projections, and whether the observation behind them was whole.
CREATE TABLE IF NOT EXISTS projection_meta (
  nwo        TEXT NOT NULL,
  scope      TEXT NOT NULL,                  -- 'pr:<n>'
  classifier_version TEXT NOT NULL,
  derived_at INTEGER NOT NULL,
  complete   INTEGER NOT NULL,               -- 0 = a fetch failed or was truncated
  -- The head this projection was derived FOR, and it is not decoration.
  --
  -- Clearing is head-dependent: `derivePr` decides `is_cleared` by asking whether
  -- a round covers THIS head, so the same threads under a different head give a
  -- different answer to "what is still open". A reader that takes the projection
  -- without checking the head is judging the current revision by the previous
  -- one's clearing -- and the two facts it feeds, how many criticals are open and
  -- which threads they are, are exactly the ones that license spilling a finding
  -- or dispatching a worker at it.
  --
  -- NULL means a projection written before this column existed, or one derived
  -- with no head in hand. Both are UNKNOWN and neither is usable, which is the
  -- same fail-closed reading as the four staleness reasons beside it.
  head       TEXT,
  -- Could the body-finding derivation have been COMPLETE for this pull request?
  --
  -- Stored with the projection rather than computed by a reader, for the same
  -- reason `head` is: it is a property of how these rows were derived, and a
  -- reader recomputing it from today's profile would answer about a fold that
  -- never ran. 0 means at least one reviewer posted a substantive review body
  -- and the profile does not say how that reviewer's bodies carry findings, so
  -- the critical count below may be missing one. Default 0 -- a projection
  -- written before this column existed derived no body findings at all.
  body_derived INTEGER NOT NULL DEFAULT 0,
  -- How many REVIEW OBJECTS this projection was folded from.
  --
  -- Stored here rather than counted from the inbox at read time, for the same
  -- reason `head` is: it is a property of the fold, and recomputing it answers
  -- about a different moment. Counting the inbox looked equivalent because ingest
  -- and derive run together in a tick — until derive FAILS or rolls back after
  -- ingest succeeded. Then the inbox holds the new review, the projection does
  -- not, and a live cross-check comparing against the inbox count agrees with
  -- itself and accepts the stale projection. The check would be vacuous in exactly
  -- the failure it exists for.
  --
  -- NULL means a projection written before this column existed. The comparison
  -- treats that as "not reported" and falls back to threads alone, rather than
  -- inventing a number.
  review_total INTEGER,
  PRIMARY KEY (nwo, scope)) STRICT;

-- ------------------------------------------------------------ review shadow
-- Does the derived view tell the same story as the live read? Rolled up per day
-- because the question is "how many consecutive DAYS has it agreed", and twenty
-- identical rows an hour would bury the divergences that matter.
--
-- `incomparable` is counted separately and is neither agreement nor
-- disagreement: a truncated read or an unbuilt projection means nothing was
-- learned, and a streak built from those is a streak of not looking.
CREATE TABLE IF NOT EXISTS review_shadow (
  nwo             TEXT NOT NULL,
  pr              INTEGER NOT NULL,
  day             TEXT NOT NULL,            -- YYYY-MM-DD, UTC
  comparisons     INTEGER NOT NULL DEFAULT 0,
  agreements      INTEGER NOT NULL DEFAULT 0,
  incomparable    INTEGER NOT NULL DEFAULT 0,
  last_divergence TEXT,
  last_at         INTEGER NOT NULL,
  PRIMARY KEY (nwo, pr, day)) STRICT;

-- ---------------------------------------------------------------- facts
-- Evidence attached to a node. Defined HERE rather than in the migrator so a
-- database opened by open() has the same shape as one built by a migration.
CREATE TABLE IF NOT EXISTS fact (
  id INTEGER PRIMARY KEY, node_id TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL, observed_at INTEGER NOT NULL, source TEXT,
  scope_sha TEXT, expires_at INTEGER, supersedes_fact_id INTEGER) STRICT;
CREATE INDEX IF NOT EXISTS fact_node ON fact(node_id, observed_at);

-- Fix attempts, counted against a HEAD-INDEPENDENT cause. The rule is one
-- attempt per finding, then escalate; keying it by revision made every surviving
-- failure look new, because a fix attempt pushes a new head by construction.
-- `last_sha` is kept for the human trail, never for the count.
CREATE TABLE IF NOT EXISTS fix_attempt (
  nwo      TEXT NOT NULL,
  pr       INTEGER NOT NULL,
  cause    TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at  INTEGER NOT NULL,
  last_sha TEXT,
  note     TEXT,                              -- what the last worker needed a human FOR
  PRIMARY KEY (nwo, pr, cause)) STRICT;

-- Settlement across REAL ticks. settle() is a pure reducer that needs the
-- previous reading to fold into, and evaluatePr() used to manufacture three
-- readings from one API call -- so a check set was declared stable the first
-- time it was seen. One row per pull request: settle() itself resets the streak
-- when the head changes while carrying the floor forward, which is what stops a
-- shrinking check set from passing as a clean one.
CREATE TABLE IF NOT EXISTS settlement (
  nwo           TEXT NOT NULL,
  pr            INTEGER NOT NULL,
  sha           TEXT NOT NULL,
  key           TEXT NOT NULL,      -- the sorted check-NAME set, NUL-joined
  streak        INTEGER NOT NULL,
  floor         INTEGER NOT NULL,   -- high-water check count for this PR, across heads
  first_seen_at INTEGER NOT NULL,   -- when THIS head was first observed
  last_seen_at  INTEGER NOT NULL,
  -- Which definition of "a check" the floor was recorded under. A floor from an
  -- older accounting is discarded, not compared against.
  accounting    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (nwo, pr)) STRICT;

-- An escalation is an event, not a state. This table holds the set currently
-- STANDING, so the daemon can announce a cause when it starts and when it
-- changes rather than on every tick. It must be durable: KeepAlive restarts the
-- daemon, and an in-memory set would re-announce everything on each restart.
CREATE TABLE IF NOT EXISTS escalation (
  why TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  announced_count INTEGER NOT NULL) STRICT;

-- ---------------------------------------------------------------- views
CREATE VIEW IF NOT EXISTS v_dead AS
  SELECT DISTINCT dst AS id FROM edge WHERE type IN ('SUPERSEDES','REFUTES');

CREATE VIEW IF NOT EXISTS v_blocked AS
  SELECT n.id FROM node n
  WHERE EXISTS (SELECT 1 FROM edge e JOIN node d ON d.id=e.dst
                WHERE e.src=n.id AND e.type='DEPENDS_ON'
                  AND d.status NOT IN ('done','decided'))
     OR EXISTS (SELECT 1 FROM edge e JOIN node b ON b.id=e.src
                WHERE e.dst=n.id AND e.type='BLOCKS'
                  AND b.status NOT IN ('done','decided','cancelled','refuted'));

CREATE VIEW IF NOT EXISTS v_ready AS
  SELECT n.*, COALESCE(x.attempts,0) AS attempts, COALESCE(x.not_before,0) AS not_before
  FROM node n
  LEFT JOIN task_exec x ON x.task_id = n.id
  WHERE n.kind='task'
    AND n.status IN ('open','ready')
    AND n.id NOT IN (SELECT id FROM v_dead)
    AND n.id NOT IN (SELECT id FROM v_blocked)
    AND NOT EXISTS (SELECT 1 FROM run r WHERE r.task_id=n.id
                    AND r.status IN ('leased','running','blocked_on_ci',
                                     'blocked_on_review','awaiting_founder'))
    AND COALESCE(x.not_before,0) <= unixepoch()
    AND COALESCE(x.cancel_requested,0) = 0
    AND COALESCE(x.attempts,0) < COALESCE(x.max_attempts,5);

-- ---------------------------------------------------------------- worker contracts
-- One row per claude worker the daemon dispatches: the immutable contract it
-- ran under, so "what did this worker actually run as" has an answer after the
-- process is gone. The guardian's attempts are independent dispatches, each
-- with its own row; reusing a recorded contract verbatim on a retry is the
-- builder's phase behaviour and reads these columns plus the argv file kept
-- beside the run. The lease stays on `run`; this row never carries a second one.
CREATE TABLE IF NOT EXISTS worker_run (
  run_id          TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  cli_version     TEXT NOT NULL,
  model_requested TEXT,
  model_resolved  TEXT,                       -- from the worker's init event, once it speaks
  effort          TEXT,
  argv_hash       TEXT NOT NULL,
  prompt_hash     TEXT NOT NULL,
  settings_hash   TEXT NOT NULL,
  env_hash        TEXT,                       -- the exact environment, canonical; PATH, git config, caps included
  tool_contract   TEXT,
  agents_hash     TEXT,
  max_turns       INTEGER,
  max_budget_usd  REAL,
  canary_id       TEXT,
  out_path        TEXT NOT NULL,
  err_path        TEXT NOT NULL,
  pid             INTEGER,
  lstart          TEXT,
  contract_drift  TEXT,                       -- JSON; null when the live environment matched
  truncated       INTEGER NOT NULL DEFAULT 0, -- the durable output hit its cap; the run is never OK
  stdout_bytes    INTEGER,
  created_at      INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
