// What the host's anchor keeps besides how far each signed order goes (#279,
// #281): the record an order's top entry names, an entry reserved before the
// store commits it, the records kept and not yet ordered, and a binding begun
// with a store's first baseline. A store's identity is copied with it, and a
// reeve can stop between any two steps, so none of these is left to the store.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as signing from "../src/signing.mjs";
import { fileSigner, knownKeys, baselineStatement, latestStatement } from "../src/signing.mjs";
import { fileAnchor, readAnchor, anchorPath } from "../src/anchor.mjs";
import { open, canonical } from "../src/db/ops.mjs";
import { storeIdentity } from "../src/db/records.mjs";
import { explainDecision, replayDecisions, signedOrder, anchorForStore } from "../src/decisions.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { run, EVAL } from "./fixtures/tick-harness.mjs";

const REPO = "o/r", PR = 42;
const A = "a".repeat(40), B = "b".repeat(40);
const ID = "a".repeat(32), OTHER = "b".repeat(32);
const D1 = "1".repeat(64), D2 = "2".repeat(64), D3 = "3".repeat(64);

/** A baseline's fingerprint, as its signed statement names it. @param {string[]} digests */
const baselineFingerprint = (digests) => baselineStatement(digests).subject[0].digest.sha256;
/** A credentials folder, made as reeve's home makes it. */
const credentials = () => { const d = join(tempDir("reeve-pins-"), "credentials"); mkdirSync(d, { mode: 0o700 }); return d; };
const input = (head, ci) => ({
  head,
  checks: { verdict: ci, settled: true, why: null, readable: true, failing: ci === "RED" ? [{ name: "unit", id: "1" }] : [], inherited: [], impostors: [], shadowRequired: false },
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
/** #42 at `head`, evaluated with its CI `ci`. */
const at = (head, ci = "GREEN") => { const i = input(head, ci); return { ...EVAL, head, input: i, verdict: computeVerdict(i) }; };
/** What the host's reeve is given, over the credentials folder `dir`, its anchor as given. */
const host = (dir, anchor = fileAnchor(dir)) => ({ signer: fileSigner(dir), keys: () => knownKeys({ local: dir }), anchor });
/** A new store, and a tick over it. */
const store = () => { const p = join(tempDir("reeve-pins-store-"), "s.db"); open(p).close(); return p; };
/** One tick over the store at `dbPath`, judging #42 as `e`, or no pull request with `e` null. */
const tick = (dbPath, e, ctx = {}) => run({ dbPath, openPrs: () => (e ? [PR] : []), evaluate: () => e, prState: () => "OPEN", prIsFinished: () => false, ...ctx });
/** Ticks in one run, each judging #42 as its evaluation says: one run's profile, so a verdict seen again keeps the same record. */
const ticks = (dbPath, evals, ctx = {}) => {
  let n = 0;
  return run({ dbPath, ticks: evals.length, openPrs: () => { n++; return [PR]; }, evaluate: () => evals[Math.min(n, evals.length) - 1],
               prState: () => "OPEN", prIsFinished: () => false, ...ctx });
};
/** The host's anchor as read, or why it can't be: a read that throws fails an assertion, rather than stopping the file. */
const anchorRead = (/** @type {string} */ dir) => { try { return readAnchor(dir, REPO); } catch (e) { return /** @type {any} */ ({ unreadable: /** @type {Error} */ (e).message }); } };
/** The host's anchor, as `why` and `replay` are given it, checked against the store. */
const anchorFor = (db, dir) => { let r; try { r = { anchor: readAnchor(dir, REPO), why: null }; } catch (e) { r = { anchor: null, why: e.message }; } return anchorForStore(db, r, REPO); };
/** The digests of #42's records, oldest first. */
const digestsOf = (db) => db.prepare("SELECT digest FROM decision WHERE pr = ? ORDER BY first_seq").all(PR).map((r) => r.digest);
/** The anchor's file, changed as `fn` changes its JSON: what a copy of the store, or a stop, would have left. */
const rewrite = (dir, fn) => {
  const p = anchorPath(dir, REPO);
  const a = JSON.parse(readFileSync(p, "utf8"));
  // What a writer that left them out didn't write, so an edit here fails an assertion rather than the file.
  a.named ??= {}; a.sealed ??= {}; a.chained ??= {}; a.reserved ??= {}; a.pinned ??= {};
  fn(a);
  writeFileSync(p, JSON.stringify(a));
};
/** An anchor file as written whole, with nothing made on the way but its folders. */
const writeAnchor = (dir, a) => { const p = anchorPath(dir, REPO); mkdirSync(dirname(p), { recursive: true, mode: 0o700 }); writeFileSync(p, JSON.stringify(a), { mode: 0o600 }); };
const baselines = (dbPath) => { const db = open(dbPath); const n = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'signing.baseline'").get().n; db.close(); return n; };
/** Entry `n` of #42's order as the store holds it, its payload read. */
const entryOf = (db, n) => JSON.parse(db.prepare("SELECT payload FROM event WHERE op = 'decision.latest' AND subject = ? AND json_extract(payload, '$.n') = ?").get(`pr:${PR}`, n)?.payload ?? "null");
/** An entry's seal, from its payload as the store holds it: sha256 over its statement, its repository without case. */
const sealOf = (/** @type {any} */ e) => createHash("sha256").update(canonical(latestStatement({ repo: String(e.repo).toLowerCase(), pr: PR, n: e.n, digest: e.digest,
                                                                                          records: e.records ?? [], store: e.store ?? null, seq: e.seq ?? null }))).digest("hex");
/** An entry reserved on the anchor, as it writes one: whole but for its repository and store. */
/** The chain to entry 1, the entry `e`, as an anchor that noted it holds it. */
const chainTo = (/** @type {any} */ e) => signing.orderChain(new Map([[1, sealOf(e)]]), 1);
const reservedAs = (/** @type {any} */ e) => ({ n: e.n, digest: e.digest, records: e.records ?? [], seq: e.seq ?? null });

// ── the anchor ───────────────────────────────────────────────────────────────

test("an anchor written before #279 and #281 reads, holding none of what they add", () => {
  const dir = credentials();
  writeAnchor(dir, { began: true, latest: { 42: 2 }, store: ID });
  const a = anchorRead(dir);
  assert.deepEqual(a, { began: true, latest: new Map([[PR, 2]]), store: ID, named: new Map(), sealed: new Map(), chained: new Map(), reserved: new Map(), pinned: new Map(), pending: null });
});

test("the anchor reserves only an order's next entry, for one record, and noting it clears that and unpins what it names", () => {
  const dir = credentials();
  const an = fileAnchor(dir);
  assert.equal(an.reserve(REPO, /** @type {any} */ (null), PR, 1, D1), false, "not on an anchor no store's, which couldn't be read back");
  assert.equal(an.bind(REPO, ID), true);
  assert.equal(an.reserve(REPO, ID, PR, 2, D1), false, "not an entry past the next");
  assert.equal(an.reserve(REPO, OTHER, PR, 1, D1), false, "nor on an anchor that's another store's");
  assert.equal(an.reserve(REPO, ID, PR, 1, D1), true);
  assert.equal(an.reserve(REPO, ID, PR, 1, D2), false, "a reserved number stays its record's");
  assert.equal(an.reserve(REPO, ID, PR, 1, D1, [D3]), false, "and its entry's, naming no other records");
  assert.equal(an.reserve(REPO, ID, PR, 1, D1, [], 7), false, "nor seen elsewhere");
  assert.equal(an.note(REPO, PR, 1, D1, [D1], sealOf({ repo: REPO, n: 1, digest: D1, records: [D3], store: ID })), false, "nor is it noted for another entry naming its record");
  assert.equal(an.pin(REPO, OTHER, PR, [D3]), false, "nothing is pinned on another store's anchor");
  assert.equal(an.pin(REPO, ID, PR, [D1, D3]), true);
  assert.equal(an.note(REPO, PR, 1, D2, [D2]), false, "nor is a reserved number noted for another record");
  assert.deepEqual(anchorRead(dir)?.reserved, new Map([[PR, { n: 1, digest: D1, records: [], seq: null }]]), "control: it's still reserved");
  assert.equal(an.note(REPO, PR, 1, D1, [D1]), true);
  const a = anchorRead(dir);
  assert.deepEqual({ latest: a?.latest, named: a?.named, reserved: a?.reserved, pinned: a?.pinned },
                   { latest: new Map([[PR, 1]]), named: new Map([[PR, D1]]), reserved: new Map(), pinned: new Map([[PR, new Set([D3])]]) });
  assert.equal(an.note(REPO, PR, 1, D2), false, "an entry noted with one record isn't noted again with another");
});

test("the anchor keeps the seal of the entry it noted last, and never another for it", () => {
  const dir = credentials();
  const an = fileAnchor(dir);
  const one = sealOf({ repo: REPO, n: 1, digest: D1, store: ID }), other = sealOf({ repo: REPO, n: 1, digest: D1, records: [D2], store: ID });
  assert.equal(an.note(REPO, PR, 1, D1, [D1], one), true);
  assert.equal(anchorRead(dir)?.sealed?.get(PR), one);
  assert.equal(an.note(REPO, PR, 1, D1, [D1], other), false, "not noted again as another entry");
  assert.equal(anchorRead(dir)?.sealed?.get(PR), one);
  assert.equal(an.note(REPO, PR, 2, D2, [D2]), true, "control: a later entry noted without one");
  assert.equal(anchorRead(dir)?.sealed?.has(PR), false, "leaves none for it");
});

test("the anchor unpins a record only on the say of the store it's bound to", () => {
  const dir = credentials();
  const an = fileAnchor(dir);
  assert.equal(an.bind(REPO, ID), true);
  assert.equal(an.pin(REPO, ID, PR, [D1, D2]), true);
  assert.equal(an.unpin(REPO, OTHER, PR, [D1]), false, "not by another store");
  assert.equal(an.unpin(REPO, ID, PR, [D1]), true);
  assert.deepEqual(anchorRead(dir)?.pinned?.get(PR), new Set([D2]));
});

test("an anchor holding a part that doesn't read whole isn't read", () => {
  const bad = {
    "an entry reserved past the next": { reserved: { 42: { n: 3, digest: D1, records: [], seq: null } } },
    "a record noted for an entry the anchor doesn't hold": { named: { 7: D1 } },
    "a record noted that isn't a digest": { named: { 42: "abc" } },
    "no record pinned": { pinned: { 42: [] } },
    "a binding begun on an anchor already bound": { pending: { store: OTHER, baseline: baselineFingerprint([D1]), digests: [D1] } },
    "a seal for an entry that names no record": { sealed: { 42: D1 } },
    "an entry reserved without its records": { reserved: { 42: { n: 2, digest: D1, seq: null } } },
    "an entry reserved seen nowhere": { reserved: { 42: { n: 2, digest: D1, records: [], seq: 0 } } },
  };
  for (const [what, part] of Object.entries(bad)) {
    const dir = credentials();
    writeAnchor(dir, { began: true, latest: { 42: 1 }, store: ID, ...part });
    assert.throws(() => readAnchor(dir, REPO), /isn't an anchor/, what);
  }
  // And what's only whole on an anchor no store's yet.
  const unbound = {
    "an entry reserved on an anchor no store's": { reserved: { 42: { n: 2, digest: D1, records: [], seq: null } } },
    "a binding begun without its records": { pending: { store: ID, baseline: baselineFingerprint([D1]) } },
    "a binding begun whose records aren't its fingerprint's": { pending: { store: ID, baseline: baselineFingerprint([D1]), digests: [D2] } },
    "a binding begun whose records aren't sorted": { pending: { store: ID, baseline: baselineFingerprint([D1, D2]), digests: [D2, D1] } },
  };
  for (const [what, part] of Object.entries(unbound)) {
    const dir = credentials();
    writeAnchor(dir, { began: false, latest: { 42: 1 }, store: null, ...part });
    assert.throws(() => readAnchor(dir, REPO), /isn't an anchor/, what);
  }
  const dir = credentials();
  writeAnchor(dir, { began: false, latest: {}, store: null, pending: { store: ID, baseline: baselineFingerprint([D1, D2]), digests: [D1, D2] } });
  assert.deepEqual(anchorRead(dir)?.pending, { store: ID, baseline: baselineFingerprint([D1, D2]), digests: [D1, D2] }, "control: a binding begun reads");
});

test("a binding begun is finished only for the store it was begun for", () => {
  const dir = credentials();
  const an = fileAnchor(dir);
  assert.equal(an.pending(REPO, ID, [D1]), true);
  assert.equal(an.pending(REPO, OTHER, [D1]), false, "nor for another store");
  assert.equal(an.pending(REPO, OTHER, [D1, D3]), false, "nor for another store over more records");
  assert.equal(an.bind(REPO, OTHER), false, "another store isn't bound over it");
  assert.deepEqual(anchorRead(dir)?.pending, { store: ID, baseline: baselineFingerprint([D1]), digests: [D1] });
  assert.equal(an.bind(REPO, ID), true);
  const a = anchorRead(dir);
  assert.deepEqual({ store: a?.store, began: a?.began, pending: a?.pending }, { store: ID, began: true, pending: null });
  assert.equal(an.pending(REPO, ID, [D1]), false, "and none is begun on an anchor bound");
});

test("a binding begun isn't moved to other records, more or fewer", () => {
  const dir = credentials();
  const an = fileAnchor(dir);
  assert.equal(an.pending(REPO, ID, [D1]), true);
  assert.equal(an.pending(REPO, ID, [D1, D2]), false, "not over more records");
  assert.equal(an.pending(REPO, ID, [D2]), false, "nor over others");
  assert.equal(an.pending(REPO, ID, [D1]), true, "control: begun again as it was, it holds");
  assert.deepEqual(anchorRead(dir)?.pending, { store: ID, baseline: baselineFingerprint([D1]), digests: [D1] });
});

// ── #279: an order's entries ─────────────────────────────────────────────────

test("an entry is reserved on the host's anchor before the store commits it", async () => {
  const dir = credentials();
  const dbPath = store();
  const real = fileAnchor(dir);
  /** @type {{ n: number, digest: string, top: number, records: string[], seq: number | null }[]} */ const seen = [];
  const anchor = { ...real, reserve: (/** @type {any[]} */ ...args) => {
    const [, id, , n, digest, records, seq] = args;
    const db = open(dbPath);
    const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }), id);
    db.close();
    seen.push({ n, digest, top: "top" in order ? order.top : -1, records, seq });
    return real.reserve(...args);
  } };
  await tick(dbPath, at(A), host(dir, anchor));
  await tick(dbPath, at(A, "RED"), host(dir, anchor));
  const db = open(dbPath);
  const [green, red] = digestsOf(db);
  const one = entryOf(db, 1), two = entryOf(db, 2);
  db.close();
  assert.deepEqual(seen, [{ n: 1, digest: green, top: 0, records: one?.records, seq: one?.seq }, { n: 2, digest: red, top: 1, records: two?.records, seq: two?.seq }],
                   "each entry reserved, whole, while the store's order ended before it");
});

test("an entry that can't be reserved isn't committed", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  const r = await tick(dbPath, at(A, "RED"), host(dir, { ...fileAnchor(dir), reserve: () => false }));
  const db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.equal("top" in order && order.top, 1);
  assert.match(r.log, /#42: entry 2 of its signed order couldn't be reserved on the host's anchor, so it isn't extended this tick/);
});

test("a copy of the store whose entry at the host's top names another record isn't current, and isn't extended", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  await tick(dbPath, at(A, "RED"), host(dir));
  let db = open(dbPath);
  const [, red] = digestsOf(db);
  db.close();
  assert.ok(red, "control: both records were kept");
  assert.equal(anchorRead(dir)?.named?.get(PR), red, "control: the anchor holds the record entry 2 names");
  // Another copy of the store, holding the same identity, signed another record
  // as entry 2 and noted it: this copy's entry 2 is no longer the host's.
  rewrite(dir, (a) => { a.named["42"] = "f".repeat(64); });
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  const replayed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  const why = new RegExp(`entry 2 of its signed order names record ${red.slice(0, 12)}, though this host noted record ffffffffffff there`);
  assert.match(String(shown), new RegExp(`can't be trusted as the latest: ${why.source}`));
  assert.ok(replayed.some((x) => x.outcome === "unreplayable" && why.test(String(x.why))), JSON.stringify(replayed));
  // Said every tick, though the pull request isn't judged again.
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, new RegExp(`#42: ${why.source}, so it isn't extended`));
  await tick(dbPath, at(B), host(dir));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, keys);
  db.close();
  assert.equal("top" in order && order.top, 2, "not extended past it");
});

