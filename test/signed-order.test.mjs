// The signed order of each pull request's decisions, and the host's anchor
// (#274): which record is a pull request's latest is signed too, and a store cut
// short, or restored from before, doesn't pass for the one the host kept.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileSigner, knownKeys, latestStatement, signStatement, signingKey } from "../src/signing.mjs";
import { fileAnchor, readAnchor, anchorPath } from "../src/anchor.mjs";
import { open, durably, storeLock, canonical } from "../src/db/ops.mjs";
import { withDefaults } from "../src/profile/schema.mjs";
import { explainDecision, replayDecisions, signedOrder, anchorForStore } from "../src/decisions.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { recordsFor, policyOf } from "../src/evidence.mjs";
import { saveDecision } from "../src/db/records.mjs";
import { restore } from "../src/backup.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";
import { run, EVAL } from "./fixtures/tick-harness.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
const REPO = "o/r", PR = 42;
const A = "a".repeat(40), B = "b".repeat(40);

/** A credentials folder, made as reeve's home makes it. */
const credentials = () => { const d = join(tempDir("reeve-order-"), "credentials"); mkdirSync(d, { mode: 0o700 }); return d; };
const input = (head) => ({
  head,
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
/** #42 at `head`, evaluated with its CI `ci` ("GREEN" passes it, "RED" blocks it). */
const at = (head, ci = "GREEN") => {
  const i = { ...input(head), checks: { ...input(head).checks, verdict: ci, failing: ci === "RED" ? [{ name: "unit", id: "1" }] : [] } };
  return { ...EVAL, head, input: i, verdict: computeVerdict(i) };
};
/** What the host's reeve is given: its signer, its keys and its anchor, over the credentials folder `dir`. */
const host = (dir) => ({ signer: fileSigner(dir), keys: () => knownKeys({ local: dir }), anchor: fileAnchor(dir) });
/** Ticks over one store, each with its own evaluation of #42, as `host` gives. Answers the store's path. */
async function ticks(evals, ctx, dbPath = null) {
  const path = dbPath ?? join(tempDir("reeve-order-ticks-"), "s.db");
  open(path).close();
  // By tick, not by call: a tick may evaluate a pull request more than once.
  let tick = 0;
  await run({ openPrs: () => { tick++; return [PR]; }, evaluate: () => evals[Math.min(tick, evals.length) - 1], dbPath: path, ticks: evals.length, ...ctx });
  return path;
}
/** The host's anchor, as `why` and `replay` are given it. */
const anchorOf = (dir) => { try { return { anchor: readAnchor(dir, REPO), why: null }; } catch (e) { return { anchor: null, why: e.message }; } };
/** The same, checked against the store it's read beside, as bin/reeve gives it. */
const anchorFor = (db, dir) => anchorForStore(db, anchorOf(dir), REPO);
/** An anchor as read, with the parts #279 and #281 added empty unless given. */
const anchorAs = (a) => ({ named: new Map(), sealed: new Map(), reserved: new Map(), pinned: new Map(), pending: null, ...a });
/** What the host's reeve is given, but no entry can be reserved on its anchor: a tick keeps its records, pinned, and orders none, as one that stopped first would. */
const unordered = (dir) => ({ ...host(dir), anchor: { ...fileAnchor(dir), reserve: () => false } });
/** The digests of #42's records, oldest first. */
const digestsOf = (db) => db.prepare("SELECT digest FROM decision WHERE pr = ? ORDER BY first_seq").all(PR).map((r) => r.digest);

test("each change of a pull request's latest decision is a numbered, signed entry of its order, and why names it", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED"), at(A, "RED")], host(dir)));
  const keys = knownKeys({ local: dir });
  const order = signedOrder(db, REPO, PR, keys);
  const [green, red] = digestsOf(db);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.deepEqual("top" in order && { top: order.top, digest: order.digest, digests: order.digests }, { top: 2, digest: red, digests: new Set([green, red]) },
                   "one entry per change, none for a decision seen again");
  assert.ok("seq" in order && Number.isInteger(order.seq) && order.seq > 0, `and where its latest was seen: ${JSON.stringify(order)}`);
  assert.match(String(shown), /the latest by its signed order, entry 2/);
  assert.doesNotMatch(String(shown), /can't be trusted/);
  const anchor = readAnchor(dir, REPO);
  assert.deepEqual({ began: anchor?.began, latest: anchor?.latest }, { began: true, latest: new Map([[PR, 2]]) }, "and the host's anchor holds its top");
  assert.match(String(anchor?.store), /^[0-9a-f]{32}$/, "and is this store's");
});

test("an older record raised in the store's own order can't be trusted as the latest", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  const [green, red] = digestsOf(db);
  db.prepare("UPDATE decision SET last_seq = 1000000 WHERE digest = ?").run(green);
  const shown = explainDecision(db, PR, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.match(String(shown), new RegExp(`can't be trusted as the latest: its signed order ends at record ${red.slice(0, 12)}`));
});

test("a store whose newest records were taken away reads as cut short against the host's anchor", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  const [, red] = digestsOf(db);
  db.prepare("DELETE FROM decision WHERE digest = ?").run(red);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  const keys = knownKeys({ local: dir });
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorOf(dir) });
  const replayed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: its signed order ends at entry 1, though this host signed up to entry 2/);
  assert.ok(replayed.some((r) => r.outcome === "unreplayable" && /ends at entry 1, though this host signed up to entry 2/.test(String(r.why))), JSON.stringify(replayed));
});

test("a pull request whose every record was taken away still shows, by the host's anchor", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  db.prepare("DELETE FROM decision WHERE pr = ?").run(PR);
  db.prepare("DELETE FROM event WHERE subject = ?").run(`pr:${PR}`);
  const keys = knownKeys({ local: dir });
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorOf(dir) });
  const replayed = replayDecisions(db, {}, { keys, repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.match(String(shown), /the store holds no decision record for it, though this host signed up to entry 2 of its order/);
  assert.ok(replayed.some((r) => r.pr === PR && r.outcome === "unreplayable" && /though this host signed up to entry 2/.test(String(r.why))), JSON.stringify(replayed));
});

test("a record the signed order names that the store no longer holds is reported by replay", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  const [green] = digestsOf(db);
  db.prepare("DELETE FROM decision WHERE digest = ?").run(green);
  const replayed = replayDecisions(db, { pr: PR }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.deepEqual(replayed.filter((r) => r.outcome === "unreplayable").map((r) => [r.digest, r.why]),
                   [[green, "its signed order names this record, but the store no longer holds it"]]);
});

test("the host's anchor is written whole, its folder and every folder made for it synced", () => {
  const dir = credentials();
  const seen = [];
  const anchor = fileAnchor(dir, { syncDir: (d) => seen.push(d) });
  assert.equal(anchor.note(REPO, 7, 1), true, "control: it was written");
  const file = anchorPath(dir, REPO);
  for (const d of [dirname(file), dirname(dirname(file)), dir]) assert.ok(seen.includes(d), `${d} synced: ${JSON.stringify(seen)}`);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { began: true, latest: { 7: 1 }, store: null, named: {}, sealed: {}, reserved: {}, pinned: {}, pending: null });
  // And by a writer that made none of them, as a reeve after a restart is: a
  // sync that failed before it started is made again.
  const again = [];
  assert.equal(fileAnchor(dir, { syncDir: (d) => again.push(d) }).note(REPO, 7, 2), true, "control: written again");
  for (const d of [dirname(file), dirname(dirname(file)), dir]) assert.ok(again.includes(d), `${d} synced again: ${JSON.stringify(again)}`);
});

test("the host's anchor only moves forward", () => {
  const dir = credentials();
  const anchor = fileAnchor(dir);
  anchor.note(REPO, 7, 3);
  anchor.note(REPO, 7, 2);
  anchor.note(REPO, 9, 1);
  assert.deepEqual(readAnchor(dir, REPO), anchorAs({ began: true, latest: new Map([[7, 3], [9, 1]]), store: null }));
});

test("an anchor that can't be read vouches for nothing, and isn't written over", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  const file = anchorPath(dir, REPO);
  writeFileSync(file, "cut sho");
  const keys = knownKeys({ local: dir });
  let db = open(dbPath);
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorOf(dir) });
  const replayed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: the host's anchor for o\/r can't be read/);
  assert.ok(replayed.some((r) => r.outcome === "unreplayable" && /anchor for o\/r can't be read/.test(String(r.why))), JSON.stringify(replayed));
  const r = await run({ evaluate: () => at(A, "RED"), dbPath, ...host(dir) });
  assert.equal(readFileSync(file, "utf8"), "cut sho", "a tick leaves it as it was");
  assert.match(r.log, /the host's anchor for o\/r can't be read: it isn't JSON, so no signed order is extended/);
  db = open(dbPath);
  assert.equal(signedOrder(db, REPO, PR, keys).top, 1, "nor is the order extended, as whether it was cut short can't be told");
  db.close();
  // Nor is it by a write of the anchor itself: each says it doesn't hold what it would say.
  const anchor = fileAnchor(dir);
  assert.equal(anchor.note(REPO, PR, 5), false, "a note isn't made over it");
  assert.equal(anchor.bind(REPO, "a".repeat(32)), false, "nor a binding");
  assert.equal(readFileSync(file, "utf8"), "cut sho", "and it's left as it was");
});

test("the order is extended only from entries that check, so a number a store edit put there never moves the anchor", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  let db = open(dbPath);
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(2, "daemon", "decision.latest", `pr:${PR}`, JSON.stringify({ repo: REPO, n: 1000, digest: "f".repeat(64), envelope: "{}" }));
  db.close();
  const r = await run({ evaluate: () => at(A, "RED"), dbPath, ...host(dir) });
  db = open(dbPath);
  const entries = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  db.close();
  assert.equal(entries, 2, "no entry signed on top of one that doesn't check");
  assert.match(r.log, /#42: its signed order doesn't hold, so it isn't extended/);
  assert.deepEqual(readAnchor(dir, REPO)?.latest, new Map([[PR, 1]]), "and the host's anchor stays where the order last checked");
});

test("replay checks each entry of the signed order, and reports one that doesn't hold", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  db.prepare("UPDATE event SET payload = json_set(payload, '$.digest', ?) WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 1")
    .run("f".repeat(64));
  const keys = knownKeys({ local: dir });
  const replayed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorOf(dir) });
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((r) => r.outcome === "unreplayable" && /entry 1 of its signed order doesn't hold/.test(String(r.why))), JSON.stringify(replayed));
  assert.match(String(shown), /can't be trusted as the latest: entry 1 of its signed order doesn't hold/);
});

test("an entry of another repository's order doesn't pass for this one's", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A)], host(dir)));
  const k = signingKey(dir);
  assert.equal(k.ok, true, "control: the host's key");
  const digest = digestsOf(db)[0];
  const s = signStatement(latestStatement({ repo: "x/y", pr: PR, n: 2, digest }), /** @type {any} */ (k));
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(3, "daemon", "decision.latest", `pr:${PR}`, JSON.stringify({ repo: "x/y", n: 2, digest, records: [], store: null, envelope: "envelope" in s ? s.envelope : null }));
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.deepEqual(order, { corrupt: "entry 2 of its signed order is of x/y, not of o/r" });
});

test("a store stripped of its baseline and every signature still began signing, by the host's anchor, and no baseline is made again", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(B)], host(dir));
  let db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op IN ('signing.baseline', 'decision.latest')").run();
  db.prepare("UPDATE decision SET envelope = NULL").run();
  const keys = knownKeys({ local: dir });
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorOf(dir) });
  const replayed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.match(String(shown), /can't be trusted: it's unsigned, though it was kept after this store began signing.*the host's anchor says this store began signing/);
  assert.ok(replayed.length >= 2 && replayed.every((x) => x.outcome === "unreplayable"), `none of its records is replayed as trusted: ${JSON.stringify(replayed)}`);
  const r = await run({ evaluate: () => at(B, "RED"), dbPath, ...host(dir) });
  db = open(dbPath);
  const baselines = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'signing.baseline'").get().n;
  db.close();
  assert.equal(baselines, 0, "none made over records that may have been rewritten");
  assert.match(r.log, /the host's anchor says this store began signing, though it holds no baseline or signed record/);
});

test("a store holding no record begins signing again, though the host's anchor says it began", async () => {
  const dir = credentials();
  // The anchor says a store began: the one it's bound to.
  const anchor = fileAnchor(dir);
  anchor.bind(REPO, "a".repeat(32));
  anchor.began(REPO, "a".repeat(32));
  assert.equal(readAnchor(dir, REPO)?.began, true, "control: the anchor says a store began");
  const dbPath = await ticks([at(A)], host(dir));
  const db = open(dbPath);
  const baselines = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'signing.baseline'").get().n;
  const signed = db.prepare("SELECT count(*) AS n FROM decision WHERE envelope IS NOT NULL").get().n;
  db.close();
  assert.equal(baselines, 1, "a baseline over nothing vouches for nothing");
  assert.ok(signed > 0, "and its records are signed");
});

