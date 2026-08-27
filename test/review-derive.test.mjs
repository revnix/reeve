// PR-3: the fold from raw observations to what the gate reads.
//
// The rules under test all exist because a specific thing is true of the real
// reviewers, and each was got WRONG in a first draft of this code:
//
//   Resolution is a CLAIM. coderabbitai resolves its own threads — measured, 8 on
//   #1121 with nobody replying — and `@coderabbitai resolve` is author-invokable
//   and bulk-resolves. The first draft cleared four bot-self-resolved threads on
//   #1128 on the strength of a round three pushes old.
//
//   A round is a SUBSTANTIVE answer at a BOUND revision. Every inline reply mints
//   a 0-byte COMMENTED review — nine at one commit on #1124 — so counting review
//   objects overstates rounds by an order of magnitude.
//
//   Unknown severity BLOCKS. A finding nobody could read is the one not to gamble
//   on, and the founder ruling is that criticals are never spilled.
import {
  severityOf, classifierVersion, classifyObservation, derivePr, deriveSupply,
  reviewState, staleScopes, BLOCKING_SEVERITIES,
} from "../src/review/derive.mjs";
import { ingest, noteHead } from "../src/review/ingest.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "o/r";
const T = 1_800_000_000;
const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);

// The markers as MEASURED on nextly, not invented.
const PROFILE = {
  watch: { staleSeconds: 900 },
  reviewers: [
    { login: "codex", kind: "blocking", refusal: "reached your Codex usage limits",
      clean: "Didn't find any major issues", commitPattern: "Reviewed commit:\\**\\s*`?([0-9a-f]{7,40})`?",
      cleanReaction: "+1",
      severityMarkers: [["!\\[P1 Badge\\]", "critical"], ["!\\[P2 Badge\\]", "major"]] },
    { login: "crab", kind: "advisory", refusal: "Review rate limited",
      severityMarkers: [["\\| _🟠 Major_ \\|", "major"], ["\\| _🟡 Minor_ \\|", "minor"]] },
  ],
};

// ── severity ─────────────────────────────────────────────────────────────────
{
  const codex = PROFILE.reviewers[0].severityMarkers;
  check(severityOf("**![P1 Badge](x)** Fix this", codex) === "critical",
    "control: a measured P1 badge classifies as critical");
  check(severityOf("**![P2 Badge](x)** Consider", codex) === "major", "and P2 as major");
  check(severityOf("some finding with no marker at all", codex) === "unknown",
    "an unreadable finding is unknown, never guessed as minor");
  check(BLOCKING_SEVERITIES.has("unknown"),
    "and unknown BLOCKS — the founder ruling is that criticals are never spilled");
  check(BLOCKING_SEVERITIES.has("critical") && !BLOCKING_SEVERITIES.has("major"),
    "while major and below do not block on severity alone");

  // Order matters: first match wins, so a profile can put specific before general.
  const ordered = [["urgent security", "critical"], ["security", "minor"]];
  check(severityOf("an urgent security issue", ordered) === "critical",
    "the FIRST matching marker wins, so specific can precede general");
}

// ── the classifier version ───────────────────────────────────────────────────
{
  const a = classifierVersion(PROFILE);
  check(a === classifierVersion(PROFILE), "control: the version is stable for the same inputs", a);

  const changed = structuredClone(PROFILE);
  changed.reviewers[1].severityMarkers[0][0] = "\\| _🔴 Critical_ \\|";
  check(classifierVersion(changed) !== a,
    "changing a DETECTOR changes the version — which is what makes a taxonomy change reach history");

  const unrelated = structuredClone(PROFILE);
  unrelated.watch.staleSeconds = 60;
  check(classifierVersion(unrelated) === a,
    "while changing something that is not a detector does not churn every projection");
}

