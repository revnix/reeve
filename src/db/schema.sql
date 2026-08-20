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
  args         TEXT NOT NULL,                 -- JSON
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                 ('pending','inflight','done','failed','dead_letter')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  not_before   INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  result       TEXT,                          -- JSON: pr number, sha, comment id…
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(not_before, id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS outbox_inflight ON outbox(lease_expires_at) WHERE status='inflight';

-- ---------------------------------------------------------------- inbox
-- Facts observed from the outside world (GitHub). Dedup by external id so a
-- re-poll is free. The reviewer/CI loops consume from here.
CREATE TABLE IF NOT EXISTS inbox (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,                 -- 'codex'|'coderabbit'|'greptile'|'human'|'ci'
  external_id  TEXT NOT NULL,                 -- comment node id / check-run id
  pr_number    INTEGER,
  head_sha     TEXT,
  kind         TEXT NOT NULL,                 -- 'review_comment'|'check_run'|'review'
  payload      TEXT NOT NULL,
  observed_at  INTEGER NOT NULL,
  processed_at INTEGER,
  UNIQUE (source, external_id)
) STRICT;
CREATE INDEX IF NOT EXISTS inbox_unprocessed ON inbox(pr_number) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------- facts
-- Evidence attached to a node. Defined HERE rather than in the migrator so a
-- database opened by open() has the same shape as one built by a migration.
CREATE TABLE IF NOT EXISTS fact (
  id INTEGER PRIMARY KEY, node_id TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL, observed_at INTEGER NOT NULL, source TEXT,
  scope_sha TEXT, expires_at INTEGER, supersedes_fact_id INTEGER) STRICT;
CREATE INDEX IF NOT EXISTS fact_node ON fact(node_id, observed_at);

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
