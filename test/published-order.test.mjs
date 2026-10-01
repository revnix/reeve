// What the merge policy publishes of its decision records (#274): each result
// on a pull request's head names the record kept for its verdict and where the
// pull request's signed order stood, so a copy of the store is checked away from
// the host, against what GitHub keeps, with no anchor to check it against.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileSigner, knownKeys, PUBLIC_FILE, latestStatement } from "../src/signing.mjs";
import { fileAnchor, anchorPath } from "../src/anchor.mjs";
import { open } from "../src/db/ops.mjs";
import * as decisions from "../src/decisions.mjs";
import { storeIdentity } from "../src/db/records.mjs";

// Read off the module, so a test of a name it doesn't export fails, rather than every test.
const { explainDecision, replayDecisions, publishedChecked } = decisions;
import { evidenceText, readEvidence, readPublished } from "../src/published.mjs";
import { publishVerdict } from "../src/pr.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";
import { run, EVAL } from "./fixtures/tick-harness.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
const REPO = "o/r", PR = 42;
const A = "a".repeat(40), B = "b".repeat(40);
const X = "c".repeat(64), Y = "d".repeat(64);

/** A credentials folder, made as reeve's home makes it. */
const credentials = () => { const d = join(tempDir("reeve-pub-"), "credentials"); mkdirSync(d, { mode: 0o700 }); return d; };
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
/** #42 at `head`, with its CI `ci` ("GREEN" passes it, "RED" blocks it). */
const at = (head, ci = "GREEN") => ({ ...EVAL, head, input: input(head, ci), verdict: computeVerdict(input(head, ci)) });
/** What the host's reeve is given: its signer, its keys and its anchor, over the credentials folder `dir`. */
const host = (dir) => ({ signer: fileSigner(dir), keys: () => knownKeys({ local: dir }), anchor: fileAnchor(dir) });

/**
 * Ticks over one store, each with its own evaluation of #42. Answers the store's
 * path, and what each publication was given, in order.
 */
async function ticks(evals, ctx) {
  const path = join(tempDir("reeve-pub-ticks-"), "s.db");
  open(path).close();
  /** @type {any[]} */ const published = [];
  let tick = 0;
  await run({ openPrs: () => { tick++; return [PR]; }, evaluate: () => evals[Math.min(tick, evals.length) - 1], dbPath: path, ticks: evals.length,
              publish: async (args) => { published.push(args); return { ok: true, id: 1, conclusion: "neutral" }; }, ...ctx });
  return { path, published };
}

/** Ticks over one store judging #42 and #7 alike, each tick with its evaluation. Answers as `ticks` does. */
async function ticksOfTwo(evals, ctx) {
  const path = join(tempDir("reeve-pub-two-"), "s.db");
  open(path).close();
  /** @type {any[]} */ const published = [];
  let tick = 0;
  await run({ openPrs: () => { tick++; return [PR, 7]; }, evaluate: ({ pr }) => ({ ...evals[Math.min(tick, evals.length) - 1], pr }),
              dbPath: path, ticks: evals.length,
              publish: async (args) => { published.push(args); return { ok: true, id: 1, conclusion: "neutral" }; }, ...ctx });
  return { path, published };
}

/**
 * GitHub as a copy's check reads it, from what the daemon published: the last
 * result at each head, as a check run updated in place keeps it, with the
 * pull request's head now the last one published.
 * @param {any[]} published
 */
const githubOf = (published) => (/** @type {number} */ pr, /** @type {string[]} */ heads) => {
  /** @type {Map<string, any>} */ const last = new Map();
  for (const p of published) if (p.evidence?.pr === pr) last.set(p.verdict.head, p.evidence);
  const now = published.at(-1)?.verdict.head;
  return { evidence: [...new Set([now, ...heads])].filter((h) => last.has(h)).map((head) => ({ ...last.get(head), head })) };
};
/** The keys a person away from the host checks with: the host's public half alone, as published. */
const publishedKeys = (dir) => {
  const away = tempDir("reeve-pub-away-");
  copyFileSync(join(dir, PUBLIC_FILE), join(away, "host.pub"));
  return knownKeys({ published: away });
};
/** The digests of #42's records, oldest first. */
const digestsOf = (db) => db.prepare("SELECT digest FROM decision WHERE pr = ? ORDER BY first_seq").all(PR).map((r) => r.digest);

// ── the evidence as a result's text carries it ──────────────────────────────

/** A commitment to the store's orders up to event `to`, a digest of `c`s. */
const st = (/** @type {number} */ to, c = "e") => ({ to, orders: c.repeat(64) });
/** Evidence of #42, with a commitment to the store's orders. */
const ev = (record, order = null, store = st(1)) => ({ pr: PR, record, order, store });

test("the evidence reads back as it was written, with an entry of the order or none yet", () => {
  for (const e of [ev(X, { n: 3, names: Y }, st(42, "f")), ev(X), ev(X, null, st(0))]) {
    const text = `PASS: all clear\n\nclauses...\n${evidenceText(e)}`;
    assert.deepEqual(readEvidence(text), e);
  }
  assert.equal(readEvidence("PASS: all clear"), null, "and a result with no evidence has none");
});

