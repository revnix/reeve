// Every UNKNOWN names its kind and its next action, and the watcher decides by
// the kind, never by the wording (#165).
//
// The direction: each UNKNOWN says whether reeve is waiting, retrying, missing
// something it will ask for, or needs a person, and only the last reaches one.
// Before this, a clause carried free text alone, and the watcher found out what
// to do by matching that text, so rewording a detail changed a decision.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeVerdict, UNKNOWN_KINDS } from "../src/verdict.mjs";
import { nextAction, ACTIONS, ESCALATIONS } from "../src/watcher.mjs";

const HEAD = "bfbbe6ed6a1c2d3e4f5061728394a5b6c7d8e9f0";
/** A fully satisfied input, as test/verdict.test.mjs builds it. */
const good = () => ({
  head: HEAD,
  checks: { verdict: "GREEN", settled: true, failing: [] },
  base: { verdict: "GREEN" },
  reviewers: [{ login: "bot", kind: "blocking", state: "CLEAN", reviewedHead: HEAD.slice(0, 10) }],
  rounds: { n: 2, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 4, readable: true },
  cleared: { readable: true, uncleared: 0, reviewers: [] },
  bodyFindings: { readable: true, open: 0, reviewers: [] },
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
  ledgerBlockers: 0,
  mergeState: "CLEAN",
});
/** What the base requires, read in full, with nothing outstanding unless overridden. */
const parts = (over = {}) => ({ readable: true, mergeable: "MERGEABLE", reviewDecision: null, ownCheckRequired: true, others: [],
                                unresolvedBlocks: false, strict: false, behind: 0, unevaluated: [], ...over });
const blocked = over => i => { i.mergeState = "BLOCKED"; i.mergeParts = parts(over); };

// Inputs that reach UNKNOWN clauses, with the kind each one must name.
const CASES = [
  ["no check reading", "ci", "retry", i => { delete i.checks; }],
  ["checks still settling", "ci", "waiting", i => { i.checks = { verdict: "SETTLING", settled: false, failing: [] }; }],
  ["a check verdict reeve doesn't know", "ci", "retry", i => { i.checks = { verdict: "WHATEVER", settled: true, failing: [] }; }],
  ["the base not read", "base", "retry", i => { delete i.base; }],
  ["the base still settling", "base", "waiting", i => { i.base = { verdict: "SETTLING" }; }],
  ["a blocking reviewer unreachable", "review", "person", i => { i.reviewers = [{ login: "bot", kind: "blocking", state: "REFUSED" }]; }],
  ["a blocking reviewer not yet run", "review", "missing", i => { i.reviewers = [{ login: "bot", kind: "blocking", state: "NOT_RUN" }]; }],
  ["threads unreadable", "threads", "retry", i => { i.threads = { readable: false }; }],
  ["the ledger unreadable", "findings", "retry", i => { i.ledgerBlockers = null; }],
  ["a hold that can't be read", "hold", "person", i => { i.hold = { readable: false, why: "no hub" }; }],
  ["the merge state not read", "mergeable", "retry", i => { delete i.mergeState; }],
  ["GitHub still computing mergeability", "mergeable", "waiting", i => { i.mergeState = "UNKNOWN"; }],
  ["the merge parts errored", "mergeable", "retry", i => { i.mergeState = "BLOCKED"; i.mergeParts = { readable: false }; }],
  ["reeve's own requirement unreadable", "mergeable", "retry", blocked({ ownCheckRequired: null })],
  ["the base's other rules unreadable", "mergeable", "retry", blocked({ others: null })],
  ["required checks still running", "mergeable", "waiting", blocked({ others: [{ context: "CI gate", state: "running" }] })],
  ["a requirement reeve doesn't evaluate", "mergeable", "person", blocked({ unevaluated: ["code owners' approval"] })],
  ["GitHub not settled on merging", "mergeable", "waiting", blocked({ mergeable: "UNKNOWN" })],
];
const verdictFor = mutate => { const i = good(); mutate(i); return computeVerdict(i); };

