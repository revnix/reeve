// The wire from the derived projection to the decision, end to end and offline.
//
// Two facts existed in the database and reached no decision. `derivePr` classifies
// every review thread by severity and clears the ones a later round covers;
// `reviewState` counts them. Both fed a shadow log and nothing else, so:
//
//   · `unspilledCritical` was hard-coded null in the evaluation, and SPILL fires
//     only on a KNOWN zero -- so SPILL was unreachable code. Not "rarely taken":
//     a branch that could not be taken, with tests passing over it because they
//     handed the watcher a number the product never produced.
//   · `threadDetails` was read by FIX_FINDINGS and by SPILL, and written nowhere,
//     so a worker dispatched at review findings was handed an empty list and told
//     it was the findings.
//
// The whole chain is exercised here without a network: ingest -> derive ->
// reviewFacts -> nextAction. The last step is the one that matters, because the
// gate's own tests hand `nextAction` a number directly and therefore prove the
// watcher's arithmetic while proving nothing about whether anything supplies it.
import { reviewFacts } from "../src/pr.mjs";
import { CLAUSE_IDS } from "../src/verdict.mjs";
import { nextAction, ACTIONS } from "../src/watcher.mjs";
import { derivePr, reviewState } from "../src/review/derive.mjs";
import { ingest, noteHead } from "../src/review/ingest.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "o/r", T = 1_700_000_000;
const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);
// The markers as MEASURED on nextly, not invented -- the same ones the derive
// test uses. Without them every finding classifies as `unknown`, and unknown
// BLOCKS, so a profile with no markers can never produce the known zero this file
// exists to demonstrate. That is correct behaviour and it is also a fixture trap:
// the first version of this test asserted one critical and got two, because both
// threads were unreadable rather than one being a nit.
const PROFILE = {
  reviewers: [{ login: "codex", kind: "blocking", trigger: "@codex review",
                severityMarkers: [["!\\[P1 Badge\\]", "critical"], ["\\| _🟡 Minor_ \\|", "minor"]] }],
  rounds: { softCap: 5, hardCap: 10 },
  watch: { reviewActions: true, staleSeconds: 900 },
};
const hash = s => createHash("sha256").update(s).digest("hex").slice(0, 16);
const thread = (id, who, body, resolved = false) => ({
  source: who, external_id: `thread:${id}`, kind: "review_thread",
  head_sha: null, event_at: T, edited_at: null,
  payload: { thread_id: id, is_resolved: resolved, is_outdated: false, resolved_by: null,
             path: "src/a.mjs", line: 10, author: who, body, review_id: null },
  content_hash: hash(id + body + resolved),
});
const review = (id, who, body, head, at) => ({
  source: who, external_id: `review:${id}`, kind: "review", head_sha: head,
  event_at: at, edited_at: null,
  payload: { login: who, state: "COMMENTED", commit_id: head, body },
  content_hash: hash(String(id) + body),
});

// The LIVE thread read this evaluation already holds. The projection is checked
// against it, because the daemon evaluates before it folds: a reviewer opening a
// thread on the SAME head leaves the projection fresh by every clock and a tick
// out of date in content, and the head check cannot see that.
const liveOf = (total, unresolved) => ({ readable: true, total, unresolved, seen: total });

const dir = mkdtempSync(join(tmpdir(), "reeve-wire-"));
const db = open(join(dir, "s.db"));
noteHead(db, NWO, 1, HEAD_A, T);
noteHead(db, NWO, 1, HEAD_B, T + 500);

// One P1 (critical) and one minor, so the two directions are both reachable.
ingest(db, NWO, 1, [
  review(1, "codex", "**![P1 Badge](x)** a critical thing", HEAD_A, T),
  thread("PRRT_1", "codex", "**![P1 Badge](x)** a critical thing"),
  thread("PRRT_2", "codex", "| _🟡 Minor_ | a nit"),
], { at: T });
derivePr(db, NWO, 1, PROFILE, { at: T, head: HEAD_A });

