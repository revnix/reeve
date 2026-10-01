// @ts-check
// Signed decision records (#165).
//
// A decision record is kept under the digest of what it says, which catches a
// row changed by accident. It doesn't catch one rewritten on purpose: whoever
// changes a record can compute its digest again. So each new record is signed
// with an Ed25519 key only reeve's host holds, as a DSSE envelope over an in-toto
// statement of the record, and `why` and `replay` check the signature.
//
// The key is created the first time reeve signs, in the credentials folder,
// which no worker may read. Its public half is written beside it, and published
// in this repository under deploy/signing-keys/, named by its key id, so a record
// can be checked anywhere. A record whose signing failed is still kept, unsigned,
// with the reason: a verdict isn't lost because it couldn't be signed.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync,
         unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonical } from "./db/ops.mjs";
import { STATEMENT_TYPE } from "./evidence.mjs";

/** The DSSE payload type for an in-toto statement. */
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const DECISION_PREDICATE = "https://revnix.com/reeve/decision/v1";
/** The records a store held unsigned when it began signing. */
export const BASELINE_PREDICATE = "https://revnix.com/reeve/unsigned-baseline/v1";
/** An entry of a pull request's signed order of decisions (#274). */
export const LATEST_PREDICATE = "https://revnix.com/reeve/latest-decision/v1";
/** The private key's file in the credentials folder, and its public half's. */
export const KEY_FILE = "signing-ed25519.pem";
export const PUBLIC_FILE = "signing-ed25519.pub";

/** @typedef {import("node:crypto").KeyObject} KeyObject */
/** @typedef {{ payloadType: string, payload: string, signatures: { keyid: string, sig: string }[] }} Envelope */

/**
 * DSSE's pre-authentication encoding: what is signed, so a signature over one
 * payload type can't be read as one over another.
 * @param {string} type @param {Buffer} body
 */
export function pae(type, body) {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${body.length} `), body]);
}

/**
 * A public key's id: the sha256 of its DER encoding.
 * @param {KeyObject} publicKey
 */
export function keyIdOf(publicKey) {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

/**
 * The in-toto statement a decision record is signed as: its commit as the
 * subject, and the record with its digest as the predicate.
 * @param {{ digest: string, record: Record<string, any> }} decision
 */
export function decisionStatement({ digest, record }) {
  const s = record?.subject ?? {};
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: `${s.repo}#${s.pr}`, digest: s.tree ? { gitCommit: s.head, gitTree: s.tree } : { gitCommit: s.head } }],
    predicateType: DECISION_PREDICATE,
    predicate: { digest, record },
  };
}

/**
 * The records a store held unsigned when it began signing, as the statement
 * that vouches for them: signed once, so a record left unsigned later, or one
 * whose signature was stripped, isn't taken for one of them.
 * @param {string[]} digests
 */
export function baselineStatement(digests) {
  const sorted = [...new Set(digests)].sort();
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: "decision records kept before signing began", digest: { sha256: createHash("sha256").update(sorted.join("\n")).digest("hex") } }],
    predicateType: BASELINE_PREDICATE,
    predicate: { digests: sorted },
  };
}

/**
 * A baseline's fingerprint, as its statement names it: sha256 over the records
 * it names, sorted, one per line. The host's anchor holds it while it's being
 * bound to a store (#281).
 * @param {string[]} digests
 */
export const baselineFingerprint = (digests) => baselineStatement(digests).subject[0].digest.sha256;

/**
 * Entry `n` of a pull request's signed order of decisions (#274): the record that
 * became its latest decision then, numbered from 1, so which record is latest is
 * signed too, not read from the store's own order. With every other record kept
 * for the pull request since the entry before, or, for its first, before it, so
 * none of them can be taken away unseen; the store it's of, so an entry of
 * another store, another host's say, never passes for one of this store's; and
 * where in the store's sequence of events its latest was seen, as the reeve that
 * signed it saw it, so a reeve never signs a record it saw earlier over it.
 * @param {{ repo: string, pr: number, n: number, digest: string, records?: string[], store?: string | null, seq?: number | null }} entry
 */
export function latestStatement({ repo, pr, n, digest, records = [], store = null, seq = null }) {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: `${repo}#${pr}`, digest: { sha256: digest } }],
    predicateType: LATEST_PREDICATE,
    predicate: { repo, pr, n, digest, records: [...records].sort(), store, seq },
  };
}