// ── one observation at a time ────────────────────────────────────────────────
{
  const codex = PROFILE.reviewers[0];
  const resolve = ab => (HEAD_A.startsWith(ab) ? HEAD_A : null);
  const c = (kind, payload) => classifyObservation({ kind, payload }, codex, resolve);

  check(c("review", { body: "", state: "COMMENTED", commit_id: HEAD_A }) === null,
    "a 0-byte review is a carrier for an inline reply, not a round");
  check(c("review", { body: "P1 finding", state: "COMMENTED", commit_id: HEAD_A })?.outcome === "findings",
    "a review with a body at a bound head is a round of findings");
  check(c("review", { body: "lgtm", state: "APPROVED", commit_id: HEAD_A })?.outcome === "clean",
    "APPROVED with a body is a clean round");
  check(c("review", { body: "changes needed", state: "CHANGES_REQUESTED", commit_id: HEAD_A })?.outcome === "findings",
    "and CHANGES_REQUESTED is findings, NOT 'covered and fine'");

  check(c("issue_comment", { body: "You have reached your Codex usage limits" })?.outcome === "refusal",
    "a refusal comment is a refusal");
  check(c("issue_comment", { body: "Didn't find any major issues. Reviewed commit: `aaaaaaaaaa`" })?.outcome === "clean",
    "a clean pass naming a head reeve pinned is clean");
  check(c("issue_comment", { body: "Didn't find any major issues. Reviewed commit: `ffffffffff`" })?.outcome === "unbound_clean",
    "one naming a head reeve never saw is UNBOUND — recorded, never coverage");
  check(c("issue_comment", { body: "please review @codex" }) === null,
    "and a trigger command is not a round at all");

  check(c("reaction", { content: "+1" })?.outcome === "unbound_clean",
    "Codex's push-triggered clean pass is a reaction, which binds to no revision");
  check(c("reaction", { content: "eyes" }) === null, "while its in-progress marker is not a round");
}

// ── the fold, over a real-shaped store ───────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "reeve-derive-"));
const db = open(join(dir, "s.db"));

const thread = (id, author, body, over = {}) => ({
  source: author, external_id: `thread:${id}`, kind: "review_thread",
  head_sha: null, event_at: T, edited_at: null,
  payload: { thread_id: id, author, body, is_resolved: false, is_outdated: false,
             resolved_by: null, path: "a.ts", line: 1, ...over },
});
const review = (id, author, body, head, at, state = "COMMENTED") => ({
  source: author, external_id: `review:${id}`, kind: "review",
  head_sha: head, event_at: at, edited_at: null,
  payload: { login: author, state, commit_id: head, body },
});

noteHead(db, NWO, 1, HEAD_A, T);
noteHead(db, NWO, 1, HEAD_B, T + 500);

ingest(db, NWO, 1, [
  review(1, "codex", "**![P1 Badge](x)** critical thing", HEAD_A, T),
  thread("PRRT_1", "codex", "**![P1 Badge](x)** critical thing"),
  thread("PRRT_2", "crab", "| _🟡 Minor_ | nit"),
  thread("PRRT_3", "crab", "a finding with no marker whatsoever"),
], { at: T });

{
  derivePr(db, NWO, 1, PROFILE, { at: T, head: HEAD_A });
  const st = reviewState(db, NWO, 1, PROFILE, { at: T });
  check(st.readable && st.total === 3, "control: three threads folded", JSON.stringify(st.total));
  // Three, not two. Two threads block -- the P1 and the one nobody can classify --
  // and codex also wrote a review BODY that this profile does not say how to read,
  // which the fold counts as one more finding of unknown severity rather than
  // leaving out. An unreadable body and an unreadable thread are the same
  // statement about different surfaces, so they get the same answer.
  check(st.unspilledCritical === 3,
    "the P1, the UNREADABLE thread and the UNREADABLE body all block — unknown counts as critical",
    `got ${st.unspilledCritical}`);
  check(st.bodyOpen === 1 && st.unreadableBodies.length === 1,
    "control: and the third really is the body, reported as its own kind",
    JSON.stringify({ bodyOpen: st.bodyOpen, unreadable: st.unreadableBodies.length }));
  check(st.rounds === 1, "one blocking reviewer answered once at one head", String(st.rounds));
}

