// Signed decision records (#165): a record rewritten on purpose, digest and all,
// no longer passes for the one reeve kept.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { signingKey, fileSigner, signDecision, checkSignature, knownKeys, keyIdOf, decisionStatement, baselineStatement,
         fileAnchor, readAnchor, anchorPath, KEY_FILE, PUBLIC_FILE, PAYLOAD_TYPE } from "../src/signing.mjs";
import { decisionRecord, digestOf } from "../src/evidence.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { open } from "../src/db/ops.mjs";
import { saveDecision } from "../src/db/records.mjs";
import { explainDecision, replayDecisions } from "../src/decisions.mjs";
import { recordsFor, policyOf } from "../src/evidence.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { offlineEnv } from "./fixtures/offline-github.mjs";
import { run, EVAL } from "./fixtures/tick-harness.mjs";

const credentials = () => { const d = join(tempDir("reeve-signing-"), "credentials"); mkdirSync(d, { mode: 0o700 }); return d; };
const decision = (state = "PASS") => decisionRecord({
  nwo: "o/r", pr: 7, head: "a".repeat(40), tree: "b".repeat(40), policy: "p".repeat(64),
  code: { commit: "c".repeat(40), tree: "d".repeat(40), dirty: false, diff: null },
  evidence: [{ kind: "checks", digest: "e".repeat(64) }],
  verdict: { state, summary: "s", clauses: [{ id: "ci", state }] },
});
/** A row as the store reads it back. */
const row = (d, signed) => ({ digest: d.digest, record: d.record, envelope: signed.envelope ?? null, unsigned: signed.unsigned ?? null });

test("a signing key is made once, exclusively, and only its owner can read it", () => {
  const dir = credentials();
  const first = signingKey(dir, { create: true });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(statSync(join(dir, KEY_FILE)).mode & 0o777, 0o600);
  const again = signingKey(dir, { create: true });
  assert.equal(again.ok && again.keyid, first.ok && first.keyid, "the same key, not a new one");
  assert.equal(again.ok && again.created, false);
  assert.ok(existsSync(join(dir, PUBLIC_FILE)), "its public half is written beside it");
});

test("no signing key is made unless asked", () => {
  const dir = credentials();
  assert.equal(signingKey(dir).ok, false);
  assert.equal(existsSync(join(dir, KEY_FILE)), false);
});

test("a signing key others can read isn't used", () => {
  const dir = credentials();
  signingKey(dir, { create: true });
  chmodSync(join(dir, KEY_FILE), 0o644);
  const k = signingKey(dir, { create: true });
  assert.equal(k.ok, false);
  assert.match(k.ok ? "" : k.why, /can be read by others/);
});

test("a decision is signed as a DSSE envelope over its in-toto statement, and checks with its key", () => {
  const dir = credentials();
  const d = decision();
  const signed = fileSigner(dir)(decisionStatement(d));
  assert.ok("envelope" in signed, JSON.stringify(signed));
  const env = JSON.parse(signed.envelope);
  assert.equal(env.payloadType, PAYLOAD_TYPE);
  assert.deepEqual(JSON.parse(Buffer.from(env.payload, "base64").toString()), JSON.parse(JSON.stringify(decisionStatement(d))));
  const keys = knownKeys({ local: dir });
  const k = signingKey(dir);
  assert.deepEqual(checkSignature(row(d, signed), keys), { state: "signed", keyid: k.ok ? k.keyid : "", where: "this host's" });
});

test("a record rewritten after it was signed fails its check, though its digest was computed again", () => {
  const dir = credentials();
  const d = decision("BLOCK");
  const signed = fileSigner(dir)(decisionStatement(d));
  const record = { ...d.record, verdict: { ...d.record.verdict, state: "PASS" } };
  const rewritten = { digest: digestOf(record), record, envelope: "envelope" in signed ? signed.envelope : null, unsigned: null };
  const got = checkSignature(rewritten, knownKeys({ local: dir }));
  assert.equal(got.state, "corrupt");
  assert.match(got.state === "corrupt" ? got.why : "", /over another record/);
});

