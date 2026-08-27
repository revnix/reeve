// R-08 must measure a body delimiter against review BODIES, and nothing else.
//
// Codex writes the same severity badge in an inline comment and in a review
// summary. `fires()` scanned every ingested text for every named pattern, so a
// badge in a THREAD reported `bodyFindings` as demonstrated even though it had
// never once matched a review body. The positive control then passed without the
// thing it controls having fired — which is the failure mode a positive control
// exists to make impossible, appearing inside the control itself.
import { checkDetectors } from "../src/doctor.mjs";
import { ingest, noteHead } from "../src/review/ingest.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "o/r", T = 1_800_000_000, HEAD = "a".repeat(40);
const BADGE = "!\\[P\\d Badge\\]";
const profile = {
  identity: { key: NWO },
  reviewers: [{ login: "codex", kind: "blocking", refusal: "usage limits",
                bodyFindings: BADGE,
                severityMarkers: [["!\\[P1 Badge\\]", "critical"]] }],
};
const thread = (id, body) => ({
  source: "codex", external_id: `thread:${id}`, kind: "review_thread",
  head_sha: null, event_at: T, edited_at: null,
  payload: { thread_id: id, author: "codex", body, is_resolved: false, is_outdated: false,
             resolved_by: null, path: "a.ts", line: 1 },
});
const review = (id, body) => ({
  source: "codex", external_id: `review:${id}`, kind: "review",
  head_sha: HEAD, event_at: T, edited_at: null,
  payload: { login: "codex", state: "COMMENTED", commit_id: HEAD, body },
});

const idleFor = r => JSON.stringify(r).includes("codex.bodyFindings");

// The defect: the badge appears in a THREAD and nowhere else.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-r08-a-"));
  const db = open(join(dir, "s.db"));
  noteHead(db, NWO, 1, HEAD, T);
  ingest(db, NWO, 1, [thread("PRRT_1", "**![P1 Badge](x)** in a thread"),
                      review(1, "a review body with no badge anywhere in it")], { at: T });
  const r = checkDetectors(db, profile);
  check(idleFor(r) || /bodyFindings unproven/.test(JSON.stringify(r)),
    "a badge in a THREAD does not report the body delimiter as demonstrated",
    JSON.stringify(r.lines));
  rmSync(dir, { recursive: true, force: true });
}

// The control: once it fires against a real BODY, it stops being reported idle.
// Without this the assertion above would pass just as well if the check had been
// broken outright and never reported anything.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-r08-b-"));
  const db = open(join(dir, "s.db"));
  noteHead(db, NWO, 1, HEAD, T);
  ingest(db, NWO, 1, [thread("PRRT_1", "**![P1 Badge](x)** in a thread"),
                      review(1, "**![P1 Badge](x)** and in the body too")], { at: T });
  const r = checkDetectors(db, profile);
  check(!idleFor(r), "control: a badge in a review BODY does demonstrate it",
    JSON.stringify(r.lines));
  rmSync(dir, { recursive: true, force: true });
}

// A grammar that WORKED and has stopped working must show up. Unlike the inline
// severity markers beside it, this detector has no miss ratio to give it away: a
// body the delimiter cannot parse yields no findings rather than an unclassified
// one, so one match from months ago would otherwise vouch for it for ever. The
// taxonomy here has already been replaced wholesale once.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-r08-c-"));
  const db = open(join(dir, "s.db"));
  noteHead(db, NWO, 1, HEAD, T);
  // One old body the delimiter parses, then a dozen recent ones in a taxonomy it
  // does not. Ingested in separate calls so observed_at orders them.
  ingest(db, NWO, 1, [review(1, "**![P1 Badge](x) an old-style finding**")], { at: T });
  for (let i = 0; i < 12; i++)
    ingest(db, NWO, 1, [review(100 + i, `<severity level="high"/> a new-style finding ${i}`)], { at: T + 100 + i });
  const r = checkDetectors(db, profile);
  check(idleFor(r), "a delimiter that no longer parses recent bodies is reported idle",
    JSON.stringify(r.lines));
  check(/0\/10 recent review/.test(JSON.stringify(r.lines)),
    "and the report says how many of the recent ones it parsed", JSON.stringify(r.lines));
  rmSync(dir, { recursive: true, force: true });
}

// Control: the same window with the grammar still working is NOT idle, so the
// assertion above is about drift and not about the window being too small.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-r08-d-"));
  const db = open(join(dir, "s.db"));
  noteHead(db, NWO, 1, HEAD, T);
  ingest(db, NWO, 1, [review(1, "**![P1 Badge](x) an old-style finding**")], { at: T });
  for (let i = 0; i < 12; i++)
    ingest(db, NWO, 1, [review(100 + i, `**![P1 Badge](x) still parsing ${i}**`)], { at: T + 100 + i });
  const r = checkDetectors(db, profile);
  check(!idleFor(r), "control: a grammar still parsing recent bodies is not idle",
    JSON.stringify(r.lines));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
