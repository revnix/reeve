// The verdict decides merges, so every case here is a measured incident.
// The governing rule: UNKNOWN never merges. Every fail-open defect found in the
// previous system was an UNKNOWN rendered as a PASS.
import { computeVerdict, coversHead, publishArgs, PASS, BLOCK, UNKNOWN } from "../src/verdict.mjs";

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fail++; }
};

const HEAD = "bfbbe6ed6a1c2d3e4f5061728394a5b6c7d8e9f0";

/** A fully satisfied input. Every case below breaks exactly one thing. */
const good = () => ({
  head: HEAD,
  checks: { verdict: "GREEN", settled: true, failing: [] },
  base: { verdict: "GREEN" },
  reviewers: [{ login: "codex", kind: "blocking", state: "CLEAN", reviewedHead: HEAD.slice(0, 10) }],
  rounds: { n: 2, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 4, readable: true },
  // A satisfied revision has both: GitHub calls nothing unresolved AND every
  // blocking reviewer has come back to what it filed. They are different facts,
  // and the second is the one a bot self-resolving its own thread cannot fake.
  cleared: { readable: true, uncleared: 0, reviewers: [] },
  ledgerBlockers: 0,
  mergeState: "CLEAN",
});
const withOut = mut => { const i = good(); mut(i); return computeVerdict(i).state; };

// --- resolved is a CLAIM; cleared is EVIDENCE -------------------------------
//
// The verdict read GitHub's `isResolved` and nothing else, so a thread the bot
// resolved itself left the threads clause PASSing. Measured on nextly: the bot
// resolves its own threads, eight on one pull request with nobody replying, and
// `@coderabbitai resolve` is author-invokable and bulk-resolves. A critical
// finding could therefore leave the verdict by being dismissed by the thing that
// filed it.
const clauseOf = (i, id) => computeVerdict(i).clauses.find(c => c.id === id);
check("a thread nobody came back to BLOCKS, even with GitHub calling it resolved",
  withOut(i => { i.cleared = { readable: true, uncleared: 1, reviewers: ["codex"] }; }), BLOCK);
check("and it blocks BELOW the round cap too, because the cap is a different question",
  withOut(i => { i.rounds = { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 };
                 i.cleared = { readable: true, uncleared: 1, reviewers: ["codex"] }; }), BLOCK);
check("an unreadable projection is UNKNOWN, never a pass",
  withOut(i => { i.cleared = { readable: false, why: "not derived" }; }), UNKNOWN);
check("and an absent one is too, because absence is not evidence of agreement",
  withOut(i => { delete i.cleared; }), UNKNOWN);
check("control: zero uncleared is a pass, so the clause is not blocking everything",
  withOut(i => { i.cleared = { readable: true, uncleared: 0, reviewers: [] }; }), PASS);

// The clause NAMES the reviewer, because "a thread is open" and "codex has not
// come back" send a person to different places.
{
  const i = good();
  i.cleared = { readable: true, uncleared: 2, reviewers: ["codex"] };
  check("the clause names who has not returned", /codex/.test(clauseOf(i, "cleared").detail), true);
}

// --- past the cap with an UNKNOWN critical count is not a pass ---------------
//
// `null > 0` is false, so an unreadable critical count fell through to the pass
// -- absence read as success in the clause that exists to stop a critical being
// carried past the budget.
check("past the soft cap with an unknown critical count is UNKNOWN",
  withOut(i => { i.rounds = { n: 6, softCap: 5, hardCap: 10, unspilledCritical: null }; }), UNKNOWN);
check("control: BELOW the cap an unknown critical count still passes, because it changes nothing there",
  withOut(i => { i.rounds = { n: 1, softCap: 5, hardCap: 10, unspilledCritical: null }; }), PASS);
check("control: and a KNOWN zero past the cap still passes",
  withOut(i => { i.rounds = { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 0 }; }), PASS);

// Positive control. Without this, every refusal below proves nothing.
check("a fully satisfied revision PASSes", computeVerdict(good()).state, PASS);

// ── the incidents ─────────────────────────────────────────────────────────

// PR #1120 merged at 03:46:11; Codex's review landed at 03:46:29. "No findings
// yet" was read as "no findings". A round in flight must never read as clean.
check("a blocking reviewer that has not run yet is UNKNOWN",
  withOut(i => { i.reviewers[0].state = "NOT_RUN"; i.reviewers[0].reviewedHead = null; }), UNKNOWN);

// 65 of 65 Codex comments on the last 40 merged PRs were quota refusals.
check("a quota-refused reviewer is UNKNOWN, never PASS",
  withOut(i => { i.reviewers[0].state = "REFUSED"; i.reviewers[0].reviewedHead = null; }), UNKNOWN);

// @greptile-apps is tagged on PRs and is not installed: the tag produces mention
// bookkeeping and nothing else, which is byte-identical to a pending review.
check("a declared-but-absent reviewer is UNKNOWN",
  withOut(i => { i.reviewers[0].state = "NOT_INSTALLED"; i.reviewers[0].reviewedHead = null; }), UNKNOWN);

