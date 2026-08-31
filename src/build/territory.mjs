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
// Imports only the phase machine's TERMINAL set, which itself imports nothing.
// It is given a `db` and never reaches for one, which is what lets both callers
// use it inside their own `BEGIN IMMEDIATE` without nesting a transaction.
import { TERMINAL, HELD } from "./phases.mjs";
// `task_territory` is a replayed projection, so clearing a spent pin here has to
// append its row image like every other write to it: an unrecorded change is
// undone by the next restore, which would hand the resurrection straight back.
import { hubEvent } from "./hubdb.mjs";

// The terminal phases, as a SQL list. A lease belonging to a task in one of
// these is dead; every other lease is live, whatever its clock says.
const TERMINAL_SQL = TERMINAL.map(p => `'${p}'`).join(",");
// The held phases. A held task's lease lives exactly as long as its PIN.
const HELD_SQL = HELD.map(p => `'${p}'`).join(",");

// hub.sql's reaper rule, as one predicate both the scan and the grant apply:
// "deletes a territory lease only when its task is terminal, or held with no
// live pin". Written once, because the scan and the replacement asking the same
// question differently is how this file's last three defects happened.
export const LEASE_IS_LIVE = `
  t.phase NOT IN (${TERMINAL_SQL})
  AND (t.phase NOT IN (${HELD_SQL})
       OR (l.pinned_until IS NOT NULL AND l.pinned_until > unixepoch()))`;

// The columns of a lease row, in the order every event payload carries them.
/**
 * The claim's row image, named once because two writers append it.
 *
 * `registry.mjs` emits it when a filing claims territory; `grantLease` emits it
 * again when the first grant stamps the pin's deadline. Both are replayed
 * projections keyed on (task, kind, path), and a column left out of either list
 * is a column replay reconstructs as NULL -- which for `pinned_until` means a
 * restored tail forgets when a pin ends and the next regrant treats it as a
 * first grant. One list, so the two cannot disagree.
 */
export const TERRITORY_COLS = `task, kind, path, pinned, pinned_until`;

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
 * Every lease in a project that still excludes other tasks.
 *
 * LIVENESS IS THE TASK'S STATE, NOT THE CLOCK, and hub.sql says so in as many
 * words: "a task is a row, not a process, so dead is a state question... never
 * merely because it looks old". The scan asked `expires_at > now` instead, and
 * NOTHING IN THIS SYSTEM RENEWS A TERRITORY LEASE -- searched: the only writes
 * are the grant here and `release-territory`'s delete. So every active task's
 * lease became invisible to this scan one hour after it was granted, and a new
 * filing on an ancestor, a descendant or the identical path was admitted beside
 * a task still editing those files. The clock was measuring nothing but the age
 * of the row.
 *
 * `expires_at` is kept on the row: it is what a future reaper reads, and it
 * records when the grant was made. It is not a liveness test and must not become
 * one again while no writer advances it.
 *
 * A HELD TASK IS THE EXCEPTION, and hub.sql names it: dead when "terminal, or
 * held with no live pin". Entering BLOCKED or ESCALATED releases territory
 * UNLESS the claim is pinned, so a pinned held task keeps its lease -- and that
 * decision is taken once, at the transition. Nothing revisits it when
 * `pinned_until` later passes, and there is no reaper: searched, and none
 * exists. So a pin whose whole purpose is to be time-bounded went on blocking
 * every overlapping filing until a founder intervened. Asking the pin at READ
 * time is what makes the deadline mean anything without a reaper to enforce it.
 *
 * SCOPED BY PROJECT. Without the project predicate two unrelated repositories
 * that both contain `packages/x` serialise against each other -- a deadlock
 * between projects that share nothing, reported as a territory conflict.
 */
