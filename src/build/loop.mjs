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
// MOVED OUT, because C4 is the change that makes it shared. The guardian needs
// the same repository id this tick needs, and a resolver used by two lanes that
// lives in one lane's tick file is a shared module by accident -- nobody decides
// it and nobody documents it. The identity rule is unchanged: one resolver,
// keyed on the project.
import { resolveRepoId as resolveRepoIdShared } from "./repoid.mjs";


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
          resolveRepoId = resolveRepoIdShared, isAlive = isSameProcess } = ctx;
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
    // AWAITED, so the builder and the guardian run the SAME policy rather than
    // two that agree today. The builder wires no GitHub client, so the fallback
    // is simply unavailable here and the answer is the hub's or none -- but it
    // is the same function deciding that, not a second one that happens to.
    const repoId = project?.repoId ?? await resolveRepoId(hub, project);
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
