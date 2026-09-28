// @ts-check
// The host's anchor (#274): what the host running reeve signed last, kept beside
// its signing key, outside every store.
//
// A signature covers one record. It doesn't say which record is a pull request's
// latest, or that a record the store no longer holds was ever kept: whoever can
// change a store can take its newest records away, or restore an older copy, and
// every record left still checks. So each change of a pull request's latest
// decision is a numbered, signed entry of an order, and the host keeps, per
// repository, whether its store began signing and each pull request's highest
// entry. A store whose order ends below that, or that no longer shows it began
// signing, was cut short or restored from before.
//
// It lives in the credentials folder, which no worker may read or write, a file
// per repository, so one repository's daemon never writes over another's. It
// only moves forward. It's written whole to a file of its own and renamed into
// place, with the file and the folders that hold it synced every time it's
// written or found already there, so a power loss leaves the last whole anchor,
// never part of one, and a sync that failed is made again. One that can't be
// read is never read as none, and never written over: it might have said more.
// Nor is one read or written through a link, or with another name: what that
// leads to may lie outside the folder that's kept from workers.
//
// One daemon at a time extends a repository's signed order and notes it here:
// each holds the host's lock on the repository's anchor across reading it,
// extending the order and noting it. And the anchor is one store's, bound to
// the first that extends an order under it: another store of the repository
// never extends one, as it could sign a number the first had taken.

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { canonical } from "./db/ops.mjs";
import { writeAll, syncFolder, running } from "./signing.mjs";

/** The anchors' folder in the credentials folder: a file per repository, under its owner. */
export const ANCHOR_DIR = "signing-anchors";

/** @typedef {{ began: boolean, latest: Map<number, number>, store: string | null }} Anchor */

/**
 * Where the host's anchor for `repo` is kept, in the credentials folder `dir`.
 * GitHub's names don't tell case apart, so neither does this.
 * @param {string} dir @param {string} repo  owner/name
 */
export function anchorPath(dir, repo) {
  const [owner, name, ...rest] = String(repo).toLowerCase().split("/");
  if (rest.length || !/^[\w.-]+$/.test(owner ?? "") || !/^[\w.-]+$/.test(name ?? "") || owner.startsWith(".") || name.startsWith("."))
    throw new Error(`not a repository: ${JSON.stringify(repo)}`);
  return join(dir, ANCHOR_DIR, owner, `${name}.json`);
}

/**
 * The host's anchor for `repo`: null when it has none. Throws when it can't be
 * read, or doesn't read as an anchor: never taken for none, which would vouch
 * for a store cut short.
 * @param {string} dir  the credentials folder
 * @param {string} repo
 * @returns {Anchor | null}
 */
export function readAnchor(dir, repo) {
  const path = anchorPath(dir, repo);
  let text;
  try {
    unlinked(dir, path);
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw new Error(`the host's anchor for ${repo} can't be read: ${/** @type {Error} */ (err).message}`);
  }
  let a;
  try { a = JSON.parse(text); } catch { throw new Error(`the host's anchor for ${repo} can't be read: it isn't JSON`); }
  const latest = a?.latest;
  if (typeof a?.began !== "boolean" || !latest || typeof latest !== "object" || Array.isArray(latest)
      || Object.entries(latest).some(([pr, n]) => !/^[1-9]\d*$/.test(pr) || !Number.isInteger(n) || n < 1)
      || !(a.store == null || (typeof a.store === "string" && /^[0-9a-f]{32}$/.test(a.store))))
    throw new Error(`the host's anchor for ${repo} can't be read: it isn't an anchor`);
  return { began: a.began, latest: new Map(Object.entries(latest).map(([pr, n]) => [Number(pr), Number(n)])), store: a.store ?? null };
}

/**
 * Throws unless the way to the anchor at `path` is the credentials folder's own:
 * the anchors' folder and its owner's a folder, not a link, and the anchor a
 * file of its own, not a link, with no other name, and not a pipe, whose read
 * would wait for ever. What a link leads to, or another name for the file, may
 * lie outside the folder that's kept from workers. A part not there yet passes,
 * and is made here as it should be.
 * @param {string} dir @param {string} path
 */
function unlinked(dir, path) {
  for (const p of [join(dir, ANCHOR_DIR), dirname(path), path]) {
    let st;
    try { st = lstatSync(p); }
    catch (err) { if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return; throw err; }
    if (st.isSymbolicLink()) throw new Error(`${p} is a link`);
    if (p !== path && !st.isDirectory()) throw new Error(`${p} isn't a folder`);
    if (p === path && !st.isFile()) throw new Error("it isn't a file");
    if (p === path && st.nlink > 1) throw new Error(`it has another name besides ${p}`);
  }
}

/**
 * The host's lock on `repo`'s anchor, in the credentials folder `dir`: SQLite's
 * exclusive lock on a file beside the anchor, which the operating system holds
 * for the process and drops when it ends, however it ends. `why` when it
 * couldn't be taken, and `busy` when that's because another process holds it.
 * @param {string} dir @param {string} repo
 * @returns {{ release: () => void } | { why: string, busy: boolean }}
 */