export const liveLeases = (db, project) =>
  db.prepare(
    `SELECT l.project, l.kind, l.path, l.task, l.expires_at, l.pinned_until
       FROM territory_lease l
       JOIN task t ON t.id = l.task
      WHERE l.project = ? AND ${LEASE_IS_LIVE}`)
    .all(project);

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
 * `WHERE` restricts the replacement to a row that is ours or whose task has gone
 * TERMINAL -- the same liveness question the scan asks, for the same reason: an
 * expired row belonging to a task that is still running is not a dead row, and
 * replacing it hands two live tasks the same paths. A live row belonging to
 * someone else makes the upsert a NO-OP, which would otherwise
 * return that task's row and read as a successful grant. So the row is read back
 * and its owner checked, and a grant that did not happen throws rather than
 * being reported. The caller's conflict scan is the first line; this is the one
 * that holds when a scan is skipped, reordered, or added to later.
 */
export function grantLease(db, { project, claim, taskId, at, pinned = false,
                                 pinnedUntil = undefined, seconds = LEASE_SECONDS }) {
  const until = at + seconds;
  // THE PIN'S DEADLINE LIVES WITH ITS INTENT, on `task_territory`, and this reads
  // it from there rather than being told.
  //
  // A pin is one promise. While its intent was durable on the claim and its
  // deadline lived on the LEASE, every path that removed a lease lost half of it
  // -- and the surviving half said "pinned" with no end, so the next grant minted
  // a fresh deadline and resurrected a promise the founder had time-boxed. That
  // was found twice: once through `release-territory` deleting the row, and again
  // through this very upsert REPLACING a non-live holder's row, which never goes
  // near the release path. Two doors onto one defect is the signal that the
  // doors were never the defect.
  //
  // So the claim owns the deadline. The FIRST grant stamps it -- that is the
  // moment the promise is made -- and every later grant reads back what is
  // stored, including when it has passed. Nothing can lose one half without the
  // other, because there are no longer two halves.
  const claimRow = pinned ? db.prepare(
    `SELECT pinned_until FROM task_territory WHERE task=? AND kind=? AND path=?`)
    .get(taskId, claim.kind, claim.path) : null;
  let pinUntil = null;
  if (pinned) {
    pinUntil = claimRow?.pinned_until ?? (pinnedUntil === undefined ? until : pinnedUntil);
    if (claimRow && claimRow.pinned_until == null) {
      db.prepare(`UPDATE task_territory SET pinned_until = ? WHERE task=? AND kind=? AND path=?`)
        .run(pinUntil, taskId, claim.kind, claim.path);
      // EVENTED, because `task_territory` is a replayed projection and this is a
      // write to it. `registry.mjs` emits the claim's image at FILING time --
      // before any grant exists, so `pinned_until` is NULL in that image -- and
      // without this second emit a replayed tail reconstructs the deadline as
      // NULL. The next regrant then reads "no deadline", treats it as a first
      // grant, and mints a new one: the resurrection this migration exists to
      // remove, arriving through replay instead of through a lease delete.
      hubEvent(db, { kind: "task_territory.claimed", task: taskId,
        payload: db.prepare(
          `SELECT ${TERRITORY_COLS} FROM task_territory WHERE task=? AND kind=? AND path=?`)
          .get(taskId, claim.kind, claim.path) });
    }
  }
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
     WHERE territory_lease.task = excluded.task
        OR NOT EXISTS (SELECT 1 FROM task t, territory_lease l
                        WHERE t.id = territory_lease.task
                          AND l.project = territory_lease.project
                          AND l.kind    = territory_lease.kind
                          AND l.path    = territory_lease.path
                          AND ${LEASE_IS_LIVE})`)
    .run(project, claim.kind, claim.path, taskId, until, pinUntil);

  const row = db.prepare(
    `SELECT ${LEASE_COLS} FROM territory_lease WHERE project=? AND kind=? AND path=?`)
    .get(project, claim.kind, claim.path);
  if (!row || row.task !== taskId)
    throw new Error(
      `territory ${claim.kind} ${claim.path || "(repository root)"} could not be granted to ${taskId}: ` +
      `it is held by ${row?.task ?? "(no row)"} until ${row?.expires_at ?? "?"}`);
  return row;
}
