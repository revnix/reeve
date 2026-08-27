// providerdb -- every statement the provider scheduler runs.
//
// The hub owns its own SQL, exactly as `hubdb.mjs` owns the phase machine's and
// `src/db/ops.mjs` owns the guardian's. `src/provider.mjs` sits above this file
// and holds the POLICY -- the admission rule, the reservation arithmetic, the
// cooldown comparison -- and calls in here for every read and write.
//
// The split is not tidiness. `src/provider.mjs` is imported by BOTH daemons, and
// it sits at the top level because of that, which puts it outside the two
// directories allowed to contain raw SQL. Keeping the statements here means the
// guardian imports a policy function rather than a query builder, and the
// statement allowlist that fences the guardian's hub connection is checking a
// surface with exactly one definition.
//
// NOTHING HERE WRITES `hub_event`, and that is a constraint rather than an
// omission. `provider_lease` and `provider_state` are process-scoped: `restoreHub`
// clears them and they are not in the replay comparison set, so there is no
// image for a replay to restore. More concretely, the guardian's hub connection
// is authorised for exactly these two tables, so an `INSERT INTO hub_event` from
// a provider transaction is DENIED -- every real guardian claim and release
// would fail on the one statement that looked like good hygiene.
import { assertWritable } from "./locks.mjs";

// The fallback used when `provider_state` has no row yet.
//
// A fresh hub genuinely has none -- the doctor's H-5 check exists for that
// state -- so every read here has to carry the default rather than assuming a
// seeded row. One slot of the two is reserved for the guardian: the guardian is
// the watchman, the builder is the thing being restrained, and the asymmetry is
// the point of the table.
export const DEFAULT_LIMIT = 2, DEFAULT_RESERVED = 1;
export const PROVIDER = "claude";

// The database clock. It lives here for the same reason every other statement
// does: `src/provider.mjs` sits at the top level, outside the two directories
// allowed to contain raw SQL, and a `SELECT unixepoch()` there is a second
// definition of the guardian's SQL surface in a file the allowlist and the
// audits do not inspect. One statement is enough to make the boundary untrue.
export const nowSeconds = (db) => db.prepare("SELECT unixepoch() n").get().n;

export const LEASE_COLS =
  `id, owner, repo_id, run_ref, pid, lstart, priority, budget_usd, status,
   requested_at, started_at, heartbeat_at, expires_at, preempt_requested, token`;

/**
 * The shape the provider scheduler REQUIRES, table by table.
 *
 * A version number is a claim about shape and `COLUMNS_AT` describes only what
 * later migrations ADD -- so a current-version hub missing a column created in
 * migration 1, `provider_state.cooldown_until` among them, satisfied both and
 * still threw on the first `providerState` read, into the guardian's fail-open
 * path. What the scheduler needs is what its own SQL names, and that is here.
 *
 * NAMES ARE NOT ENOUGH, and a name-only gate is a fail-open. These tables are
 * STRICT, so a column whose DECLARED TYPE is wrong accepts the schema check and
 * then refuses the write: a hub carrying `provider_lease.token INTEGER` passed
 * every name comparison, and `claimProvider` threw "cannot store TEXT value in
 * INTEGER column" into the guardian's documented fail-open path, which dispatches
 * model work outside the shared limit. Measured against node:sqlite, with a
 * control on the correct schema, rather than reasoned about.
 *
 * So the shape is a column-to-TYPE map, not a list of names.
 *
 * `provider_lease` can no longer be derived from `LEASE_COLS`, since that
 * constant carries no types. The derivation is replaced by an ASSERTED
 * AGREEMENT: the test requires these keys to equal `LEASE_COLS` exactly, in both
 * directions, so a column added to the SQL without a type here fails the suite
 * rather than silently leaving a hole in the gate. Both maps are also compared
 * against a freshly migrated hub, in both directions, so neither can drift from
 * what the migrations actually build.
 */