/**
 * An entry's seal: sha256 over its statement, which holds all it says, its
 * repository without case, as GitHub's names don't tell case apart. The host's
 * anchor keeps it for the entry it noted last of a pull request's order (#279):
 * another entry under that number, naming the same record and other records,
 * doesn't pass for it.
 * @param {{ repo: string, pr: number, n: number, digest: string, records?: string[], store?: string | null, seq?: number | null }} entry
 */
export const entrySeal = (entry) =>
  createHash("sha256").update(canonical(latestStatement({ ...entry, repo: String(entry.repo).toLowerCase() }))).digest("hex");

/**
 * A chain over a pull request's order to entry `n` (#303): each entry's seal
 * taken in turn with the chain before it, from the first, so it changes with
 * any entry to `n`, not only the top. Entries name no entry before them, so a
 * copy holding another variant of an earlier entry, signed by the host's key,
 * would otherwise pass beneath a top the host noted. `seals` by entry number;
 * null where one to `n` is missing.
 * @param {Map<number, string>} seals @param {number} n @returns {string | null}
 */
export function orderChain(seals, n) {
  let chain = "";
  for (let i = 1; i <= n; i++) {
    const seal = seals.get(i);
    if (!seal) return null;
    chain = chainStep(chain, seal);
  }
  return n >= 1 ? chain : null;
}

/** The chain once an entry with `seal` follows one at `chain`, "" before the first. @param {string} chain @param {string} seal */
export const chainStep = (chain, seal) => createHash("sha256").update(canonical([chain, seal])).digest("hex");

/**
 * The signing key in `dir`, the credentials folder. With `create`, one is made
 * when there's none, readable only by its owner. It's written whole to a file of
 * its own first, then linked into place, which fails if a key is already there:
 * so a stop or a full disk partway never leaves part of a key at the key's path,
 * and two processes never write over each other's. A key others could read, or
 * that isn't Ed25519, is refused. The public half beside it is written again
 * whenever it's missing, unreadable, or another key's; `publicWhy` says why it
 * isn't, when it couldn't be. Before a key is handed out to sign, its folder is
 * synced, so the key outlasts a power loss that the records it signs outlast.
 * @param {string} dir
 * @param {{ create?: boolean, write?: (fd: number, buf: Buffer, offset: number, length: number) => number,
 *           syncDir?: (dir: string) => void }} [o]
 *        `write` writes part of a buffer, as `writeSync` does, and answers how much, and `syncDir` syncs
 *        a folder: a test's faults
 * @returns {{ ok: true, key: KeyObject, keyid: string, created: boolean, publicWhy: string | null }
 *         | { ok: false, why: string, missing?: boolean }}
 */