test("a store that began signing before the host's anchor has it said there at its next tick", async () => {
  const dir = credentials();
  // Began with the signer alone, as #271's reeve did, with no anchor.
  const dbPath = await ticks([at(A)], { signer: fileSigner(dir) });
  assert.equal(readAnchor(dir, REPO), null, "control: no anchor yet");
  await run({ evaluate: () => at(A), dbPath, ...host(dir) });
  assert.equal(readAnchor(dir, REPO)?.began, true);
});

test("an anchor is kept only where a repository's name can go", () => {
  const dir = credentials();
  for (const bad of ["../../x", "o/r/../s", "o", ".o/r", "o/.", "o/..", "o/r/s"]) assert.throws(() => anchorPath(dir, bad), /not a repository/, bad);
  assert.equal(anchorPath(dir, "O/R"), anchorPath(dir, "o/r"), "GitHub's names don't tell case apart");
});

test("reeve why and reeve replay read the host's anchor for the repository asked about", async () => {
  const home = tempDir("reeve-order-cli-");
  const dir = join(home, "credentials");
  mkdirSync(dir, { mode: 0o700 });
  const dbPath = await ticks([at(A), at(A, "RED")], host(dir));
  const db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  db.close();
  const env = { ...offlineEnv(), REEVE_HOME: home };
  const shown = spawnSync(process.execPath, [REEVE, "why", REPO, String(PR), "--db", dbPath], { encoding: "utf8", env });
  assert.match(shown.stdout, /its signed order ends at entry 1, though this host signed up to entry 2/, shown.stdout + shown.stderr);
  const replayed = spawnSync(process.execPath, [REEVE, "replay", REPO, "--db", dbPath], { encoding: "utf8", env });
  assert.equal(replayed.status, 1, replayed.stdout + replayed.stderr);
  assert.match(replayed.stdout, /#42 \(record [0-9a-f]{12}\): could not be replayed: its signed order ends at entry 1, though this host signed up to entry 2/);
});

test("the daemon run by reeve is given the host's anchor and keys", () => {
  const src = readFileSync(REEVE, "utf8");
  assert.match(src, /anchor: fileAnchor\(join\(HOME, "credentials"\)\),\n\s+keys: signingKeys,/);
  assert.ok(existsSync(REEVE), "control");
});

// ── each guard's own case ────────────────────────────────────────────────────

test("an anchor that isn't one, or isn't a file, is never read as one", () => {
  const dir = credentials();
  const file = anchorPath(dir, REPO);
  mkdirSync(dirname(file), { recursive: true });
  for (const text of ['{"began":"yes","latest":{}}', '{"began":true,"latest":{"7":"x"}}', '{"began":true,"latest":{"-1":2}}', '{"began":true,"latest":[]}',
                      '{"began":true,"latest":{},"store":"not a store"}']) {
    writeFileSync(file, text);
    assert.throws(() => readAnchor(dir, REPO), /can't be read: it isn't an anchor/, text);
  }
  writeFileSync(file, '{"began":true,"latest":{"7":2}}');
  assert.deepEqual(readAnchor(dir, REPO), anchorAs({ began: true, latest: new Map([[7, 2]]), store: null }), "control: an anchor reads as one");
});

test("an anchor that's a pipe is refused before it's opened, so reading it can't wait for ever", () => {
  const dir = credentials();
  const file = anchorPath(dir, REPO);
  mkdirSync(dirname(file), { recursive: true });
  assert.equal(spawnSync("mkfifo", [file]).status, 0, "control: a pipe was made where the anchor goes");
  const at = JSON.stringify(new URL("../src/anchor.mjs", import.meta.url).href);
  const src = `import(${at}).then((m) => { try { m.readAnchor(${JSON.stringify(dir)}, ${JSON.stringify(REPO)}); process.stdout.write("read"); } catch (e) { process.stdout.write("refused: " + e.message); } })`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", timeout: 5000 });
  assert.equal(r.signal, null, `it answered: ${r.error?.message ?? ""}`);
  assert.match(r.stdout, /^refused: .*it isn't a file/);
});

test("an entry taken out of the middle of the signed order leaves it missing, and one named twice is refused", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  const keys = knownKeys({ local: dir });
  const second = db.prepare("SELECT at, actor, op, subject, payload FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").get();
  assert.ok(second, "control: the order has an entry 2");
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(second.at, second.actor, second.op, second.subject, second.payload);
  const twice = signedOrder(db, REPO, PR, keys);
  db.close();
  assert.deepEqual(twice, { corrupt: "its signed order names entry 2 twice" });
  // Another host's store: on this one, its anchor would hold the first store's order.
  const other = credentials();
  const db2 = open(await ticks([at(A), at(A, "RED")], host(other)));
  db2.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 1").run();
  const gap = signedOrder(db2, REPO, PR, knownKeys({ local: other }));
  db2.close();
  assert.deepEqual(gap, { corrupt: "its signed order is missing entry 1" });
});

test("where the host's anchor can't be read, a store's unsigned records aren't vouched for, whatever the store shows", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], {});
  mkdirSync(dirname(anchorPath(dir, REPO)), { recursive: true });
  writeFileSync(anchorPath(dir, REPO), "{");
  const db = open(dbPath);
  const keys = knownKeys({ local: dir });
  const blind = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorOf(dir) });
  const none = explainDecision(db, PR, { keys, repo: REPO, anchor: { anchor: null, why: null } });
  db.close();
  assert.match(String(none), /unsigned: this run was given no signing key/, "control: with no anchor, a store that never signed reads as unsigned");
  assert.match(String(blind), /can't be trusted: it's unsigned, though it was kept after this store began signing .*anchor for o\/r can't be read/);
});

test("a store that holds a signed order began signing, though its baseline and signatures were taken away", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  db.prepare("DELETE FROM event WHERE op = 'signing.baseline'").run();
  db.prepare("UPDATE decision SET envelope = NULL").run();
  const shown = explainDecision(db, PR, { keys: knownKeys({ local: dir }), repo: REPO, anchor: null });
  db.close();
  assert.match(String(shown), /can't be trusted: it's unsigned, though it was kept after this store began signing/);
});

test("replay of the whole store reads the order of a pull request whose records are all gone", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  const [green, red] = digestsOf(db);
  db.prepare("DELETE FROM decision WHERE pr = ?").run(PR);
  const replayed = replayDecisions(db, {}, { keys: knownKeys({ local: dir }), repo: REPO, anchor: null });
  db.close();
  assert.deepEqual(replayed.map((r) => r.digest).sort(), [green, red].sort(), JSON.stringify(replayed));
  assert.ok(replayed.every((r) => r.outcome === "unreplayable" && /the store no longer holds it/.test(String(r.why))));
});

test("a queue commit's record takes its place in the pull request's signed order", async () => {
  const dir = credentials();
  const QUEUED = "c".repeat(40);
  const readQueue = () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: QUEUED, baseSha: "f".repeat(40), state: "AWAITING_CHECKS", prHead: A }] });
  const evaluateQueue = ({ entry, input: i }) => { const q = { ...i, head: entry.sha }; return { ok: true, input: q, verdict: computeVerdict(q) }; };
  const dbPath = join(tempDir("reeve-order-queue-"), "s.db");
  open(dbPath).close();
  await run({ evaluate: () => at(A), readQueue, evaluateQueue, dbPath, ...host(dir) });
  const db = open(dbPath);
  const queued = db.prepare("SELECT digest FROM decision WHERE head = ?").get(QUEUED)?.digest;
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.ok(queued, "control: the queue commit's record was kept");
  assert.ok("digests" in order && order.digests.has(queued), JSON.stringify(order));
});

test("a store the host's anchor is bound to says there that it began signing, though no entry of its order is noted", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  const db = open(dbPath);
  const id = db.prepare("SELECT json_extract(payload, '$.id') AS id FROM event WHERE op = 'store.identity'").get()?.id;
  db.close();
  // Bound to the store and saying nothing more. Binding says the store began
  // too, so no reeve leaves it so; whatever did, the next tick says it.
  writeFileSync(anchorPath(dir, REPO), JSON.stringify({ began: false, latest: {}, store: id }));
  assert.deepEqual(readAnchor(dir, REPO), anchorAs({ began: false, latest: new Map(), store: id }), "control: bound, and saying nothing more");
  // No keys to check an order with, so none is extended or noted.
  await run({ evaluate: () => at(A), dbPath, ...host(dir), keys: () => null });
  const a = readAnchor(dir, REPO);
  assert.deepEqual({ began: a?.began, latest: a?.latest }, { began: true, latest: new Map() });
});

test("a store stripped of its baseline and signatures isn't given one again where the host's anchor can't be read", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  let db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op IN ('signing.baseline', 'decision.latest')").run();
  db.prepare("UPDATE decision SET envelope = NULL").run();
  db.close();
  writeFileSync(anchorPath(dir, REPO), "{");
  const r = await run({ evaluate: () => at(B), dbPath, ...host(dir) });
  db = open(dbPath);
  const baselines = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'signing.baseline'").get().n;
  db.close();
  assert.equal(baselines, 0);
  assert.match(r.log, /anchor for o\/r can't be read: it isn't JSON, so it's taken to say this store began signing/);
});

test("reeve why says when the host's anchor for the repository can't be read", async () => {
  const home = tempDir("reeve-order-cli-blind-");
  const dir = join(home, "credentials");
  mkdirSync(dir, { mode: 0o700 });
  const dbPath = await ticks([at(A)], host(dir));
  writeFileSync(anchorPath(dir, REPO), "{");
  const shown = spawnSync(process.execPath, [REEVE, "why", REPO, String(PR), "--db", dbPath], { encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: home } });
  assert.match(shown.stdout, /can't be trusted as the latest: the host's anchor for o\/r can't be read/, shown.stdout + shown.stderr);
});

// ── from #278's first review ─────────────────────────────────────────────────

test("an order cut short of the host's anchor is never extended, so no entry number is signed twice", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(A, "RED")], host(dir));
  let db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  db.close();
  const r = await run({ evaluate: () => at(B), dbPath, ...host(dir) });
  db = open(dbPath);
  const entries = db.prepare("SELECT json_extract(payload, '$.n') AS n FROM event WHERE op = 'decision.latest'").all().map((x) => x.n);
  db.close();
  assert.deepEqual(entries, [1], "no second entry 2 signed");
  assert.match(r.log, /#42: its signed order ends at entry 1, though this host signed up to entry 2, so it isn't extended/);
});

test("a sync of the anchor's folders that failed is made again, though the anchor already holds the value", () => {
  const dir = credentials();
  let failing = true;
  const seen = [];
  const anchor = fileAnchor(dir, { syncDir: (d) => { if (failing) throw new Error("input/output error"); seen.push(d); } });
  assert.equal(anchor.note(REPO, 7, 1), false, "control: the first write's sync failed");
  assert.equal(readAnchor(dir, REPO)?.latest.get(7), 1, "control: though the anchor holds it");
  failing = false;
  assert.equal(anchor.note(REPO, 7, 1), true);
  assert.ok(seen.includes(dirname(anchorPath(dir, REPO))), `its folder synced again: ${JSON.stringify(seen)}`);
});

test("a store holding a signed order isn't given a baseline again, though its baseline, its signatures and the host's anchor are gone", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(A, "RED")], host(dir));
  let db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op = 'signing.baseline'").run();
  db.prepare("UPDATE decision SET envelope = NULL").run();
  db.close();
  rmSync(join(dir, "signing-anchors"), { recursive: true });
  await run({ evaluate: () => at(B), dbPath, ...host(dir) });
  db = open(dbPath);
  const baselines = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'signing.baseline'").get().n;
  db.close();
  assert.equal(baselines, 0, "none made over records that may have been rewritten");
});

test("an anchor's temporaries left by a process that's gone are removed, and a running process's are left", () => {
  const dir = credentials();
  const file = anchorPath(dir, REPO);
  mkdirSync(dirname(file), { recursive: true });
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  const left = `${file}.${gone}.deadbeef.tmp`, live = `${file}.${process.ppid}.feedface.tmp`;
  writeFileSync(left, "partway");
  writeFileSync(live, "partway");
  assert.equal(fileAnchor(dir).note(REPO, 7, 1), true, "control: it was written");
  assert.deepEqual({ left: existsSync(left), live: existsSync(live) }, { left: false, live: true });
});

// ── from #278's second review ────────────────────────────────────────────────

test("the host's anchor moves only once the order's entry is committed, so a store that rolled it back isn't left behind the anchor", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  let db = open(dbPath);
  // The transaction that keeps entry 2 fails at its commit, after the entry was written.
  db.exec(`CREATE TABLE fk_parent(id INTEGER PRIMARY KEY);
           CREATE TABLE fk_child(p INTEGER REFERENCES fk_parent(id) DEFERRABLE INITIALLY DEFERRED);
           CREATE TRIGGER fail_commit AFTER INSERT ON event WHEN NEW.op = 'decision.latest' BEGIN INSERT INTO fk_child VALUES (999); END;`);
  db.close();
  await run({ evaluate: () => at(A, "RED"), dbPath, ...host(dir) });
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.equal("top" in order && order.top, 1, "control: entry 2 wasn't kept");
  assert.equal(readAnchor(dir, REPO)?.latest.get(PR), 1, "nor did the anchor move to it");
});

