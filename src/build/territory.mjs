// territory -- the claim model shared by admission and by resume.
//
// WHY ITS OWN MODULE. `admitTask` and `applyCompensation`'s `regrant-territory`
// both decide the same question -- may this task hold these paths -- and both
// wrote their own answer. They diverged in three ways at once: admission scanned
// every live lease in the project and applied the overlap predicate, while
// regrant looked up one exact `(project, kind, path)` row, so a resume could
// grant a task paths a live lease already covered by ancestry; admission's grant
// was a plain INSERT that hit the primary key when an EXPIRED row for the same
// path was still in the table; and regrant's upsert refreshed `task` and
// `expires_at` but not `pinned_until`, so a replacement silently kept the old
// pin. One copy each of the predicate, the scan and the grant is the fix -- the
// sites cannot drift from each other if there is nothing to drift.
//
// Imports nothing but `node:` nothing at all: it is given a `db` and does not
// reach for one, which is what lets both callers use it inside their own
// `BEGIN IMMEDIATE` without nesting a transaction.

// The columns of a lease row, in the order every event payload carries them.
export const LEASE_COLS = `project, kind, path, task, expires_at, pinned_until`;

// One hour. Long enough that an ordinary phase does not have to renew mid-step,
// short enough that a crashed task's paths come back without an operator.
export const LEASE_SECONDS = 3600;

/**
 * Do two claims cover any of the same bytes?
 *
 * Path containment, and deliberately NOT kind-sensitive: a `file` claim on
 * `a/b.ts` and a `prefix` claim on `a` are the same bytes reached two ways, and
 * treating them as distinct is how two tasks end up editing one file.
 */
export function overlaps(a, b) {
  const p = a?.path ?? "", q = b?.path ?? "";
  // The repository root contains everything, including itself.
  if (p === "" || q === "") return true;
  return p === q || p.startsWith(q + "/") || q.startsWith(p + "/");
}

/**
 * Every lease in a project that has not expired, as of `at`.
 *
 * SCOPED BY PROJECT. Without the project predicate two unrelated repositories
 * that both contain `packages/x` serialise against each other -- a deadlock
 * between projects that share nothing, reported as a territory conflict.
 */
export const liveLeases = (db, project, at) =>
  db.prepare(`SELECT ${LEASE_COLS} FROM territory_lease WHERE project = ? AND expires_at > ?`)
    .all(project, at);

/**
 * The first live lease held by ANOTHER task that overlaps this claim, or null.
 *
 * Takes the scan's rows rather than querying per claim so a filing with many
 * claims reads the table once, and so both callers are demonstrably applying the
 * predicate to the same set.
 */
export const firstConflict = (claim, leases, taskId) =>
  leases.find(l => l.task !== taskId && overlaps(claim, l)) ?? null;

/** How a lease refusal reads, so admission and resume word it identically. */
export const conflictRefusal = (claim, lease) =>
  `territory ${claim.kind} ${claim.path || "(repository root)"} overlaps ` +
  `${lease.kind} ${lease.path || "(repository root)"}, held by ${lease.task}; ` +
  `the filing is refused rather than granting two tasks the same paths`;

/**
 * Grant one lease, replacing a row this task already holds or one that expired.
 *
 * FAIL-CLOSED ON THE UPSERT ITSELF, not on the caller having scanned first. The
 * `WHERE` restricts the replacement to a row that is ours or is dead; a live row
 * belonging to someone else makes the upsert a NO-OP, which would otherwise
 * return that task's row and read as a successful grant. So the row is read back
 * and its owner checked, and a grant that did not happen throws rather than
 * being reported. The caller's conflict scan is the first line; this is the one
 * that holds when a scan is skipped, reordered, or added to later.
 */
export function grantLease(db, { project, claim, taskId, at, pinned = false,
                                 seconds = LEASE_SECONDS }) {
  const until = at + seconds;
  // EVERY column the insert would have set, `pinned_until` included. Leaving it
  // out let a replacement keep the previous holder's pin -- or its absence --
  // while that column is the only home of the pin, so a reaper reading it acted
  // on a value no live claim asked for.
  db.prepare(
    `INSERT INTO territory_lease(project, kind, path, task, expires_at, pinned_until)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(project, kind, path) DO UPDATE SET
       task = excluded.task,
       expires_at = excluded.expires_at,
       pinned_until = excluded.pinned_until
     WHERE territory_lease.task = excluded.task OR territory_lease.expires_at <= ?`)
    .run(project, claim.kind, claim.path, taskId, until, pinned ? until : null, at);

  const row = db.prepare(
    `SELECT ${LEASE_COLS} FROM territory_lease WHERE project=? AND kind=? AND path=?`)
    .get(project, claim.kind, claim.path);
  if (!row || row.task !== taskId)
    throw new Error(
      `territory ${claim.kind} ${claim.path || "(repository root)"} could not be granted to ${taskId}: ` +
      `it is held by ${row?.task ?? "(no row)"} until ${row?.expires_at ?? "?"}`);
  return row;
}
