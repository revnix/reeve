// Findings stated in a review BODY, which have no inline thread of their own.
//
// The fold read severity from thread rows only, so a P0 written in a review's
// summary text was invisible to it. That is why `unspilledCritical` was declared
// unusable, and an unusable critical count is what kept both the round cap and
// SPILL inert: a known zero is the only thing that licenses spilling, and the
// standing ruling is that a critical is never spilled.
//
// Three properties carry the weight here, and each one is a way the obvious
// implementation goes wrong:
//
//   Severity is read from the FINDING, not the body. Markers are first-match-wins,
//   so classifying the whole body files every finding in it under whichever
//   severity appeared first — a P1 below a P2 would be recorded as major.
//
//   The thread counts must not move. `compare` measures total/open/resolved
//   against a LIVE read of GitHub's review threads. A body finding counted among
//   them is a disagreement that can never resolve, and a permanent disagreement
//   turns every downstream answer UNKNOWN — taking the whole review path dark in
//   order to add a number.
//
//   Completeness is decided per pull request against what was POSTED, not against
//   the roster. A fully configured profile still misses a body finding from a
//   reviewer nobody rostered, and a roster check reports complete for exactly
//   that pull request.
import { derivePr, reviewState, bodyFindingsOf, BLOCKING_SEVERITIES } from "../src/review/derive.mjs";
import { ingest, noteHead } from "../src/review/ingest.mjs";
import { compare } from "../src/review/shadow.mjs";
import { reviewFacts, readReviewerStates, readThreads } from "../src/pr.mjs";
import { fixFindingsPrompt, spillPrompt } from "../src/prompts.mjs";
import { dispatchable, findingsFingerprint, attemptKey } from "../src/daemon.mjs";
import { validate, withDefaults } from "../src/profile/schema.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "o/r";
const T = 1_800_000_000;
const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);

// Codex's real shape: every finding opens with a severity badge, so the badge is
// the delimiter. Measured on this repository's own pull requests.
const BADGE = "!\\[P\\d Badge\\]";
const codexReviewer = (over = {}) => ({
  login: "codex", kind: "blocking", refusal: "reached your Codex usage limits",
  clean: "Didn't find any major issues",
  commitPattern: "Reviewed commit:\\**\\s*`?([0-9a-f]{7,40})`?",
  severityMarkers: [["!\\[P1 Badge\\]", "critical"], ["!\\[P2 Badge\\]", "major"]],
  bodyFindings: BADGE, ...over,
});
const PROFILE = (over = {}) => ({
  watch: { staleSeconds: 900 },
  reviewers: [codexReviewer(), { login: "crab", kind: "advisory", refusal: "Review rate limited",
                                 bodyFindings: false }],
  ...over,
});

const review = (id, author, body, head, at, state = "COMMENTED") => ({
  source: author, external_id: `review:${id}`, kind: "review",
  head_sha: head, event_at: at, edited_at: null,
  payload: { login: author, state, commit_id: head, body },
});
const thread = (id, author, body, over = {}) => ({
  source: author, external_id: `thread:${id}`, kind: "review_thread",
  head_sha: null, event_at: T, edited_at: null,
  payload: { thread_id: id, author, body, is_resolved: false, is_outdated: false,
             resolved_by: null, path: "a.ts", line: 7, ...over },
});

const BODY_TWO =
  "Reviewed commit: `aaaaaaa`\n\nSome preamble that is not a finding at all.\n\n" +
  "**![P2 Badge](x) Rename this variable**\n\nIt reads badly.\n\n" +
  "**![P1 Badge](x) This drops a transaction**\n\nThe write is lost on rollback.\n";

// ── the splitter ─────────────────────────────────────────────────────────────
{
  const r = bodyFindingsOf(BODY_TWO, BADGE);
  check(r.readable === true && r.findings.length === 2,
    "a body with two badges yields two findings", JSON.stringify(r.findings.length));
  check(/P2 Badge/.test(r.findings[0]) && /reads badly/.test(r.findings[0]),
    "each finding runs from its badge to the next one, carrying its own text", r.findings[0]);
  check(!/preamble/.test(r.findings.join(" ")),
    "prose BEFORE the first badge is not a finding — codex opens with a summary");
  check(bodyFindingsOf(BODY_TWO, undefined).readable === false,
    "no declaration is UNREADABLE, which is not the same as 'this reviewer had no findings'");

  // A ZERO-WIDTH pattern need not match the empty string. A lookahead returns
  // false for test("") and so passes profile validation, then produces nothing but
  // zero-length matches against a real body. Dropping them silently turned a blind
  // read into a confident zero, which is the one answer that licenses a spill.
  const look = bodyFindingsOf(BODY_TWO, "(?=!\\[P\\d Badge\\])");
  check(look.readable === false && look.findings.length === 0,
    "a zero-width pattern reports UNREADABLE rather than a confident zero",
    JSON.stringify(look));
  check(new RegExp("(?=!\\[P\\d Badge\\])", "g").test("") === false,
    "control: and that pattern really does pass an empty-string check, which is why the fold has to catch it");

  check(!/q/i.test(BODY_TWO), "control: the fixture contains no `q`, so `q*` can only match empty");
  // MIXED WIDTH is the harder case, and the first fix made it worse rather than
  // catching it. Requiring EVERY match to be zero-width meant an alternation with
  // one zero-width branch kept the body "readable": the zero-width match is
  // dropped, the full-width one survives, and the finding the dropped match should
  // have started is swallowed into the text above it. One finding silently gone,
  // and a confident count over what is left.
  {
    const mixed = "pre\n**![P2 Badge](x) two** text\n**![P1 Badge](x) one** more";
    const r2 = bodyFindingsOf(mixed, "(?=!\\[P2 Badge\\])|!\\[P\\d Badge\\]");
    check(r2.readable === false && r2.findings.length === 0,
      "a delimiter with ANY zero-width match is unreadable, not partly readable",
      JSON.stringify(r2));
    check(bodyFindingsOf(mixed, BADGE).findings.length === 2,
      "control: the same body under a wholly full-width delimiter yields both findings",
      JSON.stringify(bodyFindingsOf(mixed, BADGE).findings.length));
  }
  check(bodyFindingsOf(BODY_TWO, "q*").readable === false,
    "a pattern that can only match the empty string is unreadable too, not one finding per character",
    JSON.stringify(bodyFindingsOf(BODY_TWO, "q*")));
  check(bodyFindingsOf("", BADGE).findings.length === 0, "control: an empty body yields nothing");
}