test("the host's lock on a repository's anchor is held by one at a time", () => {
  const dir = credentials();
  const first = fileAnchor(dir).lock(REPO);
  assert.ok(first && "release" in first, "control: the lock was taken");
  const second = fileAnchor(dir).lock(REPO);
  assert.ok(second && "why" in second, "a second can't take it while the first holds it");
  first.release();
  const third = fileAnchor(dir).lock(REPO);
  assert.ok(third && "release" in third, "and can once it's released");
  third.release();
});

test("while another reeve holds the host's lock on the repository's anchor, a tick extends no signed order", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  const other = fileAnchor(dir).lock(REPO);
  assert.ok(other && "release" in other, "control: the lock was taken");
  let r;
  try { r = await run({ evaluate: () => at(A, "RED"), dbPath, ...host(dir) }); } finally { other.release(); }
  let db = open(dbPath);
  const held = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  const kept = digestsOf(db).length;
  db.close();
  assert.equal(held, 1, "no entry signed while another held the lock");
  assert.match(r.log, /another reeve holds the host's lock on o\/r's anchor, so no signed order is extended/);
  // Nor is a record kept that couldn't be pinned: taken away before an entry
  // named it, it would leave nothing to show it was kept (#279).
  assert.equal(kept, 1, "the verdict's record isn't kept this tick");
  assert.match(r.log, /#42: its decision record isn't kept this tick, as it couldn't be pinned on the host's anchor — the host's lock on the anchor wasn't held/);
  await run({ evaluate: () => at(A, "RED"), dbPath, ...host(dir) });
  db = open(dbPath);
  const after = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  db.close();
  assert.equal(after, 2, "control: once it's free, the order goes on");
});

test("reeve replay and reeve why refuse a store named by --db alone, as which repository it's of can't be told", async () => {
  const home = tempDir("reeve-order-unbound-");
  const dir = join(home, "credentials");
  mkdirSync(dir, { mode: 0o700 });
  // A store cut short of its anchor, which would replay as the same, checked as no repository.
  const cut = await ticks([at(A), at(A, "RED")], host(dir));
  const db = open(cut);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  db.close();
  const empty = join(tempDir("reeve-order-unbound-empty-"), "s.db");
  open(empty).close();
  // No checkout here, so no repository to take from one.
  const cwd = tempDir("reeve-order-nowhere-");
  const env = { ...offlineEnv(), REEVE_HOME: home };
  for (const dbPath of [cut, empty]) {
    for (const args of [["replay", "--db", dbPath], ["why", String(PR), "--db", dbPath]]) {
      const r = spawnSync(process.execPath, [REEVE, ...args], { encoding: "utf8", env, cwd });
      assert.equal(r.status, 1, `${args[0]} ${dbPath === cut ? "cut short" : "empty"}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /which repository this store is of can't be told/, args[0]);
    }
  }
  const named = spawnSync(process.execPath, [REEVE, "replay", REPO, "--db", cut], { encoding: "utf8", env, cwd });
  assert.match(named.stdout, /its signed order ends at entry 1, though this host signed up to entry 2/, "control: named, it's checked");
});

test("an anchor reached through a link, or with another name, is never read or written", () => {
  const dir = credentials();
  const file = anchorPath(dir, REPO);
  assert.equal(fileAnchor(dir).note(REPO, 7, 3), true, "control: an anchor was written");
  const elsewhere = join(tempDir("reeve-order-elsewhere-"), "r.json");
  writeFileSync(elsewhere, '{"began":true,"latest":{"7":1}}');
  rmSync(file);
  symlinkSync(elsewhere, file);
  assert.throws(() => readAnchor(dir, REPO), /is a link/);
  assert.equal(fileAnchor(dir).note(REPO, 7, 4), false, "nor written through");
  assert.equal(readFileSync(elsewhere, "utf8"), '{"began":true,"latest":{"7":1}}', "what it points at is left as it was");
  rmSync(file);
  writeFileSync(file, '{"began":true,"latest":{"7":3}}');
  linkSync(file, join(tempDir("reeve-order-other-name-"), "r.json"));
  assert.throws(() => readAnchor(dir, REPO), /another name/);
});

test("an anchor whose folder is a link is never read", () => {
  const dir = credentials();
  const owner = dirname(anchorPath(dir, REPO));
  const elsewhere = tempDir("reeve-order-owner-");
  writeFileSync(join(elsewhere, "r.json"), '{"began":true,"latest":{}}');
  mkdirSync(dirname(owner), { recursive: true });
  symlinkSync(elsewhere, owner);
  assert.throws(() => readAnchor(dir, REPO), /is a link/);
});

// ── from #278's third review ─────────────────────────────────────────────────

test("an order's entries commit synced to disk before the host's anchor moves to them", async () => {
  const dir = credentials();
  const seen = [];
  const count = (db, op) => db.prepare("SELECT count(*) AS n FROM event WHERE op = ?").get(op).n;
  const watched = (db, fn) => durably(db, () => {
    const level = db.prepare("PRAGMA synchronous").get().synchronous;
    const before = { baseline: count(db, "signing.baseline"), entries: count(db, "decision.latest") };
    const r = fn();
    seen.push({ level, baseline: count(db, "signing.baseline") > before.baseline, entry: count(db, "decision.latest") > before.entries });
    return r;
  });
  const dbPath = await ticks([at(A)], { ...host(dir), durably: watched });
  const db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  const after = db.prepare("PRAGMA synchronous").get().synchronous;
  db.close();
  assert.equal("top" in order && order.top, 1, "control: an entry was made");
  assert.ok(seen.some((x) => x.entry && x.level === 2), `the entry committed at FULL, which syncs the WAL at each commit: ${JSON.stringify(seen)}`);
  assert.ok(seen.some((x) => x.baseline && x.level === 2), `and the baseline too, before the anchor says the store began: ${JSON.stringify(seen)}`);
  assert.equal(after, 1, "and a store opened again runs as it's set to");
});

test("durably runs its work at FULL, and puts the store back as it was", () => {
  const db = open(join(tempDir("reeve-order-durably-"), "s.db"));
  const before = db.prepare("PRAGMA synchronous").get().synchronous;
  const inside = durably(db, () => db.prepare("PRAGMA synchronous").get().synchronous);
  const after = db.prepare("PRAGMA synchronous").get().synchronous;
  assert.throws(() => durably(db, () => { throw new Error("stop"); }), /stop/);
  const afterThrow = db.prepare("PRAGMA synchronous").get().synchronous;
  db.close();
  assert.deepEqual({ before, inside, after, afterThrow }, { before: 1, inside: 2, after: 1, afterThrow: 1 });
});

test("a pull request held at the same queue commit adds no entry tick after tick", async () => {
  const dir = credentials();
  const QUEUED = "c".repeat(40);
  const readQueue = () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: QUEUED, baseSha: "f".repeat(40), state: "AWAITING_CHECKS", prHead: A }] });
  const evaluateQueue = ({ entry, input: i }) => { const q = { ...i, head: entry.sha }; return { ok: true, input: q, verdict: computeVerdict(q) }; };
  const dbPath = join(tempDir("reeve-order-queued-"), "s.db");
  open(dbPath).close();
  await run({ evaluate: () => at(A), readQueue, evaluateQueue, dbPath, ticks: 3, ...host(dir) });
  const db = open(dbPath);
  const entries = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  const latest = db.prepare("SELECT digest FROM decision WHERE pr = ? ORDER BY last_seq DESC LIMIT 1").get(PR)?.digest;
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.equal(entries, 1, "one entry: the latest at the end of the first tick, and nothing changed since");
  assert.equal("digest" in order && order.digest, latest, "and it names the store's latest");
});

test("the host's anchor is one store's: another store of the repository extends no signed order, and why can't vouch for its latest", async () => {
  const dir = credentials();
  await ticks([at(A)], host(dir));
  // The second store judges a pull request the first hasn't: nothing on the
  // anchor for it yet, so only the anchor's store tells the two apart.
  const second = join(tempDir("reeve-order-second-"), "s.db");
  open(second).close();
  const r = await run({ openPrs: () => [43], evaluate: () => ({ ...at(A), pr: 43 }), dbPath: second, ...host(dir) });
  const db = open(second);
  const kept = db.prepare("SELECT count(*) AS n FROM decision WHERE pr = 43").get().n;
  const entries = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  const shown = explainDecision(db, 43, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorFor(db, dir) });
  db.close();
  assert.equal(kept, 1, "control: the second store kept its record");
  assert.equal(entries, 0, "no entry, whose number the first store might yet take");
  assert.match(r.log, /the host's anchor for o\/r is another store's, so this store's signed orders aren't extended/);
  assert.match(String(shown), /can't be trusted as the latest: the host's anchor for o\/r is another store's/);
});

test("an entry committed before the host's anchor could be moved to it is noted at the next tick", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  // The note's write fails before it's renamed into place: the entry is
  // reserved and committed, and the anchor stays at the entry before, as it
  // would were the process to stop between the two.
  const noting = (/** @type {Buffer} */ buf) => /"latest":\{"42":2\}/.test(buf.toString());
  const stuck = { ...host(dir), anchor: fileAnchor(dir, { write: (fd, buf, offset, length) => {
    if (noting(buf)) throw new Error("no space left on device");
    return writeSync(fd, buf, offset, length);
  } }) };
  const r = await run({ evaluate: () => at(A, "RED"), dbPath, ...stuck });
  assert.match(r.log, /the host's anchor couldn't be moved to entry 2 of its order/, "control: the note failed");
  assert.equal(readAnchor(dir, REPO)?.latest.get(PR), 1, "control: the anchor stayed behind");
  const next = await run({ evaluate: () => at(A, "RED"), dbPath, ...host(dir) });
  const db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.ok("top" in order && order.top >= 2, JSON.stringify(order));
  assert.equal(readAnchor(dir, REPO)?.latest.get(PR), order.top, "the anchor caught up with the order");
  assert.doesNotMatch(next.log, /isn't extended/, "and the order wasn't refused");
});

test("a store whose identity was taken away, once the host's anchor is bound to it, extends no signed order", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  let db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op = 'store.identity'").run();
  db.close();
  const r = await run({ evaluate: () => at(A, "RED"), dbPath, ...host(dir) });
  db = open(dbPath);
  const entries = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  db.close();
  assert.equal(entries, 1, "no entry signed as though it were the store the anchor holds");
  assert.match(r.log, /the host's anchor for o\/r is another store's, so this store's signed orders aren't extended/);
});

test("a tick that halts after keeping its records orders them all the same", async () => {
  const dir = credentials();
  const marker = join(tempDir("reeve-order-halt-"), "HALT");
  const dbPath = join(tempDir("reeve-order-halted-"), "s.db");
  open(dbPath).close();
  const r = await run({ evaluate: () => { writeFileSync(marker, ""); return at(A); }, dbPath, haltMarker: marker, ...host(dir) });
  const db = open(dbPath);
  const kept = db.prepare("SELECT count(*) AS n FROM decision WHERE pr = ?").get(PR).n;
  const entries = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  db.close();
  assert.match(r.log, /HALTED/, "control: it halted");
  assert.equal(kept, 1, "control: its record was kept");
  assert.equal(entries, 1);
});

test("a queue commit's record is ordered though its pull request's own record couldn't be kept", async () => {
  const dir = credentials();
  const QUEUED = "c".repeat(40);
  const readQueue = () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: QUEUED, baseSha: "f".repeat(40), state: "AWAITING_CHECKS", prHead: A }] });
  const evaluateQueue = ({ entry, input: i }) => { const q = { ...i, head: entry.sha }; return { ok: true, input: q, verdict: computeVerdict(q) }; };
  // The head's tree can't be read, so its record isn't kept; the queue commit's is.
  const treeOf = (_nwo, sha) => { if (sha === A) throw new Error("the tree couldn't be read"); return "d".repeat(40); };
  const dbPath = join(tempDir("reeve-order-queue-only-"), "s.db");
  open(dbPath).close();
  await run({ evaluate: () => at(A), readQueue, evaluateQueue, treeOf, dbPath, ...host(dir) });
  const db = open(dbPath);
  const heads = db.prepare("SELECT head FROM decision WHERE pr = ?").all(PR).map((x) => x.head);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.deepEqual(heads, [QUEUED], "control: only the queue commit's record was kept");
  assert.ok("top" in order && order.top === 1, JSON.stringify(order));
});

test("the host's anchor, once bound to a store, is never bound to another", () => {
  const dir = credentials();
  const anchor = fileAnchor(dir);
  assert.equal(anchor.bind(REPO, "a".repeat(32)), true);
  assert.equal(anchor.bind(REPO, "a".repeat(32)), true, "the same store again");
  assert.equal(anchor.bind(REPO, "b".repeat(32)), false);
  assert.equal(readAnchor(dir, REPO)?.store, "a".repeat(32));
});

// ── from #278's fourth review ────────────────────────────────────────────────

test("a pull request whose order a tick couldn't extend, as another held the lock, is ordered by the next, though never judged again", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  // Another reeve takes the host's lock once this one has kept its record, pinned.
  const real = fileAnchor(dir);
  /** @type {any} */ let other = null;
  const kept = () => { const db = open(dbPath); try { return digestsOf(db).length; } finally { db.close(); } };
  const anchor = { ...real, lock: (/** @type {string} */ repo) => { if (!other && kept() > 1) other = real.lock(repo); return real.lock(repo); } };
  let r;
  try { r = await run({ evaluate: () => at(A, "RED"), dbPath, ...host(dir), anchor }); } finally { other?.release?.(); }
  assert.match(r.log, /another reeve holds the host's lock on o\/r's anchor, so no signed order is extended/, "control: it couldn't order the record it kept");
  // Gone from the open list, merged, and never judged again.
  await run({ openPrs: () => [], evaluate: () => at(A), dbPath, prState: () => "MERGED", prIsFinished: () => true, ...host(dir) });
  const db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  const [first, left] = digestsOf(db);
  db.close();
  // Named, so it can't be taken away unseen; and not signed as the latest by a
  // reeve that didn't keep it, as a record put in the store could be.
  assert.ok("digests" in order && order.top === 2 && order.digests.has(left), JSON.stringify(order));
  assert.equal("digest" in order && order.digest, first, "the latest stays where this host signed it");
  assert.equal(readAnchor(dir, REPO)?.latest.get(PR), 2);
});

test("the anchor's lock makes nothing through a link on its way", () => {
  const dir = credentials();
  const outside = tempDir("reeve-order-outside-");
  symlinkSync(outside, join(dir, "signing-anchors"));
  const lock = fileAnchor(dir).lock(REPO);
  assert.ok(lock && "why" in lock, "it's refused");
  assert.match(lock.why, /is a link/);
  assert.deepEqual(readdirSync(outside), [], "and nothing was made where the link leads");
});

test("a repository whose name starts with a dot keeps an anchor", () => {
  const dir = credentials();
  assert.equal(fileAnchor(dir).note("o/.github", 7, 1), true);
  assert.equal(readAnchor(dir, "o/.github")?.latest.get(7), 1);
});

// ── from #278's fifth review ─────────────────────────────────────────────────

test("an order that ran ahead of the host's anchor is noted there by a later tick, though its pull request is never judged again", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  // Its entry committed, and the note never made, as by a disk that filled in between.
  const stuck = { ...host(dir), anchor: { ...fileAnchor(dir), note: () => false } };
  await run({ evaluate: () => at(A, "RED"), dbPath, ...stuck });
  assert.equal(readAnchor(dir, REPO)?.latest.get(PR), 1, "control: the anchor stayed behind the order");
  const db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.equal("top" in order && order.top, 2, "control: the order ran ahead of it");
  await run({ openPrs: () => [], evaluate: () => at(A), dbPath, prState: () => "CLOSED", prIsFinished: () => true, ...host(dir) });
  assert.equal(readAnchor(dir, REPO)?.latest.get(PR), 2);
});

test("the first entry of a pull request's order names every record kept for it before, so none can be taken away unseen", async () => {
  const dir = credentials();
  // A store that began signing before orders did: two records of #42, and no entry.
  const dbPath = await ticks([at(A), at(B, "RED")], { signer: fileSigner(dir) });
  await run({ evaluate: () => at(B, "RED"), dbPath, ...host(dir) });
  const db = open(dbPath);
  const [older] = digestsOf(db);
  db.prepare("DELETE FROM decision WHERE digest = ?").run(older);
  const replayed = replayDecisions(db, { pr: PR }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((r) => r.digest === older && /names this record, but the store no longer holds it/.test(String(r.why))), JSON.stringify(replayed));
});

test("a record superseded within the tick that kept it is named by the order's entry", async () => {
  const dir = credentials();
  const QUEUED = "c".repeat(40);
  const readQueue = () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: QUEUED, baseSha: "f".repeat(40), state: "AWAITING_CHECKS", prHead: A }] });
  const evaluateQueue = ({ entry, input: i }) => { const q = { ...i, head: entry.sha }; return { ok: true, input: q, verdict: computeVerdict(q) }; };
  const dbPath = join(tempDir("reeve-order-superseded-"), "s.db");
  open(dbPath).close();
  await run({ evaluate: () => at(A), readQueue, evaluateQueue, dbPath, ...host(dir) });
  const db = open(dbPath);
  const head = db.prepare("SELECT digest FROM decision WHERE head = ?").get(A)?.digest;
  assert.ok(head, "control: the head's record was kept");
  db.prepare("DELETE FROM decision WHERE digest = ?").run(head);
  const replayed = replayDecisions(db, { pr: PR }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((r) => r.digest === head && /no longer holds it/.test(String(r.why))), JSON.stringify(replayed));
});

test("a pull request never judged again once orders begin still has its records named", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(B, "RED")], { signer: fileSigner(dir) });
  // The tick that begins orders judges another pull request only.
  await run({ openPrs: () => [43], evaluate: () => ({ ...at(A), pr: 43 }), prState: () => "CLOSED", prIsFinished: () => true, dbPath, ...host(dir) });
  const db = open(dbPath);
  const [older] = digestsOf(db);
  db.prepare("DELETE FROM decision WHERE digest = ?").run(older);
  const replayed = replayDecisions(db, {}, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((r) => r.digest === older && /no longer holds it/.test(String(r.why))), JSON.stringify(replayed));
});

test("an entry of another host's order, of the same repository, doesn't pass for one of this store's", async () => {
  const dir = credentials(), otherDir = credentials();
  const ours = await ticks([at(A)], host(dir));
  const theirs = await ticks([at(A, "RED")], host(otherDir));
  // Their entry 1, and the record it names, put in this store in place of its own.
  const t = open(theirs);
  const entry = t.prepare("SELECT at, actor, op, subject, payload FROM event WHERE op = 'decision.latest'").get();
  const rec = t.prepare("SELECT * FROM decision WHERE pr = ?").get(PR);
  t.close();
  assert.ok(entry && rec, "control: the other host signed an entry");
  const db = open(ours);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest'").run();
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(entry.at, entry.actor, entry.op, entry.subject, entry.payload);
  const cols = Object.keys(rec);
  db.prepare(`INSERT OR REPLACE INTO decision(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => rec[c]));
  // Both hosts' keys are known: the other's published, as it would be.
  const published = tempDir("reeve-order-published-");
  for (const [id, v] of knownKeys({ local: otherDir })) writeFileSync(join(published, `${id}.pub`), readFileSync(v.path));
  const keys = knownKeys({ published, local: dir });
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: anchorOf(dir) });
  const replayed = replayDecisions(db, { pr: PR }, { keys, repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: entry 1 of its signed order is another store's/);
  assert.ok(replayed.some((r) => /entry 1 of its signed order is another store's/.test(String(r.why))), JSON.stringify(replayed));
});

test("a record kept while its pull request's latest stays the same is named by a new entry", async () => {
  const dir = credentials();
  const dbPath = join(tempDir("reeve-order-side-"), "s.db");
  open(dbPath).close();
  const SIDE = "e".repeat(40);
  let tick = 0, side = null;
  await run({ openPrs: () => { tick++; return [PR]; }, dbPath, ticks: 2, ...host(dir),
              evaluate: () => {
                if (tick === 2 && !side) {
                  // A record of another commit, kept beside the latest, which stays the same.
                  const store = open(dbPath);
                  const i = input(SIDE);
                  const k = recordsFor({ nwo: REPO, pr: PR, head: SIDE, input: i, verdict: computeVerdict(i), policy: policyOf({ identity: { key: REPO } }),
                                         code: { commit: "d".repeat(40), tree: "e".repeat(40), dirty: false, diff: null }, observedAt: new Date(0).toISOString() });
                  saveDecision(store, { at: 1, seq: 1, pr: PR, head: SIDE, ...k });
                  store.close();
                  side = k.decision.digest;
                }
                return at(A);
              } });
  assert.ok(side, "control: the side record was kept");
  const db = open(dbPath);
  db.prepare("DELETE FROM decision WHERE digest = ?").run(side);
  const replayed = replayDecisions(db, { pr: PR }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((r) => r.digest === side && /no longer holds it/.test(String(r.why))), JSON.stringify(replayed));
});

// ── from #278's sixth review ─────────────────────────────────────────────────

test("replay --since still checks a pull request whose records and entries were all taken away", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(A, "RED")], host(dir));
  // Another pull request judged after, whose record the date takes.
  await run({ openPrs: () => [43], evaluate: () => ({ ...at(B), pr: 43 }), prState: () => "CLOSED", prIsFinished: () => true, dbPath, ...host(dir) });
  const db = open(dbPath);
  db.prepare("DELETE FROM decision WHERE pr = ?").run(PR);
  db.prepare("DELETE FROM event WHERE subject = ?").run(`pr:${PR}`);
  const replayed = replayDecisions(db, { since: 0 }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((r) => r.pr === 43), "control: the date takes the other pull request's record");
  assert.ok(replayed.some((r) => r.pr === PR && /though this host signed up to entry 2/.test(String(r.why))), JSON.stringify(replayed));
});

test("replay --since still checks the records an order names that the store no longer holds", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(A, "RED")], host(dir));
  await run({ openPrs: () => [43], evaluate: () => ({ ...at(B), pr: 43 }), prState: () => "CLOSED", prIsFinished: () => true, dbPath, ...host(dir) });
  const db = open(dbPath);
  const gone = digestsOf(db);
  db.prepare("DELETE FROM decision WHERE pr = ?").run(PR);
  const replayed = replayDecisions(db, { since: 0 }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: null });
  db.close();
  assert.ok(gone.length === 2, "control: two records were taken away");
  for (const g of gone) assert.ok(replayed.some((r) => r.digest === g && /no longer holds it/.test(String(r.why))), `${g}: ${JSON.stringify(replayed)}`);
});