export const SCHEDULER_COLUMNS = Object.freeze({
  provider_lease: Object.freeze({
    id: "INTEGER", owner: "TEXT", repo_id: "INTEGER", run_ref: "TEXT",
    pid: "INTEGER", lstart: "TEXT", priority: "INTEGER", budget_usd: "REAL",
    status: "TEXT", requested_at: "INTEGER", started_at: "INTEGER",
    heartbeat_at: "INTEGER", expires_at: "INTEGER",
    preempt_requested: "INTEGER", token: "TEXT",
  }),
  provider_state: Object.freeze({
    provider: "TEXT", concurrency_limit: "INTEGER", guardian_reserved: "INTEGER",
    cooldown_until: "INTEGER", last_429_at: "INTEGER", last_signature: "TEXT",
    measured_at: "INTEGER",
  }),
});

/**
 * A claim's INCARNATION, and the reason an identity is not enough.
 *
 * `restoreHub` clears provider_lease in the restored file, so SQLite restarts
 * its integer keys: after a restore, a re-claim of the same run gets an
 * identical (owner, repo_id, run_ref) AND an identical id. Nothing in the row
 * told the new claim apart from the old one, so a pre-restore mutation replayed
 * afterwards -- which the retry-on-maintenance loop is exactly the caller to do
 * -- deleted a live lease or overwrote its liveness data.
 *
 * Random rather than a counter, because a counter would have to survive the very
 * event this exists to detect. outbox.lease_token solves the same problem the
 * same way; this is that pattern applied to the second table that needed it.
 */
export const newToken = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * The scheduler's view of the provider, with the documented defaults applied.
 *
 * Returned as a plain object rather than a row so callers cannot accidentally
 * depend on the row being absent -- "no row" and "the default limits" are the
 * same fact to every reader above this line.
 */
export function providerState(db, { provider = PROVIDER } = {}) {
  const row = db.prepare(
    `SELECT provider, concurrency_limit, guardian_reserved, cooldown_until,
            last_429_at, last_signature, measured_at
       FROM provider_state WHERE provider = ?`).get(provider);
  return {
    provider,
    limit: row?.concurrency_limit ?? DEFAULT_LIMIT,
    reserved: row?.guardian_reserved ?? DEFAULT_RESERVED,
    cooldownUntil: row?.cooldown_until ?? null,
    lastSignature: row?.last_signature ?? null,
    seeded: row != null,
  };
}

export const heldCount = (db) => db.prepare(
  `SELECT count(*) c FROM provider_lease WHERE status = 'held'`).get().c;

export const heldCountBy = (db, owner) => db.prepare(
  `SELECT count(*) c FROM provider_lease WHERE status = 'held' AND owner = ?`).get(owner).c;

export const queuedGuardianCount = (db) => db.prepare(
  `SELECT count(*) c FROM provider_lease WHERE status = 'queued' AND owner = 'guardian'`).get().c;

/**
 * Every `queued` guardian request for ONE repository.
 *
 * It exists as a function rather than as a query in the daemon because the sweep
 * that uses it runs in `src/daemon.mjs`, where raw SQL is not allowed to live: a
 * `SELECT ... FROM provider_lease` embedded there is a second definition of the
 * guest's SQL surface, and it drifts from this one the first time the allowlist
 * or the schema changes.
 */
export const queuedGuardianRequests = (db, { repoId }) => db.prepare(
  `SELECT ${LEASE_COLS} FROM provider_lease
    WHERE status = 'queued' AND owner = 'guardian' AND repo_id = ?
    ORDER BY requested_at, id`).all(repoId);

export const liveRequest = (db, { owner, repoId, runRef }) => db.prepare(
  `SELECT ${LEASE_COLS} FROM provider_lease
    WHERE owner = ? AND repo_id = ? AND run_ref = ? AND status IN ('queued','held')`)
  .get(owner, repoId, runRef);

export const leaseById = (db, id) => db.prepare(
  `SELECT ${LEASE_COLS} FROM provider_lease WHERE id = ?`).get(id);