// ── the fold ─────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "reeve-body-"));
const db = open(join(dir, "s.db"));
noteHead(db, NWO, 1, HEAD_A, T);
noteHead(db, NWO, 1, HEAD_B, T + 500);
ingest(db, NWO, 1, [
  review(1, "codex", BODY_TWO, HEAD_A, T),
  thread("PRRT_1", "codex", "**![P2 Badge](x)** a thread finding"),
], { at: T });

{
  const p = PROFILE();
  const r = derivePr(db, NWO, 1, p, { at: T, head: HEAD_A });
  check(r.bodyFindings === 2, "control: the fold derived both body findings", JSON.stringify(r));

  const st = reviewState(db, NWO, 1, p, { at: T, head: HEAD_A });
  check(st.readable === true, "control: the projection is readable", JSON.stringify(st.why ?? ""));

  // Severity per FINDING. Both live in one body, and first-match-wins over the
  // whole body would file the P1 as major because the P2 appears above it.
  const sev = st.threads.filter(t => t.anchor === "body").map(t => t.severity).sort();
  check(JSON.stringify(sev) === JSON.stringify(["critical", "major"]),
    "each finding is classified by its OWN text, not by the body it arrived in",
    JSON.stringify(sev));

  check(st.bodyFindingsDerived === true,
    "with every reviewer that wrote a body having declared how, the count can be complete");

  // The count the whole capability waits on: one thread P2 (major, not blocking)
  // plus one body P1 (critical).
  check(st.unspilledCritical === 1,
    "the body-only critical reaches the count that licenses a spill", String(st.unspilledCritical));

  // THE COMPARE-SAFETY PROPERTY. One thread exists; two body findings do. If the
  // body findings had been folded into these, the live cross-check would disagree
  // forever and every answer downstream would be UNKNOWN.
  check(st.total === 1 && st.open === 1 && st.resolved === 0,
    "thread counts stay THREAD counts however many body findings there are",
    `total=${st.total} open=${st.open} resolved=${st.resolved}`);
  const agreement = compare({ readable: true, total: 1, unresolved: 1 }, { ...st, readable: true });
  check(agreement.comparable && agreement.agree,
    "so the live thread read still agrees with the projection", agreement.why ?? "");

  check(st.bodyOpen === 2 && st.bodyTotal === 2,
    "and the body population is reported on its own", `${st.bodyOpen}/${st.bodyTotal}`);
  check(st.threads.filter(t => t.anchor === "thread").length === 1 &&
        st.threads.filter(t => t.anchor === "body").length === 2,
    "one list, with every item saying which kind it is");
}

// ── clearing: the founder's rule of 2026-08-27 ───────────────────────────────
{
  const p = PROFILE();
  // The round that FILED them is not a later round.
  derivePr(db, NWO, 1, p, { at: T, head: HEAD_A });
  let st = reviewState(db, NWO, 1, p, { at: T, head: HEAD_A });
  check(st.bodyOpen === 2, "the round that filed a body finding does not clear it", String(st.bodyOpen));

  // A round by a DIFFERENT reviewer is not this reviewer looking again.
  ingest(db, NWO, 1, [review(2, "crab", "crab had a look", HEAD_A, T + 100)], { at: T + 100 });
  derivePr(db, NWO, 1, p, { at: T + 100, head: HEAD_A });
  st = reviewState(db, NWO, 1, p, { at: T + 100, head: HEAD_A });
  check(st.bodyOpen === 2, "nor does a round by a different reviewer", String(st.bodyOpen));

  // A later round by the SAME reviewer at the SAME head is exactly the rule.
  ingest(db, NWO, 1, [review(3, "codex", "**![P2 Badge](x) something else**", HEAD_A, T + 200)], { at: T + 200 });
  derivePr(db, NWO, 1, p, { at: T + 200, head: HEAD_A });
  st = reviewState(db, NWO, 1, p, { at: T + 200, head: HEAD_A });
  check(st.bodyOpen === 1,
    "the same reviewer reviewing this same revision again clears the earlier findings",
    `${st.bodyOpen} still open`);
  check(st.threads.some(t => t.anchor === "body" && /something else/.test(t.excerpt)),
    "and the round that cleared them left its OWN finding open");

  // The same rounds judged at a DIFFERENT head clear nothing: nobody has reviewed
  // that revision, so nothing about it has been confirmed.
  derivePr(db, NWO, 1, p, { at: T + 300, head: HEAD_B });
  st = reviewState(db, NWO, 1, p, { at: T + 300, head: HEAD_B });
  check(st.bodyOpen === 3, "a push un-clears every body finding until the reviewer answers again",
    String(st.bodyOpen));
  derivePr(db, NWO, 1, p, { at: T + 200, head: HEAD_A });   // restore for the blocks below
}