test("an entry reserved for a record the store doesn't hold stops its order, and is said", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  // Reserved, as a copy of the store that kept another record would have.
  rewrite(dir, (a) => { a.reserved = { 42: reservedAs({ n: 2, digest: "f".repeat(64) }) }; });
  const r = await tick(dbPath, null, host(dir));
  await tick(dbPath, at(A, "RED"), host(dir));
  const keys = knownKeys({ local: dir });
  const db = open(dbPath);
  const order = signedOrder(db, REPO, PR, keys);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.equal("top" in order && order.top, 1, "no other record is signed under the reserved number");
  assert.match(r.log, /#42: this host reserved entry 2 of its signed order for record ffffffffffff, which this store doesn't hold, so it isn't extended/);
  assert.match(String(shown), /reserved entry 2 of its signed order for record ffffffffffff, which its order doesn't hold yet, and the store doesn't hold that record/);
});

test("an entry reserved and never committed is completed for the record it was reserved for", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  await tick(dbPath, at(A, "RED"), host(dir));
  let db = open(dbPath);
  const [green, red] = digestsOf(db);
  const two = entryOf(db, 2);
  assert.ok(red && two, "control: entry 2 was kept");
  // As a reeve that stopped after reserving entry 2 and before committing it
  // would have left it: the record kept, the entry not.
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  const sealOne = entryOf(db, 1);
  db.close();
  rewrite(dir, (a) => { a.latest["42"] = 1; a.named["42"] = green; a.sealed["42"] = sealOf(sealOne); a.chained["42"] = chainTo(sealOne); a.reserved = { 42: reservedAs(two) }; });
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.match(String(shown), new RegExp(`reserved entry 2 of its signed order for record ${red.slice(0, 12)}, which its order doesn't hold yet, until a reeve completes it`));
  // Judged green again since: the entry is still the reserved record's.
  await tick(dbPath, at(A), host(dir));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, keys);
  db.close();
  assert.ok("entries" in order, JSON.stringify(order));
  assert.equal(order.entries.get(2), red, "entry 2 names the record it was reserved for");
  assert.equal(order.seals?.get(2), sealOf(two), "and is the entry reserved, whole");
  const a = anchorRead(dir);
  assert.equal(a?.reserved?.size, 0, "and the reservation is noted");
  assert.equal(a?.latest?.get(PR), order.top);
});