/**
 * The YOUNGEST live builder lease -- the one a queued guardian asks to preempt.
 *
 * Youngest, not oldest: the newest builder has done the least work, so releasing
 * it at its next phase boundary discards the least. `requested_at` is integer
 * seconds and several claims can share one, so `id` breaks the tie -- without it
 * "the youngest" has no defined answer inside a single second and the choice
 * falls to whichever row the scan happened to reach first.
 */
export const youngestHeldBuilder = (db) => db.prepare(
  `SELECT ${LEASE_COLS} FROM provider_lease
    WHERE status = 'held' AND owner = 'builder'
    ORDER BY requested_at DESC, id DESC LIMIT 1`).get();

export const requestPreemption = (db, id) => db.prepare(
  `UPDATE provider_lease SET preempt_requested = 1 WHERE id = ?`).run(id);

// The flag is a REQUEST for capacity, so it has to be withdrawn when the
// capacity is no longer wanted. Left set, the marked builder still surrenders
// its slot at its next phase boundary for a guardian that has already been
// served, suspending running work to leave a slot idle.
export const clearPreemption = (db) => db.prepare(
  `UPDATE provider_lease SET preempt_requested = 0 WHERE preempt_requested = 1`).run();

export const insertLease = (db, { owner, repoId, runRef, pid, lstart, priority,
                                  budgetUsd, status, at, expiresAt, token }) => db.prepare(
  `INSERT INTO provider_lease(owner, repo_id, run_ref, pid, lstart, priority, budget_usd,
                              status, requested_at, started_at, heartbeat_at, expires_at, token)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
   RETURNING id, token`)
  .get(owner, repoId, runRef, pid, lstart, priority, budgetUsd, status, at,
       status === "held" ? at : null, status === "held" ? at : null, expiresAt, token);

// A queued request records WHO is waiting, so a re-ask by a restarted daemon has
// to update that -- otherwise the row still names a dead process and the reaper
// deletes a queue entry somebody is actively polling for. A queued row holds no
// slot, so this transfers no capacity; it only keeps the claimant current.
export const renewQueued = (db, { id, pid, lstart, at, expiresAt }) => db.prepare(
  `UPDATE provider_lease SET pid = ?, lstart = ?, expires_at = ?, heartbeat_at = ?
    WHERE id = ? AND status = 'queued'`).run(pid, lstart, expiresAt, at, id);

// The oldest guardian still waiting. `requested_at` is integer seconds and two
// requests can share one, so `id` breaks the tie -- without it "first in the
// queue" has no defined answer inside a single second.
export const oldestQueuedGuardian = (db) => db.prepare(
  `SELECT ${LEASE_COLS} FROM provider_lease
    WHERE status = 'queued' AND owner = 'guardian'
    ORDER BY requested_at, id LIMIT 1`).get();

// A promotion records WHO is being admitted, in the same statement.
//
// Promoting a queued row without refreshing its pid and lstart leaves it naming
// whichever process first asked -- and a guardian that restarted while queued is
// then admitted under its dead predecessor's identity. The restore holder scan
// can read that process as gone and replace the hub mid-dispatch, an idempotent
// re-ask gets `held-elsewhere` from its own lease until the worker bind lands,
// and the reaper is watching a pid that will never be alive again. `renewQueued`
// covers the re-ask path; this is the one that bypasses it.
export const promoteToHeld = (db, { id, pid, lstart, at, expiresAt }) => db.prepare(
  `UPDATE provider_lease
      SET status = 'held', pid = ?, lstart = ?, started_at = ?, heartbeat_at = ?, expires_at = ?
    WHERE id = ? AND status = 'queued'`).run(pid, lstart, at, at, expiresAt, id);