test("evidence that doesn't read whole is garbled, not taken", () => {
  const whole = evidenceText(ev(X, { n: 3, names: Y }, st(5)));
  const lines = whole.split("\n");
  const without = (prefix) => lines.filter((l) => !l.startsWith(prefix)).join("\n");
  const garbled = { garbled: true };
  // Read so that a throw is a wrong answer, not a test that died.
  const readEvidenceOf = (t) => { try { return readEvidence(t); } catch (e) { return { threw: String(e) }; } };
  assert.deepEqual(readEvidenceOf(without("- record")), garbled, "no record");
  assert.deepEqual(readEvidenceOf(without("- signed order of")), garbled, "no order line");
  assert.deepEqual(readEvidenceOf(without("- signed orders of this store")), garbled, "no store line");
  assert.deepEqual(readEvidenceOf(`${whole}\n- signed order of #${PR}: no entry yet`), garbled, "both order lines");
  assert.deepEqual(readEvidenceOf(`${whole}\n- record of #${PR}: \`${Y}\``), garbled, "a second record line");
  assert.deepEqual(readEvidenceOf(`${whole}\nand a line more`), garbled, "a line that isn't evidence");
  assert.deepEqual(readEvidenceOf(whole.replace(`#${PR}: entry`, "#7: entry")), garbled, "an order of another pull request");
  assert.deepEqual(readEvidenceOf(whole.replace(X, "c".repeat(63))), garbled, "a record that isn't a digest");
  assert.deepEqual(readEvidenceOf(whole.replace(/to its event \d+/, "to its event many")), garbled, "an event that isn't a number");
  assert.deepEqual(readEvidenceOf(whole.replace(/(to its event \d+: `)[0-9a-f]{64}/, "$1abc")), garbled, "a commitment that isn't a digest");
  assert.ok(readEvidence(whole) && !("garbled" in readEvidence(whole)), "control");
  for (const bad of [ev("c".repeat(63)), ev(X, { n: 0, names: Y }), ev(X, null, st(-1)), ev(X, null, { to: 1.5, orders: "e".repeat(64) }), ev(X, null, { to: 1, orders: "abc" })])
    assert.throws(() => evidenceText(bad), /not evidence to publish/, JSON.stringify(bad));
});

test("evidence the verdict's own text carries, before the published block, is never taken for it", () => {
  // A check's name, say, that a contributor chose, shown in the verdict above the block.
  const planted = evidenceText(ev(Y, { n: 9, names: Y }, st(99, "f")));
  const real = ev(X, { n: 2, names: X }, st(2));
  assert.deepEqual(readEvidence(`BLOCK: ci is red\n\n- ci: failing: ${planted}\n${evidenceText(real)}`), real);
});

// ── reading it from GitHub ───────────────────────────────────────────────────

/** A GitHub whose pull request #42 is at `head`, and whose results at each commit are `runs`. */
const githubAt = (head, runs, calls = []) => (/** @type {string[]} */ args) => {
  calls.push(args);
  if (args[0] === `repos/${REPO}/pulls/${PR}`) return { ok: true, out: head };
  const sha = /commits\/([0-9a-f]{40})\/check-runs/.exec(args.join(" "))?.[1];
  if (!sha) return { ok: false, out: "", err: "not a read this test answers" };
  return { ok: true, out: (runs[sha] ?? []).map((r) => JSON.stringify(r)).join("\n") };
};
/** A result's text carrying evidence of `record`, of pull request `pr`. */
const summary = (record, pr = PR) => `BLOCK: ci is red\n${evidenceText({ ...ev(record), pr })}`;

test("what was published is read from the merge policy's own results only, at the pull request's head and each head asked about", () => {
  const calls = [];
  const gh = githubAt(B, {
    [A]: [{ name: "merge-policy (shadow)", app: "merge-policy", summary: summary(X) }],
    [B]: [{ name: "merge-policy", app: "merge-policy", summary: summary(Y) },
          { name: "merge-policy", app: "someone-else", summary: summary("e".repeat(64)) },
          { name: "tests", app: "merge-policy", summary: summary("f".repeat(64)) },
          // Another pull request's, at a commit both are at: that one's to check.
          { name: "merge-policy (shadow)", app: "merge-policy", summary: summary("a".repeat(64), 7) }],
  }, calls);
  const got = readPublished(REPO, PR, [A], { gh });
  assert.ok("evidence" in got, JSON.stringify(got));
  assert.deepEqual(got.evidence.map((e) => [e.head, e.record]).sort(), [[A, X], [B, Y]]);
  assert.ok(calls.every((c) => !c.join(" ").includes("someone")), "control: nothing else was asked");
});

test("a read of GitHub that fails, or evidence of the merge policy's own that doesn't read whole, vouches for nothing", () => {
  assert.match(JSON.stringify(readPublished(REPO, PR, [A], { gh: () => ({ ok: false, out: "", err: "HTTP 502" }) })), /#42 couldn't be read from GitHub: HTTP 502/);
  const runsFail = (args) => (args[0] === `repos/${REPO}/pulls/${PR}` ? { ok: true, out: B } : { ok: false, out: "", err: "HTTP 502" });
  assert.match(JSON.stringify(readPublished(REPO, PR, [A], { gh: runsFail })), /results at bbbbbbbb couldn't be read from GitHub: HTTP 502/);
  const notJson = (args) => (args[0] === `repos/${REPO}/pulls/${PR}` ? { ok: true, out: B } : { ok: true, out: "{not json" });
  assert.match(JSON.stringify(readPublished(REPO, PR, [A], { gh: notJson })), /results at bbbbbbbb don't read as GitHub's/);
  const garbled = githubAt(B, { [B]: [{ name: "merge-policy", app: "merge-policy", summary: `${summary(X)}\n- record of #${PR}: \`${Y}\`` }] });
  assert.match(JSON.stringify(readPublished(REPO, PR, [], { gh: garbled })), /the merge policy's result at bbbbbbbb carries evidence that doesn't read whole/);
});

// ── publishing it ────────────────────────────────────────────────────────────

test("a published result carries its evidence after the verdict, however long the verdict, shadow or not", async () => {
  const long = { head: A, state: "BLOCK", summary: "ci is red", clauses: [{ id: "ci", state: "BLOCK", detail: "x".repeat(70000) }] };
  const evidence = ev(X, { n: 2, names: Y }, st(7));
  for (const shadow of [true, false]) {
    const calls = [];
    const api = (_token, args) => { calls.push(args); return args.includes("POST") || args.includes("PATCH") ? { ok: true, out: JSON.stringify({ id: 9 }) } : { ok: true, out: "" }; };
    await publishVerdict({ nwo: REPO, verdict: long, shadow, evidence, auth: async () => ({ ok: true, token: "t" }), api });
    const write = calls.find((a) => a.includes("POST")) ?? [];
    const summary = String(write.find((x) => typeof x === "string" && x.startsWith("output[summary]=")) ?? "").slice("output[summary]=".length);
    assert.ok(summary.length <= 60000, `within GitHub's bound: ${summary.length}`);
    assert.ok(summary.endsWith(evidenceText(evidence)), `shadow ${shadow}: ${summary.slice(-300)}`);
    assert.deepEqual(readEvidence(summary, PR), evidence);
  }
});

/**
 * What publishing `evidence` writes at a head whose result already carries
 * `prior`'s evidence (none where null), and whether it says the store is behind.
 */
async function publishOver(prior, evidence, { entryAt = null, commitAt = null, holds = null, shadow = true, name = "merge-policy (shadow)", conclusion = "neutral", also = [] } = {}) {
  const calls = [];
  const run0 = [...(prior ? [{ name, id: 5, conclusion, evidence: prior }] : []), ...also]
    .map((r, i) => JSON.stringify({ name: r.name, id: r.id ?? 6 + i, conclusion: r.conclusion, app: "merge-policy", summary: `BLOCK: ci\n${evidenceText(r.evidence)}` })).join("\n");
  const api = (_token, args) => {
    calls.push(args);
    if (args.includes("PATCH") || args.includes("POST")) return { ok: true, out: JSON.stringify({ id: 5 }) };
    if (args.join(" ").includes("/check-runs?")) return { ok: true, out: run0 };
    return { ok: true, out: "" };
  };
  const r = await publishVerdict({ nwo: REPO, verdict: { head: A, state: "BLOCK", summary: "ci", clauses: [] }, shadow, evidence, entryAt, commitAt,
                                   ...(holds ? { holds } : {}), auth: async () => ({ ok: true, token: "t" }), api });
  const summaryOf = (a) => String(a.find((x) => typeof x === "string" && x.startsWith("output[summary]=")) ?? "").slice("output[summary]=".length);
  // The result written: a new one, or the one at this head updated. A superseded result is written apart.
  const write = calls.find((a) => a.includes("POST") || (a.includes("PATCH") && !a.includes("conclusion=cancelled"))) ?? [];
  const superseded = calls.find((a) => a.includes("conclusion=cancelled"));
  return { written: readEvidence(summaryOf(write)), behind: r.behind ?? null, ...(superseded ? { superseded: readEvidence(summaryOf(superseded)) } : {}) };
}

test("published evidence only moves forward: evidence behind what a head carries never replaces it, and says the store is behind", async () => {
  const newer = ev(X, { n: 3, names: X }, st(9));
  for (const [older, why] of [
    [ev(Y, { n: 2, names: Y }, st(9)), /the store's signed order of #42 ends at entry 2, where entry 3 was published/],
    [ev(X, { n: 3, names: X }, st(8)), /its signed orders go to its event 8, where orders to event 9 were published/],
    [ev(X, { n: 3, names: X }, st(9, "f")), /its signed orders to event 9 aren't those published/],
  ]) {
    const r = await publishOver(newer, older);
    assert.deepEqual(r.written, newer, `what was published stays: ${JSON.stringify(older)}`);
    assert.match(String(r.behind), why);
    assert.match(String(r.behind), /^at aaaaaaaa, /);
  }
  const ahead = ev(Y, { n: 4, names: Y }, st(10, "f"));
  assert.deepEqual(await publishOver(newer, ahead), { written: ahead, behind: null }, "control: evidence ahead of it is written");
  // Gone further, from orders to the published event other than those published: a store that forked, then went on.
  const forked = await publishOver(newer, ahead, { commitAt: (to) => (to === 9 ? "0".repeat(64) : null) });
  assert.deepEqual(forked.written, newer, "a store whose orders to the published event aren't those published doesn't write over it");
  assert.match(String(forked.behind), /its signed orders to event 9 aren't those published/);
  assert.deepEqual(await publishOver(newer, ahead, { commitAt: (to) => (to === 9 ? "e".repeat(64) : null) }), { written: ahead, behind: null },
                   "control: one whose orders to it are those published goes forward");
});

test("a fork signed under an entry number already published is behind, not forward, whether or not it has gone further", async () => {
  const published = ev(X, { n: 3, names: X }, st(9));
  const fork = await publishOver(published, ev(Y, { n: 3, names: Y }, st(9)));
  assert.deepEqual(fork.written, published, "the fork at the same number doesn't replace it");
  assert.match(String(fork.behind), /the store's entry 3 of #42's signed order names d{12}, where c{12} was published/);
  const further = ev(Y, { n: 5, names: Y }, st(11, "f"));
  const on = await publishOver(published, further, { entryAt: (n) => (n === 3 ? Y : undefined) });
  assert.deepEqual(on.written, published, "nor does one gone further, where the store's entry 3 names another record");
  assert.match(String(on.behind), /the store's entry 3 of #42's signed order names d{12}, where c{12} was published/);
  assert.deepEqual(await publishOver(published, further, { entryAt: (n) => (n === 3 ? X : undefined) }), { written: further, behind: null },
                   "control: one gone further from the same entry is written");
});

test("switching from enforcing to shadow keeps the evidence the enforcing result carried, and holds a store behind it", async () => {
  const enforced = ev(X, { n: 3, names: X }, st(9));
  const r = await publishOver(enforced, ev(Y, { n: 2, names: Y }, st(8)), { name: "merge-policy", conclusion: "success" });
  assert.deepEqual(r.superseded, enforced, "the superseded result keeps its evidence");
  assert.deepEqual(r.written, enforced, "and the shadow result carries it, not the store's older evidence");
  assert.match(String(r.behind), /ends at entry 2, where entry 3 was published/);
  // With both names carrying evidence, the one furthest on is what the store is held to.
  const both = await publishOver(ev(Y, { n: 2, names: Y }, st(8)), ev(Y, { n: 2, names: Y }, st(8)),
                                 { also: [{ name: "merge-policy", conclusion: "success", evidence: enforced }] });
  assert.deepEqual(both.written, enforced);
  assert.match(String(both.behind), /ends at entry 2, where entry 3 was published/);
});

test("a result published with no evidence keeps what the head carries, rather than erasing it", async () => {
  const newer = ev(X, { n: 3, names: X }, st(9));
  assert.deepEqual(await publishOver(newer, null), { written: newer, behind: null });
  assert.deepEqual(await publishOver(null, null), { written: null, behind: null }, "control: and a head with none gets none");
});

test("another pull request's evidence, at a commit both are at, is written over, as that one's to keep", async () => {
  const theirs = { ...ev(Y, { n: 9, names: Y }, st(99, "f")), pr: 7 };
  const ours = ev(X, { n: 1, names: X }, st(1));
  assert.deepEqual(await publishOver(theirs, ours), { written: ours, behind: null });
});

test("the daemon raises a store behind what the merge policy published of it", async () => {
  const dir = credentials();
  const path = join(tempDir("reeve-pub-behind-"), "s.db");
  open(path).close();
  const r = await run({ openPrs: () => [PR], evaluate: () => at(A), dbPath: path, ticks: 1, ...host(dir),
                        publish: async () => ({ ok: true, id: 1, conclusion: "neutral", behind: "at aaaaaaaa, its signed orders go to its event 1, where orders to event 9 were published, so what was published there is kept" }) });
  assert.match(r.esc, /#42: the store is behind what the merge policy published at aaaaaaaa, its signed orders go to its event 1, where orders to event 9 were published/);
  assert.match(r.log, /#42: the store is behind what was published at aaaaaaaa/);
});

test("a merge queue's result carries its pull request's evidence, where the queue's commit is that one pull request's", async () => {
  const Q = "c".repeat(40), BASE = "d".repeat(40);
  const judgedAt = ({ entry, input }) => { const i = { ...input, head: entry.sha }; return { ok: true, input: i, verdict: computeVerdict(i) }; };
  const one = [];
  const path = join(tempDir("reeve-pub-queue-"), "s.db");
  open(path).close();
  await run({ openPrs: () => [PR], evaluate: () => at(A), dbPath: path, ticks: 2, ...host(credentials()),
              readQueue: () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: Q, baseSha: BASE, state: "AWAITING_CHECKS" }] }), evaluateQueue: judgedAt,
              publish: async (args) => { one.push(args); return { ok: true, id: 1, conclusion: "neutral" }; } });
  const db = open(path);
  const queuedRecord = db.prepare("SELECT digest FROM decision WHERE pr = ? AND head = ?").get(PR, Q)?.digest;
  db.close();
  const atQueue = one.filter((p) => p.queue);
  assert.ok(queuedRecord && atQueue.length === 2, `control: the queue's commit was judged and published: ${atQueue.length}`);
  assert.deepEqual(atQueue.map((p) => p.evidence?.record ?? null), [queuedRecord, queuedRecord]);
  assert.equal(atQueue[1].evidence?.pr, PR);
  assert.equal(atQueue[1].entryAt?.(1), queuedRecord, "with what the store's order names at an entry");

  const both = [];
  const two = join(tempDir("reeve-pub-queue-"), "s.db");
  open(two).close();
  await run({ openPrs: () => [PR, 7], evaluate: ({ pr }) => ({ ...at(A), pr }), dbPath: two, ticks: 1, ...host(credentials()),
              readQueue: () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: Q, baseSha: BASE, state: "AWAITING_CHECKS" }, { pr: 7, sha: Q, baseSha: BASE, state: "AWAITING_CHECKS" }] }),
              evaluateQueue: judgedAt, publish: async (args) => { both.push(args); return { ok: true, id: 1, conclusion: "neutral" }; } });
  const batched = both.filter((p) => p.queue);
  assert.equal(batched.length, 1, "control: the commit of two was published once");
  assert.equal(batched[0].evidence ?? null, null, "a commit of two carries no one pull request's evidence");

  const refused = [];
  const refusing = join(tempDir("reeve-pub-queue-"), "s.db");
  open(refusing).close();
  const r0 = open(refusing);
  r0.exec("CREATE TRIGGER refuse BEFORE INSERT ON decision BEGIN SELECT RAISE(ABORT, 'refused'); END;");
  r0.close();
  await run({ openPrs: () => [PR], evaluate: () => at(A), dbPath: refusing, ticks: 1, ...host(credentials()),
              readQueue: () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: Q, baseSha: BASE, state: "AWAITING_CHECKS" }] }), evaluateQueue: judgedAt,
              publish: async (args) => { refused.push(args); return { ok: true, id: 1, conclusion: "neutral" }; } });
  assert.deepEqual(refused.filter((p) => p.queue).map((p) => p.evidence ?? null), [null], "a queue's record the store refused isn't published as kept");
});