// A verdict shaped as the watcher reads it: threads BLOCK, past the soft cap.
// Shaped exactly as the watcher reads one: clauses keyed by `id`, and a verdict
// state derived from them rather than asserted separately.
const cl = (id, state, detail = "") => ({ id, state, detail });
// DERIVED, not restated: the fourth copy of this set was the one that drifted.
const CLAUSES = CLAUSE_IDS;
const ev = rounds => {
  const clauses = CLAUSES.map(id => (id === "threads" ? cl(id, "BLOCK", "2 unresolved") : cl(id, "PASS")));
  return { pr: 1, head: HEAD_A, state: "open", rounds, checks: {},
           verdict: { state: "BLOCK", clauses, summary: "x" } };
};

// --- the facts arrive, and they are the derived ones --------------------------
{
  const f = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A, at: T + 100, live: liveOf(2, 2) });
  check(f.projection.readable === true, "the projection is readable at this head", JSON.stringify(f.projection));
  // WITHHELD, and for a written reason. The details are a tick old, because the
  // daemon folds after it evaluates, and the count cross-check below cannot see a
  // thread EDITED in place -- no total, resolved or open count moves. A worker
  // given a superseded excerpt acts on a withdrawn request; the empty list it
  // gets today at least makes it go and look. They arrive when the fold precedes
  // the evaluation, which is a change to the tick and not to this function.
  check(f.threadDetails === null,
    "the thread details are WITHHELD while the fold still runs after the evaluation",
    JSON.stringify(f.threadDetails));
  check(/edited in place/.test(String(f.projection.detailsUnknown)),
    "and say why, so the precondition is written down rather than remembered",
    JSON.stringify(f.projection));
  // With the fold ahead of the evaluation they are handed on, and that is the ONE
  // thing that flips: same projection, same everything else.
  const ordered = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A,
                                at: T + 100, live: liveOf(2, 2),
                                io: { foldPrecedesEvaluation: true } });
  check(Array.isArray(ordered.threadDetails) && ordered.threadDetails.length === 2,
    "control: once the fold precedes it, the details a worker is dispatched with arrive",
    JSON.stringify(ordered.threadDetails?.length));
  check(ordered.threadDetails[0].id && ordered.threadDetails[0].severity && ordered.threadDetails[0].path,
    "control: carrying what a follow-up issue or a fix would need",
    JSON.stringify(ordered.threadDetails?.[0]));
  check(f.rounds === 1,
    "and the DERIVED round count, which `judged.size` cannot produce past one for a single reviewer",
    String(f.rounds));
  // The count is deliberately still UNKNOWN, and for a written reason rather than
  // by the accident of a hard-coded null. The fold classifies severity for THREAD
  // rows only, so a P0 stated in a review body with no inline thread is invisible
  // -- and a zero missing a body-only critical would spill a P0, which is the one
  // outcome the standing ruling forbids outright.
  check(f.unspilledCritical === null,
    "but the critical COUNT stays unknown while a body-only finding could be missing from it",
    JSON.stringify(f.unspilledCritical));
  check(/body/.test(String(f.projection.countUnknown)),
    "and it says WHY, so the next stage has a stated precondition rather than a mystery",
    JSON.stringify(f.projection));

}

