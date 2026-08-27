// The verdict decides merges, so every case here is a measured incident.
// The governing rule: UNKNOWN never merges. Every fail-open defect found in the
// previous system was an UNKNOWN rendered as a PASS.
import { computeVerdict, coversHead, publishArgs, CLAUSE_IDS, PASS, BLOCK, UNKNOWN } from "../src/verdict.mjs";
import { readFileSync } from "node:fs";

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
  // A THIRD fact about review state, and it is separate from both above for the
  // reason its clause explains: a finding stated in a review body is not one of
  // GitHub's unresolved threads, so `threads` cannot see it, and answering it by
  // asking for another round -- which is what `cleared` means -- skips the fix.
  bodyFindings: { readable: true, open: 0, reviewers: [] },
  // A FOURTH, and it is not the same question as the one above. That clause asks
  // whether there are open findings in review bodies; this asks whether reeve
  // could read those bodies at all. One is work a worker can do; the other is
  // reeve saying it does not know what was said.
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
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
// UNKNOWN only when the count COULD have been known. A projection unreadable
// right now is a per-pull-request uncertainty; review-body findings never being
// derived is an unbuilt capability, and reporting THAT as UNKNOWN made every pull
// request past the cap UNKNOWN -- which the watcher handles before BLOCK
// findings, so the cap stopped every repair instead of stopping a spill. Absence
// read as success was the defect; absence read as paralysis is not the fix.
check("past the soft cap with an UNREADABLE projection is UNKNOWN",
  withOut(i => { i.rounds = { n: 6, softCap: 5, hardCap: 10, unspilledCritical: null, criticalGap: "unreadable" }; }), UNKNOWN);
// The permanent gap that PASS existed for is closed: a review body reeve cannot
// read is now counted as one `unknown` finding rather than omitted from the
// count, so a missing count is always transient and UNKNOWN clears itself.
// Nothing is left that can report "not derived", and the branch that spared it is
// gone with it -- which means the cap is now ENFORCED rather than announced as
// unenforced.
check("past the cap with a critical open BLOCKS, which is the cap actually enforced",
  withOut(i => { i.rounds = { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 1, blockingCritical: 1 }; }), BLOCK);
{
  const i = good();
  i.rounds = { n: 6, softCap: 5, hardCap: 10, unspilledCritical: null, criticalGap: "unreadable" };
  const c = computeVerdict(i).clauses.find(x => x.id === "rounds");
  check("and an unreadable count says so rather than passing silently",
    /cannot say how many criticals/.test(c.detail), true);
}
check("control: BELOW the cap an unknown critical count still passes, because it changes nothing there",
  withOut(i => { i.rounds = { n: 1, softCap: 5, hardCap: 10, unspilledCritical: null }; }), PASS);
check("control: and a KNOWN zero past the cap still passes",
  withOut(i => { i.rounds = { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 0 }; }), PASS);

// The body-finding clause. Its whole reason to exist is that neither neighbour
// can see what it sees.
check("an open review-body finding BLOCKS, though no thread is unresolved",
  withOut(i => { i.bodyFindings = { readable: true, open: 1, reviewers: ["codex"] }; }), BLOCK);
check("control: and zero of them passes, so the clause is not blocking everything",
  withOut(i => { i.bodyFindings = { readable: true, open: 0, reviewers: [] }; }), PASS);
check("an unreadable body population is UNKNOWN, never zero",
  withOut(i => { i.bodyFindings = { readable: false, why: "no projection" }; }), UNKNOWN);
{
  // The isolating control: with the OTHER two review clauses explicitly satisfied,
  // only this one can be producing the block. Without it, the assertion above
  // would pass just as well if `threads` were doing the work.
  const i = good();
  i.threads = { unresolved: 0, total: 4, readable: true };
  i.cleared = { readable: true, uncleared: 0, reviewers: [] };
  i.bodyFindings = { readable: true, open: 2, reviewers: ["codex"] };
  const v = computeVerdict(i);
  const c = v.clauses.find(x => x.id === "bodyFindings");
  check("and it is THIS clause blocking, with threads and cleared both satisfied",
    `${v.state}/${c.state}`, `${BLOCK}/${BLOCK}`);
  check("control: its neighbours really did pass, so the block is not theirs",
    v.clauses.filter(x => x.id === "threads" || x.id === "cleared").every(x => x.state === PASS), true);
}

// A body reeve cannot read stops the merge, whoever wrote it.
check("an unreadable review body BLOCKS",
  withOut(i => { i.unreadableBodies = { readable: true, open: 1, reviewers: ["a-human"] }; }), BLOCK);
check("control: and a readable one passes",
  withOut(i => { i.unreadableBodies = { readable: true, open: 0, reviewers: [] } }), PASS);
check("not knowing whether they were readable is UNKNOWN, never zero",
  withOut(i => { i.unreadableBodies = { readable: false, why: "no projection" }; }), UNKNOWN);
{
  // Isolating control: the finding clause explicitly satisfied, so only this one
  // can be producing the block.
  const i = good();
  i.bodyFindings = { readable: true, open: 0, reviewers: [] };
  i.unreadableBodies = { readable: true, open: 2, reviewers: ["a-human"] };
  const v = computeVerdict(i);
  check("and it is THIS clause blocking, with bodyFindings satisfied",
    `${v.clauses.find(c => c.id === "bodyReadable").state}/${v.clauses.find(c => c.id === "bodyFindings").state}`,
    `${BLOCK}/${PASS}`);
  check("and it names the reviewer to declare, because the fix is a line of profile",
    /a-human/.test(v.clauses.find(c => c.id === "bodyReadable").detail), true);
}

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
//
// TWO COUNTS SERVE TWO RULES. The cap blocks on criticals from a BLOCKING
// reviewer, because blocking-ness is what says whose opinion gates a merge. The
// spill refusal counts EVERY reviewer, because a critical is never deferred
// whoever filed it. Sharing one number made an advisory reviewer's P0 escalate a
// pull request that every gating clause had passed.
check("the hard cap with an open critical BLOCKs",
  withOut(i => { i.rounds = { n: 10, softCap: 5, hardCap: 10, unspilledCritical: 1, blockingCritical: 1 }; }), BLOCK);