// ── a finding ADDED BY AN EDIT is not cleared by a round that predates it ────
//
// CodeRabbit rewrites its own bodies in place, and an edit keeps the original
// `submitted_at`. Ordering the fold by that timestamp meant a finding added later
// inherited the position of the review it was added to — so a round that had
// already happened cleared text that did not exist when that round ran, and a
// newly added P0 could leave the count without anyone having looked at it.
{
  const dir5 = mkdtempSync(join(tmpdir(), "reeve-body5-"));
  const db5 = open(join(dir5, "s.db"));
  noteHead(db5, NWO, 5, HEAD_A, T);
  const p = PROFILE();
  const ONE = "**![P1 Badge](x) the first thing**\n\ndetail.";
  ingest(db5, NWO, 5, [review(1, "codex", ONE, HEAD_A, T)], { at: T });
  ingest(db5, NWO, 5, [review(2, "codex", "**![P2 Badge](x) a later round**", HEAD_A, T + 100)], { at: T + 100 });
  derivePr(db5, NWO, 5, p, { at: T + 150, head: HEAD_A });
  const before = reviewState(db5, NWO, 5, p, { at: T + 150, head: HEAD_A });
  check(before.bodyOpen === 1,
    "control: the later round clears the first body's finding, leaving only its own",
    String(before.bodyOpen));

  // The edit. Same review id, same submitted_at, new text, observed later.
  ingest(db5, NWO, 5, [review(1, "codex", ONE + "\n\n**![P1 Badge](x) added by an edit**", HEAD_A, T)],
         { at: T + 200 });
  derivePr(db5, NWO, 5, p, { at: T + 250, head: HEAD_A });
  const after = reviewState(db5, NWO, 5, p, { at: T + 250, head: HEAD_A });
  check(after.threads.some(t => t.anchor === "body" && /added by an edit/.test(t.excerpt)),
    "the finding added by the edit is open, not cleared by the round that preceded it",
    JSON.stringify(after.threads.filter(t => t.anchor === "body").map(t => t.excerpt.slice(0, 40))));
  check(after.unspilledCritical >= 1,
    "and it reaches the critical count, which is what an added P0 must do",
    String(after.unspilledCritical));

  // The conservative consequence, asserted so it is a decision rather than a
  // surprise: the whole edited body is judged by when its NEW text was seen, so
  // the finding that was already there re-opens too. The reviewer's later round
  // read a body that no longer exists, and saying so is the honest reading.
  check(after.threads.filter(t => t.anchor === "body" && /the first thing/.test(t.excerpt)).length === 1,
    "and the unchanged finding beside it re-opens too — the round read a body that has since changed");

  // Control: another round AFTER the edit clears both, so this is a delay and not
  // a wedge.
  ingest(db5, NWO, 5, [review(3, "codex", "looked again", HEAD_A, T + 300)], { at: T + 300 });
  derivePr(db5, NWO, 5, p, { at: T + 350, head: HEAD_A });
  const done = reviewState(db5, NWO, 5, p, { at: T + 350, head: HEAD_A });
  check(done.bodyOpen === 0,
    "control: a round after the edit clears them, so the rule delays rather than wedges",
    String(done.bodyOpen));
  rmSync(dir5, { recursive: true, force: true });
}

// ── history ingested in ONE batch still clears ───────────────────────────────
//
// When reeve first watches an existing pull request it ingests all of its history
// at once, so every historical review shares one `observed_at` of now. Taking
// that as when the text arrived made no historical round later than any
// historical finding, so every old body finding stayed open until some future
// review arrived — on a pull request whose reviewers had long since finished.
// A first generation's text arrived WITH its review; only an edit arrives later.
{
  const dir6 = mkdtempSync(join(tmpdir(), "reeve-body6-"));
  const db6 = open(join(dir6, "s.db"));
  noteHead(db6, NWO, 6, HEAD_A, T);
  const p = PROFILE();
  // Both reviews are historical, and both are seen for the first time NOW.
  ingest(db6, NWO, 6, [
    review(1, "codex", "**![P1 Badge](x) an old finding**", HEAD_A, T),
    review(2, "codex", "looked again and it is fine", HEAD_A, T + 100),
  ], { at: T + 100000 });
  derivePr(db6, NWO, 6, p, { at: T + 100000, head: HEAD_A });
  const st = reviewState(db6, NWO, 6, p, { at: T + 100000, head: HEAD_A });
  check(st.bodyOpen === 0,
    "a later historical round clears an earlier historical finding, though both were first seen at once",
    JSON.stringify({ open: st.bodyOpen, total: st.bodyTotal }));
  check(st.bodyTotal === 1,
    "control: the finding was really derived, so this is clearing and not a failure to read it",
    String(st.bodyTotal));
  rmSync(dir6, { recursive: true, force: true });
}

// ── a DISMISSED review's findings are not recreated ──────────────────────────
//
// Dismissing is a maintainer saying that review no longer counts. Recreating its
// findings would put a worker to work implementing feedback somebody explicitly
// discarded, and no later round can clear them, because a dismissal is not a
// round.
{
  const dir7 = mkdtempSync(join(tmpdir(), "reeve-body7-"));
  const db7 = open(join(dir7, "s.db"));
  noteHead(db7, NWO, 7, HEAD_A, T);
  const p = PROFILE();
  ingest(db7, NWO, 7, [review(1, "codex", BODY_TWO, HEAD_A, T, "DISMISSED")], { at: T });
  derivePr(db7, NWO, 7, p, { at: T, head: HEAD_A });
  const st = reviewState(db7, NWO, 7, p, { at: T, head: HEAD_A });
  check(st.bodyTotal === 0, "a dismissed review contributes no body findings", String(st.bodyTotal));
  check(st.unreadableBodies.length === 0,
    "and no unreadable sentinel either — a dismissed body is not an unread one",
    JSON.stringify(st.unreadableBodies));

  // Control: the identical body on a live review DOES produce them, so the
  // assertion above is about the dismissal and not about the fixture.
  const dir8 = mkdtempSync(join(tmpdir(), "reeve-body8-"));
  const db8 = open(join(dir8, "s.db"));
  noteHead(db8, NWO, 8, HEAD_A, T);
  ingest(db8, NWO, 8, [review(1, "codex", BODY_TWO, HEAD_A, T)], { at: T });
  derivePr(db8, NWO, 8, p, { at: T, head: HEAD_A });
  check(reviewState(db8, NWO, 8, p, { at: T, head: HEAD_A }).bodyTotal === 2,
    "control: the same body on a live review yields both findings");
  rmSync(dir7, { recursive: true, force: true });
  rmSync(dir8, { recursive: true, force: true });
}

