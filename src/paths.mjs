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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { storeLock } from "./db/ops.mjs";
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

/**
 * A name, every character but a letter, a digit, `-` and `_` written as its
 * percent code: one name for each, which no two share and none walks out of the
 * folder, as `.github` and `-github` would share `safe`'s.
 */
const exact = s => encodeURIComponent(String(s)).replace(/[.!~*'()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * A repository's owner or name as one segment of a store's or a dashboard's
 * path (#310): kept as it is where `safe` would keep it, letters, digits, `.`,
 * `_` and `-` with no dot first, and percent-coded as `exact` codes it where
 * not. One name for each: one kept holds no `%`, and one coded always does. So
 * `.github` and `-github`, which `safe` made alike, are kept apart, and a store
 * already at its path for any other name stays where it is.
 */
const named = s => (/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(String(s)) ? String(s) : exact(s));
/** The name a path's segment was made from by `named`: one that holds no `%` is as it is. */
const unnamed = s => { if (!s.includes("%")) return s; try { return decodeURIComponent(s); } catch { return s; } };

/** The owner and name a store's or a dashboard's path is made of. */
const segments = nwo => {
  const [owner, repo] = String(nwo).split("/");
  return [named(owner ?? "unknown"), named(repo ?? "unknown")];
};

/** The state database for one repository. */
export function statePathFor(home, nwo) {
  const [owner, repo] = segments(nwo);
  return join(home, "state", owner, `${repo}.db`);
}

/**
 * The repository a store at `state/<owner>/<file>` is of: its owner's folder
 * and its file named as `statePathFor` names them, the `.db` taken off. Given
 * its `path`, one an earlier reeve kept where names were made alike (#310), not
 * moved yet, is the repository whose decision records it holds, every one.
 */
export function storeRepo(owner, file, path = null) {
  const nwo = `${unnamed(owner)}/${unnamed(String(file).replace(/\.db$/, ""))}`;
  if (path == null || !nwo.split("/")[1].startsWith("-")) return nwo;
  const o = ownerOf(path, nwo);
  if (o.is !== "others" || o.mixed || o.others.length !== 1) return nwo;
  const [so, sr] = parts(o.others[0]);
  return so === owner && `${sr}.db` === file ? o.others[0] : nwo;
}

/**
 * Where a person's audits of one repository's shadow trial are kept (#294),
 * under its owner's and its own names exactly: an audit of another repository
 * found there makes this one's unreadable.
 */
export function auditDirFor(home, nwo) {
  const [owner, repo] = String(nwo).split("/");
  return join(home, "audits", exact(owner ?? ""), exact(repo ?? ""));
}

/** The dashboard for one repository. */
export function dashPathFor(home, nwo) {
  const [owner, repo] = segments(nwo);
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

/** Where a store was kept before #310: owner and name made safe, `.github`'s and `-github`'s alike. */
const sharedStatePath = (home, nwo) => { const [owner, repo] = parts(nwo); return join(home, "state", owner, `${repo}.db`); };

/**
 * Whose the store at `path` is, by the decision records it holds (#310):
 * `mine` where every one, and at least one, is of `nwo`; `none` where it holds
 * none; `unread` where it, or one of them, can't be read; otherwise `others`,
 * the other repositories they're of, `mixed` where some are of `nwo` too.
 * @param {string} path @param {string} nwo
 * @returns {{ is: "mine" | "none" | "unread" } | { is: "others", others: string[], mixed: boolean }}
 */
function ownerOf(path, nwo) {
  const repos = reposIn(path);
  if (repos === null || repos.includes(null)) return { is: "unread" };
  if (!repos.length) return { is: "none" };
  const others = /** @type {string[]} */ (repos.filter(r => r !== nwo));
  return others.length ? { is: "others", others, mixed: others.length < repos.length } : { is: "mine" };
}

/**
 * The repositories the decision records of the store at `path` are of, null
 * for one that can't be read, or null where the store can't be. Read without
 * leaving anything beside it: a store closed whole, with no log beside it, is
 * read as it is on disk, as a read-only reader of it would otherwise leave a
 * log and its index there; one with its log is read with it, as nothing new
 * is made.
 * @param {string} path @returns {(string | null)[] | null}
 */
function reposIn(path) {
  let db = null;
  try {
    db = existsSync(`${path}-wal`) ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
    return db.prepare(`SELECT DISTINCT CASE WHEN json_valid(record) THEN json_extract(record, '$.subject.repo') END AS repo FROM decision`).all()
      .map(r => (typeof r.repo === "string" ? r.repo : null));
  } catch { return null; }
  finally { try { db?.close(); } catch { /* never opened */ } }
}

/**
 * Where `nwo`'s store is, where an earlier reeve kept it, to be moved into
 * place, and why it can't be used, if it can't (#310). Before #310 an owner and
 * name were made safe for the path, and names that made alike, `.github` and
 * `-github`, shared a store there:
 * - one there is `.github`'s only where every decision record it holds, and at
 *   least one, is of `.github`; one only of others is theirs, and the store
 *   under the name alone, from before stores were kept by owner, is looked for
 *   as before; one whose owner can't be told, holding none, both, or one that
 *   can't be read, is refused rather than taken for none;
 * - one at `-github`'s path, which is its own, is refused where a record it
 *   holds is another's, or can't be read.
 * @param {string} home @param {string} nwo
 * @returns {{ path: string, earlier: string, refused: string | null }}
 */
export function storeLookup(home, nwo) {
  const path = statePathFor(home, nwo), shared = sharedStatePath(home, nwo);
  const legacy = legacyStatePathFor(home, nwo);
  const [, repo] = String(nwo).split("/");
  if (existsSync(path)) {
    if (!String(repo ?? "").startsWith("-")) return { path, earlier: legacy, refused: null };
    const o = ownerOf(path, nwo);
    if (o.is === "unread") return { path, earlier: legacy, refused: `the store at ${path} holds a decision record that can't be read, so whether it's ${nwo}'s or one whose name a path made alike to it can't be told` };
    if (o.is !== "others") return { path, earlier: legacy, refused: null };
    return { path, earlier: legacy, refused: o.mixed
      ? `the store at ${path} holds the decision records of ${nwo} and of ${o.others.join(", ")}, which an earlier reeve kept in one store: neither can use it until it's split by hand`
      : `the store at ${path} holds decision records of ${o.others.join(", ")}, not ${nwo}: an earlier reeve kept the stores of names a path made alike in one place. Run reeve once for ${o.others[0]} to move its store to its own path, then run this again` };
  }
  if (shared === path || !existsSync(shared)) return { path, earlier: legacy, refused: null };
  const o = ownerOf(shared, nwo);
  if (o.is === "mine") return { path, earlier: shared, refused: null };
  if (o.is === "others" && !o.mixed) return { path, earlier: legacy, refused: null };
  return { path, earlier: legacy, refused: `an earlier reeve kept a store at ${shared}, where names a path made alike shared one, and ${
    o.is === "none" ? "it holds no decision record" : o.is === "unread" ? "a decision record it holds can't be read" : `it holds the decision records of ${nwo} and of ${o.others.join(", ")}`
  }, so whether it's ${nwo}'s can't be told: move it to ${path} by hand if it is` };
}

/** Where an earlier reeve kept the store for `nwo`, for it to be moved into place, as `storeLookup` finds it. */
export function earlierStorePath(home, nwo) {
  return storeLookup(home, nwo).earlier;
}

/**
 * The store for `nwo`, moved into place from where an earlier reeve kept it,
 * as `adoptLegacyStore` moves it, and the path to use (#310). Throws, with
 * `code` STORE_REFUSED, where `storeLookup` refuses it. Moved from where names
 * were made alike only while no reeve runs on it there, STORE_BUSY otherwise:
 * one would go on writing it under its old name while another started on it
 * under its new one. A dashboard of this repository left at that path's is
 * taken away, whenever it's found there.
 */
export function adoptStore(home, nwo, opts = {}) {
  const found = storeLookup(home, nwo);
  if (found.refused) throw storeError("STORE_REFUSED", found.refused);
  let used;
  if (found.earlier !== sharedStatePath(home, nwo)) used = adoptLegacyStore(found.path, found.earlier, opts);
  else {
    const lock = storeLock(found.earlier);
    if ("why" in lock) throw storeError(lock.busy ? "STORE_BUSY" : "STORE_REFUSED", lock.busy
      ? `a reeve is running on ${found.earlier}, ${nwo}'s store before #310: stop it before the store moves to ${found.path}`
      : `the lock on ${found.earlier} couldn't be taken, so ${nwo}'s store isn't moved from there: ${lock.why}`);
    try { used = adoptLegacyStore(found.path, found.earlier, opts); } finally { lock.release(); }
  }
  retireSharedDash(home, nwo);
  return used;
}

/**
 * Takes away this repository's dashboard left where names were made alike, at
 * a path that's another's now (#310): one whose title names it. Where it can't
 * be, it's tried again the next time.
 * @param {string} home @param {string} nwo
 */
function retireSharedDash(home, nwo) {
  const [owner, repo] = parts(nwo);
  const shared = join(home, "dash", owner, `${repo}.html`);
  if (shared === dashPathFor(home, nwo)) return;
  try { if (readFileSync(shared, "utf8").includes(`<title>${nwo} — fleet</title>`)) rmSync(shared, { force: true }); }
  catch { /* not there, or taken away the next time */ }
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
  const lockPath = moveLockPath(next);
  if (existsSync(next)) { clearMoveLock(next); return next; }
  if (!existsSync(legacy)) return next;
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
  let lock = null;
  try {
    mkdirSync(dirname(next), { recursive: true });
    lock = new DatabaseSync(lockPath, { timeout: timeoutMs });
    // Nothing is ever written to it, so its journal stays in memory. On disk,
    // a holder killed while holding the lock left a journal beside it for good.
    lock.exec("PRAGMA journal_mode=MEMORY");
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

const moveLockPath = (next) => `${next}.move-lock`;

/**
 * Remove the move lock a mover killed after its last rename left beside a store
 * that is now in place; nothing else looks for it once the store is there. Safe
 * only once the main file is at `next`, because the main file moves last: a
 * process still waiting on the lock then finds the store moved and moves
 * nothing.
 */
export function clearMoveLock(next) {
  try { rmSync(moveLockPath(next), { force: true }); } catch { /* left for a later run */ }
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