test("each result the daemon publishes names the record it kept, and where the pull request's signed order stood", async () => {
  const dir = credentials();
  const { path, published } = await ticks([at(A), at(A), at(A, "RED")], host(dir));
  const db = open(path);
  const [green, red] = digestsOf(db);
  const keys = knownKeys({ local: dir }), id = storeIdentity(db);
  const [one, two] = db.prepare("SELECT seq FROM event WHERE op = 'decision.latest' ORDER BY seq").all().map((r) => r.seq);
  const upTo = (/** @type {number} */ to) => ({ to, orders: /** @type {any} */ (decisions).ordersCommitment?.(db, REPO, keys, id, to)?.orders });
  const expected = [
    { pr: PR, record: green, order: null, store: upTo(0) },
    // Published again once the tick's orders are extended, to the entry naming it.
    { pr: PR, record: green, order: { n: 1, names: green }, store: upTo(one) },
    { pr: PR, record: green, order: { n: 1, names: green }, store: upTo(one) },
    // The order is extended at the tick's end, so it lags the record until then.
    { pr: PR, record: red, order: { n: 1, names: green }, store: upTo(one) },
    { pr: PR, record: red, order: { n: 2, names: red }, store: upTo(two) },
  ];
  db.close();
  assert.deepEqual(published.map((p) => p.evidence), expected);
  assert.equal(published[3].entryAt?.(1), green, "and says what the store's order names at an entry, so a fork is told from progress");
});