// --- a projection answers only about the head it was derived FOR --------------
{
  // The check a caller is most likely to skip, because a projection derived for
  // the previous head looks perfectly fresh by every other measure.
  //
  // Clearing is head-dependent: `derivePr` decides `is_cleared` by asking whether
  // a round covers THIS head, so the same threads under a different head give a
  // different answer to "what is still open". The two facts that answer feeds --
  // how many criticals are open, and which threads they are -- are exactly the
  // ones that license spilling a finding or sending a worker at it.
  derivePr(db, NWO, 1, PROFILE, { at: T, head: HEAD_A });

  const atA = reviewState(db, NWO, 1, PROFILE, { at: T, head: HEAD_A });
  check(atA.readable === true, "a projection derived for this head is readable", JSON.stringify(atA.why ?? ""));
  check(atA.unspilledCritical === 3 && atA.threads.length === 3,
    "control: and carries the counts and the threads a decision needs",
    JSON.stringify({ c: atA.unspilledCritical, n: atA.threads?.length }));

  const atB = reviewState(db, NWO, 1, PROFILE, { at: T, head: HEAD_B });
  check(atB.readable === false,
    "the same projection is UNREADABLE for a different head, however fresh it is",
    JSON.stringify(atB));
  check(/derived for/.test(String(atB.why)) && atB.unspilledCritical === undefined,
    "and reports no counts at all, rather than counts about the wrong revision",
    JSON.stringify(atB));

  // A caller that names no head keeps the old behaviour. The shadow log compares
  // against a live read taken in the same tick and has no revision to assert.
  check(reviewState(db, NWO, 1, PROFILE, { at: T }).readable === true,
    "control: a caller that names no head is unaffected", "");

  // A projection written before the column existed records no head. That is
  // "we do not know which revision", which is unusable rather than a match.
  db.prepare("UPDATE projection_meta SET head=NULL WHERE nwo=? AND scope=?").run(NWO, "pr:1");
  const noHead = reviewState(db, NWO, 1, PROFILE, { at: T, head: HEAD_A });
  check(noHead.readable === false,
    "a projection that records no head is unreadable, not assumed to match",
    JSON.stringify(noHead));
  derivePr(db, NWO, 1, PROFILE, { at: T, head: HEAD_A });   // restore for later blocks
}

// ── resolution is a claim ────────────────────────────────────────────────────
{
  // crab resolves its OWN thread. Nothing else changes.
  ingest(db, NWO, 1, [thread("PRRT_2", "crab", "| _🟡 Minor_ | nit",
    { is_resolved: true, resolved_by: "crab[bot]" })], { at: T + 100 });
  derivePr(db, NWO, 1, PROFILE, { at: T + 100, head: HEAD_A });

  let t2 = db.prepare("SELECT * FROM review_thread WHERE thread_id='PRRT_2'").get();
  check(t2.is_resolved === 1 && t2.is_cleared === 0,
    "a thread the bot resolved itself is RESOLVED but not CLEARED", JSON.stringify(t2.is_cleared));

  // The round that FILED it cannot clear it, even at the right head.
  ingest(db, NWO, 1, [review(9, "crab", "| _🟡 Minor_ | nit", HEAD_A, T - 50)], { at: T + 100 });
  derivePr(db, NWO, 1, PROFILE, { at: T + 100, head: HEAD_A });
  t2 = db.prepare("SELECT * FROM review_thread WHERE thread_id='PRRT_2'").get();
  check(t2.is_cleared === 0,
    "a round from BEFORE the resolution cannot clear it — otherwise the filing round does",
    JSON.stringify(t2.is_cleared));

  // A LATER round by the same reviewer, at the head under judgement, clears it.
  ingest(db, NWO, 1, [review(10, "crab", "looked again", HEAD_A, T + 900)], { at: T + 1000 });
  derivePr(db, NWO, 1, PROFILE, { at: T + 1000, head: HEAD_A });
  t2 = db.prepare("SELECT * FROM review_thread WHERE thread_id='PRRT_2'").get();
  check(t2.is_cleared === 1,
    "a LATER round by the same reviewer at this head does clear it", JSON.stringify(t2.is_cleared));

  // A different reviewer's later round does not.
  ingest(db, NWO, 1, [thread("PRRT_3", "crab", "a finding with no marker whatsoever",
    { is_resolved: true, resolved_by: "someone" })], { at: T + 1100 });
  ingest(db, NWO, 1, [review(11, "codex", "unrelated", HEAD_A, T + 1200)], { at: T + 1300 });
  derivePr(db, NWO, 1, PROFILE, { at: T + 1300, head: HEAD_A });
  const t3 = db.prepare("SELECT * FROM review_thread WHERE thread_id='PRRT_3'").get();
  check(t3.is_cleared === 0,
    "another reviewer answering does not clear THIS reviewer's thread", JSON.stringify(t3.is_cleared));

  // And a new head un-clears everything: an unreviewed revision confirms nothing.
  derivePr(db, NWO, 1, PROFILE, { at: T + 1400, head: HEAD_B });
  const cleared = db.prepare("SELECT COUNT(*) n FROM review_thread WHERE pr=1 AND is_cleared=1").get().n;
  check(cleared === 0,
    "a push to an unreviewed head un-clears everything — nothing about it is confirmed",
    String(cleared));
}

