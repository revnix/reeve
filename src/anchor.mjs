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
// the first that makes its baseline under it: another store of the repository
// never extends one, as it could sign a number the first had taken.
//
// A store's identity is copied with it, so the anchor keeps more than numbers
// (#279, #281): the record each pull request's top entry names, and a seal of
// the whole entry, so a copy that signed another entry under the same number
// isn't current; an entry reserved whole before the store commits it, so a
// reeve that stops in between can't leave a number free for a copy to take;
// each record kept and not yet ordered, so one taken away while no reeve runs
// still shows; and a binding begun, with the records of the store's first
// baseline, so a store stripped between its baseline and its binding isn't
// given a baseline again.

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { canonical } from "./db/ops.mjs";
import { writeAll, syncFolder, running, baselineFingerprint, entrySeal } from "./signing.mjs";

/** The anchors' folder in the credentials folder: a file per repository, under its owner. */
export const ANCHOR_DIR = "signing-anchors";

/**
 * @typedef {{ n: number, digest: string, records: string[], seq: number | null }} Reserved
 * @typedef {{ began: boolean, latest: Map<number, number>, store: string | null,
 *             named: Map<number, string>, sealed: Map<number, string>, reserved: Map<number, Reserved>,
 *             pinned: Map<number, Set<string>>, pending: { store: string, baseline: string, digests: string[] } | null }} Anchor
 *   `latest`: each pull request's highest entry noted; `named`: the record that
 *   entry names, where the anchor was told, and `sealed` the entry's seal;
 *   `reserved`: an entry reserved and not yet noted, whole but for its
 *   repository and store, which are the anchor's; `pinned`: records kept and no
 *   entry names yet; `pending`: a binding begun and not yet made, with the
 *   records of the baseline it was begun with, and their fingerprint.
 */

const DIGEST = /^[0-9a-f]{64}$/;
const STORE = /^[0-9a-f]{32}$/;
const PR = /^[1-9]\d*$/;
/** Digests, each once, sorted, as the anchor writes them. @param {unknown} ds */
const digestList = (ds) => Array.isArray(ds) && ds.every((d, i) => typeof d === "string" && DIGEST.test(d) && (i === 0 || ds[i - 1] < d));
/** An object keyed by pull request number, or none at all. @param {unknown} o */
const byPr = (o) => o == null ? [] : typeof o === "object" && !Array.isArray(o) ? Object.entries(/** @type {object} */ (o)) : null;

/**
 * Where the host's anchor for `repo` is kept, in the credentials folder `dir`.
 * GitHub's names don't tell case apart, so neither does this.
 * @param {string} dir @param {string} repo  owner/name
 */