/** What one tick over the store at `path` publishes of #42 at A, red, with `ctx`. */
async function publishedOnce(path, ctx, evaluation = at(A, "RED")) {
  /** @type {any[]} */ const got = [];
  // Another pull request the store holds isn't open this tick, and is read as still open, not from GitHub.
  await run({ openPrs: () => [PR], evaluate: () => evaluation, dbPath: path, ticks: 1, prState: () => "OPEN", prIsFinished: () => false, ...ctx,
              publish: async (args) => { got.push(args); return { ok: true, id: 1, conclusion: "neutral" }; } });
  return got.map((p) => p.evidence ?? null);
}

test("no evidence is published where no order can be told", async () => {
  const fresh = () => { const p = join(tempDir("reeve-pub-one-"), "s.db"); open(p).close(); return p; };
  const dir = credentials();
  const { keys, anchor } = host(dir);
  assert.deepEqual(await publishedOnce(fresh(), { keys, anchor }), [null], "a reeve that signs no orders");
  assert.deepEqual(await publishedOnce(fresh(), { ...host(credentials()), keys: () => null }), [null], "no keys to check an order with");

  const unread = credentials();
  const first = await ticks([at(A)], host(unread));
  writeFileSync(anchorPath(unread, REPO), "{");
  assert.deepEqual(await publishedOnce(first.path, host(unread)), [null], "a host's anchor that can't be read");
  // Read to pin the verdict's record, and unreadable after: the record is kept, and where its order stands can't be told.
  const late = credentials();
  const held = await ticks([at(A)], host(late));
  const real = fileAnchor(late);
  let pinned = false;
  const flaky = { ...real, pin: (/** @type {any[]} */ ...args) => { const r = real.pin(...args); pinned = true; return r; },
                  read: (/** @type {any[]} */ ...args) => { if (pinned) throw new Error("the host's anchor can't be read"); return real.read(...args); } };
  assert.deepEqual(await publishedOnce(held.path, { ...host(late), anchor: flaky }), [null], "a host's anchor that can't be read once the verdict's record is pinned");
  assert.ok(pinned, "control: the record was pinned");

  const other = credentials();
  fileAnchor(other).bind(REPO, "f".repeat(32));
  assert.deepEqual(await publishedOnce(fresh(), host(other)), [null], "a host's anchor another store is bound to");

  const edited = credentials();
  const { path } = await ticks([at(A), at(A, "RED")], host(edited));
  const db = open(path);
  db.prepare("UPDATE event SET payload = json_set(payload, '$.seq', 99999) WHERE op = 'decision.latest'").run();
  db.close();
  assert.deepEqual(await publishedOnce(path, host(edited)), [null], "an order that doesn't hold");

  const two = credentials();
  const both = await ticksOfTwo([at(A), at(A, "RED")], host(two));
  const theirs = open(both.path);
  theirs.prepare("UPDATE event SET payload = json_set(payload, '$.seq', 99999) WHERE op = 'decision.latest' AND subject = 'pr:7'").run();
  theirs.close();
  assert.deepEqual(await publishedOnce(both.path, host(two)), [null], "another pull request's order that doesn't hold, as the store's counts would vouch for less than it should hold");

  const cutDir = credentials();
  const second = await ticks([at(A), at(A, "RED"), at(A, "RED")], host(cutDir));
  const cut = open(second.path);
  cut.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  cut.close();
  assert.deepEqual(await publishedOnce(second.path, host(cutDir)), [null], "an order cut short of the host's anchor");
  assert.ok(second.published.at(-1).evidence, "control: published before it was cut");
  assert.ok((await publishedOnce(fresh(), host(credentials())))[0], "control: a host that signs, on a store of its own");
});

test("only a record the store kept is published as the record of a verdict", async () => {
  const fresh = () => { const p = join(tempDir("reeve-pub-kept-"), "s.db"); open(p).close(); return p; };
  const { input: _none, ...unjudged } = at(A, "RED");
  assert.deepEqual(await publishedOnce(fresh(), host(credentials()), unjudged), [null], "no record made, as nothing said what it was judged from");
  const refusing = fresh();
  const db = open(refusing);
  db.exec("CREATE TRIGGER refuse BEFORE INSERT ON decision BEGIN SELECT RAISE(ABORT, 'refused'); END;");
  db.close();
  assert.deepEqual(await publishedOnce(refusing, host(credentials())), [null], "a record the store refused");
  assert.ok((await publishedOnce(fresh(), host(credentials())))[0]?.record, "control: a record the store kept is published");
});

// ── checking a copy against it, away from the host ──────────────────────────

/** A store judged at A then at B, twice, by a host with keys in `dir`, and what it published. */
async function history() {
  const dir = credentials();
  const { path, published } = await ticks([at(A), at(B, "RED"), at(B, "RED")], host(dir));
  return { dir, path, published, keys: publishedKeys(dir) };
}

test("a copy that holds what the merge policy published checks against it, with no anchor", async () => {
  const h = await history();
  const db = open(h.path);
  const checked = publishedChecked(db, {}, { keys: h.keys, repo: REPO, anchor: null, published: githubOf(h.published) });
  db.close();
  assert.deepEqual(checked.faults, []);
  assert.equal(checked.results, 2, "the results at both heads");
});

test("a copy whose newest records were taken away is caught by what was published, where no anchor is there to catch it", async () => {
  const h = await history();
  const db = open(h.path);
  const [, red] = digestsOf(db);
  db.prepare("DELETE FROM decision WHERE digest = ?").run(red);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  const replayed = replayDecisions(db, {}, { keys: h.keys, repo: REPO, anchor: null });
  const checked = publishedChecked(db, {}, { keys: h.keys, repo: REPO, anchor: null, published: githubOf(h.published) });
  db.close();
  assert.ok(replayed.every((r) => r.outcome === "same"), `control: the copy alone replays whole: ${JSON.stringify(replayed)}`);
  const why = checked.faults.map((f) => f.why).join("\n");
  assert.match(why, new RegExp(`published this record for it at ${B.slice(0, 8)}, but this copy doesn't hold it`));
  assert.match(why, new RegExp(`published entry 2 of its signed order at ${B.slice(0, 8)}, but this copy's ends at entry 1`));
});

test("a pull request whose every record was taken away from a copy is still checked, by its order", async () => {
  const h = await history();
  const db = open(h.path);
  db.prepare("DELETE FROM decision WHERE pr = ?").run(PR);
  const checked = publishedChecked(db, {}, { keys: h.keys, repo: REPO, anchor: null, published: githubOf(h.published) });
  db.close();
  assert.match(checked.faults.map((f) => f.why).join("\n"), new RegExp(`published this record for it at ${B.slice(0, 8)}, but this copy doesn't hold it`));
});

test("a copy whose signed orders were all taken away is caught by what was published", async () => {
  const h = await history();
  const db = open(h.path);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest'").run();
  const replayed = replayDecisions(db, {}, { keys: h.keys, repo: REPO, anchor: null });
  const checked = publishedChecked(db, {}, { keys: h.keys, repo: REPO, anchor: null, published: githubOf(h.published) });
  db.close();
  assert.ok(replayed.every((r) => r.outcome === "same"), `control: the copy alone replays whole: ${JSON.stringify(replayed)}`);
  assert.match(checked.faults.map((f) => f.why).join("\n"), new RegExp(`published entry 2 of its signed order at ${B.slice(0, 8)}, but this copy's ends at entry 0`));
});