test("a record kept is pinned on the host's anchor, and unpinned once an entry names it", async () => {
  const dir = credentials();
  const dbPath = store();
  const real = fileAnchor(dir);
  /** @type {string[]} */ const pinned = [];
  const anchor = { ...real, pin: (/** @type {any[]} */ ...args) => { pinned.push(...args[3]); return real.pin(...args); } };
  // The same again on the third: a record the store holds already.
  await ticks(dbPath, [at(A), at(B), at(B)], host(dir, anchor));
  const db = open(dbPath);
  const [first, second] = digestsOf(db);
  const kept = digestsOf(db).length;
  db.close();
  assert.equal(kept, 2, "control: the third tick kept no new record");
  assert.deepEqual(pinned, [first, second], "each record new to the store, once; not one seen again");
  assert.equal(anchorRead(dir)?.pinned?.size, 0, "and none stays pinned once ordered");
});

test("a record pinned and taken away before a reeve ordered it is said by the tick, why and replay", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  // Kept, and not ordered: a reeve whose reservations fail orders nothing.
  await tick(dbPath, at(A, "RED"), host(dir, { ...fileAnchor(dir), reserve: () => false }));
  let db = open(dbPath);
  const [, red] = digestsOf(db);
  assert.deepEqual(anchorRead(dir)?.pinned?.get(PR), new Set([red]), "control: pinned, not ordered");
  db.prepare("DELETE FROM decision WHERE digest = ?").run(red);
  db.close();
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  const replayed = replayDecisions(db, {}, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  const why = new RegExp(`this host kept record ${red.slice(0, 12)} for it, which the store no longer holds and no entry of its signed order names: taken away`);
  assert.match(String(shown), why);
  assert.ok(replayed.some((x) => x.pr === PR && x.outcome === "unreplayable" && why.test(String(x.why))), JSON.stringify(replayed));
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, new RegExp(`#42: this host kept 1 record\\(s\\) that this store no longer holds, and no entry of its signed order names: they were taken away, or a reeve stopped before its store committed them — ${red.slice(0, 12)}`));
});

// ── #281: the first baseline ─────────────────────────────────────────────────

test("a store's first baseline binds the host's anchor to it, so one stripped afterwards isn't given a baseline again", async () => {
  const dir = credentials();
  const dbPath = store();
  // A record kept before this host signed anything.
  await tick(dbPath, at(A));
  // Signing begins, and the reeve stops before any order is extended: here, one
  // whose reservations fail, which extends none.
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), reserve: () => false }));
  let db = open(dbPath);
  const id = storeIdentity(db);
  db.close();
  const a = anchorRead(dir);
  assert.deepEqual({ store: a?.store, began: a?.began, pending: a?.pending }, { store: id, began: true, pending: null }, "bound as its baseline was made");
  db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op = 'signing.baseline'").run();
  db.prepare("DELETE FROM decision").run();
  db.close();
  const r = await tick(dbPath, null, host(dir));
  assert.equal(baselines(dbPath), 0, "no baseline made over what was left");
  assert.match(r.log, /the host's anchor says this store began signing, though it holds no baseline or signed record/);
});

test("a store stripped between its first baseline and its binding isn't given a baseline again", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  await tick(dbPath, at(A, "RED"));
  // A reeve that stops once the baseline has committed, before the binding.
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), bind: () => false }));
  assert.equal(baselines(dbPath), 1, "control: the baseline committed");
  assert.equal(anchorRead(dir)?.store, null, "control: the anchor wasn't bound");
  assert.ok(anchorRead(dir)?.pending, "control: its binding was begun");
  let db = open(dbPath);
  const [green] = digestsOf(db);
  db.prepare("DELETE FROM event WHERE op = 'signing.baseline'").run();
  db.prepare("DELETE FROM decision WHERE digest = ?").run(green);
  db.close();
  const r = await tick(dbPath, null, host(dir));
  assert.equal(baselines(dbPath), 0, "no baseline made over what was left");
  assert.match(r.log, /the host's anchor for o\/r was being bound to this store, holding other records than it holds now: records were taken away, or the store restored from before/);
  assert.match(r.log, /the host's anchor was being bound to a store holding a baseline this one doesn't hold, so the host's anchor for o\/r isn't bound to this store/, "and why it isn't bound");
  assert.equal(anchorRead(dir)?.store, null, "nor is it bound");
});

test("a binding begun is finished once its store holds that baseline, after a stop before binding", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), bind: () => false }));
  assert.equal(anchorRead(dir)?.store, null, "control: the anchor wasn't bound");
  await tick(dbPath, null, host(dir));
  const db = open(dbPath);
  const id = storeIdentity(db);
  db.close();
  const a = anchorRead(dir);
  assert.deepEqual({ store: a?.store, pending: a?.pending }, { store: id, pending: null });
});

test("a store whose baseline changed after its binding was begun isn't bound", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), bind: () => false }));
  // Restored to another baseline, over none of its records, signed by this host all the same.
  let db = open(dbPath);
  const other = fileSigner(dir)(baselineStatement([]));
  db.prepare("UPDATE event SET payload = ? WHERE op = 'signing.baseline'").run(JSON.stringify({ digests: [], envelope: other.envelope }));
  db.close();
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, /this store's baseline isn't the one its binding was begun with: the store was restored from before, or its baseline changed, so the host's anchor for o\/r isn't bound to this store/);
  assert.equal(anchorRead(dir)?.store, null);
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const whole = replayDecisions(db, {}, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.ok(whole.some((x) => /the host's anchor was being bound to this store, holding other records than it holds now/.test(String(x.why))), JSON.stringify(whole));
});

test("a binding begun before the baseline committed is finished for its store, with the identity it was begun with", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  let db = open(dbPath);
  const digests = db.prepare("SELECT digest FROM decision ORDER BY digest").all().map((r) => r.digest);
  db.close();
  // As a reeve that stopped after writing the binding and before its store
  // committed the baseline and identity would have left it.
  assert.equal(fileAnchor(dir).pending(REPO, ID, digests), true);
  await tick(dbPath, null, host(dir));
  db = open(dbPath);
  const id = storeIdentity(db);
  db.close();
  assert.equal(id, ID, "the store takes the identity its binding was begun with");
  assert.equal(baselines(dbPath), 1);
  assert.equal(anchorRead(dir)?.store, ID);
});

test("a binding begun for other records than the store holds makes no baseline", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  assert.equal(fileAnchor(dir).pending(REPO, ID, ["f".repeat(64)]), true);
  const r = await tick(dbPath, null, host(dir));
  assert.equal(baselines(dbPath), 0);
  assert.match(r.log, /was being bound to this store, holding other records than it holds now/);
  assert.equal(anchorRead(dir)?.store, null);
  const db = open(dbPath);
  const id = storeIdentity(db);
  db.close();
  assert.equal(id, null, "and no identity is made for it, as another tick would take one it wasn't begun with");
});

