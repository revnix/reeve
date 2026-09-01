// repoid -- the ONE place reeve turns a project into GitHub's numeric repository
// id.
//
// It lived in `build/loop.mjs` while only the builder needed it. C4 gives the
// guardian the same need, and a resolver two lanes call that lives inside one
// lane's tick file is a shared module by accident: nobody decides it, nobody
// documents it, and the next reader infers from its address that it is
// builder-only. The founder's rule is about identity rather than location --
// ONE resolver, keyed on the project -- so moving it changes nothing it decides.
//
// Keyed on the PROJECT and never on the name. A repository can be renamed or
// transferred; its id cannot. Asking GitHub by name and trusting the answer
// would make a rename look like a different repository, and a GitHub outage
// would refuse every dispatch while the answer sat in the local database.

import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { completedVersion, HUB_BUSY_TIMEOUT_MS } from "./hubdb.mjs";

/**
 * The identity table's columns and their DECLARED types, for the guardian's
 * runtime schema gate.
 *
 * Adding a table to the guest allowlist puts it in that gate, and a table with
 * no entry here is checked only for EXISTENCE. `project_identity` is STRICT, so
 * a hub whose `repo_id` is declared TEXT passes an existence check, and the
 * write that follows is refused by the column rather than by the gate -- which
 * is the route `provider_lease.token INTEGER` took to being reported usable
 * while `claimProvider` threw and the daemon dispatched work UNSCHEDULED,
 * outside the shared limit. The gate exists to be failed, not passed.
 */
export const IDENTITY_COLUMNS = Object.freeze({
  project: "TEXT", repo_id: "INTEGER", learned_at: "INTEGER",
});

/**
 * The migration that introduces `project_identity`.
 *
 * Named rather than written as a bare 5 at the comparison, because the lookup
 * and the compatibility path below must agree about which hubs have the table,
 * and two spellings of one number is the shape this repository keeps finding.
 */
export const IDENTITY_SINCE = 5;

/**
 * The numeric repository id the hub already knows for a project.
 *
 * READ FROM `project_identity`, not from `task`. Both are written at admission
 * from the snapshot `resolveSnapshot` took through the API client, so either is
 * a value GitHub gave us rather than one derived from a name -- but only one of
 * them is a table the GUARDIAN may read. `task` is the builder's work table and
 * is deliberately absent from the guest allowlist, so reading it here forced the
 * id to reach the guardian through a privileged handle opened in the CLI. The
 * identity table is the id and nothing else, and the guardian reads it directly.
 *
 * MATCHED ON THE REGISTRY PROJECT KEY, not on the nwo, and the table is keyed on
 * it for the same reason. An earlier version of this lookup keyed on
 * `nwo_snapshot` while its own comment said a repository can be renamed and that
 * column is only ever a snapshot -- so the moment a repository was renamed or
 * transferred, `projects.json` supplied the new name, every existing task still
 * carried the old one, and the lookup returned null for a repository whose
 * numeric id the hub was holding all along.
 *
 * ONE ROW PER PROJECT, so there is no longer an ordering to get right. The
 * previous version took the most recently updated task, and the writer preserves
 * that meaning: a changed id updates the row, because the newest admission is
 * the one that saw the current repository.
 *
 * Returns null for a project the hub has never admitted a task for. That is a
 * real state in S2 -- a registered project with no work yet -- and it is not an
 * error.
 *
 * A QUERY FAILURE IS NOT THAT STATE, and the catch that swallowed it said the
 * two were the same. A structurally damaged hub -- a version-1 file whose `task`
 * table is gone, which still passes `quick_check` because the pages it does have
 * are intact -- reported "no repository id" on every tick, so gate state aged
 * into staleness while the tick reported a clean pass over a skipped project.
 * The one failure a diagnostic must never render as a benign absence. It
 * propagates, and `build run` already turns a throwing tick into a reported
 * failure that keeps the lease.
 */
export function repoIdFromHub(hub, project) {
  if (!hub || !project?.name) return null;
  return hub.prepare(
    `SELECT repo_id FROM project_identity WHERE project = ?`)
    .get(project.name)?.repo_id ?? null;
}

/**
 * The same answer from a hub that PREDATES the identity table.
 *
 * A guardian can legitimately meet a hub no builder has migrated yet: this
 * lookup deliberately does not migrate a store out from under a running older
 * builder, so versions 1 to 4 are an ordinary state and not a fault. Without
 * this, `no such table: project_identity` propagated on every tick and the
 * guardian refused every dispatch for as long as the builder stayed old.
 *
 * This is the query the lookup used before migration 5, kept for exactly the
 * window it applies to. It reads `task`, which the guardian's GUEST connection
 * may not -- so on a pre-v5 hub the guardian resolves only through a connection
 * that can, and the refusal it gets otherwise is the honest answer rather than a
 * silent null. The window closes the first time the builder migrates.
 */
export function legacyRepoIdFromHub(hub, project) {
  if (!hub || !project?.name) return null;
  return hub.prepare(
    `SELECT repo_id FROM task WHERE project = ? ORDER BY updated_at DESC, id DESC LIMIT 1`)
    .get(project.name)?.repo_id ?? null;
}