test("a copy with one pull request's every record and entry taken away is caught by the orders published with another", async () => {
  const dir = credentials();
  const { path, published } = await ticksOfTwo([at(A), at(B, "RED"), at(B, "RED")], host(dir));
  const db = open(path);
  db.prepare("DELETE FROM decision WHERE pr = 7").run();
  db.prepare("DELETE FROM event WHERE subject = 'pr:7'").run();
  const checked = publishedChecked(db, {}, { keys: publishedKeys(dir), repo: REPO, anchor: null, published: githubOf(published) });
  db.close();
  assert.equal(checked.prs, 1, "control: the copy names only #42 now");
  assert.match(checked.faults.map((f) => f.why).join("\n"), /published with #(42|7)'s result at bbbbbbbb the signed orders this store held to its event \d+, but this copy's orders to that event aren't those/);
});

test("entries taken from a pull request the check doesn't read are caught by the orders published with the one it does", async () => {
  const dir = credentials();
  const { path, published } = await ticksOfTwo([at(A), at(B, "RED"), at(B, "RED")], host(dir));
  const db = open(path);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND subject = 'pr:7' AND json_extract(payload, '$.n') = 2").run();
  const checked = publishedChecked(db, { pr: PR }, { keys: publishedKeys(dir), repo: REPO, anchor: null, published: githubOf(published) });
  db.close();
  assert.match(checked.faults.map((f) => f.why).join("\n"), /published with #42's result at bbbbbbbb the signed orders this store held to its event \d+, but this copy's orders to that event aren't those/);
});

test("a pull request with nothing published is named as unchecked, not passed over, and the orders published still hold the copy to what was", async () => {
  const dir = credentials();
  const { path, published } = await ticksOfTwo([at(A), at(B, "RED"), at(B, "RED")], host(dir));
  const db = open(path);
  const github = (pr, heads) => (pr === 7 ? { evidence: [] } : githubOf(published)(pr, heads));
  const checked = publishedChecked(db, {}, { keys: publishedKeys(dir), repo: REPO, anchor: null, published: github });
  db.close();
  assert.deepEqual(checked.unchecked, [7]);
  assert.deepEqual(checked.faults, [], "and the copy holds what was published");
});

test("a copy whose entry names another record than the one published is caught", async () => {
  const h = await history();
  const db = open(h.path);
  const github = (pr, heads) => {
    const got = githubOf(h.published)(pr, heads);
    return { evidence: got.evidence.map((e) => (e.order ? { ...e, order: { ...e.order, names: X } } : e)) };
  };
  const checked = publishedChecked(db, {}, { keys: h.keys, repo: REPO, anchor: null, published: github });
  db.close();
  assert.match(checked.faults.map((f) => f.why).join("\n"), new RegExp(`published entry 2 of its signed order at ${B.slice(0, 8)} naming ${X.slice(0, 12)}, but this copy's entry 2 names [0-9a-f]{12}`));
});

test("a published record the copy doesn't hold as it was kept, or holds as another pull request's, is caught", async () => {
  const h = await history();
  const db = open(h.path);
  const [green] = digestsOf(db);
  db.prepare("UPDATE decision SET record = json_set(record, '$.verdict.summary', 'edited') WHERE digest = ?").run(green);
  const changed = publishedChecked(db, {}, { keys: h.keys, repo: REPO, anchor: null, published: githubOf(h.published) });
  const other = publishedChecked(db, { pr: 7 }, { keys: h.keys, repo: REPO, anchor: null,
                                                  published: () => ({ evidence: [{ ...ev(digestsOf(db)[1]), pr: 7, head: B }] }) });
  db.close();
  assert.match(changed.faults.map((f) => f.why).join("\n"), new RegExp(`published this record for it at ${A.slice(0, 8)}, but this copy's doesn't hold: its record doesn't match its digest`));
  assert.match(other.faults.map((f) => f.why).join("\n"), /published this record for it at bbbbbbbb, but this copy holds it as pull request 42's/);
});

test("a read of GitHub that fails is a fault of the check, not a pass", async () => {
  const h = await history();
  const db = open(h.path);
  const checked = publishedChecked(db, {}, { keys: h.keys, repo: REPO, anchor: null, published: () => ({ why: "HTTP 502" }) });
  db.close();
  assert.match(checked.faults.map((f) => f.why).join("\n"), /what the merge policy published for it couldn't be read, so this copy wasn't checked against it: HTTP 502/);
});

test("a copy nothing published can be checked against doesn't pass as checked", async () => {
  const h = await history();
  const db = open(h.path);
  const checked = publishedChecked(db, {}, { keys: h.keys, repo: REPO, anchor: null, published: () => ({ evidence: [] }) });
  db.close();
  assert.equal(checked.results, 0);
  assert.match(checked.faults.map((f) => f.why).join("\n"), /no result the merge policy published names a record of these pull requests/);
});

test("reeve replay --published checks a copy away from the host, reading the merge policy's results with gh", async () => {
  const h = await history();
  assert.ok(h.published.every((p) => p.evidence), "the daemon published its evidence, to read back");
  const bin = tempDir("reeve-pub-gh-");
  // GitHub as gh answers these two reads, --jq applied: the pull request's head,
  // and the results at a commit, one to a line.
  const last = new Map(h.published.map((p) => [p.verdict.head, p]));
  for (const [head, p] of last)
    writeFileSync(join(bin, `runs-${head}`), JSON.stringify({ name: "merge-policy (shadow)", app: "merge-policy",
                                                                summary: `${p.verdict.state}: ${p.verdict.summary}\n${evidenceText(p.evidence)}` }) + "\n");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$2" in
  repos/${REPO}/pulls/${PR}) echo ${B} ;;
  "repos/${REPO}/pulls?state=all"*) echo ${PR} ;;
  --paginate) sha=$(echo "$3" | sed -E 's#.*/commits/([0-9a-f]+)/.*#\\1#'); cat "${bin}/runs-$sha" 2>/dev/null ;;
  *) echo "not a read this test answers: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  const home = tempDir("reeve-pub-home-");
  mkdirSync(join(home, "credentials"), { mode: 0o700 });
  copyFileSync(join(h.dir, PUBLIC_FILE), join(home, "credentials", PUBLIC_FILE));
  const env = { ...offlineEnv(), PATH: `${bin}:${offlineEnv().PATH}`, REEVE_HOME: home };
  const whole = spawnSync(process.execPath, [REEVE, "replay", REPO, "--db", h.path, "--published"], { encoding: "utf8", env });
  assert.equal(whole.status, 0, whole.stdout + whole.stderr);
  assert.match(whole.stdout, /checked against 2 result\(s\) the merge policy published/);

  const db = open(h.path);
  db.prepare("DELETE FROM event WHERE op = 'decision.latest' AND json_extract(payload, '$.n') = 2").run();
  db.close();
  const cut = spawnSync(process.execPath, [REEVE, "replay", REPO, "--db", h.path, "--published"], { encoding: "utf8", env });
  assert.equal(cut.status, 1, cut.stdout + cut.stderr);
  assert.match(cut.stdout, /published entry 2 of its signed order at bbbbbbbb, but this copy's ends at entry 1/);
  const alone = spawnSync(process.execPath, [REEVE, "replay", REPO, "--db", h.path], { encoding: "utf8", env });
  assert.doesNotMatch(alone.stdout, /published/, "control: without --published, GitHub isn't read");
});

test("--published is refused by every command but replay, rather than ignored", () => {
  const env = { ...offlineEnv(), REEVE_HOME: tempDir("reeve-pub-flag-") };
  for (const cmd of ["status", "backup", "why"]) {
    const r = spawnSync(process.execPath, [REEVE, cmd, REPO, "--published"], { encoding: "utf8", env });
    assert.notEqual(r.status, 0, `${cmd}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`--published is not implemented by \`${cmd}\``), `${cmd}: ${r.stderr}`);
  }
});

// ── a record that can't be read (#280) ──────────────────────────────────────

test("why says a latest record that can't be read can't be trusted, rather than stopping", async () => {
  const dir = credentials();
  const { path } = await ticks([at(A), at(A, "RED")], host(dir));
  const db = open(path);
  const [, red] = digestsOf(db);
  const keys = knownKeys({ local: dir });
  for (const record of ["{", "[]", '{"verdict":"x"}']) {
    db.prepare("UPDATE decision SET record = ? WHERE digest = ?").run(record, red);
    let shown;
    assert.doesNotThrow(() => { shown = explainDecision(db, PR, { keys, repo: REPO }); }, record);
    assert.match(String(shown), new RegExp(`this record can't be trusted: its record (can't be read|doesn't match its digest).*record ${red.slice(0, 12)}`), record);
  }
  db.close();
  const cli = spawnSync(process.execPath, [REEVE, "why", REPO, String(PR), "--db", path], { encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: dirname(dir) } });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /this record can't be trusted/);
});