test("a baseline over no record binds the host's anchor at the store's first order, not before", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, null, host(dir));
  assert.equal(baselines(dbPath), 1, "control: signing began");
  assert.equal(anchorRead(dir)?.store ?? null, null, "a store that judges nothing takes no anchor");
  await tick(dbPath, at(A), host(dir));
  const db = open(dbPath);
  const id = storeIdentity(db);
  db.close();
  assert.equal(anchorRead(dir)?.store, id, "bound once it has an order to extend");
});

test("a store ahead of the host's anchor, its entry naming another record than the one reserved, isn't current", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  await tick(dbPath, at(A, "RED"), host(dir));
  let db = open(dbPath);
  const [green, red] = digestsOf(db);
  db.close();
  assert.ok(red, "control: both records were kept");
  // The anchor stopped before noting entry 2, and holds it reserved for another record.
  rewrite(dir, (a) => { a.latest["42"] = 1; a.named["42"] = green; delete a.sealed["42"]; delete a.chained["42"]; a.reserved = { 42: reservedAs({ n: 2, digest: "f".repeat(64) }) }; });
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, new RegExp(`#42: its signed order ends at entry 2, naming record ${red.slice(0, 12)}, though this host reserved entry 2 for record ffffffffffff, so it isn't extended`));
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.match(String(shown), new RegExp(`entry 2 of its signed order names record ${red.slice(0, 12)}, though this host reserved it for record ffffffffffff`));
  assert.equal(anchorRead(dir)?.latest?.get(PR), 1, "and the anchor isn't moved to it");
});

test("replay reports a pull request the host's anchor holds only a pin or a reservation for", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  const db = open(dbPath);
  const id = storeIdentity(db);
  db.close();
  // #7 was kept and pinned, and #9 had an entry reserved, and neither ordered: both taken away.
  assert.equal(fileAnchor(dir).pin(REPO, String(id), 7, [D1]), true);
  assert.equal(fileAnchor(dir).reserve(REPO, String(id), 9, 1, D2), true);
  const keys = knownKeys({ local: dir });
  const ro = open(dbPath);
  const replayed = replayDecisions(ro, {}, { keys, repo: REPO, anchor: anchorFor(ro, dir) });
  ro.close();
  assert.ok(replayed.some((x) => x.pr === 7 && /this host kept record 111111111111 for it, which the store no longer holds/.test(String(x.why))), JSON.stringify(replayed));
  assert.ok(replayed.some((x) => x.pr === 9 && /reserved entry 1 of its signed order for record 222222222222/.test(String(x.why))), JSON.stringify(replayed));
});

test("a binding begun for another store isn't finished for this one", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), bind: () => false }));
  rewrite(dir, (a) => { a.pending = { ...(a.pending ?? {}), store: OTHER }; });
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, /the host's anchor was being bound to another store, so the host's anchor for o\/r isn't bound to this store/);
  assert.equal(anchorRead(dir)?.store, null);
});

test("a store that lost a record its baseline names, with its binding begun, isn't bound", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  await tick(dbPath, at(A, "RED"));
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), bind: () => false }));
  const db = open(dbPath);
  const [green] = digestsOf(db);
  db.prepare("DELETE FROM decision WHERE digest = ?").run(green);
  db.close();
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, /this store no longer holds 1 record\(s\) its baseline names: they were taken away, so the host's anchor for o\/r isn't bound to this store/);
  assert.equal(anchorRead(dir)?.store, null);
});

test("the host's anchor holds the binding before the store commits its first baseline", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  const real = fileAnchor(dir);
  /** @type {number[]} */ const seen = [];
  const anchor = { ...real, pending: (/** @type {any[]} */ ...args) => { seen.push(baselines(dbPath)); return real.pending(...args); } };
  await tick(dbPath, null, host(dir, anchor));
  assert.deepEqual(seen, [0], "written once, while the store held no baseline");
  assert.equal(baselines(dbPath), 1);
});

test("a store's first baseline waits for a tick that holds the host's lock on the anchor", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  const other = fileAnchor(dir).lock(REPO);
  assert.ok(other && "release" in other, "control: the lock was taken");
  try { await tick(dbPath, null, host(dir)); } finally { other.release(); }
  assert.equal(baselines(dbPath), 0, "no baseline made, as its binding couldn't be begun");
  await tick(dbPath, null, host(dir));
  assert.equal(baselines(dbPath), 1, "control: made once the lock is free");
});

test("a record the host's anchor may pin is kept synced to disk", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  let durableKeeps = 0;
  const durably = (/** @type {any} */ db, /** @type {() => any} */ fn) => {
    const before = db.prepare("SELECT count(*) AS n FROM decision").get().n;
    const was = db.prepare("PRAGMA synchronous").get().synchronous;
    db.exec("PRAGMA synchronous = FULL");
    try { return fn(); }
    finally { db.exec(`PRAGMA synchronous = ${was}`); if (db.prepare("SELECT count(*) AS n FROM decision").get().n > before) durableKeeps++; }
  };
  await tick(dbPath, at(A, "RED"), { ...host(dir), durably });
  assert.ok(durableKeeps >= 1, "the new record was kept in a synced transaction");
});


test("an entry reserved for the record its order already ends at is completed, though nothing else is new", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  let db = open(dbPath);
  const [green] = digestsOf(db);
  db.close();
  // Reserved to name the latest again, seen at another place in the store's
  // events, and naming nothing else.
  rewrite(dir, (a) => { a.reserved = { 42: reservedAs({ n: 2, digest: green, records: [], seq: 1 }) }; });
  await tick(dbPath, null, host(dir));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  const id = storeIdentity(db);
  db.close();
  assert.ok("entries" in order && order.entries.get(2) === green, JSON.stringify(order));
  assert.equal(order.seals?.get(2), sealOf({ repo: REPO, n: 2, digest: green, records: [], store: id, seq: 1 }), "completed whole, as it was reserved");
  assert.equal(anchorRead(dir)?.reserved?.size, 0, "and its reservation doesn't stand for good");
});

test("an entry reserved naming a record the store no longer holds is completed naming it", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  let db = open(dbPath);
  const [green] = digestsOf(db);
  db.close();
  // Reserved naming a record kept since and taken away before the entry was committed.
  rewrite(dir, (a) => { a.reserved = { 42: reservedAs({ n: 2, digest: green, records: ["f".repeat(64)], seq: 1 }) }; });
  await tick(dbPath, null, host(dir));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  const id = storeIdentity(db);
  db.close();
  assert.equal(order.seals?.get(2), sealOf({ repo: REPO, n: 2, digest: green, records: ["f".repeat(64)], store: id, seq: 1 }), "completed whole, the record it names included");
  assert.ok("digests" in order && order.digests.has("f".repeat(64)), "so its loss shows");
});

test("a pull request reached only to unpin what its order names takes no new entry", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  let db = open(dbPath);
  const [green] = digestsOf(db);
  db.close();
  // Pinned again, as a reeve that stopped before its note would have left it.
  rewrite(dir, (a) => { a.pinned = { 42: [green] }; });
  await tick(dbPath, null, host(dir));
  await tick(dbPath, null, host(dir));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.equal("top" in order && order.top, 1, "no entry signed where nothing changed");
  assert.equal(anchorRead(dir)?.pinned?.size, 0, "and it's unpinned");
});

test("the first record a store keeps binds the host's anchor and is pinned, though no order is extended", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir, { ...fileAnchor(dir), reserve: () => false }));
  const db = open(dbPath);
  const id = storeIdentity(db);
  const [green] = digestsOf(db);
  db.close();
  assert.equal(anchorRead(dir)?.store, id, "bound to the store that kept it");
  assert.deepEqual(anchorRead(dir)?.pinned?.get(PR), new Set([green]), "and it's pinned");
});

test("why says a pull request's only record, pinned or reserved on the host's anchor, is gone", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  let db = open(dbPath);
  const id = String(storeIdentity(db));
  db.close();
  assert.equal(fileAnchor(dir).pin(REPO, id, 7, [D1]), true);
  assert.equal(fileAnchor(dir).reserve(REPO, id, 9, 1, D2), true);
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const seven = explainDecision(db, 7, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  const nine = explainDecision(db, 9, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.match(String(seven), /the store holds no decision record for it, though this host kept record 111111111111 for it, which the store no longer holds/);
  assert.match(String(nine), /the store holds no decision record for it, though this host reserved entry 1 of its signed order for record 222222222222/);
});

test("a store whose baseline isn't signed by a key this host knows doesn't bind the host's anchor", async () => {
  const dir = credentials();
  const dbPath = store();
  const db = open(dbPath);
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(1, "daemon", "signing.baseline", "store", JSON.stringify({ digests: ["f".repeat(64)], envelope: "forged" }));
  db.close();
  const r = await tick(dbPath, null, host(dir));
  assert.equal(anchorRead(dir)?.store ?? null, null);
  assert.match(r.log, /this store's baseline doesn't hold.*, so the host's anchor for o\/r isn't bound to this store/);
});

test("a store whose signed baseline names a record it no longer holds doesn't bind the host's anchor", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  await tick(dbPath, at(A, "RED"));
  let db = open(dbPath);
  const digests = db.prepare("SELECT digest FROM decision ORDER BY digest").all().map((x) => x.digest);
  // A baseline made before #281, signed by this host, with no binding begun.
  const s = fileSigner(dir)(baselineStatement(digests));
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(2, "daemon", "signing.baseline", "store", JSON.stringify({ digests: baselineStatement(digests).predicate.digests, envelope: s.envelope }));
  db.prepare("DELETE FROM decision WHERE digest = ?").run(digests[0]);
  db.close();
  const r = await tick(dbPath, null, host(dir));
  assert.equal(anchorRead(dir)?.store ?? null, null);
  assert.match(r.log, /this store no longer holds 1 record\(s\) its baseline names: they were taken away, so the host's anchor for o\/r isn't bound to this store/);
});