// --- THE BRANCH THAT COULD NOT BE TAKEN --------------------------------------
{
  // With a critical open, SPILL must not fire -- the standing ruling is that
  // criticals escalate and are never moved to a follow-up.
  const withCritical = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A, at: T + 100, live: liveOf(2, 2) });
  const d1 = nextAction(ev({ n: 6, softCap: 5, hardCap: 10, unspilledCritical: withCritical.unspilledCritical }), PROFILE);
  check(d1.action !== ACTIONS.SPILL,
    "with a critical open, the wired count still refuses to spill", JSON.stringify(d1));

  // Clear the critical the way reality does -- the thread is resolved and a later
  // round covers this head -- and the same chain now reaches SPILL. Before this
  // wire, no input to the product could produce that: the count was null forever.
  // Cleared the way reality clears it: the thread is resolved AND a later
  // substantive round by the same reviewer has been and gone at this head.
  // Resolution alone is a CLAIM -- the bot resolves its own threads -- so the
  // later round is what makes it evidence, and leaving it out is why the first
  // version of this block still measured one critical.
  // In TWO steps, and the order is the rule rather than fixture noise.
  // `resolved_at` is when reeve first SAW the thread claim to be resolved, and
  // clearing needs a round strictly later than that. Ingesting both at one instant
  // leaves the round simultaneous rather than later, and nothing clears -- which
  // is exactly what the first version of this block did, and it read as the wire
  // being broken rather than the fixture being wrong.
  ingest(db, NWO, 1, [thread("PRRT_1", "codex", "**![P1 Badge](x)** a critical thing", true)], { at: T + 600 });
  ingest(db, NWO, 1, [review(2, "codex", "| _🟡 Minor_ | one nit left", HEAD_A, T + 700)], { at: T + 700 });
  derivePr(db, NWO, 1, PROFILE, { at: T + 800, head: HEAD_A });
  const cleared = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A, at: T + 900, live: liveOf(2, 1) });
  check(cleared.unspilledCritical === null,
    "control: and it stays unknown even once the fold really has no criticals left",
    JSON.stringify({ c: cleared.unspilledCritical, readable: cleared.projection.readable }));

  // With the precondition MET -- a fold that has derived body findings -- the same
  // chain reaches SPILL. This is the one thing the flag gates, driven through an
  // injected projection that declares itself complete, so the day the fold learns
  // to classify bodies the behaviour here is what the product does.
  const complete = reviewFacts({
    db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A, at: T + 900, live: liveOf(2, 1),
    io: { reviewState: () => ({ readable: true, bodyFindingsDerived: true, total: 2, open: 1,
                                resolved: 1, unspilledCritical: 0, rounds: 6, threads: [] }) } });
  check(complete.unspilledCritical === 0,
    "with body findings derived, the count becomes a KNOWN zero", JSON.stringify(complete.unspilledCritical));
  const d2 = nextAction(ev({ n: 6, softCap: 5, hardCap: 10, unspilledCritical: complete.unspilledCritical }), PROFILE);
  check(d2.action === ACTIONS.SPILL,
    "and SPILL becomes reachable, which no input to the product could previously produce",
    JSON.stringify(d2));
}

// --- every way of not knowing stays UNKNOWN, never zero -----------------------
{
  // null is refusal and 0 is permission, so the difference is the whole safety
  // property. Each of these used to be a way for a caller to end up with the
  // convenient number rather than the honest one.
  const cases = [
    ["no state database at all", () => reviewFacts({ db: null, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A, at: T + 100, live: liveOf(2, 2) })],
    ["a projection derived for a DIFFERENT head", () => reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_B, at: T + 100, live: liveOf(2, 2) })],
    ["a pull request never derived", () => reviewFacts({ db, nwo: NWO, pr: 999, profile: PROFILE, head: HEAD_A, at: T + 100, live: liveOf(0, 0) })],
    ["a store that THROWS rather than answering", () => reviewFacts({
      db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A, at: T + 100,
      io: { reviewState: () => { throw new Error("database is locked"); } } })],
  ];
  for (const [what, run] of cases) {
    const f = run();
    check(f.unspilledCritical === null && f.threadDetails === null && f.projection.readable === false,
      `UNKNOWN, not zero: ${what}`, JSON.stringify(f));
    const d = nextAction(ev({ n: 6, softCap: 5, hardCap: 10, unspilledCritical: f.unspilledCritical }), PROFILE);
    check(d.action !== ACTIONS.SPILL, `control: and nothing spills on it — ${what}`, JSON.stringify(d.action));
  }
}

// --- an empty projection is not an unreadable one ----------------------------
{
  // "Nothing is open" and "reeve cannot say what is open" are different answers,
  // and a caller has to be able to tell them apart. A single nullable number
  // cannot carry both, which is why the details are null rather than [].
  const f = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A, at: T + 800,
                          live: liveOf(0, 0),
                          io: { foldPrecedesEvaluation: true,
                                reviewState: () => ({ readable: true, bodyFindingsDerived: true, total: 0,
                                                      open: 0, resolved: 0, unspilledCritical: 0,
                                                      rounds: 3, threads: [] }) } });
  check(f.unspilledCritical === 0 && Array.isArray(f.threadDetails) && f.threadDetails.length === 0,
    "a readable projection with nothing open is an empty LIST and a known zero",
    JSON.stringify(f));
}