test("a pull request whose latest is seen again, already named, isn't extended or noted again", async () => {
  const dir = credentials();
  let notes = 0;
  const anchor = fileAnchor(dir);
  const counted = { ...anchor, note: (...args) => { notes++; return anchor.note(...args); } };
  await ticks([at(A), at(A), at(A)], { ...host(dir), anchor: counted });
  assert.equal(notes, 1, "noted once, when its entry was made");
});

// ── from #278's seventh review ───────────────────────────────────────────────

test("replay --pr reports a record its order names that was moved to another pull request", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  const [green] = digestsOf(db);
  // Out of what --pr 42 reads, though the store still holds a row under its key.
  db.prepare("UPDATE decision SET pr = 43 WHERE digest = ?").run(green);
  const replayed = replayDecisions(db, { pr: PR }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(!replayed.some((r) => r.pr === 43), "control: the filter leaves the moved record out");
  assert.ok(replayed.some((r) => r.pr === PR && r.digest === green && r.outcome === "unreplayable" &&
                                 /names this record, but the store's copy of it doesn't hold: its row names pull request 43/.test(String(r.why))),
            JSON.stringify(replayed));
});

test("replay --since reports a record its order names that was changed in place before the date", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  const [green] = digestsOf(db);
  db.prepare("UPDATE decision SET last_at = 1, record = json_set(record, '$.verdict.summary', 'all clear') WHERE digest = ?").run(green);
  const replayed = replayDecisions(db, { since: 2 }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((r) => r.outcome === "same"), "control: the date takes the newer record");
  assert.ok(replayed.some((r) => r.pr === PR && r.digest === green && /names this record, but the store's copy of it doesn't hold: its record doesn't match its digest/.test(String(r.why))),
            JSON.stringify(replayed));
});

test("replay reports a record an order names that the store holds as another pull request's", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  await run({ openPrs: () => [43], evaluate: () => ({ ...at(B), pr: 43 }), prState: () => "CLOSED", prIsFinished: () => true, dbPath, ...host(dir) });
  const db = open(dbPath);
  const [ours] = digestsOf(db);
  const theirs = db.prepare("SELECT digest FROM decision WHERE pr = 43").get()?.digest;
  const store = db.prepare("SELECT json_extract(payload, '$.id') AS id FROM event WHERE op = 'store.identity'").get()?.id;
  const k = signingKey(dir);
  assert.ok(theirs && store && k.ok, "control: #43's record, the store's identity and the host's key");
  // Entry 2 of #42's order, signed, names #43's record as one of #42's.
  const entry = { repo: REPO, pr: PR, n: 2, digest: ours, records: [theirs], store };
  const s = signStatement(latestStatement(entry), /** @type {any} */ (k));
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(3, "daemon", "decision.latest", `pr:${PR}`, JSON.stringify({ ...entry, pr: undefined, envelope: "envelope" in s ? s.envelope : null }));
  const replayed = replayDecisions(db, {}, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((r) => r.pr === 43 && r.digest === theirs && r.outcome === "same"), "control: #43's record replays as its own");
  assert.ok(replayed.some((r) => r.pr === PR && r.digest === theirs && /names this record, but the store holds it as pull request 43's/.test(String(r.why))),
            JSON.stringify(replayed));
});

test("a tick that can't list the repository's pull requests still notes an order that ran ahead of the host's anchor", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  // Its entry committed, and the note never made.
  const stuck = { ...host(dir), anchor: { ...fileAnchor(dir), note: () => false } };
  await run({ evaluate: () => at(A, "RED"), dbPath, ...stuck });
  assert.equal(readAnchor(dir, REPO)?.latest.get(PR), 1, "control: the anchor stayed behind the order");
  const r = await run({ openPrs: () => null, evaluate: () => at(A), dbPath, ...host(dir) });
  assert.match(r.log, /could not list PRs for o\/r/, "control: the list couldn't be read");
  assert.equal(readAnchor(dir, REPO)?.latest.get(PR), 2);
});