test("a reeve with no keys to check a baseline with binds no anchor, and says so", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  let r;
  try { r = await tick(dbPath, null, { ...host(dir), keys: () => null }); } catch (e) { r = { log: `the tick threw: ${e}` }; }
  assert.equal(anchorRead(dir)?.store ?? null, null);
  assert.match(r.log, /there are no keys to check its baseline with, so the host's anchor for o\/r isn't bound to this store/);
});

test("a pinned or reserved record moved to another pull request, or changed, isn't held for its own", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  await tick(dbPath, at(A, "RED"), host(dir, { ...fileAnchor(dir), reserve: () => false }));
  let db = open(dbPath);
  const [green, red] = digestsOf(db);
  assert.ok(red, "control: both records were kept");
  // The pinned record moved to #43; and entry 2 reserved for it, as a stop would leave it.
  db.prepare("UPDATE decision SET pr = 43 WHERE digest = ?").run(red);
  db.close();
  rewrite(dir, (a) => { a.reserved = { 42: reservedAs({ n: 2, digest: red }) }; });
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const replayed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.ok(replayed.some((x) => new RegExp(`this host kept record ${red.slice(0, 12)} for it, which the store no longer holds`).test(String(x.why))), JSON.stringify(replayed));
  assert.match(String(shown), new RegExp(`reserved entry 2 of its signed order for record ${red.slice(0, 12)}, which its order doesn't hold yet, and the store doesn't hold that record`));
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, new RegExp(`#42: this host reserved entry 2 of its signed order for record ${red.slice(0, 12)}, which this store doesn't hold, so it isn't extended`));
  assert.match(r.log, new RegExp(`#42: this host kept 1 record\\(s\\) that this store no longer holds, and no entry of its signed order names: they were taken away, or a reeve stopped before its store committed them — ${red.slice(0, 12)}`));
  // And one changed in place is no more held than one moved.
  db = open(dbPath);
  db.prepare("UPDATE decision SET pr = 42, record = json_set(record, '$.verdict.state', 'PASS') WHERE digest = ?").run(red);
  const changed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.ok(changed.some((x) => new RegExp(`this host kept record ${red.slice(0, 12)} for it, which the store no longer holds`).test(String(x.why))), JSON.stringify(changed));
  void green;
});

const QUEUED = "c".repeat(40), QBASE = "d".repeat(40);
/** The queue holding #42 at QUEUED, and its commit judged from the pull request's input. */
const inQueue = {
  readQueue: () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: QUEUED, baseSha: QBASE, state: "AWAITING_CHECKS" }] }),
  evaluateQueue: (/** @type {any} */ { entry, input }) => { const i = { ...input, head: entry.sha }; return { ok: true, input: i, verdict: computeVerdict(i) }; },
};

test("a record is pinned on the host's anchor before the store commits it, at a head and on the queue's commit", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  const real = fileAnchor(dir);
  /** @type {{ digest: string, held: boolean }[]} */ const pins = [];
  const anchor = { ...real, pin: (/** @type {any[]} */ ...args) => {
    const db = open(dbPath);
    for (const d of args[3]) pins.push({ digest: d, held: Boolean(db.prepare("SELECT 1 FROM decision WHERE digest = ?").get(d)) });
    db.close();
    return real.pin(...args);
  } };
  await tick(dbPath, at(A, "RED"), { ...host(dir, anchor), ...inQueue });
  const db = open(dbPath);
  const kept = db.prepare("SELECT digest, head FROM decision WHERE pr = ? ORDER BY first_seq").all(PR);
  db.close();
  const queued = kept.find((k) => k.head === QUEUED)?.digest;
  assert.ok(queued, `control: the queue's commit was judged: ${JSON.stringify(kept)}`);
  assert.ok(pins.some((p) => p.digest === queued), `the queue's record pinned: ${JSON.stringify(pins)}`);
  assert.ok(pins.length >= 2 && pins.every((p) => !p.held), `each pinned while the store didn't hold it yet: ${JSON.stringify(pins)}`);
});

test("a record whose commit fails is unpinned, at a head and on the queue's commit", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  const real = fileAnchor(dir);
  /** @type {string[]} */ const pinned = [];
  const anchor = { ...real, pin: (/** @type {any[]} */ ...args) => { pinned.push(...args[3]); return real.pin(...args); } };
  // Every record's commit fails, as on a full disk, and nothing else's.
  const durably = (/** @type {any} */ db, /** @type {() => any} */ fn) => {
    db.exec("CREATE TEMP TRIGGER IF NOT EXISTS no_room BEFORE INSERT ON decision BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    try { return fn(); } finally { db.exec("DROP TRIGGER IF EXISTS temp.no_room"); }
  };
  await tick(dbPath, at(A, "RED"), { ...host(dir, anchor), ...inQueue, durably });
  assert.ok(pinned.length >= 2, `control: the head's and the queue's records were pinned: ${JSON.stringify(pinned)}`);
  assert.equal(anchorRead(dir)?.pinned?.size, 0, "and unpinned once their commits failed");
});

test("a whole-store replay says a binding begun for other records than the store holds", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  await tick(dbPath, at(A, "RED"));
  // Stopped after the baseline committed and before the binding; then stripped of it, and one of its records.
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), bind: () => false }));
  let db = open(dbPath);
  const [green] = digestsOf(db);
  db.prepare("DELETE FROM event WHERE op = 'signing.baseline'").run();
  db.prepare("DELETE FROM decision WHERE digest = ?").run(green);
  db.close();
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const whole = replayDecisions(db, {}, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.ok(whole.some((x) => x.outcome === "unreplayable" && /the host's anchor was being bound to this store, holding other records than it holds now: records were taken away/.test(String(x.why))),
            JSON.stringify(whole));
  // Another store, of another identity, isn't the one being bound, and isn't said to be.
  const otherPath = store();
  await tick(otherPath, at(B));
  const o = open(otherPath);
  o.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(1, "daemon", "store.identity", "store", JSON.stringify({ id: OTHER }));
  const theirs = replayDecisions(o, {}, { keys, repo: REPO, anchor: { anchor: readAnchor(dir, REPO), why: null } });
  o.close();
  assert.ok(!theirs.some((x) => /was being bound to this store/.test(String(x.why))), JSON.stringify(theirs));
});


// ── #299's third review ──────────────────────────────────────────────────────

test("a record that can't be pinned on the host's anchor isn't kept, and is kept when its pull request is judged again", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  const r = await tick(dbPath, at(A, "RED"), host(dir, { ...fileAnchor(dir), pin: () => false }));
  let db = open(dbPath);
  const kept = digestsOf(db).length;
  db.close();
  assert.equal(kept, 1, "the verdict's record isn't kept, as nothing would show it was, taken away before an entry named it");
  assert.match(r.log, /#42: its decision record isn't kept this tick, as it couldn't be pinned on the host's anchor — the host's anchor couldn't be written/);
  await tick(dbPath, at(A, "RED"), host(dir));
  db = open(dbPath);
  const [, red] = digestsOf(db);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.ok(red && "digest" in order && order.digest === red, `kept and ordered once it could be pinned: ${JSON.stringify(order)}`);
});