test("a signature that doesn't verify is corrupt", () => {
  const dir = credentials();
  const d = decision();
  const signed = fileSigner(dir)(decisionStatement(d));
  const env = JSON.parse("envelope" in signed ? signed.envelope : "{}");
  assert.ok(Array.isArray(env.signatures), "control: it was signed");
  env.signatures[0].sig = Buffer.alloc(64).toString("base64");
  const got = checkSignature(row(d, { envelope: JSON.stringify(env) }), knownKeys({ local: dir }));
  assert.equal(got.state, "corrupt");
  assert.match(got.state === "corrupt" ? got.why : "", /doesn't verify/);
});

test("a record signed by a key reeve doesn't know is corrupt, not unsigned", () => {
  const d = decision();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signDecision(d, { key: privateKey, keyid: keyIdOf(publicKey) });
  const got = checkSignature(row(d, signed), knownKeys({ local: credentials() }));
  assert.equal(got.state, "corrupt");
  assert.match(got.state === "corrupt" ? got.why : "", /a key reeve doesn't know/);
});

test("an unsigned record is never read as signed, and says why it's unsigned", () => {
  const d = decision();
  const keys = knownKeys({ local: credentials() });
  assert.deepEqual(checkSignature(row(d, {}), keys), { state: "unsigned", why: "it was kept before records were signed" });
  assert.deepEqual(checkSignature(row(d, { unsigned: "there is no signing key" }), keys), { state: "unsigned", why: "there is no signing key" });
});

test("a record whose signing failed is kept unsigned, with the reason", () => {
  const dir = credentials();
  writeFileSync(join(dir, KEY_FILE), "not a key", { mode: 0o600 });
  const signed = fileSigner(dir)(decisionStatement(decision()));
  assert.ok("unsigned" in signed);
  assert.match("unsigned" in signed ? signed.unsigned : "", /signing key/);
});

test("published keys are read from their folder, and each is known by its key id", () => {
  const published = tempDir("reeve-signing-published-");
  const { publicKey } = generateKeyPairSync("ed25519");
  const id = keyIdOf(publicKey);
  writeFileSync(join(published, `${id}.pub`), String(publicKey.export({ type: "spki", format: "pem" })));
  writeFileSync(join(published, "README.md"), "not a key");
  const keys = knownKeys({ published });
  assert.deepEqual([...keys.keys()], [id]);
  assert.equal(keys.get(id)?.where, "published");
  assert.equal(readFileSync(join(published, `${id}.pub`), "utf8").includes("PUBLIC KEY"), true);
});

// ── kept in the store, and read back by why and replay ───────────────────────

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
const CODE = { commit: "d".repeat(40), tree: "e".repeat(40), dirty: false, diff: null };
const input = () => ({
  head: "a".repeat(40),
  checks: { verdict: "GREEN", settled: true, why: null, readable: true, failing: [], inherited: [], impostors: [], shadowRequired: false },
  base: { verdict: "GREEN", readable: true },
  reviewers: [],
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 0, readable: true },
  cleared: { readable: true, uncleared: 0, reviewers: [] },
  bodyFindings: { readable: true, open: 0, reviewers: [] },
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
  ledgerBlockers: 0,
  mergeState: "CLEAN",
});

/** A store holding one decision for #7, signed by `signer` when one is given, and its credentials folder. */
function kept(signer = null) {
  const home = tempDir("reeve-signing-home-");
  const dir = join(home, "credentials");
  mkdirSync(dir, { mode: 0o700 });
  const dbPath = join(home, "s.db");
  const db = open(dbPath);
  const i = input();
  const k = recordsFor({ nwo: "o/r", pr: 7, head: i.head, input: i, verdict: computeVerdict(i), policy: policyOf({ identity: { key: "o/r" } }),
                         code: CODE, observedAt: new Date(0).toISOString() });
  const sign = signer === "file" ? fileSigner(dir) : signer;
  saveDecision(db, { at: 1, seq: 1, pr: 7, head: i.head, ...k, ...(sign ? { signed: sign(decisionStatement(k.decision)) } : {}) });
  return { db, dbPath, home, dir, k };
}

test("a decision is kept with its signature, and why names the key that signed it", () => {
  const { db, dir } = kept("file");
  const k = signingKey(dir);
  const shown = explainDecision(db, 7, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.match(String(shown), new RegExp(`signed by key ${k.ok ? k.keyid.slice(0, 12) : "none"}, this host's`));
});

test("why says a record kept before records were signed is unsigned, never signed", () => {
  const { db, dir } = kept();
  db.prepare("UPDATE decision SET envelope = NULL, unsigned = NULL").run();
  const shown = explainDecision(db, 7, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.match(String(shown), /unsigned: it was kept before records were signed/);
  assert.doesNotMatch(String(shown), /signed by key/);
});

test("a record rewritten in the store, digest and all, can't be replayed, and why says it can't be trusted", () => {
  const { db, dir, k } = kept("file");
  const record = { ...k.decision.record, verdict: { ...k.decision.record.verdict, state: "BLOCK" } };
  db.prepare("UPDATE decision SET digest = ?, record = ? WHERE digest = ?").run(digestOf(record), JSON.stringify(record), k.decision.digest);
  const keys = knownKeys({ local: dir });
  const shown = explainDecision(db, 7, { keys });
  const replayed = replayDecisions(db, { pr: 7 }, { keys });
  db.close();
  assert.match(String(shown), /can't be trusted: its signature is over another record/);
  assert.deepEqual(replayed.map(r => [r.outcome, r.why]), [["unreplayable", "its signature is over another record"]]);
});

test("a record held unsigned is signed when it's seen again, over exactly what it says", () => {
  const { db, dir, k } = kept();
  assert.equal(db.prepare("SELECT envelope FROM decision").get().envelope, null);
  saveDecision(db, { at: 2, seq: 2, pr: 7, head: k.decision.record.subject.head, ...k, signed: fileSigner(dir)(decisionStatement(k.decision)) });
  const shown = explainDecision(db, 7, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.match(String(shown), /signed by key/);
});

test("reeve why and reeve replay check signatures with the keys published and this host's", () => {
  const { db, dbPath, home, dir, k } = kept("file");
  const record = { ...k.decision.record, verdict: { ...k.decision.record.verdict, state: "BLOCK" } };
  db.prepare("UPDATE decision SET digest = ?, record = ? WHERE digest = ?").run(digestOf(record), JSON.stringify(record), k.decision.digest);
  db.close();
  assert.ok(existsSync(join(dir, PUBLIC_FILE)));
  const env = { ...offlineEnv(), REEVE_HOME: home };
  const shown = spawnSync(process.execPath, [REEVE, "why", "o/r", "7", "--db", dbPath], { encoding: "utf8", env });
  assert.match(shown.stdout, /can't be trusted: its signature is over another record/, shown.stderr);
  const replayed = spawnSync(process.execPath, [REEVE, "replay", "o/r", "--db", dbPath], { encoding: "utf8", env });
  assert.equal(replayed.status, 1, replayed.stderr);
  assert.match(replayed.stdout, /could not be replayed: its signature is over another record/);
});

test("reeve signing-key names the host's key by its id, and says whether it's published", () => {
  const home = tempDir("reeve-signing-cli-");
  const env = { ...offlineEnv(), REEVE_HOME: home };
  const none = spawnSync(process.execPath, [REEVE, "signing-key"], { encoding: "utf8", env });
  assert.equal(none.status, 3, none.stderr);
  assert.match(none.stdout, /no signing key yet/);
  const k = signingKey(join(home, "credentials"), { create: true });
  const some = spawnSync(process.execPath, [REEVE, "signing-key"], { encoding: "utf8", env });
  assert.equal(some.status, 0, some.stderr);
  assert.match(some.stdout, new RegExp(`key id ${k.ok ? k.keyid : "none"}`));
  assert.match(some.stdout, /not published yet: copy it to deploy\/signing-keys\//);
});

// ── signed as the tick keeps them ─────────────────────────────────────────────

/** #42 evaluated at its head, every clause passing. */
const evaluated = () => { const i = input(); return { ...EVAL, head: i.head, input: i, verdict: computeVerdict(i) }; };
/** The decision rows a run left, each read back with its record. */
function rowsOf(dbPath) {
  const db = open(dbPath);
  const rows = db.prepare("SELECT digest, head, record, envelope, unsigned FROM decision").all().map(x => ({ ...x, record: JSON.parse(x.record) }));
  db.close();
  return rows;
}

test("each record the tick keeps is signed with the signer its run was given", async () => {
  const dir = credentials();
  const r = await run({ evaluate: evaluated, signer: fileSigner(dir), keepDir: true });
  const rows = rowsOf(r.dbPath);
  assert.ok(rows.length > 0);
  for (const x of rows) assert.equal(checkSignature(x, knownKeys({ local: dir })).state, "signed");
  assert.match(r.log, /made this host's signing key, [0-9a-f]{64}: publish its public half, as reeve signing-key says/);
});

test("a queue commit's record is signed too", async () => {
  const dir = credentials();
  const QUEUED = "c".repeat(40);
  const readQueue = () => ({ ok: true, queue: true, entries: [{ pr: 42, sha: QUEUED, baseSha: "f".repeat(40), state: "AWAITING_CHECKS", prHead: "a".repeat(40) }] });
  const evaluateQueue = ({ entry, input: i }) => { const q = { ...i, head: entry.sha }; return { ok: true, input: q, verdict: computeVerdict(q) }; };
  const r = await run({ evaluate: evaluated, readQueue, evaluateQueue, signer: fileSigner(dir), anchor: fileAnchor(dir), keepDir: true });
  const queued = rowsOf(r.dbPath).filter(x => x.head === QUEUED);
  assert.equal(queued.length, 1);
  assert.equal(checkSignature(queued[0], knownKeys({ local: dir })).state, "signed");
  assert.equal(readAnchor(dir).latest.get("o/r#42"), 2, "the host's anchor holds the queue commit's entry, after the head's");
});

test("a tick whose run was given no signer keeps its records unsigned, and says why", async () => {
  const r = await run({ evaluate: evaluated, keepDir: true });
  const rows = rowsOf(r.dbPath);
  assert.ok(rows.length > 0);
  for (const x of rows) assert.deepEqual([x.envelope, x.unsigned], [null, "this run was given no signing key"]);
});

test("a record the tick couldn't sign is still kept, unsigned, with the reason", async () => {
  const r = await run({ evaluate: evaluated, signer: () => { throw new Error("the disk is full"); }, keepDir: true });
  const rows = rowsOf(r.dbPath);
  assert.ok(rows.length > 0, "the verdict's record is kept");
  for (const x of rows) assert.match(String(x.unsigned), /the disk is full/);
});

// ── what else the checks rest on ──────────────────────────────────────────────

test("a signing key that isn't Ed25519 isn't used", () => {
  const dir = credentials();
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeFileSync(join(dir, KEY_FILE), String(privateKey.export({ type: "pkcs8", format: "pem" })), { mode: 0o600 });
  const k = signingKey(dir, { create: true });
  assert.equal(k.ok, false);
  assert.match(k.ok ? "" : k.why, /isn't an Ed25519 key/);
});

test("an envelope over anything but an in-toto statement is corrupt, whatever it says", () => {
  const dir = credentials();
  const d = decision();
  const signed = fileSigner(dir)(decisionStatement(d));
  const env = JSON.parse("envelope" in signed ? signed.envelope : "{}");
  env.payloadType = "text/plain";
  const got = checkSignature(row(d, { envelope: JSON.stringify(env) }), knownKeys({ local: dir }));
  assert.equal(got.state, "corrupt");
  assert.match(got.state === "corrupt" ? got.why : "", /over a "text\/plain"/);
});

test("a record held signed keeps its signature when it's seen again unsigned", () => {
  const { db, dir, k } = kept("file");
  saveDecision(db, { at: 2, seq: 2, pr: 7, head: k.decision.record.subject.head, ...k, signed: { unsigned: "the key couldn't be read" } });
  const shown = explainDecision(db, 7, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.match(String(shown), /signed by key/);
});

// ── from #271's first review ─────────────────────────────────────────────────

test("a malformed signature entry is corrupt, and replay goes on past it", () => {
  const { db, dir } = kept("file");
  const env = JSON.parse(db.prepare("SELECT envelope FROM decision").get().envelope ?? "null");
  assert.ok(env, "control: it was signed");
  env.signatures = [null];
  db.prepare("UPDATE decision SET envelope = ?").run(JSON.stringify(env));
  let replayed;
  assert.doesNotThrow(() => { replayed = replayDecisions(db, { pr: 7 }, { keys: knownKeys({ local: dir }) }); });
  db.close();
  assert.deepEqual(replayed?.map(r => [r.outcome, r.why]), [["unreplayable", "its envelope holds a signature that isn't one"]]);
});

test("a key whose writing stops partway leaves nothing at the key's path, and the next signing makes a whole one", () => {
  const dir = credentials();
  const full = () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); };
  assert.equal(signingKey(dir, { create: true, write: full }).ok, false);
  assert.equal(existsSync(join(dir, KEY_FILE)), false, "no part of a key where the key goes");
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith(".tmp")), [], "and nothing left beside it");
  const k = signingKey(dir, { create: true });
  assert.equal(k.ok && k.created, true);
});

test("a public half that's missing, cut short or another key's is written again from the key", () => {
  const dir = credentials();
  const k = signingKey(dir, { create: true });
  const id = k.ok ? k.keyid : "";
  const slot = () => { try { return keyIdOf(createPublicKey(readFileSync(join(dir, PUBLIC_FILE), "utf8"))); } catch { return null; } };
  for (const broken of ["-----BEGIN PUBLIC KEY-----\nMCow", String(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }))]) {
    writeFileSync(join(dir, PUBLIC_FILE), broken);
    assert.equal(signingKey(dir).ok, true);
    assert.equal(slot(), id, "the slot holds this key's public half again");
    assert.equal(knownKeys({ local: dir }).get(id)?.where, "this host's");
  }
});

/** #42 at `head`, evaluated with its CI `ci` ("GREEN" passes it, "RED" blocks it). */
const at = (head, ci = "GREEN") => {
  const i = { ...input(), head, checks: { ...input().checks, verdict: ci, failing: ci === "RED" ? [{ name: "unit", id: "1" }] : [] } };
  return { ...EVAL, head, input: i, verdict: computeVerdict(i) };
};
/**
 * Ticks over one store, each with its own evaluation, and with `signer` from
 * tick `from` on. The ticks with one signer share a run, and so its profile.
 */
async function ticks(evals, { signer = null, from = 0, anchor = null } = {}) {
  const dbPath = join(tempDir("reeve-signing-ticks-"), "s.db");
  open(dbPath).close();
  const each = async (list, s) => {
    if (!list.length) return;
    // By tick, not by call: a tick may evaluate a pull request more than once.
    let tick = 0;
    await run({ openPrs: () => { tick++; return [42]; }, evaluate: () => list[Math.min(tick, list.length) - 1],
                dbPath, ticks: list.length, ...(s ? { signer: s } : {}), ...(s && anchor ? { anchor } : {}) });
  };
  await each(evals.slice(0, from), null);
  await each(evals.slice(from), signer);
  return dbPath;
}
const A = "a".repeat(40), B = "b".repeat(40);

test("a signature stripped from a record kept after its store began signing leaves it untrusted", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A)], { signer: fileSigner(dir) }));
  db.prepare("UPDATE decision SET envelope = NULL, unsigned = 'it was kept before records were signed'").run();
  const keys = knownKeys({ local: dir });
  const shown = explainDecision(db, 42, { keys });
  const replayed = replayDecisions(db, { pr: 42 }, { keys });
  db.close();
  assert.match(String(shown), /can't be trusted: it's unsigned, though it was kept after this store began signing/);
  assert.deepEqual(replayed.map(r => r.outcome), ["unreplayable"]);
});