export function anchorPath(dir, repo) {
  const [owner, name, ...rest] = String(repo).toLowerCase().split("/");
  // A repository's name may start with a dot, as `.github` does, and an owner's
  // may not; neither is ever `.` or `..`, which would lead out of the folder.
  if (rest.length || !/^[\w.-]+$/.test(owner ?? "") || !/^[\w.-]+$/.test(name ?? "") || owner.startsWith(".") || name === "." || name === "..")
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
  const notOne = () => new Error(`the host's anchor for ${repo} can't be read: it isn't an anchor`);
  const latest = a?.latest;
  if (typeof a?.began !== "boolean" || !latest || typeof latest !== "object" || Array.isArray(latest)
      || Object.entries(latest).some(([pr, n]) => !PR.test(pr) || !Number.isInteger(n) || n < 1)
      || !(a.store == null || (typeof a.store === "string" && STORE.test(a.store))))
    throw notOne();
  // What #279 and #281 added, absent from an anchor written before them.
  const named = byPr(a.named), sealed = byPr(a.sealed), reserved = byPr(a.reserved), pinned = byPr(a.pinned);
  if (!named || !sealed || !reserved || !pinned) throw notOne();
  // The record an entry names, only for an entry the anchor holds, and its seal
  // only with the record.
  if (named.some(([pr, d]) => !PR.test(pr) || !(pr in latest) || typeof d !== "string" || !DIGEST.test(d))) throw notOne();
  if (sealed.some(([pr, s]) => !PR.test(pr) || !(pr in (a.named ?? {})) || typeof s !== "string" || !DIGEST.test(s))) throw notOne();
  // Only the next entry is ever reserved, and only on an anchor bound to a
  // store, as an entry is that store's.
  if (reserved.some(([pr, r]) => !PR.test(pr) || typeof r?.digest !== "string" || !DIGEST.test(r.digest) || r.n !== (latest[pr] ?? 0) + 1
                                 || !(Array.isArray(r.records) && r.records.every((/** @type {unknown} */ d) => typeof d === "string" && DIGEST.test(d)))
                                 || !(r.seq === null || (Number.isSafeInteger(r.seq) && r.seq > 0)) || a.store == null)) throw notOne();
  if (pinned.some(([pr, ds]) => !PR.test(pr) || !Array.isArray(ds) || !ds.length || ds.some((d) => typeof d !== "string" || !DIGEST.test(d)) || new Set(ds).size !== ds.length)) throw notOne();
  const pending = a.pending ?? null;
  if (pending !== null && (typeof pending?.store !== "string" || !STORE.test(pending.store) || typeof pending?.baseline !== "string" || !DIGEST.test(pending.baseline)
                           || !digestList(pending.digests) || baselineFingerprint(pending.digests) !== pending.baseline
                           || a.store != null)) throw notOne();
  return { began: a.began, latest: new Map(Object.entries(latest).map(([pr, n]) => [Number(pr), Number(n)])), store: a.store ?? null,
           named: new Map(named.map(([pr, d]) => [Number(pr), String(d)])),
           sealed: new Map(sealed.map(([pr, s]) => [Number(pr), String(s)])),
           reserved: new Map(reserved.map(([pr, r]) => [Number(pr), { n: Number(r.n), digest: String(r.digest), records: r.records.map(String), seq: r.seq === null ? null : Number(r.seq) }])),
           pinned: new Map(pinned.map(([pr, ds]) => [Number(pr), new Set(/** @type {string[]} */ (ds))])),
           pending: pending && { store: String(pending.store), baseline: String(pending.baseline), digests: pending.digests.map(String) } };
}

/** An anchor that holds nothing yet. @returns {Anchor} */
export const noAnchor = () => ({ began: false, latest: new Map(), store: null, named: new Map(), sealed: new Map(), reserved: new Map(), pinned: new Map(), pending: null });

/**
 * The seal of the entry reserved as `r` for pull request `pr`, on `repo`'s anchor
 * bound to `store`: the entry the store commits for it, as `entrySeal` seals it.
 * @param {string} repo @param {string | null} store @param {number} pr @param {Reserved} r
 */
export const reservedSeal = (repo, store, pr, r) => entrySeal({ repo, pr, n: r.n, digest: r.digest, records: r.records, store, seq: r.seq });

/** Numbers keyed by pull request, as the anchor writes them. @template T @param {Map<number, T>} m @param {(v: T) => unknown} [f] */
const written = (m, f = (v) => v) => Object.fromEntries([...m].map(([pr, v]) => [String(pr), f(v)]));

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
 * Make `folder` and the folders on the way to it, and owe a sync to the folder
 * that holds each one made: a name made in a folder outlasts a power loss only
 * once that folder is synced, and the one holding the highest folder made, a
 * home made here say, is synced by nothing else.
 * @param {string} folder @param {(dir: string) => void} owe
 */
function makeFolders(folder, owe) {
  const made = mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (made) for (let d = resolve(folder); d !== dirname(d); d = dirname(d)) { owe(dirname(d)); if (d === resolve(made)) break; }
}