test("a first record whose binding of the host's anchor can't be written isn't kept", async () => {
  const dir = credentials();
  const dbPath = store();
  // A baseline over no record, so the store's first record binds the anchor.
  await tick(dbPath, null, host(dir));
  const r = await tick(dbPath, at(A), host(dir, { ...fileAnchor(dir), bind: () => false }));
  const db = open(dbPath);
  const kept = digestsOf(db).length;
  db.close();
  assert.equal(kept, 0);
  assert.match(r.log, /#42: its decision record isn't kept this tick, as it couldn't be pinned on the host's anchor — the host's anchor couldn't be bound to this store/);
});

/** A store holding a record kept before signing began, and a baseline over it made before #281, signed by this host, with no identity or binding. */
const olderStore = async (dir) => {
  const dbPath = store();
  await tick(dbPath, at(A));
  const db = open(dbPath);
  const digests = db.prepare("SELECT digest FROM decision ORDER BY digest").all().map((x) => x.digest);
  const s = fileSigner(dir)(baselineStatement(digests));
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(2, "daemon", "signing.baseline", "store", JSON.stringify({ digests: baselineStatement(digests).predicate.digests, envelope: s.envelope }));
  db.close();
  return dbPath;
};

test("an older store's identity is committed only once the host's anchor holds the binding begun for it", async () => {
  const dir = credentials();
  const dbPath = await olderStore(dir);
  const real = fileAnchor(dir);
  /** @type {(string | null)[]} */ const seen = [];
  const anchor = { ...real, pending: (/** @type {any[]} */ ...args) => { const db = open(dbPath); seen.push(storeIdentity(db)); db.close(); return real.pending(...args); } };
  await tick(dbPath, null, host(dir, anchor));
  const db = open(dbPath);
  const id = storeIdentity(db);
  db.close();
  assert.deepEqual(seen.slice(0, 1), [null], "the binding was begun while the store held no identity");
  assert.equal(anchorRead(dir)?.store, id, "control: bound");
});

test("an older store whose binding can't be begun on the host's anchor takes no identity", async () => {
  const dir = credentials();
  const dbPath = await olderStore(dir);
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), pending: () => false }));
  const db = open(dbPath);
  const id = storeIdentity(db);
  db.close();
  assert.equal(id, null, "none made, by the binding or by ordering");
  assert.equal(anchorRead(dir)?.store ?? null, null);
});

test("a whole-store replay says a binding begun over a baseline whose signature doesn't hold", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  // Stopped after the baseline committed and before the binding; then its envelope forged, its records as they were.
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), bind: () => false }));
  assert.ok(anchorRead(dir)?.pending, "control: its binding was begun");
  let db = open(dbPath);
  db.prepare("UPDATE event SET payload = json_set(payload, '$.envelope', 'forged') WHERE op = 'signing.baseline'").run();
  db.close();
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const whole = replayDecisions(db, {}, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.ok(whole.some((x) => x.outcome === "unreplayable" && /the host's anchor was being bound to this store, and its baseline doesn't hold/.test(String(x.why))), JSON.stringify(whole));
});

/** Entry 2 of #42's order in the store at `dbPath`, re-signed by this host naming `records` besides its record: what a copy of the store would hold. */
const resign = (dbPath, dir, records) => {
  const db = open(dbPath);
  const e = entryOf(db, 2);
  const s = fileSigner(dir)(latestStatement({ repo: e.repo, pr: PR, n: 2, digest: e.digest, records, store: e.store, seq: e.seq }));
  db.prepare("UPDATE event SET payload = ? WHERE op = 'decision.latest' AND subject = ? AND json_extract(payload, '$.n') = 2")
    .run(JSON.stringify({ ...e, records, envelope: s.envelope }), `pr:${PR}`);
  db.close();
};

test("a copy of the store whose entry at the host's top names that record and others isn't current, and isn't extended", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  await tick(dbPath, at(A, "RED"), host(dir));
  let db = open(dbPath);
  const [, red] = digestsOf(db);
  db.close();
  assert.ok(anchorRead(dir)?.sealed?.get(PR), "control: the anchor holds entry 2's seal");
  resign(dbPath, dir, ["f".repeat(64)]);
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  const replayed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  const why = new RegExp(`entry 2 of its signed order names record ${red.slice(0, 12)}, as this host noted, but isn't the entry this host noted there`);
  assert.match(String(shown), new RegExp(`can't be trusted as the latest: ${why.source}`));
  assert.ok(replayed.some((x) => x.outcome === "unreplayable" && why.test(String(x.why))), JSON.stringify(replayed));
  // Said every tick, though the pull request isn't judged again.
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, new RegExp(`#42: ${why.source}, so it isn't extended`));
  await tick(dbPath, at(B), host(dir));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, keys);
  db.close();
  assert.equal("top" in order && order.top, 2, "not extended past it");
});

test("a store ahead of the host's anchor, its entry naming the reserved record and other records, isn't current", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  await tick(dbPath, at(A, "RED"), host(dir));
  let db = open(dbPath);
  const [green, red] = digestsOf(db);
  const one = entryOf(db, 1), two = entryOf(db, 2);
  db.close();
  assert.ok(red && one && two, "control: both entries were kept");
  // The anchor stopped before noting entry 2, reserved for it naming another record besides.
  rewrite(dir, (a) => { a.latest["42"] = 1; a.named["42"] = green; a.sealed["42"] = sealOf(one); a.chained["42"] = chainTo(one); a.reserved = { 42: reservedAs({ ...two, records: ["f".repeat(64)] }) }; });
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, new RegExp(`#42: its signed order ends at entry 2, naming record ${red.slice(0, 12)}, as this host reserved it, but isn't the entry this host reserved, so it isn't extended`));
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.match(String(shown), new RegExp(`entry 2 of its signed order names record ${red.slice(0, 12)}, as this host reserved it, but isn't the entry this host reserved`));
  assert.equal(anchorRead(dir)?.latest?.get(PR), 1, "and the anchor isn't moved to it");
});