test("records a store kept before it began signing are vouched for by its signed baseline, and read as unsigned", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(B)], { signer: fileSigner(dir), from: 1 }));
  const keys = knownKeys({ local: dir });
  const before = explainDecision(db, 42, { head: A.slice(0, 8), keys });
  const replayed = replayDecisions(db, { pr: 42 }, { keys });
  db.close();
  assert.match(String(before), /unsigned: it was kept before this store began signing/);
  assert.doesNotMatch(String(before), /can't be trusted/);
  assert.deepEqual(replayed.map(r => r.outcome), ["same", "same"]);
});

test("a baseline changed after it was signed vouches for nothing", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(B)], { signer: fileSigner(dir), from: 1 }));
  const row = db.prepare("SELECT seq, payload FROM event WHERE op = 'signing.baseline'").get();
  assert.ok(row, "control: the store began signing with a baseline");
  const p = JSON.parse(row.payload);
  db.prepare("UPDATE event SET payload = ? WHERE seq = ?").run(JSON.stringify({ ...p, digests: [...p.digests, "f".repeat(64)] }), row.seq);
  const replayed = replayDecisions(db, { pr: 42 }, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.deepEqual(replayed.map(r => r.outcome).sort(), ["same", "unreplayable"], "the record kept before signing is no longer vouched for");
});