// ── the two critical counts are derived differently, not just read differently ──
//
// The clause tests inject these numbers, so they prove the verdict READS them
// correctly and nothing about whether `reviewState` COMPUTES them correctly. This
// is the half that was missing: unscoping the blocking count changed no test.
{
  const dirE = mkdtempSync(join(tmpdir(), "reeve-bodyE-"));
  const dbE = open(join(dirE, "s.db"));
  noteHead(dbE, NWO, 14, HEAD_A, T);
  const p = PROFILE();   // codex is blocking; crab is advisory
  ingest(dbE, NWO, 14, [
    thread("PRRT_X", "codex", "**![P1 Badge](x)** a blocking reviewer's critical"),
    thread("PRRT_Y", "crab", "an advisory reviewer's finding nobody can classify"),
  ], { at: T });
  derivePr(dbE, NWO, 14, p, { at: T, head: HEAD_A });
  const st = reviewState(dbE, NWO, 14, p, { at: T, head: HEAD_A });
  check(st.unspilledCritical === 2,
    "the universal count sees BOTH — a critical is never spilled whoever filed it",
    String(st.unspilledCritical));
  check(st.blockingCritical === 1,
    "while the blocking count sees only the reviewer whose opinion gates a merge",
    String(st.blockingCritical));
  check(st.unspilledCritical !== st.blockingCritical,
    "control: and they DIFFER here, so this fixture can tell the two apart at all");
  rmSync(dirE, { recursive: true, force: true });
}

// ── a body reverted to earlier text is read as earlier text ─────────────────
//
// The inbox is content-addressed, so re-polling unchanged data writes nothing.
// That is right for storage and wrong as an answer to "what does this object say
// now": a body edited A -> B -> A matches A's stored hash on the third
// observation, nothing is written, and MAX(generation) still points at B. The
// fold then reads text the reviewer has already taken back, and a finding
// restored by the revert is invisible while the pull request merges.
{
  const dirD = mkdtempSync(join(tmpdir(), "reeve-bodyD-"));
  const dbD = open(join(dirD, "s.db"));
  noteHead(dbD, NWO, 13, HEAD_A, T);
  const p = PROFILE();
  const A = "**![P1 Badge](x) a critical thing**\n\nit is broken.";
  const B = "on reflection, never mind";

  ingest(dbD, NWO, 13, [review(1, "codex", A, HEAD_A, T)], { at: T });
  derivePr(dbD, NWO, 13, p, { at: T + 10, head: HEAD_A });
  check(reviewState(dbD, NWO, 13, p, { at: T + 10, head: HEAD_A }).bodyTotal === 1,
    "control: the original body yields its finding");

  ingest(dbD, NWO, 13, [review(1, "codex", B, HEAD_A, T)], { at: T + 100 });
  derivePr(dbD, NWO, 13, p, { at: T + 110, head: HEAD_A });
  check(reviewState(dbD, NWO, 13, p, { at: T + 110, head: HEAD_A }).bodyTotal === 0,
    "control: the edit withdrawing it is honoured");

  // The revert. Byte-identical to A, so the content-addressed store holds it
  // already and writes nothing at all.
  const before = dbD.prepare("SELECT COUNT(*) c FROM inbox WHERE pr_number = 13").get().c;
  const r = ingest(dbD, NWO, 13, [review(1, "codex", A, HEAD_A, T)], { at: T + 200 });
  const after = dbD.prepare("SELECT COUNT(*) c FROM inbox WHERE pr_number = 13").get().c;
  check(before === after && r.unchanged === 1,
    "control: the revert really is de-duplicated — no row is written for it",
    JSON.stringify({ before, after, r }));

  derivePr(dbD, NWO, 13, p, { at: T + 210, head: HEAD_A });
  const back = reviewState(dbD, NWO, 13, p, { at: T + 210, head: HEAD_A });
  check(back.bodyTotal === 1,
    "and the restored finding is read again, though nothing was stored for the revert",
    JSON.stringify({ total: back.bodyTotal }));
  check(back.unspilledCritical >= 1,
    "so a P0 taken back and then restored reaches the count", String(back.unspilledCritical));
  rmSync(dirD, { recursive: true, force: true });
}

// ── a DISMISSED review clears nothing, not even other reviews' findings ──────
//
// Suppressing only its OWN findings left it clearing everyone else's: dismiss a
// review and the earlier findings it was never about quietly went away. A
// maintainer saying a review no longer counts is not that reviewer having looked
// again.
{
  const dir9 = mkdtempSync(join(tmpdir(), "reeve-body9-"));
  const db9 = open(join(dir9, "s.db"));
  noteHead(db9, NWO, 9, HEAD_A, T);
  const p = PROFILE();
  ingest(db9, NWO, 9, [
    review(1, "codex", "**![P1 Badge](x) an earlier finding**", HEAD_A, T),
    review(2, "codex", "a later look", HEAD_A, T + 100, "DISMISSED"),
  ], { at: T });
  derivePr(db9, NWO, 9, p, { at: T + 200, head: HEAD_A });
  check(reviewState(db9, NWO, 9, p, { at: T + 200, head: HEAD_A }).bodyOpen === 1,
    "a dismissed later review does not clear an earlier finding it was never about");

  // Control: the identical timeline with that review NOT dismissed does clear it,
  // so the assertion is about the dismissal and not about the timeline.
  const dirA = mkdtempSync(join(tmpdir(), "reeve-bodyA-"));
  const dbA = open(join(dirA, "s.db"));
  noteHead(dbA, NWO, 10, HEAD_A, T);
  ingest(dbA, NWO, 10, [
    review(1, "codex", "**![P1 Badge](x) an earlier finding**", HEAD_A, T),
    review(2, "codex", "a later look", HEAD_A, T + 100),
  ], { at: T });
  derivePr(dbA, NWO, 10, p, { at: T + 200, head: HEAD_A });
  check(reviewState(dbA, NWO, 10, p, { at: T + 200, head: HEAD_A }).bodyOpen === 0,
    "control: undismissed, the same later review clears it");
  rmSync(dir9, { recursive: true, force: true });
  rmSync(dirA, { recursive: true, force: true });
}

