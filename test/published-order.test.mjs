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
import { fileSigner, knownKeys, PUBLIC_FILE } from "../src/signing.mjs";
import { fileAnchor, anchorPath } from "../src/anchor.mjs";
import { open } from "../src/db/ops.mjs";
import { explainDecision, replayDecisions, publishedChecked } from "../src/decisions.mjs";
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

test("the evidence reads back as it was written, with an entry of the order or none yet", () => {
  for (const e of [{ pr: PR, record: X, order: { n: 3, names: Y } }, { pr: PR, record: X, order: null }]) {
    const text = `PASS: all clear\n\nclauses...\n${evidenceText(e)}`;
    assert.deepEqual(readEvidence(text, PR), e);
    assert.equal(readEvidence(text, 7), null, "and it's evidence of its own pull request only");
  }
});

test("evidence that doesn't read whole is none", () => {
  const whole = evidenceText({ pr: PR, record: X, order: { n: 3, names: Y } });
  const lines = whole.split("\n");
  const without = (i) => lines.filter((_, j) => j !== i).join("\n");
  assert.equal(readEvidence(without(lines.findIndex((l) => l.startsWith("- record"))), PR), null, "no record");
  assert.equal(readEvidence(without(lines.findIndex((l) => l.startsWith("- signed order"))), PR), null, "no order line");
  assert.equal(readEvidence(`${whole}\n- signed order of #${PR}: no entry yet`, PR), null, "both order lines");
  assert.equal(readEvidence(whole.replace(X, "c".repeat(63)), PR), null, "a record that isn't a digest");
  assert.ok(readEvidence(whole, PR), "control");
  assert.throws(() => evidenceText({ pr: PR, record: "c".repeat(63), order: null }), /not evidence to publish/);
  assert.throws(() => evidenceText({ pr: PR, record: X, order: { n: 0, names: Y } }), /not evidence to publish/);
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

test("what was published is read from the merge policy's own results only, at the pull request's head and each head asked about", () => {
  const ev = (record) => `BLOCK: ci is red\n${evidenceText({ pr: PR, record, order: null })}`;
  const calls = [];
  const gh = githubAt(B, {
    [A]: [{ name: "merge-policy (shadow)", app: "merge-policy", summary: ev(X) }],
    [B]: [{ name: "merge-policy", app: "merge-policy", summary: ev(Y) },
          { name: "merge-policy", app: "someone-else", summary: ev("e".repeat(64)) },
          { name: "tests", app: "merge-policy", summary: ev("f".repeat(64)) }],
  }, calls);
  const got = readPublished(REPO, PR, [A], { gh });
  assert.ok("evidence" in got, JSON.stringify(got));
  assert.deepEqual(got.evidence.map((e) => [e.head, e.record]).sort(), [[A, X], [B, Y]]);
  assert.ok(calls.every((c) => !c.join(" ").includes("someone")), "control: nothing else was asked");
});

test("a read of GitHub that fails vouches for nothing", () => {
  assert.match(JSON.stringify(readPublished(REPO, PR, [A], { gh: () => ({ ok: false, out: "", err: "HTTP 502" }) })), /#42 couldn't be read from GitHub: HTTP 502/);
  const runsFail = (args) => (args[0] === `repos/${REPO}/pulls/${PR}` ? { ok: true, out: B } : { ok: false, out: "", err: "HTTP 502" });
  assert.match(JSON.stringify(readPublished(REPO, PR, [A], { gh: runsFail })), /results at bbbbbbbb couldn't be read from GitHub: HTTP 502/);
  const garbled = (args) => (args[0] === `repos/${REPO}/pulls/${PR}` ? { ok: true, out: B } : { ok: true, out: "{not json" });
  assert.match(JSON.stringify(readPublished(REPO, PR, [A], { gh: garbled })), /results at bbbbbbbb don't read as GitHub's/);
});

// ── publishing it ────────────────────────────────────────────────────────────

test("a published result carries its evidence after the verdict, however long the verdict, shadow or not", async () => {
  const long = { head: A, state: "BLOCK", summary: "ci is red", clauses: [{ id: "ci", state: "BLOCK", detail: "x".repeat(70000) }] };
  const evidence = { pr: PR, record: X, order: { n: 2, names: Y } };
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

test("each result the daemon publishes names the record it kept, and where the pull request's signed order stood", async () => {
  const dir = credentials();
  const { path, published } = await ticks([at(A), at(A), at(A, "RED")], host(dir));
  const db = open(path);
  const [green, red] = digestsOf(db);
  db.close();
  assert.deepEqual(published.map((p) => p.evidence), [
    { pr: PR, record: green, order: null },
    { pr: PR, record: green, order: { n: 1, names: green } },
    // The order is extended at the tick's end, so it lags the record by a tick.
    { pr: PR, record: red, order: { n: 1, names: green } },
  ]);
});

/** What one tick over the store at `path` publishes of #42 at A, red, with `ctx`. */
async function publishedOnce(path, ctx, evaluation = at(A, "RED")) {
  /** @type {any[]} */ const got = [];
  await run({ openPrs: () => [PR], evaluate: () => evaluation, dbPath: path, ticks: 1, ...ctx,
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

  const other = credentials();
  fileAnchor(other).bind(REPO, "f".repeat(32));
  assert.deepEqual(await publishedOnce(fresh(), host(other)), [null], "a host's anchor another store is bound to");

  const edited = credentials();
  const { path } = await ticks([at(A), at(A, "RED")], host(edited));
  const db = open(path);
  db.prepare("UPDATE event SET payload = json_set(payload, '$.seq', 99999) WHERE op = 'decision.latest'").run();
  db.close();
  assert.deepEqual(await publishedOnce(path, host(edited)), [null], "an order that doesn't hold");

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
                                                  published: () => ({ evidence: [{ pr: 7, record: digestsOf(db)[1], order: null, head: B }] }) });
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