test("a store that never began signing reads its records as unsigned, and replays them", async () => {
  const db = open(await ticks([at(A)]));
  const keys = knownKeys({ local: credentials() });
  const shown = explainDecision(db, 42, { keys });
  const replayed = replayDecisions(db, { pr: 42 }, { keys });
  db.close();
  assert.match(String(shown), /unsigned: this run was given no signing key/);
  assert.deepEqual(replayed.map(r => r.outcome), ["same"]);
});

test("an older decision made to look latest in the store is caught by the signed order", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], { signer: fileSigner(dir) }));
  const keys = knownKeys({ local: dir });
  assert.doesNotMatch(String(explainDecision(db, 42, { keys })), /as the latest/, "control: the store's order and the signed one agree");
  const older = db.prepare("SELECT digest FROM decision ORDER BY last_seq LIMIT 1").get().digest;
  db.prepare("UPDATE decision SET last_seq = 999999 WHERE digest = ?").run(older);
  const shown = explainDecision(db, 42, { keys });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: the signed order of this pull request's decisions ends at record/);
});

test("the signed order records each change of a pull request's latest decision, and only a change", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A), at(A, "RED"), at(A)], { signer: fileSigner(dir) }));
  const order = db.prepare("SELECT payload FROM event WHERE op = 'decision.latest' AND subject = 'pr:42' ORDER BY seq").all().map(r => JSON.parse(r.payload));
  const digests = db.prepare("SELECT digest FROM decision ORDER BY first_seq").all().map(r => r.digest);
  db.close();
  assert.deepEqual(order.map(o => [o.n, o.digest]), [[1, digests[0]], [2, digests[1]], [3, digests[0]]]);
});

