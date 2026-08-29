// A deletion is a FACT, and the projection had no way to record one.
//
// `derivePr` folds every external_id ever seen, and `inbox_current` says which
// GENERATION an object is on but never that it stopped existing. So a thread deleted
// on GitHub kept its last payload for ever; if that payload said resolved, it was
// counted in the total AND in the resolved count. That is exactly what the shadow
// reported on #1325 -- live 25/18, derived 26/19 -- one extra, and resolved.
//
// The danger in fixing it is the opposite error. Concluding absence from a partial
// read erases live threads, and threads gate merges. So every assertion here is
// about WHEN absence may be concluded, not merely that it can be.
import { ingest, isAbsent, ABSENT } from "../src/review/ingest.mjs";
import { derivePr } from "../src/review/derive.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log("        " + detail); fail++; }
};

const NWO = "o/r";
const T = 1_800_000_000;
const HEAD = "a".repeat(40);
const PROFILE = { watch: { staleSeconds: 900 }, reviewers: [{ login: "crab", kind: "bot" }] };

const thread = (id, over = {}) => ({
  source: "crab", external_id: `thread:${id}`, kind: "review_thread",
  head_sha: null, event_at: T, edited_at: null,
  payload: { thread_id: id, author: "crab", body: "a finding", is_resolved: false,
             is_outdated: false, resolved_by: null, path: "a.ts", line: 1, ...over },
});
const review = id => ({
  source: "crab", external_id: `review:${id}`, kind: "review",
  head_sha: HEAD, event_at: T, edited_at: null,
  payload: { review_id: id, author: "crab", body: "looks fine", state: "COMMENTED", head_sha: HEAD },
});

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "absence-"));
  return { db: open(join(dir, "s.db")), dir };
};
const threadCount = db =>
  db.prepare("SELECT COUNT(*) n FROM review_thread WHERE pr = 1").get().n;
const resolvedCount = db =>
  db.prepare("SELECT COUNT(*) n FROM review_thread WHERE pr = 1 AND is_resolved = 1").get().n;
const COMPLETE = { completeKinds: ["review_thread"] };

// --- the marker itself ----------------------------------------------------------
{
  check(isAbsent(ABSENT) && isAbsent(JSON.stringify(ABSENT)),
    "a tombstone reads as absent whether given as an object or as stored JSON");
  check(!isAbsent({ is_resolved: true }) && !isAbsent(null) && !isAbsent(undefined)
        && !isAbsent("not json") && !isAbsent('{"absent":"yes"}'),
    "content, null, unparseable text and a non-true `absent` are all NOT absent",
    "a loose check here would delete live threads");
}

// --- ONE complete read that misses a thread changes nothing ---------------------
{
  // The whole point. A single complete-LOOKING read that misses three threads would
  // otherwise erase three threads that gate a merge, and the bulk refusal does not
  // catch a small miss.
  const { db, dir } = fresh();
  ingest(db, NWO, 1, [thread("A"), thread("B", { is_resolved: true })], { at: T, ...COMPLETE });
  derivePr(db, NWO, 1, PROFILE, { at: T, head: HEAD });
  check(threadCount(db) === 2, "control: both threads are in the projection to begin with",
    String(threadCount(db)));

  ingest(db, NWO, 1, [thread("A")], { at: T + 100, ...COMPLETE });
  derivePr(db, NWO, 1, PROFILE, { at: T + 100, head: HEAD });
  check(threadCount(db) === 2,
    "a thread missing from ONE complete read is still counted", String(threadCount(db)));
  rmSync(dir, { recursive: true, force: true });
}

// --- TWO consecutive complete reads that both miss it do remove it ---------------
{
  const { db, dir } = fresh();
  ingest(db, NWO, 1, [thread("A"), thread("B", { is_resolved: true })], { at: T, ...COMPLETE });
  ingest(db, NWO, 1, [thread("A")], { at: T + 100, ...COMPLETE });
  const w = ingest(db, NWO, 1, [thread("A")], { at: T + 200, ...COMPLETE });
  derivePr(db, NWO, 1, PROFILE, { at: T + 200, head: HEAD });
  check(w.absent === 1, "the second consecutive complete miss records one absence",
    JSON.stringify({ absent: w.absent, refused: w.absenceRefused }));
  check(threadCount(db) === 1 && resolvedCount(db) === 0,
    "the deleted thread leaves BOTH the total and the resolved count",
    `total=${threadCount(db)} resolved=${resolvedCount(db)}`);
  // The log keeps it. Scrubbing the projection is not erasing the record.
  const rows = db.prepare(
    "SELECT COUNT(*) n FROM inbox WHERE pr_number=1 AND external_id='thread:B'").get().n;
  check(rows === 2, "the original observation and its tombstone both survive in the log",
    String(rows));
  rmSync(dir, { recursive: true, force: true });
}