test("every UNKNOWN site in the verdict names a kind and a next action", () => {
  const src = readFileSync(new URL("../src/verdict.mjs", import.meta.url), "utf8");
  const sites = src.split("\n").filter(l => /add\("[a-zA-Z]+", UNKNOWN, /.test(l));
  assert.ok(sites.length >= 20, `control: the UNKNOWN sites were found (${sites.length})`);
  const named = new RegExp(`, "(${UNKNOWN_KINDS.join("|")})", "[^"]+"\\);\\s*$`);
  assert.deepEqual(sites.filter(l => !named.test(l)), []);
});

test("each UNKNOWN names the kind that says what happens next", () => {
  for (const [what, id, kind, mutate] of CASES) {
    const c = verdictFor(mutate).clauses.find(x => x.id === id);
    assert.equal(c?.state, "UNKNOWN", `control: ${what} reaches an UNKNOWN ${id} clause`);
    assert.equal(c?.kind, kind, what);
    assert.ok(typeof c?.next === "string" && c.next.length > 0, `${what} names its next action`);
  }
});

test("an UNKNOWN verdict carries the most serious kind among its clauses, and a settled one carries none", () => {
  const waitingAndRetry = verdictFor(i => { i.checks = { verdict: "SETTLING", settled: false, failing: [] }; i.threads = { readable: false }; });
  assert.equal(waitingAndRetry.state, "UNKNOWN");
  assert.equal(waitingAndRetry.kind, "retry");
  const withPerson = verdictFor(i => { i.threads = { readable: false }; blocked({ unevaluated: ["code owners' approval"] })(i); });
  assert.equal(withPerson.kind, "person");
  assert.equal(computeVerdict(good()).kind, undefined);
});

// ── the watcher decides by the kind ───────────────────────────────────────────

const P = { rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 }, authority: { policy: "propose_and_merge" }, watch: { reviewActions: true } };
const ev = verdict => ({ pr: 1, state: "open", checks: {}, rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 }, verdict });
/** A verdict with one clause's wording replaced, its kind kept. */
const reworded = (v, id, detail) => ({ ...v, clauses: v.clauses.map(c => (c.id === id ? { ...c, detail } : c)) });
/** A verdict with one clause's kind replaced, its wording kept. */
const rekinded = (v, id, kind) => ({ ...v, clauses: v.clauses.map(c => (c.id === id ? { ...c, kind } : c)) });

test("a reviewer's missing round is asked for, whatever the clause says", () => {
  const v = verdictFor(i => { i.reviewers = [{ login: "bot", kind: "blocking", state: "NOT_RUN" }]; });
  assert.equal(nextAction(ev(reworded(v, "review", "the bot has said nothing here")), P).action, ACTIONS.REQUEST_REVIEW);
});

test("wording alone decides nothing: a review clause worded as not run, but of another kind, waits", () => {
  const v = verdictFor(i => { i.reviewers = [{ login: "bot", kind: "blocking", state: "NOT_RUN" }]; });
  assert.equal(nextAction(ev(rekinded(v, "review", "waiting")), P).action, ACTIONS.WAIT);
});

test("a reviewer only a person can make reachable again goes to one, as reviewers down", () => {
  const v = verdictFor(i => { i.reviewers = [{ login: "bot", kind: "blocking", state: "REFUSED" }]; });
  const d = nextAction(ev(reworded(v, "review", "no answer from the bot")), P);
  assert.equal(d.action, ACTIONS.ESCALATE);
  assert.equal(d.why, ESCALATIONS.REVIEWERS_DOWN);
});

test("a requirement reeve doesn't evaluate goes to a person at once, not after the settling window", () => {
  const v = verdictFor(blocked({ unevaluated: ["code owners' approval"] }));
  const d = nextAction(ev(v), P, { now: 1000, unknownSince: 1000 });
  assert.equal(d.action, ACTIONS.ESCALATE);
  assert.equal(d.why, ESCALATIONS.PROTECTION_UNMET);
});

test("control: an UNKNOWN reeve only waits on still waits, inside its window", () => {
  const v = verdictFor(i => { i.checks = { verdict: "SETTLING", settled: false, failing: [] }; });
  assert.equal(nextAction(ev(v), P, { now: 1000, unknownSince: 1000 }).action, ACTIONS.WAIT);
});