test("an entry missing from the signed order is caught", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED"), at(A)], { signer: fileSigner(dir) }));
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  const shown = explainDecision(db, 42, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: the signed order of its decisions is missing entry 2/);
});

test("a store whose baseline was deleted still began signing, by its signed records", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], { signer: fileSigner(dir) }));
  db.prepare("DELETE FROM event WHERE op = 'signing.baseline'").run();
  const older = db.prepare("SELECT digest FROM decision ORDER BY first_seq LIMIT 1").get().digest;
  db.prepare("UPDATE decision SET envelope = NULL WHERE digest = ?").run(older);
  const replayed = replayDecisions(db, { pr: 42 }, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.deepEqual(replayed.map(r => r.outcome), ["unreplayable", "same"]);
});

test("a baseline isn't made once a store holds signed records, so it can't vouch for one stripped since", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(A, "RED")], { signer: fileSigner(dir) });
  let db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op = 'signing.baseline'").run();
  const older = db.prepare("SELECT digest FROM decision ORDER BY first_seq LIMIT 1").get().digest;
  db.prepare("UPDATE decision SET envelope = NULL WHERE digest = ?").run(older);
  db.close();
  await run({ evaluate: () => at(A, "RED"), dbPath, signer: fileSigner(dir) });
  db = open(dbPath);
  const replayed = replayDecisions(db, { digest: older.slice(0, 12) }, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.deepEqual(replayed.map(r => r.outcome), ["unreplayable"]);
});