// THE IDENTITY IS PART OF THE KEY, on every mutation that names a row by id.
//
// A restore replaces the database, clears `provider_lease` and lets SQLite
// renumber it, so an integer key can come back pointing at somebody else's
// request. Two silent failures follow from trusting it. If a restore lands
// between a claim and the spawn, a rebind keyed on the id alone overwrites the
// NEW holder's pid and lstart with the spawned worker's, and the reaper -- whose
// whole basis is pid-and-lstart death -- can never match either row again. If it
// lands while an old worker still runs, that worker's heartbeat keeps renewing an
// unrelated reused row and prevents its reaping for as long as the worker lives.
//
// So the id is a fast path, never an identity. Where a caller supplies both, both
// must match; where it supplies only the identity, that alone selects the row.
// THE TOKEN IS PART OF EVERY FENCE. The identity says WHICH RUN; the token says
// WHICH ATTEMPT AT IT. Without the second, a mutation held across a restore
// matches a row that merely inherited the same name and number.
// THE TOKEN IS NOT OPTIONAL, and a missing one is refused rather than dropped.
//
// Building the predicate without it when it is absent means a tokenless call
// silently gets the PRE-MIGRATION fence -- identity and id, both of which a
// restore reproduces exactly. A guard that degrades to the thing it replaced,
// quietly, on the input it was added for, is not a guard. Callers have the token:
// `claimProvider` returns it beside the id for exactly this.
const identityWhere = (id, token) => {
  if (token == null)
    throw new Error("a fenced provider mutation requires the claim's token; refusing the weaker predicate");
  return `owner = ? AND repo_id = ? AND run_ref = ? AND token = ?`
       + (id == null ? "" : ` AND id = ?`);
};
const identityArgs = (id, token, owner, repoId, runRef) =>
  [owner, repoId, runRef, token, ...(id == null ? [] : [id])];

export const bindLease = (db, { id = null, token = null, owner, repoId, runRef, pid, lstart, at }) => db.prepare(
  `UPDATE provider_lease SET pid = ?, lstart = ?, started_at = COALESCE(started_at, ?),
                             heartbeat_at = ?
    WHERE ${identityWhere(id, token)}`)
  .run(pid, lstart, at, at, ...identityArgs(id, token, owner, repoId, runRef));

export const touchLease = (db, { id = null, token = null, owner, repoId, runRef, at, expiresAt }) => db.prepare(
  `UPDATE provider_lease SET heartbeat_at = ?, expires_at = ?
    WHERE ${identityWhere(id, token)}`)
  .run(at, expiresAt, ...identityArgs(id, token, owner, repoId, runRef));

export const deleteLease = (db, { id = null, token = null, owner, repoId, runRef }) => db.prepare(
  `DELETE FROM provider_lease WHERE ${identityWhere(id, token)}`)
  .run(...identityArgs(id, token, owner, repoId, runRef));

export const deleteLeaseById = (db, id) => db.prepare(
  `DELETE FROM provider_lease WHERE id = ?`).run(id);

export const deleteQueued = (db, { owner, repoId, runRef }) => db.prepare(
  `DELETE FROM provider_lease
    WHERE owner = ? AND repo_id = ? AND run_ref = ? AND status = 'queued'`)
  .run(owner, repoId, runRef);

// EXPIRED AND ONLY EXPIRED. Liveness is asked about these by the caller, because
// `isAlive` is a process question and this file answers only database ones.
export const expiredLeases = (db, at) => db.prepare(
  `SELECT ${LEASE_COLS} FROM provider_lease WHERE expires_at <= ? ORDER BY id`).all(at);