// ── re-derivation is total and identical ─────────────────────────────────────
{
  const snap = () => createHash("sha256").update(JSON.stringify([
    db.prepare("SELECT * FROM review_round ORDER BY reviewer, source_id").all(),
    db.prepare("SELECT * FROM review_thread ORDER BY thread_id").all(),
  ])).digest("hex");

  derivePr(db, NWO, 1, PROFILE, { at: T + 1400, head: HEAD_A });
  const a = snap();
  db.exec("DELETE FROM review_round; DELETE FROM review_thread");
  derivePr(db, NWO, 1, PROFILE, { at: T + 1400, head: HEAD_A });
  check(snap() === a,
    "deleting every projection and re-folding reproduces it byte for byte");

  // Running it twice without deleting is also identical: a fold is not an append.
  derivePr(db, NWO, 1, PROFILE, { at: T + 1400, head: HEAD_A });
  check(snap() === a, "and folding twice does not duplicate a single row");
}

// ── staleness and version drift both refuse to answer ────────────────────────
{
  check(reviewState(db, NWO, 1, PROFILE, { at: T + 1400 }).readable === true,
    "control: a fresh projection is readable");
  check(reviewState(db, NWO, 1, PROFILE, { at: T + 99999 }).readable === false,
    "one older than staleSeconds is not — stale evidence answers UNKNOWN, never PASS");
  check(reviewState(db, NWO, 999, PROFILE, { at: T }).readable === false,
    "and a PR never folded is not readable either — absence is not an empty answer");

  const changed = structuredClone(PROFILE);
  changed.reviewers[0].severityMarkers.push(["!\\[P3 Badge\\]", "minor"]);
  check(reviewState(db, NWO, 1, changed, { at: T + 1400 }).readable === false,
    "a projection derived by a different classifier is refused, not trusted");
  check(staleScopes(db, NWO, changed).includes("pr:1"),
    "and it is named as stale so it can be rebuilt", JSON.stringify(staleScopes(db, NWO, changed)));

  // An INCOMPLETE observation must not become a confident projection.
  derivePr(db, NWO, 1, PROFILE, { at: T + 1400, head: HEAD_A, complete: false });
  check(reviewState(db, NWO, 1, PROFILE, { at: T + 1400 }).readable === false,
    "a projection built from a truncated read refuses to answer");
}

// ── supply is a band ─────────────────────────────────────────────────────────
{
  derivePr(db, NWO, 1, PROFILE, { at: T + 1400, head: HEAD_A });
  ingest(db, NWO, 2, [{ source: "codex", external_id: "comment:50", kind: "issue_comment",
    head_sha: null, event_at: T + 2000, edited_at: null,
    payload: { login: "codex", body: "You have reached your Codex usage limits" } }], { at: T + 2000 });
  derivePr(db, NWO, 2, PROFILE, { at: T + 2000, head: HEAD_A });
  deriveSupply(db, NWO, PROFILE, { at: T + 2000 });
  let s = db.prepare("SELECT * FROM reviewer_supply WHERE reviewer='codex'").get();
  check(s.state === "down", "a refusal puts a reviewer DOWN", JSON.stringify(s.state));
  const epoch0 = s.supply_epoch;

  ingest(db, NWO, 2, [review(60, "codex", "back with findings", HEAD_A, T + 3000)], { at: T + 3000 });
  derivePr(db, NWO, 2, PROFILE, { at: T + 3000, head: HEAD_A });
  deriveSupply(db, NWO, PROFILE, { at: T + 3000 });
  s = db.prepare("SELECT * FROM reviewer_supply WHERE reviewer='codex'").get();
  check(s.state === "up", "and a substantive answer brings it back UP");
  check(s.supply_epoch === epoch0 + 1,
    "recovery advances the supply epoch, so a request spent during the band can be reissued",
    `${epoch0} -> ${s.supply_epoch}`);
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