test("a store with no order to extend doesn't bind the host's anchor, so the store that has one still can", async () => {
  const dir = credentials();
  // Another store of the repository, named by --db, say: it judges nothing.
  const idle = join(tempDir("reeve-order-idle-store-"), "s.db");
  open(idle).close();
  await run({ openPrs: () => [], evaluate: () => at(A), dbPath: idle, ...host(dir) });
  assert.equal(readAnchor(dir, REPO)?.store ?? null, null, "the idle store didn't bind it");
  const dbPath = await ticks([at(A)], host(dir));
  const db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  const store = db.prepare("SELECT json_extract(payload, '$.id') AS id FROM event WHERE op = 'store.identity'").get()?.id;
  db.close();
  assert.ok("top" in order && order.top === 1, JSON.stringify(order));
  assert.equal(readAnchor(dir, REPO)?.store, store, "the store with an order to extend bound it");
});

// ── from #278's eighth review ────────────────────────────────────────────────

/** A tick of the store at `dbPath` whose pull requests are all closed: nothing is judged. */
const closedTick = (dbPath, ctx) => run({ openPrs: () => [], evaluate: () => at(A), prState: () => "CLOSED", prIsFinished: () => true, dbPath, ...ctx });
/** The store's identity, as it keeps it. */
const identityOf = (db) => db.prepare("SELECT json_extract(payload, '$.id') AS id FROM event WHERE op = 'store.identity'").get()?.id;

test("a store with no order to extend says nothing on the host's anchor, so another store's records from before signing are still vouched for", async () => {
  const dir = credentials();
  // A store kept before signing: its record unsigned, and no baseline.
  const dbPath = await ticks([at(A, "RED")], {});
  // Another store of the repository, named by --db say, begins signing first and judges nothing.
  const idle = join(tempDir("reeve-order-idle-first-"), "s.db");
  open(idle).close();
  // Twice: the second time with an identity of its own, kept by the first.
  await run({ openPrs: () => [], evaluate: () => at(A), dbPath: idle, ticks: 2, ...host(dir) });
  const said = readAnchor(dir, REPO);
  await closedTick(dbPath, host(dir));
  const db = open(dbPath);
  const shown = explainDecision(db, PR, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorFor(db, dir) });
  const baselines = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'signing.baseline'").get().n;
  db.close();
  assert.equal(said?.began ?? false, false, "the idle store didn't say on the anchor that a store began");
  assert.equal(baselines, 1, "the store with records was given its baseline");
  assert.match(String(shown), /kept before this store began signing/);
  assert.doesNotMatch(String(shown), /can't be trusted/);
});

test("a baseline made while another reeve holds the host's lock is committed synced to disk all the same", async () => {
  const dir = credentials();
  // Over no record: one that vouches for records begins the anchor's binding,
  // and waits for the lock (#281).
  const dbPath = join(tempDir("reeve-order-empty-"), "s.db");
  open(dbPath).close();
  const seen = [];
  const count = (db) => db.prepare("SELECT count(*) AS n FROM event WHERE op = 'signing.baseline'").get().n;
  const watched = (db, fn) => durably(db, () => {
    const level = db.prepare("PRAGMA synchronous").get().synchronous;
    const before = count(db);
    const r = fn();
    seen.push({ level, baseline: count(db) > before });
    return r;
  });
  const other = fileAnchor(dir).lock(REPO);
  assert.ok(other && "release" in other, "control: the lock was taken");
  try { await run({ evaluate: () => at(A), dbPath, ...host(dir), durably: watched }); } finally { other.release(); }
  const db = open(dbPath);
  const baselines = count(db);
  db.close();
  assert.equal(baselines, 1, "control: the baseline was made");
  assert.ok(seen.some((x) => x.baseline && x.level === 2), `it committed at FULL: ${JSON.stringify(seen)}`);
});

test("an older record a store edit raises isn't signed as the latest, whether or not its pull request is judged again", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(A, "RED")], host(dir));
  // A record kept by a reeve that couldn't order it: the one record no entry names yet.
  await run({ evaluate: () => at(B, "RED"), dbPath, ...unordered(dir) });
  let db = open(dbPath);
  const [green, red, unnamed] = digestsOf(db);
  assert.ok(unnamed, "control: it was kept");
  db.prepare("UPDATE decision SET last_seq = 1000000 WHERE digest = ?").run(green);
  db.close();
  // Closed, and never judged again: the reeve ordering it kept none of its records.
  await closedTick(dbPath, host(dir));
  db = open(dbPath);
  const leftOver = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.equal("digest" in leftOver && leftOver.digest, red, "the order keeps the latest this host signed, not the raised one");
  // Reopened and judged again: the reeve judging it kept the newest record.
  await run({ evaluate: () => at(A, "RED"), dbPath, ...host(dir) });
  db = open(dbPath);
  const newest = digestsOf(db).at(-1);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  const shown = explainDecision(db, PR, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(newest !== green && newest !== red, "control: a record kept after the raised one");
  assert.equal("digest" in order && order.digest, newest, "the order ends at the record this host kept last, not the raised one");
  assert.match(String(shown), new RegExp(`can't be trusted as the latest: its signed order ends at record ${String(newest).slice(0, 12)}`));
});

test("a record a store edit put in, unsigned, isn't signed as the latest though no entry names it yet", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A, "RED")], host(dir));
  let db = open(dbPath);
  const [first] = digestsOf(db);
  const i = input(B);
  const k = recordsFor({ nwo: REPO, pr: PR, head: B, input: i, verdict: computeVerdict(i), policy: policyOf({ identity: { key: REPO } }),
                         code: { commit: "d".repeat(40), tree: "e".repeat(40), dirty: false, diff: null }, observedAt: new Date(0).toISOString() });
  saveDecision(db, { at: 1, seq: 1000000, pr: PR, head: B, ...k });
  db.close();
  await closedTick(dbPath, host(dir));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.ok("digests" in order && order.digests.has(k.decision.digest), `control: it's named, as a record the store holds: ${JSON.stringify(order)}`);
  assert.equal("digest" in order && order.digest, first, "the order's latest stays the record this host signed");
});

test("where more than one record no entry names is kept, the store's own order doesn't pick which is the latest", async () => {
  const dir = credentials();
  const C = "c".repeat(40);
  const dbPath = await ticks([at(A, "RED")], host(dir));
  // Two records kept, each by a reeve that couldn't order it.
  for (const head of [B, C]) await run({ evaluate: () => at(head, "RED"), dbPath, ...unordered(dir) });
  await closedTick(dbPath, host(dir));
  const db = open(dbPath);
  const [first, ...kept] = digestsOf(db);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.equal(kept.length, 2, "control: two records kept since the first entry");
  assert.ok("digests" in order && kept.every((d) => order.digests.has(d)), `control: both are named: ${JSON.stringify(order)}`);
  assert.equal("digest" in order && order.digest, first, "and the order's latest stays the one this host signed");
});

test("an entry that doesn't check never counts as naming a record, so the order it's in is checked and said not to hold", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  // A record kept by a reeve that couldn't order it, so no entry names it yet.
  await run({ evaluate: () => at(A, "RED"), dbPath, ...unordered(dir) });
  let db = open(dbPath);
  const [, red] = digestsOf(db);
  assert.ok(red, "control: it was kept");
  // A store edit: an entry, unsigned, that names it, numbered as no entry is.
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(3, "daemon", "decision.latest", `pr:${PR}`, JSON.stringify({ repo: REPO, n: "x", digest: red, records: [red], store: null, envelope: "{}" }));
  db.close();
  const r = await closedTick(dbPath, host(dir));
  assert.match(r.log, /#42: its signed order doesn't hold, so it isn't extended/);
});

test("a record this reeve kept, taken away before an entry named it, is named all the same, so replay reports it gone", async () => {
  const dir = credentials();
  const dbPath = join(tempDir("reeve-order-taken-first-"), "s.db");
  open(dbPath).close();
  let tick = 0, gone = [];
  // The second and third ticks' records aren't ordered, as no entry can be reserved.
  const real = fileAnchor(dir);
  const anchor = { ...real, reserve: (/** @type {any[]} */ ...args) => (tick === 2 || tick === 3 ? false : real.reserve(...args)) };
  await run({ ticks: 4, dbPath, ...host(dir), anchor, prState: () => "CLOSED", prIsFinished: () => true,
              evaluate: () => (tick === 1 ? at(A) : at(tick === 2 ? A : B, "RED")),
              openPrs: () => {
                tick++;
                if (tick < 4) return [PR];
                // Then both are taken away, the latest and the one it superseded, before a tick orders them.
                const s = open(dbPath);
                gone = s.prepare("SELECT digest FROM decision WHERE pr = ? AND digest NOT IN (SELECT json_extract(payload, '$.digest') FROM event WHERE op = 'decision.latest')").all(PR).map((r) => r.digest);
                s.prepare(`DELETE FROM decision WHERE digest IN (${gone.map(() => "?").join(",")})`).run(...gone);
                s.close();
                return [];
              } });
  const db = open(dbPath);
  const replayed = replayDecisions(db, { pr: PR }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.equal(gone.length, 2, "control: two records were taken away");
  for (const g of gone) assert.ok(replayed.some((r) => r.digest === g && /no longer holds it/.test(String(r.why))), `${g}: ${JSON.stringify(replayed)}`);
});

test("an order that doesn't check is said not to hold, though its pull request's records are all gone", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A, "RED")], host(dir));
  const db = open(dbPath);
  db.prepare("DELETE FROM decision WHERE pr = ?").run(PR);
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(3, "daemon", "decision.latest", `pr:${PR}`, JSON.stringify({ repo: REPO, n: "x", digest: "f".repeat(64), records: [], store: null, envelope: "{}" }));
  db.close();
  const r = await closedTick(dbPath, host(dir));
  assert.match(r.log, /#42: its signed order doesn't hold, so it isn't extended/);
});

// ── from #278's ninth review ─────────────────────────────────────────────────

test("a reeve doesn't sign what it kept as the latest over a record another reeve on the store kept after it", async () => {
  const dir = credentials();
  const C = "c".repeat(40);
  const dbPath = await ticks([at(A, "RED")], host(dir));
  let tick = 0;
  // The first reeve keeps a record and can't order it, as no entry can be
  // reserved. Before its next tick, a second reeve keeps a newer one and orders both.
  const real = fileAnchor(dir);
  const anchor = { ...real, reserve: (/** @type {any[]} */ ...args) => (tick === 1 ? false : real.reserve(...args)) };
  await run({ ticks: 2, dbPath, ...host(dir), anchor, prState: () => "CLOSED", prIsFinished: () => true,
              evaluate: () => at(B, "RED"),
              openPrs: () => {
                tick++;
                return tick === 1 ? [PR] : [];
              },
              afterTick: async (i) => {
                if (i !== 0) return;
                await run({ evaluate: () => at(C, "RED"), dbPath, ...host(dir) });
              } });
  const db = open(dbPath);
  const first = db.prepare("SELECT digest FROM decision WHERE head = ?").get(B)?.digest;
  const second = db.prepare("SELECT digest FROM decision WHERE head = ?").get(C)?.digest;
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.ok(first && second, "control: each reeve kept a record");
  assert.ok("digests" in order && order.digests.has(first), `control: the first reeve's record is named: ${JSON.stringify(order)}`);
  assert.equal("digest" in order && order.digest, second, "the order ends at the record kept last, the second reeve's");
});

test("a home made on the way to the host's anchor is synced into the folder that holds it, by writes until it holds", () => {
  for (const how of ["lock", "write", "retry"]) {
    const top = tempDir("reeve-order-new-home-");
    const dir = join(top, "home", "credentials");
    const seen = [];
    let failing = how === "retry";
    const anchor = fileAnchor(dir, { syncDir: (d) => { if (failing && d === top) throw new Error("input/output error"); seen.push(d); } });
    if (how === "lock") {
      const lock = anchor.lock(REPO);
      assert.ok(lock && "release" in lock, "control: the lock was taken, making the folders on its way");
      lock.release();
    }
    const first = anchor.note(REPO, 7, 1);
    if (how === "retry") {
      assert.equal(first, false, "control: the sync of the folder holding the home failed");
      failing = false;
      assert.equal(anchor.note(REPO, 7, 1), true, "control: a later write, changing nothing, holds");
    } else assert.equal(first, true, "control: the anchor was written");
    assert.ok(seen.includes(top), `${how}: the folder holding the home made there was synced: ${JSON.stringify(seen)}`);
  }
});

test("an entry whose latest isn't placed in the store's sequence by a whole number isn't one", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A)], host(dir)));
  const k = signingKey(dir);
  const [digest] = digestsOf(db);
  // Signed as it says: only what it says is wrong.
  const entry = { repo: REPO, pr: PR, n: 2, digest, records: [], store: identityOf(db), seq: -1 };
  const s = signStatement(latestStatement(entry), /** @type {any} */ (k));
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(3, "daemon", "decision.latest", `pr:${PR}`, JSON.stringify({ ...entry, pr: undefined, envelope: "envelope" in s ? s.envelope : null }));
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.equal(k.ok, true, "control: the host's key");
  assert.deepEqual(order, { corrupt: "an entry of its signed order isn't one" });
});