export function signingKey(dir, { create = false, write = (fd, buf, offset, length) => writeSync(fd, buf, offset, length),
                                  syncDir = syncFolder } = {}) {
  const path = join(dir, KEY_FILE);
  let created = false;
  // The folders synced before the key signs: its own, which holds its name, and
  // the one that holds the folder's, and so on up for every folder made here.
  const folders = new Set([resolve(dir), dirname(resolve(dir))]);
  try {
    if (create) reapTemporaries(dir);
    if (!existsSync(path)) {
      if (!create) return { ok: false, why: `there is no signing key at ${path}`, missing: true };
      const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (made) for (let d = resolve(dir); d !== dirname(d); d = dirname(d)) { folders.add(dirname(d)); if (d === resolve(made)) break; }
      const { privateKey } = generateKeyPairSync("ed25519");
      const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try {
        try { writeAll(fd, String(privateKey.export({ type: "pkcs8", format: "pem" })), write); fsyncSync(fd); } finally { closeSync(fd); }
        try { linkSync(temp, path); created = true; }
        catch (err) {
          // Another process made it first: that one is the key.
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
        }
      } finally { try { unlinkSync(temp); } catch { /* gone */ } }
    }
    // Only a file of its own: what a link points at, or another name for the
    // file, may lie outside what workers are kept from reading.
    const own = lstatSync(path);
    if (own.isSymbolicLink()) return { ok: false, why: `the signing key at ${path} is a link, so it isn't used: a worker could read what it points at` };
    // A pipe or a device there would hold a read up for ever, and every tick with it.
    if (!own.isFile()) return { ok: false, why: `the signing key at ${path} isn't a file, so it isn't used: reading it could wait for ever` };
    if (own.nlink > 1) return { ok: false, why: `the signing key at ${path} has another name besides this one, so it isn't used: a worker could read it there` };
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) return { ok: false, why: `the signing key at ${path} can be read by others (mode ${mode.toString(8)}), so it isn't used` };
    const key = createPrivateKey(readFileSync(path));
    if (key.asymmetricKeyType !== "ed25519") return { ok: false, why: `the signing key at ${path} isn't an Ed25519 key` };
    const pub = createPublicKey(key);
    const keyid = keyIdOf(pub);
    // A public half that can't be written now is written the next time; the key
    // signs either way, and its records check against the published copy. One
    // that's another key's, made before this one replaced it, is kept under its
    // own id first, as what still checks the records that key signed, and left
    // in its slot when it can't be.
    const pubPath = join(dir, PUBLIC_FILE);
    let publicWhy = null;
    if (publicIdAt(pubPath) !== keyid) {
      // A private key there by mistake is never read as a public key, but its
      // public half is kept too when it's another key's: written over, it would
      // be lost, and with it what that key signed.
      const old = publicKeyAt(pubPath) ?? derivedPublicAt(pubPath);
      publicWhy = old && keyIdOf(old) !== keyid ? keepReplaced(dir, pubPath, old, syncDir, write) : null;
      if (!publicWhy) {
        try { writePublic(dir, pub, write); }
        catch (err) { publicWhy = `its public half couldn't be written at ${pubPath}: ${/** @type {Error} */ (err).message}`; }
      }
    }
    // A record signed by a key whose file a power loss took could never be
    // checked, and the store keeps that record.
    if (create) {
      try { for (const f of folders) syncDir(f); }
      catch (err) {
        return { ok: false, why: `the signing key's folder ${dir} couldn't be synced, so the key might not outlast a power loss: ${/** @type {Error} */ (err).message}` };
      }
    }
    return { ok: true, key, keyid, created, publicWhy };
  } catch (err) {
    return { ok: false, why: `the signing key couldn't be read or made: ${/** @type {Error} */ (err).message}` };
  }
}

/**
 * All of `text`, however little each write takes: a short write is written on
 * from where it stopped, never taken for the whole.
 * @param {number} fd @param {string} text
 * @param {(fd: number, buf: Buffer, offset: number, length: number) => number} write
 */
export function writeAll(fd, text, write) {
  const buf = Buffer.from(text);
  for (let at = 0; at < buf.length;) {
    const n = write(fd, buf, at, buf.length - at);
    if (!(n > 0)) throw new Error(`a write took nothing, at byte ${at} of ${buf.length}`);
    at += n;
  }
}

/**
 * The Ed25519 public key in `path`, or null when there's none to read. A file
 * that holds a private key is never read as a public one: the key can be derived
 * from it, but a file meant to be published must never hold it.
 * @param {string} path
 */
function publicKeyAt(path) {
  try {
    const text = readFile(path);
    if (/PRIVATE KEY/.test(text)) return null;
    const key = createPublicKey(text);
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch { return null; }
}

/**
 * What the file at `path` holds. Anything that isn't a file, a pipe or a device,
 * is refused before it's opened: reading one could wait for ever.
 * @param {string} path
 */
function readFile(path) {
  if (!statSync(path).isFile()) throw new Error(`${path} isn't a file`);
  return readFileSync(path, "utf8");
}

/**
 * The public half of the Ed25519 private key in `path`, a file meant for a
 * public key that holds a private one by mistake, or null.
 * @param {string} path
 */
function derivedPublicAt(path) {
  try {
    const text = readFile(path);
    if (!/PRIVATE KEY/.test(text)) return null;
    const key = createPublicKey(createPrivateKey(text));
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch { return null; }
}

/** The key id of the public key in `path`, or null when there's none to read. @param {string} path */
function publicIdAt(path) {
  const key = publicKeyAt(path);
  return key ? keyIdOf(key) : null;
}

/** Where a replaced key's public half is kept, by its id. @param {string} keyid */
const archivedPublic = (keyid) => `signing-ed25519.${keyid}.pub`;

/**
 * Keep the public half in `pubPath`, key `old`'s, which this key replaced,
 * under that key's id, before its slot is written over. A copy already there
 * counts only if it's a file of its own holding that key: anything else there,
 * a link to the slot included, is never taken for it, or written over. It's
 * written from the key read, whole, to a file of its own and linked into place,
 * never as a second name for what the slot holds, which could be a link that
 * follows the slot; and the folder is synced, so it's kept before the slot
 * changes. Null once it's kept; otherwise why the slot is left as it is.
 * @param {string} dir @param {string} pubPath @param {KeyObject} old
 * @param {(dir: string) => void} syncDir
 * @param {(fd: number, buf: Buffer, offset: number, length: number) => number} write
 */
function keepReplaced(dir, pubPath, old, syncDir, write) {
  const oldId = keyIdOf(old);
  const archive = join(dir, archivedPublic(oldId));
  const said = `${pubPath} holds key ${oldId.slice(0, 12)}'s, which this key replaced`;
  try {
    if (!keptAt(archive, oldId)) {
      if (existsSync(archive)) return `${said}, and ${archive}, where it would be kept, holds something else: move that aside, and reeve keeps it there`;
      linkWhole(archive, String(old.export({ type: "spki", format: "pem" })), 0o644, write);
    }
    syncDir(dir);
    return null;
  } catch (err) {
    return `${said}, and it couldn't be kept at ${archive}: ${/** @type {Error} */ (err).message}`;
  }
}

/** Whether `path` is a file of its own, not a link, holding the public key `keyid`. @param {string} path @param {string} keyid */
function keptAt(path, keyid) {
  try { return lstatSync(path).isFile() && publicIdAt(path) === keyid; } catch { return false; }
}

/**
 * `text`, written whole to a file of its own and linked into place at `path`,
 * which fails if anything is there. Its own file is gone afterwards.
 * @param {string} path @param {string} text @param {number} mode
 * @param {(fd: number, buf: Buffer, offset: number, length: number) => number} write
 */
function linkWhole(path, text, mode, write) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx", mode);
    try { writeAll(fd, text, write); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temp, path);
  } finally { try { unlinkSync(temp); } catch { /* gone */ } }
}

