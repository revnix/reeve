// Evidence records and decision records (#165).
//
// `computeVerdict` is pure, so keeping what it was given is enough to explain and
// replay a verdict exactly. These tests prove the records keep all of it, and
// that their digests say what was decided and from what, never when.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeVerdict } from "../src/verdict.mjs";
import { canonical } from "../src/db/ops.mjs";
import { splitEvidence, joinEvidence, decisionRecord, policyOf, codeVersion, digestOf, asJson,
         STATEMENT_TYPE, EVIDENCE_PREDICATE } from "../src/evidence.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const HEAD = "bfbbe6ed6a1c2d3e4f5061728394a5b6c7d8e9f0";
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const at = (observedAt = "2026-09-27T04:00:00Z") =>
  ({ nwo: "o/r", pr: 7, head: HEAD, tree: TREE, producer: { name: "reeve", version: "abc123" }, observedAt });

/** A fully satisfied input, as test/verdict.test.mjs builds it, with a profile and a hold. */
const good = () => ({
  head: HEAD,
  checks: { verdict: "GREEN", settled: true, failing: [], impostors: [], shadowRequired: false },
  base: { verdict: "GREEN" },
  reviewers: [{ login: "bot", kind: "blocking", state: "CLEAN", reviewedHead: HEAD.slice(0, 10) }],
  rounds: { n: 2, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 4, readable: true },
  cleared: { readable: true, uncleared: 0, reviewers: [] },
  bodyFindings: { readable: true, open: 0, reviewers: [] },
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
  ledgerBlockers: 0,
  mergeState: "CLEAN",
  mergeParts: { readable: true, behind: 0, required: [] },
  hold: null,
  profile: { schemaVersion: 1, project: { kind: "product" }, path: "/home/someone/.reeve/profiles/o/r.json" },
});
/** Inputs that reach each verdict, and one carrying a key no source knows yet. */
const variants = () => [
  good(),
  { ...good(), checks: { verdict: "RED", settled: true, failing: ["test"], impostors: [], shadowRequired: false } },
  { ...good(), threads: { unresolved: 0, total: 0, readable: false } },
  { ...good(), mergeState: "BEHIND", ledgerBlockers: null },
  { ...good(), hold: undefined },
  { ...good(), aFutureInput: { seen: true, n: 3 } },
];
const round = i => joinEvidence(splitEvidence(i, at()).map(e => e.statement), policyOf(i.profile).body);
const withoutPath = i => { const j = asJson(i); delete j.profile.path; return j; };

test("splitting the input into evidence and joining it again gives back exactly what computeVerdict got", () => {
  for (const i of variants()) assert.equal(canonical(asJson(round(i))), canonical(withoutPath(i)));
});

test("the verdict recomputed from the joined evidence is the verdict", () => {
  const states = new Set();
  for (const i of variants()) {
    const v = computeVerdict(i);
    states.add(v.state);
    assert.deepEqual(asJson(computeVerdict(round(i))), asJson(v));
  }
  assert.deepEqual([...states].sort(), ["BLOCK", "PASS", "UNKNOWN"], "the variants reach every verdict");
});

test("a key no source claims is kept, as evidence of its own", () => {
  const other = splitEvidence({ ...good(), aFutureInput: { seen: true } }, at()).find(e => e.kind === "other");
  assert.deepEqual(other?.statement.predicate.claim, { aFutureInput: { seen: true } });
});

test("the policy is not evidence: it is kept once, by hash, without the path it was read from", () => {
  const kinds = splitEvidence(good(), at()).flatMap(e => Object.keys(e.statement.predicate.claim));
  assert.ok(!kinds.includes("profile"));
  const a = policyOf(good().profile), b = policyOf({ ...good().profile, path: "/elsewhere/r.json" });
  assert.equal(a.hash, b.hash);
  assert.equal(a.body.path, undefined);
  assert.notEqual(policyOf({ ...good().profile, project: { kind: "client" } }).hash, a.hash);
});

test("an evidence digest leaves out when the reading was seen, and changes with what it says", () => {
  const first = splitEvidence(good(), at("2026-09-27T04:00:00Z"));
  const later = splitEvidence(good(), at("2026-09-27T05:00:00Z"));
  assert.deepEqual(later.map(e => e.digest), first.map(e => e.digest));
  const red = splitEvidence({ ...good(), checks: { ...good().checks, failing: ["lint"] } }, at());
  const changed = red.filter((e, n) => e.digest !== first[n].digest).map(e => e.kind);
  assert.deepEqual(changed, ["checks"]);
});

test("evidence takes the in-toto Statement v1 shape, about the commit and its tree", () => {
  const e = splitEvidence(good(), at()).find(x => x.kind === "checks");
  assert.equal(e?.statement._type, STATEMENT_TYPE);
  assert.equal(e?.statement.predicateType, EVIDENCE_PREDICATE);
  assert.deepEqual(e?.statement.subject, [{ name: "o/r#7", digest: { gitCommit: HEAD, gitTree: TREE } }]);
  assert.deepEqual(Object.keys(e?.statement.predicate ?? {}).sort(), ["claim", "from", "kind", "observedAt", "producer"]);
  assert.equal(e?.statement.predicate.observedAt, "2026-09-27T04:00:00Z");
});

test("a decision digest says what was decided and from what, never when", () => {
  const evidence = splitEvidence(good(), at());
  const base = { nwo: "o/r", pr: 7, head: HEAD, tree: TREE, policy: policyOf(good().profile).hash,
                 code: { commit: "c1", tree: "t1", dirty: false, diff: null }, evidence, verdict: computeVerdict(good()) };
  const d = decisionRecord(base);
  assert.equal(decisionRecord(base).digest, d.digest);
  assert.equal(d.digest, digestOf(d.record));
  for (const [what, changed] of [
    ["policy", { ...base, policy: "other" }],
    ["code", { ...base, code: { ...base.code, commit: "c2" } }],
    ["evidence", { ...base, evidence: splitEvidence({ ...good(), mergeState: "BEHIND" }, at()) }],
    ["verdict", { ...base, verdict: computeVerdict({ ...good(), mergeState: "BEHIND" }) }],
  ]) assert.notEqual(decisionRecord(changed).digest, d.digest, `a change of ${what}`);
});

/** A git repository with one commit. */
function repo() {
  const dir = tempDir("reeve-code-");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
  git("add", "a.mjs");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "one");
  return { dir, git };
}

test("the code version names the commit and its tree, and a clean checkout as clean", () => {
  const { dir, git } = repo();
  assert.deepEqual(codeVersion(dir), { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty: false, diff: null });
});

test("a changed checkout is marked, with a digest of the change, and a new file counts as a change", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "a.mjs"), "export const a = 2;\n");
  const edited = codeVersion(dir);
  assert.equal(edited.dirty, true);
  assert.match(String(edited.diff), /^[0-9a-f]{64}$/);
  writeFileSync(join(dir, "b.mjs"), "export const b = 1;\n");
  const added = codeVersion(dir);
  assert.equal(added.dirty, true);
  assert.notEqual(added.diff, edited.diff);
});

test("a folder git can't read gives no version, not a clean one", () => {
  assert.deepEqual(codeVersion(tempDir("reeve-nogit-")), { commit: null, tree: null, dirty: null, diff: null });
});