/**
 * The repository id for a project: the hub first, then GitHub.
 *
 * THREE OUTCOMES, and they are not two. A number is an id reeve knows. `null`
 * is "no id is known", which is an ordinary state -- a registered project the
 * hub has never admitted a task for, with no fallback wired. A THROW is "reeve
 * could not look", which every caller must treat differently from `null`: one
 * means there is nothing to key a row on, the other means the store is damaged.
 * `repoIdFromHub` propagates its query failures for exactly this reason, and
 * this function must not catch them into the benign answer.
 *
 * The fallback is INJECTED rather than imported. This module is under
 * `src/build/` because that is where raw SQL is allowed to live; reaching a
 * network client from here would make a SQL module a network module. The caller
 * that has an API client passes one, and a caller with none gets the hub's
 * answer or nothing -- which is the builder's situation today and is correct
 * there.
 *
 * NOT CACHED HERE. A durable cache needs a table the hub does not have, and
 * inventing one is a migration this change does not need: the hub learns the id
 * the moment a task is admitted for the project, so the fallback covers only the
 * window before there is any work. Callers that want to avoid re-asking within
 * that window hold the answer for their own process lifetime.
 */
export async function resolveRepoId(hub, project, { fetchRepoId = null, fromHub = repoIdFromHub } = {}) {
  // THE HUB READER IS INJECTABLE so the pre-migration path can reuse the rules
  // below rather than restate them. A caller that has already established the
  // hub cannot answer -- because the table it reads does not exist at that
  // schema version -- still needs the GitHub fallback and, more importantly,
  // still needs the refusal of a fabricated id. Two copies of that refusal is
  // one copy too many for a value every authority-bearing row is keyed on.
  const known = fromHub(hub, project);
  if (known != null) return known;
  if (!fetchRepoId || !project?.nwo) return null;
  const got = await fetchRepoId(project.nwo);
  // A FABRICATED ID IS WORSE THAN NONE. Every row this keys is
  // authority-bearing, and a non-integer that reached `provider_lease` or
  // `pr_hold` would scope a lease or a hold to a repository that does not exist
  // -- so a fallback that answers with something unusable answers with nothing.
  return Number.isInteger(got) && got > 0 ? got : null;
}

/**
 * The repository id for a project, given the hub's PATH rather than a handle.
 *
 * THE CATCH IS THE POINT, and it is why this exists at all. `resolveRepoId` has
 * three outcomes and the caller that opened the connection is the one that has
 * to keep them apart -- so every such caller re-decides, from memory, which
 * failures are the ordinary "no id known" and which are "reeve could not look".
 * The CLI kept that decision inside its own `catch`, where the only assertion
 * available was a regex over the CLI's own source text: the narrowing that
 * turned every `no such table` into the benign answer READ as covered and was
 * never exercised. Stubbing it out broke nothing. The decision lives here now,
 * where a hub can be built in either state and asked.
 *
 * ONLY AN UNMIGRATED HUB IS BENIGN, and the error kind alone does not say that.
 * `task` is created by migration 1, so `no such table` on a store that records
 * NO completed migration is a hub that has simply never been built -- an
 * ordinary state on a machine with no builder. The same error on a store that
 * records one is a hub that HAD the table and lost it, which is damage. Reading
 * the second as the first suppresses `guardian:hub:unreadable` and leaves
 * dispatch fail-closed under "the repository numeric id is unknown", which
 * describes a healthy empty machine and not a corrupt authority database.
 *
 * NOT `openHub`. `openHub` MIGRATES -- it applies every pending migration before
 * answering -- and this path holds no builder singleton lease, so a newer
 * guardian restarting beside an older running builder would upgrade the schema
 * underneath it. A lookup must never be a schema change.
 */
export async function resolveRepoIdAt(hubPath, project, {
  fetchRepoId = null,
  connect = openForLookup,
  versionAt = completedVersion,
  statAt = statSync,
} = {}) {
  if (!project || !hubPath) return null;
  // ABSENT, OR UNREACHABLE? The caller used to answer this with `existsSync`,
  // which is false for EACCES, ELOOP and every other stat failure as well as for
  // ENOENT -- so a hub whose directory lost its permissions read as a machine
  // that simply has no builder, and the guardian sat fail-closed on every
  // dispatch under "the repository numeric id is unknown" with nothing saying
  // the store could not be reached. Only ENOENT is genuinely absent; the rest is
  // a fault and propagates, exactly as a damaged store does below.
  try {
    statAt(hubPath);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  let db = null;
  try {
    db = connect(hubPath);
    return await resolveRepoId(db, project, { fetchRepoId });
  } catch (err) {
    if (!/no such table/i.test(err?.message ?? "")) throw err;
    const v = versionAt(hubPath);
    // A store with no completed migration is a machine with no builder on it.
    if (v < 1) return null;
    // A store BELOW the identity migration is an ordinary state too, and a
    // different one: the hub is real, it holds the id, and the table this
    // lookup prefers does not exist yet. Answering null here would refuse every
    // dispatch for as long as the builder stayed old; throwing would do the same
    // and call it a fault. Neither is true, so ask the older question.
    if (v < IDENTITY_SINCE && db) {
      const legacy = legacyRepoIdFromHub(db, project);
      if (legacy != null) return legacy;
      // Still nothing, and the id may yet be gettable from GitHub -- the same
      // fallback a v5 hub with no identity row gets, for the same reason.
      return fetchRepoId ? await resolveRepoId(db, project, { fetchRepoId, fromHub: () => null }) : null;
    }
    throw err;
  } finally {
    try { db?.close(); } catch {}
  }
}

/**
 * How a lookup opens the hub: read-only, and waiting the SHARED contention
 * budget rather than SQLite's default of zero.
 *
 * Exported as a value so the two facts have one home. On a timeout of zero this
 * connection fails the instant a migration or a restore holds the lock, and the
 * caller then waits its whole retry cadence before asking again -- ten minutes
 * of fail-closed dispatch bought by a moment's contention.
 */
export const HUB_LOOKUP_OPEN = Object.freeze({ readOnly: true, timeout: HUB_BUSY_TIMEOUT_MS });

const openForLookup = (path) => new DatabaseSync(path, HUB_LOOKUP_OPEN);