// PR #1119's clean verdict named a commit superseded 23 seconds earlier.
check("a verdict naming a different revision BLOCKs",
  withOut(i => { i.reviewers[0].reviewedHead = "0123456789"; }), BLOCK);

// A workflow that has not scheduled its jobs reports an empty, unfailing set.
check("an unsettled green is UNKNOWN",
  withOut(i => { i.checks.settled = false; i.checks.why = "green reading 1 of 3"; }), UNKNOWN);

// A fork PR shows zero check runs while mergeable_state is blocked.
check("no check reading at all is UNKNOWN",
  withOut(i => { i.checks = null; }), UNKNOWN);

check("a required check that never reported BLOCKs",
  withOut(i => { i.checks = { verdict: "MISSING_REQUIRED", settled: true, why: "CI Gate never reported", failing: [] }; }), BLOCK);

// strict:false means GitHub does not check this, so the verdict must.
check("a red base BLOCKs",
  withOut(i => { i.base = { verdict: "RED" }; }), BLOCK);
check("an unreadable base is UNKNOWN",
  withOut(i => { i.base = { verdict: "UNKNOWN" }; }), UNKNOWN);

// The previous gate skipped its findings check entirely when the read failed.
check("unreadable ledger blockers is UNKNOWN, not zero",
  withOut(i => { i.ledgerBlockers = null; }), UNKNOWN);
check("active ledger blockers BLOCK",
  withOut(i => { i.ledgerBlockers = 3; }), BLOCK);

// reviewThreads(first:100) has produced four consecutive false "zero" reports.
check("unreadable threads is UNKNOWN, not zero",
  withOut(i => { i.threads = { unresolved: 0, total: 0, readable: false }; }), UNKNOWN);
check("unresolved threads BLOCK",
  withOut(i => { i.threads = { unresolved: 2, total: 9, readable: true }; }), BLOCK);

check("a DIRTY merge state BLOCKs", withOut(i => { i.mergeState = "DIRTY"; }), BLOCK);
check("a BEHIND merge state BLOCKs", withOut(i => { i.mergeState = "BEHIND"; }), BLOCK);
check("UNSTABLE is acceptable", withOut(i => { i.mergeState = "UNSTABLE"; }), PASS);
check("GitHub still computing is UNKNOWN", withOut(i => { i.mergeState = "UNKNOWN"; }), UNKNOWN);

// The founder's rule: past the cap, only P0/P1 keep going, and a critical is
// never spilled to a follow-up PR.
check("the hard cap with an open critical BLOCKs",
  withOut(i => { i.rounds = { n: 10, softCap: 5, hardCap: 10, unspilledCritical: 1 }; }), BLOCK);
check("past the soft cap with an open critical BLOCKs",
  withOut(i => { i.rounds = { n: 7, softCap: 5, hardCap: 10, unspilledCritical: 2 }; }), BLOCK);
check("past the soft cap with everything spilled PASSes",
  withOut(i => { i.rounds = { n: 7, softCap: 5, hardCap: 10, unspilledCritical: 0 }; }), PASS);

// ── precedence ────────────────────────────────────────────────────────────

// A single BLOCK outranks everything; a single UNKNOWN outranks every PASS.
check("one BLOCK among passes is BLOCK",
  withOut(i => { i.threads.unresolved = 1; }), BLOCK);
check("BLOCK outranks UNKNOWN",
  withOut(i => { i.threads.unresolved = 1; i.ledgerBlockers = null; }), BLOCK);
check("UNKNOWN outranks PASS and cannot be outvoted",
  withOut(i => { i.ledgerBlockers = null; }), UNKNOWN);

// ── coversHead ────────────────────────────────────────────────────────────

check("a 10-hex prefix covers the full sha", coversHead(HEAD.slice(0, 10), HEAD), true);
check("the full sha covers itself", coversHead(HEAD, HEAD), true);
check("a different sha does not cover", coversHead("0123456789abcdef", HEAD), false);
check("a missing reviewed head covers nothing", coversHead(null, HEAD), false);
// A 6-hex prefix is too short to identify a revision safely.
check("a too-short prefix does not cover", coversHead(HEAD.slice(0, 6), HEAD), false);

// ── publishing ────────────────────────────────────────────────────────────

{
  const v = computeVerdict(good());
  const app = publishArgs(v, { nwo: "o/r", asApp: true });
  check("as an App it publishes a check run", app.surface, "check_run");
  check("bound to the exact head", app.body.head_sha, HEAD);
  const pat = publishArgs(v, { nwo: "o/r", asApp: false });
  check("without an App it falls back to a commit status", pat.surface, "status");
  check("the status path carries the sha", pat.path, `repos/o/r/statuses/${HEAD}`);
}
{
  // UNKNOWN must never publish as success on either surface.
  const v = computeVerdict({ ...good(), ledgerBlockers: null });
  check("UNKNOWN is not a success check run", publishArgs(v, { nwo: "o/r", asApp: true }).body.conclusion, "action_required");
  check("UNKNOWN is not a success status", publishArgs(v, { nwo: "o/r", asApp: false }).body.state, "pending");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