// ── from #278's tenth review ─────────────────────────────────────────────────

test("after a restart, a record another host signed, its key published, isn't signed as the latest", async () => {
  const dir = credentials(), otherDir = credentials();
  const dbPath = await ticks([at(A, "RED")], host(dir));
  // Another host's record of the same pull request, and its key published, as it would be.
  const theirs = open(await ticks([at(B, "RED")], host(otherDir)));
  const rec = theirs.prepare("SELECT * FROM decision WHERE pr = ?").get(PR);
  theirs.close();
  const published = tempDir("reeve-order-published-");
  for (const [id, v] of knownKeys({ local: otherDir })) writeFileSync(join(published, `${id}.pub`), readFileSync(v.path));
  let db = open(dbPath);
  const [ours] = digestsOf(db);
  // Put in by a store edit as this store's latest, the one record no entry names.
  const cols = Object.keys(rec);
  db.prepare(`INSERT INTO decision(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => (c === "last_seq" ? 1000000 : rec[c])));
  db.close();
  // A reeve that kept neither record, checking orders with both hosts' keys.
  const keys = () => knownKeys({ published, local: dir });
  await closedTick(dbPath, { ...host(dir), keys });
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, keys());
  db.close();
  assert.ok(rec && "digests" in order && order.digests.has(rec.digest), `control: it's named, as a record the store holds: ${JSON.stringify(order)}`);
  assert.equal("digest" in order && order.digest, ours, "the order's latest stays the record this host signed");
});

test("an entry filed under another spelling of a pull request's name fails every order while it's there, so none is signed afresh", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(A, "RED")], host(dir));
  let db = open(dbPath);
  const [, red] = digestsOf(db);
  // Every entry of #42 filed as pr:042, its newest record taken away, and the host's anchor gone.
  db.prepare("UPDATE event SET subject = 'pr:042' WHERE op = 'decision.latest'").run();
  db.prepare("DELETE FROM decision WHERE digest = ?").run(red);
  const before = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  const keys = knownKeys({ local: dir });
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: null });
  const replayed = replayDecisions(db, {}, { keys, repo: REPO, anchor: null });
  db.close();
  rmSync(anchorPath(dir, REPO), { force: true });
  const r = await closedTick(dbPath, host(dir));
  db = open(dbPath);
  const after = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: an entry of a signed order in this store is filed under "pr:042"/);
  assert.ok(replayed.some((x) => x.outcome === "unreplayable" && /filed under "pr:042"/.test(String(x.why))), JSON.stringify(replayed));
  assert.equal(after, before, "no entry signed afresh");
  // With the host's anchor gone, its order not holding, the store isn't bound to it either.
  assert.match(r.log, /#42's signed order in this store doesn't hold, so the host's anchor for o\/r isn't bound to it — an entry of a signed order in this store is filed under "pr:042"/);
});

test("replay of one record checks its pull request's order, so a record that survived a rollback doesn't pass as whole", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  const [green, red] = digestsOf(db);
  db.prepare("DELETE FROM decision WHERE digest = ?").run(red);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  const replayed = replayDecisions(db, { digest: green }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((x) => x.digest === green && x.outcome === "same"), `control: the record replays as it was: ${JSON.stringify(replayed)}`);
  assert.ok(replayed.some((x) => /ends at entry 1, though this host signed up to entry 2/.test(String(x.why))), JSON.stringify(replayed));
});

test("replay reports an entry filed under a name that's no pull request's, though no pull request's records are left", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A, "RED")], host(dir)));
  db.prepare("UPDATE event SET subject = 'zz' WHERE op = 'decision.latest'").run();
  db.prepare("DELETE FROM decision").run();
  const replayed = replayDecisions(db, {}, { keys: knownKeys({ local: dir }), repo: REPO, anchor: null });
  db.close();
  assert.ok(replayed.some((x) => x.outcome === "unreplayable" && /filed under "zz"/.test(String(x.why))), JSON.stringify(replayed));
});

test("an entry filed under another name while a reeve runs is caught by its next tick, whatever it checked before", async () => {
  const dir = credentials();
  const dbPath = join(tempDir("reeve-order-renamed-"), "s.db");
  open(dbPath).close();
  let tick = 0;
  // The first tick makes the entry, and the second finds its order whole; then it's filed as pr:042.
  const r = await run({ ticks: 3, dbPath, ...host(dir), prState: () => "CLOSED", prIsFinished: () => true,
                        evaluate: () => at(A, "RED"),
                        openPrs: () => (++tick === 1 ? [PR] : []),
                        afterTick: async (i) => {
                          if (i !== 1) return;
                          const s = open(dbPath);
                          s.prepare("UPDATE event SET subject = 'pr:042' WHERE op = 'decision.latest'").run();
                          s.close();
                        } });
  assert.match(r.log, /#42: its signed order doesn't hold, so it isn't extended — an entry of a signed order in this store is filed under "pr:042"/);
});

test("one reeve runs on a store at a time: its lock is held by one, a link to the store included", () => {
  const dbPath = join(tempDir("reeve-order-running-"), "s.db");
  open(dbPath).close();
  const link = join(tempDir("reeve-order-running-link-"), "s.db");
  symlinkSync(dbPath, link);
  const first = storeLock(dbPath);
  assert.ok(first && "release" in first, "control: the lock was taken");
  const second = storeLock(link);
  assert.ok(second && "why" in second && second.busy, "a second, through a link to the store, can't take it");
  first.release();
  const third = storeLock(link);
  assert.ok(third && "release" in third, "and can once it's released");
  third.release();
  // A lock file that's a link is never locked through.
  const other = join(tempDir("reeve-order-running-other-"), "s.db");
  open(other).close();
  symlinkSync(join(tempDir("reeve-order-running-elsewhere-"), "x"), `${other}.running`);
  const linked = storeLock(other);
  assert.ok(linked && "why" in linked && /isn't a file of its own/.test(linked.why), JSON.stringify(linked));
  // A store with another name, a hard link, isn't run on at all: each name's lock would be its own.
  const named = join(tempDir("reeve-order-running-named-"), "s.db");
  open(named).close();
  linkSync(named, join(dirname(named), "also.db"));
  const twice = storeLock(named);
  assert.ok(twice && "why" in twice && /has another name besides this one, a hard link/.test(twice.why), JSON.stringify(twice));
});

test("reeve tick doesn't run on a store another reeve is running on", () => {
  const home = tempDir("reeve-order-running-cli-");
  mkdirSync(join(home, "profiles", "o"), { recursive: true });
  writeFileSync(join(home, "profiles", "o", "r.json"), JSON.stringify(withDefaults({ schemaVersion: 1, project: { kind: "product" },
    identity: { key: REPO, defaultBranch: "main", visibility: "public" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
    state: { mode: "in-repo" }, units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] })));
  // Were it to tick, the tick would halt at once, reaching nothing.
  writeFileSync(join(home, "HALT"), "");
  const dbPath = join(home, "s.db");
  open(dbPath).close();
  const other = storeLock(dbPath);
  assert.ok(other && "release" in other, "control: another reeve holds the store's lock");
  let r;
  try { r = spawnSync(process.execPath, [REEVE, "tick", REPO, "--db", dbPath], { cwd: home, encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: home } }); }
  finally { other.release(); }
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /another reeve is running on .*s\.db; one runs on a store at a time/);
});

// ── from #278's eleventh review ──────────────────────────────────────────────

test("an entry filed under a number past what reeve writes is a stray, though it's spelled as one", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  // Past the largest whole number JavaScript holds exactly: read back, it would name another.
  db.prepare("UPDATE event SET subject = 'pr:9007199254740993' WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  const keys = knownKeys({ local: dir });
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: null });
  const replayed = replayDecisions(db, {}, { keys, repo: REPO, anchor: null });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: an entry of a signed order in this store is filed under "pr:9007199254740993"/);
  assert.ok(replayed.some((x) => x.outcome === "unreplayable" && /filed under "pr:9007199254740993"/.test(String(x.why))), JSON.stringify(replayed));
});

test("an order goes on across a change of this host's key, the reeve still running", async () => {
  const dir = credentials();
  const dbPath = join(tempDir("reeve-order-rotated-"), "s.db");
  open(dbPath).close();
  let tick = 0;
  const r = await run({ ticks: 3, dbPath, ...host(dir),
                        evaluate: () => (tick === 1 ? at(A) : at(A, "RED")),
                        openPrs: () => { tick++; return [PR]; },
                        // After the first tick, the key is moved aside, as when it's lost: the next signature makes another.
                        afterTick: async (i) => { if (i === 0) renameSync(join(dir, "signing-ed25519.pem"), join(dir, "moved-aside.pem")); } });
  const db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  const envelopes = db.prepare("SELECT payload FROM event WHERE op = 'decision.latest' ORDER BY seq").all().map((x) => JSON.parse(JSON.parse(x.payload).envelope).signatures[0].keyid);
  db.close();
  assert.equal(new Set(envelopes).size, 2, `control: its entries were signed by two keys: ${JSON.stringify(envelopes)}`);
  assert.equal("top" in order && order.top, 2, JSON.stringify(order));
  assert.doesNotMatch(r.log, /its signed order doesn't hold/);
});

// ── from #278's twelfth review ───────────────────────────────────────────────

test("after a restart, a record copied in from another store of this host isn't signed as the latest", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A, "RED")], host(dir));
  // Another store of the repository, on this host: it keeps records, signed with this host's key, and orders none.
  const alternate = await ticks([at(B, "RED")], host(dir), join(tempDir("reeve-order-alternate-"), "s.db"));
  const alt = open(alternate);
  const rec = alt.prepare("SELECT * FROM decision WHERE pr = ?").get(PR);
  alt.close();
  let db = open(dbPath);
  const [ours] = digestsOf(db);
  // Copied in by a store edit, as this store's latest, the one record no entry names.
  const cols = Object.keys(rec);
  db.prepare(`INSERT INTO decision(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => (c === "last_seq" ? 1000000 : rec[c])));
  db.close();
  await closedTick(dbPath, host(dir));
  db = open(dbPath);
  const order = signedOrder(db, REPO, PR, knownKeys({ local: dir }));
  db.close();
  assert.ok(rec && "digests" in order && order.digests.has(rec.digest), `control: it's named, as a record the store holds: ${JSON.stringify(order)}`);
  assert.equal("digest" in order && order.digest, ours, "the order's latest stays the record this store kept");
});

test("a rollback that takes a pull request's every record and entry away is said by the daemon's next tick", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A), at(A, "RED")], host(dir));
  const db = open(dbPath);
  db.prepare("DELETE FROM decision WHERE pr = ?").run(PR);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest'").run();
  db.close();
  const r = await closedTick(dbPath, host(dir));
  assert.match(r.log, /#42: its signed order ends at entry 0, though this host signed up to entry 2, so it isn't extended/);
});

// ── from #278's thirteenth review ────────────────────────────────────────────

test("binding the host's anchor to a store says there that the store began signing", () => {
  const dir = credentials();
  const id = "a".repeat(32);
  assert.equal(fileAnchor(dir).bind(REPO, id), true, "control: bound");
  assert.deepEqual(readAnchor(dir, REPO), anchorAs({ began: true, latest: new Map(), store: id }));
});

