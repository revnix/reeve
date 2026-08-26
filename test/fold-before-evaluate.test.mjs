// The tick folds review data BEFORE it judges, and the head is pinned once.
//
// The order used to be the other way round -- evaluate, then observe, ingest and
// derive -- so every decision read a projection built from the PREVIOUS tick. Two
// P1s came out of that single fact, and neither was catchable downstream:
//
//   · a head check cannot see it. A reviewer acting on the SAME revision leaves
//     the head matching while the content moves.
//   · a count cross-check cannot see it either. A thread EDITED in place changes
//     no total, no resolved count and no open count. Comparing aggregates catches
//     things appearing and disappearing, never things changing.
//
// A third check would have detected one more instance of an ordering that can be
// corrected, at a cost paid on every tick for every pull request. This asserts the
// correction: the ORDER, and that one pin serves both halves.
import { tick } from "../src/daemon.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-order-"));
const db = open(join(dir, "s.db"));
const logPath = join(dir, "reeve.log");
const HEAD = "a".repeat(40);

const profile = {
  reviewers: [{ login: "codex", kind: "blocking", trigger: "@codex review" }],
  rounds: { softCap: 5, hardCap: 10 },
  watch: { reviewActions: false, staleSeconds: 900 },
  ci: {}, merge: { authority: "propose" },
};

// One recorder, so the assertions are about SEQUENCE rather than about counts.
const seen = [];
const anchor = { ok: true, head: HEAD, headRef: "f", updatedAt: "2026-08-26T00:00:00Z" };
const evaluation = {
  ok: true, pr: 1, title: "t", headRef: "f", baseRef: "main", state: "open",
  head: HEAD, updatedAt: anchor.updatedAt,
  verdict: { state: "PASS", clauses: [], summary: "x" },
  reviewers: [], threads: { readable: true, total: 0, unresolved: 0, seen: 0 },
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: null },
  checks: {}, settled: {},
};

const ctx = {
  nwo: "o/r", profile, db, dbPath: join(dir, "s.db"), logPath,
  haltMarker: join(dir, "HALT"), execute: false, shadow: true,
  dashPath: join(dir, "dash.md"), canaryStateDir: dir,
  openPrs: () => [1],
  prAnchor: () => { seen.push("anchor"); return anchor; },
  observe: () => { seen.push("observe"); return { observations: [], incomplete: false, threads: { readable: true, total: 0, unresolved: 0 } }; },
  ingest: () => { seen.push("ingest"); return { inserted: 0, generations: 0 }; },
  derivePr: (_db, _n, _p, _pr, o) => { seen.push(`derive:${o?.head?.slice(0, 4)}`); return { rounds: 0, threads: 0 }; },
  reviewState: () => ({ readable: false, why: "not derived in this fixture" }),
  evaluate: () => { seen.push("evaluate"); return evaluation; },
  authenticate: async () => ({ ok: false, why: "not in this fixture" }),
  drain: false,
  backupFailures: new Map(),
};

await tick(ctx);

// --- the order itself ---------------------------------------------------------
{
  check(seen.includes("evaluate"), "control: the tick reached the evaluation at all", seen.join(" -> "));
  check(seen.includes("ingest") && seen.some(s => s.startsWith("derive")),
    "control: and it folded, so there is an order to assert", seen.join(" -> "));

  const iIngest = seen.indexOf("ingest");
  const iDerive = seen.findIndex(s => s.startsWith("derive"));
  const iEval = seen.indexOf("evaluate");
  check(iIngest < iEval && iDerive < iEval,
    "the fold runs BEFORE the evaluation, which is the whole change",
    seen.join(" -> "));
  check(seen.indexOf("anchor") < iIngest,
    "and the head is pinned before the fold, because clearing is computed against it",
    seen.join(" -> "));
}

// --- one pin, not two ---------------------------------------------------------
{
  // Pinning twice would be worse than the ordering it fixes: two reads can return
  // different revisions, and the evaluation would then judge a head the fold did
  // not describe. The anchor is taken once and handed to both.
  check(seen.filter(s => s === "anchor").length === 1,
    "the revision is pinned ONCE per pull request per tick", seen.join(" -> "));
  const derived = seen.find(s => s.startsWith("derive:"));
  check(derived === `derive:${HEAD.slice(0, 4)}`,
    "and the fold derives against that same pinned revision", String(derived));
}

// --- and the reorder RELEASES what the review branch withheld ----------------
{
  // The two halves compose or neither is worth anything. `reviewFacts` withheld
  // the thread details a worker is dispatched with, gated on exactly this
  // ordering; the daemon has to actually say the ordering now holds, or the
  // details stay withheld forever and the fix is invisible.
  //
  // Checked over the source, because the flag is passed at a call site that
  // reaches GitHub six times before it returns. Narrow enough to be honest: the
  // evaluation must be handed the anchor AND told the fold preceded it.
  const src = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  check(/evaluatePr\)\(\{[^}]*anchor[^}]*\}/s.test(src) || /evaluate \?\? evaluatePr\)\(\{[\s\S]{0,200}anchor/.test(src),
    "the evaluation is handed the anchor the fold used", "");
  check(/foldPrecedesEvaluation:\s*true/.test(src),
    "and told the fold preceded it, which is what releases the thread details", "");
  // Control: the scan would notice if the flag were merely mentioned rather than set.
  check(!/foldPrecedesEvaluation:\s*false/.test(src),
    "control: and nothing sets it false", "");
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