test("replay reports a record that can't be read as not replayable, and replays the rest", async () => {
  const dir = credentials();
  const { path } = await ticks([at(A), at(A, "RED")], host(dir));
  const db = open(path);
  const [green, red] = digestsOf(db);
  db.prepare("UPDATE decision SET record = '{' WHERE digest = ?").run(red);
  let replayed = [];
  assert.doesNotThrow(() => { replayed = replayDecisions(db, {}, { keys: knownKeys({ local: dir }), repo: REPO }); });
  db.close();
  const of = (d) => replayed.filter((r) => r.digest === d);
  assert.deepEqual(of(green).map((r) => r.outcome), ["same"]);
  assert.ok(of(red).some((r) => r.outcome === "unreplayable" && /its record can't be read/.test(String(r.why))), JSON.stringify(replayed));
});

test("evidence or a policy the store can't read is reported as not its digest's, by why and replay, rather than stopping them", async () => {
  const dir = credentials();
  const { path } = await ticks([at(A)], host(dir));
  const db = open(path);
  const keys = knownKeys({ local: dir });
  const [green] = digestsOf(db);
  db.prepare("UPDATE evidence SET statement = '{' WHERE digest = (SELECT min(digest) FROM evidence)").run();
  let shown, replayed = [];
  assert.doesNotThrow(() => { shown = explainDecision(db, PR, { keys, repo: REPO }); });
  assert.doesNotThrow(() => { replayed = replayDecisions(db, {}, { keys, repo: REPO }); });
  assert.match(String(shown), /corrupt +[0-9a-f]{12}: this evidence doesn't match its digest/);
  assert.match(JSON.stringify(replayed.find((r) => r.digest === green)), /piece\(s\) of its evidence don't match their digests/);
  const fresh = open((await ticks([at(A)], host(dir))).path);
  fresh.prepare("UPDATE policy SET body = '{'").run();
  let again = [];
  assert.doesNotThrow(() => { again = replayDecisions(fresh, {}, { keys, repo: REPO }); });
  fresh.close();
  db.close();
  assert.match(JSON.stringify(again), /its policy doesn't match its hash/);
});

// ── #285's third review ──────────────────────────────────────────────────────

const Q = "c".repeat(40), QBASE = "d".repeat(40);
/** A queue's commit judged from its pull request's evaluation. */
const judgedAtQueue = ({ entry, input }) => { const i = { ...input, head: entry.sha }; return { ok: true, input: i, verdict: computeVerdict(i) }; };

/**
 * Ticks over one store, each listing the pull requests `open` gives for it, all
 * judged at A, with `ctx`. Answers the store's path, and what each publication
 * was given, in order.
 */
async function ticksOf(open_, n, ctx, path = join(tempDir("reeve-pub-of-"), "s.db")) {
  open(path).close();
  /** @type {any[]} */ const published = [];
  let tick = 0;
  await run({ openPrs: () => open_(++tick), evaluate: ({ pr }) => ({ ...at(A), pr }), dbPath: path, ticks: n, prState: () => "OPEN", prIsFinished: () => false,
              publish: async (args) => { published.push(args); return { ok: true, id: 1, conclusion: "neutral" }; }, ...ctx });
  return { path, published };
}

test("a copy with one pull request's orders taken away, and another's in their place, is caught by what was published, though it counts alike", async () => {
  const dir = credentials();
  // #7 judged alone, then #7 and #42: #42's first entry is made at the second tick's end.
  const { path, published } = await ticksOf((t) => (t === 1 ? [7] : [7, PR]), 2, host(dir));
  const db = open(path);
  // #7 taken away, every record and entry: #42's order alone is left, one pull request's, one entry, as #7's was.
  db.prepare("DELETE FROM decision WHERE pr = 7").run();
  db.prepare("DELETE FROM event WHERE subject = 'pr:7'").run();
  const checked = publishedChecked(db, {}, { keys: publishedKeys(dir), repo: REPO, anchor: null, published: githubOf(published) });
  db.close();
  assert.match(checked.faults.map((f) => f.why).join("\n"), /the signed orders this store held to its event \d+, but this copy's orders to that event aren't those/);
});

test("a pull request a copy no longer names is read from GitHub's list, and what was published of it holds the copy", async () => {
  const dir = credentials();
  const { path, published } = await ticksOf((t) => (t === 1 ? [7] : [7, PR]), 2, host(dir));
  const db = open(path);
  // Restored to before #42 was judged: it holds nothing of #42, so names it nowhere.
  db.prepare("DELETE FROM decision WHERE pr = ?").run(PR);
  db.prepare("DELETE FROM event WHERE subject = ?").run(`pr:${PR}`);
  const alone = publishedChecked(db, {}, { keys: publishedKeys(dir), repo: REPO, anchor: null, published: githubOf(published) });
  // And #99, which GitHub lists and reeve never judged: nothing published, and nothing of the copy's to check.
  const listed = publishedChecked(db, {}, { keys: publishedKeys(dir), repo: REPO, anchor: null, published: githubOf(published), listed: () => [7, PR, 99] });
  db.close();
  assert.equal(alone.prs, 1, "control: the copy names #7 alone");
  assert.equal(listed.prs, 3, "#42 read all the same, as GitHub lists it");
  assert.deepEqual(listed.unchecked, [], "and one the copy holds nothing of isn't named unchecked");
  const why = listed.faults.map((f) => f.why).join("\n");
  assert.match(why, /the merge policy published this record for it at aaaaaaaa, but this copy doesn't hold it/);
  assert.match(why, /the signed orders this store held to its event \d+, but this copy's orders to that event aren't those/);
});

test("a copy rolled back to before a merge queue's commit of several pull requests was judged is caught by the orders published as the tick extended them", async () => {
  const dir = credentials();
  const { path, published } = await ticksOf(() => [PR, 7], 1, { ...host(dir), evaluateQueue: judgedAtQueue,
    readQueue: () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: Q, baseSha: QBASE, state: "AWAITING_CHECKS" }, { pr: 7, sha: Q, baseSha: QBASE, state: "AWAITING_CHECKS" }] }) });
  const db = open(path);
  const queued = db.prepare("SELECT count(*) AS n FROM decision WHERE head = ?").get(Q).n;
  assert.equal(queued, 2, "control: the queue's commit was judged for both");
  // Rolled back to before the queue's commit was judged: its records, and the entries this tick made, gone.
  db.prepare("DELETE FROM decision WHERE head = ?").run(Q);
  db.prepare("DELETE FROM event WHERE op IN ('queue.decided', 'decision.latest')").run();
  const checked = publishedChecked(db, {}, { keys: publishedKeys(dir), repo: REPO, anchor: null, published: githubOf(published) });
  db.close();
  assert.match(checked.faults.map((f) => f.why).join("\n"), /the signed orders this store held to its event \d+, but this copy's orders to that event aren't those/);
});

test("the tick's orders, as its end extends them, are published with the last result it published at a pull request's head", async () => {
  const dir = credentials();
  const { path, published } = await ticksOf(() => [PR], 1, host(dir));
  const db = open(path);
  const last = db.prepare("SELECT MAX(seq) AS n FROM event WHERE op = 'decision.latest'").get().n;
  db.close();
  assert.ok(last > 0, "control: the tick extended an order");
  assert.equal(published.at(-1)?.evidence?.store.to, last, JSON.stringify(published.map((p) => p.evidence?.store)));
  assert.equal(published.at(-1)?.verdict.head, A, "at the pull request's head");
});

test("a copy whose top entry of an order the check doesn't read was swapped, at the same number, is caught by the orders published with one it does", async () => {
  const dir = credentials();
  const { path, published } = await ticksOfTwo([at(A), at(B, "RED"), at(B, "RED")], host(dir));
  const db = open(path);
  // #7's top entry signed again by this host, the same number and record, naming a record besides: a copy's own.
  const top = db.prepare("SELECT seq, payload FROM event WHERE op = 'decision.latest' AND subject = 'pr:7' ORDER BY json_extract(payload, '$.n') DESC LIMIT 1").get();
  const e = JSON.parse(top.payload);
  const records = ["f".repeat(64)];
  const s = fileSigner(dir)(latestStatement({ repo: e.repo, pr: 7, n: e.n, digest: e.digest, records, store: e.store, seq: e.seq }));
  db.prepare("UPDATE event SET payload = ? WHERE seq = ?").run(JSON.stringify({ ...e, records, envelope: s.envelope }), top.seq);
  const checked = publishedChecked(db, { pr: PR }, { keys: publishedKeys(dir), repo: REPO, anchor: null, published: githubOf(published) });
  db.close();
  assert.match(checked.faults.map((f) => f.why).join("\n"), /the signed orders this store held to its event \d+, but this copy's orders to that event aren't those/);
});

test("a list of the repository's pull requests that can't be read from GitHub is a fault of the check, not a pass", async () => {
  const h = await history();
  const db = open(h.path);
  const checked = publishedChecked(db, {}, { keys: h.keys, repo: REPO, anchor: null, published: githubOf(h.published), listed: () => ({ why: "HTTP 502" }) });
  db.close();
  assert.match(checked.faults.map((f) => f.why).join("\n"), /the repository's pull requests couldn't be listed from GitHub, so one this copy no longer names may be missed: HTTP 502/);
});

test("a result taken back before the tick's end isn't published again with its orders", async () => {
  const dir = credentials();
  const path = join(tempDir("reeve-pub-of-"), "s.db");
  // Taken back as the merge queue is read, after the pull request's head was published.
  const { published } = await ticksOf(() => [PR], 1, { ...host(dir), readQueue: () => {
    const db = open(path);
    db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
      .run(2, "daemon", "pr.withdrawn", `pr:${PR}`, JSON.stringify({ head: A, name: "merge-policy (shadow)", id: 1, why: "taken back" }));
    db.close();
    return { ok: true, queue: true, entries: [] };
  } }, path);
  assert.equal(published.filter((p) => p.verdict.head === A).length, 1, JSON.stringify(published.map((p) => p.evidence?.store)));
});

test("each result the daemon publishes says what the store's orders commit to at an event, so a store gone further is told from one that forked", async () => {
  const dir = credentials();
  /** @type {{ queue: boolean, orders: string, at: string | null | undefined }[]} */ const seen = [];
  // A queue's commit of one pull request too, which carries that one's evidence.
  await ticksOf(() => [PR], 2, { ...host(dir), evaluateQueue: judgedAtQueue,
    readQueue: () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: Q, baseSha: QBASE, state: "AWAITING_CHECKS" }] }),
    publish: async (/** @type {any} */ args) => {
    // Asked while the tick runs, of the store as the publication found it.
    if (args.evidence) seen.push({ queue: Boolean(args.queue), orders: args.evidence.store.orders, at: args.commitAt?.(args.evidence.store.to) });
    return { ok: true, id: 1, conclusion: "neutral" };
  } });
  assert.ok(seen.some((x) => x.queue) && seen.some((x) => !x.queue), `control: results were published at a head and on the queue's commit: ${JSON.stringify(seen)}`);
  for (const x of seen) assert.equal(x.at, x.orders);
});