/**
 * The host's lock on `repo`'s anchor, in the credentials folder `dir`: SQLite's
 * exclusive lock on a file beside the anchor, which the operating system holds
 * for the process and drops when it ends, however it ends. `why` when it
 * couldn't be taken, and `busy` when that's because another process holds it.
 * @param {string} dir @param {string} repo
 * @param {(dir: string) => void} [owe]  given each folder owed a sync for one made on the way: synced here unless given
 * @returns {{ release: () => void } | { why: string, busy: boolean }}
 */
export function anchorLock(dir, repo, owe = syncFolder) {
  /** @type {DatabaseSync | null} */ let lock = null;
  try {
    const path = anchorPath(dir, repo);
    // Checked before anything is made on the way, so nothing is made through a
    // link, and again once it's there.
    unlinked(dir, path);
    makeFolders(dirname(path), owe);
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
 * `began(repo, id)` says the repository's store began signing, where the anchor
 * is store `id`'s, `bind(repo, id)` that it's store `id`'s, where it's no store's
 * yet, and that it began signing, as only a store that has is bound, and
 * `note(repo, pr, n)`
 * that entry `n` of a pull request's signed order was kept. Each only moves the
 * anchor forward, and answers whether it holds that now, durably: false when it
 * couldn't be read, written or synced, which leaves it as it was, or not yet
 * sure to outlast a power loss, until a later call.
 * @param {string} dir
 * @param {{ write?: (fd: number, buf: Buffer, offset: number, length: number) => number, syncDir?: (dir: string) => void }} [o]
 *        `write` and `syncDir` as `signingKey` takes them: a test's faults
 */
export function fileAnchor(dir, { write = (fd, buf, offset, length) => writeSync(fd, buf, offset, length), syncDir = syncFolder } = {}) {
  // The folders owed a sync for one made on the way to an anchor, by its lock or
  // a write: synced on every write until they hold, as a sync that failed, or one
  // never made, would otherwise leave that folder to be lost to a power loss.
  /** @type {Set<string>} */ const owed = new Set();
  const owe = (/** @type {string} */ f) => { owed.add(f); };
  /** @param {string} repo @param {(a: Anchor) => boolean} change  true when it changed the anchor */
  const update = (repo, change) => {
    try {
      const path = anchorPath(dir, repo);
      const folder = dirname(path);
      const a = readAnchor(dir, repo) ?? noAnchor();
      if (change(a)) {
        makeFolders(folder, owe);
        reap(folder);
        const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        try {
          const fd = openSync(temp, "wx", 0o600);
          try {
            writeAll(fd, canonical({ began: a.began, latest: written(a.latest), store: a.store, named: written(a.named), sealed: written(a.sealed),
                                     reserved: written(a.reserved), pinned: written(a.pinned, (ds) => [...ds].sort()), pending: a.pending }), write);
            fsyncSync(fd);
          } finally { closeSync(fd); }
          renameSync(temp, path);
        } finally { try { unlinkSync(temp); } catch { /* renamed, or gone */ } }
      }
      // Changed or not: a sync that failed after its rename leaves the anchor
      // saying it, and only syncing again makes it outlast a power loss. Its own
      // folder holds its name, and each folder above, to the one that holds the
      // credentials folder, holds the name of the one below, made here perhaps.
      for (const f of owed) syncDir(f);
      owed.clear();
      if (existsSync(folder)) for (const f of [folder, dirname(folder), resolve(dir), dirname(resolve(dir))]) syncDir(f);
      return true;
    } catch { return false; }
  };
  return {
    /** The anchor for `repo`, as `readAnchor` reads it. @param {string} repo */
    read: (repo) => readAnchor(dir, repo),
    /** The host's lock on `repo`'s anchor, as `anchorLock` takes it. @param {string} repo */
    lock: (repo) => anchorLock(dir, repo, owe),
    /** Only where the anchor is bound to store `id`: said by a store it isn't, it would be said of the one it is. @param {string} repo @param {string | null} id */
    began: (repo, id) => update(repo, (a) => (a.began || !id || a.store !== id ? false : ((a.began = true), true))),
    /**
     * Said with the binding that the store began: a reeve stopped between it and
     * its first note would otherwise leave the anchor bound to a store it doesn't
     * say began, and that store, stripped while it's down, given a baseline again.
     * @param {string} repo @param {string} id
     */
    bind: (repo, id) => update(repo, (a) => {
      if (a.store === id) return false;
      if (a.store) throw new Error(`the host's anchor for ${repo} is another store's`);
      // A binding begun is finished only for the store it was begun for.
      if (a.pending && a.pending.store !== id) throw new Error(`the host's anchor for ${repo} is being bound to another store`);
      a.store = id;
      a.began = true;
      a.pending = null;
      return true;
    }),
    /**
     * A binding begun for store `id`, with the records of the baseline it's
     * about to commit (#281): written before the store commits it, so a reeve
     * that stops before binding leaves the anchor saying which store, holding
     * which records, it was binding. Where the anchor is bound, or a binding of
     * another store, or of other records, was begun, it isn't written over.
     * @param {string} repo @param {string} id @param {string[]} digests
     */
    pending: (repo, id, digests) => update(repo, (a) => {
      const sorted = [...new Set(digests.map(String))].sort();
      if (!STORE.test(String(id)) || sorted.some((d) => !DIGEST.test(d))) throw new Error("not a store's identity and the records of a baseline");
      if (a.store) throw new Error(a.store === id ? `the host's anchor for ${repo} is bound already` : `the host's anchor for ${repo} is another store's`);
      const baseline = baselineFingerprint(sorted);
      if (a.pending) {
        if (a.pending.store !== id) throw new Error(`the host's anchor for ${repo} is being bound to another store`);
        if (a.pending.baseline === baseline) return false;
        throw new Error(`the host's anchor for ${repo} is being bound to this store with another baseline`);
      }
      a.pending = { store: id, baseline, digests: sorted };
      return true;
    }),
    /**
     * Entry `n` of a pull request's order reserved on the anchor bound to store
     * `id`, before the store commits it (#279), whole: naming record `digest` as
     * latest, and `records` besides, seen at `seq`. Only the next entry, and
     * one reserved stays reserved for that entry until it's noted: a copy of
     * the store can't take the number for another, however alike. Never on an
     * anchor no store's: an entry is a store's, and written there, the anchor
     * couldn't be read back.
     * @param {string} repo @param {string} id @param {number} pr @param {number} n @param {string} digest
     * @param {string[]} [records] @param {number | null} [seq]
     */
    reserve: (repo, id, pr, n, digest, records = [], seq = null) => update(repo, (a) => {
      if (!(Number.isSafeInteger(pr) && pr >= 1 && Number.isSafeInteger(n) && n >= 1) || !DIGEST.test(String(digest))
          || records.some((d) => !DIGEST.test(String(d))) || !(seq === null || (Number.isSafeInteger(seq) && seq > 0)))
        throw new Error(`#${pr}, entry ${n}, isn't an entry of a pull request's order`);
      if (!a.store || a.store !== id) throw new Error(`the host's anchor for ${repo} isn't this store's`);
      if (n !== (a.latest.get(pr) ?? 0) + 1) throw new Error(`entry ${n} isn't the next of #${pr}'s order on the host's anchor`);
      /** @type {Reserved} */ const entry = { n, digest: String(digest), records: [...new Set(records.map(String))].sort(), seq };
      const r = a.reserved.get(pr);
      if (r) {
        if (reservedSeal(repo, id, pr, r) === reservedSeal(repo, id, pr, entry)) return false;
        throw new Error(`entry ${r.n} of #${pr}'s order is reserved for another ${r.digest === entry.digest ? "entry" : "record"}`);
      }
      a.reserved.set(pr, entry);
      return true;
    }),
    /**
     * Records kept for a pull request and not yet named by an entry, pinned on
     * the anchor bound to store `id` (#279): one taken away while no reeve runs
     * shows, though the reeve that kept it stopped before ordering it.
     * @param {string} repo @param {string} id @param {number} pr @param {string[]} digests
     */
    pin: (repo, id, pr, digests) => update(repo, (a) => {
      if (!(Number.isSafeInteger(pr) && pr >= 1) || digests.some((d) => !DIGEST.test(String(d)))) throw new Error(`#${pr}'s records aren't records`);
      if (a.store !== id) throw new Error(`the host's anchor for ${repo} isn't this store's`);
      const pins = a.pinned.get(pr) ?? new Set();
      const was = pins.size;
      for (const d of digests) pins.add(d);
      if (pins.size === was) return false;
      a.pinned.set(pr, pins);
      return true;
    }),
    /**
     * Records unpinned from the anchor bound to store `id`, as a commit that
     * failed never kept them (#279).
     * @param {string} repo @param {string} id @param {number} pr @param {string[]} digests
     */
    unpin: (repo, id, pr, digests) => update(repo, (a) => {
      if (a.store !== id) throw new Error(`the host's anchor for ${repo} isn't this store's`);
      const pins = a.pinned.get(pr);
      if (!pins) return false;
      let changed = false;
      for (const d of digests) if (pins.delete(d)) changed = true;
      if (!pins.size) a.pinned.delete(pr);
      return changed;
    }),
    /**
     * Only what the anchor reads back, a pull request's number and an entry's,
     * each a whole number from 1: written otherwise, it couldn't be read, and
     * would vouch for nothing again. With `digest`, the record the entry names
     * as latest (#279), with `seal` the entry's seal, and with `names`, every
     * record it names, which are pinned no longer. It clears the entry's
     * reservation.
     * @param {string} repo @param {number} pr @param {number} n @param {string | null} [digest] @param {string[]} [names] @param {string | null} [seal]
     */
    note: (repo, pr, n, digest = null, names = [], seal = null) => update(repo, (a) => {
      if (!(Number.isSafeInteger(pr) && pr >= 1 && Number.isSafeInteger(n) && n >= 1)) throw new Error(`#${pr}, entry ${n}, isn't an entry of a pull request's order`);
      if (digest !== null && !DIGEST.test(String(digest))) throw new Error(`entry ${n} of #${pr}'s order names no record`);
      if (seal !== null && (!digest || !DIGEST.test(String(seal)))) throw new Error(`entry ${n} of #${pr}'s order has no seal`);
      const was = a.latest.get(pr) ?? 0;
      const r = a.reserved.get(pr);
      // A reserved number is noted only for the entry it was reserved for.
      if (r && r.n === n && digest && (r.digest !== digest || (seal && seal !== reservedSeal(repo, a.store, pr, r))))
        throw new Error(`entry ${n} of #${pr}'s order is reserved for another ${r.digest === digest ? "entry" : "record"}`);
      let changed = false;
      if (was < n) {
        a.latest.set(pr, n);
        a.began = true;
        if (digest) a.named.set(pr, digest); else a.named.delete(pr);
        if (seal) a.sealed.set(pr, seal); else a.sealed.delete(pr);
        changed = true;
      } else if (was === n && digest) {
        // The same entry noted again: an anchor written before #279 learns its
        // record and seal, and one that holds another is never written over.
        const held = a.named.get(pr), heldSeal = a.sealed.get(pr);
        if (held && held !== digest) throw new Error(`entry ${n} of #${pr}'s order names another record on the host's anchor`);
        if (seal && heldSeal && heldSeal !== seal) throw new Error(`entry ${n} of #${pr}'s order is another entry on the host's anchor`);
        if (!held) { a.named.set(pr, digest); changed = true; }
        if (seal && !heldSeal) { a.sealed.set(pr, seal); changed = true; }
      }
      if (r && r.n <= (a.latest.get(pr) ?? 0)) { a.reserved.delete(pr); changed = true; }
      const pins = a.pinned.get(pr);
      if (pins) {
        for (const d of names) if (pins.delete(d)) changed = true;
        if (!pins.size) a.pinned.delete(pr);
      }
      return changed;
    }),
  };
}