export function anchorLock(dir, repo) {
  /** @type {DatabaseSync | null} */ let lock = null;
  try {
    const path = anchorPath(dir, repo);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    unlinked(dir, path);
    const lockPath = `${path}.lock`;
    let st = null;
    try { st = lstatSync(lockPath); } catch { /* made here */ }
    if (st && !st.isFile()) throw new Error(`${lockPath} isn't a file of its own`);
    lock = new DatabaseSync(lockPath, { timeout: 0 });
    // Nothing is ever written to it, so its journal stays in memory.
    lock.exec("PRAGMA journal_mode=MEMORY");
    lock.exec("BEGIN EXCLUSIVE");
    const held = lock;
    return { release: () => { try { held.exec("ROLLBACK"); } catch { /* nothing to undo */ } try { held.close(); } catch { /* closed */ } } };
  } catch (err) {
    try { lock?.close(); } catch { /* never opened */ }
    return { why: /** @type {Error} */ (err).message, busy: /** @type {any} */ (err).errcode === 5 };
  }
}

/**
 * Remove the temporaries a process killed partway left beside the anchors in
 * `folder`: each is named for the process that made it, and one whose process
 * is gone is never finished. A running process's is its own, still being
 * written, and is left.
 * @param {string} folder
 */
function reap(folder) {
  let names = [];
  try { names = readdirSync(folder); } catch { return; }
  for (const n of names) {
    const m = /^[\w.-]+\.json\.(\d+)\.[0-9a-f]{8}\.tmp$/.exec(n);
    if (!m || running(Number(m[1]))) continue;
    try { unlinkSync(join(folder, n)); } catch { /* gone already, or not this user's to remove */ }
  }
}

/**
 * The daemon's writer of the host's anchors, in the credentials folder `dir`.
 * `began(repo)` says the repository's store began signing, `bind(repo, id)` that
 * the anchor is store `id`'s, where it's no store's yet, and `note(repo, pr, n)`
 * that entry `n` of a pull request's signed order was kept. Each only moves the
 * anchor forward, and answers whether it holds that now, durably: false when it
 * couldn't be read, written or synced, which leaves it as it was, or not yet
 * sure to outlast a power loss, until a later call.
 * @param {string} dir
 * @param {{ write?: (fd: number, buf: Buffer, offset: number, length: number) => number, syncDir?: (dir: string) => void }} [o]
 *        `write` and `syncDir` as `signingKey` takes them: a test's faults
 */
export function fileAnchor(dir, { write = (fd, buf, offset, length) => writeSync(fd, buf, offset, length), syncDir = syncFolder } = {}) {
  /** @param {string} repo @param {(a: Anchor) => boolean} change  true when it changed the anchor */
  const update = (repo, change) => {
    try {
      const path = anchorPath(dir, repo);
      const folder = dirname(path);
      const a = readAnchor(dir, repo) ?? { began: false, latest: new Map(), store: null };
      if (change(a)) {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        reap(folder);
        const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        try {
          const fd = openSync(temp, "wx", 0o600);
          try {
            writeAll(fd, canonical({ began: a.began, latest: Object.fromEntries([...a.latest].map(([pr, n]) => [String(pr), n])), store: a.store }), write);
            fsyncSync(fd);
          } finally { closeSync(fd); }
          renameSync(temp, path);
        } finally { try { unlinkSync(temp); } catch { /* renamed, or gone */ } }
      }
      // Changed or not: a sync that failed after its rename leaves the anchor
      // saying it, and only syncing again makes it outlast a power loss. Its own
      // folder holds its name, and each folder above, to the one that holds the
      // credentials folder, holds the name of the one below, made here perhaps.
      if (existsSync(folder)) for (const f of [folder, dirname(folder), resolve(dir), dirname(resolve(dir))]) syncDir(f);
      return true;
    } catch { return false; }
  };
  return {
    /** The anchor for `repo`, as `readAnchor` reads it. @param {string} repo */
    read: (repo) => readAnchor(dir, repo),
    /** The host's lock on `repo`'s anchor, as `anchorLock` takes it. @param {string} repo */
    lock: (repo) => anchorLock(dir, repo),
    /** @param {string} repo */
    began: (repo) => update(repo, (a) => (a.began ? false : ((a.began = true), true))),
    /** @param {string} repo @param {string} id */
    bind: (repo, id) => update(repo, (a) => {
      if (a.store === id) return false;
      if (a.store) throw new Error(`the host's anchor for ${repo} is another store's`);
      a.store = id;
      return true;
    }),
    /** @param {string} repo @param {number} pr @param {number} n */
    note: (repo, pr, n) => update(repo, (a) => {
      if ((a.latest.get(pr) ?? 0) >= n) return false;
      a.latest.set(pr, n);
      a.began = true;
      return true;
    }),
  };
}