test("an entry of the signed order changed after it was signed doesn't hold", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], { signer: fileSigner(dir) }));
  const older = db.prepare("SELECT digest FROM decision ORDER BY first_seq LIMIT 1").get().digest;
  const top = db.prepare("SELECT seq, payload FROM event WHERE op = 'decision.latest' ORDER BY seq DESC LIMIT 1").get();
  assert.ok(top, "control: the signed order has entries");
  db.prepare("UPDATE event SET payload = ? WHERE seq = ?").run(JSON.stringify({ ...JSON.parse(top.payload), digest: older }), top.seq);
  db.prepare("UPDATE decision SET last_seq = 999999 WHERE digest = ?").run(older);
  const shown = explainDecision(db, 42, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: an entry in the signed order of its decisions doesn't hold/);
});

test("an entry the signed order names twice is caught", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], { signer: fileSigner(dir) }));
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) SELECT at, actor, op, subject, payload FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 1").run();
  const shown = explainDecision(db, 42, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: the signed order of its decisions names entry 1 twice/);
});

// ── from #271's second review ────────────────────────────────────────────────

test("only a store's first baseline vouches for records, so a later one can't launder a stripped record", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], { signer: fileSigner(dir) }));
  const later = db.prepare("SELECT digest FROM decision ORDER BY first_seq DESC LIMIT 1").get().digest;
  const s = fileSigner(dir)(baselineStatement([later]));
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(2, "daemon", "signing.baseline", "store", JSON.stringify({ digests: [later], envelope: "envelope" in s ? s.envelope : null }));
  db.prepare("UPDATE decision SET envelope = NULL WHERE digest = ?").run(later);
  const replayed = replayDecisions(db, { digest: later.slice(0, 12) }, { keys: knownKeys({ local: dir }) });
  db.close();
  assert.deepEqual(replayed.map(r => r.outcome), ["unreplayable"]);
});

test("a public half whose writing fails leaves nothing behind, and signing goes on", () => {
  const dir = credentials();
  assert.equal(signingKey(dir, { create: true }).ok, true);
  writeFileSync(join(dir, PUBLIC_FILE), "cut short");
  const full = () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); };
  const k = signingKey(dir, { write: full });
  assert.equal(k.ok, true, "the key still signs");
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith(".tmp")), [], "no half-written public file left beside it");
});