/**
 * Remove the key files' temporaries that a process killed partway left in `dir`:
 * each is named for the process that made it, and one whose process is gone is
 * never finished. A private one holds a key, and one linked into place is a
 * second name for the key in use. One of a process still running is its own,
 * still being written, and is left.
 * @param {string} dir
 */
function reapTemporaries(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const m = /^signing-ed25519\.(?:[0-9a-f]{64}\.)?(?:pem|pub)\.(\d+)\.[0-9a-f]{8}\.tmp$/.exec(n);
    if (!m || running(Number(m[1]))) continue;
    try { unlinkSync(join(dir, n)); } catch { /* gone already, or not this user's to remove */ }
  }
}

/** Whether process `pid` is running. One that can't be signalled is, but isn't this user's. @param {number} pid */
export function running(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (err) { return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM"; }
}

/** Sync the folder `dir`, so the names made in it outlast a power loss. @param {string} dir */
export function syncFolder(dir) {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * The public half, written whole to a file of its own and renamed into place.
 * Its own file is gone afterwards, whatever failed.
 * @param {string} dir @param {KeyObject} publicKey
 * @param {(fd: number, buf: Buffer, offset: number, length: number) => number} write
 */
function writePublic(dir, publicKey, write) {
  const path = join(dir, PUBLIC_FILE);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o644);
    try { writeAll(fd, String(publicKey.export({ type: "spki", format: "pem" })), write); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch { /* renamed, or gone */ } }
}

/**
 * A signer over the key in `dir`, made on first use: it signs a statement, or
 * says why it couldn't.
 * @param {string} dir
 * @returns {(statement: Record<string, any>) => ({ envelope: string } | { unsigned: string }) & { created?: string }}
 */
export function fileSigner(dir) {
  return (statement) => {
    const k = signingKey(dir, { create: true });
    if ("why" in k) return { unsigned: k.why };
    const s = signStatement(statement, k);
    // The key made for this statement, named so the run can say so.
    return k.created ? { ...s, created: k.keyid } : s;
  };
}

/**
 * A decision record, signed.
 * @param {{ digest: string, record: Record<string, any> }} decision
 * @param {{ key: KeyObject, keyid: string }} k
 */
export function signDecision(decision, k) {
  return signStatement(decisionStatement(decision), k);
}

/**
 * A statement, signed, as a DSSE envelope.
 * @param {Record<string, any>} statement
 * @param {{ key: KeyObject, keyid: string }} k
 * @returns {{ envelope: string } | { unsigned: string }}
 */
export function signStatement(statement, { key, keyid }) {
  try {
    const payload = Buffer.from(canonical(statement));
    const sig = sign(null, pae(PAYLOAD_TYPE, payload), key);
    /** @type {Envelope} */
    const envelope = { payloadType: PAYLOAD_TYPE, payload: payload.toString("base64"), signatures: [{ keyid, sig: sig.toString("base64") }] };
    return { envelope: canonical(envelope) };
  } catch (err) {
    return { unsigned: `it couldn't be signed: ${/** @type {Error} */ (err).message}` };
  }
}

/**
 * The public keys a record may be signed by, by key id: those published in
 * `published` (deploy/signing-keys/ in the checkout reeve runs from) and this
 * host's own, from `local`, the credentials folder. A file that isn't an Ed25519
 * public key is skipped.
 * @param {{ published?: string | null, local?: string | null }} where
 * @returns {Map<string, { key: KeyObject, where: string, path: string }>}
 */
export function knownKeys({ published = null, local = null } = {}) {
  /** @type {Map<string, { key: KeyObject, where: string, path: string }>} */
  const keys = new Map();
  const add = (/** @type {string} */ path, /** @type {string} */ where) => {
    const key = publicKeyAt(path);
    if (key && !keys.has(keyIdOf(key))) keys.set(keyIdOf(key), { key, where, path });
  };
  if (published) {
    let names = [];
    try { names = readdirSync(published); } catch { /* none published */ }
    for (const n of names.filter(n => n.endsWith(".pub")).sort()) add(join(published, n), "published");
  }
  if (local) {
    add(join(local, PUBLIC_FILE), "this host's");
    // And the public halves of keys this host replaced, kept by their ids.
    let names = [];
    try { names = readdirSync(local); } catch { /* none */ }
    for (const n of names.filter((n) => /^signing-ed25519\.[0-9a-f]{64}\.pub$/.test(n)).sort()) add(join(local, n), "this host's, replaced");
  }
  return keys;
}

/**
 * @typedef {{ state: "signed", keyid: string, where: string }
 *         | { state: "unsigned", why: string }
 *         | { state: "corrupt", why: string }} Signature
 */

/**
 * Whether a decision row's signature holds: signed by a known key over exactly
 * this record, unsigned (kept before records were signed, or its signing failed),
 * or corrupt. An unsigned record is never read as signed, and a signature that
 * doesn't hold is never read as unsigned.
 * @param {{ digest: string, record: Record<string, any>, envelope?: string | null, unsigned?: string | null }} row
 * @param {Map<string, { key: KeyObject, where: string }>} keys
 * @returns {Signature}
 */
export function checkSignature(row, keys) {
  if (row.envelope == null) return { state: "unsigned", why: row.unsigned ?? "it was kept before records were signed" };
  return checkEnvelope(row.envelope, decisionStatement(row), keys, "record");
}

/**
 * Whether `envelope` signs exactly `statement`, by a known key. Anything that
 * doesn't hold, however it's malformed, is corrupt, never a throw.
 * @param {string} envelope
 * @param {Record<string, any>} statement
 * @param {Map<string, { key: KeyObject, where: string }>} keys
 * @param {string} what  what it's over, in words: "record", "baseline", "order"
 * @returns {Signature}
 */
export function checkEnvelope(envelope, statement, keys, what) {
  /** @type {Envelope} */
  let env;
  try { env = JSON.parse(envelope); } catch { return { state: "corrupt", why: "its signature can't be read" }; }
  if (env?.payloadType !== PAYLOAD_TYPE) return { state: "corrupt", why: `its signature is over a ${JSON.stringify(env?.payloadType)}, not a decision` };
  const payload = Buffer.from(String(env.payload ?? ""), "base64");
  if (payload.toString() !== canonical(statement))
    return { state: "corrupt", why: `its signature is over another ${what}` };
  const s = Array.isArray(env.signatures) ? env.signatures : [];
  if (!s.length) return { state: "corrupt", why: "its signature is missing from its envelope" };
  for (const entry of s) {
    if (!entry || typeof entry !== "object") return { state: "corrupt", why: "its envelope holds a signature that isn't one" };
    const k = keys.get(String(entry.keyid));
    if (!k) continue;
    let ok = false;
    try { ok = verify(null, pae(PAYLOAD_TYPE, payload), k.key, Buffer.from(String(entry.sig ?? ""), "base64")); } catch { ok = false; }
    return ok ? { state: "signed", keyid: String(entry.keyid), where: k.where } : { state: "corrupt", why: `its signature by key ${String(entry.keyid).slice(0, 12)} doesn't verify` };
  }
  return { state: "corrupt", why: `it's signed by a key reeve doesn't know (${s.map(x => String(x.keyid).slice(0, 12)).join(", ")})` };
}