/** A tick's `durably`, as on a disk that filled: every baseline's commit fails. */
const noBaseline = (/** @type {any} */ db, /** @type {() => any} */ fn) => {
  db.exec("CREATE TEMP TRIGGER IF NOT EXISTS no_baseline BEFORE INSERT ON event WHEN NEW.op = 'signing.baseline' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
  try { return fn(); } finally { db.exec("DROP TRIGGER IF EXISTS temp.no_baseline"); }
};

test("a binding begun whose baseline didn't commit keeps no record until it does, and is finished then", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  const r = await tick(dbPath, at(A, "RED"), { ...host(dir), durably: noBaseline });
  let db = open(dbPath);
  const kept = digestsOf(db).length;
  db.close();
  assert.equal(baselines(dbPath), 0, "control: the baseline didn't commit");
  assert.ok(anchorRead(dir)?.pending, "control: its binding was begun");
  assert.equal(kept, 1, "no record kept while the baseline waits: it couldn't be told from one put in the store by hand");
  assert.match(r.log, /#42: its decision record isn't kept this tick, as the store's first baseline hasn't landed since its binding was begun on the host's anchor/);
  await tick(dbPath, at(A, "RED"), host(dir));
  db = open(dbPath);
  const id = storeIdentity(db);
  const after = digestsOf(db).length;
  db.close();
  assert.equal(baselines(dbPath), 1, "the baseline is made");
  assert.deepEqual({ store: anchorRead(dir)?.store, pending: anchorRead(dir)?.pending }, { store: id, pending: null }, "and the anchor bound");
  assert.equal(after, 2, "and the record kept, once it has");
});

test("a record put in the store while a binding's baseline waited makes no baseline, and replay says so", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  await tick(dbPath, null, { ...host(dir), durably: noBaseline });
  assert.ok(anchorRead(dir)?.pending, "control: its binding was begun");
  // A record put in the store while no reeve with the host's key ran: whole, and unsigned.
  await tick(dbPath, at(A, "RED"));
  let db = open(dbPath);
  const kept = digestsOf(db).length;
  db.close();
  assert.equal(kept, 2, "control: it was put there");
  const r = await tick(dbPath, null, host(dir));
  assert.equal(baselines(dbPath), 0, "no baseline vouching for it");
  assert.match(r.log, /the host's anchor for o\/r was being bound to this store, holding other records than it holds now/);
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const whole = replayDecisions(db, {}, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.ok(whole.some((x) => /the host's anchor was being bound to this store, holding other records than it holds now/.test(String(x.why))), JSON.stringify(whole));
});

test("a binding begun over a record changed since makes no baseline", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  let db = open(dbPath);
  const digests = db.prepare("SELECT digest FROM decision ORDER BY digest").all().map((x) => x.digest);
  db.close();
  // Begun by a reeve that stopped before its baseline committed; then the record changed in place.
  assert.equal(fileAnchor(dir).pending(REPO, ID, digests), true);
  db = open(dbPath);
  db.prepare("UPDATE decision SET record = json_set(record, '$.verdict.state', 'BLOCK')").run();
  db.close();
  const r = await tick(dbPath, null, host(dir));
  assert.equal(baselines(dbPath), 0);
  assert.match(r.log, /was being bound to this store, holding other records than it holds now/);
  const keys = knownKeys({ local: dir });
  db = open(dbPath);
  const whole = replayDecisions(db, {}, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.ok(whole.some((x) => /was being bound to this store, holding other records than it holds now/.test(String(x.why))), JSON.stringify(whole));
});

// ── #299's fourth review ─────────────────────────────────────────────────────

test("a record whose pin was written, though its folder's sync failed after, is kept", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  const real = fileAnchor(dir);
  // The pin renamed into place, and the sync after it failing: the write answers false.
  const anchor = { ...real, pin: (/** @type {any[]} */ ...args) => { real.pin(...args); return false; } };
  await tick(dbPath, at(A, "RED"), host(dir, anchor));
  const db = open(dbPath);
  const [, red] = digestsOf(db);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.ok(red, "kept, as the pin reads on the anchor");
  assert.ok("digest" in order && order.digest === red, `and ordered: ${JSON.stringify(order)}`);
});

test("an anchor written before #279 has each pull request's top entry noted, with its record and seal, on the next tick", async () => {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  await tick(dbPath, at(A, "RED"), host(dir));
  let db = open(dbPath);
  const [, red] = digestsOf(db);
  const two = entryOf(db, 2);
  db.close();
  // As #278 wrote it: each pull request's top entry, and nothing of what it names.
  rewrite(dir, (a) => { a.named = {}; a.sealed = {}; a.chained = {}; });
  assert.equal(anchorRead(dir)?.sealed?.size, 0, "control: no seal");
  // Quiet: nothing new kept for it, nor judged.
  await tick(dbPath, null, host(dir));
  const a = anchorRead(dir);
  assert.equal(a?.named?.get(PR), red);
  assert.equal(a?.sealed?.get(PR), sealOf(two));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.equal("top" in order && order.top, 2, "and no entry added for it");
});

// ── #299's fifth review ──────────────────────────────────────────────────────

/** A store holding a record kept before signing began, and an identity that can't be read. */
const unreadableIdentity = async () => {
  const dbPath = store();
  await tick(dbPath, at(A));
  const db = open(dbPath);
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(1, "daemon", "store.identity", "store", "not an identity");
  db.close();
  return dbPath;
};

test("a store holding an identity that can't be read doesn't bind the host's anchor, nor begin a binding", async () => {
  const dir = credentials();
  const dbPath = await unreadableIdentity();
  const r = await tick(dbPath, null, host(dir));
  const a = anchorRead(dir);
  assert.equal(a?.store ?? null, null, "not bound to an identity made here, which the store would never read back");
  assert.equal(a?.pending ?? null, null, "nor a binding begun for one");
  assert.match(r.log, /this store holds an identity that can't be read, so the host's anchor for o\/r isn't bound to this store/);
});

test("a store whose binding was begun, holding an identity that can't be read, makes no baseline", async () => {
  const dir = credentials();
  const dbPath = await unreadableIdentity();
  let db = open(dbPath);
  const digests = db.prepare("SELECT digest FROM decision ORDER BY digest").all().map((x) => x.digest);
  db.close();
  assert.equal(fileAnchor(dir).pending(REPO, ID, digests), true);
  await tick(dbPath, null, host(dir));
  assert.equal(baselines(dbPath), 0);
  assert.equal(anchorRead(dir)?.store ?? null, null);
});

// ── #303: every entry of an order, not only its top ─────────────────────────

/** Entry `n` of #42's order signed again by this host, the same number and record, naming `records` besides: a copy's own variant. */
const resignAt = (/** @type {string} */ dbPath, /** @type {string} */ dir, /** @type {number} */ n, /** @type {string[]} */ records) => {
  const db = open(dbPath);
  const e = entryOf(db, n);
  const s = fileSigner(dir)(latestStatement({ repo: e.repo, pr: PR, n, digest: e.digest, records, store: e.store, seq: e.seq }));
  db.prepare("UPDATE event SET payload = ? WHERE op = 'decision.latest' AND subject = ? AND json_extract(payload, '$.n') = ?")
    .run(JSON.stringify({ ...e, records, envelope: s.envelope }), `pr:${PR}`, n);
  db.close();
};

test("the anchor keeps a chain over every entry it noted to its top, and never another for that top", () => {
  const dir = credentials();
  const an = fileAnchor(dir);
  const one = sealOf({ repo: REPO, n: 1, digest: D1, store: ID });
  const chain = signing.orderChain(new Map([[1, one]]), 1);
  assert.match(String(chain), /^[0-9a-f]{64}$/, "control: a chain is a digest");
  assert.equal(an.note(REPO, PR, 1, D1, [D1], one, chain), true);
  assert.equal(anchorRead(dir)?.chained?.get(PR), chain);
  assert.equal(an.note(REPO, PR, 1, D1, [D1], one, "e".repeat(64)), false, "not noted again over other entries");
  assert.equal(anchorRead(dir)?.chained?.get(PR), chain);
  assert.equal(an.note(REPO, PR, 2, D2, [D2]), true, "control: a later entry noted without one");
  assert.equal(anchorRead(dir)?.chained?.has(PR), false, "leaves none for it");
  // A chain is over each entry's seal in turn, so another earlier entry makes another chain.
  const two = sealOf({ repo: REPO, n: 2, digest: D2, store: ID });
  assert.notEqual(signing.orderChain(new Map([[1, one], [2, two]]), 2), signing.orderChain(new Map([[1, "f".repeat(64)], [2, two]]), 2));
  assert.equal(signing.orderChain(new Map([[2, two]]), 2), null, "nor is there one with an entry missing");
  assert.equal(an.note(REPO, PR, 3, D3, [D3], null, chain), false, "nor is a chain noted for an entry without its seal");
  // An anchor holding a chain for an entry it holds no seal of, or one that isn't a digest, isn't read.
  const bad = credentials();
  writeAnchor(bad, { began: true, latest: { 42: 1 }, store: ID, named: { 42: D1 }, sealed: {}, chained: { 42: chain } });
  assert.match(String(anchorRead(bad)?.unreadable), /isn't an anchor/);
  writeAnchor(bad, { began: true, latest: { 42: 1 }, store: ID, named: { 42: D1 }, sealed: { 42: one }, chained: { 42: "x" } });
  assert.match(String(anchorRead(bad)?.unreadable), /isn't an anchor/);
  writeAnchor(bad, { began: true, latest: { 42: 1 }, store: ID, named: { 42: D1 }, sealed: { 42: one }, chained: { 42: chain } });
  assert.equal(anchorRead(bad)?.chained?.get(PR), chain, "control: one whole reads");
});

test("an order whose entry before its top was swapped for another the host signed, its top as the host noted, isn't current, in the tick, why and replay", async () => {
  const dir = credentials();
  const dbPath = store();
  await ticks(dbPath, [at(A), at(A, "RED"), at(B)], host(dir));
  const keys = knownKeys({ local: dir });
  let db = open(dbPath);
  const before = signedOrder(db, REPO, PR, keys);
  db.close();
  assert.ok("top" in before && before.top === 3, `control: three entries: ${JSON.stringify(before)}`);
  assert.equal(anchorRead(dir)?.chained?.get(PR), signing.orderChain(/** @type {any} */ (before).seals, 3), "control: the anchor holds the chain to its top");
  // Entry 2 swapped for a variant this host's key signed, as a copy of the store might have; entry 3 left as it was.
  resignAt(dbPath, dir, 2, ["f".repeat(64)]);
  db = open(dbPath);
  const after = signedOrder(db, REPO, PR, keys);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  const replayed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.ok("seals" in after && after.seals.get(3) === /** @type {any} */ (before).seals.get(3), "control: its top entry is as the host noted it");
  const why = /its signed order to entry 3 isn't the one this host noted, though entry 3 is: an entry before it was swapped for another, as a copy of this store signed/;
  assert.match(String(shown), new RegExp(`can't be trusted as the latest: ${why.source}`));
  assert.ok(replayed.some((x) => x.outcome === "unreplayable" && why.test(String(x.why))), JSON.stringify(replayed));
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, new RegExp(`#42: ${why.source}, so it isn't extended`));
  await tick(dbPath, at(B, "RED"), host(dir));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, keys);
  db.close();
  assert.equal("top" in order && order.top, 3, "not extended past it");
});

test("an anchor written before its entries were chained has them chained on the next tick, and a swap after is caught", async () => {
  const dir = credentials();
  const dbPath = store();
  await ticks(dbPath, [at(A), at(A, "RED"), at(B)], host(dir));
  // As an anchor written before this: no chain.
  rewrite(dir, (a) => { delete a.chained; });
  assert.equal(anchorRead(dir)?.chained?.has(PR), false, "control: no chain");
  await tick(dbPath, null, host(dir));
  const keys = knownKeys({ local: dir });
  let db = open(dbPath);
  const order = signedOrder(db, REPO, PR, keys);
  db.close();
  assert.equal(anchorRead(dir)?.chained?.get(PR), signing.orderChain(/** @type {any} */ (order).seals, 3), "chained from the store's order as it checks");
  resignAt(dbPath, dir, 1, ["f".repeat(64)]);
  db = open(dbPath);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.match(String(shown), /its signed order to entry 3 isn't the one this host noted, though entry 3 is/);
});

// ── #304: records kept before #299 ───────────────────────────────────────────

/** A store whose second record of #42 was kept as a reeve before #299 kept it: not pinned, and, its reservations failing, not ordered. */
async function keptUnpinned() {
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A), host(dir));
  await tick(dbPath, at(A, "RED"), host(dir, { ...fileAnchor(dir), pin: () => true, reserve: () => false }));
  const db = open(dbPath);
  const [green, red] = digestsOf(db);
  db.close();
  return { dir, dbPath, green, red };
}

test("a record kept before #299 that no order names is pinned on the host's anchor by the next tick, before a pull request is judged", async () => {
  const { dir, dbPath, red } = await keptUnpinned();
  assert.equal(anchorRead(dir)?.pinned?.get(PR)?.has(red) ?? false, false, "control: kept unpinned");
  /** @type {boolean | null} */ let atJudging = null;
  // Its reservations failing still, so nothing orders it and unpins it after.
  const r = await tick(dbPath, at(A, "RED"), { ...host(dir, { ...fileAnchor(dir), reserve: () => false }),
    evaluate: () => { atJudging ??= anchorRead(dir)?.pinned?.get(PR)?.has(red) ?? false; return at(A, "RED"); } });
  assert.equal(atJudging, true, "pinned before the pull request was judged");
  assert.ok(anchorRead(dir)?.pinned?.get(PR)?.has(red), "and still pinned, unordered");
  assert.match(r.log, /signing: pinned 1 record\(s\) this store holds that no signed order or baseline names, kept before records were pinned/);
});

test("a record kept before #299, pinned since, and taken away while no reeve ran, is said by the tick", async () => {
  const { dir, dbPath, red } = await keptUnpinned();
  await tick(dbPath, null, host(dir, { ...fileAnchor(dir), reserve: () => false }));
  let db = open(dbPath);
  db.prepare("DELETE FROM decision WHERE digest = ?").run(red);
  db.close();
  const r = await tick(dbPath, null, host(dir));
  assert.match(r.log, new RegExp(`#42: this host kept 1 record\\(s\\) that this store no longer holds, and no entry of its signed order names: they were taken away, or a reeve stopped before its store committed them — ${red.slice(0, 12)}`));
  db = open(dbPath);
  db.close();
});

test("a record a signed order or the store's baseline names, or one that doesn't hold as it was kept, isn't pinned", async () => {
  // Two records kept before the store began signing, which its baseline names, and no order yet: its reservations fail.
  const dir = credentials();
  const dbPath = store();
  await tick(dbPath, at(A));
  await tick(dbPath, at(A, "RED"));
  const refusing = () => host(dir, { ...fileAnchor(dir), reserve: () => false });
  await tick(dbPath, null, refusing());
  let db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.ok("top" in order && order.top === 0, `control: no order names them: ${JSON.stringify(order)}`);
  assert.equal(anchorRead(dir)?.store, (() => { const d = open(dbPath); const id = storeIdentity(d); d.close(); return id; })(), "control: the anchor is this store's");
  await tick(dbPath, null, refusing());
  assert.deepEqual([...(anchorRead(dir)?.pinned?.get(PR) ?? [])], [], "neither pinned: the baseline names them");
  // One kept unpinned and unordered, then changed in place: not this host's record as it was kept.
  const kept = await keptUnpinned();
  db = open(kept.dbPath);
  db.prepare("UPDATE decision SET record = json_set(record, '$.subject.pr', 9) WHERE digest = ?").run(kept.red);
  db.close();
  await tick(kept.dbPath, null, host(kept.dir, { ...fileAnchor(kept.dir), reserve: () => false }));
  assert.equal(anchorRead(kept.dir)?.pinned?.get(PR)?.has(kept.red) ?? false, false, "a record changed in place isn't pinned");
});

test("a record kept before #299 is pinned though the tick can't list the pull requests", async () => {
  const { dir, dbPath, red } = await keptUnpinned();
  const r = await tick(dbPath, null, { ...host(dir, { ...fileAnchor(dir), reserve: () => false }), openPrs: () => null });
  assert.match(r.log, /could not list PRs/, "control: the tick couldn't list them");
  assert.ok(anchorRead(dir)?.pinned?.get(PR)?.has(red), "pinned all the same");
});

test("a record kept before #299 on a store whose anchor is bound to none yet binds it, and is pinned before a pull request is judged", async () => {
  const dir = credentials();
  const dbPath = store();
  // A baseline over no record leaves the anchor bound to no store until the first order.
  await tick(dbPath, null, host(dir));
  assert.equal(anchorRead(dir)?.store ?? null, null, "control: bound to none");
  // A reeve before #299 keeps the store's first record: it neither binds the anchor nor pins it, and orders nothing.
  const real = fileAnchor(dir);
  let id = null;
  const before = { ...real, reserve: () => false, pin: () => true, pending: () => true,
                   read: (/** @type {string} */ repo) => { const a = real.read(repo); return a && id ? { ...a, store: id } : a; },
                   bind: (/** @type {string} */ _repo, /** @type {string} */ store) => { id = store; return true; } };
  await tick(dbPath, at(A), host(dir, before));
  let db = open(dbPath);
  const [kept] = digestsOf(db);
  const store_ = storeIdentity(db);
  db.close();
  assert.ok(kept, "control: a record was kept");
  assert.equal(anchorRead(dir)?.store ?? null, null, "control: and the anchor still bound to none");
  assert.equal(anchorRead(dir)?.pending ?? null, null, "control: nor its binding begun");
  // Before the next tick judges a pull request, which could stop it before its end binds the anchor.
  /** @type {boolean | null} */ let atJudging = null;
  await tick(dbPath, at(A, "RED"), { ...host(dir, { ...fileAnchor(dir), reserve: () => false }),
    evaluate: () => { atJudging ??= Boolean(anchorRead(dir)?.store && anchorRead(dir)?.pinned?.get(PR)?.has(kept)); return at(A, "RED"); } });
  db = open(dbPath);
  const identity = storeIdentity(db);
  db.close();
  assert.ok(identity && identity === (store_ ?? identity), "control: the store has its identity");
  assert.equal(atJudging, true, "bound and pinned before a pull request was judged");
  assert.equal(anchorRead(dir)?.store, identity, "bound to the store");
  assert.ok(anchorRead(dir)?.pinned?.get(PR)?.has(kept), "and the record pinned");
});

test("records kept before #299 are looked for on every tick, so one kept after the reeve's first is pinned at its next", async () => {
  const dir = credentials();
  const dbPath = store();
  /** @type {Map<number, Set<string>>} */ const atJudging = new Map();
  let tickNo = 0;
  const refusing = () => host(dir, { ...fileAnchor(dir), reserve: () => false });
  await run({ dbPath, ticks: 2, prState: () => "OPEN", prIsFinished: () => false, ...refusing(), openPrs: () => { tickNo++; return [PR]; },
              evaluate: () => { if (!atJudging.has(tickNo)) atJudging.set(tickNo, new Set(anchorRead(dir)?.pinned?.get(PR) ?? [])); return at(A); },
              // Between them, a reeve before #299 on the store keeps a record, unpinned and unordered.
              afterTick: async (i) => { if (i === 0) await tick(dbPath, at(A, "RED"), host(dir, { ...fileAnchor(dir), pin: () => true, reserve: () => false })); } });
  const db = open(dbPath);
  const red = db.prepare("SELECT digest FROM decision WHERE pr = ? AND json_extract(record, '$.verdict.state') = 'BLOCK'").get(PR)?.digest;
  db.close();
  assert.ok(red, "control: the record was kept");
  assert.deepEqual([...atJudging.keys()], [1, 2], "control: judged on each tick");
  assert.ok(atJudging.get(2)?.has(red), "pinned before the next tick judged");
});

test("a record kept before #299 is pinned though the reeve is halted", async () => {
  const { dir, dbPath, red } = await keptUnpinned();
  const marker = join(tempDir("reeve-pins-halt-"), "HALT");
  writeFileSync(marker, "");
  const r = await tick(dbPath, at(A, "RED"), { ...host(dir, { ...fileAnchor(dir), reserve: () => false }), haltMarker: marker });
  assert.match(r.log, /HALTED/, "control: the tick halted");
  assert.ok(anchorRead(dir)?.pinned?.get(PR)?.has(red), "pinned all the same");
});