export const recordRateLimit = (db, { provider = PROVIDER, signature, at, until,
                                      limit = DEFAULT_LIMIT, reserved = DEFAULT_RESERVED }) => db.prepare(
  `INSERT INTO provider_state(provider, concurrency_limit, guardian_reserved,
                              cooldown_until, last_429_at, last_signature)
   VALUES(?,?,?,?,?,?)
   ON CONFLICT(provider) DO UPDATE SET
     -- THE LONGEST WAIT WINS. provider_state is one row shared by every daemon
     -- on the host, and their profiles need not agree: a 300-second cooldown
     -- followed ten seconds later by a 30-second one would otherwise cut the
     -- remaining wait to 40 and admit claims while the first backoff was still
     -- live. A cooldown is a floor, and a second observation of the same
     -- throttling cannot be evidence that it has become less severe.
     cooldown_until = CASE
       WHEN provider_state.cooldown_until IS NULL
         OR provider_state.cooldown_until < excluded.cooldown_until
       THEN excluded.cooldown_until ELSE provider_state.cooldown_until END,
     -- The metadata is the latest by TIMESTAMP, not by arrival. Observations can
     -- commit out of order -- one daemon retrying an event stamped 1000 after
     -- another has already written one stamped 1100 -- and an unconditional
     -- assignment then walks last_429_at backwards and replaces the newest
     -- signature with an older one. The cooldown stays correct either way, but
     -- the diagnostic that tells a founder WHAT threw last would name the wrong
     -- event, which is worse than saying nothing.
     last_429_at    = CASE
       WHEN provider_state.last_429_at IS NULL
         OR provider_state.last_429_at <= excluded.last_429_at
       THEN excluded.last_429_at ELSE provider_state.last_429_at END,
     last_signature = CASE
       WHEN provider_state.last_429_at IS NULL
         OR provider_state.last_429_at <= excluded.last_429_at
       THEN excluded.last_signature ELSE provider_state.last_signature END`)
  .run(provider, limit, reserved, until, at, signature);

/**
 * Open the scheduler's write transaction.
 *
 * `assertWritable` runs FIRST, inside the transaction, on every mutation without
 * exception. Without it a guardian can take a lease and launch a worker after
 * `restoreHub` has acquired `maintenance_lock` and finished its holder scan --
 * reopening the writer race the lock exists to close, from the one code path
 * allowed to write the hub without holding a writer lease.
 *
 * It runs before any argument validation, so a caller that is missing an
 * identity during a restore is told about the restore. The restore is the
 * bigger fact, and it is the one that will still be true a second later.
 */
export function providerTx(db, { isAlive, at = null }, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertWritable(db, { isAlive, inTx: true, ...(at == null ? {} : { at }) });
    const r = fn();
    // THE INVARIANT, ENFORCED HERE RATHER THAN AT EACH SITE THAT CAN BREAK IT.
    //
    // A preemption request exists only while a guardian is waiting for capacity
    // AND COULD ACTUALLY USE IT. Three separate paths empty that queue -- a
    // promotion, a cancellation, and the reaper deleting an expired queued row
    // whose daemon died -- and the first two were taught to withdraw the mark one
    // review round at a time while the third was missed. A rule that every future
    // mutation has to remember is a rule that will be forgotten again, so it is
    // asserted on the way out of every provider transaction instead. Setting the
    // flag stays a policy decision in provider.mjs; only its withdrawal is
    // bookkeeping.
    //
    // A LIVE COOLDOWN WITHDRAWS IT TOO. A queued guardian is not waiting for a
    // SLOT while the provider is throttled -- it is waiting for the throttle to
    // lift -- so a builder that reaches a phase boundary during the cooldown
    // would surrender capacity that then sits idle until it does. Admission
    // already refuses to REQUEST preemption while cooling; a cooldown that starts
    // after the request was made is the same fact arriving in the other order,
    // and a guardian still starved when the cooldown lifts asks again.
    // Stated once, positively: A PREEMPTION REQUEST EXISTS ONLY WHILE A QUEUED
    // GUARDIAN IS BLOCKED BY CAPACITY. Everything else is a way of not being
    // blocked by capacity, and each was learned separately until the rule was
    // put here -- nobody queued (a promotion, a cancellation, the reaper taking
    // an expired row), throttled rather than starved (a cooldown), and now
    // simply not starved any more: a slot freed by an UNRELATED release, which
    // the queued guardian has not polled for yet. Left marked through that
    // interval, the victim reaches its phase boundary and yields as well,
    // suspending a second worker to leave capacity idle that was already free.
    const st = providerState(db);
    const clockNow = at ?? nowSeconds(db);
    const cooling = st.cooldownUntil != null && st.cooldownUntil > clockNow;
    const starved = queuedGuardianCount(db) > 0 && !cooling && heldCount(db) >= st.limit;
    if (!starved) clearPreemption(db);
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}