check("past the soft cap with an open critical BLOCKs",
  withOut(i => { i.rounds = { n: 7, softCap: 5, hardCap: 10, unspilledCritical: 2, blockingCritical: 2 }; }), BLOCK);
// THE CASE THE SPLIT EXISTS FOR: past the cap, the only open critical belongs to
// an ADVISORY reviewer. Every gating clause passes, so the pull request must not
// escalate on an opinion the profile says does not gate.
check("an advisory reviewer's critical does NOT block at the cap",
  withOut(i => { i.rounds = { n: 7, softCap: 5, hardCap: 10, unspilledCritical: 1, blockingCritical: 0 }; }), PASS);
{
  // ...while still refusing a spill, which is the other half and reads the other
  // number. Asserted through the same clause set, so the two rules are shown to
  // disagree deliberately rather than by accident.
  const i = good();
  i.rounds = { n: 7, softCap: 5, hardCap: 10, unspilledCritical: 1, blockingCritical: 0 };
  const v = computeVerdict(i);
  check("control: and the rounds clause really is the one passing it",
    v.clauses.find(c => c.id === "rounds").state, PASS);
  check("control: while the universal count still says a critical is open, so nothing may be spilled",
    i.rounds.unspilledCritical > 0, true);
}
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

// ── the builder hold clause ────────────────────────────────────────────────
{
  const v = computeVerdict({ ...good(), hold: { readable: true, held: false } });
  check("a clear hold is a PASS clause", v.clauses.find(c => c.id === "hold")?.state, PASS);
  check("and does not disturb the verdict", v.state, PASS);
}
{
  const v = computeVerdict({ ...good(),
    hold: { readable: true, held: true, reason: "ownership_lost", detail: "the task no longer owns this path" } });
  const c = v.clauses.find(x => x.id === "hold");
  check("an open hold BLOCKS", c?.state, BLOCK);
  check("and carries the reason and the detail, not just the reason", c?.detail,
    "ownership_lost: the task no longer owns this path");
  check("so the whole verdict blocks", v.state, BLOCK);
}
{
  // ABSENT IS NOT UNREADABLE. This is the fail-open the guest connection exists
  // to prevent: an unreachable hub must never read as "nothing is held".
  const v = computeVerdict({ ...good(), hold: { readable: false, why: "no hub connection" } });
  check("an unreadable hold is UNKNOWN, never a pass", v.clauses.find(c => c.id === "hold")?.state, UNKNOWN);
  check("and UNKNOWN does not merge", v.state, UNKNOWN);
}
{
  // A guardian with no hub was never ASKED about holds, so it has no opinion.
  // An UNKNOWN clause here would drag every verdict it renders to UNKNOWN for a
  // question nobody put to it.
  const v = computeVerdict(good());
  check("no reading supplied means no clause at all", v.clauses.some(c => c.id === "hold"), false);
  check("and the verdict is unaffected", v.state, PASS);
}

// ── CLAUSE_IDS agrees with what computeVerdict actually emits ─────────────
// The list is consumed by three test matrices that assert TOTALITY over it. A
// restated set drifts, and a matrix claiming totality over a stale copy is how a
// clause ships with no branch while its test reports full coverage. So the list
// is compared against the source rather than trusted -- in BOTH directions,
// because an id declared but never emitted is just as wrong as one emitted and
// never declared, and only one of those is caught by running the code.
{
  const src = readFileSync(new URL("../src/verdict.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function computeVerdict"));
  // ANY quoted id, not a character class. This read was `[a-z_]+`, and every
  // clause id in the repository happened to be lowercase -- so the pattern was
  // correct by accident and totally blind to the first id that was not. Measured
  // against a trial merge with the lane adding `bodyFindings` and `bodyReadable`:
  // the two ids were never SEEN, both directions agreed on a set that silently
  // excluded them, and this block reported full agreement while `computeVerdict`
  // emitted two clauses the list did not declare. A narrowing read does not fail;
  // it answers a smaller question and calls it the answer.
  const calls = [...body.matchAll(/\badd\(\s*"([^"]*)"/g)].map(m => m[1]);
  const emitted = [...new Set(calls)].sort();
  const declared = [...CLAUSE_IDS].sort();
  // Fixture: a regex that matched nothing would make both sides trivially agree
  // on the empty set and pass while comparing nothing at all.
  check("fixture: the source really emits clauses this test can read", emitted.length > 0, true);
  // AND EVERY CALL WAS READ. The count is the guard on the guard: an `add(` whose
  // first argument this pattern cannot parse -- a renamed helper, a computed id,
  // a template literal -- would otherwise vanish from `emitted` and be declared
  // absent rather than unreadable, which is the exact failure above in a new
  // costume. Disagreement here means the reader is out of date, not the list.
  check("and every add() call in the body was actually read",
    calls.length, (body.match(/\badd\(/g) ?? []).length);
  check("every id computeVerdict emits is declared in CLAUSE_IDS",
    emitted.filter(id => !declared.includes(id)).join(",") || "none", "none");
  check("and every id CLAUSE_IDS declares is one computeVerdict emits",
    declared.filter(id => !emitted.includes(id)).join(",") || "none", "none");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