// ── two rounds in the same SECOND: the ordinal decides ───────────────────────
//
// For a first generation `seen_at` IS the review's own event_at, so a strict
// timestamp comparison rejects a later round sharing that second — the timestamp
// vetoing the tiebreak it was supposed to accompany. The comment claimed the
// ordinal still decided ties. It did not.
{
  const dirB = mkdtempSync(join(tmpdir(), "reeve-bodyB-"));
  const dbB = open(join(dirB, "s.db"));
  noteHead(dbB, NWO, 11, HEAD_A, T);
  const p = PROFILE();
  ingest(dbB, NWO, 11, [
    review(1, "codex", "**![P1 Badge](x) filed**", HEAD_A, T),
    review(2, "codex", "looked again in the same second", HEAD_A, T),
  ], { at: T });
  derivePr(dbB, NWO, 11, p, { at: T + 100, head: HEAD_A });
  check(reviewState(dbB, NWO, 11, p, { at: T + 100, head: HEAD_A }).bodyOpen === 0,
    "a later round sharing the filing second still clears, decided by the ordinal");
  rmSync(dirB, { recursive: true, force: true });
}

// ── a sentinel is never cleared by a round ───────────────────────────────────
//
// It does not say "this reviewer raised something"; it says reeve cannot parse
// this reviewer's bodies at all — a fact about the profile, not the pull request.
// Ordinary clearance let a later clean round retire it while reeve was exactly as
// unable to read as before, and since sentinels are minted only from review
// OBJECTS, that round created no replacement. The count fell to zero.
{
  const dirC = mkdtempSync(join(tmpdir(), "reeve-bodyC-"));
  const dbC = open(join(dirC, "s.db"));
  noteHead(dbC, NWO, 12, HEAD_A, T);
  // codex is blocking and configured, but with no bodyFindings declaration.
  const undeclared = PROFILE();
  undeclared.reviewers[0] = { ...undeclared.reviewers[0] };
  delete undeclared.reviewers[0].bodyFindings;
  ingest(dbC, NWO, 12, [review(1, "codex", "something I cannot parse", HEAD_A, T)], { at: T });
  derivePr(dbC, NWO, 12, undeclared, { at: T + 50, head: HEAD_A });
  check(reviewState(dbC, NWO, 12, undeclared, { at: T + 50, head: HEAD_A }).unreadableBodies.length === 1,
    "control: the unreadable body produced a sentinel");

  // A later round at the same head. Nothing about the profile has changed.
  ingest(dbC, NWO, 12, [review(2, "codex", "looked again", HEAD_A, T + 100)], { at: T + 100 });
  derivePr(dbC, NWO, 12, undeclared, { at: T + 150, head: HEAD_A });
  const after = reviewState(dbC, NWO, 12, undeclared, { at: T + 150, head: HEAD_A });
  // BOTH, and counting them is the point. The later round is itself an unreadable
  // body, so it mints a sentinel of its own — which means "at least one survives"
  // passes even when the first one has been wrongly cleared, satisfied by the
  // replacement rather than by the rule. Naming the specific one is what makes
  // this a measurement.
  check(after.unreadableBodies.length === 2,
    "a later round does not retire the earlier sentinel — reeve is exactly as unable to read as before",
    JSON.stringify(after.unreadableBodies.map(b => b.excerpt.slice(0, 40))));
  check(after.unreadableBodies.some(b => /cannot parse/.test(b.excerpt)),
    "and it is the ORIGINAL one still open, not merely its successor",
    JSON.stringify(after.unreadableBodies.map(b => b.excerpt.slice(-40))));
  check(after.unspilledCritical > 0,
    "so the count cannot fall to zero behind an unread body", String(after.unspilledCritical));

  // And it leaves the only way it should: by the reviewer being declared, which
  // changes the classifier version and re-derives without one.
  derivePr(dbC, NWO, 12, PROFILE(), { at: T + 200, head: HEAD_A });
  check(reviewState(dbC, NWO, 12, PROFILE(), { at: T + 200, head: HEAD_A }).unreadableBodies.length === 0,
    "control: declaring the reviewer is what retires it, which is the action the escalation asks for");
  rmSync(dirC, { recursive: true, force: true });
}

// ── the identity of a findings-repair problem is WHICH findings are open ────
{
  const A = [{ id: "t1" }, { id: "b1" }];
  const B = [{ id: "b1" }, { id: "t1" }];          // same set, other order
  const C = [{ id: "t1" }];                        // one repaired
  check(findingsFingerprint(A) === findingsFingerprint(B),
    "the order a projection happened to return does not change the identity",
    `${findingsFingerprint(A)} vs ${findingsFingerprint(B)}`);
  check(findingsFingerprint(A) !== findingsFingerprint(C),
    "but repairing one DOES — a smaller set is a different problem and earns its own budget");
  check(findingsFingerprint([]) === null && findingsFingerprint(null) === null,
    "and nothing open is not a problem to cap, so it has no identity at all");
  check(findingsFingerprint([{ id: "" }, { anchor: "body" }]) === null,
    "control: items with no usable id contribute nothing rather than an empty-string identity");

  // LEDGER BLOCKERS ARE PART OF THE PROBLEM'S IDENTITY. FIX_FINDINGS is selected
  // by the ledger clause too, and when a ledger blocker is the only reason there
  // are no review findings at all — so a key built from review threads alone was
  // null, nothing was recorded, and the brake never engaged for the one kind of
  // repair that changes no GitHub state.
  check(findingsFingerprint([], ["node:7"]) !== null,
    "a ledger-only repair has an identity, where before it had none");
  check(findingsFingerprint([], ["node:7"]) !== findingsFingerprint([], ["node:8"]),
    "and different blockers are a different problem");
  check(findingsFingerprint(A, ["node:7"]) !== findingsFingerprint(A),
    "control: the same review findings with a blocker are not the same problem without one");
  check(findingsFingerprint([], []) === null,
    "control: neither findings nor blockers is still nothing to cap");
}

