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

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
 *
 * Throws, with `code` STORE_BUSY or STORE_SPLIT, when neither path is safe to
 * use: another process is still moving the store, or a move stopped with the
 * store's files split between the two paths.
 */
export function adoptLegacyStore(next, legacy, { log = (m) => console.error(`reeve: ${m}`), rename = renameSync,
                                                  timeoutMs = 10_000 } = {}) {
  if (existsSync(next) || !existsSync(legacy)) return next;
  // One process moves at a time. Two commands started together, the daemon and
  // a status check say, each saw the main file missing and moved sidecars in the
  // other's way, and a rollback could strand the WAL. The holder of the lock
  // beside the new path moves; another waits for it and uses what it made.
  //
  // The lock is SQLite's exclusive lock on that file, which the operating system
  // holds for the process and drops when the process ends, however it ends. A
  // lock file naming its holder's pid came first, and every reading of it had a
  // race: read before the pid was written, a live holder looked dead and lost
  // its lock; a dead holder's pid, reused, held the store for ever; and two
  // processes taking over one dead lock could each delete the other's.
  const lockPath = `${next}.move-lock`;
  let lock = null;
  try {
    mkdirSync(dirname(next), { recursive: true });
    lock = new DatabaseSync(lockPath, { timeout: timeoutMs });
    lock.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    try { lock?.close(); } catch { /* never opened */ }
    if (existsSync(next)) return next;   // the holder finished while this one waited
    if (e.errcode === SQLITE_BUSY)
      throw storeError("STORE_BUSY", `the state store at ${legacy} is being moved to ${next} by another process; try again once it finishes`);
    // A move that can't start leaves the legacy store where it was, and it is
    // used there, unless an earlier move left some of it at the new path.
    return whole(next, legacy, `could not move the legacy store (${e.message})`, log);
  }
  try {
    if (existsSync(next) || !existsSync(legacy)) return next;   // moved while this one waited
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
      for (const suffix of moved.reverse()) try { rename(next + suffix, legacy + suffix); } catch { /* found by whole() */ }
      return whole(next, legacy, `could not move the legacy store (${e.message})`, log);
    }
    log(`moved ${legacy} -> ${next}`);
    // Removed only once the move is done. A process still waiting on it then
    // finds the store moved, and every later one returns before looking for a
    // lock. Removed after a failure, a waiter and a newcomer could each hold a
    // lock on a different file, and move at once.
    try { rmSync(lockPath, { force: true }); } catch { /* left for the next move */ }
    return next;
  } finally {
    try { lock.exec("ROLLBACK"); } catch { /* nothing to undo */ }
    lock.close();
  }
}

const SQLITE_BUSY = 5;
const storeError = (code, message) => Object.assign(new Error(message), { code });

/**
 * The legacy path, if the store is whole there. It isn't while any of its files
 * sit at the new path, whether this run's rollback failed or an earlier run
 * stopped there: opened without its WAL, the legacy main file hides every
 * committed write still in it.
 */
function whole(next, legacy, why, log) {
  const split = ["-wal", "-shm"].filter((suffix) => existsSync(next + suffix));
  if (split.length)
    throw storeError("STORE_SPLIT", `${why}, and the state store is split: ${split.map((s) => next + s).join(" and ")} ` +
                                    `${split.length > 1 ? "belong" : "belongs"} with ${legacy}. Fix what stopped the move and run again to finish it`);
  log(`${why}; using ${legacy}`);
  return legacy;
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
