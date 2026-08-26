// loop -- the builder tick, importable.
//
// `bin/reeve`'s `build run` calls this between heartbeats. It lives in its own
// module so the wiring can be tested without spawning a daemon: `build run` is a
// heartbeat loop, and invoking it from a test starts one.
//
// S2's tick does exactly ONE thing: refresh `repo_gate_state` for every registry
// project. The phase work that fills it out is S4's, and no task in S2
// dispatches a builder worker.
import { refreshGateState } from "./gatestate.mjs";
// REAL LIVENESS FOR THE DAEMON PATH. `refreshGateState` defaults `isAlive` to
// `() => true`, which is right for a pure unit test and wrong for `build run`: a
// maintenance lock left behind by a crashed restore then reads as live for ever,
// every refresh throws, the daemon catches the tick failure and continues, and no
// gate-state row is written again until some unrelated writer happens to reap it.
// The tick is a long-running process on the machine that holds the lock, so it is
// exactly the caller that CAN answer the question.
import { isSameProcess } from "../supervisor.mjs";

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
 * One pass of the builder loop.
 *
 * `fetchGateState` defaults to a function returning null, which
 * `gateStateFrom` turns into an `unknown` row -- the correct reading of "reeve
 * has not looked", and the only configuration that actually ships in S2. An
 * implementation that called `ctx.fetchGateState` blindly would throw on every
 * real tick, where no live GitHub client is wired.
 */
export async function buildTick(ctx = {}) {
  const { hub, projects = [], fetchGateState = () => null,
          resolveRepoId = repoIdFromHub, isAlive = isSameProcess } = ctx;
  const skipped = [];
  const rows = [];
  for (const project of projects) {
    // NO REPO ID, NO ROW. `repo_gate_state` is keyed on the numeric repository
    // id and the column is NOT NULL, while the registry file records only a name
    // and an `owner/repo` -- so the id has to come from somewhere before this
    // tick can write anything at all.
    //
    // AND IT DID NOT. `registryProjects` returns exactly `{name, nwo}`, so in the
    // real `build run` path every registered project arrived here with no
    // `repoId` and was skipped on every single iteration: the wiring existed, the
    // tick ran, and not one gate-state row was ever written for a real project.
    // A guard whose condition is unconditionally true in production is not a
    // guard, it is an off switch.
    //
    // So the hub is asked first. It is the honest local authority: it holds the
    // numeric id for every project it has admitted a task for, recorded at
    // admission from the API client's own snapshot. A project it has never seen
    // still has no id, and skipping THAT is the right answer -- there is no row
    // to key, and inventing one would put a fabricated identity in front of the
    // clause that reads it.
    const repoId = project?.repoId ?? resolveRepoId(hub, project);
    if (repoId == null) { skipped.push(project?.name ?? "(unnamed)"); continue; }
    // One project's failure is not the tick's. A fetcher that throws for one
    // repository must not stop the others being refreshed -- and
    // `refreshGateState` already turns a throw into an `unknown` row carrying
    // why, so there is nothing here to catch that it does not.
    rows.push(await refreshGateState(hub, { ...project, repoId }, fetchGateState, { isAlive }));
  }
  // `skipped` is RETURNED rather than swallowed. A tick that silently refreshed
  // nothing is indistinguishable from one that refreshed everything, and the
  // caller is the only place that can say whether an empty pass is expected.
  return { refreshed: rows.length, rows, skipped };
}