// ── both ENDS of the live review cross-check, not just the comparison ───────
//
// `compare` is exercised with hand-built inputs, which proves it compares and
// nothing about whether either side reports what it compares. Stubbing each end
// out changed no test until these existed.
{
  // The LIVE end.
  const page = JSON.stringify({ data: { repository: { pullRequest: {
    mergeStateStatus: "CLEAN",
    reviews: { totalCount: 11 },
    reviewThreads: { totalCount: 2, pageInfo: { hasNextPage: false },
                     nodes: [{ isResolved: true }, { isResolved: false }] } } } } });
  const live = readThreads(NWO, 1, { gh: () => ({ ok: true, out: page }) });
  check(live.reviewTotal === 11,
    "the live read carries the review count it was asked for", JSON.stringify(live.reviewTotal));
  check(live.total === 2 && live.unresolved === 1,
    "control: and still carries the thread counts, so the surface was added not swapped",
    JSON.stringify({ total: live.total, unresolved: live.unresolved }));

  // The PROJECTION end.
  const dirF = mkdtempSync(join(tmpdir(), "reeve-bodyF-"));
  const dbF = open(join(dirF, "s.db"));
  noteHead(dbF, NWO, 15, HEAD_A, T);
  const p = PROFILE();
  ingest(dbF, NWO, 15, [
    review(1, "codex", "**![P2 Badge](x) one**", HEAD_A, T),
    review(2, "codex", "two", HEAD_A, T + 10),
    review(3, "crab", "three", HEAD_A, T + 20),
  ], { at: T });
  derivePr(dbF, NWO, 15, p, { at: T, head: HEAD_A });
  check(reviewState(dbF, NWO, 15, p, { at: T, head: HEAD_A }).reviewTotal === 3,
    "and the projection reports how many review objects it was derived from",
    String(reviewState(dbF, NWO, 15, p, { at: T, head: HEAD_A }).reviewTotal));

  // An EDIT is a new generation of the same review, not a fourth review. Counting
  // rows instead of distinct ids would report the edit as a new review and make
  // the two sides disagree for ever.
  ingest(dbF, NWO, 15, [review(2, "codex", "two, revised", HEAD_A, T + 10)], { at: T + 100 });
  derivePr(dbF, NWO, 15, p, { at: T + 110, head: HEAD_A });
  check(reviewState(dbF, NWO, 15, p, { at: T + 110, head: HEAD_A }).reviewTotal === 3,
    "control: an edit is a new generation of one review, not a fourth review",
    String(reviewState(dbF, NWO, 15, p, { at: T + 110, head: HEAD_A }).reviewTotal));
  rmSync(dirF, { recursive: true, force: true });
}

// ── what a decision spends, asked in one place ──────────────────────────────
//
// FIX_CI has had a budget since it was written and FIX_FINDINGS had none, and
// nothing in either call site said the other should exist. Asking the question in
// one function is what makes a missing answer visible.
{
  const items = [{ id: "t1" }, { id: "b1" }];
  check(attemptKey({ action: "FIX_CI" }, "ci:abc", items) === "ci:abc",
    "a CI repair spends its failure cause");
  check(attemptKey({ action: "FIX_FINDINGS" }, "ci:abc", items) === findingsFingerprint(items),
    "a findings repair spends the identity of the finding set, not the CI cause");
  check(attemptKey({ action: "MERGE" }, "ci:abc", items) === null,
    "and a decision that repairs nothing spends nothing");
  check(attemptKey({ action: "FIX_CI" }, null, items) === null,
    "control: a CI repair with no nameable cause spends nothing rather than a false key");
  check(attemptKey({ action: "FIX_FINDINGS" }, "ci:abc", []) === null,
    "control: nor does a findings repair with nothing open");
}

// ── a stale body finding is withheld from a MIXED dispatch ───────────────────
{
  const items = [{ id: "t1", anchor: "thread" }, { id: "b1", anchor: "body" }];
  check(dispatchable({ action: "FIX_FINDINGS", bodyFindings: false }, items).length === 1 &&
        dispatchable({ action: "FIX_FINDINGS", bodyFindings: false }, items)[0].anchor === "thread",
    "when the decision withheld body findings, the worker is sent only the thread",
    JSON.stringify(dispatchable({ action: "FIX_FINDINGS", bodyFindings: false }, items)));
  check(dispatchable({ action: "FIX_FINDINGS", bodyFindings: true }, items).length === 2,
    "control: when it did NOT withhold them, both travel");
  check(dispatchable({ bodyFindings: true }, null).length === 0,
    "control: an absent list is empty rather than a crash");
}

