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
// place, with the file, its folder and any folder made for it synced, so a
// power loss leaves the last whole anchor, never part of one. One that can't be
// read is never read as none, and never written over: it might have said more.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { canonical } from "./db/ops.mjs";
import { writeAll, syncFolder } from "./signing.mjs";

/** The anchors' folder in the credentials folder: a file per repository, under its owner. */
export const ANCHOR_DIR = "signing-anchors";

/** @typedef {{ began: boolean, latest: Map<number, number> }} Anchor */

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
    // A pipe or a device there would hold the read up for ever.
    if (!statSync(path).isFile()) throw new Error("it isn't a file");
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw new Error(`the host's anchor for ${repo} can't be read: ${/** @type {Error} */ (err).message}`);
  }
  let a;
  try { a = JSON.parse(text); } catch { throw new Error(`the host's anchor for ${repo} can't be read: it isn't JSON`); }
  const latest = a?.latest;
  if (typeof a?.began !== "boolean" || !latest || typeof latest !== "object" || Array.isArray(latest)
      || Object.entries(latest).some(([pr, n]) => !/^[1-9]\d*$/.test(pr) || !Number.isInteger(n) || n < 1))
    throw new Error(`the host's anchor for ${repo} can't be read: it isn't an anchor`);
  return { began: a.began, latest: new Map(Object.entries(latest).map(([pr, n]) => [Number(pr), Number(n)])) };
}

/**
 * The daemon's writer of the host's anchors, in the credentials folder `dir`.
 * `began(repo)` says the repository's store began signing, and `note(repo, pr, n)`
 * that entry `n` of a pull request's signed order was kept. Each only moves the
 * anchor forward, and answers whether it holds that now: false when it couldn't
 * be read or written, which leaves it as it was, behind until a later tick.
 * @param {string} dir
 * @param {{ write?: (fd: number, buf: Buffer, offset: number, length: number) => number, syncDir?: (dir: string) => void }} [o]
 *        `write` and `syncDir` as `signingKey` takes them: a test's faults
 */
export function fileAnchor(dir, { write = (fd, buf, offset, length) => writeSync(fd, buf, offset, length), syncDir = syncFolder } = {}) {
  /** @param {string} repo @param {(a: Anchor) => boolean} change  true when it changed the anchor */
  const update = (repo, change) => {
    try {
      const a = readAnchor(dir, repo) ?? { began: false, latest: new Map() };
      if (!change(a)) return true;
      const path = anchorPath(dir, repo);
      const folder = dirname(path);
      // The folders synced once it's in place: its own, which holds its name, and
      // every folder made for it, each in the one that holds it.
      const folders = new Set([folder]);
      const made = mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (made) for (let d = resolve(folder); d !== dirname(d); d = dirname(d)) { folders.add(dirname(d)); if (d === resolve(made)) break; }
      const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        const fd = openSync(temp, "wx", 0o600);
        try {
          writeAll(fd, canonical({ began: a.began, latest: Object.fromEntries([...a.latest].map(([pr, n]) => [String(pr), n])) }), write);
          fsyncSync(fd);
        } finally { closeSync(fd); }
        renameSync(temp, path);
      } finally { try { unlinkSync(temp); } catch { /* renamed, or gone */ } }
      for (const f of folders) syncDir(f);
      return true;
    } catch { return false; }
  };
  return {
    /** The anchor for `repo`, as `readAnchor` reads it. @param {string} repo */
    read: (repo) => readAnchor(dir, repo),
    /** @param {string} repo */
    began: (repo) => update(repo, (a) => (a.began ? false : ((a.began = true), true))),
    /** @param {string} repo @param {number} pr @param {number} n */
    note: (repo, pr, n) => update(repo, (a) => {
      if ((a.latest.get(pr) ?? 0) >= n) return false;
      a.latest.set(pr, n);
      a.began = true;
      return true;
    }),
  };
}