// ── the host's anchor, from #271's second review ─────────────────────────────

test("a signed order cut short of its newest entries is caught against the host's anchor", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], { signer: fileSigner(dir), anchor: fileAnchor(dir) }));
  const older = db.prepare("SELECT digest FROM decision ORDER BY first_seq LIMIT 1").get().digest;
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  db.prepare("UPDATE decision SET last_seq = 999999 WHERE digest = ?").run(older);
  const keys = knownKeys({ local: dir });
  const shown = explainDecision(db, 42, { keys, anchor: readAnchor(dir) });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: the signed order of its decisions ends at entry 1, though this host signed up to entry 2/);
});

test("a store that reads as never signed, where the host's anchor says it began, isn't trusted", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A)], { signer: fileSigner(dir), anchor: fileAnchor(dir) }));
  db.prepare("DELETE FROM event WHERE op IN ('signing.baseline', 'decision.latest')").run();
  db.prepare("UPDATE decision SET envelope = NULL, unsigned = 'it was kept before records were signed'").run();
  const keys = knownKeys({ local: dir });
  const replayed = replayDecisions(db, { pr: 42 }, { keys, anchor: readAnchor(dir) });
  const shown = explainDecision(db, 42, { keys, anchor: readAnchor(dir) });
  db.close();
  assert.deepEqual(replayed.map(r => r.outcome), ["unreplayable"]);
  assert.match(String(shown), /can't be trusted as the latest: the store holds no signed order of its decisions, though this host signed up to entry 1/);
});

test("the host's anchor only moves forward, and is readable only by its owner", () => {
  const dir = credentials();
  const anchor = fileAnchor(dir);
  assert.equal(anchor.note("o/r", 7, 3), true);
  assert.equal(anchor.note("o/r", 7, 2), true);
  assert.equal(anchor.began("o/r"), true);
  const read = readAnchor(dir);
  assert.equal(read.latest.get("o/r#7"), 3);
  assert.equal(read.began.has("o/r"), true);
  assert.equal(statSync(anchorPath(dir, "o/r")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(anchorPath(dir, "o/r"))).filter(f => f.endsWith(".tmp")), []);
});

test("reeve why reads the host's anchor, and says when the store holds less than this host signed", async () => {
  const home = tempDir("reeve-signing-anchor-cli-");
  const dir = join(home, "credentials");
  mkdirSync(dir, { mode: 0o700 });
  const dbPath = await ticks([at(A), at(A, "RED")], { signer: fileSigner(dir), anchor: fileAnchor(dir) });
  const db = open(dbPath);
  const older = db.prepare("SELECT digest FROM decision ORDER BY first_seq LIMIT 1").get().digest;
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  db.prepare("UPDATE decision SET last_seq = 999999 WHERE digest = ?").run(older);
  db.close();
  const shown = spawnSync(process.execPath, [REEVE, "why", "o/r", "42", "--db", dbPath], { encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: home } });
  assert.match(shown.stdout, /though this host signed up to entry 2/, shown.stderr);
});

test("the host's anchor says a store began signing once its baseline is made, before any record", async () => {
  const dir = credentials();
  await run({ openPrs: () => [], signer: fileSigner(dir), anchor: fileAnchor(dir) });
  assert.equal(readAnchor(dir).began.has("o/r"), true);
});

test("reeve replay reads the host's anchor, and doesn't replay a store stripped to look never signed", async () => {
  const home = tempDir("reeve-signing-anchor-replay-");
  const dir = join(home, "credentials");
  mkdirSync(dir, { mode: 0o700 });
  const dbPath = await ticks([at(A)], { signer: fileSigner(dir), anchor: fileAnchor(dir) });
  const db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op IN ('signing.baseline', 'decision.latest')").run();
  db.prepare("UPDATE decision SET envelope = NULL").run();
  db.close();
  const replayed = spawnSync(process.execPath, [REEVE, "replay", "o/r", "--db", dbPath], { encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: home } });
  assert.equal(replayed.status, 1, replayed.stdout + replayed.stderr);
  assert.match(replayed.stdout, /unsigned, though it was kept after this store began signing/);
});