// ── completeness, decided against what was POSTED ────────────────────────────
{
  // A reviewer nobody rostered writes a review body. The roster is untouched and
  // fully declared, so a roster-based check reports complete for this very PR.
  const dir2 = mkdtempSync(join(tmpdir(), "reeve-body2-"));
  const db2 = open(join(dir2, "s.db"));
  noteHead(db2, NWO, 2, HEAD_A, T);
  ingest(db2, NWO, 2, [
    review(1, "codex", BODY_TWO, HEAD_A, T),
    review(2, "a-human", "I think this whole approach is wrong.", HEAD_A, T + 10),
  ], { at: T });
  const p = PROFILE();
  derivePr(db2, NWO, 2, p, { at: T, head: HEAD_A });
  const st = reviewState(db2, NWO, 2, p, { at: T, head: HEAD_A });
  check(st.bodyFindingsDerived === false,
    "an unrostered reviewer writing a body makes the count incomplete, however good the roster is");

  // AND THE IGNORANCE IS COUNTED, not withheld. Withholding was the silent option:
  // `computeVerdict` reads a null critical count as no reason to stop, so an
  // undeclared reviewer writing a P0 in a body left every clause passing and the
  // pull request mergeable. One `unknown` finding stands for the body instead, and
  // unknown blocks — the same answer this codebase already gives a thread whose
  // severity nobody can read.
  const sentinel = (st.unreadableBodies ?? []).find(b => /cannot read/.test(b.excerpt));
  check(!!sentinel, "an unreadable body is reported as its own fact", JSON.stringify(st.unreadableBodies));
  check(/a-human/.test(String(sentinel?.reviewer)),
    "attributed to the reviewer whose body could not be read", String(sentinel?.reviewer));
  check(/whole approach is wrong/.test(String(sentinel?.excerpt)),
    "and carrying the text, so a person can see what was said", String(sentinel?.excerpt).slice(0, 80));
  // And it is NOT in the list a worker is dispatched at. There is nothing in
  // "reeve cannot parse this reviewer" for a worker to do: no code is wrong, no
  // thread exists, and the fix is a line of profile only the operator can write.
  check(!st.threads.some(t => /cannot read/.test(t.excerpt)),
    "and it is kept OUT of the findings a worker is sent at, having nothing a worker could do",
    JSON.stringify(st.threads.map(t => t.anchor)));
  check(st.unspilledCritical > 0,
    "control: while still counting, so it cannot be spilled — routed apart, counted together",
    String(st.unspilledCritical));

  const facts = reviewFacts({
    db: db2, nwo: NWO, pr: 2, profile: p, head: HEAD_A, at: T,
    live: { readable: true, total: 0, unresolved: 0 },
  });
  check(facts.unspilledCritical > 0,
    "so the number reaches the decision path and is not zero — a spill cannot be licensed by a body nobody read",
    JSON.stringify(facts.unspilledCritical));

  // AND IT IS NOT SCOPED TO BLOCKING REVIEWERS, which is the whole difference
  // between this fact and the findings beside it. `a-human` is in no roster at
  // all. Blocking-ness answers whose OPINION gates a merge; this is not an
  // opinion, it is reeve reporting that it does not know what was said, and a
  // stranger's unread body is exactly as unread as a configured reviewer's.
  check(facts.unreadableBodies.readable === true && facts.unreadableBodies.open === 1,
    "an UNROSTERED author's unreadable body still reaches the decision path",
    JSON.stringify(facts.unreadableBodies));
  check(facts.unreadableBodies.reviewers.includes("a-human"),
    "and names them, because the fix is a line of profile describing that reviewer",
    JSON.stringify(facts.unreadableBodies.reviewers));
  // Control: the findings clause beside it IS scoped, so the two really are being
  // treated differently rather than both happening to include everyone.
  // Control: the findings clause beside it carries codex, who IS blocking, and not
  // `a-human`, who is not — so the two facts really are scoped differently rather
  // than both happening to include everyone.
  check(!facts.bodyFindings.reviewers.includes("a-human") && facts.bodyFindings.reviewers.includes("codex"),
    "control: while the findings clause stays scoped to blocking reviewers, so the two differ by design",
    JSON.stringify(facts.bodyFindings));

  // The mounted half: with every body author declared, the SAME call hands it on.
  const dir3 = mkdtempSync(join(tmpdir(), "reeve-body3-"));
  const db3 = open(join(dir3, "s.db"));
  noteHead(db3, NWO, 3, HEAD_A, T);
  ingest(db3, NWO, 3, [review(1, "codex", BODY_TWO, HEAD_A, T)], { at: T });
  derivePr(db3, NWO, 3, p, { at: T, head: HEAD_A });
  const ok = reviewFacts({
    db: db3, nwo: NWO, pr: 3, profile: p, head: HEAD_A, at: T,
    live: { readable: true, total: 0, unresolved: 0 },
  });
  check(ok.unspilledCritical === 1,
    "and hands on a real number once it can be complete — the seam is actually wired",
    JSON.stringify(ok.unspilledCritical));
  check(BLOCKING_SEVERITIES.has("unknown"),
    "control: an unreadable body finding would block, never be guessed as minor");
  rmSync(dir2, { recursive: true, force: true });
  rmSync(dir3, { recursive: true, force: true });
}

// ── a declared `false` is an ANSWER, not an omission ─────────────────────────
{
  const dir4 = mkdtempSync(join(tmpdir(), "reeve-body4-"));
  const db4 = open(join(dir4, "s.db"));
  noteHead(db4, NWO, 4, HEAD_A, T);
  // crab's body is a SUMMARY — its findings arrive as inline threads — and the
  // profile says so.
  ingest(db4, NWO, 4, [review(1, "crab", "Actionable comments posted: 2", HEAD_A, T)], { at: T });
  const st = (() => { derivePr(db4, NWO, 4, PROFILE(), { at: T, head: HEAD_A });
                      return reviewState(db4, NWO, 4, PROFILE(), { at: T, head: HEAD_A }); })();
  check(st.bodyFindingsDerived === true,
    "a reviewer declared as never stating findings in a body keeps the count complete");
  check(st.bodyTotal === 0, "and contributes none", String(st.bodyTotal));

  // Take the declaration away and nothing else changes: the same body, the same
  // reviewer, and the count stops being trustworthy.
  const undeclared = PROFILE();
  undeclared.reviewers[1] = { ...undeclared.reviewers[1] };
  delete undeclared.reviewers[1].bodyFindings;
  derivePr(db4, NWO, 4, undeclared, { at: T, head: HEAD_A });
  const st2 = reviewState(db4, NWO, 4, undeclared, { at: T, head: HEAD_A });
  check(st2.bodyFindingsDerived === false,
    "control: removing only the declaration flips it — the flag tracks the declaration, nothing else");
  rmSync(dir4, { recursive: true, force: true });
}

