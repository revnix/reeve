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

/**
 * The numeric repository id the hub already knows for a project.
 *
 * `task.repo_id` is written at admission from the snapshot `resolveSnapshot`
 * took through the API client, so it is a value GitHub gave us rather than one
 * derived from a name.
 *
 * MATCHED ON THE REGISTRY PROJECT KEY, not on the nwo. The first version keyed
 * on `nwo_snapshot` while its own comment said a repository can be renamed and
 * that column is only ever a snapshot -- so the moment a repository was renamed
 * or transferred, `projects.json` supplied the new name, every existing task
 * still carried the old one, and the lookup returned null for a repository whose
 * numeric id the hub was holding all along. The project key is what does not
 * move: `task.project` IS the registry key, written at admission from the same
 * `projects.json` entry this lookup is resolving.
 *
 * The most recently updated task wins, so if an id ever did change, the newest
 * admission is the one that saw the current repository.
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
export async function resolveRepoId(hub, project, { fetchRepoId = null } = {}) {
  const known = repoIdFromHub(hub, project);
  if (known != null) return known;
  if (!fetchRepoId || !project?.nwo) return null;
  const got = await fetchRepoId(project.nwo);
  // A FABRICATED ID IS WORSE THAN NONE. Every row this keys is
  // authority-bearing, and a non-integer that reached `provider_lease` or
  // `pr_hold` would scope a lease or a hold to a repository that does not exist
  // -- so a fallback that answers with something unusable answers with nothing.
  return Number.isInteger(got) && got > 0 ? got : null;
}
