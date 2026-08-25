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
  const { hub, projects = [], fetchGateState = () => null } = ctx;
  const skipped = [];
  const rows = [];
  for (const project of projects) {
    // NO REPO ID, NO ROW. `repo_gate_state` is keyed on the numeric repository
    // id and the column is NOT NULL, and the registry file records only a name
    // and an `owner/repo`. The id is resolved by the API client S8 supplies, so
    // in S2 a registry entry legitimately has none -- and skipping it is the
    // honest answer: there is no row to key, and inventing one would put a
    // fabricated identity in front of the clause that reads it.
    if (project?.repoId == null) { skipped.push(project?.name ?? "(unnamed)"); continue; }
    // One project's failure is not the tick's. A fetcher that throws for one
    // repository must not stop the others being refreshed -- and
    // `refreshGateState` already turns a throw into an `unknown` row carrying
    // why, so there is nothing here to catch that it does not.
    rows.push(await refreshGateState(hub, project, fetchGateState));
  }
  // `skipped` is RETURNED rather than swallowed. A tick that silently refreshed
  // nothing is indistinguishable from one that refreshed everything, and the
  // caller is the only place that can say whether an empty pass is expected.
  return { refreshed: rows.length, rows, skipped };
}