// ── what a worker is told ────────────────────────────────────────────────────
{
  const p = PROFILE();
  const st = reviewState(db, NWO, 1, p, { at: T + 200, head: HEAD_A });
  // Driven from a REAL projection rather than a hand-built shape. The prompt read
  // `t.body` while the projection has always supplied `excerpt`, so every prompt
  // built from real data rendered a numbered list of severities with no text —
  // and the test that proved the text appeared was passing a shape production
  // never produces.
  const fix = fixFindingsPrompt({ profile: p, nwo: NWO, pr: 1, head: HEAD_A,
                                  branch: "b", threads: st.threads });
  check(/a thread finding/.test(fix),
    "a prompt built from the real projection carries the finding's WORDS", fix.slice(0, 400));
  check(/stated in the review body, no thread/.test(fix),
    "and marks the ones with no thread behind them");

  // A CONTRACT A BODY FINDING CAN SATISFY. Labelling the item is not enough: the
  // prompt went on to require exactly one outcome, and every branch of it replied
  // on a thread. A worker that fixed a body finding could not report the fix
  // without inventing a thread, and the honest move left to it was to call the
  // whole run a failure or to say it needed a human.
  check(/FOR EACH FINDING WITH A THREAD/.test(fix),
    "the thread contract says which findings it governs");
  check(/there is no thread, so there\s+is nothing to reply to and nothing to resolve/.test(fix),
    "and a body finding gets branches it can actually satisfy");
  check(/do not treat\s+its absence as a reason to skip the finding or to fail the run/.test(fix),
    "and is told not to fail the run over the thread it will not find");

  const spill = spillPrompt({ profile: p, nwo: NWO, pr: 1, head: HEAD_A, findings: st.threads });
  check(/do not attempt to reply to it or resolve it/i.test(spill),
    "the spill instruction exempts them from a resolve that could only fail");
  // The issue-body requirement is the other half, and it was still absolute: every
  // entry had to carry a file, a line and a pinned permalink. A body finding has
  // none, so the worker could satisfy the contract only by fabricating an anchor.
  check(/for a finding that\s+names a file/.test(spill),
    "the issue-body requirement is conditional on the finding naming a file");
  check(/carry its text alone rather than inventing an anchor for it/.test(spill),
    "and says what to do instead, rather than leaving the worker to invent one");
  const bodyLine = spill.split("\n").find(l => /stated in the review body/.test(l));
  check(bodyLine && !/permalink/.test(bodyLine),
    "and no permalink is minted for a finding with no file or line", String(bodyLine));
  const threadLine = spill.split("\n").find(l => /a thread finding/.test(l));
  check(/permalink/.test(spill) && threadLine,
    "control: a thread finding still gets one, so the exemption is not just an empty prompt");
}

// ── the profile refuses what cannot mean anything ────────────────────────────
{
  const base = {
    schemaVersion: 1,
    project: { kind: "product" },
    identity: { key: NWO, defaultBranch: "main", visibility: "private" },
    authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "sidecar" },
    state: { mode: "in-repo" },
    units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm",
              commands: { test: { cmd: "pnpm test", state: "present" } } }],
    ci: { provider: "github-actions", requiredChecks: [] },
    merge: { method: "squash", enforcement: "enforced" },
    reviewers: [codexReviewer()],
  };
  const withBody = v => {
    const p = structuredClone(base);
    if (v === undefined) delete p.reviewers[0].bodyFindings; else p.reviewers[0].bodyFindings = v;
    return validate(withDefaults(p));
  };
  const refused = r => !r.ok && r.errors.some(e => /bodyFindings/.test(e));
  check(refused(withBody("x*")), "a pattern matching the empty string is refused at load",
    JSON.stringify(withBody("x*").errors));
  check(refused(withBody("([")), "so is one that does not compile",
    JSON.stringify(withBody("([").errors));
  check(withBody(BADGE).ok, "a real pattern is accepted", JSON.stringify(withBody(BADGE).errors));
  check(withBody(false).ok, "and so is `false`, which is a declaration",
    JSON.stringify(withBody(false).errors));
  check(withBody(undefined).ok,
    "an absent one is not an ERROR — it is a gap the fold records, not a bad profile",
    JSON.stringify(withBody(undefined).errors));
}

// ── the LIVE reviewer read asks GitHub for every page ───────────────────────
//
// `per_page=100` is a page size, not a promise that one page is all of it. Every
// inline reply mints a 0-byte COMMENTED review — nine at one commit on nextly
// #1124 — so review objects outrun real rounds by an order of magnitude and a
// busy pull request passes 100 easily. Measured on this repository's own #49:
// per_page=2 returns two rows unpaginated and every row with --paginate.
//
// Without it the fold could apply a current-head clean round from page two while
// this read still reported coverage as stale, so reeve would ask for a review it
// had already received and could never observe.
{
  const calls = [];
  const fakeGh = args => { calls.push(args); return { ok: true, out: "" }; };
  readReviewerStates(NWO, 1, HEAD_A, [codexReviewer()], { gh: fakeGh });
  check(calls.length === 2, "control: both live surfaces are read", String(calls.length));
  check(calls.every(a => a.includes("--paginate")),
    "and each asks GitHub for every page rather than the first hundred",
    JSON.stringify(calls.map(a => a[0])));
  check(calls.some(a => a.some(x => /pulls\/1\/reviews/.test(String(x)))) &&
        calls.some(a => a.some(x => /issues\/1\/comments/.test(String(x)))),
    "control: and they are the surfaces this is about, not some other call");
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
