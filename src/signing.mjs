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
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync,
         unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./db/ops.mjs";
import { STATEMENT_TYPE } from "./evidence.mjs";

/** The DSSE payload type for an in-toto statement. */
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const DECISION_PREDICATE = "https://revnix.com/reeve/decision/v1";
/** The records a store held unsigned when it began signing, and each change of a pull request's latest decision. */
export const BASELINE_PREDICATE = "https://revnix.com/reeve/unsigned-baseline/v1";
export const LATEST_PREDICATE = "https://revnix.com/reeve/latest-decision/v1";
/** The private key's file in the credentials folder, and its public half's. */
export const KEY_FILE = "signing-ed25519.pem";
export const PUBLIC_FILE = "signing-ed25519.pub";
/** What the host signed last, kept beside the key, outside every store. */
export const ANCHOR_FILE = "signing-anchor.json";

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
 * A change of a pull request's latest decision, numbered from 1, so which one is
 * latest is signed too, not read from the store's own order.
 * @param {{ repo: string, pr: number, n: number, digest: string }} l
 */
export function latestStatement({ repo, pr, n, digest }) {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: `${repo}#${pr}`, digest: { sha256: digest } }],
    predicateType: LATEST_PREDICATE,
    predicate: { repo, pr, n, digest },
  };
}

/**
 * The signing key in `dir`, the credentials folder. With `create`, one is made
 * when there's none, readable only by its owner. It's written whole to a file of
 * its own first, then linked into place, which fails if a key is already there:
 * so a stop or a full disk partway never leaves part of a key at the key's path,
 * and two processes never write over each other's. A key others could read, or
 * that isn't Ed25519, is refused. The public half beside it is written again
 * whenever it's missing, unreadable, or another key's.
 * @param {string} dir
 * @param {{ create?: boolean, write?: (fd: number, text: string) => void }} [o]  `write` for a test's faults
 * @returns {{ ok: true, key: KeyObject, keyid: string, created: boolean } | { ok: false, why: string }}
 */
export function signingKey(dir, { create = false, write = (fd, text) => { writeSync(fd, text); } } = {}) {
  const path = join(dir, KEY_FILE);
  let created = false;
  try {
    if (!existsSync(path)) {
      if (!create) return { ok: false, why: `there is no signing key at ${path}` };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const { privateKey } = generateKeyPairSync("ed25519");
      const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try {
        try { write(fd, String(privateKey.export({ type: "pkcs8", format: "pem" }))); fsyncSync(fd); } finally { closeSync(fd); }
        try { linkSync(temp, path); created = true; }
        catch (err) {
          // Another process made it first: that one is the key.
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
        }
      } finally { try { unlinkSync(temp); } catch { /* gone */ } }
    }
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) return { ok: false, why: `the signing key at ${path} can be read by others (mode ${mode.toString(8)}), so it isn't used` };
    const key = createPrivateKey(readFileSync(path));
    if (key.asymmetricKeyType !== "ed25519") return { ok: false, why: `the signing key at ${path} isn't an Ed25519 key` };
    const pub = createPublicKey(key);
    const keyid = keyIdOf(pub);
    // A public half that can't be written now is written the next time; the key
    // signs either way, and its records check against the published copy.
    if (publicIdAt(join(dir, PUBLIC_FILE)) !== keyid) { try { writePublic(dir, pub, write); } catch { /* next time */ } }
    return { ok: true, key, keyid, created };
  } catch (err) {
    return { ok: false, why: `the signing key couldn't be read or made: ${/** @type {Error} */ (err).message}` };
  }
}

/** The key id of the public key in `path`, or null when there's none to read. @param {string} path */
function publicIdAt(path) {
  try { return keyIdOf(createPublicKey(readFileSync(path))); } catch { return null; }
}

/**
 * The public half, written whole to a file of its own and renamed into place.
 * Its own file is gone afterwards, whatever failed.
 * @param {string} dir @param {KeyObject} publicKey @param {(fd: number, text: string) => void} write
 */
function writePublic(dir, publicKey, write) {
  const path = join(dir, PUBLIC_FILE);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o644);
    try { write(fd, String(publicKey.export({ type: "spki", format: "pem" }))); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch { /* renamed, or gone */ } }
}

/**
 * The host's anchor (#165): what it signed last, kept beside the key, where
 * whoever can change a store, or restore an older one, can't. For each
 * repository, whether its store began signing, and each pull request's highest
 * entry of the signed order. It only moves forward, and is written whole and
 * renamed into place. Each write says whether it landed; a write that didn't
 * leaves the anchor behind, which reads as nothing taken away.
 * @param {string} dir  the credentials folder
 * @param {{ write?: (fd: number, text: string) => void }} [o]  `write` for a test's faults
 */
export function fileAnchor(dir, { write = (fd, text) => { writeSync(fd, text); } } = {}) {
  const path = join(dir, ANCHOR_FILE);
  const update = (/** @type {(a: { began: Record<string, true>, latest: Record<string, number> }) => boolean} */ change) => {
    try {
      const a = anchorAt(path);
      if (!change(a)) return true;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        const fd = openSync(temp, "wx", 0o600);
        try { write(fd, canonical(a)); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, path);
      } finally { try { unlinkSync(temp); } catch { /* renamed, or gone */ } }
      return true;
    } catch { return false; }
  };
  return {
    /** @param {string} repo */
    began: (repo) => update((a) => (a.began[repo] ? false : ((a.began[repo] = true), true))),
    /** @param {string} repo @param {number} pr @param {number} n */
    note: (repo, pr, n) => update((a) => {
      const k = `${repo}#${pr}`;
      if ((a.latest[k] ?? 0) >= n) return false;
      a.latest[k] = n;
      a.began[repo] = true;
      return true;
    }),
  };
}

/** The anchor in `path`, or an empty one when there's none. Throws when it can't be read. @param {string} path */
function anchorAt(path) {
  if (!existsSync(path)) return { began: {}, latest: {} };
  const a = JSON.parse(readFileSync(path, "utf8"));
  return { began: { ...(a?.began ?? {}) }, latest: { ...(a?.latest ?? {}) } };
}

/**
 * The host's anchor, to check stores against. Empty when there's none, or when
 * it can't be read: then it tells nothing, and takes nothing away.
 * @param {string} dir  the credentials folder
 * @returns {{ began: Set<string>, latest: Map<string, number> }}
 */
export function readAnchor(dir) {
  try {
    const a = anchorAt(join(dir, ANCHOR_FILE));
    return { began: new Set(Object.keys(a.began)), latest: new Map(Object.entries(a.latest).filter(([, n]) => Number.isInteger(n))) };
  } catch { return { began: new Set(), latest: new Map() }; }
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
 * @returns {Map<string, { key: KeyObject, where: string }>}
 */
export function knownKeys({ published = null, local = null } = {}) {
  /** @type {Map<string, { key: KeyObject, where: string }>} */
  const keys = new Map();
  const add = (/** @type {string} */ path, /** @type {string} */ where) => {
    try {
      const key = createPublicKey(readFileSync(path));
      if (key.asymmetricKeyType === "ed25519" && !keys.has(keyIdOf(key))) keys.set(keyIdOf(key), { key, where });
    } catch { /* not a public key */ }
  };
  if (published) {
    let names = [];
    try { names = readdirSync(published); } catch { /* none published */ }
    for (const n of names.filter(n => n.endsWith(".pub")).sort()) add(join(published, n), "published");
  }
  if (local) add(join(local, PUBLIC_FILE), "this host's");
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