// --- an INCOMPLETE read never concludes anything, however often ------------------
{
  // `completeKinds` is empty when the read was partial. Absence from a truncated
  // read is not deletion, and acting on it is how live threads disappear.
  const { db, dir } = fresh();
  ingest(db, NWO, 1, [thread("A"), thread("B")], { at: T, ...COMPLETE });
  for (const at of [T + 100, T + 200, T + 300])
    ingest(db, NWO, 1, [thread("A")], { at, completeKinds: [] });
  derivePr(db, NWO, 1, PROFILE, { at: T + 300, head: HEAD });
  check(threadCount(db) === 2,
    "three incomplete reads that all miss a thread still conclude nothing",
    String(threadCount(db)));
  rmSync(dir, { recursive: true, force: true });
}

// --- a reappearing thread needs no special case ---------------------------------
{
  const { db, dir } = fresh();
  ingest(db, NWO, 1, [thread("A"), thread("B")], { at: T, ...COMPLETE });
  ingest(db, NWO, 1, [thread("A")], { at: T + 100, ...COMPLETE });
  ingest(db, NWO, 1, [thread("A")], { at: T + 200, ...COMPLETE });
  derivePr(db, NWO, 1, PROFILE, { at: T + 200, head: HEAD });
  check(threadCount(db) === 1, "control: it really was removed before it came back",
    String(threadCount(db)));

  ingest(db, NWO, 1, [thread("A"), thread("B")], { at: T + 300, ...COMPLETE });
  derivePr(db, NWO, 1, PROFILE, { at: T + 300, head: HEAD });
  check(threadCount(db) === 2,
    "an object observed again supersedes its tombstone with no special case",
    String(threadCount(db)));
  rmSync(dir, { recursive: true, force: true });
}

// --- a bulk disappearance is disbelieved ----------------------------------------
{
  const { db, dir } = fresh();
  const many = Array.from({ length: 12 }, (_, i) => thread(`T${i}`));
  ingest(db, NWO, 1, many, { at: T, ...COMPLETE });
  ingest(db, NWO, 1, [thread("T0")], { at: T + 100, ...COMPLETE });
  const w = ingest(db, NWO, 1, [thread("T0")], { at: T + 200, ...COMPLETE });
  derivePr(db, NWO, 1, PROFILE, { at: T + 200, head: HEAD });
  check(w.absent === 0 && w.absenceRefused.length === 1,
    "a complete read that loses most of what it knew is refused, not obeyed",
    JSON.stringify({ absent: w.absent, refused: w.absenceRefused }));
  check(threadCount(db) === 12, "and nothing leaves the projection", String(threadCount(db)));
  // CONTROL: the refusal is about the SIZE of the loss, not about absence being
  // switched off -- the same store removes a small one.
  // T5 was ALREADY missing at the refused read, so this read is its second
  // consecutive miss and the absence lands here -- not on a further read. Asserting
  // on the call after this one measured a store where the work was already done, and
  // read absent=0 as "absence is off" rather than "absence already happened".
  const w2 = ingest(db, NWO, 1, many.filter(t => t.external_id !== "thread:T5"),
                    { at: T + 300, ...COMPLETE });
  derivePr(db, NWO, 1, PROFILE, { at: T + 300, head: HEAD });
  check(w2.absent === 1 && threadCount(db) === 11,
    "control: a small loss in the same store is still concluded",
    JSON.stringify({ absent: w2.absent, refused: w2.absenceRefused, total: threadCount(db) }));
  rmSync(dir, { recursive: true, force: true });
}

// --- a surface with NO completeness signal is never tombstoned -------------------
{
  // Only threads carry `total`/`seen`. Reviews, comments and reactions do not, so
  // nothing may ever conclude one of them is gone -- and passing the thread signal
  // must not license absence on a surface it says nothing about.
  const { db, dir } = fresh();
  ingest(db, NWO, 1, [thread("A"), review(1)], { at: T, ...COMPLETE });
  ingest(db, NWO, 1, [thread("A")], { at: T + 100, ...COMPLETE });
  const w = ingest(db, NWO, 1, [thread("A")], { at: T + 200, ...COMPLETE });
  check(w.absent === 0, "a review missing from two complete THREAD reads is not tombstoned",
    JSON.stringify({ absent: w.absent }));
  const gone = db.prepare(
    "SELECT payload FROM inbox WHERE pr_number=1 AND external_id='review:1' ORDER BY generation DESC").get();
  check(!isAbsent(gone.payload), "and its current row is still its content", gone.payload.slice(0, 60));
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
