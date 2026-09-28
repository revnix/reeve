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

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./db/ops.mjs";
import { STATEMENT_TYPE } from "./evidence.mjs";

/** The DSSE payload type for an in-toto statement. */
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const DECISION_PREDICATE = "https://revnix.com/reeve/decision/v1";
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
 * The signing key in `dir`, the credentials folder. With `create`, one is made
 * when there's none: exclusively, so two processes never write over each other's,
 * and readable only by its owner. A key others could read, or that isn't
 * Ed25519, is refused.
 * @param {string} dir
 * @param {{ create?: boolean }} [o]
 * @returns {{ ok: true, key: KeyObject, keyid: string, created: boolean } | { ok: false, why: string }}
 */
export function signingKey(dir, { create = false } = {}) {
  const path = join(dir, KEY_FILE);
  let created = false;
  try {
    if (!existsSync(path)) {
      if (!create) return { ok: false, why: `there is no signing key at ${path}` };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      let fd;
      try { fd = openSync(path, "wx", 0o600); }
      catch (err) {
        // Another process made it first: that one is the key.
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      }
      if (fd !== undefined) {
        try { writeSync(fd, String(privateKey.export({ type: "pkcs8", format: "pem" }))); } finally { closeSync(fd); }
        writePublic(dir, publicKey);
        created = true;
      }
    }
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) return { ok: false, why: `the signing key at ${path} can be read by others (mode ${mode.toString(8)}), so it isn't used` };
    const key = createPrivateKey(readFileSync(path));
    if (key.asymmetricKeyType !== "ed25519") return { ok: false, why: `the signing key at ${path} isn't an Ed25519 key` };
    const pub = createPublicKey(key);
    // The public half is written again if it went missing, from the key itself.
    if (!existsSync(join(dir, PUBLIC_FILE))) writePublic(dir, pub);
    return { ok: true, key, keyid: keyIdOf(pub), created };
  } catch (err) {
    return { ok: false, why: `the signing key couldn't be read or made: ${/** @type {Error} */ (err).message}` };
  }
}

/** @param {string} dir @param {KeyObject} publicKey */
function writePublic(dir, publicKey) {
  const fd = openSync(join(dir, PUBLIC_FILE), "w", 0o644);
  try { writeSync(fd, String(publicKey.export({ type: "spki", format: "pem" }))); } finally { closeSync(fd); }
}

/**
 * A signer over the key in `dir`, made on first use. What it can't sign it says
 * why, and the record is kept unsigned with that reason.
 * @param {string} dir
 * @returns {(decision: { digest: string, record: Record<string, any> }) => ({ envelope: string } | { unsigned: string }) & { created?: string }}
 */
export function fileSigner(dir) {
  return (decision) => {
    const k = signingKey(dir, { create: true });
    if ("why" in k) return { unsigned: k.why };
    const s = signDecision(decision, k);
    // The key made for this record, named so the run can say so.
    return k.created ? { ...s, created: k.keyid } : s;
  };
}

/**
 * A decision record, signed.
 * @param {{ digest: string, record: Record<string, any> }} decision
 * @param {{ key: KeyObject, keyid: string }} k
 * @returns {{ envelope: string } | { unsigned: string }}
 */
export function signDecision(decision, { key, keyid }) {
  try {
    const payload = Buffer.from(canonical(decisionStatement(decision)));
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
  /** @type {Envelope} */
  let env;
  try { env = JSON.parse(row.envelope); } catch { return { state: "corrupt", why: "its signature can't be read" }; }
  if (env?.payloadType !== PAYLOAD_TYPE) return { state: "corrupt", why: `its signature is over a ${JSON.stringify(env?.payloadType)}, not a decision` };
  const payload = Buffer.from(String(env.payload ?? ""), "base64");
  if (payload.toString() !== canonical(decisionStatement(row)))
    return { state: "corrupt", why: "its signature is over another record" };
  const s = Array.isArray(env.signatures) ? env.signatures : [];
  if (!s.length) return { state: "corrupt", why: "its signature is missing from its envelope" };
  for (const { keyid, sig } of s) {
    const k = keys.get(String(keyid));
    if (!k) continue;
    let ok = false;
    try { ok = verify(null, pae(PAYLOAD_TYPE, payload), k.key, Buffer.from(String(sig ?? ""), "base64")); } catch { ok = false; }
    return ok ? { state: "signed", keyid: String(keyid), where: k.where } : { state: "corrupt", why: `its signature by key ${String(keyid).slice(0, 12)} doesn't verify` };
  }
  return { state: "corrupt", why: `it's signed by a key reeve doesn't know (${s.map(x => String(x.keyid).slice(0, 12)).join(", ")})` };
}