// --- a projection that DISAGREES with the live read is not usable -------------
{
  // The staleness the head check cannot see, and the reason it cannot.
  //
  // The daemon evaluates a pull request before it observes, ingests and folds, so
  // the projection read during evaluation came from the PREVIOUS tick. When a
  // reviewer opens a thread on the SAME head -- the ordinary case -- the head
  // matches, every clock says fresh, and the content is a tick out of date. A
  // newly filed critical would sit behind a zero.
  //
  // The live read the evaluation already holds is the cross-check, through the
  // same `compare` the review shadow has been running against this projection for
  // days. The shadow was measuring exactly this while the decision path ignored it.
  const agreeing = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A,
                                 at: T + 900, live: liveOf(2, 1) });
  check(agreeing.projection.readable === true,
    "control: a projection that agrees with the live read is usable", JSON.stringify(agreeing.projection));

  // One more thread exists live than the projection knows about: exactly what a
  // reviewer filing a finding between the fold and this tick looks like.
  const behind = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A,
                               at: T + 900, live: liveOf(3, 2) });
  check(behind.projection.readable === false && behind.unspilledCritical === null,
    "a projection the live read has moved past is UNKNOWN, however fresh its clock",
    JSON.stringify(behind.projection));
  check(/disagrees/.test(String(behind.projection.why)),
    "and says so, rather than reporting an absence", JSON.stringify(behind.projection.why));

  // Same head, same thread count, different resolution: the shape a bot
  // self-resolving a thread produces, which is a claim rather than evidence.
  const resolvedDiff = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A,
                                     at: T + 900, live: liveOf(2, 2) });
  check(resolvedDiff.projection.readable === false,
    "and so is one whose resolved count the live read contradicts", JSON.stringify(resolvedDiff.projection));

  // A live read that could not answer is not agreement. It is another way of not
  // knowing, and the honest answer to not knowing is the same as everywhere else.
  const blind = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A,
                              at: T + 900, live: { readable: false, why: "truncated" } });
  check(blind.projection.readable === false && blind.unspilledCritical === null,
    "an unreadable live read is not agreement either", JSON.stringify(blind.projection));
}

