// paths — where a project's state and dashboard live.
//
// These were derived inline from `nwo.split("/")[1]`, the SHORT repository name,
// in three separate places. So `owner-a/api` and `owner-b/api` shared one database
// and one dashboard: two projects writing each other's runs, settlement, fix
// attempts and escalations into the same rows, with the second one's dashboard
// overwriting the first's.
//
// Nothing would have errored. Two repositories sharing a store simply answer
// questions about the wrong one, quietly — and serving many projects is this
// system's stated primary requirement, so a key that cannot tell two of them apart
// contradicts the whole point.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A repository name made safe to put in a path.
 *
 * A repository name arrives from a git remote or a command line and is not a
 * path component until it has been made one. `..` in either half would otherwise
 * walk out of the state directory entirely.
 */
const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "-");

const parts = nwo => {
  const [owner, repo] = String(nwo).split("/");
  return [safe(owner ?? "unknown"), safe(repo ?? "unknown")];
};

/** The state database for one repository. */
export function statePathFor(home, nwo) {
  const [owner, repo] = parts(nwo);
  return join(home, "state", owner, `${repo}.db`);
}

/** The dashboard for one repository. */
export function dashPathFor(home, nwo) {
  const [owner, repo] = parts(nwo);
  return join(home, "dash", owner, `${repo}.html`);
}

/**
 * Where the store used to live, so an existing one can be found and moved.
 *
 * Without this reeve would open a brand-new empty database at the new path and
 * carry on, which is how a thousand events of real programme history stop being
 * read with nothing appearing to fail.
 */
export function legacyStatePathFor(home, nwo) {
  const [, repo] = parts(nwo);
  return join(home, "state", `${repo}.db`);
}

/** Likewise for the dashboard, which sat directly in the reeve home. */
export function legacyDashPathFor(home, nwo) {
  const [, repo] = parts(nwo);
  return join(home, `${repo}.html`);
}

/**
 * The hub store: one file for the whole builder, not one per repository.
 *
 * Every other store here is per-repo because a repository is what the guardian
 * watches. The hub is the opposite by design -- a task spans projects, a lease
 * is global, and the provider scheduler exists precisely to arbitrate between
 * repositories. Keying it by nwo would make each of those unaskable.
 */
export function hubPathFor(home) {
  return join(home, "state", "hub.db");
}

/**
 * The artifact each report phase produces. ONE declaration, exported, because
 * the phase-to-filename map is a fact about the design's per-action table and a
 * second copy in the artifact store would be a second inventory to drift from.
 */
export const ARTIFACT_FILE = Object.freeze({
  SIZING: "sizing.json", RESEARCH: "research.md", DESIGN: "design.md",
});

/**
 * One task's tree.
 *
 * The id is sanitised for the same reason a repository name is: it arrives from
 * a command line, and a separator in it would walk out of the home. `safe`
 * replaces every character outside [A-Za-z0-9._-], which includes both kinds of
 * separator, so whatever comes back is a SINGLE path segment and cannot
 * traverse. It may still contain a literal `..` -- `../../etc` becomes
 * `--..-etc` -- and that is harmless for exactly that reason: a segment is not a
 * path. Asserting the absence of the two characters would be testing a proxy;
 * what matters, and what the test asserts, is that the resolved path stays
 * inside the tasks directory.
 *
 * `bt:<ulid>` is [0-9A-Z] apart from its colon, so the substitution is injective
 * over real ids and two tasks can never share a directory.
 */
export function taskPathFor(home, taskId) {
  return join(home, "tasks", safe(taskId));
}

/** Where a report phase's artifact lands, durable before its transition. */
export function artifactPathFor(home, taskId, phase) {
  const name = ARTIFACT_FILE[phase];
  if (!name) throw new Error(`${phase} produces no artifact; its product is a diff, reviewed by reviewDiff`);
  return join(taskPathFor(home, taskId), "artifacts", name);
}

/**
 * A run's durable output. Every field is required: a run file that omits the
 * attempt overwrites the previous attempt's transcript, which is how a measured
 * comparison lost two of its three runs.
 */
export function runPathFor(home, taskId, { generation, phase, slice, attempt, stream }) {
  if (![generation, slice, attempt].every(Number.isInteger) || !phase || !stream)
    throw new Error("a run path needs generation, phase, slice, attempt and stream; none is optional");
  // EVERY COMPONENT IS A SEGMENT, not just the task id. The id was sanitised and
  // the rest were only checked for presence, so a phase or stream carrying a
  // separator escaped the task tree entirely -- `phase: "x/../../../../escape"`
  // resolved to a file directly under the reeve home. Same defect as the one
  // `safe` exists to prevent, in the same function, on the arguments beside it.
  //
  // These THROW rather than being sanitised. A task id arrives from a command
  // line and a person can typo it; a phase and a stream are chosen by this
  // codebase, so a separator in one is a wiring error, and quietly rewriting it
  // would hide the bug and produce a file nobody can find by name.
  for (const [name, value] of [["phase", phase], ["stream", stream]])
    if (String(value) !== safe(value))
      throw new Error(`a run path's ${name} must be a single path segment; ` +
                      `${JSON.stringify(String(value))} is not, and would place the file outside the task's tree`);
  return join(taskPathFor(home, taskId), "runs", `g${generation}-${phase}-s${slice}-a${attempt}.${stream}`);
}

/**
 * Move a store from its legacy path into place, once, and return the path to use.
 *
 * A store at the old short-name path is moved rather than abandoned: opening a
 * fresh empty database beside it is how real history stops being read without
 * anything appearing to fail.
 */
export function adoptLegacyStore(next, legacy, { log = (m) => console.error(`reeve: ${m}`), rename = renameSync } = {}) {
  try {
    if (!existsSync(next) && existsSync(legacy)) {
      mkdirSync(dirname(next), { recursive: true });
      // The main file LAST. Every reader takes it for "the store exists", so
      // moving it first and stopping before the -wal left a canonical store
      // without its newest committed writes, stranded in a WAL at the old path.
      // With the sidecars first, a stop anywhere leaves no main file at the new
      // path, and the next run finishes the move.
      const moved = [];
      try {
        for (const suffix of ["-wal", "-shm", ""]) {
          if (existsSync(legacy + suffix)) { rename(legacy + suffix, next + suffix); moved.push(suffix); }
        }
      } catch (e) {
        // Put back what moved, so the store isn't split across two paths.
        const stranded = moved.reverse().filter((suffix) => { try { rename(next + suffix, legacy + suffix); return false; } catch { return true; } });
        if (stranded.length) throw new Error(`${e.message}; and ${stranded.map((s) => next + s).join(", ")} could not be moved back`);
        throw e;
      }
      log(`moved ${legacy} -> ${next}`);
    }
  } catch (e) { log(`could not move the legacy store (${e.message}); using ${legacy}`); return legacy; }
  return next;
}

/**
 * What a command says when a repository has no state database. The step that
 * creates one is named only for the default path: init creates the store there,
 * not wherever --db points. init reads the repository from the directory it
 * runs in, so the step names the checkout to run it from.
 */
export function missingStoreMessage(dbPath, { initCreatesIt = true, nwo = null } = {}) {
  if (!initCreatesIt) return `no state database at ${dbPath}`;
  return `no state database at ${dbPath}\n-> reeve init --write   creates it, run inside ${nwo ? `a checkout of ${nwo}` : "the repository's checkout"}`;
}