test("a store stripped while its reeve was down, after a tick that bound the host's anchor and noted no entry, isn't given a baseline again", async () => {
  const dir = credentials();
  // The first ordering tick binds the anchor, and its reeve stops before an entry is noted.
  const h = host(dir);
  const dbPath = await ticks([at(A)], { ...h, anchor: { ...h.anchor, note: () => false } });
  const a = readAnchor(dir, REPO);
  assert.ok(a?.store && a.latest.size === 0, `control: bound, and no entry noted: ${JSON.stringify(a?.store)}, ${a?.latest.size}`);
  // While it's down, the store is stripped of its baseline, every signature and its order.
  let db = open(dbPath);
  db.prepare("DELETE FROM event WHERE op IN ('signing.baseline', 'decision.latest')").run();
  db.prepare("UPDATE decision SET envelope = NULL").run();
  db.close();
  const r = await run({ evaluate: () => at(B), dbPath, ...host(dir) });
  db = open(dbPath);
  const baselines = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'signing.baseline'").get().n;
  db.close();
  assert.equal(baselines, 0, "none made over records that may have been rewritten");
  assert.match(r.log, /the host's anchor says this store began signing, though it holds no baseline or signed record/);
});

test("a store holding entries of signed orders, its identity taken away, has none taken as checked where no host's anchor says which store it is", async () => {
  const dir = credentials(), otherDir = credentials();
  const ours = await ticks([at(A)], host(dir));
  const theirs = await ticks([at(A, "RED")], host(otherDir));
  const t = open(theirs);
  const entry = t.prepare("SELECT at, actor, op, subject, payload FROM event WHERE op = 'decision.latest'").get();
  const rec = t.prepare("SELECT * FROM decision WHERE pr = ?").get(PR);
  t.close();
  assert.ok(entry && rec, "control: the other host signed an entry");
  // Its records and order replaced with another host's, and its identity taken away.
  const db = open(ours);
  db.prepare("DELETE FROM event WHERE op IN ('decision.latest', 'store.identity')").run();
  db.prepare("DELETE FROM decision").run();
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(entry.at, entry.actor, entry.op, entry.subject, entry.payload);
  const cols = Object.keys(rec);
  db.prepare(`INSERT INTO decision(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => rec[c]));
  // Both hosts' keys known, the other's published, and checked where the host's anchor isn't: on another machine, say.
  const published = tempDir("reeve-order-published-");
  for (const [id, v] of knownKeys({ local: otherDir })) writeFileSync(join(published, `${id}.pub`), readFileSync(v.path));
  const keys = knownKeys({ published, local: dir });
  const shown = explainDecision(db, PR, { keys, repo: REPO, anchor: null });
  const replayed = replayDecisions(db, {}, { keys, repo: REPO, anchor: null });
  db.close();
  assert.match(String(shown), /can't be trusted as the latest: this store holds entries of signed orders, but no identity to check them against/);
  assert.doesNotMatch(String(shown), /the latest by its signed order/);
  assert.ok(replayed.some((x) => x.outcome === "unreplayable" && /no identity to check them against/.test(String(x.why))), JSON.stringify(replayed));
});

// ── from #278's fourteenth review ────────────────────────────────────────────

/** A record of `repo`'s pull request `pr` at `head`, as reeve keeps one. */
const recordOf = (repo, pr, head) => {
  const i = input(head);
  return recordsFor({ nwo: repo, pr, head, input: i, verdict: computeVerdict(i), policy: policyOf({ identity: { key: repo } }),
                      code: { commit: "d".repeat(40), tree: "e".repeat(40), dirty: false, diff: null }, observedAt: new Date(0).toISOString() });
};

test("reeve restore doesn't write over a store a reeve is running on, a reeve tick included", () => {
  const dir = tempDir("reeve-order-restore-");
  const dbPath = join(dir, "s.db"), snap = join(dir, "snap.db");
  open(dbPath).close();
  copyFileSync(dbPath, snap);
  // A reeve tick holds the store's lock, and no reeve run is seen.
  const running = storeLock(dbPath);
  assert.ok("release" in running, "control: the store's lock is held");
  let r;
  try { r = restore(snap, dbPath, { overwrite: true, isDaemonRunning: () => null }); } finally { running.release(); }
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.why), /another reeve is running on .*s\.db/);
  const after = restore(snap, dbPath, { overwrite: true, isDaemonRunning: () => null });
  assert.equal(after.ok, true, `and once it's released, the store is restored: ${JSON.stringify(after)}`);
});

/**
 * A store kept before signing, with records of #42 and #43, that begins signing
 * under a reeve whose reservations fail, so no order names either yet (a
 * baseline over records now waits for the host's lock, #281); then
 * `edit` is made, #43's record taken away unless it says otherwise. Answers the
 * store, and that record.
 */
async function lostBeforeOrdered(dir, edit = "DELETE FROM decision WHERE pr = 43") {
  const dbPath = await ticks([at(A)], {});
  let db = open(dbPath);
  const k = recordOf(REPO, 43, B);
  saveDecision(db, { at: 1, seq: 1000, pr: 43, head: B, ...k });
  db.close();
  await closedTick(dbPath, { ...host(dir), anchor: { ...fileAnchor(dir), reserve: () => false } });
  db = open(dbPath);
  const baseline = JSON.parse(db.prepare("SELECT payload FROM event WHERE op = 'signing.baseline'").get()?.payload ?? "{}").digests ?? [];
  const entries = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest'").get().n;
  db.prepare(edit).run();
  db.close();
  assert.ok(baseline.includes(k.decision.digest) && entries === 0, `control: the baseline names it, and no order does: ${baseline.length} named, ${entries} entries`);
  return { dbPath, lost: k.decision.digest };
}

test("a record the store's baseline names, taken away before an order named it, is reported by a whole-store replay", async () => {
  const dir = credentials();
  const { dbPath, lost } = await lostBeforeOrdered(dir);
  const db = open(dbPath);
  const replayed = replayDecisions(db, {}, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((x) => x.digest === lost && x.outcome === "unreplayable" && /the store's baseline names this record.*no longer holds it/.test(String(x.why))),
            JSON.stringify(replayed));
});

test("a record the store's baseline names, taken away before an order named it, is said by the daemon's every tick", async () => {
  const dir = credentials();
  const { dbPath, lost } = await lostBeforeOrdered(dir);
  const r = await run({ openPrs: () => [], evaluate: () => at(A), prState: () => "CLOSED", prIsFinished: () => true, dbPath, ticks: 2, ...host(dir) });
  const said = r.log.match(/the store's baseline names 1 record\(s\) kept before it began signing that it doesn't hold as they were kept, and no signed order names: [0-9a-f]{12} \(the store no longer holds it\)/g) ?? [];
  assert.equal(said.length, 2, `said on each tick: ${r.log}`);
  assert.ok(said.every((s) => s.includes(lost.slice(0, 12))), JSON.stringify(said));
});

test("a store holding another repository's records doesn't bind the host's anchor, so that repository's own store still can", async () => {
  const dir = credentials();
  // Another repository's store, named by --db say: a record of x/y's #43 in it.
  const foreign = join(tempDir("reeve-order-foreign-"), "s.db");
  const f = open(foreign);
  saveDecision(f, { at: 1, seq: 1, pr: 43, head: A, ...recordOf("x/y", 43, A) });
  f.close();
  const r = await closedTick(foreign, host(dir));
  assert.equal(readAnchor(dir, REPO)?.store ?? null, null, "the host's anchor for o/r isn't bound to it");
  assert.match(r.log, /this store holds records of x\/y, so it isn't taken as o\/r's own, and the host's anchor for o\/r isn't bound to it/);
  const db = open(await ticks([at(A)], host(dir)));
  const id = identityOf(db);
  db.close();
  assert.equal(readAnchor(dir, REPO)?.store, id, "and o/r's own store binds it");
});

// ── from #278's fifteenth review ─────────────────────────────────────────────

test("a store holding only another repository's order, and no records, doesn't bind the host's anchor, so the repository's own store still can", async () => {
  const dir = credentials();
  const k = signingKey(dir, { create: true });
  assert.equal(k.ok, true, "control: the host's key");
  // Another repository's store, named by --db say: an entry of x/y's order in it, signed by this host, and no record.
  const foreign = join(tempDir("reeve-order-foreign-order-"), "s.db");
  const f = open(foreign);
  const digest = "f".repeat(64);
  const s = signStatement(latestStatement({ repo: "x/y", pr: 43, n: 1, digest }), /** @type {any} */ (k));
  f.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(1, "daemon", "decision.latest", "pr:43", JSON.stringify({ repo: "x/y", n: 1, digest, records: [], store: null, envelope: "envelope" in s ? s.envelope : null }));
  f.close();
  const r = await closedTick(foreign, host(dir));
  assert.equal(readAnchor(dir, REPO)?.store ?? null, null, "the host's anchor for o/r isn't bound to it");
  assert.match(r.log, /#43's signed order in this store doesn't hold, so the host's anchor for o\/r isn't bound to it — entry 1 of its signed order is of x\/y, not of o\/r/);
  const db = open(await ticks([at(A)], host(dir)));
  const id = identityOf(db);
  db.close();
  assert.equal(readAnchor(dir, REPO)?.store, id, "and o/r's own store binds it");
});

test("a record the store's baseline names, changed in place before an order named it, is reported by a replay since a later date", async () => {
  const dir = credentials();
  // Its verdict rewritten under its own digest; kept long before the date replayed from.
  const { dbPath, lost } = await lostBeforeOrdered(dir, "UPDATE decision SET record = json_set(record, '$.verdict.summary', 'rewritten') WHERE pr = 43");
  const db = open(dbPath);
  const replayed = replayDecisions(db, { since: Math.floor(Date.now() / 1000) - 3600 }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) });
  db.close();
  assert.ok(replayed.some((x) => x.digest === lost && x.outcome === "unreplayable"
                               && /baseline names this record.*but the store's copy of it doesn't hold: its record doesn't match its digest/.test(String(x.why))),
            JSON.stringify(replayed));
});

test("reeve restore puts a store that's gone back whole, never a part of it where a reeve could start on it", () => {
  const dir = tempDir("reeve-order-restore-gone-");
  const dbPath = join(dir, "s.db"), snap = join(dir, "snap.db");
  open(dbPath).close();
  copyFileSync(dbPath, snap);
  // Lost with a disk, say.
  for (const s of ["", "-wal", "-shm"]) rmSync(dbPath + s, { force: true });
  let to = null, there = null;
  const r = restore(snap, dbPath, { isDaemonRunning: () => null, copy: (from, dest) => { to = dest; copyFileSync(from, dest); there = existsSync(dbPath); } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(to && to !== dbPath, `copied to a file of its own: ${to}`);
  assert.equal(there, false, "the store's name wasn't there while it was copied");
  assert.equal(existsSync(to), false, "and the copy was renamed into place");
  assert.ok(existsSync(dbPath), "control: the store is back");
});

test("replay since a date reports a record its order names whose row can't be read, rather than stopping", async () => {
  const dir = credentials();
  const db = open(await ticks([at(A), at(A, "RED")], host(dir)));
  const [green] = digestsOf(db);
  // Its record no longer JSON, and kept long before the date replayed from.
  db.prepare("UPDATE decision SET record = '{', first_at = 1, last_at = 1 WHERE digest = ?").run(green);
  let replayed = null, threw = null;
  try { replayed = replayDecisions(db, { since: Math.floor(Date.now() / 1000) - 3600 }, { keys: knownKeys({ local: dir }), repo: REPO, anchor: anchorOf(dir) }); }
  catch (e) { threw = e; }
  db.close();
  assert.equal(threw, null, `replay stopped: ${threw?.message}`);
  assert.ok(replayed?.some((x) => x.digest === green && /its signed order names this record, but the store's copy of it doesn't hold: its record can't be read/.test(String(x.why))),
            JSON.stringify(replayed));
});

// ── from #278's sixteenth review ─────────────────────────────────────────────

test("a store holding a record whose repository can't be read doesn't bind the host's anchor, so the repository's own store still can", async () => {
  const dir = credentials();
  // A record that isn't JSON, and one that names no repository.
  for (const record of ["{", JSON.stringify({ subject: { pr: 43, head: A } })]) {
    const other = join(tempDir("reeve-order-unreadable-"), "s.db");
    const f = open(other);
    f.prepare("INSERT INTO decision(digest, pr, head, record, first_at, last_at, first_seq, last_seq, envelope, unsigned) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("e".repeat(64), 43, A, record, 1, 1, 1, 1, null, "kept before signing");
    f.close();
    const r = await closedTick(other, host(dir));
    assert.equal(readAnchor(dir, REPO)?.store ?? null, null, `the host's anchor for o/r isn't bound to a store holding ${record}`);
    assert.match(r.log, /this store holds a record whose repository can't be read, so it isn't taken as o\/r's own, and the host's anchor for o\/r isn't bound to it/);
  }
  const db = open(await ticks([at(A)], host(dir)));
  const id = identityOf(db);
  db.close();
  assert.equal(readAnchor(dir, REPO)?.store, id, "and o/r's own store binds it");
});

test("reeve restore syncs the store's folder once the store is in place, before it says it's restored", () => {
  const dir = tempDir("reeve-order-restore-sync-");
  const dbPath = join(dir, "s.db"), snap = join(dir, "snap.db");
  open(dbPath).close();
  copyFileSync(dbPath, snap);
  const synced = [];
  const r = restore(snap, dbPath, { overwrite: true, isDaemonRunning: () => null,
                                    syncDir: (d) => synced.push({ d, placed: !readdirSync(d).some((n) => n.endsWith(".restoring")) }) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(synced.at(-1), { d: realpathSync(dir), placed: true }, "its folder synced, once the copy was renamed into place");
  // Its last sync, the one once the copy is in place, failing.
  let n = 0;
  const failed = restore(snap, dbPath, { overwrite: true, isDaemonRunning: () => null, syncDir: () => { if (++n === 2) throw new Error("EIO: i/o error"); } });
  assert.equal(failed.ok, false, "and a store whose folder couldn't be synced isn't said to be restored");
  assert.match(String(failed.why), /is restored, but its folder couldn't be synced to disk/);
});

// ── from #278's seventeenth review ───────────────────────────────────────────

test("a store the host's anchor is bound to, stripped of its baseline and every record while its reeve was down, isn't given a baseline again", async () => {
  const dir = credentials();
  // The first ordering tick binds the anchor, and its reeve stops before an entry is noted.
  const h = host(dir);
  const dbPath = await ticks([at(A)], { ...h, anchor: { ...h.anchor, note: () => false } });
  let db = open(dbPath);
  const id = identityOf(db);
  // While it's down: its baseline, its records and its order all taken away.
  db.prepare("DELETE FROM event WHERE op IN ('signing.baseline', 'decision.latest')").run();
  db.prepare("DELETE FROM decision").run();
  db.close();
  const a = readAnchor(dir, REPO);
  assert.deepEqual({ began: a?.began, store: a?.store }, { began: true, store: id }, "control: the host's anchor is bound to it, and says it began");
  const r = await closedTick(dbPath, host(dir));
  db = open(dbPath);
  const baselines = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'signing.baseline'").get().n;
  db.close();
  assert.equal(baselines, 0, "none made over nothing, which would leave no digest to find the rollback by");
  assert.match(r.log, /the host's anchor says this store began signing, though it holds no baseline or signed record/);
});

test("a store holding a record of the repository that doesn't hold as it was kept doesn't bind the host's anchor, so the repository's own store still can", async () => {
  const dir = credentials();
  // A store kept before signing, named by --db say, its record's row moved to another pull request.
  const moved = await ticks([at(A)], {});
  let db = open(moved);
  db.prepare("UPDATE decision SET pr = 43").run();
  db.close();
  const r = await closedTick(moved, host(dir));
  assert.equal(readAnchor(dir, REPO)?.store ?? null, null, "the host's anchor for o/r isn't bound to it");
  assert.match(r.log, /this store holds a record of o\/r that doesn't hold as it was kept \(its row names pull request 43, but its record 42\), so it isn't taken as o\/r's own/);
  db = open(await ticks([at(A)], host(dir)));
  const id = identityOf(db);
  db.close();
  assert.equal(readAnchor(dir, REPO)?.store, id, "and o/r's own store binds it");
});

test("a restore whose copy can't be put in place leaves the store's log where it was, and nothing beside it", () => {
  const dir = tempDir("reeve-order-restore-log-");
  const dbPath = join(dir, "s.db"), snap = join(dir, "snap.db");
  open(dbPath).close();
  copyFileSync(dbPath, snap);
  // What the store committed before an unclean stop, in its log alone.
  writeFileSync(`${dbPath}-wal`, "committed");
  const rename = (from, to) => { if (to === dbPath) throw new Error("EIO: i/o error"); renameSync(from, to); };
  const r = restore(snap, dbPath, { overwrite: true, isDaemonRunning: () => null, rename });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(existsSync(`${dbPath}-wal`) && readFileSync(`${dbPath}-wal`, "utf8"), "committed", "the store's log is where it was");
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".restoring")), [], "and nothing is left beside it");
});

test("a restore puts right what one killed partway left: its copy removed, and the store's log it had moved aside put back", () => {
  const dir = tempDir("reeve-order-restore-reap-");
  const dbPath = join(dir, "s.db"), snap = join(dir, "snap.db");
  open(dbPath).close();
  copyFileSync(dbPath, snap);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  // One killed after moving the store's log aside, before its copy was put in place.
  writeFileSync(`${dbPath}.${gone}.deadbeef.restoring`, "partway");
  writeFileSync(`${dbPath}.${gone}.deadbeef.restoring-wal`, "committed");
  // One killed once its copy was in place, the old store's index still aside.
  writeFileSync(`${dbPath}.${gone}.cafebabe.restoring-shm`, "old");
  // And a running process's own.
  const live = `${dbPath}.${process.ppid}.feedface.restoring`;
  writeFileSync(live, "partway");
  let during = null;
  const r = restore(snap, dbPath, { overwrite: true, isDaemonRunning: () => null,
    copy: (from, to) => {
      during = { log: existsSync(`${dbPath}-wal`) && readFileSync(`${dbPath}-wal`, "utf8"), left: readdirSync(dir).filter((n) => n.includes(".restoring")).sort() };
      copyFileSync(from, to);
    } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(during, { log: "committed", left: [basename(live)] }, "the log put back, and only a running process's left");
});

// ── from #278's eighteenth review ────────────────────────────────────────────

test("a store holding a record filed under no pull request's number doesn't bind the host's anchor, which still reads", async () => {
  const dir = credentials();
  // A store kept before signing, and a record filed under pull request 0, whole as a record.
  const dbPath = await ticks([at(A)], {});
  const db = open(dbPath);
  saveDecision(db, { at: 1, seq: 1000, pr: 0, head: B, ...recordOf(REPO, 0, B) });
  db.close();
  const r = await closedTick(dbPath, host(dir));
  assert.deepEqual(anchorOf(dir), { anchor: null, why: null }, "the host's anchor isn't bound to it, and still reads");
  assert.match(r.log, /this store holds a record filed under 0, which is no pull request's number, so it isn't taken as o\/r's own/);
});

test("a record filed under no pull request's number is never ordered or noted, so the host's anchor goes on reading", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], host(dir));
  let db = open(dbPath);
  saveDecision(db, { at: 1, seq: 1000, pr: 0, head: B, ...recordOf(REPO, 0, B) });
  db.close();
  const r = await closedTick(dbPath, host(dir));
  db = open(dbPath);
  const unfiled = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'decision.latest' AND subject NOT GLOB 'pr:[1-9]*'").get().n;
  db.close();
  assert.equal(unfiled, 0, "no entry filed where no order finds it");
  assert.equal(anchorOf(dir).why, null, "and the host's anchor still reads");
  assert.match(r.log, /this store holds a record filed under 0, which is no pull request's number, so no signed order names it/);
});

test("the host's anchor notes only a pull request's number and an entry's, so it never holds what it can't read back", () => {
  const dir = credentials();
  const anchor = fileAnchor(dir);
  assert.equal(anchor.note(REPO, 7, 1), true, "control: a pull request's entry is noted");
  for (const [pr, n] of [[0, 1], [-3, 1], [1.5, 1], [7, 0]]) assert.equal(anchor.note(REPO, pr, n), false, `#${pr}, entry ${n}`);
  assert.deepEqual(anchorOf(dir), { anchor: anchorAs({ began: true, latest: new Map([[7, 1]]), store: null }), why: null }, "and the anchor reads as it was");
});

test("two restores of a store that's gone run one at a time", () => {
  const dir = tempDir("reeve-order-restore-twice-");
  const dbPath = join(dir, "s.db"), snap = join(dir, "snap.db");
  open(dbPath).close();
  copyFileSync(dbPath, snap);
  for (const s of ["", "-wal", "-shm"]) rmSync(dbPath + s, { force: true });
  let second = null;
  const first = restore(snap, dbPath, { isDaemonRunning: () => null,
                                        copy: (from, to) => { second = restore(snap, dbPath, { isDaemonRunning: () => null }); copyFileSync(from, to); } });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second?.ok, false, `the second waits its turn: ${JSON.stringify(second)}`);
  assert.match(String(second?.why), /another reeve is running on .*s\.db, or restoring it/);
});

test("a restore lets go what one killed partway left that couldn't be put back, once its own copy is in place", () => {
  const dir = tempDir("reeve-order-restore-superseded-");
  const dbPath = join(dir, "s.db"), snap = join(dir, "snap.db");
  open(dbPath).close();
  copyFileSync(dbPath, snap);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  // One killed after moving the store's log aside; a reeve has since given the store a log of its own.
  writeFileSync(`${dbPath}.${gone}.deadbeef.restoring`, "partway");
  writeFileSync(`${dbPath}.${gone}.deadbeef.restoring-wal`, "old log");
  writeFileSync(`${dbPath}-wal`, "new log");
  const r = restore(snap, dbPath, { overwrite: true, isDaemonRunning: () => null });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".restoring")), [], "nothing of the killed one is left");
});

// ── from #278's nineteenth review ────────────────────────────────────────────

test("a restore syncs its copy's name into the store's folder before it moves the store's log aside", () => {
  const dir = tempDir("reeve-order-restore-order-");
  const dbPath = join(dir, "s.db"), snap = join(dir, "snap.db");
  open(dbPath).close();
  copyFileSync(dbPath, snap);
  writeFileSync(`${dbPath}-wal`, "committed");
  const real = realpathSync(dbPath);
  const steps = [];
  const r = restore(snap, dbPath, { overwrite: true, isDaemonRunning: () => null,
    copy: (from, to) => { copyFileSync(from, to); steps.push("copied"); },
    syncDir: () => { steps.push("synced"); },
    rename: (from, to) => { steps.push(to.endsWith(".restoring-wal") ? "log aside" : to === real ? "placed" : `renamed to ${basename(to)}`); renameSync(from, to); } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(steps, ["copied", "synced", "log aside", "placed", "synced"]);
});

test("a restore through a link to the store restores the store, and leaves the link", () => {
  const dir = tempDir("reeve-order-restore-link-");
  const real = join(dir, "real.db"), link = join(dir, "link.db"), snap = join(dir, "snap.db");
  open(real).close();
  // The snapshot holds an event the store doesn't.
  const s = open(snap);
  s.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(1, "test", "restored.marker", "store", "{}");
  s.close();
  symlinkSync(real, link);
  const r = restore(snap, link, { overwrite: true, isDaemonRunning: () => null });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
  const db = open(real);
  const marked = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'restored.marker'").get().n;
  db.close();
  assert.equal(marked, 1, "and the store it leads to is the snapshot");
});

test("a restore through a link to nothing is refused, as which store it names can't be told", () => {
  const dir = tempDir("reeve-order-restore-dangling-");
  const snap = join(dir, "snap.db"), dangling = join(dir, "gone.db");
  open(snap).close();
  symlinkSync(join(dir, "nowhere.db"), dangling);
  let r;
  try { r = restore(snap, dangling, { isDaemonRunning: () => null }); } catch (e) { r = { ok: false, why: `threw: ${e.message}` }; }
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.why), /is a link to nothing/);
  assert.ok(lstatSync(dangling).isSymbolicLink(), "and the link is left as it was");
});

test("a store isn't restored from itself, by its own name or another", () => {
  const dir = tempDir("reeve-order-restore-self-");
  const dbPath = join(dir, "s.db");
  open(dbPath).close();
  // What it committed, in its log alone.
  writeFileSync(`${dbPath}-wal`, "committed");
  const refused = (from) => {
    const r = restore(from, dbPath, { overwrite: true, isDaemonRunning: () => null });
    assert.equal(r.ok, false, `${basename(from)}: ${JSON.stringify(r)}`);
    assert.match(String(r.why), /is the store itself/);
  };
  refused(dbPath);
  symlinkSync(dbPath, join(dir, "link.db"));
  refused(join(dir, "link.db"));
  // And by another name for its file, a hard link, which its lock would refuse too.
  linkSync(dbPath, join(dir, "also.db"));
  refused(join(dir, "also.db"));
  assert.equal(readFileSync(`${dbPath}-wal`, "utf8"), "committed", "and its log is where it was");
});

// ── from #278's twentieth review ─────────────────────────────────────────────

test("a store holding a record filed under a number that isn't whole doesn't bind the host's anchor, which still reads", async () => {
  const dir = credentials();
  const dbPath = await ticks([at(A)], {});
  const db = open(dbPath);
  // Its table rebuilt without its types held, as a store edit could, and a record filed under 1.5 in it, whole as a record.
  db.exec("CREATE TABLE decision_loose AS SELECT * FROM decision; DROP TABLE decision; ALTER TABLE decision_loose RENAME TO decision;");
  const k = recordOf(REPO, 1.5, B);
  db.prepare("INSERT INTO decision(digest, pr, head, record, first_at, last_at, first_seq, last_seq, envelope, unsigned) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(k.decision.digest, 1.5, B, canonical(k.decision.record), 1, 1, 1000, 1000, null, "kept before signing");
  db.close();
  const r = await closedTick(dbPath, host(dir));
  assert.deepEqual(anchorOf(dir), { anchor: null, why: null }, "the host's anchor isn't bound to it, and still reads");
  assert.match(r.log, /this store holds a record filed under 1\.5, which is no pull request's number/);
});

/** A reeve home with a profile for o/r, halted, and a store in it: `reeve tick` there reaches nothing. */
function haltedHome(prefix) {
  const home = tempDir(prefix);
  mkdirSync(join(home, "profiles", "o"), { recursive: true });
  writeFileSync(join(home, "profiles", "o", "r.json"), JSON.stringify(withDefaults({ schemaVersion: 1, project: { kind: "product" },
    identity: { key: REPO, defaultBranch: "main", visibility: "public" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
    state: { mode: "in-repo" }, units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] })));
  writeFileSync(join(home, "HALT"), "");
  const dbPath = join(home, "s.db");
  open(dbPath).close();
  return { home, dbPath };
}
const tickOn = ({ home, dbPath }) => spawnSync(process.execPath, [REEVE, "tick", REPO, "--db", dbPath], { cwd: home, encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: home } });

test("reeve tick puts back the store's log a restore killed partway had moved aside, before it opens the store", () => {
  const h = haltedHome("reeve-order-settle-");
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(`${h.dbPath}.${gone}.deadbeef.restoring`, "partway");
  writeFileSync(`${h.dbPath}.${gone}.deadbeef.restoring-wal`, "");
  const r = tickOn(h);
  assert.deepEqual(readdirSync(h.home).filter((n) => n.includes(".restoring")), [], `put right: ${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stderr, /couldn't be put back/);
});

test("reeve tick doesn't run on a store whose log a restore killed partway moved aside, where it can't be put back", () => {
  const h = haltedHome("reeve-order-settle-taken-");
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(`${h.dbPath}.${gone}.cafebabe.restoring`, "partway");
  writeFileSync(`${h.dbPath}.${gone}.cafebabe.restoring-wal`, "committed");
  // Its name taken since.
  writeFileSync(`${h.dbPath}-wal`, "");
  const r = tickOn(h);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /a restore killed partway left what the store at .*s\.db held in its log aside/);
  assert.equal(readFileSync(`${h.dbPath}.${gone}.cafebabe.restoring-wal`, "utf8"), "committed", "and what it moved aside is kept");
});