// ── #285's fourth review ─────────────────────────────────────────────────────

/** A merge queue holding #42 alone at Q. */
const queueOfOne = () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: Q, baseSha: QBASE, state: "AWAITING_CHECKS" }] });
/** The highest entry of a signed order that names a record the queue's commit was judged with, in the store at `path`. */
const queueEntryAt = (path) => {
  const db = open(path);
  const queued = new Set(db.prepare("SELECT digest FROM decision WHERE head = ?").all(Q).map((r) => r.digest));
  const seqs = db.prepare("SELECT seq, payload FROM event WHERE op = 'decision.latest'").all()
    .filter((r) => { const p = JSON.parse(r.payload); return queued.has(p.digest) || p.records.some((d) => queued.has(d)); }).map((r) => r.seq);
  db.close();
  return Math.max(0, ...seqs);
};

test("the daemon raises a store behind what the merge policy published on a merge queue's commit", async () => {
  const path = join(tempDir("reeve-pub-qbehind-"), "s.db");
  open(path).close();
  const r = await run({ openPrs: () => [PR], evaluate: () => at(A), dbPath: path, ticks: 1, ...host(credentials()), evaluateQueue: judgedAtQueue, readQueue: queueOfOne,
                        publish: async (args) => ({ ok: true, id: 1, conclusion: "neutral",
                                                    ...(args.queue ? { behind: "at cccccccc, its signed orders go to its event 1, where orders to event 9 were published, so what was published there is kept" } : {}) }) });
  assert.match(r.esc, /#42: the store is behind what the merge policy published at cccccccc, its signed orders go to its event 1, where orders to event 9 were published/);
  assert.match(r.log, /#42: the store is behind what was published at cccccccc/);
});

test("an enforcing result is held to the evidence a shadow result carries at its head, as a shadow one is to an enforcing one's", async () => {
  const shadowed = ev(X, { n: 3, names: X }, st(9));
  const r = await publishOver(shadowed, ev(Y, { n: 2, names: Y }, st(8)), { shadow: false });
  assert.deepEqual(r.written, shadowed, "the enforcing result carries the shadow one's evidence, not the store's older evidence");
  assert.match(String(r.behind), /ends at entry 2, where entry 3 was published/);
  const ahead = ev(Y, { n: 4, names: Y }, st(10, "f"));
  assert.deepEqual(await publishOver(shadowed, ahead, { shadow: false }), { written: ahead, behind: null }, "control: evidence ahead of it is written");
});

test("a result is published with the record its verdict kept, and none where pinning kept none", async () => {
  const dir = credentials();
  const path = join(tempDir("reeve-pub-unpinned-"), "s.db");
  open(path).close();
  /** @type {any[]} */ const published = [];
  let tick = 0;
  const publish = async (/** @type {any} */ args) => { published.push({ tick, ...args }); return { ok: true, id: 1, conclusion: "neutral" }; };
  await run({ openPrs: () => { tick++; return [PR]; }, evaluate: () => at(A), dbPath: path, ticks: 1, ...host(dir), publish });
  // Judged again, red, where the host's anchor reads but won't take a pin.
  await run({ openPrs: () => { tick++; return [PR]; }, evaluate: () => at(A, "RED"), dbPath: path, ticks: 1, ...host(dir), anchor: { ...fileAnchor(dir), pin: () => false }, publish });
  const db = open(path);
  const held = new Set(digestsOf(db));
  db.close();
  assert.equal(held.size, 1, "control: the red verdict's record wasn't kept");
  assert.ok(published.some((p) => p.tick === 2 && p.verdict.state === "BLOCK"), "control: the red verdict was published");
  for (const p of published) if (p.evidence) assert.ok(held.has(p.evidence.record), `tick ${p.tick} published ${p.evidence.record.slice(0, 12)}, a record the store doesn't hold`);
});

test("a merge queue's PASS is published once the orders, extended with the records its commit was judged with, are published at a pull request's head", async () => {
  const dir = credentials();
  const { path, published } = await ticksOf(() => [PR, 7], 1, { ...host(dir), evaluateQueue: judgedAtQueue,
    readQueue: () => ({ ok: true, queue: true, entries: [{ pr: PR, sha: Q, baseSha: QBASE, state: "AWAITING_CHECKS" }, { pr: 7, sha: Q, baseSha: QBASE, state: "AWAITING_CHECKS" }] }) });
  const pass = published.findIndex((p) => p.queue && p.verdict.state === "PASS");
  assert.ok(pass > 0, `control: the queue's commit passed: ${JSON.stringify(published.map((p) => [p.queue, p.verdict.state]))}`);
  const entry = queueEntryAt(path);
  assert.ok(entry > 0, "control: an order names the queue's records");
  const before = published.slice(0, pass).filter((p) => !p.queue && p.evidence);
  assert.ok(before.some((p) => p.evidence.store.to >= entry), `a head carried them first: ${entry} ${JSON.stringify(before.map((p) => p.evidence.store.to))}`);
});

test("a merge queue's PASS whose records couldn't be published at a pull request's head first isn't published", async () => {
  const dir = credentials();
  const path = join(tempDir("reeve-pub-qwit-"), "s.db");
  open(path).close();
  /** @type {any[]} */ const published = [];
  const seen = new Set();
  const r = await run({ openPrs: () => [PR], evaluate: () => at(A), dbPath: path, ticks: 1, ...host(dir), evaluateQueue: judgedAtQueue, readQueue: queueOfOne,
                        publish: async (args) => {
                          published.push(args);
                          // A head's result goes out, and fails when it goes out again with its orders.
                          const key = `${args.evidence?.pr}@${args.verdict.head}`;
                          if (!args.queue && args.evidence && seen.has(key)) return { ok: false, why: "HTTP 502" };
                          seen.add(key);
                          return { ok: true, id: 1, conclusion: "neutral" };
                        } });
  assert.ok(published.some((p) => !p.queue && p.verdict.head === A), "control: the head was published");
  assert.deepEqual(published.filter((p) => p.queue && p.verdict.state === "PASS"), [], "no PASS went to the queue's commit");
  assert.match(r.log, /queue commit cccccccccc \(#42\): could not publish PASS — the store's signed orders, extended with its records, couldn't be published at a pull request's head first/);
  const db = open(path);
  const standing = db.prepare("SELECT count(*) AS n FROM event WHERE op = 'pr.published' AND json_extract(payload, '$.head') = ?").get(Q).n;
  db.close();
  assert.equal(standing, 0, "nor is a PASS written down as standing there");
});

test("the orders a tick extended are published again once, not once more at the tick's end with nothing new", async () => {
  const dir = credentials();
  const { published } = await ticksOf(() => [PR], 1, { ...host(dir), evaluateQueue: judgedAtQueue, readQueue: queueOfOne });
  const atHead = published.filter((p) => !p.queue && p.verdict.head === A);
  assert.ok(published.some((p) => p.queue), "control: the queue's commit was published");
  assert.equal(atHead.length, 2, `published, then again with the orders extended: ${JSON.stringify(atHead.map((p) => p.evidence?.store.to))}`);
});

test("a record published at a head stays there until the store holds it, though other evidence is no further behind", async () => {
  const Z = "f".repeat(64);
  const published = ev(X, { n: 3, names: Y }, st(9));
  const other = ev(Z, { n: 3, names: Y }, st(9));
  const lost = await publishOver(published, other, { holds: (d) => d !== X });
  assert.deepEqual(lost.written, published, "a store that doesn't hold the record published doesn't write over it");
  assert.match(String(lost.behind), /the record published there, c{12}, isn't one this store holds/);
  assert.deepEqual(await publishOver(published, other, { holds: () => true }), { written: other, behind: null }, "control: one that holds it goes on");
});

test("each result the daemon publishes is asked whether the store holds a record, at a head and on the queue's commit", async () => {
  const dir = credentials();
  /** @type {{ queue: boolean, own: boolean | undefined, other: boolean | undefined }[]} */ const seen = [];
  await ticksOf(() => [PR], 2, { ...host(dir), evaluateQueue: judgedAtQueue, readQueue: queueOfOne,
    publish: async (/** @type {any} */ args) => {
      if (args.evidence) seen.push({ queue: Boolean(args.queue), own: args.holds?.(args.evidence.record), other: args.holds?.("0".repeat(64)) });
      return { ok: true, id: 1, conclusion: "neutral" };
    } });
  assert.ok(seen.some((x) => x.queue) && seen.some((x) => !x.queue), `control: published at a head and on the queue's commit: ${JSON.stringify(seen)}`);
  for (const x of seen) assert.deepEqual([x.own, x.other], [true, false], JSON.stringify(x));
});

test("where the results at a head can't be read, nothing is written there, as a new result would hide what was published", async () => {
  for (const shadow of [true, false]) {
    /** @type {string[][]} */ const calls = [];
    const api = (/** @type {string} */ _t, /** @type {string[]} */ args) => {
      calls.push(args);
      return args.join(" ").includes("/check-runs?") ? { ok: false, out: "", err: "HTTP 502" } : { ok: true, out: JSON.stringify({ id: 9 }) };
    };
    const r = await publishVerdict({ nwo: REPO, verdict: { head: A, state: "BLOCK", summary: "ci", clauses: [] }, shadow, evidence: ev(X, { n: 1, names: X }, st(1)),
                                     auth: async () => ({ ok: true, token: "t" }), api });
    assert.equal(r.ok, false, `shadow ${shadow}`);
    assert.match(String(r.why), /the results at aaaaaaaa couldn't be read, so what was published there couldn't be kept/);
    assert.deepEqual(calls.filter((a) => a.includes("POST") || a.includes("PATCH")), [], `shadow ${shadow}: nothing written`);
  }
});

// ── #285's fifth review ──────────────────────────────────────────────────────

test("a merge queue's PASS isn't published where the orders published again at a head stayed behind what was there", async () => {
  const dir = credentials();
  const path = join(tempDir("reeve-pub-qbehind2-"), "s.db");
  open(path).close();
  /** @type {any[]} */ const published = [];
  const seen = new Set();
  const r = await run({ openPrs: () => [PR], evaluate: () => at(A), dbPath: path, ticks: 1, ...host(dir), evaluateQueue: judgedAtQueue, readQueue: queueOfOne,
                        publish: async (args) => {
                          published.push(args);
                          // Published again with its orders, and kept behind evidence further on there.
                          const key = `${args.evidence?.pr}@${args.verdict.head}`;
                          const again = !args.queue && args.evidence && seen.has(key);
                          seen.add(key);
                          return { ok: true, id: 1, conclusion: "neutral", ...(again ? { behind: "at aaaaaaaa, its signed orders go to its event 3, where orders to event 9 were published, so what was published there is kept" } : {}) };
                        } });
  assert.ok(published.filter((p) => !p.queue && p.verdict.head === A).length >= 2, "control: the head was published again");
  assert.deepEqual(published.filter((p) => p.queue && p.verdict.state === "PASS"), [], "no PASS went to the queue's commit");
  assert.match(r.log, /queue commit cccccccccc \(#42\): could not publish PASS — the store's signed orders, extended with its records, couldn't be published/);
});

test("the daemon holds a record published only where the store holds it whole, not changed in place", async () => {
  const dir = credentials();
  const path = join(tempDir("reeve-pub-whole-"), "s.db");
  open(path).close();
  await run({ openPrs: () => [PR], evaluate: () => at(A), dbPath: path, ticks: 1, ...host(dir), publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }) });
  let db = open(path);
  const [first] = digestsOf(db);
  // Changed in place: its row still there under its digest, naming another pull request.
  db.prepare("UPDATE decision SET record = json_set(record, '$.subject.pr', 9) WHERE digest = ?").run(first);
  db.close();
  /** @type {(boolean | undefined)[]} */ const asked = [];
  await run({ openPrs: () => [PR], evaluate: () => at(A, "RED"), dbPath: path, ticks: 1, ...host(dir),
              publish: async (/** @type {any} */ args) => { if (args.holds) asked.push(args.holds(first)); return { ok: true, id: 1, conclusion: "neutral" }; } });
  db = open(path);
  const rows = db.prepare("SELECT count(*) AS n FROM decision WHERE digest = ?").get(first).n;
  db.close();
  assert.equal(rows, 1, "control: its row is still there");
  assert.ok(asked.length > 0, "control: the publication asked");
  assert.ok(asked.every((x) => x === false), JSON.stringify(asked));
});

test("a published commitment a copy's orders can't be committed to is a fault, though the check reads another pull request alone", async () => {
  const dir = credentials();
  const { path, published } = await ticksOfTwo([at(A), at(A, "RED")], host(dir));
  const db = open(path);
  // #7's order doesn't hold; #42 is the one checked.
  db.prepare("UPDATE event SET payload = json_set(payload, '$.seq', 99999) WHERE op = 'decision.latest' AND subject = 'pr:7'").run();
  const checked = publishedChecked(db, { pr: PR }, { keys: publishedKeys(dir), repo: REPO, anchor: null, published: githubOf(published) });
  db.close();
  assert.ok(checked.results > 0, "control: #42's results were checked");
  assert.match(checked.faults.map((f) => f.why).join("\n"), /this copy's signed orders to its event \d+ can't be committed to, so what the merge policy published with #\d+'s result at [0-9a-f]{8} can't be checked: #7: /);
});