test("an anchor whose writing fails leaves it as it was, and nothing beside it", () => {
  const dir = credentials();
  assert.equal(fileAnchor(dir).note("o/r", 7, 1), true);
  const full = () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); };
  assert.equal(fileAnchor(dir, { write: full }).note("o/r", 7, 2), false, "it says the write didn't land");
  assert.equal(readAnchor(dir).latest.get("o/r#7"), 1);
  assert.deepEqual(readdirSync(dirname(anchorPath(dir, "o/r"))).filter(f => f.endsWith(".tmp")), []);
});

// ── from #271's third review ─────────────────────────────────────────────────

const privatePem = () => String(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));

test("a public-key file holding a private key is never taken for a public key, and is written again from the key", () => {
  const dir = credentials();
  const k = signingKey(dir, { create: true });
  writeFileSync(join(dir, PUBLIC_FILE), privatePem());
  assert.deepEqual([...knownKeys({ local: dir }).keys()], [], "a private key is never read as a public one");
  assert.equal(signingKey(dir).ok, true);
  assert.doesNotMatch(readFileSync(join(dir, PUBLIC_FILE), "utf8"), /PRIVATE KEY/);
  assert.deepEqual([...knownKeys({ local: dir }).keys()], [k.ok ? k.keyid : ""]);
});

test("reeve signing-key never points at a file holding a private key", () => {
  const home = tempDir("reeve-signing-private-cli-");
  const dir = join(home, "credentials");
  mkdirSync(dir, { mode: 0o700 });
  signingKey(dir, { create: true });
  writeFileSync(join(dir, PUBLIC_FILE), privatePem());
  const r = spawnSync(process.execPath, [REEVE, "signing-key"], { encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(readFileSync(join(dir, PUBLIC_FILE), "utf8"), /PRIVATE KEY/, "what it points at is the public half");
});

test("a key made in place of a lost one keeps the lost one's public half, so what it signed still checks", () => {
  const dir = credentials();
  const d = decision();
  const signed = fileSigner(dir)(decisionStatement(d));
  const old = signingKey(dir);
  rmSync(join(dir, KEY_FILE));
  const made = signingKey(dir, { create: true });
  assert.notEqual(made.ok && made.keyid, old.ok && old.keyid);
  const keys = knownKeys({ local: dir });
  assert.ok(keys.has(old.ok ? old.keyid : ""), "the old public half is kept");
  assert.equal(checkSignature(row(d, signed), keys).state, "signed");
});

test("each repository's anchor is a file of its own, so one repository's write never touches another's", () => {
  const dir = credentials();
  const anchor = fileAnchor(dir);
  anchor.note("o/a", 1, 1);
  anchor.note("o/b", 2, 1);
  assert.notEqual(anchorPath(dir, "o/a"), anchorPath(dir, "o/b"));
  writeFileSync(anchorPath(dir, "o/a"), "{}");
  assert.equal(readAnchor(dir).latest.get("o/b#2"), 1);
});

test("an anchor write that failed is made good on a later tick, though the decision didn't change", async () => {
  const dir = credentials();
  const real = fileAnchor(dir);
  let failing = true;
  const anchor = { began: real.began, note: (...a) => (failing ? ((failing = false), false) : real.note(...a)) };
  await ticks([at(A), at(A)], { signer: fileSigner(dir), anchor });
  assert.equal(readAnchor(dir).latest.get("o/r#42"), 1);
});

test("replay reports a record the signed order names that the store no longer holds", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], { signer: fileSigner(dir), anchor: fileAnchor(dir) }));
  const older = db.prepare("SELECT digest FROM decision ORDER BY first_seq LIMIT 1").get().digest;
  db.prepare("DELETE FROM decision WHERE digest = ?").run(older);
  const replayed = replayDecisions(db, {}, { keys: knownKeys({ local: dir }), anchor: readAnchor(dir) });
  db.close();
  assert.ok(replayed.some(r => r.outcome === "unreplayable" && r.digest === older && /no longer holds it/.test(r.why ?? "")), JSON.stringify(replayed));
});

test("a store that began signing before the host kept an anchor is anchored as begun on its next tick", async () => {
  const dir = credentials();
  const dbPath = join(tempDir("reeve-signing-late-anchor-"), "s.db");
  open(dbPath).close();
  await run({ openPrs: () => [], signer: fileSigner(dir), dbPath });
  assert.equal(readAnchor(dir).began.has("o/r"), false, "control: no anchor was kept then");
  await run({ openPrs: () => [], signer: fileSigner(dir), anchor: fileAnchor(dir), dbPath });
  assert.equal(readAnchor(dir).began.has("o/r"), true);
});