// --- uncleared threads, scoped to whose silence counts -----------------------
{
  // "Resolved" and "cleared" answer different questions. Resolved is a CLAIM --
  // the bot resolves its own threads, and `@coderabbitai resolve` is
  // author-invokable and bulk-resolves -- so a critical finding can leave the
  // verdict by being dismissed by the thing that filed it. Cleared is EVIDENCE.
  //
  // The scoping is the part that needed thought rather than the counting. An
  // advisory reviewer that files a thread and never returns leaves it uncleared
  // FOREVER, so gating on every reviewer would block every pull request
  // permanently the first time one went quiet. Blocking-ness is what says whose
  // silence counts, and it is the same rule the review clause already applies.
  // The store has moved on by this point in the file: an earlier block resolved
  // one thread and gave the reviewer a later round, so one is cleared and one is
  // not. The live read has to describe THAT moment -- the projection is checked
  // against it, and a live read from an earlier moment reads as disagreement,
  // which is the cross-check working rather than the fixture being right.
  const f = reviewFacts({ db, nwo: NWO, pr: 1, profile: PROFILE, head: HEAD_A,
                          at: T + 900, live: liveOf(2, 1), io: { foldPrecedesEvaluation: true } });
  check(f.cleared.readable === true, "control: the projection is usable", JSON.stringify(f.cleared));
  check(f.cleared.uncleared === 1,
    "the blocking reviewer's uncleared thread is counted, and the cleared one is not",
    JSON.stringify(f.cleared));
  check(f.cleared.reviewers.includes("codex"),
    "and the reviewer is named, because a person needs to know WHO has not returned",
    JSON.stringify(f.cleared.reviewers));

  // An ADVISORY reviewer's threads do not gate. Same store, same threads, one
  // word changed in the profile.
  const advisory = { ...PROFILE, reviewers: PROFILE.reviewers.map(r => ({ ...r, kind: "advisory" })) };
  // RE-DERIVED under that profile, and it has to be. A reviewer's kind is part of
  // the classifier version, so reading the old projection with a changed profile
  // is UNKNOWN rather than a different answer -- which is correct, and would have
  // made this control pass for the wrong reason had I not looked at the `why`.
  derivePr(db, NWO, 1, advisory, { at: T + 900, head: HEAD_A });
  const g = reviewFacts({ db, nwo: NWO, pr: 1, profile: advisory, head: HEAD_A,
                          at: T + 950, live: liveOf(2, 1), io: { foldPrecedesEvaluation: true } });
  check(g.cleared.readable === true && g.cleared.uncleared === 0,
    "an advisory reviewer's uncleared threads do not gate, so going quiet cannot block forever",
    JSON.stringify(g.cleared));

  // And an unusable projection is UNKNOWN here too, never zero.
  // NOBODY TO GATE means nothing to be unknown about. With no blocking reviewer,
  // an unusable projection must NOT make the clearance clause unknown -- there is
  // nothing it could hold up, and an UNKNOWN there would stop an otherwise
  // passing pull request on a transient failure. The scoping has to apply to the
  // unreadable path too, or it is only half applied.
  const noneBlocking = { ...PROFILE, reviewers: PROFILE.reviewers.map(r => ({ ...r, kind: "advisory" })) };
  const nb = reviewFacts({ db, nwo: NWO, pr: 999, profile: noneBlocking, head: HEAD_A,
                           at: T + 900, live: liveOf(0, 0), io: { foldPrecedesEvaluation: true } });
  check(nb.projection.readable === false,
    "control: the projection really is unusable here", JSON.stringify(nb.projection.why));
  check(nb.cleared.readable === true && nb.cleared.uncleared === 0,
    "and with no blocking reviewer the clearance clause is satisfied rather than unknown",
    JSON.stringify(nb.cleared));

  derivePr(db, NWO, 1, PROFILE, { at: T + 960, head: HEAD_A });   // restore for anything after
  const blind = reviewFacts({ db, nwo: NWO, pr: 999, profile: PROFILE, head: HEAD_A,
                              at: T + 900, live: liveOf(0, 0), io: { foldPrecedesEvaluation: true } });
  check(blind.cleared.readable === false,
    "an unusable projection cannot say what is uncleared, and says so", JSON.stringify(blind.cleared));
}

// --- and the EVALUATION is actually wired to it ------------------------------
{
  // Everything above proves the seam works. None of it proves the product uses
  // it, and that gap is not hypothetical: stubbing `unspilledCritical` back to a
  // hard-coded null in `evaluatePr` left every assertion in this file GREEN,
  // because they all call `reviewFacts` directly. A working seam nothing is
  // plugged into is precisely the state this whole change exists to end -- the
  // projection worked for weeks and reached no decision.
  //
  // `evaluatePr` reaches GitHub half a dozen times before it gets here, so this is
  // checked over the SOURCE rather than by mocking six API calls. Mechanical, and
  // narrow enough to be honest: the two fields must come from the facts, and the
  // literal that made them unreachable must not come back.
  const src = readFileSync(new URL("../src/pr.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function evaluatePr"));

  check(/unspilledCritical:\s*facts\.unspilledCritical/.test(body),
    "evaluatePr takes its critical count from the projection, not from a literal", "");
  check(/threadDetails:\s*facts\.threadDetails/.test(body),
    "and hands on whatever the projection permits as thread details", "");
  check(/n:\s*facts\.rounds\s*\?\?/.test(body),
    "and prefers the DERIVED round count, without which every cap decision is unreachable", "");
  check(/live:\s*threads/.test(body),
    "and hands the live read in, so the projection can be checked against it", "");
  check(!/unspilledCritical:\s*(null|0)\b/.test(body),
    "and no literal count survives anywhere in it",
    (body.match(/unspilledCritical:.*/g) ?? []).join(" | "));

  // Controls, in both directions: the scan must find a literal when one is there,
  // and must not be satisfied by a file that simply stopped mentioning the field.
  check(/unspilledCritical:\s*(null|0)\b/.test("const r = { unspilledCritical: null };"),
    "control: the literal scan recognises a hard-coded count", "");
  check(!/unspilledCritical:\s*facts\.unspilledCritical/.test("const r = { unspilledCritical: x };"),
    "control: and the wire scan is not satisfied by any other source", "");
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
